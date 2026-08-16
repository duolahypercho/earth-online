import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { chromium } from 'playwright';

const phase = process.env.SF_FERRY_FACADE_PHASE || 'after';
assert.ok(phase === 'before' || phase === 'after', 'SF_FERRY_FACADE_PHASE must be before or after');

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outDir = process.env.SF_FERRY_FACADE_QA_DIR || '.qa-ferry-segmented-facade';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const viewport = Object.freeze({ width: 1440, height: 810 });
const cameraModel = Object.freeze({ fov: 52, near: 0.08, far: 4200 });
const target = Object.freeze([2253.3, 7.2, 1916]);
const direction = new THREE.Vector3(-18.3, 4, -14).normalize();
const poses = [16, 23].map((distance) => ({
  id: `${distance}m`,
  distance,
  position: new THREE.Vector3().fromArray(target).addScaledVector(direction, distance).toArray(),
  target,
  elevationAware: false,
}));
const ferryFootprint = await (async () => {
  const source = JSON.parse(await readFile(new URL('../public/data/sf/sf-city.json', import.meta.url), 'utf8'));
  const building = source.detailBuildings.find((candidate) => String(candidate.id) === '558731934');
  assert.ok(building, 'exact Ferry Building OSM way must exist in the shipped SF city snapshot');
  assert.ok(Array.isArray(building.points) && building.points.length >= 6, 'exact Ferry Building OSM footprint must contain a polygon');
  return Array.from({ length: building.points.length / 2 }, (_, index) => [
    building.points[index * 2],
    building.points[index * 2 + 1],
  ]);
})();

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [x, z] = polygon[index];
    const [previousX, previousZ] = polygon[previous];
    const crosses = (z > point[1]) !== (previousZ > point[1])
      && point[0] < ((previousX - x) * (point[1] - z)) / (previousZ - z) + x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToFootprint(point, polygon) {
  let minimum = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const lengthSq = dx * dx + dz * dz;
    const progress = lengthSq > 0
      ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSq))
      : 0;
    minimum = Math.min(minimum, Math.hypot(
      point[0] - (start[0] + dx * progress),
      point[1] - (start[1] + dz * progress),
    ));
  }
  return minimum;
}

function rounded(elements) {
  return elements.map((value) => {
    const roundedValue = Number(value.toFixed(10));
    return Object.is(roundedValue, -0) ? 0 : roundedValue;
  });
}

function cameraMatrices(pose) {
  const camera = new THREE.PerspectiveCamera(
    cameraModel.fov,
    viewport.width / viewport.height,
    cameraModel.near,
    cameraModel.far,
  );
  camera.position.fromArray(pose.position);
  camera.lookAt(new THREE.Vector3().fromArray(pose.target));
  camera.updateMatrixWorld(true);
  return {
    view: rounded(camera.matrixWorldInverse.elements),
    projection: rounded(camera.projectionMatrix.elements),
  };
}

function lightMatrices(cameraState) {
  // The hero tile's day rig targets the loaded OSM region centroid. These are
  // the exact orthographic shadow-camera bounds configured by realmap/main.js.
  const lightTarget = new THREE.Vector3(2336, 0, 1920);
  const lightCamera = new THREE.OrthographicCamera(-420, 420, 420, -420, 10, 1600);
  lightCamera.position.fromArray(cameraState.sunPosition);
  lightCamera.lookAt(lightTarget);
  lightCamera.updateMatrixWorld(true);
  return {
    view: rounded(lightCamera.matrixWorldInverse.elements),
    projection: rounded(lightCamera.projectionMatrix.elements),
    target: lightTarget.toArray(),
    intensity: cameraState.sunIntensity,
  };
}

async function waitForHero(page, errors) {
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
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    window.__SF_REALMAP__.setBeauty(true);
    window.__SF_REALMAP__.setTimeOfDay('day');
    window.__SF_REALMAP__.setWeather('clear');
  });
}

async function capturePhase() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  const captures = [];
  let defaultLaunch = null;
  try {
    await waitForHero(page, errors);
    await page.evaluate(() => {
      window.__SF_REALMAP__.setCityMode('orbit');
      window.__SF_REALMAP__.setStreamFocus({ x: 2281.5306, z: 1936.6459 });
    });
    for (const pose of poses) {
      const footprintPoint = [pose.position[0], pose.position[2]];
      const insideFootprint = pointInPolygon(footprintPoint, ferryFootprint);
      const footprintClearanceM = distanceToFootprint(footprintPoint, ferryFootprint);
      assert.equal(insideFootprint, false, `${pose.id}: capture eye must be outside exact OSM way 558731934`);
      assert.ok(footprintClearanceM >= 1, `${pose.id}: capture eye needs a defensible exterior clearance`);
      await page.evaluate((nextPose) => window.__SF_REALMAP__.setCameraPose(nextPose), pose);
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => ({
        camera: window.__SF_REALMAP__.getCameraState(),
        landmark: window.__SF_REALMAP__.getHeroLandmark()?.landmark,
      }));
      assert.deepEqual(state.camera.position.map((value) => Number(value.toFixed(8))), pose.position.map((value) => Number(value.toFixed(8))), `${pose.id}: camera position drifted`);
      assert.deepEqual(state.camera.target.map((value) => Number(value.toFixed(8))), pose.target.map((value) => Number(value.toFixed(8))), `${pose.id}: camera target drifted`);
      assert.equal(state.camera.timeOfDay, 'day', `${pose.id}: time of day drifted`);
      assert.equal(state.camera.weatherMode, 'clear', `${pose.id}: weather drifted`);
      const fullPath = join(outDir, `${phase}-${pose.id}.png`);
      const cropPath = join(outDir, `${phase}-${pose.id}-facade-2x.png`);
      await page.screenshot({ path: fullPath });
      await page.screenshot({ path: cropPath, clip: { x: 120, y: 110, width: 1200, height: 590 } });
      captures.push({
        id: pose.id,
        distance: pose.distance,
        fullPath,
        cropPath,
        camera: state.camera,
        cameraMatrices: cameraMatrices(pose),
        lightMatrices: lightMatrices(state.camera),
        exactOsmCameraExterior: {
          osmWay: 558731934,
          footprintPoints: ferryFootprint.length,
          insideFootprint,
          footprintClearanceM: Number(footprintClearanceM.toFixed(3)),
        },
        landmark: state.landmark,
      });
    }

    if (phase === 'after') {
      const launchPage = await context.newPage();
      await waitForHero(launchPage, errors);
      await launchPage.waitForTimeout(600);
      const launchState = await launchPage.evaluate(() => ({
        camera: window.__SF_REALMAP__.getCameraState(),
        heroCamera: window.__SF_REALMAP__.getHeroCamera(),
        landmark: window.__SF_REALMAP__.getHeroLandmark(),
        player: window.__SF_REALMAP__.getPlayerPosition(),
      }));
      assert.equal(launchState.heroCamera?.active, true, 'default launch must retain the Ferry hero camera');
      assert.equal(launchState.heroCamera?.cameraInsideBuilding, false, 'default launch camera must remain outside building collision');
      assert.equal(launchState.landmark?.active, true, 'default launch must retain the Ferry landmark');
      assert.equal(launchState.landmark?.error, null, 'default launch landmark must not report an integration error');
      const launchPath = join(outDir, 'after-default-launch.png');
      await launchPage.screenshot({ path: launchPath });
      defaultLaunch = { path: launchPath, ...launchState };
      await launchPage.close();
    }
  } finally {
    await context.close();
    await browser.close();
  }
  assert.equal(errors.length, 0, `${phase}: browser errors: ${errors.join(' | ')}`);
  return { phase, captures, defaultLaunch, errors };
}

async function probePerformance() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  try {
    await waitForHero(page, errors);
    await page.evaluate(() => {
      window.__SF_REALMAP__.setCityMode('orbit');
      window.__SF_REALMAP__.setStreamFocus({ x: 2281.5306, z: 1936.6459 });
    });
    await page.evaluate((pose) => window.__SF_REALMAP__.setCameraPose(pose), poses[0]);
    await page.waitForTimeout(3000);
    const result = await page.evaluate(async () => {
      const started = performance.now();
      let frames = 0;
      await new Promise((resolve) => {
        const tick = (now) => {
          frames += 1;
          if (now - started >= 5000) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const elapsedMs = performance.now() - started;
      return {
        frames,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        sustainedFps: Number((frames * 1000 / elapsedMs).toFixed(1)),
        app: window.__SF_REALMAP__.getPerf(),
      };
    });
    assert.equal(errors.length, 0, `performance probe browser errors: ${errors.join(' | ')}`);
    assert.ok(result.sustainedFps >= 60, `segmented facade must sustain >=60 warmed FPS, received ${result.sustainedFps}`);
    return { ...result, errors };
  } finally {
    await context.close();
    await browser.close();
  }
}

await mkdir(outDir, { recursive: true });
const current = await capturePhase();
const report = {
  result: 'captured',
  url,
  viewport,
  outputPixels: { width: viewport.width * 2, height: viewport.height * 2 },
  cameraModel,
  target,
  ...current,
};

if (phase === 'before') {
  await writeFile(join(outDir, 'before-report.json'), `${JSON.stringify(report, null, 2)}\n`);
} else {
  const before = JSON.parse(await readFile(join(outDir, 'before-report.json'), 'utf8'));
  const comparisons = report.captures.map((capture, index) => {
    const baseline = before.captures[index];
    assert.equal(capture.id, baseline.id, 'before/after pose order drifted');
    assert.deepEqual(capture.cameraMatrices.view, baseline.cameraMatrices.view, `${capture.id}: camera view matrix drifted`);
    assert.deepEqual(capture.cameraMatrices.projection, baseline.cameraMatrices.projection, `${capture.id}: camera projection matrix drifted`);
    assert.deepEqual(capture.lightMatrices.view, baseline.lightMatrices.view, `${capture.id}: light view matrix drifted`);
    assert.deepEqual(capture.lightMatrices.projection, baseline.lightMatrices.projection, `${capture.id}: light projection matrix drifted`);
    assert.equal(capture.lightMatrices.intensity, baseline.lightMatrices.intensity, `${capture.id}: light intensity drifted`);
    return {
      id: capture.id,
      cameraViewEqual: true,
      cameraProjectionEqual: true,
      lightViewEqual: true,
      lightProjectionEqual: true,
      lightIntensityEqual: true,
    };
  });
  report.comparisons = comparisons;
  report.performance = await probePerformance();
  report.result = 'passed';
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
