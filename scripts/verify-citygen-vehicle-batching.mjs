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

const snapshot = () => page.evaluate(() => {
  const api = window.__CITYGEN__;
  const traffic = api.getTraffic();
  const renderer = api.getRenderer();
  const batch = traffic.vehicleBatch;
  const allMatricesFinite = Object.values(batch.parts)
    .every((mesh) => [...mesh.instanceMatrix.array].every(Number.isFinite));
  const bodyColorsFinite = batch.parts.body.instanceColor
    && [...batch.parts.body.instanceColor.array].every(Number.isFinite);
  const movingCarIndex = traffic.cars.reduce(
    (best, car, index, cars) => (car.speed > cars[best].speed ? index : best), 0,
  );
  batch.parts.body.getMatrixAt(movingCarIndex, batch.partMatrix);
  const car = traffic.cars[movingCarIndex];
  return {
    backend: renderer.rendererBackend,
    diagnostics: traffic.getVehicleBatchDiagnostics(),
    allMatricesFinite,
    bodyColorsFinite,
    bodyColorCount: batch.parts.body.instanceColor?.count || 0,
    stableIndices: traffic.cars.map((entry) => entry.instanceIndex),
    movingCarIndex,
    movingCarPosition: car.group.position.toArray(),
    movingBodyMatrix: batch.partMatrix.toArray(),
    drawCalls: renderer.renderer.info.render.drawCalls,
    rendererGeometries: renderer.renderer.info.memory.geometries,
  };
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu
      && window.__CITYGEN__?.getState().generator === 'sf-builtin'
      && window.__CITYGEN__?.getTraffic()?.cars?.length === 42,
    { timeout: 30000 },
  );
  await page.evaluate(() => window.__CITYGEN__.setCameraPose('sf'));
  await page.waitForTimeout(1400);

  const before = await snapshot();
  const expectedIndices = Array.from({ length: 42 }, (_, index) => index);
  assert.equal(before.backend, 'webgpu');
  assert.equal(before.diagnostics.logicalCars, 42);
  assert.deepEqual(before.diagnostics.kinds, { sedan: 28, taxi: 6, truck: 4, bus: 4 });
  assert.equal(before.diagnostics.meshes, 258);
  assert.equal(before.diagnostics.instancedMeshes, 6);
  assert.equal(before.diagnostics.geometries, 3);
  assert.equal(before.diagnostics.materials, 132);
  assert.deepEqual(before.diagnostics.instances, {
    body: 42,
    cab: 42,
    taxiTopper: 6,
    headlights: 84,
    tires: 168,
    hubs: 168,
  });
  assert.equal(before.diagnostics.frustumSafe, true);
  assert.equal(before.allMatricesFinite, true);
  assert.equal(before.bodyColorsFinite, true);
  assert.equal(before.bodyColorCount, 42);
  assert.deepEqual(before.stableIndices, expectedIndices);

  await page.waitForTimeout(750);
  const after = await snapshot();
  const movedDistance = Math.hypot(...after.movingCarPosition.map((value, index) => value - before.movingCarPosition[index]));
  const matrixDelta = Math.max(...after.movingBodyMatrix.map((value, index) => Math.abs(value - before.movingBodyMatrix[index])));
  assert.ok(movedDistance >= 0.2, `sampled logical car moved ${movedDistance.toFixed(3)}m`);
  assert.ok(matrixDelta >= 0.01, `batched body matrix changed by ${matrixDelta.toFixed(4)}`);
  assert.deepEqual(after.stableIndices, expectedIndices);

  const animation = await page.evaluate(() => {
    const traffic = window.__CITYGEN__.getTraffic();
    const car = traffic.cars[0];
    const rig = car.group.userData.rig;
    const saved = {
      speed: car.speed,
      braking: car.braking,
      corner: car.corner,
      turnSide: car.turnSide,
      nextEdge: car.nextEdge,
      phase: traffic.phase,
      spin: rig.spin,
      bobTime: rig.bobTime,
      bodyY: rig.body.position.y,
      bodyLean: rig.body.rotation.z,
    };
    rig.spin = 0;
    rig.bobTime = 0;
    rig.body.rotation.z = 0;
    car.speed = 6;
    car.braking = true;
    car.corner = {};
    car.turnSide = 1;
    car.nextEdge = car.edge;
    traffic.phase = 0;
    traffic.animateCar(car, 0.25);
    const left = {
      spin: rig.spin,
      bob: rig.body.position.y,
      lean: rig.body.rotation.z,
      tail: rig.taillightMat.emissiveIntensity,
      active: rig.turnSignals.left[0].emissiveIntensity,
      inactive: rig.turnSignals.right[0].emissiveIntensity,
    };
    car.braking = false;
    car.speed = 0;
    car.turnSide = -1;
    rig.body.rotation.z = 0;
    traffic.phase = 0;
    traffic.animateCar(car, 0.25);
    const right = {
      lean: rig.body.rotation.z,
      tail: rig.taillightMat.emissiveIntensity,
      active: rig.turnSignals.right[0].emissiveIntensity,
      inactive: rig.turnSignals.left[0].emissiveIntensity,
    };
    Object.assign(car, {
      speed: saved.speed,
      braking: saved.braking,
      corner: saved.corner,
      turnSide: saved.turnSide,
      nextEdge: saved.nextEdge,
    });
    traffic.phase = saved.phase;
    rig.spin = saved.spin;
    rig.bobTime = saved.bobTime;
    rig.body.position.y = saved.bodyY;
    rig.body.rotation.z = saved.bodyLean;
    return { left, right };
  });
  assert.ok(Math.abs(animation.left.spin - 5) <= 1e-6);
  assert.notEqual(animation.left.bob, 0);
  assert.ok(Math.abs(animation.left.lean + 0.035) <= 1e-6);
  assert.equal(animation.left.tail, 1.6);
  assert.equal(animation.left.active, 1.5);
  assert.equal(animation.left.inactive, 0);
  assert.ok(Math.abs(animation.right.lean - 0.035) <= 1e-6);
  assert.equal(animation.right.tail, 0.85);
  assert.equal(animation.right.active, 1.5);
  assert.equal(animation.right.inactive, 0);

  assert.ok(after.drawCalls <= 1200, `full SF draw calls ${after.drawCalls}`);
  assert.ok(after.rendererGeometries <= 450, `renderer geometries ${after.rendererGeometries}`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    result: 'PASS',
    url,
    structure: before.diagnostics,
    synchronization: {
      movedDistance: Number(movedDistance.toFixed(3)),
      matrixDelta: Number(matrixDelta.toFixed(4)),
      stableIndices: true,
    },
    animation,
    render: { drawCalls: after.drawCalls, geometries: after.rendererGeometries },
    errors,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
