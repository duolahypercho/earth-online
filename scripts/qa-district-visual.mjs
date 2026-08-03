import { chromium } from 'playwright';
import { access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const outputDir = process.env.SF_QA_VISUAL_DIR
  || join(projectRoot, 'sessions/captures/pass9');
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
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
    id: 'civic-soma',
    key: '1:0',
    district: 'Civic Center',
    x: 256,
    z: -59,
    cameraPose: {
      position: { x: 288, y: 8, z: -64 },
      lookAt: { x: 352, y: 6, z: -64 },
    },
  },
  {
    id: 'financial',
    key: '4:0',
    district: 'Financial District',
    x: 1600,
    z: 0,
    cameraPose: {
      position: { x: 1520, y: 36, z: 140 },
      lookAt: { x: 1600, y: 22, z: 20 },
    },
  },
  {
    id: 'pacific-heights',
    key: '0:4',
    district: 'Pacific Heights',
    x: 0,
    z: 1536,
    cameraPose: {
      position: { x: -40, y: 18, z: 1488 },
      lookAt: { x: 12, y: 12, z: 1576 },
    },
    landmarkPose: {
      // Stay above Pacific Heights surface (~+6); y:-8 clipped under the map.
      position: { x: -8, y: 18, z: 1508 },
      lookAt: { x: -28, y: 16, z: 1608 },
    },
  },
  {
    id: 'north-beach',
    key: '4:4',
    district: 'North Beach',
    x: 1600,
    z: 1536,
    cameraPose: {
      position: { x: 1520, y: 22, z: 1460 },
      lookAt: { x: 1608, y: 18, z: 1588 },
    },
    landmarkPose: {
      position: { x: 1528, y: 24, z: 1448 },
      lookAt: { x: 1600, y: 28, z: 1600 },
    },
  },
  {
    id: 'presidio',
    key: '-4:1',
    district: 'Presidio',
    x: -1600,
    z: 384,
    cameraPose: {
      position: { x: -1640, y: -28, z: 340 },
      lookAt: { x: -1560, y: -34, z: 450 },
    },
    landmarkPose: {
      position: { x: -1632, y: -28, z: 360 },
      lookAt: { x: -1564, y: -34, z: 460 },
    },
  },
  { id: 'mission', key: '-3:-2', district: 'Mission', x: -1152, z: -768 },
  {
    id: 'mission-bay',
    key: '4:-4',
    district: 'Mission Bay',
    x: 1600,
    z: -1536,
    waterfrontPose: {
      position: { x: 1554, y: 6, z: -1496 },
      lookAt: { x: 1592, y: 3, z: -1466 },
    },
  },
  {
    id: 'outer-sunset',
    key: '-5:-4',
    district: 'Outer Sunset',
    x: -1920,
    z: -1536,
    waterfrontPose: {
      // Frame Sutro, the Pacific shelf, and the surf bands as one readable
      // hero composition instead of aiming across the empty near beach.
      position: { x: -2024.2, y: -52.03, z: -1400 },
      lookAt: { x: -2077.2, y: -67.03, z: -1352 },
    },
    heroRoutePose: {
      // The close N-Judah view keeps the route plate, tram silhouette, track
      // throat, and Sutro/ocean horizon in the same frame for pixel review.
      position: { x: -1964, y: -61.46, z: -1461.3 },
      lookAt: { x: -1975, y: -69.46, z: -1435.3 },
    },
  },
  {
    id: 'chinatown',
    key: '3:3',
    district: 'Chinatown',
    x: 1152,
    z: 1152,
    landmarkPose: {
      position: { x: 1152, y: 18, z: 1000 },
      lookAt: { x: 1088, y: 10, z: 982 },
    },
  },
  {
    id: 'nob-hill',
    key: '2:3',
    district: 'Nob Hill',
    x: 768,
    z: 1152,
    landmarkPose: {
      position: { x: 720, y: 30, z: 1040 },
      lookAt: { x: 728, y: 18, z: 1132 },
    },
  },
  {
    id: 'russian-hill',
    key: '1:4',
    district: 'Russian Hill',
    x: 384,
    z: 1536,
    landmarkPose: {
      position: { x: 420, y: 28, z: 1640 },
      lookAt: { x: 464, y: 12, z: 1712 },
    },
  },
  {
    id: 'marina',
    key: '0:5',
    district: 'Marina',
    x: 0,
    z: 1920,
    landmarkPose: {
      position: { x: -40, y: 12, z: 1800 },
      lookAt: { x: -150, y: 10, z: 1940 },
    },
    waterfrontPose: {
      position: { x: 0, y: 8, z: 1860 },
      lookAt: { x: 0, y: 2, z: 2096 },
    },
  },
  {
    id: 'embarcadero',
    key: '3:0',
    district: 'Embarcadero',
    x: 1152,
    z: 0,
    landmarkPose: {
      position: { x: 1080, y: 24, z: -40 },
      lookAt: { x: 1192, y: 40, z: 90 },
    },
    waterfrontPose: {
      position: { x: 1240, y: 10, z: 20 },
      lookAt: { x: 1328, y: 4, z: 20 },
    },
  },
  {
    id: 'soma-design',
    key: '2:-1',
    district: 'SoMa',
    x: 768,
    z: -384,
    landmarkPose: {
      position: { x: 700, y: 18, z: -300 },
      lookAt: { x: 808, y: 16, z: -264 },
    },
  },
];

try {
  await mkdir(outputDir, { recursive: true });
  // Large atlas/GLB assets can keep the window "load" event pending under
  // headless GPU paths. DomContentLoaded + an explicit launch-ready wait is
  // the stable gate for visual capture.
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled
      && document.querySelector('#boot-overlay')?.classList.contains('is-ready'),
    { timeout: 60000 },
  );
  await page.locator('#launch-button').click({ force: true, timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 15000 },
  );
  await page.waitForTimeout(1200);

  const evidence = [];
  for (const stop of stops) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), stop);
    await page.waitForFunction(
      (key) => window.__SF_SIM__?.streaming?.stats?.focusSector === key,
      stop.key,
      { timeout: 12000 },
    );
    await page.waitForFunction(
      (key) => {
        const stats = window.__SF_SIM__?.streaming?.stats;
        return stats?.focusSector === key
          && stats.populationPendingDetailed === 0
          && stats.enterableBuildings > 0;
      },
      stop.key,
      { timeout: 12000 },
    );
    await page.waitForTimeout(1200);
    if (stop.cameraPose) {
      await page.evaluate((pose) => {
        window.__SF_SIM__.setCameraPose(pose.position, pose.lookAt);
      }, stop.cameraPose);
      await page.waitForTimeout(600);
    }
    await page.locator('#scene-canvas').click({ position: { x: 640, y: 360 } });
    await page.waitForTimeout(80);
    const beautyOn = await page.evaluate(() => document.querySelector('#app')?.classList.contains('is-beauty'));
    if (!beautyOn) {
      await page.keyboard.press('h');
    }
    await page.waitForTimeout(220);
    const file = join(outputDir, `${stop.id}.png`);
    await page.screenshot({ path: file });
    const beautyFile = join(outputDir, `${stop.id}-beauty.png`);
    await page.screenshot({ path: beautyFile });
    await page.evaluate(() => window.__SF_SIM__.setCameraPose());
    await page.waitForTimeout(100);
    let waterfrontFile = null;
    let waterfrontBeautyFile = null;
    let heroRouteFile = null;
    let heroRouteBeautyFile = null;
    let landmarkFile = null;
    if (stop.landmarkPose) {
      await page.evaluate((pose) => {
        window.__SF_SIM__.setCameraPose(pose.position, pose.lookAt);
      }, stop.landmarkPose);
      await page.waitForTimeout(900);
      await page.locator('#scene-canvas').click({ position: { x: 640, y: 360 } });
      await page.waitForTimeout(80);
      const landmarkBeautyOn = await page.evaluate(() => document.querySelector('#app')?.classList.contains('is-beauty'));
      if (!landmarkBeautyOn) {
        await page.keyboard.press('h');
      }
      await page.waitForTimeout(220);
      landmarkFile = join(outputDir, `${stop.id}-landmark.png`);
      await page.screenshot({ path: landmarkFile });
      await page.evaluate(() => window.__SF_SIM__.setCameraPose());
    }
    if (stop.waterfrontPose) {
      await page.evaluate((pose) => {
        window.__SF_SIM__.setCameraPose(pose.position, pose.lookAt);
      }, stop.waterfrontPose);
      await page.waitForTimeout(900);
      waterfrontFile = join(outputDir, `${stop.id}-waterfront.png`);
      await page.screenshot({ path: waterfrontFile });
      await page.keyboard.press('h');
      await page.waitForTimeout(220);
      waterfrontBeautyFile = join(outputDir, `${stop.id}-waterfront-beauty.png`);
      await page.screenshot({ path: waterfrontBeautyFile });
      await page.keyboard.press('h');
      await page.evaluate(() => window.__SF_SIM__.setCameraPose());
      await page.waitForTimeout(100);
    }
    if (stop.heroRoutePose) {
      await page.evaluate((pose) => {
        window.__SF_SIM__.setCameraPose(pose.position, pose.lookAt);
      }, stop.heroRoutePose);
      await page.waitForTimeout(900);
      heroRouteFile = join(outputDir, `${stop.id}-hero-route.png`);
      await page.screenshot({ path: heroRouteFile });
      await page.keyboard.press('h');
      await page.waitForTimeout(220);
      heroRouteBeautyFile = join(outputDir, `${stop.id}-hero-route-beauty.png`);
      await page.screenshot({ path: heroRouteBeautyFile });
      await page.keyboard.press('h');
      await page.evaluate(() => window.__SF_SIM__.setCameraPose());
      await page.waitForTimeout(100);
    }
    const state = await page.evaluate((filePath) => {
      const sim = window.__SF_SIM__;
      const stats = sim.streaming.getStats();
      const presentation = sim.streaming.getSectorPresentation(stats.focusSector)?.presentation || null;
      return {
        focusSector: stats.focusSector,
        district: presentation?.district || null,
        landmark: presentation?.authoredOverlay?.landmark || null,
        waterfront: presentation?.waterfront || null,
        buildingCount: presentation?.buildingCount || 0,
        streetSignatureProps: presentation?.streetSignaturePropCount || 0,
        routeCue: presentation?.heroRouteCue || null,
        pendingDetailed: stats.populationPendingDetailed,
        pendingProxy: stats.populationPendingProxy,
        file: filePath,
        beautyFile: null,
        landmarkFile: null,
        waterfrontFile: null,
        waterfrontBeautyFile: null,
        heroRouteFile: null,
        heroRouteBeautyFile: null,
      };
    }, file);
    state.beautyFile = beautyFile;
    state.landmarkFile = landmarkFile;
    state.waterfrontFile = waterfrontFile;
    state.waterfrontBeautyFile = waterfrontBeautyFile;
    state.heroRouteFile = heroRouteFile;
    state.heroRouteBeautyFile = heroRouteBeautyFile;
    if (state.focusSector !== stop.key) {
      errors.push(`${stop.id}: visual evidence focus was ${state.focusSector}, expected ${stop.key}`);
    }
    if (state.district !== stop.district) {
      errors.push(`${stop.id}: visual evidence district was ${state.district}, expected ${stop.district}`);
    }
    if (state.pendingDetailed !== 0 || state.buildingCount <= 0) {
      errors.push(`${stop.id}: visual evidence was captured before detail population completed`);
    }
    evidence.push(state);
  }

  console.log(JSON.stringify({ result: errors.length ? 'district visual capture failed' : 'district visual capture passed', angle, outputDir, evidence, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ result: 'district visual capture failed', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
