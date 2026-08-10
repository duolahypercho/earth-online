import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const sampleMs = Number(process.env.SF_HERO_SAMPLE_MS || 3000);
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
  await page.waitForTimeout(1200);
  const result = await page.evaluate(async (duration) => {
    const data = window.__SF_REALMAP__.getData();
    const hero = window.__SF_REALMAP__.getHeroTile();
    const inBounds = ([x, z]) => x >= hero.bufferedBounds.minX && x <= hero.bufferedBounds.maxX
      && z >= hero.bufferedBounds.minZ && z <= hero.bufferedBounds.maxZ;
    const roads = data.roads.filter((road) => road.points.some((_, index) => index % 2 === 0 && inBounds([road.points[index], road.points[index + 1]])));
    const buildings = [...data.detailBuildings, ...data.coarseBuildings].filter((building) => inBounds(building.centroid));
    const start = performance.now();
    const startDraws = window.__SF_HERO_DRAW_PROBE__.draws;
    const startTriangles = window.__SF_HERO_DRAW_PROBE__.triangles;
    const frames = [];
    let previousDraws = startDraws;
    let previousTriangles = startTriangles;
    await new Promise((resolve) => {
      const tick = (now) => {
        frames.push({ draws: window.__SF_HERO_DRAW_PROBE__.draws - previousDraws, triangles: window.__SF_HERO_DRAW_PROBE__.triangles - previousTriangles });
        previousDraws = window.__SF_HERO_DRAW_PROBE__.draws;
        previousTriangles = window.__SF_HERO_DRAW_PROBE__.triangles;
        if (now - start >= duration) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sum = (key) => frames.reduce((total, frame) => total + frame[key], 0);
    return {
      app: window.__SF_REALMAP__.getPerf(),
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
      visualDiagnostics: window.__SF_REALMAP__.getFrameDiagnostics(),
    };
  }, sampleMs);
  await page.screenshot({ path: screenshotPath });
  const measured = result.gpu.sampledFrames > 0
    && result.gpu.averageDrawCallsPerFrame > 0
    && result.gpu.averageTrianglesPerFrame > 0
    && result.entities.sourceRoadsInBufferedHeroTile > 0;
  console.log(JSON.stringify({
    result: errors.length || !measured ? 'failed' : 'captured', url, screenshotPath, result, errors,
    note: 'This is a repeatable workload probe, not a AAA-quality visual certification. Inspect the saved frame for city correctness.',
  }, null, 2));
  if (errors.length || !measured) process.exitCode = 1;
} finally {
  await browser.close();
}
