import { chromium } from 'playwright';
import { access } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
const qaAngle = process.env.SF_QA_ANGLE || 'metal';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${qaAngle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(qaAngle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const warnings = [];
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'warning') warnings.push(message.text());
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
    errors.push(message.text());
  }
});
page.on('pageerror', (error) => errors.push(error.message));

const failures = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};

const stops = [
  { key: '1:0', district: 'Civic Center / SoMa', position: { x: 288, z: -64 } },
  { key: '4:0', district: 'Financial District', position: { x: 1600, z: 0 } },
  { key: '-5:-4', district: 'Outer Sunset', position: { x: -1920, z: -1536 } },
];

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled,
    { timeout: 30000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 15000 },
  );

  const samples = [];
  for (const stop of stops) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), stop.position);
    await page.waitForFunction(
      ({ key }) => {
        const stats = window.__SF_SIM__?.streaming?.stats;
        return stats?.focusSector === key && stats.populationPendingDetailed === 0;
      },
      stop,
      { timeout: 15000 },
    );
    await page.waitForTimeout(500);
    const sample = await page.evaluate((stopSpec) => {
      const sim = window.__SF_SIM__;
      const streaming = sim.streaming.getStats();
      const agents = sim.streamedAgents.getStats();
      const traffic = sim.traffic.getStats();
      const trafficDiagnostics = sim.traffic.getDiagnostics();
      const invalidTransforms = [];
      [sim.traffic.group, sim.pedestrians.group, sim.streamedAgents.group].forEach((root) => {
        root?.traverse((object) => {
          if (!object.visible) return;
          const { x, y, z } = object.position;
          if (![x, y, z].every(Number.isFinite) && invalidTransforms.length < 12) {
            invalidTransforms.push({ name: object.name, position: [x, y, z] });
          }
        });
      });
      return {
        key: stopSpec.key,
        district: stopSpec.district,
        focusSector: streaming.focusSector,
        traffic,
        trafficDiagnostics: {
          elapsed: trafficDiagnostics.elapsed,
          minLaneGap: trafficDiagnostics.minLaneGap,
          minMovingHeadway: trafficDiagnostics.minMovingHeadway,
          minStoppedGap: trafficDiagnostics.minStoppedGap,
          maxAcceleration: trafficDiagnostics.maxAcceleration,
          maxDeceleration: trafficDiagnostics.maxDeceleration,
          maxJerk: trafficDiagnostics.maxJerk,
          maxSafetyCorrection: trafficDiagnostics.maxSafetyCorrection,
          safetyClamps: trafficDiagnostics.safetyClamps,
          turning: trafficDiagnostics.turning,
        },
        streamedAgents: {
          schedule: agents.schedule,
          vehicles: agents.vehicles,
          pedestrians: agents.pedestrians,
          duplicateIds: agents.duplicateIds,
          conservationError: agents.conservationError,
          capErrors: agents.capErrors,
        },
        handoffs: streaming.handoffs,
        invalidTransforms,
      };
    }, stop);
    samples.push(sample);
    assert(sample.focusSector === stop.key, `${stop.key} focus sector mismatch`, sample);
    assert(sample.traffic.active > 0, `${stop.key} has no active traffic`, sample.traffic);
    assert(sample.streamedAgents.vehicles.visible > 0, `${stop.key} has no visible vehicle representatives`, sample.streamedAgents);
    assert(sample.streamedAgents.pedestrians.visible > 0, `${stop.key} has no visible pedestrian representatives`, sample.streamedAgents);
    assert(sample.streamedAgents.duplicateIds === 0, `${stop.key} duplicate streamed IDs`, sample.streamedAgents);
    assert(sample.streamedAgents.conservationError === 0, `${stop.key} streamed population conservation error`, sample.streamedAgents);
    assert(sample.streamedAgents.capErrors === 0, `${stop.key} streamed population cap error`, sample.streamedAgents);
    assert(sample.handoffs.dropped === 0 && sample.handoffs.deferred === 0,
      `${stop.key} dropped or deferred sector handoff`, sample.handoffs);
    assert(sample.invalidTransforms.length === 0, `${stop.key} invalid visible transform`, sample.invalidTransforms);
    [
      'elapsed',
      'maxAcceleration',
      'maxDeceleration',
      'maxJerk',
      'maxSafetyCorrection',
    ].forEach((field) => assert(
      Number.isFinite(sample.trafficDiagnostics[field]),
      `${stop.key} traffic diagnostic ${field} is not finite`,
      sample.trafficDiagnostics,
    ));
    ['minLaneGap', 'minMovingHeadway', 'minStoppedGap'].forEach((field) => {
      const value = sample.trafficDiagnostics[field];
      if (value !== null) assert(value >= -0.01, `${stop.key} ${field} breached collision gap`, sample.trafficDiagnostics);
    });
  }

  // The production scene has no clock setter. Advance the exposed live
  // systems monotonically through the overnight boundary and label this as a
  // direct-system QA probe, not a claim that RAF time can be set in production.
  const scheduleBoundary = await page.evaluate(async () => {
    const sim = window.__SF_SIM__;
    const state = sim.getRoamState();
    const position = state.target;
    const hoursPerElapsedSecond = 0.033;
    const elapsedForHour = (hour) => ((hour - 7 + 24) % 24) / hoursPerElapsedSecond;
    const applyElapsed = async (elapsed) => {
      sim.streaming.update(position, sim.camera, 0.05, elapsed);
      sim.streamedAgents.update(position, 0.05, elapsed);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const stats = sim.streamedAgents.getStats();
      return {
        elapsed,
        dayHour: stats.schedule.dayHour,
        beat: stats.schedule.beat,
        activities: stats.schedule.activities,
      };
    };
    const lateNight = await applyElapsed(elapsedForHour(23));
    const earlyMorning = await applyElapsed(elapsedForHour(5.05));
    return { lateNight, earlyMorning, mode: 'direct-system-accelerated-elapsed' };
  });
  assert(
    scheduleBoundary.lateNight.beat === 'late-night'
      && scheduleBoundary.earlyMorning.beat === 'midday'
      && scheduleBoundary.earlyMorning.dayHour > 5
      && scheduleBoundary.earlyMorning.dayHour < 6,
    'Live accelerated schedule did not cross the 23:00 → 05:05 boundary',
    scheduleBoundary,
  );

  assert(warnings.length === 0, 'Browser emitted console warnings', warnings.slice(0, 8));
  assert(errors.length === 0, 'Browser emitted runtime errors', errors.slice(0, 8));
  const result = {
    result: failures.length === 0 ? 'live soak gate passed' : 'live soak gate failed',
    baseUrl,
    angle: qaAngle,
    stops: samples,
    scheduleBoundary,
    warnings: warnings.slice(0, 8),
    errors: errors.slice(0, 8),
    failures,
    limitation: 'Overnight transition uses direct exposed system updates because production RAF time has no setter; it does not certify a wall-clock accelerated mode.',
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'live soak gate failed',
    baseUrl,
    error: error.message,
    warnings: warnings.slice(0, 8),
    errors: errors.slice(0, 8),
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
