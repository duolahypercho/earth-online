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

async function findPrivateCandidate(excludedIds = []) {
  return page.evaluate((excluded) => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      !excluded.includes(vehicle.id)
      && vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.reported === false
      && vehicle.theft?.registeredOwner !== true
    )) || null, excludedIds);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await launch();

  const candidate = await findPrivateCandidate();
  assert(candidate?.id >= 0, 'no fresh parked private vehicle was available', candidate);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
  await page.waitForTimeout(50);
  await page.keyboard.press('e');
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.6,
    null,
    { timeout: 8000 },
  );
  await page.keyboard.up('w');
  await page.keyboard.press('e');
  await page.waitForTimeout(100);

  const parkedBefore = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    registration: window.__SF_SIM__.traffic.getPlayerVehicleRegistrationState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    life: window.__SF_SIM__.lifeSim.getState(),
  }));
  assert(parkedBefore.driving === false
    && parkedBefore.vehicle?.mode === 'parked'
    && parkedBefore.vehicle?.vehicleId === candidate.id
    && parkedBefore.vehicle?.theftReported === true
    && parkedBefore.vehicle?.registeredOwner === false
    && parkedBefore.registration?.eligible === true
    && parkedBefore.heat?.heat === 18,
  'real E/W/exit did not retain an eligible unregistered private vehicle', parkedBefore);

  const ferryPortal = await page.evaluate(() => {
    const portal = window.__SF_SIM__.city.portals.find((entry) => (
      String(entry.label || '').toLowerCase().includes('ferry building market hall')
    ));
    return portal ? { label: portal.label, position: portal.position, radius: portal.radius } : null;
  });
  assert(ferryPortal?.position, 'Ferry Building market hall portal was unavailable', ferryPortal);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), ferryPortal.position);
  await page.waitForTimeout(80);
  await page.keyboard.press('e');
  await page.waitForFunction(
    () => window.__SF_SIM__.getInteractionState()?.mode === 'interior',
    null,
    { timeout: 4000 },
  );
  await page.waitForTimeout(700);

  const pursuitRefusal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const priorHeat = sim.streetHeat.exportState();
    const life = sim.lifeSim.getState();
    sim.streetHeat.reportIncident(18, {
      kind: 'qa-registration-pursuit',
      message: 'QA registration pursuit',
      source: 'qa-registration-pursuit',
    });
    return { priorHeat, life, heat: sim.getStreetHeatState() };
  });
  await page.keyboard.press('r');
  await page.waitForTimeout(60);
  const pursuitBlocked = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    life: window.__SF_SIM__.lifeSim.getState(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
  }));
  assert(pursuitRefusal.heat?.pursuitActive === true
    && pursuitBlocked.vehicle?.registeredOwner === false
    && pursuitBlocked.life?.cash === pursuitRefusal.life.cash
    && pursuitBlocked.life?.lastTransaction?.at === pursuitRefusal.life.lastTransaction?.at,
  'active pursuit R mutated registration or economy', pursuitBlocked);
  await page.evaluate((state) => window.__SF_SIM__.streetHeat.importState(state), pursuitRefusal.priorHeat);

  const downedRefusal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.combat.setEnabled(true);
    sim.damagePlayer(100, 'qa-registration-downed');
    return { combat: sim.getCombatState(), life: sim.lifeSim.getState() };
  });
  await page.keyboard.press('r');
  await page.waitForTimeout(60);
  const downedBlocked = await page.evaluate(() => ({
    combat: window.__SF_SIM__.getCombatState(),
    life: window.__SF_SIM__.lifeSim.getState(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
  }));
  assert(downedRefusal.combat?.status === 'downed'
    && downedBlocked.vehicle?.registeredOwner === false
    && downedBlocked.life?.cash === downedRefusal.life.cash
    && downedBlocked.life?.lastTransaction?.at === downedRefusal.life.lastTransaction?.at,
  'downed R mutated registration or economy', downedBlocked);
  await page.evaluate(() => window.__SF_SIM__.restartCombat());

  const refusalSetup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(-sim.lifeSim.getState().cash);
    return {
      life: sim.lifeSim.getState(),
      vehicle: sim.traffic.exportPlayerVehicleState(),
    };
  });
  await page.keyboard.press('r');
  await page.waitForTimeout(80);
  const insufficient = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(insufficient.life?.cash === 0
    && insufficient.life?.lastTransaction?.at === refusalSetup.life?.lastTransaction?.at
    && insufficient.vehicle?.registeredOwner === false
    && insufficient.message.includes('costs $60'),
  'insufficient-cash R mutated registration, cash, or transaction', insufficient);

  await page.evaluate(() => window.__SF_SIM__.lifeSim.addCash(140));
  const beforePayment = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
  }));
  await page.keyboard.press('r');
  await page.waitForTimeout(120);
  const registered = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    registration: window.__SF_SIM__.traffic.getPlayerVehicleRegistrationState(),
    saved: window.__SF_SIM__.getSavedProgress(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(registered.vehicle?.vehicleId === candidate.id
    && registered.vehicle?.registeredOwner === true
    && registered.vehicle?.theftReported === true
    && registered.registration?.registeredOwner === true
    && registered.life?.cash === beforePayment.life.cash - 60
    && registered.life?.lastTransaction?.kind === 'vehicle-registration'
    && registered.life?.lastTransaction?.amount === -60
    && registered.life?.lastTransaction?.cashAfter === registered.life.cash
    && registered.heat?.heat === beforePayment.heat?.heat
    && registered.saved?.snapshot?.vehicle?.registeredOwner === true
    && registered.message.includes('Vehicle registered'),
  'Ferry R did not atomically register, charge, and immediately save', registered);

  const registeredAt = registered.life?.lastTransaction?.at;
  await page.keyboard.press('r');
  await page.waitForTimeout(60);
  const duplicate = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
  }));
  assert(duplicate.life?.cash === registered.life.cash
    && duplicate.life?.lastTransaction?.at === registeredAt
    && duplicate.vehicle?.registeredOwner === true,
  'duplicate Ferry registration charged or changed ownership', duplicate);

  await reloadAndLaunch();
  const restored = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    thefts: window.__SF_SIM__.traffic.getDiagnostics().vehicleThefts,
  }));
  assert(restored.driving === false
    && restored.vehicle?.mode === 'parked'
    && restored.vehicle?.vehicleId === candidate.id
    && restored.vehicle?.class === registered.vehicle.class
    && restored.vehicle?.identity === registered.vehicle.identity
    && restored.vehicle?.registeredOwner === true
    && restored.vehicle?.theftReported === true
    && Math.hypot(
      restored.vehicle.position.x - registered.vehicle.position.x,
      restored.vehicle.position.z - registered.vehicle.position.z,
    ) <= 0.5
    && Math.abs(restored.vehicle.heading - registered.vehicle.heading) <= 0.01,
  'reload did not preserve registered identity, pose, damage, and ownership', restored);

  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), restored.vehicle.position);
  await page.waitForTimeout(50);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const ownedEntry = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    thefts: window.__SF_SIM__.traffic.getDiagnostics().vehicleThefts,
  }));
  assert(ownedEntry.driving === true
    && ownedEntry.vehicle?.index === candidate.id
    && ownedEntry.vehicle?.theft?.registeredOwner === true
    && ownedEntry.heat?.heat === restored.heat?.heat
    && ownedEntry.thefts === restored.thefts,
  'real E into registered vehicle duplicated theft or heat', ownedEntry);
  await page.keyboard.press('e');
  await page.waitForTimeout(60);

  const impoundRoundTrip = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = sim.traffic.exportPlayerVehicleState();
    const impounded = sim.traffic.impoundPlayerVehicle();
    const held = sim.traffic.getImpoundedVehicleState();
    const retrieved = sim.traffic.retrieveImpoundedPlayerVehicle(before.position, before.heading);
    return { before, impounded, held, retrieved };
  });
  assert(impoundRoundTrip.impounded?.registeredOwner === true
    && impoundRoundTrip.held?.registeredOwner === true
    && impoundRoundTrip.retrieved?.registeredOwner === true
    && impoundRoundTrip.retrieved?.theftReported === true,
  'registration did not survive impound and retrieval', impoundRoundTrip);

  const control = await findPrivateCandidate([candidate.id]);
  assert(control?.id >= 0, 'no unregistered control vehicle was available', control);
  const beforeControl = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    thefts: window.__SF_SIM__.traffic.getDiagnostics().vehicleThefts,
  }));
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), control.position);
  await page.waitForTimeout(50);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const controlEntry = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    thefts: window.__SF_SIM__.traffic.getDiagnostics().vehicleThefts,
  }));
  assert(controlEntry.driving === true
    && controlEntry.vehicle?.index === control.id
    && controlEntry.vehicle?.theft?.registeredOwner === false
    && controlEntry.heat?.heat === beforeControl.heat.heat + 18
    && controlEntry.thefts === beforeControl.thefts + 1,
  'unregistered control vehicle did not retain exact theft behavior', controlEntry);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'registration slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'vehicle registration smoke passed'
      : 'vehicle registration smoke failed',
    baseUrl,
    angle,
    candidate: { id: candidate?.id, class: candidate?.class },
    control: { id: control?.id, class: control?.class },
    parkedBefore,
    pursuitBlocked,
    downedBlocked,
    insufficient,
    registered,
    duplicate,
    restored,
    ownedEntry,
    impoundRoundTrip,
    controlEntry,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  console.error(JSON.stringify(await page.evaluate(() => ({
    vehicle: window.__SF_SIM__?.traffic?.exportPlayerVehicleState?.(),
    registration: window.__SF_SIM__?.traffic?.getPlayerVehicleRegistrationState?.(),
    life: window.__SF_SIM__?.lifeSim?.getState?.(),
    heat: window.__SF_SIM__?.getStreetHeatState?.(),
  })).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
