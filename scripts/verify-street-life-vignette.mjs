import { access, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const url = new URL('/realmap.html?place=ferry-building&mode=walk', baseUrl).toString();
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(systemChrome);
const angle = process.env.SF_QA_ANGLE || 'metal';
if (angle !== 'metal') throw new Error(`verify:street-life-vignette requires Metal, received ${angle}`);

const outputDir = process.env.SF_STREET_LIFE_DIR || '.qa-street-life-vignette';
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  executablePath: systemChrome,
  args: [
    '--disable-dev-shm-usage',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
});
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestErrors = [];
const captures = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};

function observe(page, label) {
  page.on('pageerror', (error) => consoleErrors.push(`${label}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('/favicon.ico')) {
      consoleErrors.push(`${label}: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => requestErrors.push(
    `${label}: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`,
  ));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      httpErrors.push(`${label}: ${response.status()} ${response.url()}`);
    }
  });
}

async function ready(page) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => (
    document.body.classList.contains('is-city')
      && window.__SF_REALMAP__?.getStreetLifeVignette?.().available === true
      && window.__SF_REALMAP__?.getPlayerPosition?.() != null
  ), null, { timeout: 60000 });
  await page.waitForTimeout(500);
}

async function rendererName(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#scene-canvas');
    const gl = canvas?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
}

async function waitVignette(page, predicate, timeout = 18000) {
  await page.waitForFunction(predicate, null, { timeout, polling: 25 });
  return page.evaluate(() => window.__SF_REALMAP__.getStreetLifeVignette());
}

async function capture(page, name) {
  const path = `${outputDir}/${name}.png`;
  await page.screenshot({ path });
  captures.push(path);
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  observe(page, 'movement');
  await ready(page);
  await page.evaluate(() => {
    window.__SF_REALMAP__.setWeather('clear');
    window.__SF_REALMAP__.setTimeOfDay('day');
  });

  const renderer = await rendererName(page);
  assert(typeof renderer === 'string'
    && /metal/i.test(renderer)
    && !/swiftshader|software|llvmpipe/i.test(renderer),
  'a verified hardware Metal renderer was not active', { angle, renderer });

  const baseline = await page.evaluate(() => ({
    player: window.__SF_REALMAP__.getPlayerPosition(),
    perf: window.__SF_REALMAP__.getPerf(),
  }));
  const activeBeforeExit = await page.evaluate(() => window.__SF_REALMAP__.getStreetLifeVignette());
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('s');
  await page.waitForTimeout(6500);
  await page.keyboard.up('s');
  await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(250);
  const inactive = await page.evaluate(() => window.__SF_REALMAP__.getStreetLifeVignette());
  assert(!inactive.active
    && inactive.phase === 'idle'
    && inactive.pedestrians.every((person) => !person.controlled)
    && inactive.vehicles.every((vehicle) => !vehicle.controlled),
  'vignette actors did not return to ordinary simulation outside the activation radius', inactive);
  const releasedVehicleDistance = Math.max(...inactive.vehicles.map((vehicle, index) => Math.hypot(
    vehicle.position.x - activeBeforeExit.vehicles[index].position.x,
    vehicle.position.z - activeBeforeExit.vehicles[index].position.z,
  )));
  assert(releasedVehicleDistance >= 1,
    'released traffic remained frozen at its scripted vignette stop', { activeBeforeExit, inactive });
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('w');
  await page.waitForTimeout(6500);
  await page.keyboard.up('w');
  await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(250);
  const reentered = await page.evaluate(() => window.__SF_REALMAP__.getStreetLifeVignette());
  assert(reentered.active
    && reentered.pedestrians.every((person) => person.controlled)
    && reentered.vehicles.every((vehicle) => vehicle.controlled),
  'vignette control did not reacquire after real-input re-entry', reentered);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('w');
  await page.waitForTimeout(8500);
  await page.keyboard.up('w');
  await page.keyboard.down('a');
  await page.waitForTimeout(1200);
  await page.keyboard.up('a');
  await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(120);
  const afterWalk = await page.evaluate(() => window.__SF_REALMAP__.getPlayerPosition());
  const displacement = Math.hypot(afterWalk.x - baseline.player.x, afterWalk.z - baseline.player.z);
  assert(displacement >= 10, 'real W/Shift traversal did not cover 10m', {
    start: baseline.player,
    end: afterWalk,
    displacement,
  });

  const queue = await waitVignette(page, () => {
    const state = window.__SF_REALMAP__.getStreetLifeVignette();
    return state.phase === 'queue' && state.elapsed >= 1;
  });
  const crossing = await waitVignette(page, () => {
    const state = window.__SF_REALMAP__.getStreetLifeVignette();
    return state.phase === 'cross' && state.stoppedSeconds >= 2.7;
  });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
  await capture(page, '00-real-input-cross');
  const clear = await waitVignette(page, () => {
    const state = window.__SF_REALMAP__.getStreetLifeVignette();
    return state.phase === 'clear' && state.vehicles.every((vehicle) => vehicle.speed >= 2);
  });

  assert(queue.pedestrians.length >= 2
    && new Set(queue.pedestrians.map(({ role }) => role)).size >= 2,
  'queue did not contain two distinct resident roles', queue);
  assert(crossing.pedestrians.length >= 2
    && crossing.pedestrians.every((person) => person.visible
      && person.detailed
      && !person.occluded
      && !person.overlapsPlayer
      && person.projectedHeightPx >= 6
      && person.groundErrorM <= 0.05),
  'crossing pedestrians were not readable and grounded', crossing.pedestrians);
  assert(crossing.vehicles.length >= 2
    && new Set(crossing.vehicles.map(({ variant }) => variant)).size >= 2
    && crossing.vehicles.every((vehicle) => vehicle.stopped
      && vehicle.speed === 0
      && vehicle.groundErrorM <= 0.05)
    && crossing.stoppedSeconds >= 1,
  'two vehicle classes did not hold a grounded one-second yield', crossing);
  assert(clear.resumes >= 2
    && clear.vehicles.every((vehicle) => vehicle.speed >= 2),
  'yielding vehicles did not resume after pedestrian clearance', clear);
  assert(crossing.phaseEvents.queue >= 1
    && crossing.phaseEvents.cross >= 1
    && clear.phaseEvents.clear >= 1
    && crossing.crossings >= 2
    && crossing.yields >= 2,
  'vignette phase/event evidence was incomplete', { queue, crossing, clear });
  const pedestrianSpacing = Math.hypot(
    crossing.pedestrians[0].position.x - crossing.pedestrians[1].position.x,
    crossing.pedestrians[0].position.z - crossing.pedestrians[1].position.z,
  );
  const vehicleSpacing = Math.hypot(
    crossing.vehicles[0].position.x - crossing.vehicles[1].position.x,
    crossing.vehicles[0].position.z - crossing.vehicles[1].position.z,
  );
  assert(pedestrianSpacing >= 1 && vehicleSpacing >= 6,
    'vignette actors overlap or interpenetrate', { pedestrianSpacing, vehicleSpacing });

  await page.waitForTimeout(9000);
  const performance = await page.evaluate(() => window.__SF_REALMAP__.getPerf());
  assert(Number.isFinite(performance.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'application p99 exceeded the 16.67ms budget', performance);
  assert(performance.heroStreetscape?.stats?.drawCalls <= 18,
    'hero streetscape draw-call budget regressed', performance.heroStreetscape);
  await context.close();

  // Beauty evidence uses a separate presentation-only page. The measured
  // traversal above is exclusively real keyboard input; this pose simply
  // keeps the authored crossing large enough for human 100% review.
  const beautyContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const beautyPage = await beautyContext.newPage();
  observe(beautyPage, 'beauty');
  await ready(beautyPage);
  await beautyPage.evaluate(() => {
    window.__SF_REALMAP__.setPlayerPose({ x: 2226, z: 1890, yaw: 1 });
    window.__SF_REALMAP__.setWeather('clear');
    window.__SF_REALMAP__.setTimeOfDay('day');
    window.__SF_REALMAP__.setBeauty(true);
  });
  const beautyQueue = await waitVignette(beautyPage, () => {
    const state = window.__SF_REALMAP__.getStreetLifeVignette();
    return state.phase === 'queue' && state.elapsed >= 1.2;
  });
  await capture(beautyPage, '01-queue-day');
  const beautyCross = await waitVignette(beautyPage, () => {
    const state = window.__SF_REALMAP__.getStreetLifeVignette();
    return state.phase === 'cross' && state.stoppedSeconds >= 2.7;
  });
  await capture(beautyPage, '02-cross-day');
  const beautyClear = await waitVignette(beautyPage, () => {
    const state = window.__SF_REALMAP__.getStreetLifeVignette();
    return state.phase === 'clear' && state.vehicles.every((vehicle) => vehicle.speed >= 2);
  });
  await capture(beautyPage, '03-clear-day');
  await beautyPage.evaluate(() => window.__SF_REALMAP__.setTimeOfDay('night'));
  const beautyNight = await waitVignette(beautyPage, () => {
    const state = window.__SF_REALMAP__.getStreetLifeVignette();
    return state.phase === 'cross' && state.stoppedSeconds >= 2.7;
  });
  await capture(beautyPage, '04-cross-night');
  await beautyContext.close();

  assert(beautyCross.pedestrians.every((person) => person.detailed
      && !person.occluded
      && !person.overlapsPlayer
      && person.projectedHeightPx >= 6),
  'beauty crossing actors were not detailed, unobstructed, and readable', beautyCross);
  assert(beautyCross.pedestrians.every((person) => person.projectedHeightPx <= 260)
    && beautyCross.vehicles.every((vehicle) => vehicle.projectedHeightPx <= 300),
  'beauty framing contains a giant clipped actor', beautyCross);
  assert(consoleErrors.length === 0, 'page/console errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestErrors.length === 0, 'request failures occurred', requestErrors);

  const report = {
    result: failures.length ? 'failed' : 'passed',
    renderer,
    url,
    displacement: Number(displacement.toFixed(2)),
    lifecycle: { activeBeforeExit, inactive, releasedVehicleDistance, reentered },
    queue,
    crossing,
    clear,
    beauty: { queue: beautyQueue, crossing: beautyCross, clear: beautyClear, night: beautyNight },
    performance,
    captures,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  };
  await writeFile(`${outputDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
