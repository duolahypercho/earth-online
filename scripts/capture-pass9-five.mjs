import { chromium } from 'playwright';
import { access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const outputDir = join(projectRoot, 'sessions/captures/pass9');
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);

const stops = [
  {
    id: 'civic-soma', key: '1:0', district: 'Civic Center', x: 256, z: -59,
    cameraPose: { position: { x: 288, y: 8, z: -64 }, lookAt: { x: 352, y: 6, z: -64 } },
  },
  {
    id: 'financial', key: '4:0', district: 'Financial District', x: 1600, z: 0,
    cameraPose: { position: { x: 1520, y: 36, z: 140 }, lookAt: { x: 1600, y: 22, z: 20 } },
  },
  {
    id: 'pacific-heights', key: '0:4', district: 'Pacific Heights', x: 0, z: 1536,
    cameraPose: { position: { x: -40, y: 18, z: 1488 }, lookAt: { x: 12, y: 12, z: 1576 } },
    landmarkPose: { position: { x: -8, y: 18, z: 1508 }, lookAt: { x: -28, y: 16, z: 1608 } },
  },
  {
    id: 'north-beach', key: '4:4', district: 'North Beach', x: 1600, z: 1536,
    cameraPose: { position: { x: 1520, y: 22, z: 1460 }, lookAt: { x: 1608, y: 18, z: 1588 } },
    landmarkPose: { position: { x: 1528, y: 24, z: 1448 }, lookAt: { x: 1600, y: 28, z: 1600 } },
  },
  {
    id: 'presidio', key: '-4:1', district: 'Presidio', x: -1600, z: 384,
    cameraPose: { position: { x: -1640, y: -28, z: 340 }, lookAt: { x: -1560, y: -34, z: 450 } },
    landmarkPose: { position: { x: -1632, y: -28, z: 360 }, lookAt: { x: -1564, y: -34, z: 460 } },
  },
];

async function ensureBeautyMode(page) {
  await page.locator('#scene-canvas').click({ position: { x: 640, y: 360 } });
  await page.waitForTimeout(80);
  const isBeauty = await page.evaluate(() => document.querySelector('#app')?.classList.contains('is-beauty'));
  if (!isBeauty) {
    await page.keyboard.press('h');
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

try {
  await mkdir(outputDir, { recursive: true });
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    { timeout: 120000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 20000 },
  );
  await page.waitForTimeout(2000);

  for (const stop of stops) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), stop);
    await page.waitForFunction(
      (key) => window.__SF_SIM__?.streaming?.stats?.focusSector === key
        && window.__SF_SIM__?.streaming?.stats?.populationPendingDetailed === 0,
      stop.key,
      { timeout: 20000 },
    );
    await page.waitForTimeout(1500);
    if (stop.cameraPose) {
      await page.evaluate((pose) => {
        window.__SF_SIM__.setCameraPose(pose.position, pose.lookAt);
      }, stop.cameraPose);
      await page.waitForTimeout(700);
    }
    await ensureBeautyMode(page);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(outputDir, `${stop.id}.png`) });
    if (stop.landmarkPose) {
      await page.evaluate((pose) => {
        window.__SF_SIM__.setCameraPose(pose.position, pose.lookAt);
      }, stop.landmarkPose);
      await page.waitForTimeout(900);
      await ensureBeautyMode(page);
      await page.screenshot({ path: join(outputDir, `${stop.id}-landmark.png`) });
    }
    await page.evaluate(() => window.__SF_SIM__.setCameraPose());
  }
  console.log(JSON.stringify({ result: 'pass9 five-district capture complete', outputDir }, null, 2));
} finally {
  await browser.close();
}
