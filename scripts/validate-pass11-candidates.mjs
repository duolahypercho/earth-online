/**
 * Validate and screenshot top pass11 camera candidates.
 */
import { chromium } from 'playwright';
import { access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:4173/';
const outputDir = join(projectRoot, 'sessions/captures/pass11-probe');
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';

const candidates = [
  {
    sectorKey: '0:4',
    label: 'ph-north-cal-st',
    camera: { x: 96, z: 1668 },
    lookAt: { x: -28, z: 1608 },
  },
  {
    sectorKey: '0:4',
    label: 'ph-north-east-grid',
    camera: { x: 132, z: 1668 },
    lookAt: { x: -28, z: 1608 },
  },
  {
    sectorKey: '0:4',
    label: 'ph-north-west-grid',
    camera: { x: -8, z: 1668 },
    lookAt: { x: -28, z: 1608 },
  },
  {
    sectorKey: '0:4',
    label: 'ph-east-cal-st',
    camera: { x: 192, z: 1528 },
    lookAt: { x: -28, z: 1608 },
  },
  {
    sectorKey: '-4:1',
    label: 'presidio-park-edge',
    camera: { x: -1404, z: 516 },
    lookAt: { x: -1542, z: 462 },
  },
  {
    sectorKey: '-4:1',
    label: 'presidio-gate-approach',
    camera: { x: -1374, z: 516 },
    lookAt: { x: -1542, z: 462 },
  },
  {
    sectorKey: '-4:1',
    label: 'presidio-ns-mid',
    camera: { x: -1476, z: 546 },
    lookAt: { x: -1542, z: 462 },
  },
  {
    sectorKey: '-4:1',
    label: 'presidio-gate-south',
    camera: { x: -1404, z: 444 },
    lookAt: { x: -1542, z: 462 },
  },
];

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
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
  for (const candidate of candidates) {
    const roam = candidate.sectorKey === '0:4' ? { x: 0, z: 1536 } : { x: -1536, z: 384 };
    await page.evaluate((pos) => window.__SF_SIM__.setRoamPose(pos), roam);
    await page.waitForFunction(
      (key) => {
        const stats = window.__SF_SIM__?.streaming?.stats;
        return stats?.focusSector === key && stats.populationPendingDetailed === 0;
      },
      candidate.sectorKey,
      { timeout: 35000 },
    );
    await page.waitForTimeout(2000);

    const metrics = await page.evaluate(({ camera, lookAt }) => {
      const streaming = window.__SF_SIM__?.streaming;
      const camSurface = streaming?.getSurfaceHeight?.(camera);
      const lookSurface = streaming?.getSurfaceHeight?.(lookAt);
      const publicRealm = streaming?.getPublicRealmPoint?.(camera);
      const CLEARANCE = 1.75;
      const LOOK_H = 1.65;
      const camPos = { x: camera.x, y: camSurface + CLEARANCE, z: camera.z };
      const lookPos = { x: lookAt.x, y: lookSurface + LOOK_H, z: lookAt.z };
      const validation = streaming?.validateDetailedView?.(camPos, lookPos);
      return { camSurface, lookSurface, camY: camPos.y, publicRealm, validation };
    }, candidate);

    await page.evaluate(({ camera, lookAt, camSurface, lookSurface }) => {
      window.__SF_SIM__.setCameraPose(
        { x: camera.x, y: camSurface + 1.75, z: camera.z },
        { x: lookAt.x, y: lookSurface + 1.65, z: lookAt.z },
      );
    }, { ...candidate, ...metrics });
    await page.waitForTimeout(1800);
    const file = join(outputDir, `final-${candidate.sectorKey.replace(':', '_')}-${candidate.label}.png`);
    await page.screenshot({ path: file });
    report.push({ ...candidate, ...metrics, file });
    console.log(JSON.stringify({ label: candidate.label, ...metrics, file }, null, 2));
  }
} finally {
  await browser.close();
}
