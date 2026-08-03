import { chromium } from 'playwright';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174/';
const outputDir = process.env.SF_PASS9_DIR
  || join(process.cwd(), 'sessions/pass9-captures');
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
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

await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(
  () => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled
    && document.querySelector('#boot-overlay')?.classList.contains('is-ready'),
  { timeout: 90000 },
);
await page.evaluate(() => {
  if (typeof window.__SF_SIM__?.launch === 'function') window.__SF_SIM__.launch();
  else document.querySelector('#launch-button')?.click();
});
await page.waitForFunction(
  () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed')
    && !!window.__SF_SIM__,
  { timeout: 20000 },
);
await page.waitForTimeout(2000);
await page.evaluate(() => {
  document.querySelector('#boot-overlay')?.classList.add('is-dismissed');
  const boot = document.querySelector('#boot-overlay');
  if (boot) boot.style.display = 'none';
  if (window.__SF_SIM__?.isDriving?.()) window.__SF_SIM__.exitCar?.();
});

const shots = [
  { name: 'core-clear-beauty', weather: 'clear', pose: null },
  { name: 'core-fog-beauty', weather: 'fog', pose: null },
  { name: 'core-drizzle-beauty', weather: 'drizzle', pose: null },
  {
    name: 'waterfront-clear-beauty',
    weather: 'clear',
    pose: {
      position: { x: 52, y: 12, z: 72 },
      lookAt: { x: 28, y: 4, z: 110 },
    },
  },
  {
    name: 'waterfront-fog-beauty',
    weather: 'fog',
    pose: {
      position: { x: 52, y: 12, z: 72 },
      lookAt: { x: 28, y: 4, z: 110 },
    },
  },
  {
    name: 'waterfront-drizzle-beauty',
    weather: 'drizzle',
    pose: {
      position: { x: 52, y: 12, z: 72 },
      lookAt: { x: 28, y: 4, z: 110 },
    },
  },
];

const saved = [];
for (const shot of shots) {
  await page.evaluate((mode) => {
    window.__SF_SIM__.setRenderQuality('cinematic');
    window.__SF_SIM__.setWeather(mode);
  }, shot.weather);
  await page.waitForTimeout(2200);
  if (shot.pose) {
    await page.evaluate((pose) => {
      window.__SF_SIM__.setCameraPose(pose.position, pose.lookAt);
    }, shot.pose);
    await page.waitForTimeout(900);
  } else {
    await page.evaluate(() => window.__SF_SIM__.setCameraPose());
  }
  await page.evaluate(() => {
    document.querySelector('#app')?.classList.add('is-beauty');
    const hud = document.querySelector('#hud-root');
    if (hud) hud.style.visibility = 'hidden';
    const boot = document.querySelector('#boot-overlay');
    if (boot) boot.style.display = 'none';
  });
  await page.waitForTimeout(260);
  const file = join(outputDir, `${shot.name}.png`);
  await page.screenshot({ path: file });
  saved.push(file);
}

console.log(JSON.stringify({ saved, errors: errors.slice(0, 8) }, null, 2));
await browser.close();
