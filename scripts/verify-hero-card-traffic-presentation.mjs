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

  const stagedByCard = Object.fromEntries(captures.map((capture) => [
    capture.id,
    capture.traffic.staging.records.filter((record) => record.cardId === capture.id),
  ]));
  const movement = await page.evaluate(async () => {
    const initial = window.__SF_REALMAP__.getPerf().heroTrafficVisuals.staging.records;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const current = window.__SF_REALMAP__.getPerf().heroTrafficVisuals.staging.records;
    return current.map((record) => {
      const before = initial.find((candidate) => candidate.cardId === record.cardId);
      return {
        cardId: record.cardId,
        vehicleIndex: record.vehicleIndex,
        sourceRoadId: record.sourceRoadId,
        pathId: record.pathId,
        movedM: Math.hypot(record.position.x - before.position.x, record.position.z - before.position.z),
        initial: before,
        current: record,
      };
    });
  });
  assert.equal(captures[0].traffic.staging.count, 3, 'locked cards require two Card01 and one Card02 source records');
  for (const capture of captures) {
    const staged = stagedByCard[capture.id];
    assert.equal(staged.length, capture.id.startsWith('01-') ? 2 : 1, `${capture.id}: source staging count drifted`);
    for (const staging of staged) {
      const moved = movement.find((record) => record.cardId === capture.id
        && record.vehicleIndex === staging.vehicleIndex);
      assert.ok(moved, `${capture.id}: movement sample missing for staged vehicle ${staging.vehicleIndex}`);
      assert.equal(staging.sourceRoadId, 283512618, `${capture.id}: OSM Embarcadero road id drifted`);
      assert.equal(staging.sourceHighway, 'primary', `${capture.id}: vehicular highway class drifted`);
      assert.ok(staging.readable, `${capture.id}: staged source vehicle is not wholly readable`);
      assert.ok(staging.distanceToCameraM > 8, `${capture.id}: vehicle occupies the near camera exclusion zone`);
      assert.ok(staging.distanceToPlayerM > 10, `${capture.id}: vehicle is not a midground object`);
      assert.equal(moved.sourceRoadId, staging.sourceRoadId, `${capture.id}: moving vehicle lost its OSM road`);
      assert.equal(moved.pathId, staging.pathId, `${capture.id}: moving vehicle left its traffic path`);
      assert.ok(moved.movedM > 0.3, `${capture.id}: staged vehicle did not continue its normal update`);
    }
    assert.equal(capture.traffic.stats.drawCalls, 8, `${capture.id}: traffic draw-call budget drifted`);
    assert.equal(capture.traffic.stats.active, capture.traffic.sourceVehicles,
      `${capture.id}: source traffic records are not all represented`);
    assert.equal(capture.paths.oneWayViolations, 0, `${capture.id}: one-way topology changed`);
    assert.equal(capture.paths.twoWayViolations, 0, `${capture.id}: two-way topology changed`);
    assert.equal(capture.signal.legal, true, `${capture.id}: signal legality changed`);
  }
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({
    result: 'locked Ferry cards 01 and 02 have readable source-path traffic vehicles', url, captures, movement, errors,
  }, null, 2));
} finally {
  await browser.close();
}
