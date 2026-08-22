// Frame-free check that the review-protocol resolution path still stands up.
//
// The gate's blind-review protocol needs >= 1440p. On this software rasterizer
// a 2560x1440 card costs minutes, so this probe answers the part that can be
// answered cheaply: does the canonical route actually COME UP at that viewport,
// does the renderer allocate a drawing buffer of that size, does MSAA survive,
// and do the shadow render targets still allocate. It never calls renderFrame,
// so it costs one world boot, not a card.
//
//   SF_QA_W=2560 SF_QA_H=1440 node scripts/qa/probe-protocol-resolution-v1.mjs
//
// Env: SF_QA_URL, SF_QA_W, SF_QA_H, SF_QA_PROTOCOL=1, SF_QA_PROBE_OUT
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const URL_BASE = process.env.SF_QA_URL || 'http://127.0.0.1:5178/';
const PROTOCOL = process.env.SF_QA_PROTOCOL === '1';
const W = Number(process.env.SF_QA_W || (PROTOCOL ? 2560 : 1280));
const H = Number(process.env.SF_QA_H || (PROTOCOL ? 1440 : 720));
const OUT = process.env.SF_QA_PROBE_OUT || '.qa-protocol-probe';
const BOOT_MS = Number(process.env.SF_QA_BOOT_MS || 300000);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(() => { window.__QA_SKIP_PREWARM__ = true; });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
let crashed = false;
page.on('crash', () => { crashed = true; });

const startedAt = Date.now();
const report = { url: URL_BASE, viewport: { w: W, h: H }, protocol: PROTOCOL };
try {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // Stop drawing as early as the handle exists, so the boot is the only cost.
  await page.waitForFunction(() => !!window.__CITYGEN__?.getRenderer, null, { timeout: BOOT_MS });
  await page.evaluate(() => {
    const r = window.__CITYGEN__.getRenderer();
    if (!r.__probePinned) { r.renderFrame = () => undefined; r.__probePinned = true; }
  });
  await page.waitForFunction(() => (window.__CITYGEN__?.getCity()?.buildings?.length || 0) > 50, null, { timeout: BOOT_MS });
  report.bootMs = Date.now() - startedAt;
  report.probe = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const r = api.getRenderer();
    const gl = r.renderer;
    const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
    const V = api.THREE?.Vector2;
    const size = V && gl?.getDrawingBufferSize ? gl.getDrawingBufferSize(new V()) : null;
    const shadow = r.sun?.shadow || null;
    const map = shadow?.map || null;
    const canvas = gl?.domElement || document.getElementById('scene-canvas');
    return {
      rendererBackend: safe(() => api.getState().rendererBackend),
      isWebGPUBackend: safe(() => (gl?.backend ? !!gl.backend.isWebGPUBackend : null)),
      samples: safe(() => gl?.samples ?? null),
      pixelRatio: safe(() => gl?.getPixelRatio?.() ?? null),
      drawingBufferSize: size ? [size.x, size.y] : null,
      canvasSize: canvas ? [canvas.width, canvas.height] : null,
      cssSize: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
      shadow: {
        requested: shadow?.mapSize ? [shadow.mapSize.width, shadow.mapSize.height] : null,
        allocated: map ? [map.width ?? null, map.height ?? null] : null,
        exists: !!map,
      },
      deviceMemoryGb: navigator.deviceMemory ?? null,
      jsHeapMb: safe(() => Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576), null),
      boot: safe(() => (typeof api.getBootPhases === 'function' ? api.getBootPhases() : null)),
    };
  });
} catch (error) {
  report.error = String(error).slice(0, 400);
}
report.rendererCrashed = crashed;
report.errors = errors.slice(0, 20);
await writeFile(path.join(OUT, `protocol-probe-${W}x${H}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  viewport: report.viewport,
  bootMs: report.bootMs,
  drawingBufferSize: report.probe?.drawingBufferSize,
  canvasSize: report.probe?.canvasSize,
  samples: report.probe?.samples,
  shadow: report.probe?.shadow,
  crashed,
  error: report.error || null,
  errors: report.errors.length,
}, null, 2));
await browser.close();
