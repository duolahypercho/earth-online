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

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.getState();
    return {
      needs: { ...life.needs },
      cash: life.cash,
      activity: life.activity,
      cooldown: life.residentTalkCooldownRemaining,
      transaction: life.lastTransaction,
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      driving: sim.isDriving(),
      mode: sim.getInteractionState().mode,
      target: sim.getInteractionState().target,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function findResident() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    for (const root of sim.pedestrians.group.children) {
      if (!root.visible || !root.position) continue;
      const resident = sim.pedestrians.getNearestPerson(root.position, 0.8);
      if (!resident?.id) continue;
      if (sim.city.getNearestPortal(root.position, 5)?.distance <= 5) continue;
      if (sim.traffic.getNearestEnterableVehicle(root.position, 4.2)) continue;
      return {
        id: resident.id,
        role: resident.role,
        position: resident.position,
      };
    }
    return null;
  });
}

async function stageResident(residentId, includeDefeated = false) {
  return page.evaluate(({ id, include }) => {
    const sim = window.__SF_SIM__;
    for (const root of sim.pedestrians.group.children) {
      if (!root.visible || !root.position) continue;
      const resident = sim.pedestrians.getNearestPerson(
        root.position,
        0.8,
        { includeDefeated: include },
      );
      if (resident?.id !== id) continue;
      sim.setRoamPose(resident.position);
      return { id: resident.id, position: resident.position };
    }
    return null;
  }, { id: residentId, include: includeDefeated });
}

function needsEqual(a, b, tolerance = 0.12) {
  return ['energy', 'hunger', 'social', 'fun'].every(
    (key) => Math.abs(a[key] - b[key]) <= tolerance,
  );
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.group.children
    .some((root) => root.visible), null, { timeout: 15000, polling: 40 });

  const resident = await findResident();
  assert(resident?.id && Number.isFinite(resident?.position?.x),
    'no stable living resident was exposed', resident);

  const isolated = await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    const offsets = [[18, 0], [-18, 0], [0, 18], [0, -18], [28, 28], [-28, -28]];
    return offsets.map(([x, z]) => ({ x: position.x + x, z: position.z + z }))
      .find((candidate) => (
        !sim.pedestrians.getNearestPerson(candidate, 4.6)
        && !sim.lifeSim.canEat(candidate)
        && !sim.lifeSim.canWork(candidate)
        && !sim.city.getNearestPortal(candidate, 5)
        && !sim.streaming.getNearestEnterablePortal(candidate, 5)
        && !sim.traffic.getNearestEnterableVehicle(candidate, 4.2)
      )) || null;
  }, resident.position);
  assert(isolated, 'no isolated out-of-range talk pose was found', isolated);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), isolated);
  const beforeOutOfRange = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(70);
  const outOfRange = await evidence();
  assert(needsEqual(outOfRange.needs, beforeOutOfRange.needs)
    && outOfRange.cash === beforeOutOfRange.cash
    && outOfRange.transaction?.at === beforeOutOfRange.transaction?.at,
  'out-of-range T mutated life state', { beforeOutOfRange, outOfRange });

  await stageResident(resident.id);
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.lifeSim.exportState();
    snapshot.needs = { energy: 80, hunger: 50, social: 40, fun: 40 };
    snapshot.residentTalkCooldownRemaining = 0;
    snapshot.residentFavor = null;
    snapshot.deliveryRun = null;
    sim.lifeSim.importState(snapshot);
    sim.restartCombat();
    sim.streetHeat.restart();
  });
  const beforeTalk = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(80);
  const talked = await evidence();
  assert(Math.abs(talked.needs.social - (beforeTalk.needs.social + 20)) <= 0.12
    && Math.abs(talked.needs.fun - (beforeTalk.needs.fun + 7)) <= 0.12
    && Math.abs(talked.needs.energy - (beforeTalk.needs.energy - 2)) <= 0.12
    && Math.abs(talked.needs.hunger - beforeTalk.needs.hunger) <= 0.12
    && talked.activity === `talk:${resident.id}`
    && talked.cooldown > 3.8
    && talked.cash === beforeTalk.cash
    && talked.heat?.heat === beforeTalk.heat?.heat
    && talked.transaction?.at === beforeTalk.transaction?.at
    && talked.saved?.snapshot?.life?.lastActivity === `talk:${resident.id}`
    && talked.message.includes('chatted'),
  'real T did not apply and save the exact resident talk result', { beforeTalk, talked });

  await page.keyboard.down('t');
  await page.keyboard.down('t');
  await page.waitForTimeout(80);
  await page.keyboard.up('t');
  const repeated = await evidence();
  assert(needsEqual(repeated.needs, talked.needs)
    && repeated.activity === talked.activity,
  'held/repeated T bypassed resident talk debounce', { talked, repeated });

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await evidence();
  assert(needsEqual(restored.needs, talked.needs)
    && restored.activity === talked.activity
    && restored.cooldown > 0,
  'reload did not preserve resident talk needs/activity/cooldown', { talked, restored });

  await stageResident(resident.id);
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.lifeSim.exportState();
    snapshot.residentTalkCooldownRemaining = 0;
    sim.lifeSim.importState(snapshot);
    sim.streetHeat.reportIncident(36, {
      kind: 'qa-resident-talk-pursuit',
      source: 'vehicle-theft',
      notify: false,
    });
  });
  const beforePursuit = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(70);
  const pursuit = await evidence();
  assert(beforePursuit.heat?.pursuitActive === true
    && needsEqual(pursuit.needs, beforePursuit.needs),
  'active-pursuit T talked to a resident', { beforePursuit, pursuit });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.traffic.setPursuitResponder({ active: false, position: sim.getInteractionState().target });
    sim.restartCombat();
    sim.damagePlayer(100, 'qa-resident-talk');
  });
  const beforeDowned = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(70);
  const downed = await evidence();
  assert(beforeDowned.combat?.status === 'downed'
    && needsEqual(downed.needs, beforeDowned.needs),
  'downed T talked to a resident', { beforeDowned, downed });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.restartCombat();
    const snapshot = sim.lifeSim.exportState();
    snapshot.residentTalkCooldownRemaining = 0;
    snapshot.residentFavor = {
      residentId: 'qa-active-job',
      residentLabel: 'QA Resident',
      residentRole: 'worker',
      target: { id: 'qa-target', label: 'QA Target', x: 0, z: 0 },
      elapsed: 1,
    };
    sim.lifeSim.importState(snapshot);
  });
  await stageResident(resident.id);
  const beforeJob = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(70);
  const activeJob = await evidence();
  assert(needsEqual(activeJob.needs, beforeJob.needs)
    && activeJob.activity === beforeJob.activity,
  'active-job T talked to a resident', { beforeJob, activeJob });

  const drivingCandidate = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.lifeSim.exportState();
    snapshot.residentFavor = null;
    snapshot.deliveryRun = null;
    snapshot.residentTalkCooldownRemaining = 0;
    sim.lifeSim.importState(snapshot);
    return sim.traffic.getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.disabled !== true
    )) || null;
  });
  assert(drivingCandidate?.id >= 0, 'no parked private vehicle was available', drivingCandidate);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), drivingCandidate.position);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true, null, {
    timeout: 5000,
    polling: 25,
  });
  await stageResident(resident.id);
  const beforeDriving = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(70);
  const driving = await evidence();
  assert(beforeDriving.driving === true
    && driving.activity === beforeDriving.activity
    && driving.cooldown === 0
    && driving.cash === beforeDriving.cash
    && driving.transaction?.at === beforeDriving.transaction?.at,
  'driving T talked to a resident', { beforeDriving, driving });
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === false, null, {
    timeout: 5000,
    polling: 25,
  });

  const interiorPortal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((candidate) => candidate.featured && candidate.room)
      ?? sim.city.portals.find((candidate) => candidate.room);
    const route = portal?.approachRoute || [];
    const point = route[route.length - 1] || portal?.position;
    if (!portal || !point) return null;
    sim.setRoamPose({ x: point.x, z: point.z });
    return { id: portal.id, position: point };
  });
  assert(interiorPortal?.id, 'no enterable interior portal was available', interiorPortal);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.city.getInteriorState()?.active === true, null, {
    timeout: 7000,
    polling: 25,
  });
  const beforeInterior = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(70);
  const interior = await evidence();
  assert(beforeInterior.mode === 'interior'
    && needsEqual(interior.needs, beforeInterior.needs)
    && interior.activity === beforeInterior.activity,
  'interior T talked to a resident', { beforeInterior, interior });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__SF_SIM__.city.getInteriorState()?.active === false, null, {
    timeout: 7000,
    polling: 25,
  });

  await stageResident(resident.id);
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.restartCombat();
    sim.streetHeat.restart();
    const snapshot = sim.lifeSim.exportState();
    snapshot.residentFavor = null;
    snapshot.deliveryRun = null;
    snapshot.residentTalkCooldownRemaining = 0;
    sim.lifeSim.importState(snapshot);
  });
  const defeatShots = [];
  for (let shotIndex = 0; shotIndex < 4; shotIndex += 1) {
    if (shotIndex > 0) await page.waitForTimeout(240);
    defeatShots.push(await page.evaluate((residentId) => {
      const sim = window.__SF_SIM__;
      const root = sim.pedestrians.group.children.find((candidate) => {
        const nearby = sim.pedestrians.getNearestPerson(
          candidate.position,
          0.8,
          { includeDefeated: true },
        );
        return nearby?.id === residentId;
      });
      if (!root) throw new Error(`resident root ${residentId} unavailable for combat`);
      const player = { x: root.position.x, z: root.position.z + 6 };
      sim.setRoamPose(player);
      sim.setCombatAim(true);
      sim.camera.position.set(player.x, root.position.y + 1.6, player.z);
      sim.camera.lookAt(root.position.x, root.position.y + 1.1, root.position.z);
      sim.camera.updateMatrixWorld(true);
      return {
        fire: sim.fireCombat(),
        defeated: root.userData?.combatDefeated === true,
        disabled: root.userData?.combatDisabled === true,
        position: { x: root.position.x, y: root.position.y, z: root.position.z },
      };
    }, resident.id));
  }
  const defeatedResident = defeatShots.at(-1);
  assert(defeatShots.every((shot) => shot.fire?.fired === true && shot.fire?.hit === true)
    && defeatedResident?.defeated === true
    && defeatedResident?.disabled === true,
  'four real combat hits did not defeat the talk target', defeatShots);
  await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.traffic.setPursuitResponder({
      active: false,
      position,
      playerVehicleId: null,
      level: 0,
    });
    sim.setCombatAim(false);
    sim.setRoamPose(position);
  }, defeatedResident.position);
  const beforeDefeated = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(70);
  const defeated = await evidence();
  assert(needsEqual(defeated.needs, beforeDefeated.needs)
    && defeated.activity === beforeDefeated.activity
    && defeated.message.includes('incapacitated'),
  'defeated resident T mutated life state', { beforeDefeated, defeated });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.restartCombat();
    const snapshot = sim.lifeSim.exportState();
    snapshot.residentTalkCooldownRemaining = 0;
    snapshot.residentFavor = null;
    snapshot.deliveryRun = null;
    snapshot.needs = { energy: 76, hunger: 50, social: 35, fun: 38 };
    sim.lifeSim.importState(snapshot);
  });
  await stageResident(resident.id);
  await page.waitForFunction(() => {
    const button = document.querySelector('.hud__interaction');
    return button && !button.hidden && button.textContent.includes('TALK');
  }, null, { timeout: 5000, polling: 25 });
  const beforeTouch = await evidence();
  await page.locator('.hud__interaction').click();
  await page.waitForTimeout(80);
  const touched = await evidence();
  assert(Math.abs(touched.needs.social - (beforeTouch.needs.social + 20)) <= 0.12
    && Math.abs(touched.needs.fun - (beforeTouch.needs.fun + 7)) <= 0.12
    && Math.abs(touched.needs.energy - (beforeTouch.needs.energy - 2)) <= 0.12
    && touched.activity === `talk:${resident.id}`
    && touched.saved?.snapshot?.life?.lastActivity === `talk:${resident.id}`,
  'HUD touch talk did not apply and save the exact result', { beforeTouch, touched });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    (window.__SF_SIM__.getPerformanceSnapshot?.()?.applicationFrameCount || 0) >= 180
  ), null, { timeout: 10000, polling: 100 });
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'resident talk slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'resident talk smoke passed'
      : 'resident talk smoke failed',
    baseUrl,
    angle,
    resident,
    talked,
    restored,
    pursuit,
    downed,
    activeJob,
    driving,
    interior,
    defeated,
    touched,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'resident talk smoke passed') process.exitCode = 1;
} finally {
  await browser.close();
}
