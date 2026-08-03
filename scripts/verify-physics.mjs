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
  await page.waitForTimeout(1000);

  const result = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const traffic = sim.traffic;
    const before = traffic.getDiagnostics();
    // Exercise the two hostile frame inputs a browser hitch can produce. The
    // system must clamp the large step and ignore the invalid one without
    // producing a negative lane gap or non-finite diagnostics.
    traffic.update(1.0, before.elapsed + 1.0);
    traffic.update(Number.NaN, before.elapsed + 1.01);
    traffic.update(0.016, before.elapsed + 1.026);
    const after = traffic.getDiagnostics();
    const gapFields = ['minLaneGap', 'minMovingHeadway', 'minStoppedGap'];
    return {
      before,
      after,
      gapSafe: gapFields.every((field) => after[field] == null || after[field] >= -0.01),
      finite: ['elapsed', 'maxInputDt', 'maxAcceleration', 'maxDeceleration', 'maxJerk', 'maxSafetyCorrection']
        .every((field) => Number.isFinite(after[field])),
    };
  });

  assert.equal(result.after.dtClampCount > result.before.dtClampCount, true, 'large dt was not clamped');
  assert.equal(result.after.invalidDtCount > result.before.invalidDtCount, true, 'invalid dt was not rejected');
  assert.equal(result.after.maxInputDt >= 1, true, 'input dt telemetry did not observe the hitch');
  assert.equal(result.gapSafe, true, 'traffic produced a negative collision gap');
  assert.equal(result.finite, true, 'physics diagnostics became non-finite');
  assert.equal(errors.length, 0, `browser errors: ${errors.join(' | ')}`);

  console.log(JSON.stringify({
    result: 'physics smoke gate passed',
    angle,
    dt: {
      maxInputDt: result.after.maxInputDt,
      dtClampCount: result.after.dtClampCount,
      invalidDtCount: result.after.invalidDtCount,
    },
    safety: {
      minLaneGap: result.after.minLaneGap,
      minMovingHeadway: result.after.minMovingHeadway,
      minStoppedGap: result.after.minStoppedGap,
      safetyClamps: result.after.safetyClamps,
      maxSafetyCorrection: result.after.maxSafetyCorrection,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    result: 'physics smoke gate failed',
    error: error.message,
    errors,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
