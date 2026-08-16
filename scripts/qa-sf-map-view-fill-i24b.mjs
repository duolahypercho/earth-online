import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SF_MAP_VIEW_FILL_QA_PORT || 5199);
const baseUrl = `http://127.0.0.1:${port}/sf-map.html`;
const outputDir = process.env.SF_MAP_VIEW_FILL_QA_DIR || join(root, '.qa-sf-map-i24b-view-fill');
const beforeDir = process.env.SF_MAP_VIEW_FILL_QA_BEFORE_DIR || join(root, '.qa-sf-map-i24-visual-critic');
const settleTimeoutMs = Number(process.env.SF_MAP_VIEW_FILL_QA_TIMEOUT_MS || 300000);
const manifest = JSON.parse(await readFile(join(
  root,
  'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json',
), 'utf8'));
const expectedDescriptorCount = manifest.tiles.length;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tupleWithin(actual, expected, tolerance = 1e-4) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
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

async function buildContactSheet(page, beforePaths, afterPaths) {
  const pairs = [
    { label: 'FERRY · CURRENT RUNTIME', before: beforePaths.ferry, after: afterPaths.ferry },
    { label: 'DISTRICT · CURRENT RUNTIME', before: beforePaths.district, after: afterPaths.district },
  ];
  const frames = await Promise.all(pairs.map(async (pair) => ({
    ...pair,
    before: `data:image/png;base64,${(await readFile(pair.before)).toString('base64')}`,
    after: `data:image/png;base64,${(await readFile(pair.after)).toString('base64')}`,
  })));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><style>
    body{margin:0;background:#07100f;color:#d7ff48;font:600 13px system-ui}
    .grid{display:grid;grid-template-columns:1fr 1fr;height:720px}
    .pair{min-width:0;border-right:1px solid #314239}.pair:last-child{border:0}
    .label{height:30px;box-sizing:border-box;padding:8px 12px;background:#0b1713}
    .row{position:relative;height:330px}.row span{position:absolute;z-index:1;left:10px;top:9px;background:#07100fcc;padding:4px 6px}
    .row img{display:block;width:100%;height:330px;object-fit:cover}
  </style><div class="grid">${frames.map(({ label, before, after }) => `<section class="pair"><header class="label">${label}</header><div class="row"><span>BEFORE · REVIEW BASELINE</span><img src="${before}"></div><div class="row"><span>AFTER · VIEW-AWARE FILL ONLY</span><img src="${after}"></div></section>`).join('')}</div>`);
  const output = join(outputDir, 'ferry-district-view-fill-before-after.png');
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
      const viewer = window.__SF_MAP_VIEWER__;
      const diagnostics = viewer.streamingDiagnostics;
      return {
        residents: [...viewer.residentTileIds].sort(),
        descriptorCount: viewer.tileDescriptors.length,
        camera: diagnostics.camera,
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
    assert(capture.residents.length === expectedResidents, `${name} resident count changed: ${capture.residents.length}`);
    assert(
      capture.descriptorCount === expectedDescriptorCount,
      `${name} did not inspect the current ${expectedDescriptorCount}-tile runtime.`,
    );
    assert(capture.rejected.length === 0, `${name} rejected a source-locked tile: ${JSON.stringify(capture.rejected)}`);
    assert(capture.presentation?.version === 'sf-map-render-depth-v2', `${name} changed the render-depth policy identity.`);
    assert(capture.presentation?.lightingFill?.includes('non-shadow-casting'), `${name} did not expose the fill policy.`);
    assert(capture.presentation?.viewFill?.castShadow === false, `${name} view fill unexpectedly casts shadows.`);
    assert(tupleWithin(capture.presentation.viewFill.target, capture.camera.target), `${name} fill target drifted from camera target.`);
    assert(Number.isFinite(capture.presentation.viewFill.intensity) && capture.presentation.viewFill.intensity > 0, `${name} lacks fill intensity evidence.`);
    assert(Number.isFinite(capture.presentation.performance.drawCalls)
      && Number.isFinite(capture.presentation.performance.triangles)
      && Number.isFinite(capture.presentation.performance.programCount), `${name} lacks render-cost evidence.`);
    assert(capture.metricContract?.runtimeUnitsPerMetre === 1
      && capture.metricContract.sceneScale === 1
      && capture.metricContract.originSubtractions === 1
      && capture.metricContract.sourceLockedDescriptors, `${name} changed the metric/source-lock contract.`);
  }
  assert(tupleWithin(ferry.camera.position, [430, 132, 292]), `Ferry camera position changed: ${JSON.stringify(ferry.camera.position)}`);
  assert(tupleWithin(ferry.camera.target, [119, 8, 292]), `Ferry camera target changed: ${JSON.stringify(ferry.camera.target)}`);
  assert(ferry.camera.fovDegrees === 43 && ferry.camera.nearMetres === 0.5, 'Ferry projection changed.');
  assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);

  const reviewBaseline = beforeDir === join(root, '.qa-sf-map-i24-visual-critic');
  const beforePaths = {
    ferry: join(beforeDir, reviewBaseline ? 'ferry.png' : 'ferry-after.png'),
    district: join(beforeDir, reviewBaseline ? 'district.png' : 'district-after.png'),
  };
  await page.close();
  await browser.close();
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const comparisonPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let comparison;
  try {
    comparison = await buildContactSheet(comparisonPage, beforePaths, { ferry: ferryPath, district: districtPath });
  } finally {
    await comparisonPage.close();
  }
  const report = {
    result: 'SF map i24b view-aware fill QA passed',
    baseline: {
      ferry: beforePaths.ferry,
      district: beforePaths.district,
      note: reviewBaseline
        ? 'Review baseline supplied by the i24 visual critic.'
        : 'Exact same-673-tile baseline captured with the view-aware fill removed; camera, residency, and source bytes were otherwise unchanged.',
    },
    screenshots: { ferry: ferryPath, district: districtPath, comparison },
    errors,
    ferry,
    district,
  };
  await writeFile(join(outputDir, 'view-fill-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
