import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const errors = [];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getPerf?.().heroLighting?.active === true
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );

  async function sample(timeOfDay) {
    await page.evaluate((mode) => window.__SF_REALMAP__.setTimeOfDay(mode), timeOfDay);
    await page.waitForTimeout(500);
    return page.evaluate(() => window.__SF_REALMAP__.getPerf().heroLighting);
  }

  const day = await sample('day');
  const night = await sample('night');
  assert.equal(day.heroFrame, true, 'Ferry lighting frame is not active');
  assert.equal(day.nightKey.active, false, 'night key must remain off during the day');
  assert.equal(night.nightKey.active, true, 'night key did not activate at night');
  assert.equal(night.nightKey.castShadow, true, 'night key must cast a shaped local shadow');
  assert.deepEqual(night.nightKey.shadowMapSize, [512, 512], 'night key shadow budget changed');
  assert.equal(night.nightKey.distanceM, 32, 'night key falloff moved outside its bounded plaza range');
  assert.equal(night.nightKeyShadowBudget, 1, 'more than one local night shadow was introduced');
  assert.equal(night.shadowLights, 1, 'daylight shadow budget changed');
  assert.deepEqual(night.shadowMapSize, [2048, 2048], 'sun shadow-map budget changed');
  assert.equal(night.shadowAutoUpdate, false, 'hero shadow cadence must remain demand-driven');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);

  console.log(JSON.stringify({ result: 'hero lighting composition verified', url, day, night, errors }, null, 2));
} finally {
  await browser.close();
}
