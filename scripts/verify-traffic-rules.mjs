import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
    errors.push(message.text());
  }
});

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    { timeout: 30000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 15000 },
  );
  await page.waitForTimeout(500);

  const result = await page.evaluate(async () => {
    const mod = await import('/src/traffic.js');
    if (typeof mod.createTrafficRulesHarness !== 'function') {
      return {
        ok: false,
        failures: ['createTrafficRulesHarness is not exported from /src/traffic.js'],
      };
    }
    const harness = mod.createTrafficRulesHarness({ vehicleCount: 28 });
    return harness.run(18, 1 / 30);
  });

  assert.equal(errors.length, 0, `browser errors: ${errors.join(' | ')}`);
  assert.equal(result.ok, true, `traffic rules failed: ${(result.failures || []).join(' | ')}`);
  assert.ok(result.active > 0, 'harness spawned no vehicles');
  assert.ok(
    (result.counts?.stopSignStops || 0) > 0
      || (result.counts?.stopSightings || 0) > 0,
    'expected stop-sign compliance from the multi-agent run',
  );
  assert.equal(result.counts?.wrongWay || 0, 0, 'wrong-way driving detected');

  console.log(JSON.stringify({
    result: 'traffic rules gate passed',
    angle,
    active: result.active,
    counts: result.counts,
    diagnostics: {
      stopSignStops: result.diagnostics?.stopSignStops,
      stopSignReleases: result.diagnostics?.stopSignReleases,
      oneWayRejects: result.diagnostics?.oneWayRejects,
      illegalTurnRejects: result.diagnostics?.illegalTurnRejects,
      minLaneGap: result.diagnostics?.minLaneGap,
      minMovingHeadway: result.diagnostics?.minMovingHeadway,
      minStoppedGap: result.diagnostics?.minStoppedGap,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    result: 'traffic rules gate failed',
    error: error.message,
    errors,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
