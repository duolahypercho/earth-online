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
    () => window.__CITYGEN__?.getState().webgpu && window.__CITYGEN__?.getState().furniture?.props === 900,
    { timeout: 30000 },
  );
  const report = await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    const records = renderer.sidewalkPropRecords || [];
    const kinds = records.reduce((counts, record) => {
      counts[record.kind] = (counts[record.kind] || 0) + 1;
      return counts;
    }, {});
    const measuredBandViolations = records.filter((record) => !record.segmentId
      || !Number.isFinite(record.lateralOffset)
      || record.lateralOffset < record.minOffset - 1e-6
      || record.lateralOffset > record.maxOffset + 1e-6).length;
    return {
      backend: renderer.rendererBackend,
      props: records.length,
      segmentOwners: new Set(records.map((record) => record.segmentId)).size,
      kinds,
      measuredBandViolations,
      diagnostics: renderer.sidewalkPropDiagnostics,
    };
  });
  assert.equal(report.backend, 'webgpu');
  assert.equal(report.props, 900);
  assert.ok(report.segmentOwners >= 100);
  assert.deepEqual(Object.keys(report.kinds).sort(), ['bench', 'cone', 'hydrant', 'planter', 'sign']);
  assert.equal(report.measuredBandViolations, 0);
  assert.equal(report.diagnostics.bandViolations, 0);
  assert.equal(report.diagnostics.asphaltOverlaps, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', url, report, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
