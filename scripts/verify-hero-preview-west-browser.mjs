import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import * as THREE from 'three';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
const lockedCrossingPose = { x: 2114.9, z: 1854, yaw: -Math.PI / 2 };

function roundedMatrix(matrix) {
  return matrix.elements.map((value) => Number(value.toFixed(6)));
}

function cameraMatrices(camera) {
  assert.ok(Array.isArray(camera.cameraPosition) && Array.isArray(camera.lookTarget), 'camera pose diagnostics are required for locked visual QA');
  const eye = new THREE.Vector3(...camera.cameraPosition);
  const target = new THREE.Vector3(...camera.lookTarget);
  const view = new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(0, 1, 0));
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.nearClip;
  const halfWidth = halfHeight * camera.aspect;
  const projection = new THREE.Matrix4().makePerspective(-halfWidth, halfWidth, halfHeight, -halfHeight, camera.nearClip, camera.far);
  return { view: roundedMatrix(view), projection: roundedMatrix(projection) };
}

async function lockedPreviewFrame(page, enabled, file) {
  await page.evaluate((nextEnabled) => {
    const qa = window.__SF_FERRY_WEST_PREVIEW_QA__;
    if (!qa?.setPresentationEnabled) throw new Error('Preview QA hook is not mounted.');
    qa.setPresentationEnabled(nextEnabled);
  }, enabled);
  await page.waitForTimeout(250);
  await page.screenshot({ path: file });
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.body.classList.contains('is-city') && window.__SF_REALMAP__?.getHeroTileHandoff?.().active, { timeout: 60000 });
  const initial = await page.evaluate(() => window.__SF_REALMAP__.getHeroTileHandoff());
  assert.equal(initial.previewNeighbor.status, 'not-mounted-preview');
  assert.equal(initial.neighborReady, false);

  // OSM footprint analysis selects this clear California Street approach:
  // it is a real path through the west boundary, not a teleport fixture.
  await page.evaluate(() => window.__SF_REALMAP__.setPlayerPose({ x: 2160, z: 1854, yaw: -Math.PI / 2 }));
  await page.keyboard.down('w');
  await page.waitForFunction(() => window.__SF_REALMAP__.getHeroTileHandoff().previewNeighbor?.mounted === true, { timeout: 30000 });
  await page.waitForFunction(() => window.__SF_REALMAP__.getPlayerPosition().x < 2115, { timeout: 30000 });
  await page.keyboard.up('w');
  await page.waitForTimeout(800);

  const crossed = await page.evaluate(() => ({
    player: window.__SF_REALMAP__.getPlayerPosition(),
    handoff: window.__SF_REALMAP__.getHeroTileHandoff(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
    terrain: window.__SF_REALMAP__.getElevationAt(window.__SF_REALMAP__.getPlayerPosition().x, window.__SF_REALMAP__.getPlayerPosition().z),
    perf: window.__SF_REALMAP__.getPerf(),
  }));
  assert.ok(crossed.player.x < 2144 && crossed.player.x >= 1760, 'continuous walking must end in the neighbor core');
  assert.equal(crossed.handoff.neighborReady, true, 'ready becomes true only after mount');
  assert.equal(crossed.handoff.previewNeighbor.id, 'sf-ferry-building-west-preview-v1');
  assert.equal(crossed.handoff.previewNeighbor.previewOnly, true);
  assert.ok(crossed.handoff.previewNeighbor.edge.withinOneCentimeter);
  assert.ok(Math.abs(crossed.handoff.playerGrounding.error) <= 0.05, 'avatar must remain grounded to resident terrain');
  assert.ok(crossed.camera.armDistance >= 4, 'camera arm must remain playable');
  assert.equal(crossed.camera.cameraInsideBuilding, false);
  assert.equal(crossed.camera.cameraInsideVehicle, false);
  assert.ok(crossed.perf.fps >= 60, `warmed FPS must be >=60 (got ${crossed.perf.fps})`);
  assert.deepEqual(errors, []);

  // Freeze the resident player and camera fixture after the continuous walk.
  // The only difference between frames below is the preview presentation pass.
  await page.evaluate((pose) => window.__SF_REALMAP__.setPlayerPose(pose), lockedCrossingPose);
  await page.waitForTimeout(650);
  const locked = await page.evaluate(() => ({
    player: window.__SF_REALMAP__.getPlayerPosition(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
    handoff: window.__SF_REALMAP__.getHeroTileHandoff(),
  }));
  assert.ok(Math.abs(locked.player.x - lockedCrossingPose.x) <= 0.01 && Math.abs(locked.player.z - lockedCrossingPose.z) <= 0.01, 'locked capture pose must remain on the continuous crossing corridor');
  assert.equal(locked.handoff.previewNeighbor.previewOnly, true, 'the QA switch may not change preview-only provenance');
  assert.equal(locked.camera.cameraInsideBuilding, false, 'locked crossing camera must remain outside building geometry');
  assert.ok(locked.camera.armDistance >= 4, 'locked crossing camera must remain playable');

  await lockedPreviewFrame(page, false, '.qa-ferry-west-preview-crossing-before.png');
  const before = await page.evaluate(() => ({ player: window.__SF_REALMAP__.getPlayerPosition(), camera: window.__SF_REALMAP__.getHeroCamera() }));
  await lockedPreviewFrame(page, true, '.qa-ferry-west-preview-crossing-after.png');
  const after = await page.evaluate(() => ({ player: window.__SF_REALMAP__.getPlayerPosition(), camera: window.__SF_REALMAP__.getHeroCamera(), perf: window.__SF_REALMAP__.getPerf() }));
  assert.deepEqual(after.player, before.player, 'before/after captures must share the exact player pose');
  assert.deepEqual(cameraMatrices(after.camera), cameraMatrices(before.camera), 'before/after captures must share view and projection matrices');
  assert.ok(after.perf.fps >= 60, `presented preview must sustain >=60 FPS (got ${after.perf.fps})`);

  await page.evaluate(() => window.__SF_REALMAP__.build());
  await page.waitForFunction(() => window.__SF_REALMAP__.getHeroTileHandoff().active && window.__SF_REALMAP__.getHeroTileHandoff().previewNeighbor.status === 'not-mounted-preview', { timeout: 60000 });
  const rebuilt = await page.evaluate(() => window.__SF_REALMAP__.getHeroTileHandoff());
  assert.equal(rebuilt.neighborReady, false, 'rebuild must unmount the preview neighbor');
  await page.evaluate(() => document.querySelector('[data-action="back"]').click());
  await page.waitForFunction(() => window.__SF_REALMAP__.getHeroTileHandoff().active === false);
  const disposed = await page.evaluate(() => window.__SF_REALMAP__.getHeroTileHandoff());
  assert.equal(disposed.active, false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', url, crossed: { player: crossed.player, groundError: crossed.handoff.playerGrounding.error, cameraArm: crossed.camera.armDistance, fps: crossed.perf.fps, neighbor: crossed.handoff.previewNeighbor }, locked: { pose: locked.player, cameraMatrices: cameraMatrices(after.camera), fps: after.perf.fps, before: '.qa-ferry-west-preview-crossing-before.png', after: '.qa-ferry-west-preview-crossing-after.png' }, lifecycle: { rebuiltNeighbor: rebuilt.previewNeighbor.status, disposed: disposed.active } }, null, 2));
} finally {
  await browser.close();
}
