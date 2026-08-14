import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SF_MAP_RENDER_DEPTH_QA_PORT || 5198);
const baseUrl = `http://127.0.0.1:${port}/sf-map.html`;
const outputDir = process.env.SF_MAP_RENDER_DEPTH_QA_DIR || join(root, '.qa-sf-map-i10-render-depth');
const settleTimeoutMs = Number(process.env.SF_MAP_RENDER_DEPTH_QA_TIMEOUT_MS || 300000);

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

async function captureBeforeAfterContactSheet(page, screenshots) {
  const pairs = [
    { label: 'FERRY · 10 / 598', before: join(root, '.qa-i10-stream-ferry-valid.png'), after: screenshots.ferry },
    { label: 'DISTRICT · 16 / 598', before: join(root, '.qa-i10-stream-district-valid.png'), after: screenshots.district },
  ];
  const frames = await Promise.all(pairs.map(async (pair) => ({
    ...pair,
    before: `data:image/png;base64,${(await readFile(pair.before)).toString('base64')}`,
    after: `data:image/png;base64,${(await readFile(pair.after)).toString('base64')}`,
  })));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><style>body{margin:0;background:#07100f;color:#d7ff48;font:600 13px system-ui}.grid{display:grid;grid-template-columns:1fr 1fr;height:720px}.pair{min-width:0;border-right:1px solid #314239}.pair:last-child{border:0}.label{height:30px;box-sizing:border-box;padding:8px 12px;background:#0b1713}.row{position:relative;height:330px}.row span{position:absolute;z-index:1;left:10px;top:9px;background:#07100fcc;padding:4px 6px}.row img{display:block;width:100%;height:330px;object-fit:cover}</style><div class="grid">${frames.map(({ label, before, after }) => `<section class="pair"><header class="label">${label}</header><div class="row"><span>BEFORE</span><img src="${before}"></div><div class="row"><span>AFTER · RENDER ONLY</span><img src="${after}"></div></section>`).join('')}</div>`);
  const output = join(outputDir, 'ferry-district-before-after-contact-sheet.png');
  await page.screenshot({ path: output });
  return output;
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

  async function settle(view) {
    await page.evaluate((name) => window.__SF_MAP_VIEWER__.setView(name), view);
    await page.waitForFunction((name) => {
      const viewer = window.__SF_MAP_VIEWER__;
      const diagnostics = viewer?.streamingDiagnostics;
      if (!viewer || !diagnostics || diagnostics.activeView !== name || diagnostics.activeLoadCount || diagnostics.queuedCount) return false;
      if (name === 'district' && diagnostics.districtFit.oneTimeStatus !== 'fitted') return false;
      if (diagnostics.explicitViewResidency.lastPrune?.view !== name) return false;
      const focus = diagnostics.focusWorldPosition;
      const expected = viewer.tileDescriptors.filter((tile) => Math.hypot(
        focus[0] - (tile.offset[0] + tile.size / 2),
        focus[1] - (tile.offset[2] + tile.size / 2),
      ) <= 880).map((tile) => tile.id).sort();
      return JSON.stringify([...viewer.residentTileIds].sort()) === JSON.stringify(expected);
    }, view, { timeout: settleTimeoutMs });
    return page.evaluate(() => {
      const diagnostics = window.__SF_MAP_VIEWER__.streamingDiagnostics;
      return {
        residents: [...window.__SF_MAP_VIEWER__.residentTileIds].sort(),
        presentation: diagnostics.presentation,
        metricContract: diagnostics.metricContract,
        rejected: diagnostics.completed.filter((entry) => entry.result === 'rejected'),
      };
    });
  }

  const ferry = await settle('ferry');
  const ferryPath = join(outputDir, 'ferry-after.png');
  await page.screenshot({ path: ferryPath });
  const district = await settle('district');
  const districtPath = join(outputDir, 'district-after.png');
  await page.screenshot({ path: districtPath });

  for (const [name, capture, expectedResidents] of [['ferry', ferry, 10], ['district', district, 16]]) {
    assert(capture.residents.length === expectedResidents, `${name} resident count changed.`);
    assert(capture.rejected.length === 0, `${name} rejected a source-locked tile.`);
    assert(capture.presentation?.version === 'sf-map-render-depth-v1', `${name} did not expose render-depth policy.`);
    assert(capture.presentation.buildingToneCount === 4, `${name} did not keep four deterministic building tones.`);
    assert(capture.presentation.activeViewShadowed, `${name} did not use the local shadow policy.`);
    assert(capture.metricContract?.runtimeUnitsPerMetre === 1 && capture.metricContract.sceneScale === 1 && capture.metricContract.originSubtractions === 1, `${name} changed metric placement.`);
    assert(capture.metricContract.sourceLockedDescriptors, `${name} lost a byte lock.`);
    assert(Number.isFinite(capture.presentation.performance.drawCalls) && Number.isFinite(capture.presentation.performance.triangles), `${name} lacks render-cost evidence.`);
    assert(capture.presentation.performance.programCount > 0, `${name} did not compile a render program.`);
  }
  assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);

  const screenshots = { ferry: ferryPath, district: districtPath };
  // Releasing the live WebGL context before compositing avoids competing with
  // the deterministic render pass for the headless capture surface. Chromium
  // can retain that GPU process after a page closes, so use a fresh software-
  // only browser for the image-only comparison sheet.
  await page.close();
  await browser.close();
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const comparisonPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let comparison;
  try {
    comparison = await captureBeforeAfterContactSheet(comparisonPage, screenshots);
  } finally {
    await comparisonPage.close();
  }
  const report = {
    result: 'SF map render-depth Ferry/District QA passed',
    screenshots: { ...screenshots, comparison },
    ferry,
    district,
    errors,
    plan: {
      verdict: 'REJECT',
      reason: 'Full 598-tile LOD0 Plan presentation remains unsuitable pending a lower-LOD/offline-streaming strategy.',
      throughputEvidence: {
        status: 'timed-out after 600000 ms',
        residents: 58,
        queued: 540,
        activeLoads: 1,
        rejected: 0,
        drawCalls: 286,
        triangles: 17505881,
        materialPrograms: 6,
        source: '/tmp/sf-map-render-depth-i10.err',
      },
    },
  };
  await writeFile(join(outputDir, 'render-depth-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
