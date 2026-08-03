import { chromium } from 'playwright';
import { access } from 'node:fs/promises';

const configuredUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const baseUrl = configuredUrl.includes('?')
  ? `${configuredUrl}&sf-profile=1`
  : `${configuredUrl}?sf-profile=1`;
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';
const headless = process.env.SF_QA_HEADLESS !== 'false';
const browser = await chromium.launch({
  headless,
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
  { id: 'core', key: '0:0', x: 0, z: 0 },
  { id: 'civic-soma', key: '1:0', x: 384, z: 0 },
  { id: 'financial', key: '4:0', x: 1536, z: 0 },
  { id: 'north-beach', key: '4:4', x: 1536, z: 1536 },
  { id: 'pacific-heights', key: '0:4', x: 0, z: 1536 },
  { id: 'presidio', key: '-4:1', x: -1536, z: 384 },
  { id: 'mission', key: '-3:-2', x: -1152, z: -768 },
  { id: 'mission-bay', key: '4:-4', x: 1536, z: -1536 },
  { id: 'outer-sunset', key: '-5:-4', x: -1920, z: -1536 },
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
  await page.waitForTimeout(1000);

  const profiles = [];
  for (const stop of stops) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), stop);
    await page.evaluate(() => window.__SF_SIM__.resetFrameProfile());
    await page.evaluate(() => window.__SF_SIM__.streaming.resetFrameProfile());
    await page.waitForFunction(
      (key) => {
        const stats = window.__SF_SIM__?.streaming?.stats;
        return stats?.focusSector === key
          && stats.populationPendingDetailed === 0
          && (key === '0:0' || stats.enterableBuildings > 0);
      },
      stop.key,
      { timeout: 12000 },
    );
    await page.waitForTimeout(1000);
    profiles.push(await page.evaluate((id) => ({
      id,
      performance: window.__SF_SIM__.getPerformanceSnapshot(),
      profile: window.__SF_SIM__.getFrameProfile(),
      streamingProfile: window.__SF_SIM__.streaming.getFrameProfile(),
      streamingStats: window.__SF_SIM__.streaming.stats,
    }), stop.id));
  }

  console.log(JSON.stringify({ result: 'frame profile passed', angle, profiles, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ result: 'frame profile failed', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
