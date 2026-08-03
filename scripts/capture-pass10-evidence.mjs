/**
 * Pass 10 / 10b evidence pack — elevation-aware, evidence-stop based.
 * Fixes critic pass10 FAIL: void/wall-clip district cameras.
 */
import { chromium } from 'playwright';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:4173/';
const outputDir = process.env.SF_QA_VISUAL_DIR
  || join(projectRoot, 'sessions/captures/pass10');
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'swiftshader';
const onlyShotId = process.env.SF_QA_ONLY || '';

const shots = [
  {
    id: 'core-hero-cable-hudless',
    roam: { x: 28, z: 0 },
    weather: 'clear',
    // Three-quarter east-side view; authored pose from pass11-cable-car.md.
    poseFromSurface: null,
    // Pass25: closer three-quarter so face cards + wardrobe resolve for A/B.
    cablePose: {
      cam: { x: 31.2, z: 1.8 },
      look: { x: 28.2, z: 4.6 },
      camClearance: 1.55,
      lookHeight: 1.7,
    },
    settleMs: 8000,
  },
  {
    id: 'core-hero-cable-hud',
    roam: { x: 28, z: 0 },
    weather: 'clear',
    poseFromSurface: null,
    cablePose: {
      cam: { x: 31.2, z: 1.8 },
      look: { x: 28.2, z: 4.6 },
      camClearance: 1.55,
      lookHeight: 1.7,
    },
    beauty: false,
    settleMs: 1500,
  },
  {
    id: 'embarcadero-clear',
    roam: { x: 28, z: 0 },
    weather: 'clear',
    // Pass18: Ferry clock hero — elevated to clear foreground mast/beam.
    poseFromSurface: (y) => ({
      position: { x: 42, y: y + 11.5, z: 64 },
      lookAt: { x: -8, y: y + 16, z: 104 },
    }),
  },
  {
    id: 'embarcadero-fog',
    roam: { x: 28, z: 0 },
    weather: 'fog',
    poseFromSurface: (y) => ({
      position: { x: 42, y: y + 11.5, z: 64 },
      lookAt: { x: -8, y: y + 16, z: 104 },
    }),
  },
  {
    id: 'embarcadero-drizzle',
    roam: { x: 28, z: 0 },
    weather: 'drizzle',
    poseFromSurface: (y) => ({
      position: { x: 42, y: y + 11.5, z: 64 },
      lookAt: { x: -8, y: y + 16, z: 104 },
    }),
  },
  // Built-in surface-resolved evidence stops (authoritative street clearance).
  { id: 'civic-center', evidenceStop: '1:0' },
  { id: 'financial', evidenceStop: '4:0' },
  { id: 'pacific-heights', evidenceStop: '0:4' },
  {
    id: 'pacific-heights-villa',
    roam: { x: 0, z: 1536 },
    key: '0:4',
    poseAt: { x: -18, z: 1608 },
  },
  { id: 'north-beach', evidenceStop: '4:4' },
  { id: 'presidio', evidenceStop: '-4:1' },
];

async function forceInWorldBeauty(page, beauty = true) {
  await page.evaluate((wantBeauty) => {
    const sim = window.__SF_SIM__;
    if (sim?.isDriving?.()) sim.exitCar?.();
    document.querySelector('#boot-overlay')?.classList.add('is-dismissed');
    const boot = document.querySelector('#boot-overlay');
    if (boot) boot.style.display = 'none';
    const app = document.querySelector('#app');
    if (wantBeauty) app?.classList.add('is-beauty');
    else app?.classList.remove('is-beauty');
    const hud = document.querySelector('#hud-root');
    if (hud) hud.style.visibility = wantBeauty ? 'hidden' : '';
    if (sim?.playerAvatar) sim.playerAvatar.visible = !wantBeauty;
  }, beauty);
}

async function assertInWorld(page) {
  return page.evaluate(() => {
    const boot = document.querySelector('#boot-overlay');
    const dismissed = boot?.classList.contains('is-dismissed');
    return {
      ok: !!window.__SF_SIM__ && dismissed,
      focus: window.__SF_SIM__?.streaming?.stats?.focusSector ?? null,
      pending: window.__SF_SIM__?.streaming?.stats?.populationPendingDetailed ?? null,
      driving: window.__SF_SIM__?.isDriving?.() === true,
      camY: window.__SF_SIM__?.camera?.position?.y ?? null,
    };
  });
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
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await mkdir(outputDir, { recursive: true });
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
    { timeout: 60000 },
  );
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__SF_SIM__?.setRenderQuality?.('cinematic');
    if (window.__SF_SIM__?.isDriving?.()) window.__SF_SIM__.exitCar?.();
  });

  const manifest = [];
  const activeShots = onlyShotId
    ? shots.filter((shot) => shot.id === onlyShotId)
    : shots;
  for (const shot of activeShots) {
    if (shot.evidenceStop) {
      await page.evaluate((selector) => {
        window.__SF_SIM__.setStreamingEvidenceStop(selector);
      }, shot.evidenceStop);
      await page.waitForFunction(
        (key) => {
          const stats = window.__SF_SIM__?.streaming?.stats;
          return stats?.focusSector === key && stats.populationPendingDetailed === 0;
        },
        shot.evidenceStop,
        { timeout: 30000 },
      ).catch(() => {});
      await page.waitForTimeout(1800);
    } else {
      if (shot.roam) {
        await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), shot.roam);
      }
      if (shot.key) {
        await page.waitForFunction(
          (key) => {
            const stats = window.__SF_SIM__?.streaming?.stats;
            return stats?.focusSector === key && stats.populationPendingDetailed === 0;
          },
          shot.key,
          { timeout: 30000 },
        ).catch(() => {});
      }
      if (shot.weather) {
        await page.evaluate((mode) => window.__SF_SIM__.setWeather(mode), shot.weather);
        await page.waitForTimeout(1600);
      }
      await page.evaluate((spec) => {
        const sim = window.__SF_SIM__;
        const streaming = sim?.streaming;
        const coreStreetHeight = (x, z) => 0.022 * x + 0.042 * z;
        const surfaceAt = (point) => {
          const sampled = streaming?.getSurfaceHeight?.(point);
          if (Number.isFinite(sampled) && Math.abs(sampled) > 0.05) return sampled;
          return coreStreetHeight(point.x, point.z);
        };
        const cablePoseFrom = (cfg) => ({
          position: {
            x: cfg.cam.x,
            y: surfaceAt(cfg.cam) + cfg.camClearance,
            z: cfg.cam.z,
          },
          lookAt: {
            x: cfg.look.x,
            y: surfaceAt(cfg.look) + cfg.lookHeight,
            z: cfg.look.z,
          },
        });
        if (spec.cablePose) {
          sim.setCameraPose(
            cablePoseFrom(spec.cablePose).position,
            cablePoseFrom(spec.cablePose).lookAt,
          );
          return;
        }
        const anchor = spec.poseAt || spec.roam || { x: 0, z: 0 };
        const y = surfaceAt(anchor);
        // poseFromSurface is serialized as null; rebuild locally from known ids
        const builders = {
          'embarcadero-clear': (sy) => ({
            position: { x: 42, y: sy + 11.5, z: 64 },
            lookAt: { x: -8, y: sy + 16, z: 104 },
          }),
          'embarcadero-fog': (sy) => ({
            position: { x: 42, y: sy + 11.5, z: 64 },
            lookAt: { x: -8, y: sy + 16, z: 104 },
          }),
          'embarcadero-drizzle': (sy) => ({
            position: { x: 42, y: sy + 11.5, z: 64 },
            lookAt: { x: -8, y: sy + 16, z: 104 },
          }),
          'pacific-heights': (sy) => ({
            position: { x: -36, y: sy + 7, z: 1496 },
            lookAt: { x: 20, y: sy + 5, z: 1580 },
          }),
          'pacific-heights-villa': (sy) => ({
            position: { x: -10, y: sy + 10, z: 1520 },
            lookAt: { x: -28, y: sy + 12, z: 1608 },
          }),
          'north-beach': (sy) => ({
            position: { x: 1540, y: sy + 6, z: 1488 },
            lookAt: { x: 1620, y: sy + 8, z: 1588 },
          }),
          'presidio': (sy) => ({
            position: { x: -1636, y: sy + 6, z: 350 },
            lookAt: { x: -1560, y: sy + 4, z: 450 },
          }),
        };
        const pose = (builders[spec.id] || builders['pacific-heights'])(y);
        sim.setCameraPose(pose.position, pose.lookAt);
      }, {
        id: shot.id,
        roam: shot.roam || null,
        poseAt: shot.poseAt || null,
        cablePose: shot.cablePose || null,
      });
      await page.waitForTimeout(shot.settleMs || 1400);
    }

    await forceInWorldBeauty(page, shot.beauty !== false);
    await page.waitForTimeout(250);
    if ((await assertInWorld(page)).driving) {
      await page.evaluate(() => window.__SF_SIM__?.exitCar?.());
      await page.waitForTimeout(200);
    }
    const file = join(outputDir, `${shot.id}.png`);
    await page.screenshot({ path: file });
    const finalGate = await assertInWorld(page);
    manifest.push({
      id: shot.id,
      file,
      ...finalGate,
      weather: shot.weather || 'clear',
      evidenceStop: shot.evidenceStop || null,
    });
    await page.evaluate(() => window.__SF_SIM__.setCameraPose());
  }

  const reportPath = join(outputDir, 'manifest.json');
  await writeFile(reportPath, `${JSON.stringify({ outputDir, baseUrl, manifest, errors: errors.slice(0, 12) }, null, 2)}\n`);
  console.log(JSON.stringify({ result: 'pass10b evidence complete', count: manifest.length, reportPath }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    result: 'pass10b evidence failed',
    error: String(error?.message || error),
    errors: errors.slice(0, 12),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
