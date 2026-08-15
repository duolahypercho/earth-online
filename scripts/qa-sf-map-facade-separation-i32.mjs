import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SF_MAP_FACADE_QA_PORT || 5202);
const baseUrl = `http://127.0.0.1:${port}/sf-map.html`;
const outputDir = process.env.SF_MAP_FACADE_QA_DIR || join(root, '.qa-sf-map-facade-separation-i32');
const referenceDir = process.env.SF_MAP_FACADE_QA_REFERENCE_DIR || null;
const settleTimeoutMs = Number(process.env.SF_MAP_FACADE_QA_TIMEOUT_MS || 300000);
const manifest = JSON.parse(await readFile(join(
  root,
  'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json',
), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tupleWithin(actual, expected, tolerance = 1e-4) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

async function waitForPort(host, targetPort, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const available = await new Promise((resolve) => {
      const socket = createConnection({ host, port: targetPort });
      socket.once('connect', () => socket.end(() => resolve(true)));
      socket.once('error', () => resolve(false));
    });
    if (available) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not open ${host}:${targetPort}`);
}

function imageMetrics(pixels, width, region) {
  const luminance = [];
  let edgeEnergy = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const index = (y * width + x) * 4;
      const value = (0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255;
      luminance.push(value);
      if (x > region.x) {
        const left = index - 4;
        const leftValue = (0.2126 * pixels[left] + 0.7152 * pixels[left + 1] + 0.0722 * pixels[left + 2]) / 255;
        edgeEnergy += Math.abs(value - leftValue);
      }
      if (y > region.y) {
        const above = index - width * 4;
        const aboveValue = (0.2126 * pixels[above] + 0.7152 * pixels[above + 1] + 0.0722 * pixels[above + 2]) / 255;
        edgeEnergy += Math.abs(value - aboveValue);
      }
    }
  }
  luminance.sort((left, right) => left - right);
  const percentile = (fraction) => luminance[Math.floor((luminance.length - 1) * fraction)];
  const mean = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
  return {
    region,
    pixels: luminance.length,
    luminanceMean: mean,
    luminanceP10: percentile(0.1),
    luminanceP50: percentile(0.5),
    luminanceP90: percentile(0.9),
    tonalSpanP90P10: percentile(0.9) - percentile(0.1),
    shadowCrushRatio: luminance.filter((value) => value < 0.14).length / luminance.length,
    highlightRatio: luminance.filter((value) => value > 0.82).length / luminance.length,
    edgeEnergyPerPixel: edgeEnergy / luminance.length,
  };
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

async function pngRgba(path) {
  const file = await readFile(path);
  assert(file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${path} is not a PNG.`);
  let offset = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset); offset += 4;
    const type = file.subarray(offset, offset + 4).toString('ascii'); offset += 4;
    const data = file.subarray(offset, offset + length); offset += length + 4;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
  }
  assert(bitDepth === 8 && (colorType === 2 || colorType === 6), `${path} must be an 8-bit RGB(A) Playwright screenshot.`);
  const filtered = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const unfiltered = new Uint8Array(width * height * bytesPerPixel);
  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[input]; input += 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[input]; input += 1;
      const left = x >= bytesPerPixel ? unfiltered[row + x - bytesPerPixel] : 0;
      const above = y ? unfiltered[row + x - stride] : 0;
      const upperLeft = y && x >= bytesPerPixel ? unfiltered[row + x - stride - bytesPerPixel] : 0;
      unfiltered[row + x] = (raw + (filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft))) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < unfiltered.length; source += bytesPerPixel, target += 4) {
    rgba[target] = unfiltered[source]; rgba[target + 1] = unfiltered[source + 1]; rgba[target + 2] = unfiltered[source + 2]; rgba[target + 3] = 255;
  }
  return { width, height, rgba };
}

async function captureCanvasMetrics(path, name) {
  const { width, height, rgba } = await pngRgba(path);
  const regions = name === 'ferry'
    ? { facade: { x: 330, y: 52, width: 900, height: 370 } }
    : { district: { x: 115, y: 78, width: 1050, height: 590 } };
  assert(Object.values(regions).every((region) => region.x + region.width <= width && region.y + region.height <= height), `${name} metric crop exceeds the canvas.`);
  return Object.fromEntries(Object.entries(regions).map(([key, region]) => [key, imageMetrics(rgba, width, region)]));
}

async function buildContactSheet(page, before, after) {
  const pairs = [
    { label: 'FERRY · IDENTICAL PRESET / RESIDENCY', before: before.ferry, after: after.ferry },
    { label: 'DISTRICT · IDENTICAL PRESET / RESIDENCY', before: before.district, after: after.district },
  ];
  const encoded = await Promise.all(pairs.map(async (pair) => ({
    ...pair,
    before: `data:image/png;base64,${(await readFile(pair.before)).toString('base64')}`,
    after: `data:image/png;base64,${(await readFile(pair.after)).toString('base64')}`,
  })));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><style>
    body{margin:0;background:#07100f;color:#d7ff48;font:600 12px system-ui}.grid{display:grid;grid-template-columns:1fr 1fr;height:720px}
    section{min-width:0;border-right:1px solid #314239}section:last-child{border:0}header{height:30px;box-sizing:border-box;padding:8px 12px;background:#0b1713}
    .row{height:345px;position:relative}.row span{position:absolute;z-index:1;left:10px;top:9px;padding:4px 6px;background:#07100fcc}.row img{width:100%;height:345px;object-fit:cover;display:block}
  </style><div class="grid">${encoded.map(({ label, before: beforeImage, after: afterImage }) => `<section><header>${label}</header><div class="row"><span>BEFORE</span><img src="${beforeImage}"></div><div class="row"><span>AFTER · RENDER ONLY</span><img src="${afterImage}"></div></section>`).join('')}</div>`);
  const output = join(outputDir, 'ferry-district-facade-before-after.png');
  await page.screenshot({ path: output });
  return output;
}

const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});
let browser;
try {
  await mkdir(outputDir, { recursive: true });
  await waitForPort('127.0.0.1', port);
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__SF_MAP_VIEWER__), { timeout: 30000 });

  async function settle(view) {
    await page.evaluate((name) => window.__SF_MAP_VIEWER__.setView(name), view);
    await page.waitForFunction((name) => {
      const viewer = window.__SF_MAP_VIEWER__;
      const diagnostics = viewer?.streamingDiagnostics;
      if (!viewer || !diagnostics || diagnostics.activeView !== name || diagnostics.activeLoadCount || diagnostics.queuedCount) return false;
      if (name === 'district' && diagnostics.districtFit.oneTimeStatus !== 'fitted') return false;
      if (diagnostics.explicitViewResidency.lastPrune?.view !== name) return false;
      const focus = diagnostics.focusWorldPosition;
      const expected = viewer.tileDescriptors.filter((tile) => Math.hypot(
        focus[0] - (tile.offset[0] + tile.size / 2),
        focus[1] - (tile.offset[2] + tile.size / 2),
      ) <= 880).map((tile) => tile.id).sort();
      return JSON.stringify([...viewer.residentTileIds].sort()) === JSON.stringify(expected);
    }, view, { timeout: settleTimeoutMs });
    return page.evaluate(() => {
      const viewer = window.__SF_MAP_VIEWER__;
      const diagnostics = viewer.streamingDiagnostics;
      return {
        residents: [...viewer.residentTileIds].sort(),
        descriptorCount: viewer.tileDescriptors.length,
        camera: diagnostics.camera,
        presentation: diagnostics.presentation,
        metricContract: diagnostics.metricContract,
        rejected: diagnostics.completed.filter((entry) => entry.result === 'rejected'),
        activeLoadCount: diagnostics.activeLoadCount,
      };
    });
  }

  const captures = {};
  for (const [view, expectedResidents] of [['ferry', 10], ['district', 16]]) {
    const runtime = await settle(view);
    assert(runtime.descriptorCount === manifest.tiles.length, `${view} descriptor count drifted from the current manifest.`);
    assert(runtime.residents.length === expectedResidents, `${view} resident count changed: ${runtime.residents.length}.`);
    assert(runtime.rejected.length === 0 && runtime.activeLoadCount === 0, `${view} source stream is not cleanly settled.`);
    assert(runtime.metricContract?.runtimeUnitsPerMetre === 1 && runtime.metricContract?.sceneScale === 1
      && runtime.metricContract?.originSubtractions === 1 && runtime.metricContract?.sourceLockedDescriptors, `${view} lost the metric/source lock.`);
    assert(runtime.presentation?.activeViewShadowed, `${view} lost local presentation shadows.`);
    const screenshot = join(outputDir, `${view}.png`);
    await page.locator('#map-canvas').screenshot({ path: screenshot });
    captures[view] = {
      runtime,
      metrics: await captureCanvasMetrics(screenshot, view),
      screenshot,
    };
  }
  assert(tupleWithin(captures.ferry.runtime.camera.position, [430, 132, 292]), 'The reviewed Ferry camera changed.');
  assert(tupleWithin(captures.ferry.runtime.camera.target, [119, 8, 292]), 'The reviewed Ferry focus changed.');
  assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);

  let comparison = null;
  if (referenceDir) {
    await page.close();
    await browser.close();
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
    const sheet = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      comparison = await buildContactSheet(sheet, {
        ferry: join(referenceDir, 'ferry.png'), district: join(referenceDir, 'district.png'),
      }, { ferry: captures.ferry.screenshot, district: captures.district.screenshot });
    } finally {
      await sheet.close();
    }
  }
  const report = {
    result: 'SF map facade-separation i32 capture passed',
    manifestTiles: manifest.tiles.length,
    referenceDir,
    screenshots: { ferry: captures.ferry.screenshot, district: captures.district.screenshot, comparison },
    captures,
    errors,
    metricMethod: 'PNG readback over fixed map-only regions; p10/p90 span and edge energy quantify tonal/shape separation, while shadow-crush ratio tracks sub-0.14 luma area.',
  };
  await writeFile(join(outputDir, 'facade-separation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
