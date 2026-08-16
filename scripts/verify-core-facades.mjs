import { access, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const outputDir = process.env.SF_CORE_FACADE_DIR || '.qa-core-facades';
const viewport = { width: 1280, height: 720 };
const expected = [
  ['Civic Center Espresso', 'cafe'],
  ['Van Ness Residence Hotel', 'hotel'],
  ['Midtown Produce Market', 'market'],
  ['Pyramid Plaza Cafe', 'cafe'],
  ['South Market Tower Lobby', 'tower'],
];

if (process.platform !== 'darwin') throw new Error('Core facade QA requires macOS Metal.');
if ((process.env.SF_QA_ANGLE || 'metal') !== 'metal') throw new Error('Set SF_QA_ANGLE=metal.');
if (!executablePath) throw new Error(`System Chrome is required: ${systemChrome}`);
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  executablePath,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport });
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestErrors = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('/favicon.ico')) consoleErrors.push(message.text());
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${response.status()} ${response.url()}`);
  }
});
page.on('requestfailed', (request) => {
  if (!request.url().endsWith('/favicon.ico')) {
    requestErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
  }
});

await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
await page.evaluate(() => localStorage.removeItem('earth-online-player-progress-v1'));
await page.waitForFunction(() => document.querySelector('#launch-button')
  && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
await page.locator('#launch-button').click();
await page.waitForFunction(() => document.querySelector('#boot-overlay')
  ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
await page.waitForFunction(() => window.__SF_SIM__?.city?.getCoreFacadeDiagnostics?.().length === 5,
  null, { timeout: 10000 });
await page.waitForTimeout(900);

const renderer = await page.evaluate(() => {
  const gl = document.querySelector('#scene-canvas')?.getContext('webgl2');
  const extension = gl?.getExtension('WEBGL_debug_renderer_info');
  return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
});
assert(typeof renderer === 'string' && /metal/i.test(renderer), 'Renderer must be Metal.', { renderer });
assert(!/swiftshader|software|llvmpipe/i.test(renderer || ''), 'Software renderer is forbidden.', { renderer });

const baseline = await page.evaluate(() => ({
  portals: window.__SF_SIM__.city.portals.map((portal) => portal.id),
  resources: {
    geometries: window.__SF_SIM__.renderer.info.memory.geometries,
    textures: window.__SF_SIM__.renderer.info.memory.textures,
  },
  facades: window.__SF_SIM__.city.getCoreFacadeDiagnostics(),
}));
assert(baseline.facades.length === expected.length, 'Exactly five core facades must be tagged.', baseline.facades);
for (const [label, kind] of expected) {
  const facade = baseline.facades.find((entry) => entry.label === label);
  assert(Boolean(facade), `Missing facade diagnostics for ${label}.`);
  assert(facade?.kind === kind, `${label} must retain its differentiated facade profile.`, facade);
  assert(facade?.detailCount >= 18, `${label} needs at least 18 depth/detail pieces.`, facade);
  assert(facade?.depthMeters >= 0.45 && facade?.depthMeters <= 1.25,
    `${label} facade depth must be bounded.`, facade);
  assert(facade?.visible === true, `${label} facade group must be visible.`, facade);
}

await page.keyboard.press('h');
const captures = [];
for (const facade of baseline.facades) {
  const { x, z, height } = facade.bounds;
  const distance = facade.kind === 'market'
    ? 11.5
    : Math.max(18, Math.min(44, height * 1.08));
  const cameraX = facade.label === 'Pyramid Plaza Cafe' ? x + 7.5 : x;
  const cameraY = facade.kind === 'market' ? 3.4 : Math.min(8, 3.6 + height * 0.1);
  const lookY = facade.kind === 'market' ? 3.6 : Math.min(15, 3.2 + height * 0.28);
  await page.evaluate(({ x: px, z: pz, cameraX: cx, cameraY: py, lookY: ly, distance: d }) => {
    window.__SF_SIM__.setRoamPose({ x: cx, z: pz - d * 0.55 });
    window.__SF_SIM__.setCameraPose(
      { x: cx, y: py, z: pz - d },
      { x: px, y: ly, z: pz - 0.2 },
    );
  }, { x, z, cameraX, cameraY, lookY, distance });
  await page.waitForTimeout(420);
  const slug = facade.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const path = `${outputDir}/${slug}.png`;
  await page.screenshot({ path });
  const screen = await page.evaluate((label) => {
    const sim = window.__SF_SIM__;
    const detail = [];
    sim.scene.traverse((object) => {
      if (object.userData?.coreFacadeLabel !== label || !object.isMesh) return;
      const center = object.position.clone();
      object.parent?.localToWorld(center);
      const halfX = Math.abs(object.scale.x) * 0.5;
      const halfY = Math.abs(object.scale.y) * 0.5;
      const halfZ = Math.abs(object.scale.z) * 0.5;
      const corners = [
        [-halfX, -halfY, -halfZ], [-halfX, -halfY, halfZ],
        [-halfX, halfY, -halfZ], [-halfX, halfY, halfZ],
        [halfX, -halfY, -halfZ], [halfX, -halfY, halfZ],
        [halfX, halfY, -halfZ], [halfX, halfY, halfZ],
      ].map(([cx, cy, cz]) => center.clone().add({ x: cx, y: cy, z: cz }).project(sim.camera));
      const visible = corners.filter((corner) => corner.z >= -1 && corner.z <= 1);
      if (!visible.length) return;
      const xs = visible.map((corner) => (corner.x * 0.5 + 0.5) * 1280);
      const ys = visible.map((corner) => (-corner.y * 0.5 + 0.5) * 720);
      detail.push({
        left: Math.min(...xs), right: Math.max(...xs),
        top: Math.min(...ys), bottom: Math.max(...ys),
      });
    });
    return detail;
  }, facade.label);
  const union = screen.reduce((box, item) => ({
    left: Math.min(box.left, item.left), right: Math.max(box.right, item.right),
    top: Math.min(box.top, item.top), bottom: Math.max(box.bottom, item.bottom),
  }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  const projectedWidth = union.right - union.left;
  const projectedHeight = union.bottom - union.top;
  assert(screen.length >= 12, `${facade.label} must project at least 12 detail meshes.`, { screenCount: screen.length });
  assert(projectedWidth >= 240 && projectedHeight >= 260,
    `${facade.label} must be readable in the capture.`, { projectedWidth, projectedHeight });
  assert(union.right >= 32 && union.left <= 1248 && union.bottom >= 32 && union.top <= 688,
    `${facade.label} must intersect the visible frame.`, union);
  captures.push({ label: facade.label, path, screenCount: screen.length, projectedWidth, projectedHeight });
}

await page.evaluate(() => {
  window.__SF_SIM__.setCameraPose(null, null);
  window.__SF_SIM__.resetPerformanceTelemetry();
});
await page.keyboard.press('w');
await page.waitForTimeout(900);
await page.keyboard.up('w');
await page.waitForTimeout(1100);
const settledResources = await page.evaluate(() => ({
  geometries: window.__SF_SIM__.renderer.info.memory.geometries,
  textures: window.__SF_SIM__.renderer.info.memory.textures,
}));
await page.waitForTimeout(1200);
const final = await page.evaluate(() => ({
  portals: window.__SF_SIM__.city.portals.map((portal) => portal.id),
  resources: {
    geometries: window.__SF_SIM__.renderer.info.memory.geometries,
    textures: window.__SF_SIM__.renderer.info.memory.textures,
  },
  performance: window.__SF_SIM__.getPerformanceSnapshot(),
}));
assert(JSON.stringify(final.portals) === JSON.stringify(baseline.portals), 'Portal IDs/count changed during facade QA.');
assert(final.resources.geometries === settledResources.geometries, 'Geometry count grew after the live scene settled.', { settled: settledResources, final: final.resources });
assert(final.resources.textures === settledResources.textures, 'Texture count grew after the live scene settled.', { settled: settledResources, final: final.resources });
assert(final.performance.applicationP99FrameMs <= 16.67, 'Application p99 exceeds 16.67ms.', final.performance);
assert(consoleErrors.length === 0, 'Console/page errors detected.', consoleErrors);
assert(httpErrors.length === 0, 'HTTP errors detected.', httpErrors);
assert(requestErrors.length === 0, 'Request failures detected.', requestErrors);

const report = {
  renderer,
  viewport,
  facades: baseline.facades,
  captures,
  portals: baseline.portals.length,
  resources: { baseline: baseline.resources, settled: settledResources, final: final.resources },
  performance: final.performance,
  consoleErrors,
  httpErrors,
  requestErrors,
  failures,
};
await writeFile(`${outputDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
if (failures.length) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log('core facade gate passed');
console.log(JSON.stringify({ renderer, captures, performance: final.performance }, null, 2));
