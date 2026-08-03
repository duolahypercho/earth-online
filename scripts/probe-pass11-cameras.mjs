/**
 * Probe candidate evidence-stop camera XZ for Pacific Heights (0:4) and Presidio (-4:1).
 * Scores each candidate via getSurfaceHeight, getPublicRealmPoint, validateDetailedView.
 */
import { chromium } from 'playwright';
import { access, mkdir, writeFile } from 'node:fs/promises';
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

const SECTOR_SIZE = 384;

// Sector centers
const SECTORS = {
  '0:4': { cx: 0, cz: 1536, landmark: { lx: -28, lz: 72 } },
  '-4:1': { cx: -1536, cz: 384, landmark: { lx: -6, lz: 78 } },
};

// Road grid lines from sf-expansion blueprints (local coords)
const ROAD_LINES = {
  '0:4': [-192, -136, -72, -8, 60, 132, 192],
  '-4:1': [-192, -144, -80, -12, 60, 132, 192],
};

// California Street diagonal for 0:4
const DIAGONAL_0_4 = { start: [-192, -156], end: [192, 128] };

function buildCandidates(sectorKey) {
  const { cx, cz, landmark } = SECTORS[sectorKey];
  const lines = ROAD_LINES[sectorKey];
  const candidates = [];

  // Grid intersections and midpoints on E-W and N-S roads
  for (const lx of lines) {
    for (const lz of lines) {
      candidates.push({
        label: `grid-${lx}:${lz}`,
        camera: { x: cx + lx, z: cz + lz },
        lookAt: { x: cx + landmark.lx, z: cz + landmark.lz },
      });
    }
  }

  // Midpoints along each road line
  for (let i = 0; i < lines.length - 1; i += 1) {
    const midLx = (lines[i] + lines[i + 1]) / 2;
    for (const lz of [-8, 60, 132]) {
      candidates.push({
        label: `ew-mid-${midLx}:${lz}`,
        camera: { x: cx + midLx, z: cz + lz },
        lookAt: { x: cx + landmark.lx, z: cz + landmark.lz },
      });
    }
    const midLz = (lines[i] + lines[i + 1]) / 2;
    for (const lx of [-72, -8, 60]) {
      candidates.push({
        label: `ns-mid-${lx}:${midLz}`,
        camera: { x: cx + lx, z: cz + midLz },
        lookAt: { x: cx + landmark.lx, z: cz + landmark.lz },
      });
    }
  }

  // Diagonal California Street samples for 0:4
  if (sectorKey === '0:4') {
    const { start, end } = DIAGONAL_0_4;
    for (let t = 0.1; t <= 0.9; t += 0.1) {
      const lx = start[0] + (end[0] - start[0]) * t;
      const lz = start[1] + (end[1] - start[1]) * t;
      candidates.push({
        label: `cal-st-${Math.round(t * 100)}`,
        camera: { x: cx + lx, z: cz + lz },
        lookAt: { x: cx + landmark.lx, z: cz + landmark.lz },
      });
    }
  }

  // Presidio: approach from park edge (east side of sector)
  if (sectorKey === '-4:1') {
    for (const lz of [60, 78, 96, 120]) {
      candidates.push({
        label: `park-edge-${lz}`,
        camera: { x: cx + 132, z: cz + lz },
        lookAt: { x: cx + landmark.lx, z: cz + landmark.lz },
      });
      candidates.push({
        label: `gate-approach-${lz}`,
        camera: { x: cx + 60, z: cz + lz },
        lookAt: { x: cx + landmark.lx, z: cz + landmark.lz },
      });
    }
  }

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

  const allResults = {};

  for (const sectorKey of ['0:4', '-4:1']) {
    const { cx, cz } = SECTORS[sectorKey];
    await page.evaluate((pos) => window.__SF_SIM__.setRoamPose(pos), { x: cx, z: cz });
    await page.waitForFunction(
      (key) => {
        const stats = window.__SF_SIM__?.streaming?.stats;
        return stats?.focusSector === key && stats.populationPendingDetailed === 0;
      },
      sectorKey,
      { timeout: 35000 },
    );
    await page.waitForTimeout(2000);

    const candidates = buildCandidates(sectorKey);
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
        return {
          ok: true,
          camSurface,
          lookSurface,
          camY: camPos.y,
          publicRealm,
          validation,
        };
      }, candidate);

      const v = result.validation;
      const pass = result.ok
        && result.publicRealm?.onRoad
        && result.camSurface > -10
        && v?.cameraOnRoad !== false
        && v?.buildingClearance >= 3
        && !v?.forwardHitMassing;

      scored.push({
        ...candidate,
        ...result,
        pass,
        score: pass
          ? (result.publicRealm?.atIntersection ? 2 : 1)
            + (v?.buildingClearance ?? 0) * 0.1
            + Math.min(result.camSurface, 30) * 0.05
          : -999,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    allResults[sectorKey] = scored;

    // Screenshot top 5 passing candidates
    const topPassing = scored.filter((s) => s.pass).slice(0, 5);
    for (const candidate of topPassing) {
      await page.evaluate(({ camera, lookAt, camSurface, lookSurface }) => {
        const CLEARANCE = 1.75;
        const LOOK_H = 1.65;
        window.__SF_SIM__.setCameraPose(
          { x: camera.x, y: camSurface + CLEARANCE, z: camera.z },
          { x: lookAt.x, y: lookSurface + LOOK_H, z: lookAt.z },
        );
      }, candidate);
      await page.waitForTimeout(1500);
      const file = join(outputDir, `${sectorKey.replace(':', '_')}-${candidate.label}.png`);
      await page.screenshot({ path: file });
      candidate.screenshot = file;
    }

    console.log(`\n=== ${sectorKey} top candidates ===`);
    console.log(JSON.stringify(scored.filter((s) => s.pass).slice(0, 8), null, 2));
    console.log(`\n=== ${sectorKey} current broken coords ===`);
    const current = sectorKey === '0:4'
      ? { camera: { x: -36, z: 1496 }, lookAt: { x: 20, z: 1580 } }
      : { camera: { x: -1636, z: 350 }, lookAt: { x: -1560, z: 450 } };
    const currentResult = await page.evaluate(({ camera, lookAt }) => {
      const streaming = window.__SF_SIM__?.streaming;
      const camSurface = streaming?.getSurfaceHeight?.(camera);
      const lookSurface = streaming?.getSurfaceHeight?.(lookAt);
      const publicRealm = streaming?.getPublicRealmPoint?.(camera);
      return { camSurface, lookSurface, publicRealm };
    }, current);
    console.log(JSON.stringify(currentResult, null, 2));
  }

  await writeFile(
    join(outputDir, 'probe-results.json'),
    JSON.stringify(allResults, null, 2),
  );
} finally {
  await browser.close();
}
