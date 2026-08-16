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
    () => window.__CITYGEN__?.getState().webgpu && window.__CITYGEN__?.getState().pedestrians === 48,
    { timeout: 30000 },
  );
  const before = await page.evaluate(() => window.__CITYGEN__.getTraffic().pedestrians
    .map((pedestrian) => pedestrian.group.position.toArray()));
  await page.waitForTimeout(750);
  const report = await page.evaluate((startPositions) => {
    const traffic = window.__CITYGEN__.getTraffic();
    const batch = traffic.pedestrianBatch;
    const parts = Object.values(batch?.parts || {});
    const matricesFinite = parts.every((mesh) => [...mesh.instanceMatrix.array].every(Number.isFinite));
    const colorsFinite = parts.every((mesh) => mesh.instanceColor
      && [...mesh.instanceColor.array].every(Number.isFinite));
    const moved = traffic.pedestrians.map((pedestrian, index) => {
      const start = startPositions[index];
      const end = pedestrian.group.position;
      return Math.hypot(end.x - start[0], end.y - start[1], end.z - start[2]);
    });
    let pedestrianSceneMeshes = 0;
    traffic.group.traverse((object) => {
      if (object.isMesh && object.name.startsWith('pedestrian-')) pedestrianSceneMeshes += 1;
    });
    return {
      backend: window.__CITYGEN__.getState().rendererBackend,
      pedestrians: traffic.pedestrians.length,
      batchParts: parts.length,
      instanceCounts: parts.map((mesh) => mesh.count),
      instanceColorCounts: parts.map((mesh) => mesh.instanceColor?.count || 0),
      logicalSceneAttachments: traffic.pedestrians.filter((pedestrian) => pedestrian.group.parent).length,
      pedestrianSceneMeshes,
      matricesFinite,
      colorsFinite,
      movedPedestrians: moved.filter((distance) => distance > 0.1).length,
      maxMovement: Number(Math.max(...moved).toFixed(3)),
    };
  }, before);
  assert.equal(report.backend, 'webgpu');
  assert.equal(report.pedestrians, 48);
  assert.equal(report.batchParts, 3);
  assert.deepEqual(report.instanceCounts, [48, 48, 48]);
  assert.deepEqual(report.instanceColorCounts, [48, 48, 48]);
  assert.equal(report.logicalSceneAttachments, 0);
  assert.equal(report.pedestrianSceneMeshes, 3);
  assert.equal(report.matricesFinite, true);
  assert.equal(report.colorsFinite, true);
  assert.equal(report.movedPedestrians, 48);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', url, report, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
