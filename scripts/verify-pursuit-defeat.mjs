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
page.on('requestfailed', (request) => {
  if (!request.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  }
});

async function launch() {
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(450);
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
      witness: { id: pair.witness.id },
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

async function fireWitnessed(stage, expectedHits, expectedReports) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await fireAt(stage);
    await page.waitForTimeout(280);
    const registered = await page.evaluate(({ hits, reports }) => {
      const sim = window.__SF_SIM__;
      return sim.getCombatState().hits >= hits
        && sim.getStreetHeatState().witnessReports >= reports;
    }, { hits: expectedHits, reports: expectedReports });
    if (registered) return true;
  }
  return false;
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.getState();
    return {
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      combatAudio: sim.getCombatAudioState?.(),
      responders: sim.traffic.getPursuitResponders(),
      roam: sim.getRoamState(),
      life,
      transaction: life.lastTransaction,
      inventory: {
        medkits: life.inventory?.medkit?.count ?? null,
        medkitCapacity: life.inventory?.medkit?.capacity ?? null,
      },
      vehicle: sim.traffic.exportPlayerVehicleState?.() ?? null,
      garage: sim.traffic.exportGarageState?.() ?? null,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function directionKey(away = true) {
  return page.evaluate((moveAway) => {
    const sim = window.__SF_SIM__;
    const player = sim.getRoamState().target;
    const responders = sim.traffic.getPursuitResponders();
    const nearest = responders.slice().sort((a, b) => (
      Math.hypot(a.position.x - player.x, a.position.z - player.z)
      - Math.hypot(b.position.x - player.x, b.position.z - player.z)
    ))[0];
    if (!nearest) return null;
    const yaw = sim.getCombatState().camera.yaw;
    const towardX = nearest.position.x - player.x;
    const towardZ = nearest.position.z - player.z;
    const length = Math.hypot(towardX, towardZ) || 1;
    const desired = {
      x: (towardX / length) * (moveAway ? -1 : 1),
      z: (towardZ / length) * (moveAway ? -1 : 1),
    };
    const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: forward.z, z: -forward.x };
    const candidates = [
      { key: 's', x: forward.x, z: forward.z },
      { key: 'w', x: -forward.x, z: -forward.z },
      { key: 'd', x: right.x, z: right.z },
      { key: 'a', x: -right.x, z: -right.z },
    ];
    candidates.sort((a, b) => (
      b.x * desired.x + b.z * desired.z - (a.x * desired.x + a.z * desired.z)
    ));
    return { key: candidates[0].key, nearestId: nearest.id };
  }, away);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.getStats().visible > 3,
    null, { timeout: 15000, polling: 40 });

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  if (angle === 'metal') {
    assert(/metal/i.test(renderer || ''), 'Metal renderer was required but not reported', { angle, renderer });
  }

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.combat.restart();
    sim.resetPerformanceTelemetry?.();
  });
  const first = await stageWitnessedShot();
  assert(first?.victim?.id && first?.witness?.id, 'first witnessed gunfire setup unavailable', first);
  if (!first?.victim?.id) throw new Error('first witnessed shot setup failed');
  assert(await fireWitnessed(first, 1, 1), 'first witnessed shot did not register');
  await page.waitForTimeout(250);

  const second = await stageWitnessedShot([first.victim.id, first.witness.id]);
  assert(second?.victim?.id && second?.witness?.id, 'second witnessed gunfire setup unavailable', second);
  if (!second?.victim?.id) throw new Error('second witnessed shot setup failed');
  assert(await fireWitnessed(second, 2, 2), 'second witnessed shot did not register');

  const third = await stageWitnessedShot([
    first.victim.id,
    first.witness.id,
    second.victim.id,
    second.witness.id,
  ]);
  assert(third?.victim?.id && third?.witness?.id, 'third witnessed gunfire setup unavailable', third);
  if (!third?.victim?.id) throw new Error('third witnessed shot setup failed');
  assert(await fireWitnessed(third, 3, 3), 'third witnessed shot did not register');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const heat = await page.evaluate(() => window.__SF_SIM__.getStreetHeatState().heat);
    if (heat >= 88) break;
    await fireAt(third);
    await page.waitForTimeout(280);
  }
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim.getCombatState().hits >= 3
      && sim.getStreetHeatState().witnessReports >= 3
      && sim.getStreetHeatState().heat >= 88
      && sim.getStreetHeatState().pursuitActive
      && sim.traffic.getPursuitResponders().length > 0;
  }, null, { timeout: 12000, polling: 25 });

  const pursuit = await evidence();
  let resourcesBefore = null;
  const ammoAfterGunfire = {
    ammo: pursuit.combat.ammo,
    reserveAmmo: pursuit.combat.reserveAmmo,
  };
  assert(pursuit.heat.heat >= 30
    && pursuit.heat.pursuitActive === true
    && pursuit.combat.health === 100 - pursuit.heat.responderContacts * 18,
  'real witnessed gunfire did not create a consistent on-foot pursuit', pursuit);

  const contactStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders()[0];
    const pose = { x: responder.position.x + 3.4, z: responder.position.z };
    sim.setRoamPose(pose);
    return { responderId: responder.id, pose };
  });
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().responderContacts >= 1,
    null, { timeout: 5000, polling: 20 });
  const firstContact = await evidence();
  assert(firstContact.combat.health === 82
    && firstContact.heat.responderContacts === 1
    && firstContact.combat.recoverySuspended === true,
  'first live responder contact did not apply and suspend recovery', { contactStage, firstContact });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders()[0];
    sim.setRoamPose({ x: responder.position.x + 40, z: responder.position.z });
  });
  const healthBeforeHold = await page.evaluate(() => window.__SF_SIM__.getCombatState().health);
  await page.waitForTimeout(2300);
  const recoveryHold = await evidence();
  assert(recoveryHold.heat.pursuitActive === true
    && recoveryHold.combat.health === healthBeforeHold
    && recoveryHold.combat.recoverySuspended === true
    && recoveryHold.combat.recovering === false,
  'passive health recovery advanced during an active pursuit', { healthBeforeHold, recoveryHold });
  resourcesBefore = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());

  const contacts = [firstContact];
  for (let expected = 2; expected <= 6; expected += 1) {
    await page.evaluate(() => {
      const sim = window.__SF_SIM__;
      const responder = sim.traffic.getPursuitResponders()[0];
      sim.setRoamPose({ x: responder.position.x + 3.4, z: responder.position.z });
    });
    await page.waitForFunction((targetContact) => {
      const heat = window.__SF_SIM__.getStreetHeatState();
      return heat.responderContacts >= targetContact || heat.arrests >= 1;
    }, expected, { timeout: 4000, polling: 20 });
    const contact = await evidence();
    contacts.push(contact);
    if (expected < 6) {
      assert(contact.heat.responderContacts === expected
        && contact.combat.health === 100 - expected * 18,
      `responder re-catch ${expected} did not apply exactly 18 damage`, contact);
      const beforeMove = contact.roam.target;
      const direction = await directionKey(true);
      await page.keyboard.down('Shift');
      await page.keyboard.down(direction.key);
      await page.waitForTimeout(520);
      await page.keyboard.up(direction.key);
      await page.keyboard.up('Shift');
      const afterMove = await page.evaluate(() => window.__SF_SIM__.getRoamState().target);
      const realMovement = Math.hypot(
        afterMove.x - beforeMove.x,
        afterMove.z - beforeMove.z,
      );
      assert(realMovement >= 0.35, `contact ${expected} did not allow real-input escape movement`, {
        beforeMove,
        afterMove,
        realMovement,
      });
      await page.evaluate(() => {
        const sim = window.__SF_SIM__;
        const responder = sim.traffic.getPursuitResponders()[0];
        sim.setRoamPose({ x: responder.position.x + 9.4, z: responder.position.z });
      });
      await page.waitForFunction(() => {
        const state = window.__SF_SIM__.getStreetHeatState();
        return state.pursuitActive && Math.min(...state.responderDistances) >= 8.5;
      }, null, { timeout: 2500, polling: 20 });
    }
  }

  const booked = await evidence();
  const welcome = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((entry) => /welcome center/i.test(entry.label));
    const release = portal?.approachRoute?.[portal.approachRoute.length - 1] || portal?.position;
    const player = sim.getRoamState().target;
    return {
      release,
      distance: release ? Math.hypot(player.x - release.x, player.z - release.z) : null,
    };
  });
  const bookingHeat = booked.heat.lastEvent?.heatBefore ?? pursuit.heat.heat;
  const expectedDue = Math.min(120, Math.max(20, Math.ceil(20 + bookingHeat * 1.5)));
  assert(booked.heat.heat === 0
    && booked.heat.pursuitActive === false
    && booked.heat.responderCount === 0
    && booked.heat.arrests === 1
    && booked.responders.length === 0,
  'contact-sourced downing did not clear the pursuit exactly once', booked);
  assert(booked.combat.status === 'running'
    && booked.combat.health === 58
    && welcome.distance <= 1,
  'contact-sourced booking did not recover at the Welcome Center', { booked, welcome });
  assert(booked.transaction?.kind === 'wanted-fine'
    && booked.transaction.due === expectedDue
    && booked.message.includes('BUSTED /')
    && booked.saved.snapshot?.combat?.health === 58
    && booked.saved.snapshot?.streetHeat?.heat === 0
    && booked.saved.snapshot?.world?.mode === 'outdoor',
  'booking did not charge and atomically save the recovery state', { expectedDue, booked });
  assert(booked.combat.ammo === ammoAfterGunfire.ammo
    && booked.combat.reserveAmmo === ammoAfterGunfire.reserveAmmo
    && JSON.stringify(booked.inventory) === JSON.stringify(pursuit.inventory)
    && JSON.stringify(booked.vehicle) === JSON.stringify(pursuit.vehicle)
    && JSON.stringify(booked.garage) === JSON.stringify(pursuit.garage),
  'booking mutated ammo, inventory, or vehicle ownership', { pursuit, booked });
  const resourcesAfterBooking = await page.evaluate(() => (
    window.__SF_SIM__.getPerformanceSnapshot().gpuMemory
  ));
  // The shared city loader can finish a few deferred atlases while this gate
  // runs. Bound that unrelated drift tightly; this milestone itself creates
  // no render objects or texture requests.
  assert(resourcesAfterBooking.geometries - resourcesBefore.gpuMemory.geometries <= 8
    && resourcesAfterBooking.textures - resourcesBefore.gpuMemory.textures <= 4,
  'pursuit loop caused unexpected renderer-resource growth', {
    resourcesBefore,
    resourcesAfterBooking,
  });

  const transactionAt = booked.transaction?.at;
  const cashAfter = booked.life.cash;
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await evidence();
  assert(restored.heat.heat === 0
    && restored.heat.pursuitActive === false
    && restored.combat.health === 58
    && restored.life.cash === cashAfter
    && restored.transaction?.at === transactionAt,
  'reload replayed or lost pursuit-defeat booking', restored);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1800);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(Number.isFinite(performance.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'pursuit-defeat loop exceeded the application frame budget', performance);

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    renderer,
    pursuit,
    firstContact,
    recoveryHold,
    contacts: contacts.map((entry) => ({ heat: entry.heat, combat: entry.combat })),
    booked,
    welcome,
    resources: { before: resourcesBefore.gpuMemory, afterBooking: resourcesAfterBooking },
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
