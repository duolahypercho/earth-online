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
  if (message.type() === 'error' && !message.text().includes('/favicon.ico')) consoleErrors.push(message.text());
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
  await page.waitForTimeout(300);
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responders = sim.traffic.getPursuitResponders();
    const vehicles = sim.traffic.getVehicleLifeSnapshot().vehicles;
    return {
      heat: sim.getStreetHeatState(),
      primary: sim.traffic.getPursuitResponder(),
      responders,
      records: responders.map((responder) => vehicles.find((vehicle) => vehicle.id === responder.id)),
      saved: sim.getSavedProgress(),
    };
  });
}

async function setHeat(delta, kind) {
  await page.evaluate(({ amount, eventKind }) => window.__SF_SIM__.streetHeat.reportIncident(amount, {
    kind: eventKind,
    source: 'combat',
    message: `QA ${eventKind}`,
    notify: false,
  }), { amount: delta, eventKind: kind });
}

async function waitForLevel(level) {
  await page.waitForFunction((expected) => {
    const sim = window.__SF_SIM__;
    const heat = sim.getStreetHeatState();
    return heat.level === expected
      && heat.responderCount === expected
      && sim.traffic.getPursuitResponders().length === expected;
  }, level, { timeout: 12000, polling: 25 });
  return evidence();
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  // Keep a small margin above each threshold so ordinary combat heat decay
  // cannot demote the level between the incident and the responder assertion.
  await setHeat(32, 'qa-level-one');
  const levelOne = await waitForLevel(1);
  await setHeat(30, 'qa-level-two');
  const levelTwo = await waitForLevel(2);
  await setHeat(25, 'qa-level-three');
  const levelThree = await waitForLevel(3);

  const eligible = levelThree.records.every((vehicle) => (
    vehicle
    && vehicle.visible !== false
    && vehicle.action?.key === 'pursuit-responder'
    && vehicle.damage?.disabled !== true
    && vehicle.class !== 'bike'
    && vehicle.class !== 'bus'
    && vehicle.class !== 'truck'
    && vehicle.class !== 'taxi'
    && vehicle.identity?.category !== 'delivery'
    && vehicle.action?.key !== 'parked'
    && vehicle.action?.key !== 'garage-stored'
    && vehicle.action?.key !== 'impounded'
  ));
  assert(levelOne.responders.length === 1
    && levelTwo.responders.length === 2
    && levelThree.responders.length === 3
    && new Set(levelThree.responders.map((entry) => entry.id)).size === 3
    && levelThree.primary.id === levelThree.responders[0].id
    && eligible,
  'heat levels did not produce 1/2/3 distinct eligible responders', {
    levelOne, levelTwo, levelThree, eligible,
  });

  const positionsBefore = new Map(levelThree.responders.map((entry) => [entry.id, entry.position]));
  await page.waitForTimeout(750);
  const stable = await evidence();
  const stableIds = stable.responders.map((entry) => entry.id);
  const movement = stable.responders.map((entry) => {
    const before = positionsBefore.get(entry.id);
    return before ? Math.hypot(entry.position.x - before.x, entry.position.z - before.z) : 0;
  });
  assert(JSON.stringify(stableIds) === JSON.stringify(levelThree.responders.map((entry) => entry.id))
    && movement.some((distance) => distance > 0.2),
  'level-three responders were duplicated, reassigned, or mechanically static', { stableIds, movement });

  await page.evaluate(() => window.__SF_SIM__.saveProgress());
  const saved = await page.evaluate(() => window.__SF_SIM__.getSavedProgress());
  assert(saved.snapshot?.streetHeat?.heat >= 82
    && saved.snapshot?.streetHeat?.pursuitActive === true
    && saved.snapshot?.streetHeat?.responderIds === undefined,
  'pursuit save did not preserve heat while keeping responder IDs transient', saved);

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await waitForLevel(3);
  assert(restored.heat.heat >= 82
    && restored.heat.responderCount === 3
    && new Set(restored.responders.map((entry) => entry.id)).size === 3,
  'reload did not reacquire three transient responders from persisted heat', restored);

  const validSnapshot = await page.evaluate(() => JSON.stringify(
    window.__SF_SIM__.getSavedProgress().snapshot,
  ));
  const beforeInvalid = await evidence();
  const invalidAccepted = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.getSavedProgress().snapshot;
    snapshot.streetHeat = { ...snapshot.streetHeat, pursuitActive: true, heat: 0 };
    window.localStorage.setItem('earth-online-player-progress-v1', JSON.stringify(snapshot));
    return sim.restoreProgress();
  });
  await page.waitForFunction((expectedCount) => (
    window.__SF_SIM__.getStreetHeatState().responderCount === expectedCount
  ), beforeInvalid.heat.responderCount, { timeout: 5000, polling: 25 });
  const afterInvalid = await evidence();
  assert(invalidAccepted === false
    && afterInvalid.heat.heat === beforeInvalid.heat.heat
    && afterInvalid.heat.responderCount === beforeInvalid.heat.responderCount,
  'malformed pursuit restore was not rejected transactionally', { beforeInvalid, afterInvalid });

  const arrestCandidate = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
    )) || null);
  assert(arrestCandidate?.id >= 0, 'no parked private vehicle was available for level-three arrest', arrestCandidate);
  const stagedBackup = await page.evaluate((candidate) => {
    const sim = window.__SF_SIM__;
    const responders = sim.traffic.getPursuitResponders();
    const primary = responders[0];
    const backup = responders.slice(1).sort((a, b) => {
      const aDistance = Math.hypot(a.position.x - primary.position.x, a.position.z - primary.position.z);
      const bDistance = Math.hypot(b.position.x - primary.position.x, b.position.z - primary.position.z);
      return bDistance - aDistance;
    })[0];
    sim.setRoamPose(candidate.position);
    const entered = sim.enterCar();
    const snapshot = sim.traffic.exportPlayerVehicleState();
    const backupRoot = sim.traffic.group.children[backup.id];
    snapshot.position = {
      x: backup.position.x + Math.sin(backupRoot.rotation.y) * 3,
      z: backup.position.z + Math.cos(backupRoot.rotation.y) * 3,
    };
    snapshot.heading = backupRoot.rotation.y;
    return {
      entered: Boolean(entered),
      imported: entered ? sim.traffic.importPlayerVehicleState(snapshot) : false,
      primary,
      backup,
    };
  }, arrestCandidate);
  assert(stagedBackup.entered === true && stagedBackup.imported === true,
    'could not stage player beside backup responder', stagedBackup);
  await page.waitForFunction(() => window.__SF_SIM__.isDriving(), null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const state = window.__SF_SIM__.getStreetHeatState();
    return state.level === 3
      && state.responderCount === 3
      && state.responderDistance > 10
      && Math.min(...state.responderDistances) <= 10;
  }, null, { timeout: 5000, polling: 25 });
  const beforeArrest = await evidence();
  await page.keyboard.down('s');
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().arrests === 1,
    null, { timeout: 5000, polling: 25 });
  await page.keyboard.up('s');
  await page.waitForFunction(() => window.__SF_SIM__.traffic.getPursuitResponders().length === 0,
    null, { timeout: 5000 });
  const cleared = await evidence();
  assert(beforeArrest.heat.responderDistance > 10
    && Math.min(...beforeArrest.heat.responderDistances) <= 10
    && cleared.heat.pursuitActive === false
    && cleared.heat.arrests === 1
    && cleared.heat.responderCount === 0
    && cleared.responders.length === 0,
  'backup-responder surrender did not arrest once and clear the full pool', {
    stagedBackup, beforeArrest, cleared,
  });

  await page.evaluate((snapshot) => {
    window.localStorage.setItem('earth-online-player-progress-v1', snapshot);
    window.__SF_SIM__.streetHeat.restart();
  }, validSnapshot);
  await page.waitForFunction(() => window.__SF_SIM__.traffic.getPursuitResponders().length === 0,
    null, { timeout: 5000 });
  const restarted = await evidence();
  assert(restarted.heat.pursuitActive === false
    && restarted.heat.responderCount === 0
    && restarted.responders.length === 0,
  'pursuit restart did not release every responder', restarted);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1200);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(performance.applicationP99FrameMs <= 16.67,
    'application p99 exceeded 16.67 ms', performance);
  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    levelOne,
    levelTwo,
    levelThree,
    stable: { ids: stableIds, movement },
    restored,
    beforeArrest,
    cleared,
    restarted,
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
