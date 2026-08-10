import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outputDir = process.env.SF_HERO_PEDESTRIAN_STAGING_DIR || '.qa-hero-pedestrian-staging';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const viewport = { width: 1440, height: 810 };
const errors = [];
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

async function snapshot(page, id, conditions) {
  await page.evaluate((next) => {
    window.__SF_REALMAP__.setCityMode('walk');
    window.__SF_REALMAP__.setWeather(next.weather);
    window.__SF_REALMAP__.setTimeOfDay(next.timeOfDay);
  }, conditions);
  await page.waitForTimeout(850);
  const diagnostics = await page.evaluate(() => ({
    staging: window.__SF_REALMAP__.getHeroPedestrianStaging(),
    life: window.__SF_REALMAP__.getHeroLifeLighting(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
    performance: window.__SF_REALMAP__.getPerf(),
  }));
  await page.screenshot({ path: join(outputDir, `${id}.png`) });
  return diagnostics;
}

function assertPlayableHeroFrame(diagnostics, label = 'frame') {
  const { staging, life, camera, performance } = diagnostics;
  assert.equal(staging.active, true, 'Ferry pedestrian staging must be active');
  assert.equal(staging.stagedCount, 7, 'the hero needs seven deterministic staged walkers');
  assert.equal(staging.sourceUuidUnique, true, 'staged pedestrian records must stay identity-unique');
  assert.equal(staging.sourceFootwayOnly, true, 'every staged route must be an exact OSM footway/pedestrian way');
  assert.equal(staging.sourceWalkwaySurfaceClear, true, 'staged pedestrians cannot use an asphalt-surface path');
  assert.equal(staging.sourceWalkwayEnvelopeClear, true, 'parallel tracks must remain within the source footway envelope');
  assert.equal(staging.buildingClear, true, 'no staged point may be inside an OSM building footprint');
  assert.equal(staging.activeLandRegionClear, true, 'no staged point may leave the active land region');
  assert.ok(staging.minimumSpacingM >= staging.requiredMinimumSpacingM, 'staged walkers cannot clump');
  assert.ok(staging.cameraReadableAdults >= 3, 'at least three staged walkers must be in the default 8–18m camera envelope');
  assert.ok(
    staging.screenSpace?.passed,
    `${label}: three detailed adults must be screen-visible, separated, and clear of the hero silhouette; ${JSON.stringify(staging.screenSpace)}`,
  );
  assert.ok(life.stagedSourcesAttached >= 7, 'life renderer must own every staged source');
  assert.ok(life.detailedStagedSourceUuids.length >= 3, 'at least three detailed adult rigs must map to staged sources');
  assert.equal(life.detailedStagedSourceUnique, true, 'detailed adults cannot share a source identity');
  assert.equal(life.stats.detailedActors, 7, 'every staged Ferry source must use a detailed adult rig');
  assert.equal(life.stats.fallbackActors, 0, 'the default Ferry frame cannot contain fallback silhouettes');
  assert.equal(life.stats.budget.maxDetailedActors, 7, 'expanded detail capacity must stay scoped to the staged Ferry pass');
  assert.equal(life.hiddenSourcePedestrians, life.sourcePedestrians, 'primitive sources must be fully hidden');
  assert.equal(life.effectiveThoughtBubbles, 0, 'hero frame must not show thought-bubble UI');
  assert.equal(life.stats.pedestriansActive, life.stats.detailedActors + life.stats.fallbackActors, 'a pedestrian may render exactly once');
  assert.equal(camera.active, true, 'third-person hero camera must remain active');
  assert.ok(camera.armDistance >= 8.5, 'hero camera must retain its full arm');
  assert.equal(camera.forcedCloseCamera, false, 'hero camera must not collapse to a close fallback');
  assert.ok(performance.avgFrameMs <= 16.67, 'hero staging must sustain 60 FPS');
}

try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getPlayerPosition?.() != null
      && window.__SF_REALMAP__?.getHeroCamera?.().active === true
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
  // Ignore startup shader/pipeline compilation; this verifier scores the
  // steady playable frame rather than the first-render hitch.
  await page.waitForTimeout(1600);

  const day = await snapshot(page, 'default-launch-day', { weather: 'clear', timeOfDay: 'day' });
  assertPlayableHeroFrame(day, 'day');
  const drizzle = await snapshot(page, 'default-launch-drizzle', { weather: 'drizzle', timeOfDay: 'day' });
  assertPlayableHeroFrame(drizzle, 'drizzle');
  const night = await snapshot(page, 'default-launch-night', { weather: 'clear', timeOfDay: 'night' });
  assertPlayableHeroFrame(night, 'night');
  await page.waitForTimeout(3500);
  const drift = await page.evaluate(() => window.__SF_REALMAP__.getHeroPedestrianStaging());
  assert.ok(drift.minimumSpacingM >= drift.requiredMinimumSpacingM, 'staging drift cannot clump walkers');
  assert.equal(errors.length, 0, `browser errors: ${errors.join('; ')}`);

  const report = { result: 'verified', url, viewport, day, drizzle, night, drift, errors };
  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
