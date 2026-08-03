import { chromium } from 'playwright';
import { access } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
    errors.push(message.text());
  }
});

const stops = [
  {
    id: 'financial-skyline',
    focus: { x: 1536, z: 96 },
    camera: { x: 1544, y: 34, z: -80 },
    lookAt: { x: 1420, y: 6, z: 24 },
    minClearance: 24,
  },
  {
    id: 'north-beach-coit',
    focus: { x: 1536, z: 1536 },
    camera: { x: 1460, y: 52, z: 1468 },
    lookAt: { x: 1340, y: 8, z: 1336 },
    minClearance: 20,
  },
  {
    id: 'mission-bay',
    focus: { x: 1536, z: -1536 },
    camera: { x: 1600, y: 34, z: -1420 },
    lookAt: { x: 1420, y: 6, z: -1580 },
    minClearance: 24,
  },
  {
    id: 'core-avenue',
    focus: { x: 28, z: 0 },
    camera: { x: 48, y: 8.5, z: 32 },
    lookAt: { x: 20, y: 2, z: -10 },
    minClearance: 4,
  },
  {
    id: 'night-financial',
    focus: { x: 1536, z: 96 },
    camera: { x: 1544, y: 34, z: -80 },
    lookAt: { x: 1420, y: 6, z: 24 },
    minClearance: 24,
    hour: 22,
  },
  {
    id: 'night-core',
    focus: { x: 28, z: 0 },
    camera: { x: 48, y: 8.5, z: 32 },
    lookAt: { x: 20, y: 2, z: -10 },
    minClearance: 4,
    hour: 22,
  },
];

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    { timeout: 30000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    window.__SF_SIM__.setRenderQuality('cinematic');
    window.__SF_SIM__.setWeather('clear');
  });
  await page.keyboard.press('h');
  await page.waitForTimeout(1800);

  for (const stop of stops) {
    if (stop.hour !== undefined) {
      await page.evaluate((hour) => window.__SF_SIM__.setTimeOfDay(hour), stop.hour);
    }
    const placement = await page.evaluate(({ focus, camera, lookAt, minClearance }) => {
      const sim = window.__SF_SIM__;
      sim.setRoamPose({ x: focus.x, z: focus.z });
      const surface = sim.streaming.getSurfaceHeight?.({ x: focus.x, z: focus.z });
      const ground = Number.isFinite(surface) ? surface : 0;
      const cameraY = Math.max(ground + (minClearance ?? 34), camera.y);
      sim.setCameraPose(
        { x: camera.x, y: cameraY, z: camera.z },
        { x: lookAt.x, y: ground + 6, z: lookAt.z },
      );
      return { surface: ground, cameraY };
    }, stop);
    await page.waitForTimeout(stop.id === 'core-avenue' ? 1200 : 3600);
    if (stop.id === 'financial-skyline') console.log('financial placement', placement);
    await page.screenshot({ path: `.qa-beauty-${stop.id}.png` });
  }
  console.log('saved', stops.map((stop) => `.qa-beauty-${stop.id}.png`).join(', '));
  if (errors.length) console.log('errors:', errors.slice(0, 5));
} catch (error) {
  console.error(JSON.stringify({ result: 'beauty capture failed', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
