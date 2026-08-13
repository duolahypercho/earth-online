import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outDir = process.env.SF_HERO_EIGHT_CARD_DIR || '.qa-ferry-eight-card';
const traversalSeconds = Number(process.env.SF_HERO_TRAVERSAL_SECONDS || 30);
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const viewport = { width: 1440, height: 810 };
const buildHash = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [];
const captures = [];

async function ready(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getPlayerPosition?.() != null
      && window.__SF_REALMAP__?.getHeroCamera?.().active === true
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  await page.waitForTimeout(1400);
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
}

async function configure(page, { x, z, yaw, weather = 'clear', time = 'day' }) {
  await page.evaluate((settings) => {
    window.__SF_REALMAP__.setWeather(settings.weather);
    window.__SF_REALMAP__.setTimeOfDay(settings.time);
    window.__SF_REALMAP__.setPlayerPose(settings);
  }, { x, z, yaw, weather, time });
  await page.waitForTimeout(900);
}

async function capture(page, id) {
  const path = join(outDir, `${id}.png`);
  await page.screenshot({ path });
  const diagnostics = await page.evaluate(() => {
    const perf = window.__SF_REALMAP__.getPerf();
    return {
      weather: perf.weather,
      timeOfDay: perf.timeOfDay,
      heroLighting: perf.heroLighting,
      heroAtmosphere: perf.heroAtmosphere,
      heroStreetscape: perf.heroStreetscape,
      heroPedestrianStaging: perf.heroPedestrianStaging,
      heroLifeLighting: perf.heroLifeLighting,
      heroTrafficVisuals: perf.heroTrafficVisuals,
      heroCamera: perf.heroCamera,
    };
  });
  captures.push({ id, path, diagnostics });
}

try {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await ready(page);

  await configure(page, { x: 2173, z: 1831.4, yaw: 0.8008 });
  await capture(page, '01-commercial-street-day');

  await configure(page, { x: 2238, z: 1835, yaw: 2.28 });
  await capture(page, '02-intersection-crosswalk');

  await configure(page, { x: 2188, z: 1847, yaw: 0.804, time: 'dusk' });
  await capture(page, '03-building-canyon-dusk');

  // DataSF shoreline: this is source land 7.3 m from the Bay edge. The heading
  // faces the adjacent source-water side, so the card cannot depend on a
  // camera-only ground hole.
  await configure(page, { x: 2420, z: 1820, yaw: 2.4106859464 });
  await capture(page, '04-waterfront-day');

  await configure(page, { x: 2173, z: 1831.4, yaw: 0.8008, weather: 'drizzle' });
  await capture(page, '05-wet-street-drizzle');

  await configure(page, { x: 2173, z: 1831.4, yaw: 0.8008, time: 'night' });
  await capture(page, '06-night-practicals');

  await configure(page, { x: 2173, z: 1831.4, yaw: 0.8008 });
  await capture(page, '07a-character-standing');
  await page.keyboard.down('w');
  await page.waitForTimeout(650);
  await capture(page, '07b-character-walking');
  await page.keyboard.up('w');
  await page.waitForTimeout(500);
  await capture(page, '07c-character-stopped');

  const diagnostics = await page.evaluate(() => ({
    camera: window.__SF_REALMAP__.getHeroCamera(),
    landmark: window.__SF_REALMAP__.getHeroLandmark(),
    performance: window.__SF_REALMAP__.getPerf(),
    player: window.__SF_REALMAP__.getPlayerPosition(),
  }));
  await context.close();

  const traversalContext = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    recordVideo: { dir: outDir, size: viewport },
  });
  const traversalPage = await traversalContext.newPage();
  await ready(traversalPage);
  await configure(traversalPage, { x: 2173, z: 1831.4, yaw: -2.35 });
  const traversalStart = await traversalPage.evaluate(() => window.__SF_REALMAP__.getPlayerPosition());
  const video = traversalPage.video();
  await traversalPage.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
  });
  await traversalPage.waitForTimeout(Math.max(1, traversalSeconds) * 1000);
  await traversalPage.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
  });
  const traversalEnd = await traversalPage.evaluate(() => window.__SF_REALMAP__.getPlayerPosition());
  await traversalContext.close();
  const generatedVideoPath = await video.path();
  const traversalPath = join(outDir, '08-tile-boundary-traversal.webm');
  await rename(generatedVideoPath, traversalPath);

  const hero = diagnostics.landmark?.launchPose;
  const crossedHeroBoundary = traversalEnd.x < 2144 || traversalEnd.x > 2528
    || traversalEnd.z < 1728 || traversalEnd.z > 2112;
  const reachedHeroBoundary = Math.min(
    Math.abs(traversalEnd.x - 2144),
    Math.abs(traversalEnd.x - 2528),
    Math.abs(traversalEnd.z - 1728),
    Math.abs(traversalEnd.z - 2112),
  ) <= 0.25;
  const manifest = {
    result: errors.length ? 'failed' : 'captured',
    buildHash,
    url,
    viewport,
    outputPixels: { width: viewport.width * 2, height: viewport.height * 2 },
    captures,
    traversal: {
      path: traversalPath,
      seconds: traversalSeconds,
      start: traversalStart,
      end: traversalEnd,
      reachedHeroBoundary,
      crossedHeroBoundary,
    },
    launchPose: hero,
    diagnostics,
    errors,
    note: 'Evidence capture only. Human blind review determines the visual gate.',
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
  if (errors.length || !crossedHeroBoundary) process.exitCode = 1;
} finally {
  await browser.close();
}
