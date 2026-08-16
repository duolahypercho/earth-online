import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SF_MAP_PRESET_QA_PORT || 5186);
const baseUrl = `http://127.0.0.1:${port}/sf-map.html`;
const outputDir = process.env.SF_MAP_PRESET_QA_DIR || join(root, '.qa-sf-map-i10-preset-residency');
const settleTimeoutMs = Number(process.env.SF_MAP_PRESET_QA_TIMEOUT_MS || 600000);
const FERRY_RESIDENT_IDS = [
  'epsg26910-1439-10892', 'epsg26910-1439-10893', 'epsg26910-1439-10894',
  'epsg26910-1440-10892', 'epsg26910-1440-10893', 'epsg26910-1440-10894',
  'epsg26910-1440-10895', 'epsg26910-1441-10891', 'epsg26910-1441-10892',
  'epsg26910-1441-10893',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForPort(host, targetPort, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const available = await new Promise((resolve) => {
      const socket = createServer();
      socket.once('error', () => resolve(true));
      socket.once('listening', () => socket.close(() => resolve(false)));
      socket.listen(targetPort, host);
    });
    if (available) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not open ${host}:${targetPort}`);
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function assertCompactDistrictBatch(capture, label) {
  const fit = capture.districtFit;
  assert(fit.selection === 'nearest-complete-source-2x2-metric-block', `${label} did not use the source-derived compact-batch policy.`);
  assert(sameIds(fit.batchTileIds, fit.candidateTileIds), `${label} fitted an arrival-dependent batch instead of the preselected source batch.`);
  assert(fit.residentBounds?.width === 768 && fit.residentBounds?.depth === 768, `${label} did not fit a compact 2×2 384 m metric footprint.`);
}

async function sideBySide(page, firstPath, repeatPath, outputPath) {
  const [first, repeat] = await Promise.all([readFile(firstPath), readFile(repeatPath)]);
  const toDataUri = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><style>body{margin:0;background:#07100f;display:grid;grid-template-columns:1fr 1fr;color:#d7ff48;font:600 16px system-ui}.frame{position:relative}.label{position:absolute;z-index:1;left:18px;top:14px;background:#07100fcc;padding:6px 9px}.frame img{display:block;width:100%;height:720px;object-fit:cover}</style><div class="frame"><span class="label">FERRY → DISTRICT</span><img src="${toDataUri(first)}"></div><div class="frame"><span class="label">PLAN → FERRY → DISTRICT</span><img src="${toDataUri(repeat)}"></div>`);
  await page.screenshot({ path: outputPath });
}

const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});
let browser;
try {
  await mkdir(outputDir, { recursive: true });
  await waitForPort('127.0.0.1', port);
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__SF_MAP_VIEWER__), { timeout: 30000 });

  const settled = async (capturePage, name) => {
    try {
      await capturePage.waitForFunction((view) => {
        const viewer = window.__SF_MAP_VIEWER__;
        const diagnostics = viewer?.streamingDiagnostics;
        if (!viewer || !diagnostics || diagnostics.activeView !== view || diagnostics.activeLoadCount || diagnostics.queuedCount) return false;
        if (view === 'district' && diagnostics.districtFit.oneTimeStatus !== 'fitted') return false;
        if (view !== 'plan' && diagnostics.explicitViewResidency.lastPrune?.view !== view) return false;
        const focus = diagnostics.focusWorldPosition;
        const expected = viewer.tileDescriptors
          .filter((tile) => Math.hypot(focus[0] - (tile.offset[0] + tile.size / 2), focus[1] - (tile.offset[2] + tile.size / 2)) <= 880)
          .map((tile) => tile.id)
          .sort();
        const resident = [...viewer.residentTileIds].sort();
        return JSON.stringify(resident) === JSON.stringify(expected);
      }, name, { timeout: settleTimeoutMs });
    } catch (error) {
      const progress = await capturePage.evaluate(() => {
        const viewer = window.__SF_MAP_VIEWER__;
        const diagnostics = viewer?.streamingDiagnostics;
        const focus = diagnostics?.focusWorldPosition;
        const expected = focus ? viewer.tileDescriptors
          .filter((tile) => Math.hypot(focus[0] - (tile.offset[0] + tile.size / 2), focus[1] - (tile.offset[2] + tile.size / 2)) <= 880)
          .map((tile) => tile.id).sort() : [];
        return { diagnostics, residentTileIds: [...(viewer?.residentTileIds || [])].sort(), expectedTileIds: expected };
      });
      throw new Error(`${error.message}\n${JSON.stringify(progress)}`);
    }
    return capturePage.evaluate(() => {
      const viewer = window.__SF_MAP_VIEWER__;
      const diagnostics = viewer.streamingDiagnostics;
      return {
        residentTileIds: [...viewer.residentTileIds].sort(),
        districtFit: diagnostics.districtFit,
        activeView: diagnostics.activeView,
        explicitViewResidency: diagnostics.explicitViewResidency,
        rejected: diagnostics.completed.filter((entry) => entry.result === 'rejected'),
      };
    });
  };

  const choose = async (capturePage, name) => {
    await capturePage.evaluate((view) => window.__SF_MAP_VIEWER__.setView(view), name);
    return settled(capturePage, name);
  };

  const first = await choose(page, 'district');
  const firstPath = join(outputDir, 'district-first.png');
  await page.screenshot({ path: firstPath });
  await page.evaluate(() => window.__SF_MAP_VIEWER__.setView('plan'));
  await page.waitForFunction(() => window.__SF_MAP_VIEWER__?.streamingDiagnostics.activeView === 'plan', { timeout: 10000 });
  const plan = await page.evaluate(() => {
    const diagnostics = window.__SF_MAP_VIEWER__.streamingDiagnostics;
    return {
      activeView: diagnostics.activeView,
      retainedLastPrune: diagnostics.explicitViewResidency.lastPrune,
      residentCount: window.__SF_MAP_VIEWER__.residentTileIds.length,
      descriptorCount: window.__SF_MAP_VIEWER__.tileDescriptors.length,
    };
  });
  assert(plan.activeView === 'plan', 'Plan preset did not activate.');
  assert(plan.retainedLastPrune?.view === 'district', 'Plan incorrectly ran a restrictive named-view prune.');

  await page.waitForTimeout(1000);
  const ferry = await choose(page, 'ferry');
  const repeat = await choose(page, 'district');
  const repeatPath = join(outputDir, 'district-repeat.png');
  await page.screenshot({ path: repeatPath });

  const freshPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  freshPage.on('pageerror', (error) => errors.push(error.message));
  freshPage.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  await freshPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await freshPage.waitForFunction(() => Boolean(window.__SF_MAP_VIEWER__), { timeout: 30000 });
  const fresh = await choose(freshPage, 'district');
  const freshPath = join(outputDir, 'district-fresh-boot.png');
  await freshPage.screenshot({ path: freshPath });
  await freshPage.close();

  assert(sameIds(first.residentTileIds, repeat.residentTileIds), 'District resident IDs changed after Plan → Ferry → District.');
  assert(sameIds(first.residentTileIds, fresh.residentTileIds), 'District resident IDs changed between fresh boots.');
  assert(sameIds(ferry.residentTileIds, FERRY_RESIDENT_IDS), 'Ferry framing/resident IDs changed from the reviewed source-locked preset.');
  assert(first.residentTileIds.length >= 4 && first.residentTileIds.length <= 16, 'First District resident count is outside the reviewed 4–16 bound.');
  assert(repeat.residentTileIds.length >= 4 && repeat.residentTileIds.length <= 16, 'Repeat District resident count is outside the reviewed 4–16 bound.');
  assert(fresh.residentTileIds.length >= 4 && fresh.residentTileIds.length <= 16, 'Fresh District resident count is outside the reviewed 4–16 bound.');
  assert(JSON.stringify(first.districtFit.batchTileIds) === JSON.stringify(repeat.districtFit.batchTileIds), 'District fit batch changed between matched preset histories.');
  assert(JSON.stringify(first.districtFit.batchTileIds) === JSON.stringify(fresh.districtFit.batchTileIds), 'District fit batch changed between fresh boots.');
  assert(JSON.stringify(first.districtFit.cameraTarget) === JSON.stringify(repeat.districtFit.cameraTarget), 'District fit target changed between matched preset histories.');
  assert(JSON.stringify(first.districtFit.cameraTarget) === JSON.stringify(fresh.districtFit.cameraTarget), 'District fit target changed between fresh boots.');
  assert(first.districtFit.cameraDistance === repeat.districtFit.cameraDistance, 'District fit distance changed between matched preset histories.');
  assert(first.districtFit.cameraDistance === fresh.districtFit.cameraDistance, 'District fit distance changed between fresh boots.');
  assertCompactDistrictBatch(first, 'First District capture');
  assertCompactDistrictBatch(repeat, 'Repeated District capture');
  assertCompactDistrictBatch(fresh, 'Fresh District capture');
  assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
  assert(first.rejected.length === 0 && repeat.rejected.length === 0 && fresh.rejected.length === 0, 'A tile receipt or hash was rejected during matched captures.');
  const report = {
    result: 'SF map named-preset residency QA passed',
    first,
    repeat,
    fresh,
    ferry,
    plan,
    screenshots: { first: firstPath, repeat: repeatPath, fresh: freshPath },
  };
  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));

  // Composite capture is useful review evidence but must not prevent the
  // semantic resident-ID and camera-pose receipt above from being written.
  const sideBySidePath = join(outputDir, 'district-first-repeat-side-by-side.png');
  const composite = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await sideBySide(composite, firstPath, repeatPath, sideBySidePath);
  } catch (error) {
    console.warn(`Unable to capture preset side-by-side: ${error.message}`);
  } finally {
    await composite.close();
  }
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
