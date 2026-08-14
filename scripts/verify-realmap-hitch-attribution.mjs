import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5173';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk&qa=1`;
const screenshotPath = process.env.SF_HITCH_ATTRIBUTION_SCREENSHOT || '/tmp/realmap-hitch-attribution.png';
const postGateFirstFrameLimitMs = 100;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

function summarize(samples) {
  const ordered = samples.slice().sort((a, b) => a - b);
  const p99 = ordered[Math.max(0, Math.ceil(ordered.length * 0.99) - 1)] || 0;
  return {
    samples: samples.length,
    meanMs: Number((samples.reduce((total, value) => total + value, 0) / Math.max(1, samples.length)).toFixed(2)),
    p99Ms: Number(p99.toFixed(2)),
    maxMs: Number(Math.max(0, ...samples).toFixed(2)),
  };
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getPerf?.().hitchAttribution?.namedEvents?.['build.renderer-warmup']
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  const firstVisible = await page.evaluate(async () => {
    const api = window.__SF_REALMAP__;
    let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
    const rawRaf = [];
    const applicationFrames = [];
    while (rawRaf.length < 12) {
      const now = await new Promise((resolve) => requestAnimationFrame(resolve));
      rawRaf.push(now - previous);
      previous = now;
      applicationFrames.push(api.getPerf().hitchAttribution.lastApplicationFrame);
    }
    return {
      rawRaf,
      applicationFrames,
      performance: api.getPerf(),
    };
  });
  await page.waitForTimeout(1200);

  const report = await page.evaluate(async () => {
    const api = window.__SF_REALMAP__;
    const rawRaf = (count) => new Promise(async (resolve) => {
      let previous = await new Promise((next) => requestAnimationFrame(next));
      const samples = [];
      while (samples.length < count) {
        const now = await new Promise((next) => requestAnimationFrame(next));
        samples.push(now - previous);
        previous = now;
      }
      resolve(samples);
    });
    const before = api.getPerf();
    const beforeRaf = await new Promise((resolve) => requestAnimationFrame(resolve));
    const captureWallStartedAt = performance.now();
    const frameDiagnostics = api.getFrameDiagnostics();
    const captureWallEndedAt = performance.now();
    const afterRaf = await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterCapture = api.getPerf();
    const steadyRaf = await rawRaf(180);
    const afterSteady = api.getPerf();
    const screenshot = afterCapture.hitchAttribution.recentNamedEvents
      .slice().reverse().find((event) => event.name === 'screenshot.readback') || null;
    const lastApplicationFrameMs = afterCapture.hitchAttribution.lastApplicationFrame?.totalMs || 0;
    return {
      before,
      capture: {
        wallMs: Number((captureWallEndedAt - captureWallStartedAt).toFixed(2)),
        // Browser rAF timestamps describe the presentation schedule and can
        // advance by less than a synchronous readback's measured wall time.
        // Keep this as context; do not use it to assign main-thread ownership.
        rawRafDeltaMs: Number((afterRaf - beforeRaf).toFixed(2)),
        frameDiagnostics,
        screenshot,
        applicationFrameAfterCaptureMs: lastApplicationFrameMs,
        estimatedUnownedWallMs: Number(Math.max(0, (captureWallEndedAt - captureWallStartedAt)
          - (screenshot?.durationMs || 0)).toFixed(2)),
      },
      afterCapture,
      steadyRaf,
      afterSteady,
    };
  });
  await page.screenshot({ path: screenshotPath });

  const names = report.afterSteady.hitchAttribution?.namedEvents || {};
  const firstVisibleRawRaf = summarize(firstVisible.rawRaf);
  const warmup = report.afterSteady.hitchAttribution?.recentNamedEvents
    ?.slice().reverse().find((event) => event.name === 'build.renderer-warmup') || null;
  const requiredNames = [
    'boot.runtime-ready',
    'boot.data',
    'build.city',
    'config.scene',
    'build.renderer-warmup',
    'screenshot.readback',
    'render.frame',
  ];
  for (const name of requiredNames) assert(names[name]?.count > 0, `missing hitch-attribution event: ${name}`);
  assert(warmup?.details?.compileAsyncMs >= 0 && warmup.details.prePresentMs >= 0,
    'build.renderer-warmup did not retain compileAsync and pre-present timings');
  assert(firstVisible.applicationFrames.every((frame) => frame?.name === 'render.frame'),
    'first visible rAF samples did not retain complete application frames');
  assert(firstVisible.performance.applicationMaxFrameMs < postGateFirstFrameLimitMs,
    `retained post-gate application max exceeded ${postGateFirstFrameLimitMs}ms`);
  assert(firstVisibleRawRaf.maxMs < postGateFirstFrameLimitMs,
    `observed post-readiness rAF max exceeded ${postGateFirstFrameLimitMs}ms`);
  assert(report.capture.screenshot?.durationMs >= 0, 'screenshot.readback did not retain a duration');
  assert(report.afterSteady.hitchAttribution.applicationMaxFrame, 'application maximum frame was not retained');

  console.log(JSON.stringify({
    result: errors.length ? 'failed' : 'captured',
    url,
    screenshotPath,
    requiredNames,
    rendererWarmup: warmup,
    firstVisible: {
      definition: 'The first twelve raw requestAnimationFrame deltas observed after city readiness; no telemetry is reset.',
      thresholdMs: postGateFirstFrameLimitMs,
      rawRaf: firstVisibleRawRaf,
      applicationFrames: firstVisible.applicationFrames,
      applicationFrameMaxMs: Math.max(...firstVisible.applicationFrames.map((frame) => frame.totalMs)),
      applicationMaxFrameMs: firstVisible.performance.applicationMaxFrameMs,
      attributionMax: firstVisible.performance.hitchAttribution.applicationMaxFrame,
    },
    before: {
      applicationMaxFrameMs: report.before.applicationMaxFrameMs,
      attributionMax: report.before.hitchAttribution.applicationMaxFrame,
    },
    capture: report.capture,
    after: {
      applicationMaxFrameMs: report.afterSteady.applicationMaxFrameMs,
      attributionMax: report.afterSteady.hitchAttribution.applicationMaxFrame,
      hitchesOver16_67Ms: report.afterSteady.hitchAttribution.applicationHitchesOver16_67Ms,
      namedEvents: report.afterSteady.hitchAttribution.namedEvents,
    },
    steadyState: {
      definition: 'Unchanged hero scene; raw consecutive requestAnimationFrame deltas after the explicit capture.',
      ...summarize(report.steadyRaf),
    },
    errors,
    note: 'No telemetry is reset. build.renderer-warmup is explicit build-overlay work (compileAsync plus exactly one pre-present), not a render-frame hitch. build.city and boot.data are wall-clock lifecycle spans; config.scene, screenshot.readback, and render.frame are synchronous main-thread durations. rAF timestamps remain scheduling context and are not subtracted from synchronous wall durations.',
  }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', url, error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
