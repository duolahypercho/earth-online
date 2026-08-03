/**
 * Probe on-road camera candidates for Financial District 4:0.
 * Frames tower canyon / Transamerica pyramid / Battery street identity.
 */
import { chromium } from 'playwright';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:4173/';
const outputDir = join(projectRoot, 'sessions/captures/pass15-probe');
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';

const SECTOR_KEY = '4:0';
const CX = 1536;
const CZ = 0;
const ROAD_LINES = [-192, -124, -52, 16, 82, 142, 192];
// Authored landmark + canyon cues (local coords)
const PYRAMID = { lx: 64, lz: 92 };
const CANYON = { lx: 0, lz: 36 };
const CORE_TRANSAMERICA = { x: 18, z: 58 }; // core world — visible from west FiDi

function buildCandidates() {
  const candidates = [];
  const lookTargets = [
    { label: 'pyramid', ...PYRAMID },
    { label: 'canyon', ...CANYON },
    { label: 'pyramid-canyon', lx: 32, lz: 64 },
    { label: 'core-trans', lx: null, lz: null, world: CORE_TRANSAMERICA },
  ];

  for (const lx of ROAD_LINES) {
    for (const lz of ROAD_LINES) {
      for (const target of lookTargets) {
        const lookAt = target.world
          ? { x: target.world.x, z: target.world.z }
          : { x: CX + target.lx, z: CZ + target.lz };
        candidates.push({
          label: `grid-${lx}:${lz}-look-${target.label}`,
          camera: { x: CX + lx, z: CZ + lz },
          lookAt,
        });
      }
    }
  }

  // Battery Street (local x≈0) southbound canyon approaches
  for (const lz of [142, 82, 16, -52, -124]) {
    for (const camLz of [192, 142, 82]) {
      if (camLz <= lz) continue;
      candidates.push({
        label: `battery-s-${camLz}-to-${lz}`,
        camera: { x: CX, z: CZ + camLz },
        lookAt: { x: CX + 32, z: CZ + lz },
      });
      candidates.push({
        label: `battery-pyramid-${camLz}`,
        camera: { x: CX, z: CZ + camLz },
        lookAt: { x: CX + PYRAMID.lx, z: CZ + PYRAMID.lz },
      });
    }
  }

  // West-side approach framing pyramid + canyon walls
  for (const lx of [-52, -124]) {
    for (const lz of [82, 16, -52]) {
      candidates.push({
        label: `west-${lx}-${lz}`,
        camera: { x: CX + lx, z: CZ + lz },
        lookAt: { x: CX + PYRAMID.lx, z: CZ + PYRAMID.lz },
      });
    }
  }

  // Current evidence stop baseline
  candidates.push({
    label: 'current-evidence-stop',
    camera: { x: 1536, z: 96 },
    lookAt: { x: 1536, z: 32 },
  });

  return candidates;
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

  await page.evaluate((pos) => window.__SF_SIM__.setRoamPose(pos), { x: CX, z: CZ });
  await page.waitForFunction(
    (key) => {
      const stats = window.__SF_SIM__?.streaming?.stats;
      return stats?.focusSector === key && stats.populationPendingDetailed === 0;
    },
    SECTOR_KEY,
    { timeout: 35000 },
  );
  await page.waitForTimeout(2000);

  const candidates = buildCandidates();
  const scored = [];

  for (const candidate of candidates) {
    const result = await page.evaluate(({ camera, lookAt }) => {
      const sim = window.__SF_SIM__;
      const streaming = sim?.streaming;
      const camSurface = streaming?.getSurfaceHeight?.(camera);
      const lookSurface = streaming?.getSurfaceHeight?.(lookAt);
      const publicRealm = streaming?.getPublicRealmPoint?.(camera);
      const CLEARANCE = 1.75;
      const LOOK_H = 1.65;
      if (!Number.isFinite(camSurface) || !Number.isFinite(lookSurface)) {
        return { ok: false, reason: 'no-surface', camSurface, lookSurface };
      }
      const camPos = { x: camera.x, y: camSurface + CLEARANCE, z: camera.z };
      const lookPos = { x: lookAt.x, y: lookSurface + LOOK_H, z: lookAt.z };
      let validation = null;
      try {
        validation = streaming?.validateDetailedView?.(camPos, lookPos);
      } catch (e) {
        validation = { error: e.message };
      }
      const dx = lookAt.x - camera.x;
      const dz = lookAt.z - camera.z;
      const dist = Math.hypot(dx, dz);
      return {
        ok: true,
        camSurface,
        lookSurface,
        camY: camPos.y,
        publicRealm,
        validation,
        lookDist: dist,
      };
    }, candidate);

    const v = result.validation;
    const pass = result.ok
      && result.publicRealm?.onRoad
      && result.camSurface > -10
      && v?.cameraOnRoad !== false
      && v?.buildingClearance >= 3
      && !v?.forwardHitMassing;

    // Prefer views looking toward pyramid (1600, 92) with good clearance
    const pyramidDx = candidate.lookAt.x - 1600;
    const pyramidDz = candidate.lookAt.z - 92;
    const targetsPyramid = Math.hypot(pyramidDx, pyramidDz) < 80;
    const canyonAligned = Math.abs(candidate.camera.x - 1536) < 40;

    scored.push({
      ...candidate,
      ...result,
      pass,
      score: pass
        ? (targetsPyramid ? 8 : 0)
          + (canyonAligned ? 4 : 0)
          + (v?.buildingClearance ?? 0) * 0.15
          + Math.min(result.lookDist ?? 0, 120) * 0.02
          + (result.publicRealm?.atIntersection ? 1 : 2)
        : -999,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const topPassing = scored.filter((s) => s.pass).slice(0, 12);

  for (const candidate of topPassing.slice(0, 8)) {
    await page.evaluate(({ camera, lookAt, camSurface, lookSurface }) => {
      const CLEARANCE = 1.75;
      const LOOK_H = 1.65;
      window.__SF_SIM__.setCameraPose(
        { x: camera.x, y: camSurface + CLEARANCE, z: camera.z },
        { x: lookAt.x, y: lookSurface + LOOK_H, z: lookAt.z },
      );
    }, candidate);
    await page.waitForTimeout(1500);
    const file = join(outputDir, `${candidate.label}.png`);
    await page.screenshot({ path: file });
    candidate.screenshot = file;
  }

  await writeFile(
    join(outputDir, 'probe-results.json'),
    JSON.stringify({ sectorKey: SECTOR_KEY, topPassing, allPassCount: scored.filter((s) => s.pass).length }, null, 2),
  );
  console.log(JSON.stringify(topPassing.slice(0, 8), null, 2));
} finally {
  await browser.close();
}
