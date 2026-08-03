import { chromium } from 'playwright';
import { access } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
// Use the native macOS WebGL2 backend for the normal gate. SwiftShader stays
// available through SF_QA_ANGLE=swiftshader for an explicit software run, but
// its shader compilation can prevent this city-scale scene from draining the
// bounded population queue in a useful wall-clock window.
const angle = process.env.SF_QA_ANGLE
  || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
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
const qaStartedAt = Date.now();
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
  { id: 'chinatown', key: '3:3', x: 1152, z: 1152 },
  { id: 'nob-hill', key: '2:3', x: 768, z: 1152 },
  { id: 'russian-hill', key: '1:4', x: 384, z: 1536 },
  { id: 'marina', key: '0:5', x: 0, z: 1920 },
  { id: 'embarcadero', key: '3:0', x: 1152, z: 0 },
  { id: 'soma-design', key: '2:-1', x: 768, z: -384 },
];
let activeStop = 'boot';

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    { timeout: 30000 },
  );
  const launchReadyAt = Date.now();
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 15000 },
  );
  const playableAt = Date.now();
  await page.waitForTimeout(1200);

  const samples = [];
  for (const stop of stops) {
    activeStop = stop.id;
    await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry());
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), stop);
      await page.waitForFunction(
        (key) => {
          const stats = window.__SF_SIM__?.streaming?.stats;
          return stats?.focusSector === key
            && stats.populationPendingDetailed === 0
            && (key === '0:0' || stats.enterableBuildings > 0);
        },
        stop.key,
        // Dense authored overlays (Wave B/C ~48 m grids + landmarks) can spend
        // longer compiling pooled facade/material sets while a distant sector
        // drains its bounded population queue. This timeout only covers
        // readiness; the measured frame budget below remains fixed at 16.67 ms.
        { timeout: 60000 },
      );
    await page.waitForTimeout(1000);
    const sample = await page.evaluate((id) => ({
      id,
      performance: window.__SF_SIM__.getPerformanceSnapshot(),
      streaming: window.__SF_SIM__.streaming.stats,
      expansion: window.__SF_SIM__.expansion.getStats(),
      roam: window.__SF_SIM__.getRoamState(),
      detailReady: window.__SF_SIM__.streaming.stats.populationPendingDetailed === 0,
    }), stop.id);
    samples.push(sample);
  }

  const entry = await page.evaluate(() => {
    const volumes = window.__SF_SIM__.expansion.getAuthoredBuildingVolumes('1:0');
    const volume = volumes[0];
    if (!volume) return { available: false };
    window.__SF_SIM__.setRoamPose(volume.entrance);
    return { available: true, buildingId: volume.id };
  });
  let entryState = null;
  if (entry.available) {
    await page.waitForTimeout(900);
    await page.keyboard.press('e');
    await page.waitForTimeout(1200);
    entryState = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
    await page.keyboard.press('Escape');
  }

  const result = {
    result: errors.length === 0
      && samples.every((sample) => sample.performance?.hardBudgetMet === true)
      && samples.every((sample) => sample.performance?.presentedCadenceBudgetMet === true)
      && samples.every((sample) => sample.detailReady === true)
      ? 'performance traversal smoke passed'
      : 'performance traversal smoke failed',
    angle,
    stops: samples,
    hardBudgetMet: samples.every((sample) => sample.performance?.hardBudgetMet === true),
    hardBudgetMisses: samples
      .filter((sample) => sample.performance?.hardBudgetMet !== true)
      .map((sample) => sample.id),
    applicationBudgetMet: samples.every((sample) => sample.performance?.applicationHardBudgetMet === true),
    applicationBudgetMisses: samples
      .filter((sample) => sample.performance?.applicationHardBudgetMet !== true)
      .map((sample) => sample.id),
    applicationWorstFrameMs: Math.max(...samples.map((sample) => sample.performance?.applicationMaxFrameMs || 0)),
    applicationWorstFrameBudgetMet: samples.every((sample) => (
      sample.performance?.applicationMaxFrameMs != null
      && sample.performance.applicationMaxFrameMs <= 16.67
    )),
    applicationWorstFrameBudgetMisses: samples
      .filter((sample) => sample.performance?.applicationMaxFrameMs == null
        || sample.performance.applicationMaxFrameMs > 16.67)
      .map((sample) => sample.id),
    presentedCadenceBudgetMet: samples.every((sample) => sample.performance?.presentedCadenceBudgetMet === true),
    presentedCadenceBudgetMisses: samples
      .filter((sample) => sample.performance?.presentedCadenceBudgetMet !== true)
      .map((sample) => sample.id),
    detailReady: samples.every((sample) => sample.detailReady === true),
    detailReadyMisses: samples
      .filter((sample) => sample.detailReady !== true)
      .map((sample) => sample.id),
    entry,
    entryState,
    errors,
    loading: {
      toLaunchReadyMs: launchReadyAt - qaStartedAt,
      launchToPlayableMs: playableAt - launchReadyAt,
      totalToPlayableMs: playableAt - qaStartedAt,
    },
    targetFrameMs: 16.67,
    note: 'hardBudgetMet measures application-owned frame work; presentedCadenceBudgetMet is retained as a browser/display cadence diagnostic. TARGET HARDWARE profiling remains required for final GPU/display certification.',
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length || result.result !== 'performance traversal smoke passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ result: 'performance traversal smoke failed', stop: activeStop, error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
