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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
const cdp = await page.context().newCDPSession(page);
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

async function holdTouch(locator, duration = 240) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Touch control is not visible.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }],
  });
  await page.waitForTimeout(duration);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      ride: sim.getTaxiRideState(),
      driving: sim.isDriving(),
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      life: sim.lifeSim.getState(),
      target: sim.getInteractionState().target,
      saved: sim.getSavedProgress(),
      fare: sim.getTaxiFare(),
      thefts: sim.traffic.getDiagnostics().vehicleThefts,
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  await page.waitForFunction(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.some((vehicle) => (
      vehicle.identity?.category === 'taxi'
      && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.service === 'taxi'
      && vehicle.stop?.dwellRemaining >= 2.2
      && vehicle.damage?.disabled !== true
    )), null, { timeout: 35000, polling: 40 });
  const taxi = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'taxi'
      && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.service === 'taxi'
      && vehicle.stop?.dwellRemaining >= 2.2
      && vehicle.damage?.disabled !== true
    )) || null);
  assert(taxi?.id >= 0, 'no real at-stop taxi service became available', taxi);

  const outOfRangePose = await page.evaluate((taxiPosition) => {
    const sim = window.__SF_SIM__;
    const offsets = [[10, 0], [-10, 0], [0, 10], [0, -10], [14, 14], [-14, -14]];
    return offsets
      .map(([x, z]) => ({ x: taxiPosition.x + x, z: taxiPosition.z + z }))
      .find((position) => (
        !sim.traffic.getNearestTaxiService(position, 3.8)
        && !sim.traffic.getNearestEnterableVehicle(position, 3.8)
      )) || null;
  }, taxi.position);
  assert(outOfRangePose, 'could not find an isolated out-of-range taxi pose', outOfRangePose);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), outOfRangePose);
  await page.waitForTimeout(50);
  const beforeOutOfRange = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const outOfRange = await evidence();
  assert(outOfRange.ride === null
    && outOfRange.driving === false
    && outOfRange.life?.cash === beforeOutOfRange.life?.cash
    && outOfRange.life?.lastTransaction?.at === beforeOutOfRange.life?.lastTransaction?.at
    && outOfRange.heat?.heat === beforeOutOfRange.heat?.heat,
  'out-of-range E mutated taxi/economy/heat state', { beforeOutOfRange, outOfRange });

  await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    sim.setRoamPose(position);
    sim.lifeSim.addCash(-sim.lifeSim.getState().cash);
  }, taxi.position);
  await page.waitForTimeout(50);
  const beforeBroke = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(70);
  const broke = await evidence();
  assert(broke.fare === 14
    && broke.ride === null
    && broke.driving === false
    && broke.life?.cash === 0
    && broke.life?.lastTransaction?.at === beforeBroke.life?.lastTransaction?.at
    && broke.heat?.heat === beforeBroke.heat?.heat
    && broke.message.includes('$14')
    && broke.message.includes('need more cash'),
  'insufficient-cash taxi E mutated state or lacked exact fare feedback', { beforeBroke, broke });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(100);
    sim.restartCombat();
    sim.damagePlayer(100, 'qa-taxi-ride');
  });
  await page.waitForTimeout(60);
  const beforeDowned = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const downed = await evidence();
  assert(beforeDowned.life?.cash === 100
    && beforeDowned.combat?.status === 'downed'
    && downed.ride === null
    && downed.driving === false
    && downed.life?.cash === beforeDowned.life?.cash
    && downed.life?.lastTransaction?.at === beforeDowned.life?.lastTransaction?.at,
  'downed E boarded or charged the taxi', { beforeDowned, downed });
  await page.evaluate(() => window.__SF_SIM__.restartCombat());

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.reportIncident(36, {
      kind: 'qa-taxi-pursuit',
      message: 'QA taxi pursuit gate',
      source: 'vehicle-theft',
      notify: false,
    });
  });
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim.getStreetHeatState()?.pursuitActive === true
      && sim.traffic.getPursuitResponder()?.active === true;
  }, null, { timeout: 10000, polling: 25 });
  const beforePursuit = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      ride: sim.getTaxiRideState(),
      driving: sim.isDriving(),
      heat: sim.getStreetHeatState(),
      life: sim.lifeSim.getState(),
      thefts: sim.traffic.getDiagnostics().vehicleThefts,
      responder: sim.traffic.getPursuitResponder(),
    };
  });
  await page.keyboard.press('e');
  await page.waitForTimeout(70);
  const pursuitRefusal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      ride: sim.getTaxiRideState(),
      driving: sim.isDriving(),
      heat: sim.getStreetHeatState(),
      life: sim.lifeSim.getState(),
      thefts: sim.traffic.getDiagnostics().vehicleThefts,
      responder: sim.traffic.getPursuitResponder(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
  assert(beforePursuit.heat?.pursuitActive === true
    && beforePursuit.responder?.active === true
    && pursuitRefusal.ride === null
    && pursuitRefusal.driving === false
    && pursuitRefusal.life?.cash === beforePursuit.life?.cash
    && pursuitRefusal.life?.lastTransaction?.at === beforePursuit.life?.lastTransaction?.at
    && pursuitRefusal.heat?.heat === beforePursuit.heat?.heat
    && pursuitRefusal.heat?.pursuitActive === true
    && pursuitRefusal.responder?.active === beforePursuit.responder?.active
    && pursuitRefusal.responder?.id === beforePursuit.responder?.id
    && pursuitRefusal.thefts === beforePursuit.thefts
    && pursuitRefusal.message.includes('lose the StreetHeat tail'),
  'active pursuit E boarded a taxi or mutated fare/economy/heat/responder state', {
    beforePursuit,
    pursuitRefusal,
  });
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.traffic.setPursuitResponder({
      active: false,
      position: sim.getInteractionState().target,
      playerVehicleId: null,
      level: 0,
    });
  });
  await page.waitForTimeout(80);

  const beforeBoard = await evidence();
  const boardingStartedAt = await page.evaluate(() => performance.now());
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const boarded = await evidence();
  assert(boarded.ride?.active === true
    && boarded.ride?.vehicleId === taxi.id
    && boarded.ride?.identity === taxi.identity.key
    && boarded.driving === false
    && boarded.life?.cash === beforeBoard.life?.cash
    && boarded.life?.lastTransaction?.at === beforeBoard.life?.lastTransaction?.at
    && boarded.heat?.heat === beforeBoard.heat?.heat
    && boarded.thefts === beforeBoard.thefts,
  'real E did not enter a no-charge passenger state on the service taxi', { beforeBoard, boarded });
  const touchStart = await evidence();
  await holdTouch(page.getByRole('button', { name: 'Move forward' }), 240);
  await page.getByRole('button', { name: 'Enter or exit building' }).tap();
  await page.waitForTimeout(70);
  const touchLocked = await evidence();
  assert(touchLocked.ride?.active === true
    && touchLocked.ride?.vehicleId === touchStart.ride?.vehicleId
    && touchLocked.driving === false
    && Math.hypot(
      touchLocked.target.x - touchStart.target.x,
      touchLocked.target.z - touchStart.target.z,
    ) <= 0.01
    && touchLocked.life?.cash === touchStart.life?.cash
    && touchLocked.life?.lastTransaction?.at === touchStart.life?.lastTransaction?.at
    && touchLocked.heat?.heat === touchStart.heat?.heat
    && touchLocked.thefts === touchStart.thefts
    && touchLocked.message.includes('TAXI / EN ROUTE'),
  'coarse-pointer movement or interaction escaped the active taxi ride lock', {
    touchStart,
    touchLocked,
  });
  await page.keyboard.press('e');
  await page.waitForTimeout(70);
  const duplicate = await evidence();
  assert(duplicate.ride?.active === true
    && duplicate.ride?.vehicleId === taxi.id
    && duplicate.life?.cash === boarded.life?.cash
    && duplicate.life?.lastTransaction?.at === boarded.life?.lastTransaction?.at
    && duplicate.thefts === boarded.thefts,
  'duplicate passenger E charged, stole, or replaced the taxi ride', duplicate);

  await page.waitForFunction((previousAt) => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.getState();
    return sim.getTaxiRideState() === null
      && life.lastTransaction?.kind === 'taxi-fare'
      && life.lastTransaction?.at !== previousAt;
  }, beforeBoard.life?.lastTransaction?.at ?? null, { timeout: 6000, polling: 25 });
  const arrivalAt = await page.evaluate(() => performance.now());
  const arrival = await page.evaluate((vehicleId) => {
    const sim = window.__SF_SIM__;
    const state = sim.getInteractionState();
    const portal = sim.city.portals.find((entry) => (
      String(entry.label || '').toLowerCase().includes('ferry building market hall')
    ));
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles
      .find((entry) => entry.id === vehicleId) || null;
    const ground = sim.streaming.getSurfaceHeight(state.target);
    return {
      ride: sim.getTaxiRideState(),
      driving: sim.isDriving(),
      life: sim.lifeSim.getState(),
      heat: sim.getStreetHeatState(),
      thefts: sim.traffic.getDiagnostics().vehicleThefts,
      target: state.target,
      portal: portal ? { label: portal.label, position: portal.position } : null,
      distance: portal
        ? Math.hypot(state.target.x - portal.position.x, state.target.z - portal.position.z)
        : null,
      groundError: Number.isFinite(ground) ? Math.abs(state.target.y - (ground + 4)) : null,
      taxi: vehicle,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  }, taxi.id);
  const rideSeconds = (arrivalAt - boardingStartedAt) / 1000;
  assert(rideSeconds >= 2.5 && rideSeconds <= 4
    && arrival.ride === null
    && arrival.driving === false
    && arrival.distance <= 3
    && arrival.groundError <= 0.05
    && arrival.life?.cash === beforeBoard.life?.cash - 14
    && arrival.life?.lastTransaction?.kind === 'taxi-fare'
    && arrival.life?.lastTransaction?.amount === -14
    && arrival.life?.lastTransaction?.cashAfter === arrival.life?.cash
    && arrival.saved?.snapshot?.life?.lastTransaction?.at === arrival.life?.lastTransaction?.at
    && arrival.taxi?.identity?.category === 'taxi'
    && arrival.taxi?.theft?.reported === false
    && arrival.thefts === beforeBoard.thefts
    && arrival.heat?.heat === beforeBoard.heat?.heat
    && arrival.message.includes('TAXI ARRIVAL'),
  'taxi ride did not arrive, charge/save once, or preserve taxi ownership', {
    rideSeconds,
    beforeBoard,
    arrival,
  });

  const paidAt = arrival.life?.lastTransaction?.at;
  await reloadAndLaunch();
  const restored = await evidence();
  assert(restored.ride === null
    && restored.driving === false
    && restored.life?.cash === arrival.life?.cash
    && restored.life?.lastTransaction?.kind === 'taxi-fare'
    && restored.life?.lastTransaction?.at === paidAt
    && Math.hypot(
      restored.target.x - arrival.portal.position.x,
      restored.target.z - arrival.portal.position.z,
    ) <= 3,
  'reload did not preserve the one completed fare and Ferry arrival', { arrival, restored });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'taxi ride slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'taxi ride smoke passed'
      : 'taxi ride smoke failed',
    baseUrl,
    angle,
    taxi,
    outOfRange,
    broke,
    downed,
    pursuitRefusal,
    boarded,
    touchLocked,
    duplicate,
    rideSeconds,
    arrival,
    restored,
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
    ride: window.__SF_SIM__?.getTaxiRideState?.(),
    life: window.__SF_SIM__?.lifeSim?.getState?.(),
    heat: window.__SF_SIM__?.getStreetHeatState?.(),
    driving: window.__SF_SIM__?.isDriving?.(),
  })).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
