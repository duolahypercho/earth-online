import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const url = process.env.SF_QA_URL || 'http://127.0.0.1:5175/';
const output = process.env.SF_QA_OUTPUT || '.qa-citygen-metric-map.json';
const screenshot = process.env.SF_QA_SCREENSHOT || '.qa-citygen-metric-map.png';
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
});

try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const state = window.__CITYGEN__?.getState?.();
    return state?.webgpu === true && state?.generator === 'sf-builtin' && state?.busy === false;
  }, { timeout: 60000 });
  const result = await page.evaluate(() => window.__CITYGEN__.loadMetricSf());
  if (!result) throw new Error('Metric map loader rejected the candidate');
  await page.waitForFunction(() => window.__CITYGEN__?.getState?.().metricMap?.verifiedTiles === 10, { timeout: 120000 });
  await page.waitForTimeout(1200);
  const report = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const state = api.getState();
    const metric = api.getMetricMap();
    const renderer = api.getRenderer();
    let meshes = 0;
    let triangles = 0;
    renderer.root.traverse((node) => {
      if (!node.isMesh) return;
      meshes += 1;
      const indexCount = node.geometry?.index?.count || 0;
      const positionCount = node.geometry?.getAttribute?.('position')?.count || 0;
      triangles += indexCount ? indexCount / 3 : positionCount / 3;
    });
    return {
      generator: state.generator,
      rendererType: renderer.renderer.constructor.name,
      rendererBackend: renderer.rendererBackend,
      manifestTileCount: metric.manifestTileCount,
      tileIds: metric.tileIds,
      anchorOriginEpsg26910: metric.anchorOriginEpsg26910,
      records: metric.records,
      scene: {
        rootName: renderer.root.name,
        childTiles: renderer.root.children.length,
        meshes,
        triangles,
        allScaleOne: renderer.root.children.every((tile) => tile.scale.x === 1 && tile.scale.y === 1 && tile.scale.z === 1),
        anchorSubtractedOnce: renderer.root.children.some((tile) => tile.position.x === 0 && tile.position.y === 0 && tile.position.z === 0),
      },
      errors: state.errors,
    };
  });
  report.browserErrors = errors;
  report.pass = report.generator === 'sf-metric-tiles'
    && report.rendererType === 'WebGPURenderer'
    && report.rendererBackend === 'webgpu'
    && report.manifestTileCount === 803
    && report.tileIds.length === 10
    && report.tileIds.includes('epsg26910-1441-10893')
    && report.records.length === 10
    && report.records.every((record) => /^sha256:[a-f0-9]{64}$/.test(record.glbSha256)
      && /^sha256:[a-f0-9]{64}$/.test(record.receiptSha256)
      && record.originSubtractions === 1
      && record.sceneScale === 1)
    && report.scene.rootName === 'authoritative-sf-metric-root'
    && report.scene.childTiles === 10
    && report.scene.meshes > 0
    && report.scene.triangles > 0
    && report.scene.allScaleOne
    && report.scene.anchorSubtractedOnce
    && report.errors.length === 0
    && errors.length === 0;
  await page.screenshot({ path: screenshot });
  await page.evaluate(() => window.__CITYGEN__.loadBuiltinSf());
  await page.waitForFunction(() => window.__CITYGEN__?.getState?.().generator === 'sf-builtin', { timeout: 60000 });
  report.returnToDefault = await page.evaluate(() => ({
    generator: window.__CITYGEN__.getState().generator,
    rootName: window.__CITYGEN__.getRenderer().root?.name || null,
    errors: window.__CITYGEN__.getState().errors,
  }));
  report.browserErrors = errors;
  report.pass = report.pass
    && report.returnToDefault.generator === 'sf-builtin'
    && report.returnToDefault.rootName === 'city-root'
    && report.returnToDefault.errors.length === 0
    && errors.length === 0;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  await browser.close();
}
