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

async function holdTouch(locator, duration = 220) {
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

async function waitForBus() {
  await page.waitForFunction(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.some((vehicle) => (
      vehicle.class === 'bus'
      && vehicle.visible === true
      && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.cue === 'transit-stop'
      && vehicle.stop?.service === 'transit'
      && vehicle.stop?.dwellRemaining >= 3
      && vehicle.damage?.disabled !== true
    )), null, { timeout: 65000, polling: 40 });
  return page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.class === 'bus'
      && vehicle.visible === true
      && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.cue === 'transit-stop'
      && vehicle.stop?.service === 'transit'
      && vehicle.stop?.dwellRemaining >= 3
      && vehicle.damage?.disabled !== true
    )) || null);
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      ride: sim.getMuniRideState(),
      driving: sim.isDriving(),
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      life: sim.lifeSim.getState(),
      target: sim.getInteractionState().target,
      saved: sim.getSavedProgress(),
      fare: sim.getMuniFare(),
      thefts: sim.traffic.getDiagnostics().vehicleThefts,
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function stageAtBus(bus) {
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), bus.position);
  await page.waitForTimeout(60);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  const firstBus = await waitForBus();
  assert(firstBus?.id >= 0, 'no live visible Muni transit dwell became available', firstBus);
  await stageAtBus(firstBus);

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(-sim.lifeSim.getState().cash);
  });
  const brokeBefore = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const broke = await evidence();
  assert(broke.fare === 3
    && broke.ride === null
    && broke.life.cash === 0
    && broke.life.lastTransaction?.at === brokeBefore.life.lastTransaction?.at
    && broke.heat.heat === brokeBefore.heat.heat
    && broke.message.includes('$3')
    && broke.message.includes('need more cash'),
  'broke Muni boarding mutated state or lacked exact fare feedback', { brokeBefore, broke });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(40);
    sim.restartCombat();
    sim.damagePlayer(100, 'qa-muni-downed');
  });
  const downedBefore = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(50);
  const downed = await evidence();
  assert(downedBefore.combat.status === 'downed'
    && downed.ride === null
    && downed.life.cash === downedBefore.life.cash
    && downed.life.lastTransaction?.at === downedBefore.life.lastTransaction?.at,
  'downed E boarded or charged Muni', { downedBefore, downed });
  await page.evaluate(() => window.__SF_SIM__.restartCombat());

  await page.evaluate(() => window.__SF_SIM__.streetHeat.reportIncident(36, {
    kind: 'qa-muni-pursuit', source: 'vehicle-theft', message: 'QA Muni pursuit', notify: false,
  }));
  const pursuitBefore = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(50);
  const pursuit = await evidence();
  assert(pursuitBefore.heat.pursuitActive === true
    && pursuit.ride === null
    && pursuit.life.cash === pursuitBefore.life.cash
    && pursuit.life.lastTransaction?.at === pursuitBefore.life.lastTransaction?.at
    && pursuit.heat.heat === pursuitBefore.heat.heat,
  'active-pursuit E boarded Muni or mutated state', { pursuitBefore, pursuit });
  await page.evaluate(() => window.__SF_SIM__.streetHeat.restart());

  const beforeBoard = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(70);
  const boarded = await evidence();
  assert(boarded.ride?.active === true
    && boarded.ride.vehicleId === firstBus.id
    && boarded.ride.identity === firstBus.identity.key
    && boarded.driving === false
    && boarded.life.cash === beforeBoard.life.cash
    && boarded.life.lastTransaction?.at === beforeBoard.life.lastTransaction?.at
    && boarded.heat.heat === beforeBoard.heat.heat
    && boarded.thefts === beforeBoard.thefts,
  'real E did not board the live bus without a pre-arrival charge', { beforeBoard, boarded });

  await page.keyboard.press('e');
  await page.keyboard.down('w');
  await page.keyboard.down('a');
  await page.waitForTimeout(180);
  await page.keyboard.up('a');
  await page.keyboard.up('w');
  await holdTouch(page.getByRole('button', { name: 'Move forward' }), 220);
  await page.getByRole('button', { name: 'Enter or exit building' }).tap();
  const canvasBox = await page.locator('canvas').boundingBox();
  if (!canvasBox) throw new Error('Game canvas unavailable for passenger combat-lock probe.');
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.55, canvasBox.y + canvasBox.height * 0.48);
  await page.mouse.down({ button: 'right' });
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(90);
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(60);
  const locked = await evidence();
  assert(locked.ride?.active === true
    && locked.ride.vehicleId === boarded.ride.vehicleId
    && Math.hypot(locked.target.x - boarded.target.x, locked.target.z - boarded.target.z) <= 0.10
    && locked.combat.active === false
    && locked.combat.aiming === false
    && locked.combat.ammo === boarded.combat.ammo
    && locked.combat.shots === boarded.combat.shots
    && locked.life.cash === boarded.life.cash
    && locked.life.lastTransaction?.at === boarded.life.lastTransaction?.at
    && locked.heat.heat === boarded.heat.heat,
  'keyboard/touch/pointer/duplicate E escaped the Muni ride lock', { boarded, locked });

  await page.waitForTimeout(1100);
  const inflight = await evidence();
  assert(inflight.ride?.active === true
    && inflight.life.cash === beforeBoard.life.cash
    && inflight.life.lastTransaction?.at === beforeBoard.life.lastTransaction?.at,
  'in-flight Muni ride charged before arrival', inflight);
  await reloadAndLaunch();
  const transientReload = await evidence();
  assert(transientReload.ride === null
    && transientReload.life.cash === beforeBoard.life.cash
    && transientReload.life.lastTransaction?.kind !== 'muni-fare',
  'reload replayed or charged the transient in-flight Muni ride', transientReload);

  const bus = await waitForBus();
  assert(bus?.id >= 0, 'no second live Muni dwell became available after reload', bus);
  await stageAtBus(bus);
  const arrivalBefore = await evidence();
  await page.keyboard.press('e');
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim.getMuniRideState() === null
      && sim.lifeSim.getState().lastTransaction?.kind === 'muni-fare';
  }, null, { timeout: 65000, polling: 30 });
  const arrival = await page.evaluate((busId) => {
    const sim = window.__SF_SIM__;
    const state = sim.getInteractionState();
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => entry.id === busId);
    const ground = sim.streaming.getSurfaceHeight(state.target);
    return {
      ride: sim.getMuniRideState(),
      life: sim.lifeSim.getState(),
      heat: sim.getStreetHeatState(),
      driving: sim.isDriving(),
      target: state.target,
      ground,
      vehicle,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  }, bus.id);
  const busTravel = Math.hypot(
    arrival.vehicle.position.x - bus.position.x,
    arrival.vehicle.position.z - bus.position.z,
  );
  const arrivalDistance = Math.hypot(
    arrival.target.x - arrival.vehicle.position.x,
    arrival.target.z - arrival.vehicle.position.z,
  );
  assert(arrival.ride === null
    && arrival.driving === false
    && arrival.vehicle.id === bus.id
    && arrival.vehicle.class === 'bus'
    && arrival.vehicle.stop.cue === 'transit-stop'
    && busTravel >= 8
    && arrivalDistance <= 5
    && Math.abs(arrival.target.y - (arrival.ground + 4)) <= 0.05
    && arrival.life.cash === arrivalBefore.life.cash - 3
    && arrival.life.lastTransaction?.kind === 'muni-fare'
    && arrival.life.lastTransaction?.amount === -3
    && arrival.saved.snapshot?.life?.lastTransaction?.at === arrival.life.lastTransaction.at
    && arrival.heat.heat === arrivalBefore.heat.heat
    && arrival.message.includes('MUNI ARRIVAL')
    && arrival.message.includes('$3 paid'),
  'next-stop arrival did not preserve bus identity, contact, fare, heat, and save', {
    bus,
    busTravel,
    arrivalDistance,
    arrival,
  });

  const paidAt = arrival.life.lastTransaction.at;
  const paidCash = arrival.life.cash;
  await reloadAndLaunch();
  const completedReload = await evidence();
  assert(completedReload.ride === null
    && completedReload.life.cash === paidCash
    && completedReload.life.lastTransaction?.kind === 'muni-fare'
    && completedReload.life.lastTransaction?.at === paidAt,
  'completed Muni fare did not persist idempotently across reload', completedReload);

  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'application p99 exceeded 16.67 ms', performance);

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    firstBus,
    bus,
    locked,
    transientReload,
    arrival: { ...arrival, busTravel, arrivalDistance },
    completedReload,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
