/**
 * Capture a deterministic set of beauty frames from the Real Map Lab.
 * Usage: node scripts/qa-capture-set.mjs --out <dir> [--preset downtown|city] [--shots subset]
 * Env: SF_QA_URL (default http://localhost:5173/realmap.html?qa=1)
 * Writes <out>/<id>.png plus <out>/manifest.json.
 */
import { chromium } from 'playwright';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = get('--out', 'tmp/shots');
const preset = get('--preset', 'downtown');
const only = get('--shots', '');
const wanted = only ? new Set(only.split(',')) : null;

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/realmap.html?qa=1';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);

await mkdir(outDir, { recursive: true });

const SHOTS = [
  { id: 'city-beauty', pose: 'city', weather: 'clear', time: 'day' },
  { id: 'canyon-beauty', pose: 'canyon', weather: 'clear', time: 'day' },
  { id: 'street-beauty', pose: 'street', weather: 'clear', time: 'day' },
  { id: 'hills-beauty', pose: 'hills', weather: 'clear', time: 'day' },
  { id: 'night-beauty', pose: 'night', weather: 'clear', time: 'night' },
  { id: 'drizzle-beauty', pose: 'city', weather: 'drizzle', time: 'day' },
];

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message || error)));

await page.goto(baseUrl, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(
  () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
  { timeout: 120000 },
);
await page.locator('#launch-button').click();
await page.evaluate((name) => window.__SF_REALMAP__.applyPreset(name), preset);
if (preset === 'city') {
  await page.evaluate(() => window.__SF_REALMAP__.playPrebuilt());
} else {
  await page.evaluate(() => window.__SF_REALMAP__.build());
}
await page.waitForFunction(() => window.__SF_REALMAP__.getBuildState().isCity, { timeout: 240000 });
await page.waitForTimeout(2600);

const manifest = [];
for (const shot of SHOTS) {
  if (wanted && !wanted.has(shot.id)) continue;
  await page.evaluate(({ weather, time }) => {
    window.__SF_REALMAP__.setWeather(weather);
    window.__SF_REALMAP__.setTimeOfDay(time);
  }, shot);
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
  await page.evaluate((poseKey) => {
    const poses = window.__SF_REALMAP__.getSuggestedCameraPoses();
    let pose = poses[poseKey];
    if (poseKey === 'city') pose = poses.canyon || poses.street;
    window.__SF_REALMAP__.setCameraPose(pose);
  }, shot.pose);
  await page.waitForTimeout(900);
  const path = join(outDir, `${shot.id}.png`);
  await page.screenshot({ path });
  manifest.push({ id: shot.id, path, ...shot });
}
await page.evaluate(() => window.__SF_REALMAP__.setBeauty(false));
await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ preset, shots: manifest, errors }, null, 2));
console.log(JSON.stringify({ out: outDir, shots: manifest.map((m) => m.id), errors }, null, 2));
await browser.close();
