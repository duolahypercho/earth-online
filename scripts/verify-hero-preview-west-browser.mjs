import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];

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
  await page.screenshot({ path: '.qa-ferry-west-preview-crossing.png' });

  await page.evaluate(() => window.__SF_REALMAP__.build());
  await page.waitForFunction(() => window.__SF_REALMAP__.getHeroTileHandoff().active && window.__SF_REALMAP__.getHeroTileHandoff().previewNeighbor.status === 'not-mounted-preview', { timeout: 60000 });
  const rebuilt = await page.evaluate(() => window.__SF_REALMAP__.getHeroTileHandoff());
  assert.equal(rebuilt.neighborReady, false, 'rebuild must unmount the preview neighbor');
  await page.evaluate(() => document.querySelector('[data-action="back"]').click());
  await page.waitForFunction(() => window.__SF_REALMAP__.getHeroTileHandoff().active === false);
  const disposed = await page.evaluate(() => window.__SF_REALMAP__.getHeroTileHandoff());
  assert.equal(disposed.active, false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', url, crossed: { player: crossed.player, groundError: crossed.handoff.playerGrounding.error, cameraArm: crossed.camera.armDistance, fps: crossed.perf.fps, neighbor: crossed.handoff.previewNeighbor }, lifecycle: { rebuiltNeighbor: rebuilt.previewNeighbor.status, disposed: disposed.active }, screenshot: '.qa-ferry-west-preview-crossing.png' }, null, 2));
} finally {
  await browser.close();
}
