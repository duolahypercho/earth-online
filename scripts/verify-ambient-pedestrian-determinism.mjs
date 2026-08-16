import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const toleranceM = 0.0001;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [];

async function freshCohort(page, label) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getAmbientPedestrianCohort?.().count > 0
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  const cohort = await page.evaluate(() => window.__SF_REALMAP__.getAmbientPedestrianCohort());
  assert.equal(cohort.identitiesUnique, true, `${label}: ambient presentation identities must be unique`);
  assert.ok(cohort.count > 0, `${label}: expected an ambient pedestrian cohort`);
  return cohort;
}

function distance(first, second) {
  return Math.hypot(
    first.position.x - second.position.x,
    first.position.y - second.position.y,
    first.position.z - second.position.z,
  );
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const first = await freshCohort(page, 'first fresh load');
  // A full navigation exercises the same boot path as a browser reload,
  // without comparing animation-time transforms that naturally differ.
  const second = await freshCohort(page, 'second fresh load');
  assert.equal(second.seed, first.seed, 'ambient cohort seed changed between fresh loads');
  assert.equal(second.count, first.count, 'ambient cohort count changed between fresh loads');

  const firstById = new Map(first.members.map((member) => [member.id, member]));
  const mismatches = second.members.flatMap((member) => {
    const previous = firstById.get(member.id);
    if (!previous) return [{ id: member.id, issue: 'missing presentation identity' }];
    const positionErrorM = distance(previous, member);
    if (previous.pathId !== member.pathId
      || previous.sourceRoadId !== member.sourceRoadId
      || previous.sourceHighway !== member.sourceHighway
      || Math.abs(previous.initialS - member.initialS) > toleranceM
      || Math.abs(previous.heading - member.heading) > toleranceM
      || Math.abs(previous.speedMps - member.speedMps) > toleranceM
      || Math.abs(previous.phase - member.phase) > toleranceM
      || positionErrorM > toleranceM) {
      return [{ id: member.id, positionErrorM, first: previous, second: member }];
    }
    return [];
  });
  assert.equal(firstById.size, second.members.length, 'ambient cohort identity set changed between fresh loads');
  assert.deepEqual(mismatches, [], `ambient cohort drift exceeded ${toleranceM}m`);
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);

  console.log(JSON.stringify({
    result: 'ambient pedestrian cohort deterministic across fresh loads',
    url,
    toleranceM,
    count: first.count,
    seed: first.seed,
    errors,
  }, null, 2));
} finally {
  await browser.close();
}
