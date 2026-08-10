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
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    )) || null, excludedIds);
}

async function enterCandidate(candidate) {
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
  await page.waitForTimeout(50);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  return page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    thefts: window.__SF_SIM__.traffic.getDiagnostics().vehicleThefts,
  }));
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await launch();

  const first = await findPrivateCandidate();
  assert(first?.id >= 0, 'first parked private vehicle was unavailable', first);
  const firstTheft = await enterCandidate(first);
  assert(firstTheft.driving === true
    && firstTheft.heat?.heat === 18
    && firstTheft.thefts === 1,
  'first real E theft did not add exactly 18 heat', firstTheft);
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.6,
    null,
    { timeout: 8000 },
  );
  await page.keyboard.up('w');
  await page.keyboard.press('e');
  await page.waitForTimeout(80);

  const second = await findPrivateCandidate([first.id]);
  assert(second?.id >= 0, 'distinct second parked private vehicle was unavailable', second);
  const secondTheft = await enterCandidate(second);
  assert(secondTheft.driving === true
    && secondTheft.vehicle?.index === second.id
    && secondTheft.heat?.heat === 36
    && secondTheft.heat?.pursuitActive === true
    && secondTheft.thefts === 2,
  'second real E theft did not start the exact 36-heat pursuit', secondTheft);

  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponder?.();
    return sim.getStreetHeatState()?.pursuitActive === true
      && responder?.active === true
      && Number.isFinite(responder.position?.x)
      && Number.isFinite(responder.position?.z);
  }, null, { timeout: 10000, polling: 50 });

  const staged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponder();
    const responderRoot = sim.traffic.group.children[responder.id];
    const snapshot = sim.traffic.exportPlayerVehicleState();
    snapshot.position = { x: responder.position.x, z: responder.position.z };
    snapshot.heading = responderRoot.rotation.y;
    return {
      imported: sim.traffic.importPlayerVehicleState(snapshot),
      responder,
      vehicle: sim.traffic.getPlayerVehicleState(),
    };
  });
  assert(staged.imported === true, 'could not stage beside the live responder', staged);
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 1.3,
    null,
    { timeout: 4000 },
  );
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  const contact = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    driving: window.__SF_SIM__.isDriving(),
  }));
  assert(contact.heat?.arrests === 0
    && contact.heat?.pursuitActive === true
    && contact.driving === true,
  'live responder approach arrested early or ended the pursuit', contact);
  const restaged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponder();
    const responderRoot = sim.traffic.group.children[responder.id];
    const snapshot = sim.traffic.exportPlayerVehicleState();
    snapshot.position = { x: responder.position.x, z: responder.position.z };
    snapshot.heading = responderRoot.rotation.y;
    return {
      imported: sim.traffic.importPlayerVehicleState(snapshot),
      responder,
      vehicle: sim.traffic.getPlayerVehicleState(),
    };
  });
  assert(restaged.imported === true, 'could not restage stopped vehicle for arrest', restaged);
  await page.keyboard.down('s');
  await page.waitForFunction(
    () => window.__SF_SIM__.getStreetHeatState()?.arrests === 1,
    null,
    { timeout: 5000, polling: 25 },
  );
  await page.keyboard.up('s');
  await page.waitForTimeout(100);

  const impounded = await page.evaluate((vehicleId) => {
    const sim = window.__SF_SIM__;
    const state = sim.traffic.getImpoundedVehicleState();
    const nearest = state
      ? sim.traffic.getNearestEnterableVehicle(state.position, 3.8)
      : null;
    return {
      driving: sim.isDriving(),
      heat: sim.getStreetHeatState(),
      responder: sim.traffic.getPursuitResponder(),
      vehicle: state,
      lifeVehicle: sim.traffic.getVehicleLifeSnapshot().vehicles
        .find((vehicle) => vehicle.id === vehicleId) || null,
      impoundedCount: sim.traffic.getVehicleLifeSnapshot().vehicles
        .filter((vehicle) => vehicle.action?.key === 'impounded').length,
      nearest: nearest ? { index: nearest.index, distance: nearest.distance } : null,
      life: sim.lifeSim.getState(),
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  }, second.id);
  assert(impounded.driving === false
    && impounded.heat?.heat === 0
    && impounded.heat?.pursuitActive === false
    && impounded.responder?.active === false
    && impounded.vehicle?.mode === 'impounded'
    && impounded.vehicle?.vehicleId === second.id
    && impounded.vehicle?.class === second.class
    && impounded.vehicle?.identity === second.identity.key
    && impounded.vehicle?.theftReported === true
    && impounded.lifeVehicle?.action?.key === 'impounded'
    && impounded.impoundedCount === 1
    && impounded.nearest === null,
  'arrest did not atomically create one locked impound record', impounded);
  const expectedWantedFine = Math.min(
    120,
    Math.max(20, Math.ceil(20 + (impounded.heat?.lastEvent?.heatBefore || 0) * 1.5)),
  );
  assert(impounded.life?.lastTransaction?.kind === 'wanted-fine'
    && impounded.life?.lastTransaction?.due === expectedWantedFine
    && impounded.saved?.snapshot?.vehicle?.mode === 'impounded'
    && impounded.saved?.snapshot?.vehicle?.vehicleId === second.id
    && impounded.message.includes('vehicle held at Ferry'),
  'arrest fine, feedback, or immediate impound persistence was missing', impounded);
  const impoundSnapshot = structuredClone(impounded.vehicle);

  const blockedCandidate = await page.evaluate((impoundedId) => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles
    .filter((vehicle) => (
      vehicle.id !== impoundedId
      && vehicle.class !== 'bike'
      && vehicle.damage?.disabled !== true
      && ['parked', 'at-stop', 'queued', 'waiting-at-signal'].includes(vehicle.action?.key)
    ))
    .sort((a, b) => a.speed - b.speed)[0] || null, second.id);
  assert(blockedCandidate?.id >= 0,
    'no stopped ordinary vehicle was available for impound-entry refusal', blockedCandidate);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), blockedCandidate.position);
  await page.waitForTimeout(50);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const blockedEntry = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    impounded: window.__SF_SIM__.traffic.getImpoundedVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    life: window.__SF_SIM__.lifeSim.getState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(blockedEntry.driving === false
    && blockedEntry.vehicle?.mode === 'impounded'
    && blockedEntry.vehicle?.vehicleId === impoundSnapshot.vehicleId
    && blockedEntry.impounded?.vehicleId === impoundSnapshot.vehicleId
    && blockedEntry.heat?.heat === 0
    && blockedEntry.life?.lastTransaction?.at === impounded.life?.lastTransaction?.at
    && blockedEntry.message.includes('Ferry Building before taking another car'),
  'ordinary E allowed another car to mask or mutate the active impound', blockedEntry);

  const beforeOutsideReload = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const shot = sim.fireCombat();
    return {
      shot,
      combat: sim.getCombatState(),
      impounded: sim.traffic.getImpoundedVehicleState(),
      life: sim.lifeSim.getState(),
    };
  });
  assert(beforeOutsideReload.shot?.fired === true
    && beforeOutsideReload.combat?.ammo < beforeOutsideReload.combat?.magazineSize,
  'could not stage a partially spent magazine outside Ferry', beforeOutsideReload);
  await page.keyboard.press('r');
  await page.waitForTimeout(80);
  const outsideReload = await page.evaluate(() => ({
    combat: window.__SF_SIM__.getCombatState(),
    impounded: window.__SF_SIM__.traffic.getImpoundedVehicleState(),
    life: window.__SF_SIM__.lifeSim.getState(),
  }));
  assert(outsideReload.combat?.reloading === true
    && outsideReload.impounded?.vehicleId === impoundSnapshot.vehicleId
    && outsideReload.life?.cash === beforeOutsideReload.life?.cash
    && outsideReload.life?.lastTransaction?.at === beforeOutsideReload.life?.lastTransaction?.at,
  'outside-Ferry R did not preserve reload behavior while leaving impound/cash untouched', {
    beforeOutsideReload,
    outsideReload,
  });

  await reloadAndLaunch();
  const restoredImpound = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const vehicle = sim.traffic.getImpoundedVehicleState();
    const nearest = vehicle
      ? sim.traffic.getNearestEnterableVehicle(vehicle.position, 3.8)
      : null;
    return {
      driving: sim.isDriving(),
      vehicle,
      nearest: nearest ? { index: nearest.index, distance: nearest.distance } : null,
      heat: sim.getStreetHeatState(),
    };
  });
  assert(restoredImpound.driving === false
    && restoredImpound.vehicle?.mode === 'impounded'
    && restoredImpound.vehicle?.vehicleId === impoundSnapshot.vehicleId
    && restoredImpound.vehicle?.identity === impoundSnapshot.identity
    && restoredImpound.vehicle?.damage?.health === impoundSnapshot.damage.health
    && restoredImpound.nearest === null
    && restoredImpound.heat?.heat === 0,
  'reload did not preserve the locked impound state', restoredImpound);

  const ferryPortal = await page.evaluate(() => {
    const portal = window.__SF_SIM__.city.portals.find((entry) => (
      String(entry.label || '').toLowerCase().includes('ferry building market hall')
    ));
    return portal ? { label: portal.label, position: portal.position, radius: portal.radius } : null;
  });
  assert(ferryPortal?.position, 'Ferry Building market hall portal was unavailable', ferryPortal);
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(-sim.lifeSim.getState().cash);
  });
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), ferryPortal.position);
  await page.waitForTimeout(80);
  await page.keyboard.press('e');
  await page.waitForFunction(
    () => window.__SF_SIM__.getInteractionState()?.mode === 'interior',
    null,
    { timeout: 4000 },
  );
  await page.waitForTimeout(700);
  const beforeRefusal = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    vehicle: window.__SF_SIM__.traffic.getImpoundedVehicleState(),
    fee: window.__SF_SIM__.getImpoundRetrievalFee(),
  }));
  await page.keyboard.press('r');
  await page.waitForTimeout(100);
  const refused = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    vehicle: window.__SF_SIM__.traffic.getImpoundedVehicleState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(beforeRefusal.fee === 45
    && refused.life?.cash === 0
    && refused.vehicle?.mode === 'impounded'
    && refused.vehicle?.vehicleId === second.id
    && refused.life?.lastTransaction?.at === beforeRefusal.life?.lastTransaction?.at
    && refused.message.includes('costs $45')
    && refused.message.includes('need more cash'),
  'insufficient-cash Ferry retrieval mutated cash, transaction, or impound', {
    beforeRefusal,
    refused,
  });

  await page.evaluate(() => window.__SF_SIM__.lifeSim.addCash(100));
  const beforePayment = await page.evaluate(() => window.__SF_SIM__.lifeSim.getState());
  await page.keyboard.press('r');
  await page.waitForTimeout(120);
  const retrieved = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    impounded: window.__SF_SIM__.traffic.getImpoundedVehicleState(),
    life: window.__SF_SIM__.lifeSim.getState(),
    saved: window.__SF_SIM__.getSavedProgress(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(retrieved.driving === false
    && retrieved.impounded === null
    && retrieved.vehicle?.mode === 'parked'
    && retrieved.vehicle?.vehicleId === second.id
    && retrieved.vehicle?.class === impoundSnapshot.class
    && retrieved.vehicle?.identity === impoundSnapshot.identity
    && retrieved.vehicle?.damage?.health === impoundSnapshot.damage.health
    && retrieved.vehicle?.theftReported === true
    && retrieved.life?.cash === beforePayment.cash - 45
    && retrieved.life?.lastTransaction?.kind === 'vehicle-impound'
    && retrieved.life?.lastTransaction?.amount === -45
    && retrieved.life?.lastTransaction?.cashAfter === retrieved.life.cash
    && retrieved.saved?.snapshot?.vehicle?.mode === 'parked'
    && retrieved.saved?.snapshot?.vehicle?.vehicleId === second.id
    && retrieved.message.includes('Vehicle released at Ferry pickup'),
  'paid Ferry retrieval did not restore and persist the same parked vehicle atomically', {
    beforePayment,
    retrieved,
  });

  const paidAt = retrieved.life?.lastTransaction?.at;
  await page.keyboard.press('r');
  await page.waitForTimeout(80);
  const duplicate = await page.evaluate(() => ({
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    life: window.__SF_SIM__.lifeSim.getState(),
  }));
  assert(duplicate.vehicle?.mode === 'parked'
    && duplicate.vehicle?.vehicleId === second.id
    && duplicate.life?.cash === retrieved.life.cash
    && duplicate.life?.lastTransaction?.at === paidAt,
  'duplicate retrieval input charged or changed the released vehicle', duplicate);

  await reloadAndLaunch();
  const restoredParked = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.exportPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    thefts: window.__SF_SIM__.traffic.getDiagnostics().vehicleThefts,
  }));
  assert(restoredParked.driving === false
    && restoredParked.vehicle?.mode === 'parked'
    && restoredParked.vehicle?.vehicleId === second.id
    && restoredParked.vehicle?.theftReported === true,
  'reload did not preserve the retrieved parked vehicle', restoredParked);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), restoredParked.vehicle.position);
  await page.waitForTimeout(50);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const reentered = await page.evaluate(() => ({
    driving: window.__SF_SIM__.isDriving(),
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    thefts: window.__SF_SIM__.traffic.getDiagnostics().vehicleThefts,
  }));
  assert(reentered.driving === true
    && reentered.vehicle?.index === second.id
    && reentered.vehicle?.theft?.reported === true
    && reentered.heat?.heat === restoredParked.heat?.heat
    && reentered.thefts === restoredParked.thefts,
  're-entering the released vehicle duplicated theft heat or identity', reentered);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'impound slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'impound smoke passed'
      : 'impound smoke failed',
    baseUrl,
    angle,
    first: { id: first?.id, class: first?.class },
    second: { id: second?.id, class: second?.class },
    firstTheft,
    secondTheft,
    impounded,
    blockedEntry,
    outsideReload,
    restoredImpound,
    ferryPortal,
    refused,
    retrieved,
    duplicate,
    restoredParked,
    reentered,
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
    heat: window.__SF_SIM__?.getStreetHeatState?.(),
    responder: window.__SF_SIM__?.traffic?.getPursuitResponder?.(),
    vehicle: window.__SF_SIM__?.traffic?.exportPlayerVehicleState?.(),
    impounded: window.__SF_SIM__?.traffic?.getImpoundedVehicleState?.(),
    driving: window.__SF_SIM__?.isDriving?.(),
  })).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
