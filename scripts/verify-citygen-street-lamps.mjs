import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu && window.__CITYGEN__?.getState().buildings >= 700,
    { timeout: 30000 },
  );
  const report = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    api.setTime(22);
    api.setCameraPose('night');
    const renderer = api.getRenderer();
    const records = renderer.streetLampRecords || [];
    const camera = renderer.camera.position;
    const nearCamera = records.filter((record) => Math.hypot(record.x - camera.x, record.z - camera.z) <= 120).length;
    const lampRoot = renderer.root.getObjectByName('street-lamps');
    return {
      backend: renderer.rendererBackend,
      fixtures: records.length,
      renderedFixtures: lampRoot?.children.length || 0,
      sourceOwned: records.filter((record) => record.source === 'segment-polyline'
        && record.segmentId && record.streetId).length,
      measuredBandViolations: records.filter((record) => record.lateralOffset < record.minOffset - 1e-6
        || record.lateralOffset > record.maxOffset + 1e-6).length,
      classCount: new Set(records.map((record) => record.highway)).size,
      sideCount: new Set(records.map((record) => record.side)).size,
      nearNightCamera120m: nearCamera,
      lightCandidates: renderer.localLightCandidates.length,
      pointLightPool: renderer.localLightPool.length,
      diagnostics: renderer.streetLampDiagnostics,
    };
  });
  assert.equal(report.backend, 'webgpu');
  assert.equal(report.fixtures, 240);
  assert.equal(report.renderedFixtures, 240);
  assert.equal(report.sourceOwned, 240);
  assert.equal(report.measuredBandViolations, 0);
  assert.equal(report.classCount, 4);
  assert.equal(report.sideCount, 2);
  assert.ok(report.nearNightCamera120m >= 3);
  assert.ok(report.lightCandidates >= report.fixtures);
  assert.equal(report.pointLightPool, 3);
  assert.equal(report.diagnostics.asphaltOverlaps, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', url, report, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
