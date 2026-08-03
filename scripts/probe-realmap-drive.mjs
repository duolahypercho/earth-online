/**
 * Drive Full City along a path and report FPS / near three-roads stats.
 * Usage: node scripts/probe-realmap-drive.mjs
 */
import { chromium } from 'playwright';
import { access } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/realmap.html?play=1';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);

const route = [
  { id: 'spawn', x: 892, z: 377 },
  { id: 'market-east', x: 1200, z: 200 },
  { id: 'financial', x: 1600, z: 400 },
  { id: 'north', x: 1400, z: 1200 },
  { id: 'mission', x: -800, z: -600 },
  { id: 'sunset', x: -2400, z: -1200 },
  { id: 'presidio', x: -1600, z: 1400 },
  { id: 'back-spawn', x: 892, z: 377 },
];

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message || error)));

const t0 = Date.now();
await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__SF_REALMAP__, { timeout: 60000 });
while (Date.now() - t0 < 240000) {
  const ready = await page.evaluate(() => {
    const cov = window.__SF_REALMAP__?.getCoverage?.();
    const overlay = document.getElementById('build-overlay')
      || document.querySelector('[data-build-overlay], .build-overlay');
    const overlayHidden = !overlay || overlay.hidden
      || getComputedStyle(overlay).display === 'none';
    return Boolean(cov?.cityWideReady && overlayHidden);
  });
  if (ready) break;
  await page.waitForTimeout(1500);
}

await page.evaluate(() => {
  window.__SF_REALMAP__?.setCityMode?.('orbit');
  window.__SF_REALMAP__?.setBeauty?.(false);
  window.__SF_REALMAP__?.setTimeOfDay?.('day');
});

const samples = [];
for (const stop of route) {
  await page.evaluate((pose) => {
    const lab = window.__SF_REALMAP__;
    lab.setStreamFocus?.({ x: pose.x, z: pose.z });
    lab.setPlayerPose?.({ x: pose.x, z: pose.z });
    lab.setCameraPose?.({
      elevationAware: true,
      position: [pose.x - 24, 8, pose.z - 30],
      target: [pose.x + 20, 1, pose.z + 24],
    });
  }, stop);
  await page.waitForTimeout(2800);
  const sample = await page.evaluate((id) => {
    const cov = window.__SF_REALMAP__.getCoverage?.() || {};
    return {
      id,
      fps: cov.fps ?? null,
      avgFrameMs: cov.avgFrameMs ?? null,
      nearThreeRoads: cov.nearThreeRoads ?? null,
      nearThreeRoadsChunks: cov.nearThreeRoadsChunks ?? null,
      nearThreeRoadsJunctions: cov.nearThreeRoadsJunctions ?? null,
      roadGroupChildren: cov.roadGroupChildren ?? null,
      sidewalkCorners: cov.sidewalkCorners ?? null,
    };
  }, stop.id);
  samples.push(sample);
  console.log(JSON.stringify(sample));
}

const fpsValues = samples.map((s) => s.fps).filter((n) => Number.isFinite(n));
const minFps = fpsValues.length ? Math.min(...fpsValues) : null;
const avgFps = fpsValues.length
  ? Math.round((fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length) * 10) / 10
  : null;

const report = {
  ok: minFps != null && minFps >= 40 && errors.length === 0,
  minFps,
  avgFps,
  errors: errors.slice(0, 8),
  samples,
};
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(report.ok ? 0 : 1);
