/**
 * Full City road planarity gate: sample road, sidewalk, and junction quads on
 * hills and fail when any quad is visibly twisted by per-corner terrain
 * sampling. Roads must follow the centerline grade as a flat cross-section.
 *
 * Usage: node scripts/verify-realmap-planarity.mjs
 */
import { chromium } from 'playwright';
import { access } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/realmap.html?play=1';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);

const probes = [
  { id: 'spawn', x: 892, z: 377 },
  { id: 'residential-hill', x: 500, z: -300 },
  { id: 'sunset-hill', x: -2400, z: -1200 },
];

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message || error)));

await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__SF_REALMAP__, null, { timeout: 60000 });
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  const ready = await page.evaluate(() => {
    const cov = window.__SF_REALMAP__?.getCoverage?.();
    const overlay = document.querySelector('#build-overlay');
    const hidden = !overlay || overlay.hidden || getComputedStyle(overlay).display === 'none';
    return Boolean(cov?.cityWideReady && hidden);
  });
  if (ready) break;
  await page.waitForTimeout(2000);
}

const samples = [];
for (const probe of probes) {
  const sample = await page.evaluate((point) => {
    const lab = window.__SF_REALMAP__;
    lab?.setStreamFocus?.({ x: point.x, z: point.z });
    return lab?.debugRoadWaviness?.(point, 220) || null;
  }, probe);
  samples.push({ ...probe, sample });
}

const passes = samples.every((entry) => (
  entry.sample
  && Number(entry.sample.maxRoadDeviation || 0) < 0.08
  && Number(entry.sample.maxSidewalkDeviation || 0) < 0.08
  && entry.sample.counts.roads > 0
  && entry.sample.counts.sidewalks > 0
));

const report = {
  ok: passes && errors.length === 0,
  maxRoadDeviation: Math.max(...samples.map((entry) => Number(entry.sample?.maxRoadDeviation || 0))),
  maxSidewalkDeviation: Math.max(...samples.map((entry) => Number(entry.sample?.maxSidewalkDeviation || 0))),
  errors: errors.slice(0, 8),
  samples,
};
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(report.ok ? 0 : 1);
