import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk&lifeLightingVerifier=1`;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

function fail(message, detail = null) {
  throw new Error(detail ? `${message}: ${JSON.stringify(detail)}` : message);
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getHeroLifeLighting?.()?.active
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  await page.waitForTimeout(900);

  const before = await page.evaluate(() => window.__SF_REALMAP__.getHeroLifeLighting());
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => window.__SF_REALMAP__.getHeroLifeLighting());
  const movementBySlot = before.presentationSamples.flatMap((sample) => {
    const next = after.presentationSamples.find((candidate) => candidate.slot === sample.slot);
    if (!sample.active || !sample.position || !next?.active || !next.position) return [];
    return [{
      slot: sample.slot,
      metres: Math.hypot(next.position[0] - sample.position[0], next.position[2] - sample.position[2]),
    }];
  });
  const plausibleMovement = movementBySlot.some(({ metres }) => metres > 0.05 && metres <= 5);
  if (!plausibleMovement) fail('hero pedestrian presentation did not follow plausible simulation movement', {
    movementBySlot, before, after,
  });
  if (after.stats.pedestriansAttached < 1 || after.stats.pedestriansAttached > after.stats.budget.maxPedestrians) {
    fail('pedestrian replacement count is not bounded by the 24-person budget', after.stats);
  }
  if (after.stats.vehiclesAttached !== 0) fail('life layer attached vehicle replacements', after.stats);
  if (after.hiddenSourcePedestrians !== after.sourcePedestrians) fail('replaced source pedestrians remain visible', after);
  if (after.effectiveThoughtBubbles !== 0) fail('a replaced source thought bubble remains effective', after);
  if (after.pointLights !== 2 || after.configuredPointLights !== 2 || after.shadowCastingPointLights !== 0
    || after.lightPool.atmospherePointLights !== 4 || after.lightPool.lifePointLights !== 2
    || after.lightPool.totalPointLights !== 6 || after.lightPool.shadowCastingPointLights !== 0) {
    fail('pooled hero practical light split changed', after);
  }
  if (after.stats.drawCalls !== 10 || after.stats.materials !== 8) fail('fixed presentation budget changed', after.stats);
  if (after.practicalAnchors.length !== 6
    || after.practicalAnchors.some((anchor) => !anchor.source.includes('OSM way 558731934'))) {
    fail('practical anchors are not Ferry-source-relative', after.practicalAnchors);
  }

  await page.evaluate(() => window.__SF_REALMAP__.setTimeOfDay('night'));
  await page.waitForTimeout(120);
  const night = await page.evaluate(() => window.__SF_REALMAP__.getHeroLifeLighting());
  if (night.stats.conditions.timeOfDay !== 'night' || night.stats.conditions.night < 0.9
    || night.stats.activePracticals !== 6) fail('night conditions did not synchronize', night.stats);

  await page.evaluate(() => {
    window.__SF_REALMAP__.setTimeOfDay('day');
    window.__SF_REALMAP__.setWeather('drizzle');
  });
  await page.waitForTimeout(120);
  const drizzle = await page.evaluate(() => window.__SF_REALMAP__.getHeroLifeLighting());
  if (drizzle.stats.conditions.timeOfDay !== 'day' || drizzle.stats.conditions.weather !== 'drizzle'
    || drizzle.stats.conditions.wetness < 0.85) fail('drizzle conditions did not synchronize', drizzle.stats);

  await page.evaluate(() => window.__SF_REALMAP__.setWeather('clear'));
  await page.waitForTimeout(1800);
  const perf = await page.evaluate(() => window.__SF_REALMAP__.getPerf());
  if (perf.fps < 60) fail('hero runtime fell below 60 FPS', perf);
  if (perf.heroCamera.forcedCloseCamera || perf.heroCamera.cameraInsideBuilding || perf.heroCamera.cameraInsideVehicle) {
    fail('hero camera is not clean', perf.heroCamera);
  }
  if (perf.heroTrafficVisuals.stats.attached !== perf.traffic) fail('traffic visuals were disturbed', perf);
  if (errors.length) fail('runtime errors were reported', errors);

  const lifecycle = await page.evaluate(() => window.__SF_REALMAP__.rebuildHeroLifeLighting());
  if (lifecycle.disposed.active
    || lifecycle.disposed.lifecycle?.restored !== lifecycle.disposed.lifecycle?.expected
    || lifecycle.disposed.lifecycle?.expected !== after.stats.pedestriansAttached
    || lifecycle.disposed.lifecycle?.sourceRestored !== lifecycle.disposed.lifecycle?.sourceExpected
    || lifecycle.disposed.lifecycle?.sourceExpected !== after.sourcePedestrians
    || !lifecycle.rebuilt.active
    || lifecycle.rebuilt.hiddenSourcePedestrians !== after.sourcePedestrians) {
    fail('life layer did not restore and rebuild exact source visibility', lifecycle);
  }

  console.log(JSON.stringify({
    result: 'hero life-lighting integration verified',
    url,
    plausibleMovementMetres: movementBySlot
      .filter(({ metres }) => metres > 0.05 && metres <= 5)
      .map(({ slot, metres }) => ({ slot, metres: Number(metres.toFixed(3)) })),
    life: after,
    night: night.stats.conditions,
    drizzle: drizzle.stats.conditions,
    fps: perf.fps,
    avgFrameMs: perf.avgFrameMs,
    camera: perf.heroCamera,
    lifecycle: lifecycle.disposed.lifecycle,
    errors,
  }, null, 2));
} finally {
  await browser.close();
}
