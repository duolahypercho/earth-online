import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
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
const consoleErrors = [];
const httpErrors = [];
const failures = [];
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
page.on('requestfailed', (request) => {
  if (!request.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  }
});

let responderId = null;
let perfStartedAt = 0;
let perfFrameStart = null;

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled,
    // Shader compilation on the full streamed city can exceed 30 seconds on
    // headless Metal even though the application remains healthy.
    null,
    { timeout: 60000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(1200);

  const initial = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      combat: sim.getCombatState(),
      combatAudio: sim.getCombatAudioState?.(),
      heat: sim.getStreetHeatState(),
      driving: sim.isDriving?.() === true,
      simReady: Boolean(sim.traffic && sim.combat && sim.streetHeat),
    };
  });
  assert(initial.simReady, 'public simulation API did not initialize', initial);
  assert(initial.driving === false, 'smoke must start on foot', initial);
  assert(initial.heat?.heat === 0, 'street heat did not start at zero', initial.heat);
  assert(initial.heat?.pursuitActive === false, 'street heat started in pursuit', initial.heat);

  // Stage a parked, visible traffic actor at a stable eight-metre shot. The
  // camera pose is only a QA staging aid; the shot still goes through the
  // public combat raycast, reaction, and StreetHeat ingress APIs.
  const setup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.getVehicleLifeSnapshot();
    const candidate = snapshot.vehicles.find((vehicle) => (
      vehicle.visible
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
    )) || snapshot.vehicles.find((vehicle) => vehicle.visible && vehicle.class !== 'bike');
    if (!candidate) throw new Error('no visible light traffic target for combat smoke');
    const root = sim.traffic.group.children[candidate.id];
    if (!root?.position) throw new Error(`traffic root ${candidate.id} unavailable`);
    const player = {
      x: root.position.x - Math.sin(root.rotation.y) * 8,
      z: root.position.z - Math.cos(root.rotation.y) * 8,
    };
    const target = {
      x: root.position.x,
      y: root.position.y + 0.82,
      z: root.position.z,
    };
    sim.setRoamPose(player);
    sim.setCombatAim(true);
    sim.resetPerformanceTelemetry?.();
    return {
      id: candidate.id,
      class: candidate.class,
      label: candidate.identity?.label || candidate.class,
      player,
      target,
    };
  });
  perfStartedAt = Date.now();
  perfFrameStart = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot()?.frameCount ?? null);

  const shotResults = [];
  for (let index = 0; index < 4; index += 1) {
    if (index > 0) await page.waitForTimeout(240);
    const shot = await page.evaluate((pose) => {
      const sim = window.__SF_SIM__;
      const root = sim.traffic.group.children[pose.id];
      const target = {
        x: root.position.x,
        y: root.position.y + 0.82,
        z: root.position.z,
      };
      sim.camera.position.set(pose.player.x, root.position.y + 1.6, pose.player.z);
      sim.camera.lookAt(target.x, target.y, target.z);
      sim.camera.updateMatrixWorld(true);
      const fire = sim.fireCombat();
      return {
        fire,
        combat: sim.getCombatState(),
        heat: sim.getStreetHeatState(),
        combatAudio: sim.getCombatAudioState?.(),
        targetState: fire.targetId ? sim.getCombatTargetState?.(fire.targetId) : null,
        targetConsequence: {
          disabled: root.userData?.combatDisabled === true,
          defeated: root.userData?.combatDefeated === true,
          reaction: root.userData?.combatReaction || null,
          brakeUntil: root.userData?.combatBrakeUntil ?? null,
        },
      };
    }, setup);
    shotResults.push(shot);
  }

  const afterShots = shotResults.at(-1);
  assert(shotResults.some((shot) => shot.fire?.fired === true), 'no shot fired', shotResults);
  assert(shotResults.some((shot) => shot.fire?.hit === true), 'no combat hit registered', shotResults);
  assert(afterShots.combat?.shots > 0, 'combat state reports zero shots', afterShots.combat);
  assert(afterShots.combat?.hits > 0, 'combat state reports zero hits', afterShots.combat);
  assert(afterShots.combat?.defeats === 1, 'combat state did not record exactly one defeat', afterShots.combat);
  assert(afterShots.combat?.lastDefeat?.consequence === 'vehicle-disabled',
    'combat state did not expose the vehicle-disabled consequence', afterShots.combat);
  assert(afterShots.targetState?.defeated === true && afterShots.targetState?.targetable === false,
    'defeated target remained targetable', afterShots.targetState);
  assert(afterShots.targetState?.consequence === 'vehicle-disabled',
    'target state did not retain its consequence', afterShots.targetState);
  assert(afterShots.targetConsequence?.disabled === true
    && afterShots.targetConsequence?.defeated === true,
  'traffic root did not receive persistent combat disable flags', afterShots.targetConsequence);
  assert(afterShots.targetConsequence?.reaction === 'staggered'
    && Number(afterShots.targetConsequence?.brakeUntil) > 1e9,
  'disabled traffic did not retain its stopped reaction', afterShots.targetConsequence);
  assert(afterShots.heat?.heat > initial.heat.heat, 'combat shots did not increase numeric StreetHeat', {
    before: initial.heat,
    after: afterShots.heat,
  });
  assert(afterShots.heat?.pursuitActive === true, 'real hits did not escalate StreetHeat into pursuit', afterShots.heat);
  assert(shotResults[0].heat?.pursuitActive === false, 'StreetHeat was already active before shot sequence', shotResults[0].heat);
  assert((afterShots.combatAudio?.cueCounts?.shot ?? 0) >= 4,
    'combat audio hook did not receive every shot', afterShots.combatAudio);
  assert((afterShots.combatAudio?.cueCounts?.impact ?? 0) >= 4,
    'combat audio hook did not receive every impact', afterShots.combatAudio);
  assert((afterShots.combatAudio?.cueCounts?.defeat ?? 0) === 1,
    'combat audio hook did not receive exactly one defeat', afterShots.combatAudio);

  await page.waitForTimeout(240);
  const disabledProbe = await page.evaluate((pose) => {
    const sim = window.__SF_SIM__;
    const root = sim.traffic.group.children[pose.id];
    sim.camera.position.set(pose.player.x, root.position.y + 1.6, pose.player.z);
    sim.camera.lookAt(root.position.x, root.position.y + 0.82, root.position.z);
    sim.camera.updateMatrixWorld(true);
    const fire = sim.fireCombat();
    return {
      fire,
      targetState: sim.getCombatTargetState?.(`traffic:${pose.id}`),
      world: {
        disabled: root.userData?.combatDisabled === true,
        reaction: root.userData?.combatReaction || null,
        reactionSource: root.userData?.combatReactionSource || null,
      },
    };
  }, setup);
  assert(disabledProbe.fire?.fired === true && disabledProbe.fire?.hit === false,
    'disabled target still absorbed a follow-up shot', disabledProbe);
  assert(disabledProbe.fire?.nearReactions === 0,
    'disabled target still emitted a near-miss reaction', disabledProbe);
  assert(disabledProbe.targetState?.targetable === false
    && disabledProbe.world?.disabled === true
    && disabledProbe.world?.reactionSource === 'defeat',
  'follow-up shot cleared the persistent defeat consequence', disabledProbe);

  await page.waitForFunction(
    () => {
      const sim = window.__SF_SIM__;
      const heat = sim.getStreetHeatState?.();
      const responder = sim.traffic.getPursuitResponder?.();
      return heat?.pursuitActive === true
        && responder?.active === true
        && Number.isFinite(responder.distance)
        && Number.isInteger(responder.id);
    },
    null,
    { timeout: 5000, polling: 100 },
  );
  const pursuit = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const heat = sim.getStreetHeatState();
    const responder = sim.traffic.getPursuitResponder();
    const life = sim.traffic.getVehicleLifeSnapshot().vehicles.find(
      (vehicle) => vehicle.id === responder.id,
    );
    const interaction = document.querySelector('.hud__interaction');
    return {
      heat,
      responder,
      life,
      interaction: {
        hidden: interaction?.hidden ?? null,
        availability: interaction?.dataset.availability || null,
        text: interaction && !interaction.hidden ? interaction.textContent.trim() : null,
      },
    };
  });
  responderId = pursuit.responder.id;
  assert(pursuit.heat?.pursuitActive === true, 'pursuit state dropped before responder sample', pursuit.heat);
  assert(Number.isFinite(pursuit.heat?.responderDistance), 'StreetHeat responder distance is not finite', pursuit.heat);
  assert(Number.isInteger(pursuit.responder?.id), 'responder id is not an integer', pursuit.responder);
  assert(pursuit.responder?.active === true, 'traffic responder is not active', pursuit.responder);
  assert(pursuit.responder?.position
    && [pursuit.responder.position.x, pursuit.responder.position.y, pursuit.responder.position.z]
      .every(Number.isFinite), 'responder position is not finite', pursuit.responder);
  assert(pursuit.life?.visible === true, 'responder life record is not visible', pursuit.life);
  assert(pursuit.life?.action?.key === 'pursuit-responder', 'responder action is not exposed', pursuit.life);
  assert(pursuit.life?.indicators?.hazard === true, 'responder hazard indicator is not active', pursuit.life);

  await page.evaluate((position) => {
    window.__SF_SIM__.setRoamPose({ x: position.x, z: position.z });
  }, pursuit.responder.position);
  await page.waitForFunction(
    () => {
      const sim = window.__SF_SIM__;
      return sim.getStreetHeatState?.().responderContacts === 1
        && sim.getCombatState?.().health < sim.getCombatState?.().maxHealth;
    },
    null,
    { timeout: 4000, polling: 50 },
  );
  const responderContact = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    combat: window.__SF_SIM__.getCombatState(),
    audio: window.__SF_SIM__.getCombatAudioState?.(),
  }));
  assert(responderContact.heat?.responderContacts === 1
    && responderContact.heat?.lastEvent?.kind === 'responder-contact',
  'live responder contact did not register once on StreetHeat', responderContact.heat);
  assert(responderContact.combat?.health === 82,
    'live on-foot responder contact did not apply bounded combat damage', responderContact.combat);
  assert((responderContact.audio?.cueCounts?.damage ?? 0) === 1,
    'responder contact did not use the combat damage audio path', responderContact.audio);

  const reload = await page.evaluate(async () => {
    const sim = window.__SF_SIM__;
    const started = sim.reloadCombat();
    const during = sim.getCombatState();
    await new Promise((resolve) => window.setTimeout(resolve, 1450));
    return {
      started,
      during,
      after: sim.getCombatState(),
      audio: sim.getCombatAudioState?.(),
    };
  });
  assert(reload.started === true, 'manual reload did not start', reload);
  assert(reload.during?.reloading === true && reload.during?.ammo === 7,
    'reload state did not preserve the partially spent magazine', reload.during);
  assert(reload.after?.reloading === false && reload.after?.ammo === 12 && reload.after?.reserveAmmo === 43,
    'reload did not refill the magazine from reserve', reload.after);
  assert((reload.audio?.cueCounts?.['reload-start'] ?? 0) === 1
    && (reload.audio?.cueCounts?.['reload-complete'] ?? 0) === 1,
  'combat audio reload hooks did not complete', reload.audio);

  const recovery = await page.evaluate(async () => {
    const sim = window.__SF_SIM__;
    const damaged = sim.damagePlayer(100, 'combat-smoke');
    const downed = sim.getCombatState();
    await new Promise((resolve) => window.setTimeout(resolve, 2750));
    return {
      damaged,
      downed,
      revived: sim.getCombatState(),
      audio: sim.getCombatAudioState?.(),
    };
  });
  assert(recovery.damaged === true, 'player damage hook rejected lethal damage', recovery);
  assert(recovery.downed?.status === 'downed' && recovery.downed?.health === 0,
    'lethal damage did not enter the downed state', recovery.downed);
  assert(recovery.revived?.status === 'running' && recovery.revived?.health === 58,
    'downed player did not revive through the real update loop', recovery.revived);
  assert((recovery.audio?.cueCounts?.damage ?? 0) === 2
    && (recovery.audio?.cueCounts?.downed ?? 0) === 1
    && (recovery.audio?.cueCounts?.revive ?? 0) === 1,
  'combat audio recovery hooks did not cover damage/downed/revive', recovery.audio);

  // Break contact by moving the on-foot player far outside the responder's
  // nearby radius. Real RAF frames then drive StreetHeat's normal hold/cool/
  // escape window; no test-only heat mutation or traffic teleport is used.
  await page.evaluate((pose) => {
    const sim = window.__SF_SIM__;
    sim.setCombatAim(false);
    // Stay inside the core street pocket so the real escape window is tested
    // without turning this smoke into a distant-sector streaming soak.
    sim.setRoamPose({ x: pose.player.x + 40, z: pose.player.z + 40 });
  }, setup);
  await page.waitForFunction(
    () => {
      const sim = window.__SF_SIM__;
      const heat = sim.getStreetHeatState?.();
      const responder = sim.traffic.getPursuitResponder?.();
      return heat?.pursuitActive === false
        && responder?.active === false
        && responder?.id === null
        && responder?.distance === null;
    },
    null,
    { timeout: 10000, polling: 100 },
  );
  await page.waitForTimeout(500);
  const escaped = await page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const heat = sim.getStreetHeatState();
    const responder = sim.traffic.getPursuitResponder();
    const life = sim.traffic.getVehicleLifeSnapshot().vehicles.find((vehicle) => vehicle.id === id);
    const interaction = document.querySelector('.hud__interaction');
    return {
      heat,
      responder,
      life,
      interaction: {
        hidden: interaction?.hidden ?? null,
        availability: interaction?.dataset.availability || null,
        text: interaction && !interaction.hidden ? interaction.textContent.trim() : null,
      },
    };
  }, responderId);
  assert(escaped.heat?.pursuitActive === false, 'escape did not clear pursuitActive', escaped.heat);
  assert(escaped.heat?.lastEvent?.kind === 'escaped', 'escape event was not emitted', escaped.heat);
  assert(escaped.heat?.responderContacts === 0,
    'escape did not reset the responder contact latch', escaped.heat);
  assert(escaped.responder?.active === false && escaped.responder.id === null,
    'responder did not clear after escape', escaped.responder);
  assert(escaped.life?.pursuit === null, 'ordinary traffic still exposes pursuit metadata', escaped.life);
  assert(escaped.life?.action?.key !== 'pursuit-responder', 'ordinary traffic action remained responder', escaped.life);

  const secondPursuitSetup = await page.evaluate(async (previousTargetId) => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.getVehicleLifeSnapshot();
    const candidate = snapshot.vehicles.find((vehicle) => (
      vehicle.visible
      && vehicle.id !== previousTargetId
      && vehicle.class !== 'bike'
      && sim.traffic.group.children[vehicle.id]?.userData?.combatDisabled !== true
    ));
    if (!candidate) throw new Error('no second visible traffic target for repeated pursuit smoke');
    const root = sim.traffic.group.children[candidate.id];
    const player = {
      x: root.position.x - Math.sin(root.rotation.y) * 8,
      z: root.position.z - Math.cos(root.rotation.y) * 8,
    };
    sim.setRoamPose(player);
    sim.setCombatAim(true);
    const shots = [];
    for (let index = 0; index < 4; index += 1) {
      if (index > 0) await new Promise((resolve) => window.setTimeout(resolve, 240));
      sim.camera.position.set(player.x, root.position.y + 1.6, player.z);
      sim.camera.lookAt(root.position.x, root.position.y + 0.82, root.position.z);
      sim.camera.updateMatrixWorld(true);
      shots.push(sim.fireCombat());
    }
    return { id: candidate.id, player, shots, health: sim.getCombatState().health };
  }, setup.id);
  assert(secondPursuitSetup.shots.filter((shot) => shot.hit).length >= 3,
    'second real combat incident did not register enough hits', secondPursuitSetup);
  await page.waitForFunction(
    () => {
      const sim = window.__SF_SIM__;
      const heat = sim.getStreetHeatState?.();
      const responder = sim.traffic.getPursuitResponder?.();
      return heat?.pursuitActive === true
        && heat?.responderContacts === 0
        && responder?.active === true
        && Number.isFinite(responder.position?.x)
        && Number.isFinite(responder.position?.z);
    },
    null,
    { timeout: 5000, polling: 50 },
  );
  const secondResponder = await page.evaluate(() => window.__SF_SIM__.traffic.getPursuitResponder());
  await page.evaluate((position) => {
    window.__SF_SIM__.setRoamPose({ x: position.x, z: position.z });
  }, secondResponder.position);
  await page.waitForFunction(
    () => {
      const sim = window.__SF_SIM__;
      return sim.getStreetHeatState?.().responderContacts === 1;
    },
    null,
    { timeout: 4000, polling: 50 },
  );
  const secondResponderContact = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    combat: window.__SF_SIM__.getCombatState(),
    audio: window.__SF_SIM__.getCombatAudioState?.(),
  }));
  assert(secondResponderContact.heat?.lastEvent?.kind === 'responder-contact'
    && secondResponderContact.heat?.responderContacts === 1,
  'second pursuit did not emit a fresh responder contact', secondResponderContact.heat);
  assert(secondResponderContact.combat?.health === secondPursuitSetup.health - 18,
    'second pursuit contact did not apply a second bounded damage consequence', secondResponderContact.combat);
  assert((secondResponderContact.audio?.cueCounts?.damage ?? 0) === 3,
    'second pursuit contact did not reuse the combat damage audio path', secondResponderContact.audio);

  const minimumDiagnosticMs = 30000;
  const remainingMs = Math.max(0, minimumDiagnosticMs - (Date.now() - perfStartedAt));
  if (remainingMs > 0) await page.waitForTimeout(remainingMs);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  const perfFrameEnd = performance?.frameCount ?? null;
  assert(Number.isFinite(performance?.averageFrameMs), '30s FPS diagnostic has no average frame time', performance);
  assert(Number.isFinite(performance?.applicationP99FrameMs), '30s FPS diagnostic has no application p99', performance);
  assert(perfFrameStart === null || perfFrameEnd === null || perfFrameEnd > perfFrameStart,
    'performance frame counter did not advance', { perfFrameStart, perfFrameEnd });

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'combat pursuit smoke passed'
      : 'combat pursuit smoke failed',
    baseUrl,
    angle,
    target: setup,
    shots: {
      count: afterShots.combat?.shots ?? null,
      hits: afterShots.combat?.hits ?? null,
      results: shotResults.map((shot) => shot.fire),
    },
    consequence: {
      targetState: afterShots.targetState,
      world: afterShots.targetConsequence,
      disabledProbe,
    },
    reload,
    recovery,
    pursuit,
    responderContact,
    escaped,
    secondPursuitSetup,
    secondResponderContact,
    performance: {
      wallClockMs: Date.now() - perfStartedAt,
      frameCountDelta: perfFrameStart === null || perfFrameEnd === null
        ? null
        : perfFrameEnd - perfFrameStart,
      snapshot: performance,
    },
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'combat pursuit smoke passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'combat pursuit smoke failed',
    error: error.message,
    stack: error.stack,
    consoleErrors,
    httpErrors,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
