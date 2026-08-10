import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  args: ['--disable-dev-shm-usage', `--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'],
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
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(400);
}

async function stageWitnessedShot(excludedIds = []) {
  return page.evaluate((excluded) => {
    const sim = window.__SF_SIM__;
    const residents = sim.pedestrians.getCombatCandidates([]);
    const pair = residents.map((victim) => ({
      victim,
      witness: sim.pedestrians.getIncidentWitness(victim.id, 18),
    })).find((entry) => entry.witness?.id
      && !excluded.includes(entry.victim.id)
      && !excluded.includes(entry.witness.id));
    if (!pair) return null;
    const root = sim.pedestrians.group.children[pair.victim.groupIndex];
    const victimPosition = { x: root.position.x, y: root.position.y, z: root.position.z };
    const dx = pair.witness.position.x - victimPosition.x;
    const dz = pair.witness.position.z - victimPosition.z;
    const length = Math.hypot(dx, dz) || 1;
    const player = {
      x: victimPosition.x - (dx / length) * 8,
      z: victimPosition.z - (dz / length) * 8,
    };
    sim.setRoamPose(player);
    sim.pedestrians.setQaWitnessAnchor(pair.victim.id, victimPosition);
    sim.pedestrians.update(0.001, performance.now() / 1000);
    return {
      victim: { id: pair.victim.id, groupIndex: pair.victim.groupIndex },
      witness: { id: pair.witness.id, position: pair.witness.position },
      victimPosition,
      player,
    };
  }, excludedIds);
}

async function fireAt(stage) {
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.evaluate(({ player, victimPosition }) => {
    const sim = window.__SF_SIM__;
    sim.camera.position.set(player.x, victimPosition.y + 1.6, player.z);
    sim.camera.lookAt(victimPosition.x, victimPosition.y + 1.18, victimPosition.z);
    sim.camera.updateMatrixWorld(true);
  }, stage);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.getState();
    return {
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      responders: sim.traffic.getPursuitResponders(),
      primary: sim.traffic.getPursuitResponder(),
      roam: sim.getRoamState(),
      driving: sim.isDriving(),
      impound: sim.traffic.getImpoundedVehicleState(),
      transaction: life.lastTransaction,
      life,
      cash: life.cash,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
      interaction: sim.getInteractionState(),
    };
  });
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.getStats().visible > 3,
    null, { timeout: 15000, polling: 40 });

  await page.evaluate(() => {
    window.__SF_SIM__.streetHeat.restart();
    window.__SF_SIM__.combat.restart();
  });
  const first = await stageWitnessedShot();
  assert(first?.victim?.id && first?.witness?.id, 'first public gunfire pair was unavailable', first);
  if (!first?.victim?.id) throw new Error('first gunfire staging failed');
  await fireAt(first);
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().witnessReports === 1,
    null, { timeout: 5000, polling: 20 });
  await page.waitForTimeout(1900);

  const second = await stageWitnessedShot([first.victim.id, first.witness.id]);
  assert(second?.victim?.id && second?.witness?.id, 'second public gunfire pair was unavailable', second);
  if (!second?.victim?.id) throw new Error('second gunfire staging failed');
  await fireAt(second);
  await page.waitForTimeout(260);
  const secondHitRegistered = await page.evaluate(() => window.__SF_SIM__.getCombatState().hits >= 2);
  if (!secondHitRegistered) {
    await fireAt(second);
  }
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim.getCombatState().hits >= 2
      && sim.getStreetHeatState().pursuitActive
      && sim.traffic.getPursuitResponders().length > 0;
  }, null, { timeout: 12000, polling: 25 });
  const pursuit = await evidence();
  assert(pursuit.combat.hits >= 2
    && pursuit.heat.heat >= 30
    && pursuit.heat.pursuitActive === true
    && pursuit.responders.length >= 1
    && pursuit.driving === false,
  'real on-foot gunfire did not create a live pursuit', { first, second, pursuit });

  const farStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders()[0];
    sim.setRoamPose({ x: responder.position.x + 28, z: responder.position.z });
    return responder;
  });
  await page.waitForTimeout(100);
  await page.keyboard.down('x');
  await page.waitForTimeout(1400);
  await page.keyboard.up('x');
  const tooFar = await evidence();
  assert(tooFar.heat.arrests === 0
    && tooFar.heat.pursuitActive === true
    && tooFar.cash === pursuit.cash,
  'holding X outside responder range caused booking or economy mutation', { farStage, tooFar });

  const downedStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders()[0];
    sim.setRoamPose({ x: responder.position.x + 3, z: responder.position.z });
    sim.damagePlayer(100, 'qa-onfoot-surrender-negative');
    return { responder, life: sim.lifeSim.getState() };
  });
  await page.keyboard.down('x');
  await page.waitForTimeout(1400);
  await page.keyboard.up('x');
  const downed = await evidence();
  assert(downed.combat.status === 'downed'
    && downed.heat.arrests === 0
    && downed.cash === pursuit.cash
    && downed.transaction?.at === downedStage.life.lastTransaction?.at
    && downed.life.activity === downedStage.life.activity,
  'downed player could surrender or mutate the booking economy', { downedStage, downed });
  await page.evaluate(() => window.__SF_SIM__.combat.restart());

  const approachStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders()[0];
    sim.setRoamPose({ x: responder.position.x + 7, z: responder.position.z });
    return { responder, before: sim.getRoamState().target };
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(260);
  await page.keyboard.up('w');
  const approached = await evidence();
  const realApproachDistance = Math.hypot(
    approached.roam.target.x - approachStage.before.x,
    approached.roam.target.z - approachStage.before.z,
  );
  assert(realApproachDistance > 0.3
    && Math.min(...approached.heat.responderDistances) <= 10,
  'real W movement did not approach a live responder within surrender range', {
    approachStage, approached, realApproachDistance,
  });

  await page.keyboard.down('w');
  await page.keyboard.down('x');
  await page.waitForTimeout(1400);
  await page.keyboard.up('x');
  await page.keyboard.up('w');
  const moving = await evidence();
  assert(moving.heat.arrests === 0
    && moving.heat.pursuitActive === true,
  'movement did not cancel the on-foot surrender hold', moving);

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders()[0];
    sim.setRoamPose({ x: responder.position.x + 3, z: responder.position.z });
  });
  await page.waitForFunction(() => {
    const state = window.__SF_SIM__.getStreetHeatState();
    return state.pursuitActive && Math.min(...state.responderDistances) <= 10;
  }, null, { timeout: 5000, polling: 20 });
  const beforeBooking = await evidence();
  await page.keyboard.down('x');
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().arrests === 1,
    null, { timeout: 5000, polling: 20 });
  await page.keyboard.up('x');
  const booked = await evidence();
  const bookingHeat = booked.heat.lastEvent?.heatBefore ?? 0;
  const expectedDue = Math.min(120, Math.max(20, Math.ceil(20 + bookingHeat * 1.5)));
  assert(booked.heat.heat === 0
    && booked.heat.pursuitActive === false
    && booked.heat.responderCount === 0
    && booked.heat.arrests === 1
    && booked.responders.length === 0
    && booked.driving === false
    && booked.impound === null,
  'on-foot booking did not clear pursuit once without vehicle impound', { beforeBooking, booked });
  assert(booked.transaction?.kind === 'wanted-fine'
    && booked.transaction.due === expectedDue
    && booked.cash === beforeBooking.cash - booked.transaction.charged
    && booked.message.includes('ARRESTED / $')
    && booked.saved.snapshot?.streetHeat?.heat === 0
    && booked.saved.snapshot?.streetHeat?.pursuitActive === false,
  'on-foot booking did not apply and immediately save one bounded wanted fine', {
    expectedDue, beforeBooking, booked,
  });

  const transactionAt = booked.transaction?.at;
  await page.keyboard.down('x');
  await page.waitForTimeout(1400);
  await page.keyboard.up('x');
  const repeated = await evidence();
  assert(repeated.heat.arrests === 1
    && repeated.cash === booked.cash
    && repeated.transaction?.at === transactionAt,
  'repeated surrender input duplicated booking or fine', repeated);

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await evidence();
  assert(restored.heat.heat === 0
    && restored.heat.pursuitActive === false
    && restored.heat.responderCount === 0
    && restored.cash === booked.cash
    && restored.transaction?.at === transactionAt
    && restored.impound === null,
  'reload replayed or lost cleared on-foot booking state', restored);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1400);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'on-foot arrest exceeded application frame budget', performance);

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    pursuit,
    tooFar,
    downed,
    approached: { realApproachDistance, heat: approached.heat },
    moving,
    beforeBooking,
    booked,
    repeated,
    restored,
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
