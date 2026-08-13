import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outputDir = resolve(process.env.SF_HERO_CARD_TRAFFIC_DIR || '.qa-hero-card-traffic-presentation');
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const cards = [
  { id: '01-commercial-street-day', x: 2173, z: 1831.4, yaw: 0.8008 },
  { id: '02-intersection-crosswalk', x: 2238, z: 1835, yaw: 2.28 },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getHeroCamera?.().active
      && window.__SF_REALMAP__?.getPerf?.().heroTrafficVisuals?.staging
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );

  const captures = [];
  for (const card of cards) {
    await page.evaluate((pose) => window.__SF_REALMAP__.setPlayerPose(pose), card);
    await page.waitForTimeout(900);
    const screenshot = resolve(outputDir, `${card.id}.png`);
    await page.screenshot({ path: screenshot });
    const diagnostics = await page.evaluate(() => ({
      traffic: window.__SF_REALMAP__.getPerf().heroTrafficVisuals,
      signal: window.__SF_REALMAP__.getSignalLegalityDiagnostics(),
      paths: window.__SF_REALMAP__.getTrafficPathDiagnostics(),
    }));
    captures.push({ id: card.id, screenshot, ...diagnostics });
  }

  const card02 = captures[1];
  const staging = card02.traffic.staging;
  const movement = await page.evaluate(async () => {
    const initial = window.__SF_REALMAP__.getPerf().heroTrafficVisuals.staging;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const current = window.__SF_REALMAP__.getPerf().heroTrafficVisuals.staging;
    return {
      sourceRoadId: current.sourceRoadId,
      pathId: current.pathId,
      movedM: Math.hypot(current.position.x - initial.position.x, current.position.z - initial.position.z),
      initial,
      current,
    };
  });
  assert.equal(staging.cardId, cards[1].id, 'staging must explicitly target the locked card 02 frame');
  assert.equal(staging.sourceRoadId, 283512618, 'staging must retain the existing OSM Embarcadero road id');
  assert.equal(staging.sourceHighway, 'primary', 'staging must retain the existing vehicular highway class');
  assert.ok(staging.readable, 'the staged source vehicle must be wholly readable in locked card 02');
  assert.ok(staging.distanceToCameraM > 8, 'the staged vehicle must not occupy the near camera exclusion zone');
  assert.ok(staging.distanceToPlayerM > 10, 'the staged vehicle must remain a non-occluding midground object');
  assert.equal(movement.sourceRoadId, staging.sourceRoadId, 'the moving vehicle must retain its OSM source road');
  assert.equal(movement.pathId, staging.pathId, 'the moving vehicle must retain its normal traffic path');
  assert.ok(movement.movedM > 0.3, 'the staged vehicle must continue its normal path update');
  assert.equal(card02.traffic.stats.drawCalls, 8, 'traffic presentation must retain its fixed draw-call budget');
  assert.equal(card02.traffic.stats.active, card02.traffic.sourceVehicles,
    'all source traffic records must remain represented by the presentation layer');
  assert.equal(card02.paths.oneWayViolations, 0, 'traffic staging must not alter one-way topology');
  assert.equal(card02.paths.twoWayViolations, 0, 'traffic staging must not alter two-way topology');
  assert.equal(card02.signal.legal, true, 'traffic staging must preserve signal legality');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({
    result: 'locked Ferry card 02 has a readable source-path traffic vehicle', url, captures, movement, errors,
  }, null, 2));
} finally {
  await browser.close();
}
