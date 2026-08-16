import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE
  || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
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
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};

page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('/favicon.ico')) {
    consoleErrors.push(message.text());
  }
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${response.status()} ${response.url()}`);
  }
});

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(350);

  const candidates = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles
    .filter((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    ))
    .slice(0, 2));
  assert(candidates.length === 2, 'two parked private theft candidates were not available', candidates);

  const failedPose = await page.evaluate((origin) => {
    const sim = window.__SF_SIM__;
    const offsets = [
      [18, 18], [-18, 18], [18, -18], [-18, -18], [28, 0], [0, 28],
    ];
    const offset = offsets.find(([x, z]) => !sim.traffic.getNearestEnterableVehicle({
      x: origin.x + x,
      z: origin.z + z,
    }, 3.8)) || offsets[0];
    const pose = { x: origin.x + offset[0], z: origin.z + offset[1] };
    sim.setRoamPose(pose);
    return pose;
  }, candidates[0]?.position || { x: 0, z: 0 });
  await page.keyboard.press('e');
  await page.waitForTimeout(50);
  const failedEntry = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
  }));
  assert(failedEntry.driving === false
    && failedEntry.heat?.heat === 0
    && failedEntry.diagnostics?.vehicleThefts === 0,
  'failed E entry mutated theft or StreetHeat state', { failedPose, failedEntry });
  await page.keyboard.press('Escape');

  const enterCandidate = async (candidate) => {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
    await page.waitForTimeout(35);
    await page.keyboard.press('e');
    await page.waitForFunction(() => (
      window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.()?.phase === 'seated'
    ), null, { timeout: 4000, polling: 20 });
    return page.evaluate(() => ({
      driving: window.__SF_SIM__.isDriving(),
      vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
      heat: window.__SF_SIM__.getStreetHeatState(),
      diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
      responder: window.__SF_SIM__.traffic.getPursuitResponder(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    }));
  };

  const firstEntry = await enterCandidate(candidates[0]);
  assert(firstEntry.driving === true
    && firstEntry.vehicle?.index === candidates[0].id
    && firstEntry.vehicle?.theft?.reported === true
    && firstEntry.heat?.heat === 18
    && firstEntry.heat?.lastEvent?.kind === 'vehicle-theft'
    && firstEntry.diagnostics?.vehicleThefts === 1
    && firstEntry.message.includes('Vehicle theft reported'),
  'first real E theft did not add exactly one 18-heat incident', firstEntry);

  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.5,
    null,
    { timeout: 8000 },
  );
  await page.keyboard.up('w');
  const firstDrive = await page.evaluate(() => window.__SF_SIM__.traffic.getPlayerVehicleState());
  assert(firstDrive?.speed > 0.5, 'stolen vehicle did not preserve normal driving', firstDrive);
  await page.keyboard.press('e');
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.()?.phase === 'grounded'
  ), null, { timeout: 4000, polling: 20 });

  const freshSecond = await page.evaluate((firstId) => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.id !== firstId
      && vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    )) || null, candidates[0].id);
  assert(freshSecond?.id >= 0, 'a fresh second parked theft candidate was not available', freshSecond);
  if (freshSecond) candidates[1] = freshSecond;

  const secondEntry = await enterCandidate(candidates[1]);
  assert(secondEntry.driving === true
    && secondEntry.vehicle?.index === candidates[1].id
    && secondEntry.vehicle?.theft?.reported === true
    && secondEntry.heat?.heat === 36
    && secondEntry.heat?.pursuitActive === true
    && secondEntry.diagnostics?.vehicleThefts === 2,
  'second distinct theft did not reach exact 36 heat and start pursuit', secondEntry);
  if (secondEntry.heat?.pursuitActive) {
    await page.waitForFunction(() => {
      const sim = window.__SF_SIM__;
      return sim.getStreetHeatState()?.pursuitActive === true
        && sim.traffic.getPursuitResponder()?.active === true;
    }, null, { timeout: 10000 });
  }
  const pursuit = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    responder: window.__SF_SIM__.traffic.getPursuitResponder(),
  }));
  assert(pursuit.heat?.pursuitActive === true
    && pursuit.responder?.active === true
    && Number.isFinite(pursuit.responder?.distance),
  'second theft did not activate a live pursuit responder', pursuit);

  await page.keyboard.press('e');
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.()?.phase === 'grounded'
  ), null, { timeout: 4000, polling: 20 });
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true,
    null, { timeout: 4000, polling: 20 });
  const duplicate = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
  }));
  assert(duplicate.driving === true
    && duplicate.vehicle?.index === candidates[1].id
    && duplicate.vehicle?.theft?.reported === true
    && duplicate.diagnostics?.vehicleThefts === 2
    && duplicate.heat?.heat <= secondEntry.heat.heat,
  're-entering the same stolen vehicle duplicated theft heat/event state', duplicate);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'vehicle theft slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'vehicle theft smoke passed'
      : 'vehicle theft smoke failed',
    baseUrl,
    angle,
    candidates: candidates.map((vehicle) => ({
      id: vehicle.id,
      class: vehicle.class,
      position: vehicle.position,
    })),
    failedEntry,
    firstEntry,
    firstDrive,
    secondEntry,
    pursuit,
    duplicate,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
