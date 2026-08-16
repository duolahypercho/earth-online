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

const sample = () => page.evaluate(() => {
  const api = window.__CITYGEN__;
  const traffic = api.getTraffic();
  const renderer = api.getRenderer();
  const anchor = renderer.controls.target;
  const radii = [80, 120, 200, 350];
  const counts = (actors) => radii.map((radius) => actors
    .filter((actor) => Math.hypot(actor.group.position.x - anchor.x, actor.group.position.z - anchor.z) <= radius).length);
  return {
    state: api.getState(),
    phase: traffic.phase,
    cars: traffic.cars.map((car, index) => ({
      id: `car:${index}`,
      x: car.group.position.x,
      y: car.group.position.y,
      z: car.group.position.z,
      speed: car.speed,
      edgeId: car.edge?.id || null,
    })),
    pedestrians: traffic.pedestrians.map((pedestrian, index) => ({
      id: `pedestrian:${index}`,
      x: pedestrian.group.position.x,
      y: pedestrian.group.position.y,
      z: pedestrian.group.position.z,
      speed: pedestrian.speed,
      pathLength: pedestrian.points?.length || 0,
    })),
    density: {
      radii,
      cars: counts(traffic.cars),
      pedestrians: counts(traffic.pedestrians),
    },
    diagnostics: traffic.getLocalLifeDiagnostics(),
    render: {
      calls: renderer.renderer.info.render.calls,
      triangles: renderer.renderer.info.render.triangles,
      geometries: renderer.renderer.info.memory.geometries,
      textures: renderer.renderer.info.memory.textures,
    },
  };
});

function assertDensity(report, pose) {
  assert.equal(report.state.rendererBackend, 'webgpu', `${pose}: WebGPU backend`);
  assert.equal(report.cars.length, 42, `${pose}: car count`);
  assert.equal(report.pedestrians.length, 48, `${pose}: pedestrian count`);
  assert.deepEqual(new Set(report.cars.map((actor) => actor.id)).size, 42, `${pose}: unique car ids`);
  assert.deepEqual(new Set(report.pedestrians.map((actor) => actor.id)).size, 48, `${pose}: unique pedestrian ids`);
  assert.ok(report.density.cars[0] >= 2, `${pose}: at least 2 cars within 80m`);
  assert.ok(report.density.pedestrians[0] >= 4, `${pose}: at least 4 pedestrians within 80m`);
  assert.ok(report.density.cars[1] >= 6, `${pose}: at least 6 cars within 120m`);
  assert.ok(report.density.pedestrians[1] >= 10, `${pose}: at least 10 pedestrians within 120m`);
  assert.ok(report.density.cars[2] >= 10, `${pose}: at least 10 cars within 200m`);
  assert.ok(report.density.pedestrians[2] >= 16, `${pose}: at least 16 pedestrians within 200m`);
  assert.ok(report.density.cars[3] >= 15, `${pose}: at least 15 cars within 350m`);
  assert.ok(report.density.pedestrians[3] >= 24, `${pose}: at least 24 pedestrians within 350m`);
  assert.ok(report.cars.every((actor) => actor.edgeId && [actor.x, actor.y, actor.z, actor.speed].every(Number.isFinite)));
  assert.ok(report.pedestrians.every((actor) => actor.pathLength >= 2
    && [actor.x, actor.y, actor.z, actor.speed].every(Number.isFinite)));
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu
      && window.__CITYGEN__?.getState().generator === 'sf-builtin'
      && window.__CITYGEN__?.getState().pedestrians === 48,
    { timeout: 30000 },
  );

  await page.evaluate(() => {
    window.__CITYGEN__.setTime(14);
    window.__CITYGEN__.setCameraPose('sf');
  });
  await page.waitForTimeout(1400);
  const daylight = await sample();
  assertDensity(daylight, 'sf-daylight');

  const beforeMotion = await sample();
  await page.waitForTimeout(750);
  const afterMotion = await sample();
  const moved = (before, after, minimum) => before.filter((actor, index) => {
    const next = after[index];
    return Math.hypot(next.x - actor.x, next.y - actor.y, next.z - actor.z) >= minimum;
  }).length;
  assert.ok(moved(beforeMotion.cars, afterMotion.cars, 0.2) >= 12, 'at least 12 local-life cars keep moving');
  assert.ok(moved(beforeMotion.pedestrians, afterMotion.pedestrians, 0.2) >= 40, 'at least 40 pedestrians keep moving');
  assert.ok(afterMotion.phase > beforeMotion.phase, 'traffic and pedestrians share one advancing TrafficSim phase');
  assert.ok(afterMotion.state.clock > beforeMotion.state.clock, 'world clock advances from the same animation loop');

  await page.evaluate(() => {
    window.__CITYGEN__.setTime(22);
    window.__CITYGEN__.setCameraPose('night');
  });
  await page.waitForTimeout(1400);
  const night = await sample();
  assertDensity(night, 'night');

  const events = night.diagnostics.events;
  assert.ok(events.length >= 1, 'local-life recycling emits diagnostics');
  assert.ok(events.every((event) => event.fromDistance >= night.diagnostics.recycleRadius));
  assert.ok(events.every((event) => event.toDistance <= night.diagnostics.radius));
  assert.ok(events.every((event) => event.visibleBefore === false));
  assert.ok(events.filter((event) => !event.bootstrap).every((event) => event.visibleAfter === false));
  assert.ok(night.render.calls <= 1300, `draw calls remain bounded: ${night.render.calls}`);
  assert.ok(night.render.triangles <= 520000, `triangles remain bounded: ${night.render.triangles}`);
  assert.deepEqual(errors, []);

  console.log(JSON.stringify({
    result: 'PASS',
    url,
    daylight: { density: daylight.density, render: daylight.render },
    motion: {
      cars: moved(beforeMotion.cars, afterMotion.cars, 0.2),
      pedestrians: moved(beforeMotion.pedestrians, afterMotion.pedestrians, 0.2),
      trafficPhaseDelta: Number((afterMotion.phase - beforeMotion.phase).toFixed(3)),
      worldClockDelta: Number((afterMotion.state.clock - beforeMotion.state.clock).toFixed(3)),
    },
    night: { density: night.density, render: night.render },
    diagnostics: {
      enabled: night.diagnostics.enabled,
      radius: night.diagnostics.radius,
      recycleRadius: night.diagnostics.recycleRadius,
      carTarget: night.diagnostics.carTarget,
      pedestrianTarget: night.diagnostics.pedestrianTarget,
      carRecycles: night.diagnostics.carRecycles,
      pedestrianRecycles: night.diagnostics.pedestrianRecycles,
      focusUpdates: night.diagnostics.focusUpdates,
      localCars: night.diagnostics.localCars,
      localPedestrians: night.diagnostics.localPedestrians,
      safeRecycleEvents: night.diagnostics.events.length,
    },
    errors,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
