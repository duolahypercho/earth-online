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
const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

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
  await page.keyboard.up('w');

  const savedDamaged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const damaged = sim.damagePlayerVehicle(35, 'qa-persistence-impact');
    const saved = sim.saveProgress();
    return {
      damaged,
      saved,
      state: sim.traffic.getPlayerVehicleState(),
      snapshot: sim.getSavedProgress().snapshot,
    };
  });
  assert(savedDamaged.saved === true
    && savedDamaged.state?.index === candidate.id
    && savedDamaged.state?.speed > 0.6
    && savedDamaged.state?.theft?.reported === true
    && savedDamaged.state?.damage?.health === savedDamaged.state.damage.maxHealth - 35
    && savedDamaged.snapshot?.vehicle?.vehicleId === candidate.id
    && savedDamaged.snapshot?.vehicle?.theftReported === true,
  'real E/W damaged vehicle state was not saved', savedDamaged);

  await reloadAndLaunch();
  const restoredDamaged = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    state: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    snapshot: window.__SF_SIM__.getSavedProgress().snapshot,
  }));
  const savedPose = savedDamaged.snapshot.vehicle.position;
  assert(restoredDamaged.driving === true
    && restoredDamaged.state?.index === candidate.id
    && restoredDamaged.state?.class === candidate.class
    && restoredDamaged.state?.theft?.reported === true
    && restoredDamaged.state?.speed === 0
    && restoredDamaged.state?.damage?.health === savedDamaged.state.damage.health
    && Math.hypot(
      restoredDamaged.state.position.x - savedPose.x,
      restoredDamaged.state.position.z - savedPose.z,
    ) <= 0.5
    && angleDistance(restoredDamaged.state.heading, savedDamaged.snapshot.vehicle.heading) <= 0.01,
  'damaged active vehicle did not restore identity, pose, theft, and safe speed', restoredDamaged);

  const disabledSaved = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const disabled = sim.damagePlayerVehicle(999, 'qa-persistence-terminal');
    const saved = sim.saveProgress();
    return {
      disabled,
      saved,
      state: sim.traffic.getPlayerVehicleState(),
      life: sim.lifeSim.getState(),
      snapshot: sim.getSavedProgress().snapshot,
    };
  });
  assert(disabledSaved.saved === true
    && disabledSaved.state?.damage?.disabled === true
    && disabledSaved.snapshot?.vehicle?.damage?.health === 0,
  'disabled vehicle state was not saved', disabledSaved);

  await reloadAndLaunch();
  const restoredDisabled = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    state: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    quote: window.__SF_SIM__.getPlayerVehicleRepairQuote(),
  }));
  assert(restoredDisabled.driving === true
    && restoredDisabled.state?.index === candidate.id
    && restoredDisabled.state?.speed === 0
    && restoredDisabled.state?.damage?.disabled === true
    && restoredDisabled.state?.damage?.health === 0
    && restoredDisabled.quote?.cost > 0,
  'disabled vehicle did not restore exactly', restoredDisabled);
  await page.keyboard.press('r');
  await page.waitForTimeout(100);
  const repaired = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.saveProgress();
    return {
      state: sim.traffic.getPlayerVehicleState(),
      life: sim.lifeSim.getState(),
      snapshot: sim.getSavedProgress().snapshot,
    };
  });
  assert(repaired.state?.damage?.disabled === false
    && repaired.state?.damage?.health === repaired.state?.damage?.maxHealth
    && repaired.life.cash === disabledSaved.life.cash - restoredDisabled.quote.cost
    && repaired.life.lastTransaction?.kind === 'vehicle-repair'
    && repaired.snapshot?.vehicle?.damage?.disabled === false,
  'restored disabled vehicle did not retain paid repair behavior', repaired);

  await page.keyboard.press('e');
  const legacySetup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.saveProgress();
    const saved = sim.getSavedProgress();
    const legacy = structuredClone(saved.snapshot);
    delete legacy.vehicle;
    window.localStorage.setItem(saved.key, JSON.stringify(legacy));
    return { legacy, key: saved.key };
  });
  await reloadAndLaunch();
  const legacyRestored = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    life: window.__SF_SIM__.lifeSim.getState(),
  }));
  assert(legacyRestored.driving === false && legacyRestored.vehicle === null,
    'legacy on-foot snapshot did not remain backward compatible', { legacySetup, legacyRestored });

  const rollbackBaseline = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(73);
    sim.saveProgress();
    return {
      life: sim.lifeSim.getState(),
      roam: sim.getRoamState(),
      saved: sim.getSavedProgress(),
    };
  });
  const invalidIdentity = await page.evaluate((vehicleSnapshot) => {
    const sim = window.__SF_SIM__;
    const saved = sim.getSavedProgress();
    const invalid = structuredClone(saved.snapshot);
    invalid.life.cash = 17;
    invalid.vehicle = structuredClone(vehicleSnapshot);
    invalid.vehicle.identity = 'not-the-saved-identity';
    window.localStorage.setItem(saved.key, JSON.stringify(invalid));
    const restored = sim.restoreProgress();
    return {
      restored,
      life: sim.lifeSim.getState(),
      driving: sim.isDriving(),
      roam: sim.getRoamState(),
    };
  }, savedDamaged.snapshot.vehicle);
  assert(invalidIdentity.restored === false
    && invalidIdentity.life.cash === rollbackBaseline.life.cash
    && invalidIdentity.driving === false
    && Math.hypot(
      invalidIdentity.roam.target.x - rollbackBaseline.roam.target.x,
      invalidIdentity.roam.target.z - rollbackBaseline.roam.target.z,
    ) < 0.05,
  'invalid vehicle identity did not roll back atomically', invalidIdentity);

  const invalidPose = await page.evaluate((vehicleSnapshot) => {
    const sim = window.__SF_SIM__;
    const saved = sim.getSavedProgress();
    const invalid = structuredClone(saved.snapshot);
    invalid.life.cash = 9;
    invalid.vehicle = structuredClone(vehicleSnapshot);
    invalid.vehicle.position = { x: 999999, z: -999999 };
    window.localStorage.setItem(saved.key, JSON.stringify(invalid));
    const restored = sim.restoreProgress();
    return {
      restored,
      life: sim.lifeSim.getState(),
      driving: sim.isDriving(),
      roam: sim.getRoamState(),
    };
  }, savedDamaged.snapshot.vehicle);
  assert(invalidPose.restored === false
    && invalidPose.life.cash === rollbackBaseline.life.cash
    && invalidPose.driving === false
    && Math.hypot(
      invalidPose.roam.target.x - rollbackBaseline.roam.target.x,
      invalidPose.roam.target.z - rollbackBaseline.roam.target.z,
    ) < 0.05,
  'out-of-footprint vehicle pose did not roll back atomically', invalidPose);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'vehicle persistence slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'vehicle persistence smoke passed'
      : 'vehicle persistence smoke failed',
    baseUrl,
    angle,
    candidate: { id: candidate?.id, class: candidate?.class, position: candidate?.position },
    savedDamaged,
    restoredDamaged,
    disabledSaved,
    restoredDisabled,
    repaired,
    legacyRestored,
    rollbackBaseline,
    invalidIdentity,
    invalidPose,
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
