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
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.z || 0) - (b?.z || 0));

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

async function launch() {
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
  await page.waitForTimeout(300);
}

async function reloadAndLaunch() {
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await launch();

  const candidate = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.reported === false
    )) || null);
  assert(candidate?.id >= 0, 'no parked private vehicle was available', candidate);

  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
  await page.waitForTimeout(40);
  await page.keyboard.press('e');
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.6,
    null,
    { timeout: 8000 },
  );
  await page.waitForTimeout(450);
  await page.keyboard.up('w');
  const beforeExit = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.damagePlayerVehicle(35, 'qa-parked-persistence');
    return {
      state: sim.traffic.getPlayerVehicleState(),
      heat: sim.getStreetHeatState(),
      diagnostics: sim.traffic.getDiagnostics(),
    };
  });
  assert(beforeExit.state?.index === candidate.id
    && beforeExit.state?.speed > 0.6
    && beforeExit.state?.theft?.reported === true
    && beforeExit.state?.damage?.health === beforeExit.state.damage.maxHealth - 35,
  'real E/W did not produce a moving damaged stolen vehicle', beforeExit);

  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const parked = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const exported = sim.traffic.exportPlayerVehicleState();
    const lifeVehicle = sim.traffic.getVehicleLifeSnapshot().vehicles
      .find((vehicle) => vehicle.id === exported?.vehicleId) || null;
    return {
      driving: sim.isDriving(),
      roam: sim.getRoamState(),
      exported,
      lifeVehicle,
      saved: sim.getSavedProgress(),
      diagnostics: sim.traffic.getDiagnostics(),
    };
  });
  assert(parked.driving === false
    && parked.exported?.mode === 'parked'
    && parked.exported?.vehicleId === candidate.id
    && parked.exported?.identity === candidate.identity.key
    && parked.exported?.theftReported === true
    && parked.exported?.damage?.health === beforeExit.state.damage.health
    && parked.lifeVehicle?.action?.key === 'parked'
    && distance(parked.roam?.target, parked.exported?.position) <= 2.5
    && distance(parked.exported?.position, candidate.position) > 0.5
    && parked.saved?.snapshot?.vehicle?.mode === 'parked',
  'roadside exit did not hand off to the current parked vehicle pose and save it', parked);

  const parkedSnapshot = structuredClone(parked.saved.snapshot.vehicle);
  await reloadAndLaunch();
  const restored = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const exported = sim.traffic.exportPlayerVehicleState();
    const nearest = sim.traffic.getNearestEnterableVehicle(sim.getRoamState().target, 3.8);
    return {
      driving: sim.isDriving(),
      roam: sim.getRoamState(),
      exported,
      nearest: nearest ? { index: nearest.index, distance: nearest.distance } : null,
      lifeVehicle: sim.traffic.getVehicleLifeSnapshot().vehicles
        .find((vehicle) => vehicle.id === exported?.vehicleId) || null,
      heat: sim.getStreetHeatState(),
      diagnostics: sim.traffic.getDiagnostics(),
    };
  });
  const restoredChecks = {
    onFoot: restored.driving === false,
    parkedMode: restored.exported?.mode === 'parked',
    sameId: restored.exported?.vehicleId === parkedSnapshot.vehicleId,
    sameClass: restored.exported?.class === parkedSnapshot.class,
    sameIdentity: restored.exported?.identity === parkedSnapshot.identity,
    theftRetained: restored.exported?.theftReported === true,
    damageRetained: restored.exported?.damage?.health === parkedSnapshot.damage.health,
    poseDistance: distance(restored.exported?.position, parkedSnapshot.position),
    playerDistance: distance(restored.roam?.target, restored.exported?.position),
    nearestId: restored.nearest?.index,
    lifeAction: restored.lifeVehicle?.action?.key,
  };
  assert(Object.entries(restoredChecks).every(([key, value]) => (
    key === 'poseDistance' ? value <= 0.5
      : key === 'playerDistance' ? value <= 2.5
        : key === 'nearestId' ? value === parkedSnapshot.vehicleId
          : key === 'lifeAction' ? value === 'parked'
            : value === true
  )), 'reload did not restore the same re-enterable parked vehicle beside the player', {
    restoredChecks,
    restored,
  });

  const theftCountBefore = restored.diagnostics?.vehicleThefts || 0;
  const heatBefore = restored.heat?.heat || 0;
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const reentered = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    state: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
  }));
  assert(reentered.driving === true
    && reentered.state?.index === parkedSnapshot.vehicleId
    && reentered.state?.theft?.reported === true
    && reentered.diagnostics?.vehicleThefts === theftCountBefore
    && reentered.heat?.heat <= heatBefore,
  're-entering the same restored stolen vehicle duplicated theft heat or identity', reentered);

  const terminal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const damage = sim.damagePlayerVehicle(999, 'qa-parked-terminal');
    return {
      damage,
      life: sim.lifeSim.getState(),
      heat: sim.getStreetHeatState(),
      diagnostics: sim.traffic.getDiagnostics(),
    };
  });
  assert(terminal.damage?.disabled === true && terminal.damage?.health === 0,
    'terminal damage did not disable the tracked vehicle before parking', terminal);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const disabledParked = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    saved: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(disabledParked.driving === false
    && disabledParked.vehicle?.mode === 'parked'
    && disabledParked.vehicle?.damage?.disabled === true
    && disabledParked.saved?.snapshot?.vehicle?.damage?.health === 0,
  'disabled player vehicle was not preserved as a parked save', disabledParked);

  await reloadAndLaunch();
  const disabledRestored = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const roam = sim.getRoamState();
    const nearest = sim.traffic.getNearestEnterableVehicle(roam.target, 3.8);
    return {
      driving: sim.isDriving(),
      roam,
      vehicle: sim.traffic.exportPlayerVehicleState(),
      nearest: nearest ? { index: nearest.index, distance: nearest.distance } : null,
      life: sim.lifeSim.getState(),
      heat: sim.getStreetHeatState(),
      diagnostics: sim.traffic.getDiagnostics(),
    };
  });
  assert(disabledRestored.driving === false
    && disabledRestored.vehicle?.mode === 'parked'
    && disabledRestored.vehicle?.damage?.disabled === true
    && disabledRestored.nearest?.index === parkedSnapshot.vehicleId,
  'disabled parked vehicle was not selectable after reload', disabledRestored);
  const disabledHeat = disabledRestored.heat?.heat || 0;
  const disabledThefts = disabledRestored.diagnostics?.vehicleThefts || 0;
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const repairQuote = await page.evaluate(() => window.__SF_SIM__.getPlayerVehicleRepairQuote());
  await page.keyboard.press('r');
  await page.waitForTimeout(100);
  const repaired = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    state: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    life: window.__SF_SIM__.lifeSim.getState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
  }));
  assert(repaired.driving === true
    && repaired.state?.index === parkedSnapshot.vehicleId
    && repaired.state?.damage?.disabled === false
    && repaired.state?.damage?.health === repaired.state?.damage?.maxHealth
    && Number.isFinite(repairQuote?.cost)
    && repaired.life.cash === disabledRestored.life.cash - repairQuote.cost
    && repaired.life.lastTransaction?.kind === 'vehicle-repair'
    && repaired.heat?.heat <= disabledHeat
    && repaired.diagnostics?.vehicleThefts === disabledThefts,
  'disabled parked vehicle did not support paid repair without duplicate theft', {
    repairQuote,
    repaired,
  });
  await page.keyboard.press('e');
  await page.waitForTimeout(80);

  const rollbackBaseline = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(53);
    sim.saveProgress();
    return {
      life: sim.lifeSim.getState(),
      roam: sim.getRoamState(),
      vehicle: sim.traffic.exportPlayerVehicleState(),
      saved: sim.getSavedProgress(),
    };
  });
  const invalidIdentity = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const saved = sim.getSavedProgress();
    const invalid = structuredClone(saved.snapshot);
    invalid.life.cash = 7;
    invalid.vehicle.identity = 'invalid-parked-identity';
    window.localStorage.setItem(saved.key, JSON.stringify(invalid));
    return {
      restored: sim.restoreProgress(),
      life: sim.lifeSim.getState(),
      roam: sim.getRoamState(),
      vehicle: sim.traffic.exportPlayerVehicleState(),
    };
  });
  assert(invalidIdentity.restored === false
    && invalidIdentity.life.cash === rollbackBaseline.life.cash
    && distance(invalidIdentity.roam?.target, rollbackBaseline.roam?.target) < 0.05
    && invalidIdentity.vehicle?.mode === 'parked'
    && invalidIdentity.vehicle?.identity === rollbackBaseline.vehicle.identity,
  'invalid parked identity did not roll back life, world, and parked vehicle atomically', invalidIdentity);

  await page.evaluate((snapshot) => {
    const sim = window.__SF_SIM__;
    window.localStorage.setItem(sim.getSavedProgress().key, JSON.stringify(snapshot));
  }, rollbackBaseline.saved.snapshot);
  const invalidPose = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const saved = sim.getSavedProgress();
    const invalid = structuredClone(saved.snapshot);
    invalid.life.cash = 9;
    invalid.vehicle.position = { x: 999999, z: -999999 };
    window.localStorage.setItem(saved.key, JSON.stringify(invalid));
    return {
      restored: sim.restoreProgress(),
      life: sim.lifeSim.getState(),
      roam: sim.getRoamState(),
      vehicle: sim.traffic.exportPlayerVehicleState(),
    };
  });
  assert(invalidPose.restored === false
    && invalidPose.life.cash === rollbackBaseline.life.cash
    && distance(invalidPose.roam?.target, rollbackBaseline.roam?.target) < 0.05
    && invalidPose.vehicle?.mode === 'parked'
    && invalidPose.vehicle?.vehicleId === rollbackBaseline.vehicle.vehicleId,
  'off-road parked pose did not roll back life, world, and parked vehicle atomically', invalidPose);

  await page.evaluate((snapshot) => {
    const sim = window.__SF_SIM__;
    const legacy = structuredClone(snapshot);
    delete legacy.vehicle;
    window.localStorage.setItem(sim.getSavedProgress().key, JSON.stringify(legacy));
  }, rollbackBaseline.saved.snapshot);
  await reloadAndLaunch();
  const legacy = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
  }));
  assert(legacy.driving === false && legacy.vehicle === null,
    'legacy snapshot without a parked vehicle did not remain compatible', legacy);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'parked vehicle persistence exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'parked vehicle persistence smoke passed'
      : 'parked vehicle persistence smoke failed',
    baseUrl,
    angle,
    candidate: { id: candidate?.id, class: candidate?.class, position: candidate?.position },
    beforeExit,
    parked,
    restored,
    reentered,
    terminal,
    disabledParked,
    disabledRestored,
    repairQuote,
    repaired,
    rollbackBaseline,
    invalidIdentity,
    invalidPose,
    legacy,
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
