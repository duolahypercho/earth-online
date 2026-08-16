import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.body.classList.contains('is-city')
      && window.__SF_REALMAP__?.getHeroTileHandoff?.().active === true
      && window.__SF_REALMAP__?.getHeroCamera?.().active === true,
    { timeout: 60000 },
  );

  const initial = await page.evaluate(() => ({
    handoff: window.__SF_REALMAP__.getHeroTileHandoff(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
    build: window.__SF_REALMAP__.getBuildState(),
  }));
  assert.deepEqual(
    initial.handoff.authoritativeRuntimeCore.bounds,
    { minX: 2144, minZ: 1728, maxX: 2528, maxZ: 2112 },
    'live hero bounds must remain authoritative',
  );
  assert.deepEqual(
    initial.handoff.authoritativeRuntimeCore.bufferedBounds,
    { minX: 2128, minZ: 1712, maxX: 2544, maxZ: 2128 },
    'the runtime must expose the complete 16m resident buffer',
  );
  assert.equal(initial.handoff.singleTileContractMismatch, true, 'the live region must not be labeled as one regular tile');
  assert.equal(initial.handoff.regionReference.coverageKind, '2x2-planned-tile-reference');
  assert.equal(initial.handoff.regionReference.tileIds.length, 4, 'the reconciled region must reference its complete 2x2 planned coverage');
  assert.equal(initial.handoff.regionReference.runtimeHandoff, 'not-yet-backed-by-published-tile-artifacts');
  assert.equal(initial.handoff.neighborReady, false, 'no production neighbor is loaded');
  assert.ok(initial.build.collisionVolumes > 0, 'hero building collision volumes must remain active');

  // This is a clear continuous corridor across the west edge. The older
  // diagonal launch route ends near collision geometry at z≈1802 and is not a
  // valid camera-quality fixture for the handoff itself.
  await page.evaluate(() => window.__SF_REALMAP__.setPlayerPose({ x: 2160, z: 1900, yaw: -Math.PI / 2 }));
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => window.__SF_REALMAP__.getHeroTileHandoff().insideBuffer === true,
    { timeout: 15000 },
  );
  const crossing = await page.evaluate(() => ({
    player: window.__SF_REALMAP__.getPlayerPosition(),
    handoff: window.__SF_REALMAP__.getHeroTileHandoff(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
  }));
  assert.equal(crossing.handoff.insideBuffer, true, 'continuous movement must enter resident buffer geometry');
  assert.equal(crossing.handoff.playerGrounding.avatarVisible, true, 'the crossing avatar must remain rendered');
  assert.ok(Math.abs(crossing.handoff.playerGrounding.error) < 1e-7, 'the crossing avatar must remain terrain-grounded');
  assert.equal(crossing.camera.forcedCloseCamera, false, 'camera must not collapse during the boundary crossing');
  assert.equal(crossing.camera.occluded, false, 'camera must stay unoccluded during the boundary crossing');
  assert.equal(crossing.camera.cameraInsideBuilding, false, 'crossing camera must remain outside buildings');
  assert.equal(crossing.camera.cameraInsideVehicle, false, 'crossing camera must remain outside vehicles');
  assert.ok(crossing.camera.armDistance >= 4, 'crossing camera arm must remain playable');
  await page.waitForFunction(
    () => window.__SF_REALMAP__.getHeroTileHandoff().clampedToBuffer === true,
    { timeout: 10000 },
  );
  await page.keyboard.up('w');
  await page.waitForTimeout(700);

  const sustained = await page.evaluate(() => ({
    player: window.__SF_REALMAP__.getPlayerPosition(),
    handoff: window.__SF_REALMAP__.getHeroTileHandoff(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
  }));
  assert.equal(sustained.handoff.coreBoundaryCrossed, true, 'sustained movement must cross the live core boundary');
  assert.equal(sustained.handoff.insideBuffer, true, 'the player must remain in resident buffered geometry');
  assert.equal(sustained.handoff.neighborRequested, true, 'a core exit must emit an unresolved neighbor request');
  assert.equal(sustained.handoff.neighborReady, false, 'the unresolved neighbor must not be reported ready');
  assert.equal(sustained.handoff.clampedToBuffer, true, 'sustained movement must stop at the resident buffer edge');
  assert.ok(sustained.player.x >= 2128 && sustained.player.x <= 2544 && sustained.player.z >= 1712 && sustained.player.z <= 2128);
  assert.equal(sustained.handoff.playerGrounding.avatarVisible, true, 'buffer-edge avatar must remain rendered');
  assert.ok(Math.abs(sustained.handoff.playerGrounding.error) < 1e-7, 'buffer-edge avatar must remain terrain-grounded');
  assert.equal(sustained.camera.forcedCloseCamera, false, 'camera must not collapse at the buffer edge');
  assert.equal(sustained.camera.occluded, false, 'camera must stay unoccluded at the buffer edge');
  assert.equal(sustained.camera.cameraInsideBuilding, false, 'third-person camera must remain outside building collision');
  assert.equal(sustained.camera.cameraInsideVehicle, false, 'third-person camera must remain outside vehicles');
  assert.ok(sustained.camera.armDistance >= 4, 'third-person camera must retain a playable arm at the buffer edge');

  const reentry = await page.evaluate(() => {
    window.__SF_REALMAP__.setPlayerPosition(2173, 1831.4);
    return {
      player: window.__SF_REALMAP__.getPlayerPosition(),
      handoff: window.__SF_REALMAP__.getHeroTileHandoff(),
    };
  });
  assert.equal(reentry.handoff.reenteredCore, true, 'buffer-to-core movement must be diagnosed as reentry');
  assert.equal(reentry.handoff.insideCore, true, 'reentry must end in the authoritative core');

  const highSpeed = await page.evaluate(() => {
    window.__SF_REALMAP__.setPlayerPosition(1800, 1831.4);
    const player = window.__SF_REALMAP__.getPlayerPosition();
    return {
      player,
      terrain: window.__SF_REALMAP__.getElevationAt(player.x, player.z),
      handoff: window.__SF_REALMAP__.getHeroTileHandoff(),
      camera: window.__SF_REALMAP__.getHeroCamera(),
    };
  });
  assert.equal(highSpeed.player.x, 2128, 'high-speed west movement must clamp at the loaded buffer edge');
  assert.equal(highSpeed.handoff.lastCoreBoundaryCrossed, true, 'high-speed movement must not tunnel past crossing diagnostics');
  assert.equal(highSpeed.handoff.insideBuffer, true);
  assert.equal(highSpeed.handoff.clampedToBuffer, true);
  assert.equal(highSpeed.handoff.neighborReady, false);
  assert.equal(highSpeed.handoff.controller.events.at(-1).neighborIds[0], null, 'runtime must not fabricate a manifest neighbor id');
  assert.ok(Math.abs(highSpeed.handoff.terrainY - highSpeed.terrain) < 1e-7, 'terrain must be sampled at the final buffer-constrained position');

  await page.evaluate(() => window.__SF_REALMAP__.build());
  await page.waitForFunction(
    () => window.__SF_REALMAP__.getHeroTileHandoff().active === true
      && window.__SF_REALMAP__.getHeroTileHandoff().controller.events.length === 0,
    { timeout: 60000 },
  );
  const rebuilt = await page.evaluate(() => window.__SF_REALMAP__.getHeroTileHandoff());
  assert.equal(rebuilt.active, true, 'a city rebuild must initialize a fresh handoff controller');
  assert.equal(rebuilt.controller.events.length, 0, 'a rebuild must dispose prior handoff event state');
  assert.equal(rebuilt.insideCore, true, 'the rebuilt player launch must resolve inside the runtime core');

  await page.evaluate(() => document.querySelector('[data-action="back"]').click());
  await page.waitForFunction(() => window.__SF_REALMAP__.getHeroTileHandoff().active === false);
  const disposed = await page.evaluate(() => window.__SF_REALMAP__.getHeroTileHandoff());
  assert.equal(disposed.active, false, 'leaving the city must dispose the handoff controller');
  assert.deepEqual(errors, [], 'the browser run must remain free of page and console errors');

  console.log(JSON.stringify({
    result: 'passed',
    url,
    sustained: {
      player: sustained.player,
      insideBuffer: sustained.handoff.insideBuffer,
      clampedToBuffer: sustained.handoff.clampedToBuffer,
      cameraArmDistance: sustained.camera.armDistance,
      groundError: sustained.handoff.playerGrounding.error,
    },
    reentry: {
      player: reentry.player,
      reenteredCore: reentry.handoff.reenteredCore,
    },
    highSpeed: {
      player: highSpeed.player,
      terrainY: highSpeed.handoff.terrainY,
      neighborId: highSpeed.handoff.controller.events.at(-1).neighborIds[0],
    },
    lifecycle: {
      rebuiltActive: rebuilt.active,
      rebuiltEvents: rebuilt.controller.events.length,
      disposedActive: disposed.active,
    },
    errors,
  }, null, 2));
} finally {
  await browser.close();
}
