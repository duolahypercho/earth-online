import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-angle=metal',
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function samplePresentationIntervals() {
  return page.evaluate(async () => {
    const intervals = [];
    let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
    for (let index = 0; index < 600; index += 1) {
      const now = await new Promise((resolve) => requestAnimationFrame(resolve));
      intervals.push(now - previous);
      previous = now;
    }
    return intervals;
  });
}

async function sampleTransition(hour) {
  return page.evaluate(async (value) => {
    const intervals = [];
    let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
    const started = performance.now();
    window.__CITYGEN__.setTime(value);
    const setTimeCpuMs = performance.now() - started;
    for (let index = 0; index < 12; index += 1) {
      const now = await new Promise((resolve) => requestAnimationFrame(resolve));
      intervals.push(now - previous);
      previous = now;
    }
    return {
      maxMs: Math.max(...intervals),
      p95Ms: percentileInPage(intervals, 0.95),
      setTimeCpuMs,
    };

    function percentileInPage(values, ratio) {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
    }
  }, hour);
}

async function sample(hour) {
  await page.evaluate((value) => {
    window.__CITYGEN__.setTime(value);
    window.__CITYGEN__.setCameraPose('street');
  }, hour);
  await page.waitForTimeout(1200);
  return page.evaluate(async () => {
    const renderer = window.__CITYGEN__.getRenderer();
    const intervals = [];
    const updateCpuMs = [];
    const renderCpuMs = [];
    const frameDrawCalls = [];
    const frameTriangles = [];
    const originalUpdate = renderer.update;
    const originalRenderFrame = renderer.renderFrame;
    renderer.update = function measuredUpdate(...args) {
      const started = performance.now();
      try {
        return originalUpdate.apply(this, args);
      } finally {
        updateCpuMs.push(performance.now() - started);
      }
    };
    renderer.renderFrame = function measuredRenderFrame(...args) {
      const started = performance.now();
      try {
        return originalRenderFrame.apply(this, args);
      } finally {
        renderCpuMs.push(performance.now() - started);
        frameDrawCalls.push(this.renderer.info.render.drawCalls);
        frameTriangles.push(this.renderer.info.render.triangles);
      }
    };
    try {
      let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
      for (let index = 0; index < 600; index += 1) {
        const now = await new Promise((resolve) => requestAnimationFrame(resolve));
        intervals.push(now - previous);
        previous = now;
      }
    } finally {
      renderer.update = originalUpdate;
      renderer.renderFrame = originalRenderFrame;
    }
    const pointLights = [];
    renderer.scene.traverse((object) => {
      if (object.isPointLight) pointLights.push(object);
    });
    return {
      intervals,
      pointLights: pointLights.length,
      visiblePointLights: pointLights.filter((light) => light.visible && light.intensity > 0).length,
      shadowPointLights: pointLights.filter((light) => light.castShadow).length,
      drawCalls: Math.max(...frameDrawCalls),
      triangles: Math.max(...frameTriangles),
      updateCpuMs,
      renderCpuMs,
    };
  });
}

try {
  const controlBeforeIntervals = await samplePresentationIntervals();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu
      && window.__CITYGEN__?.getState().buildings >= 700
      && window.__CITYGEN__?.getState().busy === false,
    { timeout: 30000 },
  );
  const diagnostics = await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    return {
      backend: renderer.rendererBackend,
      candidates: renderer.localLightCandidates.length,
      pool: renderer.localLightPool.length,
    };
  });
  const nightTransition = await sampleTransition(22);
  const dayTransition = await sampleTransition(10);
  const day = await sample(10);
  const night = await sample(22);
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
  const controlAfterIntervals = await samplePresentationIntervals();
  const controlP95Ms = Math.max(
    percentile(controlBeforeIntervals, 0.95),
    percentile(controlAfterIntervals, 0.95),
  );
  const hostQualifiedForRaw60Fps = controlP95Ms <= 1000 / 60;
  const summarize = (result) => {
    const medianMs = percentile(result.intervals, 0.5);
    const p95Ms = percentile(result.intervals, 0.95);
    const updateCpuP95Ms = percentile(result.updateCpuMs, 0.95);
    const renderCpuP95Ms = percentile(result.renderCpuMs, 0.95);
    return {
      ...result,
      intervals: undefined,
      updateCpuMs: undefined,
      renderCpuMs: undefined,
      medianMs: Number(medianMs.toFixed(2)),
      medianFps: Number((1000 / medianMs).toFixed(1)),
      p95Ms: Number(p95Ms.toFixed(2)),
      p95Fps: Number((1000 / p95Ms).toFixed(1)),
      maxMs: Number(Math.max(...result.intervals).toFixed(2)),
      presentationP95ExcessMs: Number(Math.max(0, p95Ms - controlP95Ms).toFixed(2)),
      updateCpuP95Ms: Number(updateCpuP95Ms.toFixed(2)),
      renderCpuP95Ms: Number(renderCpuP95Ms.toFixed(2)),
      median60FpsTargetMet: medianMs <= 1000 / 60,
      strictPresentation60FpsTargetMet: p95Ms <= 1000 / 60,
      normalizedPresentationBudgetMet: p95Ms <= Math.max(1000 / 60, controlP95Ms + 2),
      applicationCpu60FpsTargetMet: updateCpuP95Ms + renderCpuP95Ms <= 1000 / 60,
    };
  };
  const report = {
    result: 'PASS',
    url,
    diagnostics,
    transitions: {
      day: {
        maxMs: Number(dayTransition.maxMs.toFixed(2)),
        p95Ms: Number(dayTransition.p95Ms.toFixed(2)),
        setTimeCpuMs: Number(dayTransition.setTimeCpuMs.toFixed(2)),
        strictTransitionBudgetMet: dayTransition.maxMs < 50,
      },
      night: {
        maxMs: Number(nightTransition.maxMs.toFixed(2)),
        p95Ms: Number(nightTransition.p95Ms.toFixed(2)),
        setTimeCpuMs: Number(nightTransition.setTimeCpuMs.toFixed(2)),
        strictTransitionBudgetMet: nightTransition.maxMs < 50,
      },
    },
    control: {
      before: {
        medianMs: Number(percentile(controlBeforeIntervals, 0.5).toFixed(2)),
        p95Ms: Number(percentile(controlBeforeIntervals, 0.95).toFixed(2)),
      },
      after: {
        medianMs: Number(percentile(controlAfterIntervals, 0.5).toFixed(2)),
        p95Ms: Number(percentile(controlAfterIntervals, 0.95).toFixed(2)),
      },
      p95Ms: Number(controlP95Ms.toFixed(2)),
      qualification: hostQualifiedForRaw60Fps ? 'QUALIFIED_FOR_RAW_60FPS' : 'UNQUALIFIED_FOR_RAW_60FPS',
    },
    day: summarize(day),
    night: summarize(night),
    errors,
  };
  assert.equal(diagnostics.backend, 'webgpu');
  assert.ok(diagnostics.candidates >= 100, 'dense SF fixture candidates must remain authored');
  assert.equal(diagnostics.pool, 3, 'local point-light pool must remain bounded to three lights');
  assert.equal(day.pointLights, 3);
  assert.equal(day.visiblePointLights, 0, 'daylight must exclude local point lights');
  assert.ok(night.visiblePointLights > 0 && night.visiblePointLights <= 3);
  assert.equal(day.shadowPointLights + night.shadowPointLights, 0);
  assert.ok(report.transitions.day.setTimeCpuMs <= 4,
    `day transition CPU must remain <=4ms (observed ${report.transitions.day.setTimeCpuMs})`);
  assert.ok(report.transitions.night.setTimeCpuMs <= 4,
    `night transition CPU must remain <=4ms (observed ${report.transitions.night.setTimeCpuMs})`);
  if (hostQualifiedForRaw60Fps) {
    assert.ok(report.transitions.day.strictTransitionBudgetMet,
      `day transition must remain <50ms after prewarm (observed ${report.transitions.day.maxMs})`);
    assert.ok(report.transitions.night.strictTransitionBudgetMet,
      `night transition must remain <50ms after prewarm (observed ${report.transitions.night.maxMs})`);
  }
  for (const [label, result] of [['day', report.day], ['night', report.night]]) {
    assert.ok(result.median60FpsTargetMet, `${label}: median presentation must meet 60 FPS`);
    assert.ok(result.normalizedPresentationBudgetMet, `${label}: presentation p95 must stay within 2ms of blank-page scheduling`);
    assert.ok(result.applicationCpu60FpsTargetMet, `${label}: application CPU p95 must fit the 16.67ms frame budget`);
    assert.ok(result.updateCpuP95Ms <= 2, `${label}: update CPU p95 must remain <=2ms`);
    assert.ok(result.renderCpuP95Ms <= 4, `${label}: render submission CPU p95 must remain <=4ms`);
    assert.ok(result.maxMs < 50, `${label}: steady presentation frame must remain <50ms`);
    assert.ok(result.drawCalls <= 1200, `${label}: draw calls must remain <=1200 (observed ${result.drawCalls})`);
    assert.ok(result.triangles <= 600000, `${label}: triangles must remain <=600k (observed ${result.triangles})`);
    if (hostQualifiedForRaw60Fps) {
      assert.ok(result.strictPresentation60FpsTargetMet, `${label}: raw p95 must meet 60 FPS on a qualified host`);
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
