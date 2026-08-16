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

async function findResidentCandidate() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    for (const root of sim.pedestrians.group.children) {
      if (!root.visible || !root.position) continue;
      const resident = sim.pedestrians.getNearestPerson(root.position, 0.8);
      if (!resident?.id) continue;
      const portal = sim.city.getNearestPortal(root.position, 8);
      if (portal && portal.distance <= Math.max(4.5, portal.radius || 0)) continue;
      if (sim.traffic.getNearestTaxiService(root.position, 4.2)) continue;
      if (sim.traffic.getNearestEnterableVehicle(root.position, 4.2)) continue;
      return {
        id: resident.id,
        label: resident.label,
        role: resident.role,
        distance: resident.distance,
        position: resident.position,
      };
    }
    return null;
  });
}

async function stageResident(residentId) {
  return page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    for (const root of sim.pedestrians.group.children) {
      if (!root.visible || !root.position) continue;
      const resident = sim.pedestrians.getNearestPerson(root.position, 0.8);
      if (resident?.id !== id) continue;
      sim.setRoamPose(resident.position);
      return {
        id: resident.id,
        label: resident.label,
        role: resident.role,
        distance: resident.distance,
        position: resident.position,
      };
    }
    return null;
  }, residentId);
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.getState();
    return {
      life,
      favor: life.residentFavor,
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      driving: sim.isDriving(),
      target: sim.getInteractionState().target,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
      favorHud: document.querySelector('.hud__life-favor')?.textContent || '',
      favorHudHidden: document.querySelector('.hud__life-favor')?.hidden ?? true,
    };
  });
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  await page.waitForFunction(() => window.__SF_SIM__.pedestrians
    .getNearestPerson(window.__SF_SIM__.getInteractionState().target, 1000)?.id, null, {
    timeout: 15000,
    polling: 40,
  });
  const resident = await findResidentCandidate();
  assert(resident?.id && resident?.role && Number.isFinite(resident?.position?.x),
    'no stable real resident candidate with id/role/pose was exposed', resident);

  const isolated = await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    const offsets = [[18, 0], [-18, 0], [0, 18], [0, -18], [32, 32], [-32, -32]];
    return offsets
      .map(([x, z]) => ({ x: position.x + x, z: position.z + z }))
      .find((candidate) => (
        !sim.pedestrians.getNearestPerson(candidate, 4.6)
        && !sim.traffic.getNearestTaxiService(candidate, 3.8)
        && !sim.traffic.getNearestEnterableVehicle(candidate, 3.8)
        && !sim.city.getNearestPortal(candidate, 4.5)
      )) || null;
  }, resident.position);
  assert(isolated, 'could not find isolated out-of-range resident input pose', isolated);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), isolated);
  const beforeOutOfRange = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const outOfRange = await evidence();
  assert(outOfRange.favor === null
    && outOfRange.life.cash === beforeOutOfRange.life.cash
    && outOfRange.life.lastTransaction?.at === beforeOutOfRange.life.lastTransaction?.at,
  'out-of-range E started or paid a resident favor', { beforeOutOfRange, outOfRange });

  await stageResident(resident.id);
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.restartCombat();
    sim.damagePlayer(100, 'qa-resident-favor');
  });
  await page.waitForTimeout(50);
  const beforeDowned = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const downed = await evidence();
  assert(beforeDowned.combat?.status === 'downed'
    && downed.favor === null
    && downed.life.cash === beforeDowned.life.cash
    && downed.life.lastTransaction?.at === beforeDowned.life.lastTransaction?.at,
  'downed resident E started or paid a favor', { beforeDowned, downed });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.restartCombat();
    sim.streetHeat.reportIncident(36, {
      kind: 'qa-resident-pursuit',
      source: 'vehicle-theft',
      notify: false,
    });
  });
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState()?.pursuitActive === true
    && window.__SF_SIM__.traffic.getPursuitResponder()?.active === true, null, {
    timeout: 10000,
    polling: 25,
  });
  await stageResident(resident.id);
  const beforePursuit = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const pursuit = await evidence();
  assert(beforePursuit.heat?.pursuitActive === true
    && pursuit.favor === null
    && pursuit.life.cash === beforePursuit.life.cash
    && pursuit.life.lastTransaction?.at === beforePursuit.life.lastTransaction?.at
    && pursuit.heat?.pursuitActive === true,
  'active-pursuit resident E started or paid a favor', { beforePursuit, pursuit });
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
  'four real combat hits did not defeat the resident target', defeatShots);
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
  await page.waitForTimeout(50);
  const beforeDefeatedE = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const defeatedRefusal = await evidence();
  assert(defeatedRefusal.favor === null
    && defeatedRefusal.life.cash === beforeDefeatedE.life.cash
    && defeatedRefusal.life.lastTransaction?.at === beforeDefeatedE.life.lastTransaction?.at
    && Math.abs(defeatedRefusal.life.needs.energy - beforeDefeatedE.life.needs.energy) <= 0.1
    && Math.abs(defeatedRefusal.life.needs.hunger - beforeDefeatedE.life.needs.hunger) <= 0.1
    && Math.abs(defeatedRefusal.life.needs.social - beforeDefeatedE.life.needs.social) <= 0.1
    && Math.abs(defeatedRefusal.life.needs.fun - beforeDefeatedE.life.needs.fun) <= 0.1
    && defeatedRefusal.message.includes('incapacitated'),
  'defeated resident E started or paid a favor', { beforeDefeatedE, defeatedRefusal });
  await page.evaluate(() => window.__SF_SIM__.restartCombat());

  const stagedResident = await stageResident(resident.id);
  assert(stagedResident?.id === resident.id, 'resident identity was not stable before favor start', {
    resident,
    stagedResident,
  });
  await page.waitForTimeout(40);
  const beforeStart = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(70);
  const started = await evidence();
  const targetPortal = await page.evaluate((targetId) => {
    const portal = window.__SF_SIM__.city.portals.find((entry) => entry.id === targetId);
    return portal ? { id: portal.id, label: portal.label, position: portal.position } : null;
  }, started.favor?.target?.id);
  assert(started.favor?.active === true
    && started.favor?.residentId === resident.id
    && started.favor?.residentRole === resident.role
    && started.favor?.reward === 24
    && started.favor?.duration === 45
    && targetPortal?.id === started.favor?.target?.id
    && started.life.cash === beforeStart.life.cash
    && started.life.lastTransaction?.at === beforeStart.life.lastTransaction?.at
    && started.saved?.snapshot?.life?.residentFavor?.residentId === resident.id
    && started.favorHudHidden === false
    && started.favorHud.includes('FAVOR /')
    && started.favorHud.includes('$24'),
  'real resident E did not start and immediately save one stable favor', {
    resident,
    beforeStart,
    started,
    targetPortal,
  });

  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const duplicate = await evidence();
  assert(duplicate.favor?.residentId === started.favor?.residentId
    && duplicate.favor?.target?.id === started.favor?.target?.id
    && duplicate.life.cash === started.life.cash
    && duplicate.life.lastTransaction?.at === started.life.lastTransaction?.at,
  'duplicate resident E replaced or paid the active favor', { started, duplicate });

  await page.waitForTimeout(1100);
  await reloadAndLaunch();
  const restored = await evidence();
  assert(restored.favor?.active === true
    && restored.favor?.residentId === started.favor?.residentId
    && restored.favor?.target?.id === started.favor?.target?.id
    && restored.life.cash === started.life.cash
    && restored.life.lastTransaction?.at === started.life.lastTransaction?.at,
  'active favor did not survive autosave and reload without payout', { started, restored });

  const approachStart = await page.evaluate((target) => {
    const sim = window.__SF_SIM__;
    const position = { x: target.x, z: target.z + 2.8 };
    sim.setRoamPose(position);
    return sim.getInteractionState().target;
  }, restored.favor.target);
  await page.keyboard.down('w');
  await page.waitForTimeout(220);
  await page.keyboard.up('w');
  await page.waitForTimeout(40);
  const beforeComplete = await evidence();
  const completionPortal = await page.evaluate((targetId) => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.getNearestPortal(sim.getInteractionState().target, 22);
    return portal && portal.id === targetId ? {
      id: portal.id,
      distance: portal.distance,
      radius: portal.radius,
    } : null;
  }, restored.favor.target.id);
  const movement = Math.hypot(
    beforeComplete.target.x - approachStart.x,
    beforeComplete.target.z - approachStart.z,
  );
  assert(movement >= 0.5
    && completionPortal?.distance <= completionPortal?.radius,
  'real W movement did not carry the player into the assigned portal', {
    approachStart,
    beforeComplete,
    completionPortal,
    movement,
  });
  await page.keyboard.press('e');
  await page.waitForTimeout(70);
  const completed = await evidence();
  assert(completed.favor === null
    && completed.life.cash === beforeComplete.life.cash + 24
    && Math.abs(completed.life.needs.social - (beforeComplete.life.needs.social + 14)) <= 0.1
    && Math.abs(completed.life.needs.fun - (beforeComplete.life.needs.fun + 9)) <= 0.1
    && completed.life.lastTransaction?.kind === 'resident-favor'
    && completed.life.lastTransaction?.amount === 24
    && completed.life.lastTransaction?.cashAfter === completed.life.cash
    && completed.saved?.snapshot?.life?.lastTransaction?.at === completed.life.lastTransaction?.at
    && completed.message.includes('FAVOR COMPLETE'),
  'assigned portal E did not pay, mutate needs, transact, and save exactly once', {
    beforeComplete,
    completed,
  });

  const paidAt = completed.life.lastTransaction?.at;
  await page.keyboard.press('e');
  await page.waitForTimeout(70);
  const duplicateComplete = await evidence();
  assert(duplicateComplete.life.cash === completed.life.cash
    && duplicateComplete.life.lastTransaction?.at === paidAt,
  'duplicate completion E paid the resident favor twice', { completed, duplicateComplete });
  if (duplicateComplete.target && duplicateComplete.favor === null) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
  await reloadAndLaunch();
  const restoredComplete = await evidence();
  assert(restoredComplete.favor === null
    && restoredComplete.life.cash === completed.life.cash
    && restoredComplete.life.lastTransaction?.at === paidAt,
  'completed favor reload duplicated or lost its one payout', { completed, restoredComplete });

  const timeoutResident = await findResidentCandidate();
  await stageResident(timeoutResident.id);
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const timeoutStarted = await evidence();
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.exportState();
    life.residentFavor.elapsed = 44.75;
    sim.lifeSim.importState(life);
  });
  const beforeTimeout = await evidence();
  await page.waitForFunction(() => window.__SF_SIM__.lifeSim.getState().residentFavor === null,
    null, { timeout: 2000, polling: 25 });
  const timedOut = await evidence();
  assert(timeoutStarted.favor?.active === true
    && beforeTimeout.favor?.remaining <= 0.3
    && timedOut.favor === null
    && timedOut.life.cash === beforeTimeout.life.cash
    && timedOut.life.lastTransaction?.at === beforeTimeout.life.lastTransaction?.at
    && timedOut.message.includes('FAVOR EXPIRED'),
  '45-second favor timeout paid or retained the objective', {
    timeoutStarted,
    beforeTimeout,
    timedOut,
  });

  const parkedVehicle = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.damage?.disabled !== true
    )) || null);
  assert(parkedVehicle?.id >= 0, 'no real parked vehicle was available for driving refusal', parkedVehicle);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), parkedVehicle.position);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true, null, {
    timeout: 3000,
    polling: 25,
  });
  const beforeDrivingE = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const drivingRefusal = await evidence();
  assert(beforeDrivingE.driving === true
    && drivingRefusal.driving === false
    && drivingRefusal.favor === null
    && drivingRefusal.life.cash === beforeDrivingE.life.cash
    && drivingRefusal.life.lastTransaction?.at === beforeDrivingE.life.lastTransaction?.at,
  'driving E started or paid a resident favor instead of exiting', {
    beforeDrivingE,
    drivingRefusal,
  });

  const interiorPortal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((entry) => (
      entry?.position
      && !sim.traffic.getNearestTaxiService(entry.position, 3.8)
    ));
    return portal ? { id: portal.id, position: portal.position } : null;
  });
  assert(interiorPortal?.id, 'no real portal was available for interior refusal', interiorPortal);
  await page.evaluate((entry) => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.setRoamPose(entry.position);
  }, interiorPortal);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.getInteractionState().mode === 'interior',
    null, { timeout: 3000, polling: 25 });
  const beforeInteriorE = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const interiorRefusal = await evidence();
  assert(beforeInteriorE.favor === null
    && interiorRefusal.favor === null
    && interiorRefusal.life.cash === beforeInteriorE.life.cash
    && interiorRefusal.life.lastTransaction?.at === beforeInteriorE.life.lastTransaction?.at,
  'interior E started or paid a resident favor', { beforeInteriorE, interiorRefusal });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'resident favor slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'resident favor smoke passed'
      : 'resident favor smoke failed',
    baseUrl,
    angle,
    resident,
    outOfRange,
    downed,
    pursuit,
    defeatedRefusal,
    started,
    duplicate,
    restored,
    movement,
    completed,
    duplicateComplete,
    restoredComplete,
    timedOut,
    drivingRefusal,
    interiorRefusal,
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
    favor: window.__SF_SIM__?.lifeSim?.getState?.().residentFavor,
    interaction: window.__SF_SIM__?.getInteractionState?.(),
    heat: window.__SF_SIM__?.getStreetHeatState?.(),
  })).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
