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

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.getState();
    return {
      life,
      delivery: life.deliveryRun,
      cash: life.cash,
      transaction: life.lastTransaction,
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      driving: sim.isDriving(),
      target: sim.getInteractionState().target,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function waitForDeliveryDwell() {
  await page.waitForFunction(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.some((vehicle) => (
      vehicle.identity?.category === 'delivery'
      && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.service === 'delivery'
      && vehicle.stop?.dwellRemaining >= 6
      && vehicle.damage?.disabled !== true
    )), null, { timeout: 70000, polling: 40 });
  return page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'delivery'
      && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.service === 'delivery'
      && vehicle.stop?.dwellRemaining >= 6
      && vehicle.damage?.disabled !== true
    )) || null);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  let service = await waitForDeliveryDwell();
  assert(service?.id >= 0
    && service.identity?.category === 'delivery'
    && service.stop?.service === 'delivery',
  'no real delivery vehicle entered an authored delivery dwell', service);

  const isolated = await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    const offsets = [[10, 0], [-10, 0], [0, 10], [0, -10], [14, 14], [-14, -14]];
    return offsets
      .map(([x, z]) => ({ x: position.x + x, z: position.z + z }))
      .find((candidate) => (
        !sim.traffic.getNearestDeliveryService(candidate, 3.8)
        && !sim.traffic.getNearestTaxiService(candidate, 3.8)
        && !sim.traffic.getNearestEnterableVehicle(candidate, 3.8)
        && !sim.city.getNearestPortal(candidate, 4.5)
        && !sim.streaming.getNearestEnterablePortal(candidate, 4.8)
        && !sim.pedestrians.getNearestPerson(candidate, 4.6)
      )) || null;
  }, service.position);
  assert(isolated, 'could not find an isolated delivery refusal pose', isolated);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), isolated);
  const beforeOutOfRange = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const outOfRange = await evidence();
  assert(outOfRange.delivery === null
    && outOfRange.cash === beforeOutOfRange.cash
    && outOfRange.transaction?.at === beforeOutOfRange.transaction?.at
    && await page.evaluate(() => window.__SF_SIM__.getInteractionState().mode === 'roam'),
  'out-of-range E started or paid a delivery run', { beforeOutOfRange, outOfRange });

  await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    sim.setRoamPose(position);
    sim.streetHeat.restart();
    sim.streetHeat.reportIncident(18, {
      kind: 'vehicle-theft',
      source: 'vehicle-theft',
      notify: false,
    });
    sim.streetHeat.reportIncident(18, {
      kind: 'vehicle-theft',
      source: 'vehicle-theft',
      notify: false,
    });
  }, service.position);
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState()?.pursuitActive === true,
    null, { timeout: 10000, polling: 25 });
  const beforePursuit = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const pursuit = await evidence();
  assert(pursuit.delivery === null
    && pursuit.cash === beforePursuit.cash
    && pursuit.transaction?.at === beforePursuit.transaction?.at
    && pursuit.heat?.pursuitActive === true,
  'active pursuit E started or paid a delivery run', { beforePursuit, pursuit });
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.traffic.setPursuitResponder({
      active: false,
      position: sim.getInteractionState().target,
      playerVehicleId: null,
      level: 0,
    });
    sim.restartCombat();
  });

  service = await waitForDeliveryDwell();
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), service.position);
  await page.waitForFunction(({ position, vehicleId }) => {
    const sim = window.__SF_SIM__;
    const delivery = sim.traffic.getNearestDeliveryService(
      sim.getInteractionState().target,
      3.8,
    );
    if (delivery?.index !== vehicleId || !(delivery?.dwellRemaining > 0)) return false;
    const probes = [
      position,
      { x: position.x + 48, z: position.z },
      { x: position.x - 48, z: position.z },
      { x: position.x, z: position.z + 48 },
      { x: position.x, z: position.z - 48 },
    ];
    return probes.some((probe) => {
      const portal = sim.streaming.getNearestEnterablePortal(probe, 120);
      const target = portal?.approach ?? portal?.position;
      const distance = target
        ? Math.hypot(target.x - position.x, target.z - position.z)
        : Infinity;
      return distance >= 16
        && distance <= 120
        && Math.abs(target.x - position.x) >= 8
        && Math.abs(target.z - position.z) >= 8;
    });
  }, { position: service.position, vehicleId: service.id }, { timeout: 5000, polling: 25 });
  const candidate = await page.evaluate(() => window.__SF_SIM__.traffic
    .getNearestDeliveryService(window.__SF_SIM__.getInteractionState().target, 3.8));
  assert(candidate?.index === service.id && candidate?.dwellRemaining > 0,
    'real delivery dwell was not available to normal E input', { service, candidate });
  if (candidate?.index !== service.id || !(candidate?.dwellRemaining > 0)) {
    throw new Error(`Fresh delivery dwell expired: ${JSON.stringify({ service, candidate })}`);
  }
  const beforeStart = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const started = await evidence();
  assert(started.delivery?.active === true
    && started.delivery.service?.vehicleId === service.id
    && typeof started.delivery.target?.id === 'string'
    && Math.hypot(
      started.delivery.target.x - service.position.x,
      started.delivery.target.z - service.position.z,
    ) >= 16
    && Math.hypot(
      started.delivery.target.x - service.position.x,
      started.delivery.target.z - service.position.z,
    ) <= 120
    && started.cash === beforeStart.cash
    && started.transaction?.at === beforeStart.transaction?.at
    && started.heat?.heat === beforeStart.heat?.heat
    && started.saved?.snapshot?.life?.deliveryRun?.target?.id === started.delivery.target.id,
  'real E did not start and immediately save one no-charge delivery run', {
    service,
    beforeStart,
    started,
  });

  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const duplicate = await evidence();
  assert(duplicate.delivery?.target?.id === started.delivery?.target?.id
    && duplicate.cash === started.cash
    && duplicate.transaction?.at === started.transaction?.at,
  'duplicate E mutated or paid the active delivery run', { started, duplicate });

  await page.waitForTimeout(1150);
  const activeSaved = await evidence();
  const savedElapsed = activeSaved.saved?.snapshot?.life?.deliveryRun?.elapsed;
  assert(activeSaved.delivery?.elapsed > 0.8
    && Number.isFinite(savedElapsed)
    && savedElapsed > 0,
  'active delivery run did not autosave progress', activeSaved);

  await reloadAndLaunch();
  const restoredActive = await evidence();
  assert(restoredActive.delivery?.active === true
    && restoredActive.delivery.target?.id === started.delivery.target.id
    && restoredActive.delivery.service?.vehicleId === service.id
    && restoredActive.delivery.elapsed >= savedElapsed
    && restoredActive.cash === started.cash,
  'reload did not restore the same active delivery run', { activeSaved, restoredActive });
  if (!restoredActive.delivery?.active) {
    throw new Error(`Delivery restore failed: ${JSON.stringify({ activeSaved, restoredActive })}`);
  }

  const travelStart = restoredActive.target;
  const destination = restoredActive.delivery.target;
  const targetSide = Math.sign(destination.x - travelStart.x) || 1;
  const bypassX = destination.x - targetSide * 3.2;
  const bypassYaw = bypassX < travelStart.x ? Math.PI / 2 : -Math.PI / 2;
  await page.evaluate(({ position, viewYaw }) => window.__SF_SIM__.setRoamPose({
    x: position.x,
    z: position.z,
    yaw: viewYaw,
    pitch: 0.62,
    distance: 17,
  }), { position: travelStart, viewYaw: bypassYaw });
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await page.waitForFunction((targetX) => {
    const target = window.__SF_SIM__.getInteractionState().target;
    return Math.abs(target.x - targetX) <= 0.5;
  }, bypassX, { timeout: 5000, polling: 40 });
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  const bypassed = await evidence();
  const firstYaw = destination.z < bypassed.target.z ? 0 : Math.PI;
  await page.evaluate(({ position, viewYaw }) => window.__SF_SIM__.setRoamPose({
    x: position.x,
    z: position.z,
    yaw: viewYaw,
    pitch: 0.62,
    distance: 17,
  }), { position: bypassed.target, viewYaw: firstYaw });
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  const firstLegReached = await page.waitForFunction((targetZ) => {
    const target = window.__SF_SIM__.getInteractionState().target;
    return Math.abs(target.z - targetZ) <= 0.5;
  }, destination.z, { timeout: 30000, polling: 40 }).then(() => true).catch(() => false);
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  const firstLeg = await evidence();
  if (!firstLegReached) {
    throw new Error(`Delivery first-leg blocked: ${JSON.stringify({ travelStart, destination, bypassed, firstLeg })}`);
  }
  const finalYaw = destination.x < firstLeg.target.x ? Math.PI / 2 : -Math.PI / 2;
  await page.evaluate(({ position, viewYaw }) => window.__SF_SIM__.setRoamPose({
    x: position.x,
    z: position.z,
    yaw: viewYaw,
    pitch: 0.62,
    distance: 17,
  }), { position: firstLeg.target, viewYaw: finalYaw });
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await page.waitForFunction((targetId) => {
    const portal = window.__SF_SIM__.getInteractionState().portal;
    return portal?.id === targetId && portal.enabled === true;
  }, destination.id, { timeout: 10000, polling: 40 });
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  await page.waitForTimeout(60);
  const afterTravel = await evidence();
  const travelDistance = Math.hypot(
    afterTravel.target.x - travelStart.x,
    afterTravel.target.z - travelStart.z,
  );
  assert(travelDistance >= 10
    && Math.hypot(
      afterTravel.target.x - destination.x,
      afterTravel.target.z - destination.z,
    ) <= 8,
  'normal W + sprint input did not traverse the full assigned delivery route', {
    travelStart,
    afterTravel: afterTravel.target,
    travelDistance,
  });

  const beforeComplete = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(90);
  const completed = await evidence();
  assert(completed.delivery === null
    && completed.cash === beforeComplete.cash + 32
    && completed.transaction?.kind === 'delivery-reward'
    && completed.transaction?.amount === 32
    && completed.transaction?.cashAfter === completed.cash
    && completed.saved?.snapshot?.life?.lastTransaction?.at === completed.transaction?.at
    && completed.message.includes('BAY PARCEL COMPLETE'),
  'real destination E did not pay and save exactly one $32 delivery reward', {
    beforeComplete,
    completed,
  });

  const paidAt = completed.transaction?.at;
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const duplicateComplete = await evidence();
  assert(duplicateComplete.cash === completed.cash
    && duplicateComplete.transaction?.at === paidAt,
  'duplicate destination E paid the delivery twice', { completed, duplicateComplete });

  await reloadAndLaunch();
  const restoredComplete = await evidence();
  assert(restoredComplete.delivery === null
    && restoredComplete.cash === completed.cash
    && restoredComplete.transaction?.kind === 'delivery-reward'
    && restoredComplete.transaction?.at === paidAt,
  'reload replayed or lost the completed delivery reward', { completed, restoredComplete });

  const timeoutSetup = await page.evaluate((serviceState) => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.lifeSim.exportState();
    snapshot.deliveryCooldownRemaining = 0;
    snapshot.deliveryRun = {
      service: {
        vehicleId: serviceState.id,
        identity: serviceState.identity.key,
        label: serviceState.identity.label,
      },
      target: {
        id: 'qa-timeout-target',
        label: 'QA timeout target',
        x: sim.getInteractionState().target.x + 80,
        z: sim.getInteractionState().target.z + 80,
      },
      elapsed: 59.85,
    };
    return sim.lifeSim.importState(snapshot);
  }, service);
  assert(timeoutSetup === true, 'could not stage the bounded timeout state', timeoutSetup);
  const beforeTimeout = await evidence();
  await page.waitForTimeout(350);
  const timedOut = await evidence();
  assert(timedOut.delivery === null
    && timedOut.cash === beforeTimeout.cash
    && timedOut.transaction?.at === beforeTimeout.transaction?.at
    && timedOut.life.deliveryCooldownRemaining > 0
    && timedOut.message.includes('BAY PARCEL EXPIRED'),
  'delivery timeout paid, mutated cash, or failed to clear/cool down', { beforeTimeout, timedOut });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'delivery job slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'delivery job smoke passed'
      : 'delivery job smoke failed',
    baseUrl,
    angle,
    service,
    pursuit,
    started,
    restoredActive,
    travelDistance,
    completed,
    timedOut,
    performance,
    failures,
    consoleErrors,
    httpErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
