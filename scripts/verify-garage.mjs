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

async function enterFerry(portal) {
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), portal.position);
  await page.waitForTimeout(60);
  await page.keyboard.press('e');
  await page.waitForFunction(
    () => window.__SF_SIM__.getInteractionState()?.mode === 'interior',
    null,
    { timeout: 5000 },
  );
  await page.waitForTimeout(650);
}

async function exitFerry() {
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => window.__SF_SIM__.getInteractionState()?.mode !== 'interior',
    null,
    { timeout: 5000 },
  );
  await page.waitForTimeout(700);
}

async function driveAndPark(candidate, damage = 0) {
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
  await page.waitForTimeout(50);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true,
    null, { timeout: 5000 });
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.6,
    null,
    { timeout: 8000 },
  );
  await page.keyboard.up('w');
  if (damage > 0) {
    await page.evaluate((amount) => window.__SF_SIM__.traffic
      .damagePlayerVehicle(amount, 'qa-garage-damage'), damage);
  }
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === false,
    null, { timeout: 4000 });
  return page.evaluate(() => window.__SF_SIM__.traffic.exportPlayerVehicleState());
}

async function registerAndStore(candidate, portal, damage = 0) {
  const parked = await driveAndPark(candidate, damage);
  await page.evaluate(() => window.__SF_SIM__.streetHeat.restart());
  await enterFerry(portal);
  await page.keyboard.press('r');
  await page.waitForTimeout(120);
  const registered = await page.evaluate(() => ({
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    life: window.__SF_SIM__.lifeSim.getState(),
  }));
  await page.keyboard.press('g');
  await page.waitForTimeout(120);
  const stored = await page.evaluate(() => ({
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    garage: window.__SF_SIM__.traffic.getPlayerGarageState(),
    saved: window.__SF_SIM__.getSavedProgress(),
    life: window.__SF_SIM__.lifeSim.getState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  await exitFerry();
  return { parked, registered, stored };
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  const ferryPortal = await page.evaluate(() => {
    const portal = window.__SF_SIM__.city.portals.find((entry) => (
      String(entry.label || '').toLowerCase().includes('ferry building market hall')
    ));
    return portal ? { label: portal.label, position: portal.position, radius: portal.radius } : null;
  });
  assert(ferryPortal?.position, 'Ferry Building market hall portal was unavailable', ferryPortal);

  const candidateA = await findPrivateCandidate();
  assert(candidateA?.id >= 0, 'first private vehicle unavailable', candidateA);
  const first = await registerAndStore(candidateA, ferryPortal, 17);
  assert(first.registered.vehicle?.registeredOwner === true
    && first.stored.vehicle === null
    && first.stored.garage?.count === 1
    && first.stored.garage?.slots?.[0]?.vehicleId === candidateA.id
    && first.stored.garage?.slots?.[0]?.damage?.health
      === first.parked.damage.health
    && first.stored.saved?.snapshot?.garage?.count === 1,
  'first real R/G flow did not register, preserve damage, store, and save', first);

  await page.evaluate(() => window.__SF_SIM__.lifeSim.addCash(100));
  const candidateB = await findPrivateCandidate([candidateA.id]);
  assert(candidateB?.id >= 0, 'second private vehicle unavailable', candidateB);
  const second = await registerAndStore(candidateB, ferryPortal, 9);
  const rosterBeforeReload = second.stored.garage;
  assert(second.registered.vehicle?.registeredOwner === true
    && rosterBeforeReload?.count === 2
    && rosterBeforeReload?.slots?.[0]?.vehicleId === candidateA.id
    && rosterBeforeReload?.slots?.[1]?.vehicleId === candidateB.id
    && new Set(rosterBeforeReload.slots.map((entry) => entry?.vehicleId)).size === 2,
  'second real R/G flow did not create two unique owned slots', second);

  await reloadAndLaunch();
  const restored = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const garage = sim.traffic.getPlayerGarageState();
    const vehicles = sim.traffic.getVehicleLifeSnapshot().vehicles;
    return {
      driving: sim.isDriving(),
      activeVehicle: sim.traffic.exportPlayerVehicleState(),
      garage,
      records: garage.slots.filter(Boolean).map((slot) => vehicles.find(
        (entry) => entry.id === slot.vehicleId,
      )),
      saved: sim.getSavedProgress(),
    };
  });
  assert(restored.driving === false
    && restored.activeVehicle === null
    && restored.garage?.count === 2
    && restored.garage.slots[0].vehicleId === candidateA.id
    && restored.garage.slots[1].vehicleId === candidateB.id
    && restored.records.every((entry) => entry?.action?.key === 'garage-stored'
      && entry.visible === false),
  'reload did not restore two hidden, non-enterable garage slots', restored);

  const outsideBefore = await page.evaluate(() => ({
    garage: window.__SF_SIM__.traffic.getPlayerGarageState(),
    life: window.__SF_SIM__.lifeSim.getState(),
  }));
  await page.keyboard.press('g');
  await page.waitForTimeout(50);
  const outsideAfter = await page.evaluate(() => ({
    garage: window.__SF_SIM__.traffic.getPlayerGarageState(),
    life: window.__SF_SIM__.lifeSim.getState(),
  }));
  assert(JSON.stringify(outsideAfter.garage) === JSON.stringify(outsideBefore.garage)
    && outsideAfter.life.cash === outsideBefore.life.cash,
  'outside-Ferry G mutated the garage or economy', { outsideBefore, outsideAfter });

  await enterFerry(ferryPortal);
  await page.keyboard.press('g');
  await page.waitForTimeout(100);
  const retrievedA = await page.evaluate(() => ({
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    garage: window.__SF_SIM__.traffic.getPlayerGarageState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
  }));
  assert(retrievedA.vehicle?.vehicleId === candidateA.id
    && retrievedA.vehicle?.mode === 'parked'
    && retrievedA.vehicle?.registeredOwner === true
    && retrievedA.vehicle?.theftReported === true
    && retrievedA.vehicle?.damage?.health === rosterBeforeReload.slots[0].damage.health
    && retrievedA.garage?.count === 1,
  'real Ferry G did not retrieve slot A exactly', retrievedA);
  await exitFerry();
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), retrievedA.vehicle.position);
  const heatBeforeOwnedA = retrievedA.heat.heat;
  await page.keyboard.press('e');
  await page.waitForTimeout(100);
  const ownedA = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
  }));
  assert(ownedA.driving === true
    && ownedA.vehicle?.index === candidateA.id
    && ownedA.heat?.heat === heatBeforeOwnedA,
  'retrieved owned slot A could not re-enter legally', ownedA);
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.5,
    null,
    { timeout: 6000 },
  );
  await page.keyboard.up('w');
  await page.keyboard.press('e');
  await page.evaluate(() => window.__SF_SIM__.streetHeat.restart());
  await enterFerry(ferryPortal);

  const pursuitBefore = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.reportIncident(36, {
      kind: 'qa-garage-pursuit', source: 'combat', message: 'QA garage pursuit',
    });
    return {
      vehicle: sim.traffic.exportPlayerVehicleState(),
      garage: sim.traffic.getPlayerGarageState(),
    };
  });
  await page.keyboard.press('g');
  await page.waitForTimeout(60);
  const pursuitAfter = await page.evaluate(() => ({
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    garage: window.__SF_SIM__.traffic.getPlayerGarageState(),
  }));
  assert(JSON.stringify(pursuitAfter) === JSON.stringify(pursuitBefore),
    'active-pursuit G mutated parked or garage state', { pursuitBefore, pursuitAfter });
  await page.evaluate(() => window.__SF_SIM__.streetHeat.restart());

  const downedBefore = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.combat.setEnabled(true);
    sim.damagePlayer(100, 'qa-garage-downed');
    return {
      vehicle: sim.traffic.exportPlayerVehicleState(),
      garage: sim.traffic.getPlayerGarageState(),
    };
  });
  await page.keyboard.press('g');
  await page.waitForTimeout(60);
  const downedAfter = await page.evaluate(() => ({
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    garage: window.__SF_SIM__.traffic.getPlayerGarageState(),
  }));
  assert(JSON.stringify(downedAfter) === JSON.stringify(downedBefore),
    'downed G mutated parked or garage state', { downedBefore, downedAfter });
  await page.evaluate(() => window.__SF_SIM__.restartCombat());

  await page.keyboard.press('g');
  await page.waitForTimeout(70);
  await page.keyboard.press('g');
  await page.waitForTimeout(100);
  const retrievedB = await page.evaluate(() => ({
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    garage: window.__SF_SIM__.traffic.getPlayerGarageState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
  }));
  assert(retrievedB.vehicle?.vehicleId === candidateB.id
    && retrievedB.vehicle?.registeredOwner === true
    && retrievedB.vehicle?.damage?.health === rosterBeforeReload.slots[1].damage.health
    && retrievedB.garage?.count === 1
    && retrievedB.garage?.slots?.[0]?.vehicleId === candidateA.id,
  'store-A/retrieve-B G sequence lost roster identity or damage', retrievedB);
  await exitFerry();
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), retrievedB.vehicle.position);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const ownedB = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
  }));
  assert(ownedB.driving === true
    && ownedB.vehicle?.index === candidateB.id
    && ownedB.heat?.heat === retrievedB.heat.heat,
  'retrieved owned slot B could not re-enter legally', ownedB);
  await page.keyboard.press('e');

  const impoundEvidence = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const garageBefore = sim.traffic.getPlayerGarageState();
    const vehicleBefore = sim.traffic.exportPlayerVehicleState();
    const impounded = sim.traffic.impoundPlayerVehicle();
    return {
      garageBefore,
      vehicleBefore,
      impounded,
      garageAfter: sim.traffic.getPlayerGarageState(),
      held: sim.traffic.getImpoundedVehicleState(),
    };
  });
  assert(impoundEvidence.impounded?.mode === 'impounded'
    && impoundEvidence.held?.vehicleId === candidateB.id
    && JSON.stringify(impoundEvidence.garageAfter) === JSON.stringify(impoundEvidence.garageBefore),
  'impound duplicated or erased a stored garage slot', impoundEvidence);

  const invalid = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = sim.traffic.getPlayerGarageState();
    const malformed = structuredClone(before);
    malformed.slots[1] = structuredClone(malformed.slots[0]);
    if (malformed.slots[1]) malformed.slots[1].slot = 1;
    return {
      accepted: sim.traffic.importPlayerGarageState(malformed),
      before,
      after: sim.traffic.getPlayerGarageState(),
    };
  });
  assert(invalid.accepted === false
    && JSON.stringify(invalid.after) === JSON.stringify(invalid.before),
  'duplicate garage snapshot was not rejected atomically', invalid);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'garage slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'garage smoke passed'
      : 'garage smoke failed',
    baseUrl,
    angle,
    candidates: [candidateA?.id, candidateB?.id],
    first,
    second,
    restored,
    outsideBefore,
    outsideAfter,
    retrievedA,
    ownedA,
    pursuitBefore,
    pursuitAfter,
    downedBefore,
    downedAfter,
    retrievedB,
    ownedB,
    impoundEvidence,
    invalid,
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
    garage: window.__SF_SIM__?.traffic?.getPlayerGarageState?.(),
    impounded: window.__SF_SIM__?.traffic?.getImpoundedVehicleState?.(),
    life: window.__SF_SIM__?.lifeSim?.getState?.(),
    heat: window.__SF_SIM__?.getStreetHeatState?.(),
  })).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
