import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const cards = [
  { id: '01-commercial-street-day', x: 2173, z: 1831.4, yaw: 0.8008 },
  { id: '02-intersection-crosswalk', x: 2238, z: 1835, yaw: 2.28 },
];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [];

async function freshLockedCards(page) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getHeroCamera?.().active
      && window.__SF_REALMAP__?.getAmbientPedestrianCohort?.().count > 0
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  const result = [];
  for (const card of cards) {
    await page.evaluate((pose) => window.__SF_REALMAP__.setPlayerPose(pose), card);
    await page.waitForTimeout(800);
    const diagnostics = await page.evaluate(() => ({
      screen: window.__SF_REALMAP__.getHeroPedestrianStaging().screenSpace,
      cohort: window.__SF_REALMAP__.getAmbientPedestrianCohort(),
    }));
    const readable = diagnostics.screen.adults.filter(({ detailed, readable: isReadable }) => detailed && isReadable);
    assert.ok(readable.length >= 3, `${card.id}: requires three readable detailed pedestrians`);
    const identities = readable.slice(0, 3).map(({ sourceIdentity }) => sourceIdentity);
    assert.equal(new Set(identities).size, 3, `${card.id}: readable presentation identities must be unique`);
    const sources = identities.map((identity) => diagnostics.cohort.members.find(({ id }) => id === identity));
    assert.ok(sources.every(Boolean), `${card.id}: every detailed identity must resolve to an ambient source`);
    result.push({
      id: card.id,
      readableDetailedCount: readable.length,
      identities,
      sources: sources.map(({ id, pathId, sourceRoadId, sourceHighway, initialS, position }) => ({
        id, pathId, sourceRoadId, sourceHighway, initialS, position,
      })),
    });
  }
  return result;
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const first = await freshLockedCards(page);
  const second = await freshLockedCards(page);
  assert.deepEqual(second, first, 'locked-card pedestrian identities and source-path launches changed across fresh loads');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({
    result: 'locked cards have deterministic readable detailed pedestrians', url, cards: first, errors,
  }, null, 2));
} finally {
  await browser.close();
}
