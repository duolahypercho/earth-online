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

const times = [5, 7, 12, 17, 19.5, 22];
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
  await page.evaluate(() => window.__SF_SIM__.setRoamPose({ x: 28, z: 0 }));
  await page.waitForTimeout(1800);

  for (const hour of times) {
    await page.evaluate((value) => window.__SF_SIM__.setTimeOfDay(value), hour);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `.qa-time-${String(hour).replace('.', '-')}.png` });
  }
  const state = await page.evaluate(() => ({
    clock: window.__SF_SIM__.timeOfDay,
    life: window.__SF_SIM__.lifeSim.getState(),
  }));
  console.log(JSON.stringify({ times, state, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'time capture failed', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
