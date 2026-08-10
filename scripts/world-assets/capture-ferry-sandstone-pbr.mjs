import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { chromium } from 'playwright';

// A fixed orbit eye is used rather than the walk camera so third-person
// collision/framing cannot bias one material variant. It is 23.4 m from the
// exact Ferry facade target (inside the requested 20–35 m review range).
const POSE = Object.freeze({
  position: [2235, 14, 1902],
  target: [2253.3, 10, 1916],
  elevationAware: false,
});
const VIEWPORT = Object.freeze({ width: 1440, height: 810 });
const FOV = 52;
const NEAR = 0.08;
const FAR = 4200;
const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outDir = process.env.SF_FERRY_SANDSTONE_QA_DIR || '.qa-ferry-sandstone-fixed-orbit';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const conditions = [
  { id: 'day', weather: 'clear', exposure: 1.12 },
  { id: 'drizzle', weather: 'drizzle', exposure: 1.24 },
];

function nearlyEqualArray(actual, expected, epsilon = 1e-7) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => Math.abs(value - expected[index]) <= epsilon);
}

function cameraMatrices(cameraState) {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT.width / VIEWPORT.height, NEAR, FAR);
  camera.position.fromArray(cameraState.position);
  camera.lookAt(new THREE.Vector3().fromArray(cameraState.target));
  camera.updateMatrixWorld(true);
  return {
    view: camera.matrixWorldInverse.elements.map((value) => Number(value.toFixed(10))),
    projection: camera.projectionMatrix.elements.map((value) => Number(value.toFixed(10))),
  };
}

async function ready(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getHeroLandmark?.()?.active === true
      && window.__SF_REALMAP__?.getCameraState?.() != null,
    { timeout: 60000 },
  );
  await page.waitForTimeout(1600);
  return errors;
}

async function applyFixedCondition(page, condition) {
  await page.evaluate(({ pose, weather }) => {
    window.__SF_REALMAP__.setBeauty(true);
    window.__SF_REALMAP__.setCityMode('orbit');
    window.__SF_REALMAP__.setStreamFocus({ x: 2281.5306, z: 1936.6459 });
    window.__SF_REALMAP__.setTimeOfDay('day');
    window.__SF_REALMAP__.setWeather(weather);
    window.__SF_REALMAP__.setCameraPose(pose);
  }, { pose: POSE, weather: condition.weather });
  await page.waitForTimeout(250);
  const state = await page.evaluate(() => {
    const landmark = window.__SF_REALMAP__.getHeroLandmark();
    const perf = window.__SF_REALMAP__.getPerf();
    return {
      camera: window.__SF_REALMAP__.getCameraState(),
      landmark: {
        active: landmark?.active ?? false,
        error: landmark?.error ?? null,
        stats: landmark?.landmark?.stats ?? null,
        pbr: landmark?.landmark?.pbr ?? null,
      },
      perf: {
        fps: perf?.fps ?? null,
        avgFrameMs: perf?.avgFrameMs ?? null,
        drawCalls: perf?.heroLandmark?.landmark?.stats?.drawCalls ?? null,
        triangles: perf?.heroLandmark?.landmark?.stats?.triangles ?? null,
      },
    };
  });
  assert.ok(nearlyEqualArray(state.camera.position, POSE.position), 'fixed capture camera position drifted');
  assert.ok(nearlyEqualArray(state.camera.target, POSE.target), 'fixed capture camera target drifted');
  assert.equal(state.camera.timeOfDay, 'day', 'capture must use the day sun position');
  assert.equal(state.camera.weatherMode, condition.weather, 'capture weather drifted');
  return {
    ...state,
    cameraMatrices: cameraMatrices(state.camera),
    expectedExposure: condition.exposure,
  };
}

async function captureVariant({ id, blockPbrAssets }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  let blockedRequests = 0;
  if (blockPbrAssets) {
    await context.route(/polyhaven-sandstone-blocks-08-(diffuse-2k\.jpg|normal-gl-2k\.jpg|orm-2k\.png)$/, async (route) => {
      blockedRequests += 1;
      await route.abort();
    });
  }
  const page = await context.newPage();
  const errors = await ready(page);
  const captures = {};
  try {
    for (const condition of conditions) {
      const state = await applyFixedCondition(page, condition);
      const fullPath = join(outDir, `${condition.id}-${id}.png`);
      const cropPath = join(outDir, `${condition.id}-${id}-facade-2x.png`);
      await page.screenshot({ path: fullPath });
      // CSS crop at deviceScaleFactor 2 gives a 2× 1800×840 facade-bay crop.
      await page.screenshot({ path: cropPath, clip: { x: 250, y: 190, width: 900, height: 420 } });
      captures[condition.id] = { fullPath, cropPath, state };
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return { id, blockPbrAssets, blockedRequests, errors, captures };
}

async function probePbrPerformance() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = await ready(page);
  try {
    await applyFixedCondition(page, conditions[0]);
    await page.waitForTimeout(3000);
    const sampled = await page.evaluate(async () => {
      const start = performance.now();
      let previous = start;
      const frameMs = [];
      await new Promise((resolve) => {
        const tick = (now) => {
          frameMs.push(now - previous);
          previous = now;
          if (now - start >= 5000) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const elapsedMs = performance.now() - start;
      return {
        elapsedMs: Number(elapsedMs.toFixed(1)),
        frames: frameMs.length,
        sustainedFps: Number((frameMs.length * 1000 / elapsedMs).toFixed(1)),
        meanFrameMs: Number((frameMs.reduce((sum, value) => sum + value, 0) / frameMs.length).toFixed(2)),
        app: window.__SF_REALMAP__.getPerf(),
      };
    });
    assert.ok(sampled.sustainedFps >= 60, `PBR material must sustain 60 FPS, received ${sampled.sustainedFps}`);
    return { ...sampled, errors };
  } finally {
    await context.close();
    await browser.close();
  }
}

await mkdir(outDir, { recursive: true });
const fallback = await captureVariant({ id: 'before-fallback', blockPbrAssets: true });
const pbr = await captureVariant({ id: 'after-pbr', blockPbrAssets: false });
const performance = await probePbrPerformance();
const comparisons = conditions.map((condition) => {
  const before = fallback.captures[condition.id].state;
  const after = pbr.captures[condition.id].state;
  const viewEqual = JSON.stringify(before.cameraMatrices.view) === JSON.stringify(after.cameraMatrices.view);
  const projectionEqual = JSON.stringify(before.cameraMatrices.projection) === JSON.stringify(after.cameraMatrices.projection);
  const lightingEqual = before.camera.sunIntensity === after.camera.sunIntensity
    && JSON.stringify(before.camera.sunPosition) === JSON.stringify(after.camera.sunPosition)
    && before.expectedExposure === after.expectedExposure;
  assert.ok(viewEqual, `${condition.id}: view matrices must match`);
  assert.ok(projectionEqual, `${condition.id}: projection matrices must match`);
  assert.ok(lightingEqual, `${condition.id}: sun or exposure drifted`);
  return { id: condition.id, viewEqual, projectionEqual, lightingEqual };
});
assert.equal(pbr.errors.length, 0, 'loaded-PBR capture emitted runtime errors');
assert.equal(fallback.blockedRequests, 3, 'fallback capture must block exactly the three PBR image requests');
assert.equal(fallback.errors.length, 3, 'fallback capture must contain only the three expected blocked-image errors');
const report = {
  result: 'passed',
  url,
  pose: POSE,
  cameraModel: { fov: FOV, near: NEAR, far: FAR, viewport: VIEWPORT },
  fallback,
  pbr,
  performance,
  comparisons,
  note: 'Fallback intentionally aborts exactly the three Poly Haven PBR image requests. All other scene code, pose, sun position, weather state, and exposure are identical within each before/after pair.',
};
await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
