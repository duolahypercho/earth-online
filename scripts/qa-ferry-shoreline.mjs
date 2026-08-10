import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outDir = process.env.SF_FERRY_SHORELINE_QA_DIR || '.qa-ferry-shoreline';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const viewport = Object.freeze({ width: 1440, height: 810 });
// The point is source land, 7.3 m from the DataSF Bay edge; the heading faces
// the known water side of that same source segment.  It is deliberately not a
// camera-only hole or a teleport into water.
const waterfrontPose = Object.freeze({ x: 2420, z: 1820, yaw: 2.4106859464 });
const conditions = Object.freeze([
  { id: 'waterfront-clear-day', weather: 'clear', time: 'day' },
  { id: 'waterfront-drizzle-day', weather: 'drizzle', time: 'day' },
  { id: 'waterfront-clear-dusk', weather: 'clear', time: 'dusk' },
]);

function rounded(values) {
  return values.map((value) => Number(value.toFixed(10)));
}

function matrices(camera) {
  assert(camera?.cameraPosition && camera?.lookTarget, 'hero camera pose is missing');
  const projection = new THREE.PerspectiveCamera(camera.fov, camera.aspect, camera.nearClip, camera.far);
  projection.position.fromArray(camera.cameraPosition);
  projection.lookAt(new THREE.Vector3().fromArray(camera.lookTarget));
  projection.updateMatrixWorld(true);
  return {
    view: rounded(projection.matrixWorldInverse.elements),
    projection: rounded(projection.projectionMatrix.elements),
  };
}

async function waitForHero(page, errors) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getPlayerPosition?.() != null
      && window.__SF_REALMAP__?.getHeroCamera?.().active === true
      && window.__SF_REALMAP__?.getPerf?.().heroShoreline?.active === true,
    { timeout: 60000 },
  );
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
}

async function configure(page, condition) {
  await page.evaluate(({ condition: next, pose }) => {
    window.__SF_REALMAP__.setWeather(next.weather);
    window.__SF_REALMAP__.setTimeOfDay(next.time);
    window.__SF_REALMAP__.setPlayerPose(pose);
  }, { condition, pose: waterfrontPose });
  await page.waitForTimeout(900);
  return page.evaluate(() => ({
    player: window.__SF_REALMAP__.getPlayerPosition(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
    shoreline: window.__SF_REALMAP__.getPerf().heroShoreline,
    atmosphere: window.__SF_REALMAP__.getHeroAtmosphere(),
    performance: window.__SF_REALMAP__.getPerf(),
  }));
}

function assertWaterfrontState(id, state) {
  assert.equal(state.player.x, waterfrontPose.x, `${id}: player X drifted from the source-land waterfront pose`);
  assert.equal(state.player.z, waterfrontPose.z, `${id}: player Z drifted from the source-land waterfront pose`);
  assert.equal(state.camera.cameraInsideBuilding, false, `${id}: waterfront camera entered a building`);
  assert.equal(state.camera.cameraInsideVehicle, false, `${id}: waterfront camera entered a vehicle`);
  assert.equal(state.camera.occluded, false, `${id}: waterfront camera spring arm is occluded`);
  assert.equal(state.shoreline.playerOnSourceLand, true, `${id}: player is no longer source land`);
  assert.equal(state.shoreline.sourceProbe.waterfrontLand.groundTriangle, true, `${id}: source land lost its ground triangle`);
  assert.equal(state.shoreline.sourceProbe.bay.sourceLand, false, `${id}: known Bay point mutated into land`);
  assert.equal(state.shoreline.sourceProbe.bay.groundTriangle, false, `${id}: known Bay point retained a ground triangle`);
  assert.equal(state.shoreline.transition.sourceAligned, true, `${id}: shoreline transition is not source aligned`);
  assert.equal(state.shoreline.transition.landInsetM, 0.9, `${id}: shoreline transition width drifted`);
  assert.equal(state.shoreline.transition.gridUnderlapM, 6, `${id}: shoreline grid underlap drifted`);
  assert.equal(state.atmosphere.waterVisible, true, `${id}: water surface is not visible`);
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
    await configure(page, conditions[0]);
    await page.waitForTimeout(3000);
    const result = await page.evaluate(async () => {
      let frames = 0;
      const started = performance.now();
      await new Promise((resolve) => {
        const frame = (now) => {
          frames += 1;
          if (now - started >= 5000) return resolve();
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      const elapsedMs = performance.now() - started;
      return {
        frames,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        sustainedFps: Number((frames * 1000 / elapsedMs).toFixed(1)),
        app: window.__SF_REALMAP__.getPerf(),
      };
    });
    assert.equal(errors.length, 0, `performance browser errors: ${errors.join(' | ')}`);
    assert.ok(result.sustainedFps >= 60, `waterfront must sustain >=60 warmed FPS, received ${result.sustainedFps}`);
    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
const captures = [];
try {
  await waitForHero(page, errors);
  const waterClamp = await page.evaluate(() => {
    const requested = { x: 2400, z: 1880, yaw: 2.4106859464 };
    const resolved = window.__SF_REALMAP__.setPlayerPose(requested);
    return {
      requested,
      resolved,
      player: window.__SF_REALMAP__.getPlayerPosition(),
      shoreline: window.__SF_REALMAP__.getPerf().heroShoreline,
    };
  });
  assert.equal(waterClamp.shoreline.sourceProbe.bay.sourceLand, false, 'water clamp probe must target source water');
  assert.equal(waterClamp.shoreline.sourceProbe.bay.groundTriangle, false, 'water clamp probe must target a ground-free Bay point');
  assert.equal(waterClamp.shoreline.playerOnSourceLand, true, 'water pose was left walkable');
  assert.notDeepEqual(
    [waterClamp.player.x, waterClamp.player.z],
    [waterClamp.requested.x, waterClamp.requested.z],
    'source-water pose was not clamped back to land',
  );
  let baselineMatrices = null;
  for (const condition of conditions) {
    const state = await configure(page, condition);
    assertWaterfrontState(condition.id, state);
    const cameraMatrices = matrices(state.camera);
    if (baselineMatrices) {
      assert.deepEqual(cameraMatrices, baselineMatrices, `${condition.id}: fixed waterfront camera matrices drifted`);
    } else {
      baselineMatrices = cameraMatrices;
    }
    const path = join(outDir, `${condition.id}.png`);
    await page.screenshot({ path });
    captures.push({
      id: condition.id,
      path,
      condition,
      player: state.player,
      camera: state.camera,
      cameraMatrices,
      shoreline: state.shoreline,
      targetWaterCoverage: '25–50% of the lower/central frame; visual review required',
    });
  }
  const restored = await configure(page, conditions[0]);
  assertWaterfrontState('restored-clear', restored);
  assert.deepEqual(matrices(restored.camera), baselineMatrices, 'clear lifecycle restoration drifted camera matrices');
  assert.equal(errors.length, 0, `capture browser errors: ${errors.join(' | ')}`);
  const performance = await probePerformance();
  const manifest = {
    result: 'passed',
    url,
    viewport,
    waterfrontPose,
    waterClamp,
    captures,
    restored: { player: restored.player, shoreline: restored.shoreline },
    performance,
    errors,
    note: 'The camera is a fixed, in-bounds third-person human view. Source-land/water assertions are automated; the 25–50% water composition remains a visual review gate.',
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await context.close();
  await browser.close();
}
