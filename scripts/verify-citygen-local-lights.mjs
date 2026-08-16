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

async function sample(hour) {
  await page.evaluate((value) => {
    window.__CITYGEN__.setTime(value);
    window.__CITYGEN__.setCameraPose('street');
  }, hour);
  await page.waitForTimeout(1200);
  return page.evaluate(async () => {
    const intervals = [];
    let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
    for (let index = 0; index < 120; index += 1) {
      const now = await new Promise((resolve) => requestAnimationFrame(resolve));
      intervals.push(now - previous);
      previous = now;
    }
    const renderer = window.__CITYGEN__.getRenderer();
    const pointLights = [];
    renderer.scene.traverse((object) => {
      if (object.isPointLight) pointLights.push(object);
    });
    return {
      intervals,
      pointLights: pointLights.length,
      visiblePointLights: pointLights.filter((light) => light.visible && light.intensity > 0).length,
      shadowPointLights: pointLights.filter((light) => light.castShadow).length,
      drawCalls: renderer.renderer.info.render.calls,
    };
  });
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu && window.__CITYGEN__?.getState().buildings >= 700,
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
  const day = await sample(14);
  const night = await sample(22);
  const summarize = (result) => {
    const medianMs = percentile(result.intervals, 0.5);
    const p95Ms = percentile(result.intervals, 0.95);
    return {
      ...result,
      intervals: undefined,
      medianMs: Number(medianMs.toFixed(2)),
      medianFps: Number((1000 / medianMs).toFixed(1)),
      p95Ms: Number(p95Ms.toFixed(2)),
      p95Fps: Number((1000 / p95Ms).toFixed(1)),
      median60FpsTargetMet: medianMs <= 1000 / 60,
      p9560FpsTargetMet: p95Ms <= 1000 / 60,
    };
  };
  const report = {
    result: 'PASS',
    url,
    diagnostics,
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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
