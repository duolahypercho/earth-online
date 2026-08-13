import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const warmupMs = Number(process.env.SF_HERO_WARMUP_MS || 1800);
const sampleFrames = Number(process.env.SF_HERO_SAMPLE_FRAMES || 180);
const steadyP99LimitMs = 33;
const steadyHitchLimitMs = 100;
const screenshotPath = process.env.SF_HERO_SCREENSHOT || '/tmp/ferry-hero-performance.png';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.addInitScript(() => {
  const probe = { draws: 0, triangles: 0, wrapped: false };
  window.__SF_HERO_DRAW_PROBE__ = probe;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...args) {
    const context = getContext.call(this, type, ...args);
    if (!context || probe.wrapped || !String(type).startsWith('webgl')) return context;
    probe.wrapped = true;
    const wrap = (name, instanced = false) => {
      const original = context[name]?.bind(context);
      if (!original) return;
      context[name] = (mode, count, ...rest) => {
        probe.draws += 1;
        if (mode === context.TRIANGLES) probe.triangles += (count / 3) * (instanced ? (rest.at(-1) || 1) : 1);
        return original(mode, count, ...rest);
      };
    };
    wrap('drawArrays');
    wrap('drawElements');
    wrap('drawArraysInstanced', true);
    wrap('drawElementsInstanced', true);
    return context;
  };
});

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getPerf?.().traffic != null && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  const probe = await page.evaluate(async ({ warmupMs: requestedWarmupMs, sampleFrames: requestedSampleFrames }) => {
    const data = window.__SF_REALMAP__.getData();
    const hero = window.__SF_REALMAP__.getHeroTile();
    const inBounds = ([x, z]) => x >= hero.bufferedBounds.minX && x <= hero.bufferedBounds.maxX
      && z >= hero.bufferedBounds.minZ && z <= hero.bufferedBounds.maxZ;
    const roads = data.roads.filter((road) => road.points.some((_, index) => index % 2 === 0 && inBounds([road.points[index], road.points[index + 1]])));
    const buildings = [...data.detailBuildings, ...data.coarseBuildings].filter((building) => inBounds(building.centroid));
    const sampleRafDeltas = async (count) => {
      let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
      const deltas = [];
      while (deltas.length < count) {
        const now = await new Promise((resolve) => requestAnimationFrame(resolve));
        deltas.push(now - previous);
        previous = now;
      }
      return deltas;
    };
    const sampleRafDuration = async (durationMs) => {
      let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
      const deltas = [];
      let elapsed = 0;
      while (elapsed < durationMs) {
        const now = await new Promise((resolve) => requestAnimationFrame(resolve));
        const delta = now - previous;
        deltas.push(delta);
        elapsed += delta;
        previous = now;
      }
      return deltas;
    };
    const summarize = (samples) => {
      const ordered = samples.slice().sort((a, b) => a - b);
      const p99Index = Math.max(0, Math.ceil(ordered.length * 0.99) - 1);
      return {
        samples: samples.length,
        meanMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2)),
        p99Ms: Number(ordered[p99Index].toFixed(2)),
        maxMs: Number(Math.max(...samples).toFixed(2)),
      };
    };
    // This is intentionally a no-input window. It lets first-use shader work,
    // forced shadows, and page setup settle before the measured rAF deltas.
    const warmupDeltas = await sampleRafDuration(requestedWarmupMs);
    const startDraws = window.__SF_HERO_DRAW_PROBE__.draws;
    const startTriangles = window.__SF_HERO_DRAW_PROBE__.triangles;
    const frames = [];
    let previousDraws = startDraws;
    let previousTriangles = startTriangles;
    let previousRaf = await new Promise((resolve) => requestAnimationFrame(resolve));
    while (frames.length < requestedSampleFrames) {
      const now = await new Promise((resolve) => requestAnimationFrame(resolve));
        frames.push({ draws: window.__SF_HERO_DRAW_PROBE__.draws - previousDraws, triangles: window.__SF_HERO_DRAW_PROBE__.triangles - previousTriangles });
        previousDraws = window.__SF_HERO_DRAW_PROBE__.draws;
        previousTriangles = window.__SF_HERO_DRAW_PROBE__.triangles;
        frames[frames.length - 1].rafDeltaMs = now - previousRaf;
        previousRaf = now;
    }
    const sum = (key) => frames.reduce((total, frame) => total + frame[key], 0);
    return {
      // App telemetry is retained for diagnosis, but this is not the steady
      // gate: it includes page boot and does not reset at this capture point.
      appTelemetry: window.__SF_REALMAP__.getPerf(),
      hero: { id: hero.id, bounds: hero.bounds, spawn: hero.spawn },
      entities: {
        sourceRoadsInBufferedHeroTile: roads.length,
        sourceBuildingsInBufferedHeroTile: buildings.length,
        traffic: window.__SF_REALMAP__.getPerf().traffic,
        pedestrians: window.__SF_REALMAP__.getPerf().pedestrians,
        doorways: window.__SF_REALMAP__.getPerf().doorways,
        buildingChunks: window.__SF_REALMAP__.getPerf().buildingChunks,
      },
      gpu: {
        sampledFrames: frames.length,
        averageDrawCallsPerFrame: Number((sum('draws') / frames.length).toFixed(1)),
        maxDrawCallsPerFrame: Math.max(...frames.map((frame) => frame.draws)),
        averageTrianglesPerFrame: Math.round(sum('triangles') / frames.length),
        maxTrianglesPerFrame: Math.round(Math.max(...frames.map((frame) => frame.triangles))),
      },
      steadyState: {
        definition: 'No input or scene mutation after hero load; raw consecutive requestAnimationFrame deltas after warmup.',
        warmup: {
          requestedDurationMs: requestedWarmupMs,
          measuredDurationMs: Number(warmupDeltas.reduce((sum, value) => sum + value, 0).toFixed(2)),
          ...summarize(warmupDeltas),
        },
        sample: summarize(frames.map((frame) => frame.rafDeltaMs)),
      },
      visualDiagnostics: window.__SF_REALMAP__.getFrameDiagnostics(),
    };
  }, { warmupMs, sampleFrames });
  await page.screenshot({ path: screenshotPath });
  const steadyStatePass = probe.steadyState.sample.p99Ms <= steadyP99LimitMs
    && probe.steadyState.sample.maxMs < steadyHitchLimitMs;
  const measured = probe.gpu.sampledFrames > 0
    && probe.gpu.averageDrawCallsPerFrame > 0
    && probe.gpu.averageTrianglesPerFrame > 0
    && probe.entities.sourceRoadsInBufferedHeroTile > 0;
  console.log(JSON.stringify({
    result: errors.length || !measured || !steadyStatePass ? 'failed' : 'captured',
    url,
    screenshotPath,
    thresholds: { steadyP99LimitMs, steadyHitchLimitMs },
    steadyStatePass,
    probe,
    errors,
    note: 'The steady-state gate uses only raw rAF deltas from the unchanged hero scene. App telemetry and the screenshot remain reported separately because they can include boot/capture work.',
  }, null, 2));
  if (errors.length || !measured || !steadyStatePass) process.exitCode = 1;
} finally {
  await browser.close();
}
