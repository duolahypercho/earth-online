/**
 * Probe candidate camera poses for pass10 district roams.
 * Writes test PNGs to sessions/captures/pass10-probe/
 */
import { chromium } from 'playwright';
import { access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:4173/';
const outputDir = join(projectRoot, 'sessions/captures/pass10-probe');
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';

const districts = [
  {
    id: 'civic-center',
    key: '1:0',
    roam: { x: 256, z: -59 },
    candidates: [
      {
        label: 'pass9-street',
        position: { x: 288, y: 8, z: -64 },
        lookAt: { x: 352, y: 6, z: -64 },
      },
      {
        label: 'plaza-approach',
        position: { x: 300, y: 7, z: -88 },
        lookAt: { x: 348, y: 8, z: -56 },
      },
      {
        label: 'market-west',
        position: { x: 260, y: 9, z: -72 },
        lookAt: { x: 340, y: 10, z: -48 },
      },
    ],
  },
  {
    id: 'financial',
    key: '4:0',
    roam: { x: 1600, z: 0 },
    candidates: [
      {
        label: 'pass9-elevated',
        position: { x: 1520, y: 36, z: 140 },
        lookAt: { x: 1600, y: 22, z: 20 },
      },
      {
        label: 'canyon-street-s',
        position: { x: 1508, y: 8, z: 110 },
        lookAt: { x: 1536, y: 12, z: 24 },
      },
      {
        label: 'canyon-mid',
        position: { x: 1520, y: 10, z: 72 },
        lookAt: { x: 1536, y: 18, z: 8 },
      },
      {
        label: 'canyon-eye',
        position: { x: 1496, y: 6.5, z: 56 },
        lookAt: { x: 1536, y: 14, z: 28 },
      },
      {
        label: 'plaza-south',
        position: { x: 1512, y: 7, z: 48 },
        lookAt: { x: 1536, y: 16, z: 36 },
      },
    ],
  },
  {
    id: 'north-beach',
    key: '4:4',
    roam: { x: 1600, z: 1536 },
    candidates: [
      {
        label: 'pass9-roam',
        position: { x: 1520, y: 22, z: 1460 },
        lookAt: { x: 1608, y: 18, z: 1588 },
      },
      {
        label: 'pass9-landmark',
        position: { x: 1528, y: 24, z: 1448 },
        lookAt: { x: 1600, y: 28, z: 1600 },
      },
      {
        label: 'cafe-street',
        position: { x: 1548, y: 8, z: 1496 },
        lookAt: { x: 1578, y: 10, z: 1508 },
      },
      {
        label: 'columbus-s',
        position: { x: 1512, y: 7, z: 1500 },
        lookAt: { x: 1578, y: 12, z: 1536 },
      },
      {
        label: 'coit-approach',
        position: { x: 1540, y: 9, z: 1510 },
        lookAt: { x: 1600, y: 24, z: 1588 },
      },
    ],
  },
];

async function waitSectorReady(page, key) {
  await page.waitForFunction(
    (sectorKey) => {
      const stats = window.__SF_SIM__?.streaming?.stats;
      return stats?.focusSector === sectorKey
        && stats.populationPendingDetailed === 0
        && stats.populationPendingProxy === 0;
    },
    key,
    { timeout: 35000 },
  );
}

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

try {
  await mkdir(outputDir, { recursive: true });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled
      && document.querySelector('#boot-overlay')?.classList.contains('is-ready'),
    { timeout: 120000 },
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
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__SF_SIM__?.setRenderQuality?.('cinematic');
    document.querySelector('#app')?.classList.add('is-beauty');
  });

  const report = [];
  for (const district of districts) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), district.roam);
    try {
      await waitSectorReady(page, district.key);
    } catch {
      report.push({ district: district.id, error: 'sector not ready' });
    }
    await page.waitForTimeout(2000);
    const surface = await page.evaluate((roam) => {
      const sim = window.__SF_SIM__;
      const stats = sim?.streaming?.stats;
      const presentation = sim?.streaming?.getSectorPresentation?.(stats?.focusSector)?.presentation;
      return {
        focus: stats?.focusSector,
        pendingDetailed: stats?.populationPendingDetailed,
        pendingProxy: stats?.populationPendingProxy,
        buildingCount: presentation?.buildingCount ?? null,
        district: presentation?.district ?? null,
        landmark: presentation?.authoredOverlay?.landmark ?? null,
        roam,
      };
    }, district.roam);

    for (const candidate of district.candidates) {
      await page.evaluate((pose) => {
        window.__SF_SIM__.setCameraPose(pose.position, pose.lookAt);
      }, candidate);
      await page.waitForTimeout(1800);
      const file = join(outputDir, `${district.id}-${candidate.label}.png`);
      await page.screenshot({ path: file });
      report.push({
        district: district.id,
        label: candidate.label,
        file,
        ...surface,
        pose: candidate,
      });
    }
    await page.evaluate(() => window.__SF_SIM__.setCameraPose());
  }

  console.log(JSON.stringify({ outputDir, report }, null, 2));
} finally {
  await browser.close();
}
