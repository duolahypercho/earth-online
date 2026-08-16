import { access } from 'node:fs/promises';
import { inspect } from 'node:util';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  args: ['--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestFailures = [];
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
    requestFailures.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  }
});

async function launch({ clearStorage = false } = {}) {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  if (clearStorage) await page.evaluate(() => window.localStorage.clear());
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(600);
}

async function aimAtTarget(stage) {
  await page.evaluate(({ id, player }) => {
    const sim = window.__SF_SIM__;
    const root = sim.traffic.group.children[id];
    sim.setRoamPose(player);
    sim.camera.position.set(player.x, root.position.y + 1.6, player.z);
    sim.camera.lookAt(root.position.x, root.position.y + 0.82, root.position.z);
    sim.camera.updateMatrixWorld(true);
  }, stage);
}

async function fireRealShot(stage) {
  await aimAtTarget(stage);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(260);
  return page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => entry.id === id);
    return {
      vehicle,
      combat: sim.getCombatState(),
      target: sim.getCombatTargetState(`traffic:${id}`),
      heat: sim.getStreetHeatState(),
      ledger: sim.traffic.exportCollisionAftermathState(),
    };
  }, stage.id);
}

async function fireUntilDamage(stage, previousHealth) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shot = await fireRealShot(stage);
    if (shot.vehicle?.damage?.health < previousHealth) return shot;
  }
  return null;
}

try {
  await launch({ clearStorage: true });
  const renderer = await page.evaluate(() => {
    const gl = document.querySelector('#scene-canvas')?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string'
    && /metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe)/i.test(renderer),
  'traffic combat aftermath gate requires a hardware Metal renderer', renderer);

  const baseline = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.resetPerformanceTelemetry?.();
    const player = sim.getRoamState().target;
    const candidate = sim.traffic.getVehicleLifeSnapshot().vehicles
      .filter((vehicle) => vehicle.visible
        && vehicle.combatEligible !== false
        && vehicle.class !== 'bike'
        && vehicle.action?.key === 'parked'
        && vehicle.damage?.state === 'clear'
        && vehicle.identity?.category !== 'remote')
      .map((vehicle) => ({
        ...vehicle,
        distance: Math.hypot(vehicle.position.x - player.x, vehicle.position.z - player.z),
      }))
      .sort((a, b) => a.distance - b.distance)[0] || null;
    if (!candidate) return null;
    const root = sim.traffic.group.children[candidate.id];
    const shotOrigin = {
      x: root.position.x - Math.sin(root.rotation.y) * 8,
      z: root.position.z - Math.cos(root.rotation.y) * 8,
    };
    const performance = sim.getPerformanceSnapshot();
    return {
      id: candidate.id,
      class: candidate.class,
      identity: candidate.identity.key,
      maxHealth: candidate.damage.maxHealth,
      player: shotOrigin,
      heat: sim.getStreetHeatState(),
      life: sim.lifeSim.getState(),
      performance,
    };
  });
  assert(baseline?.id >= 0, 'no clear parked traffic target was available', baseline);
  if (!baseline) throw new Error('traffic combat staging failed');

  await aimAtTarget(baseline);
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__.getCombatState()?.aiming === true);
  const shots = [];
  let previousHealth = baseline.maxHealth;
  for (let index = 0; index < 4; index += 1) {
    const shot = await fireUntilDamage(baseline, previousHealth);
    if (!shot) break;
    shots.push(shot);
    previousHealth = shot.vehicle.damage.health;
  }
  await page.mouse.up({ button: 'right' });

  const expectedHealth = [0.75, 0.5, 0.25, 0].map(
    (ratio) => Math.round(baseline.maxHealth * ratio * 10) / 10,
  );
  assert(shots.every((shot, index) => shot.combat?.hits === index + 1
      && shot.vehicle?.damage?.health === expectedHealth[index]
      && shot.vehicle?.damage?.lastDamage?.source === 'combat-impact'),
  'four real shots did not apply exact quarter-health traffic damage', { expectedHealth, shots });
  const disabled = shots.at(-1);
  assert(disabled.vehicle?.damage?.disabled === true
    && disabled.vehicle?.damage?.state === 'disabled'
    && disabled.vehicle?.action?.key === 'vehicle-disabled'
    && disabled.vehicle?.indicators?.hazard === true
    && disabled.vehicle?.speed === 0
    && disabled.target?.defeated === true
    && disabled.target?.targetable === false,
  'fourth hit did not produce one mechanically disabled, untargetable vehicle', disabled);
  assert(disabled.ledger?.vehicles?.length === 1
    && disabled.ledger.vehicles[0].vehicleId === baseline.id
    && disabled.ledger.vehicles[0].class === baseline.class
    && disabled.ledger.vehicles[0].identity === baseline.identity
    && disabled.ledger.vehicles[0].damage?.lastDamage?.source === 'combat-impact',
  'combat-disabled vehicle was not represented in the bounded aftermath ledger', disabled.ledger);

  const consequence = await page.evaluate(({ id, player }) => {
    const sim = window.__SF_SIM__;
    const root = sim.traffic.group.children[id];
    const saved = sim.getSavedProgress().snapshot;
    sim.setRoamPose({ x: root.position.x, z: root.position.z });
    return {
      enterableId: sim.traffic.getNearestEnterableVehicle(player, 20)?.index ?? null,
      localEnterableId: sim.traffic.getNearestEnterableVehicle(root.position, 3.8)?.index ?? null,
      rootFlags: {
        disabled: root.userData.combatDisabled === true,
        defeated: root.userData.combatDefeated === true,
      },
      saved,
      life: sim.lifeSim.getState(),
      performance: sim.getPerformanceSnapshot(),
    };
  }, baseline);
  assert(consequence.localEnterableId !== baseline.id
    && consequence.rootFlags.disabled
    && consequence.rootFlags.defeated,
  'disabled traffic remained enterable or lacked authoritative mesh flags', consequence);
  const savedRecord = consequence.saved?.trafficAftermath?.vehicles?.find(
    (record) => record.vehicleId === baseline.id,
  );
  assert(savedRecord?.damage?.health === 0
    && savedRecord?.damage?.lastDamage?.source === 'combat-impact'
    && consequence.saved?.combat?.ammo === disabled.combat?.ammo
    && consequence.saved?.life?.cash === baseline.life.cash
    && JSON.stringify(consequence.saved?.life?.lastTransaction)
      === JSON.stringify(baseline.life.lastTransaction),
  'disable consequence was not saved immediately without economy mutation', consequence.saved);
  assert(Number.isFinite(consequence.performance?.applicationP99FrameMs)
    && consequence.performance.applicationP99FrameMs <= 16.67,
  'application p99 exceeded the hard budget', consequence.performance);

  const beforeReloadHeat = disabled.heat;
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => entry.id === id);
    const root = sim.traffic.group.children[id];
    return {
      vehicle,
      rootFlags: {
        disabled: root.userData.combatDisabled === true,
        defeated: root.userData.combatDefeated === true,
      },
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      life: sim.lifeSim.getState(),
      diagnostics: sim.traffic.getDiagnostics(),
      ledger: sim.traffic.exportCollisionAftermathState(),
    };
  }, baseline.id);
  assert(restored.vehicle?.damage?.health === 0
    && restored.vehicle?.damage?.disabled === true
    && restored.vehicle?.damage?.lastDamage?.source === 'combat-impact'
    && restored.vehicle?.action?.key === 'vehicle-disabled'
    && restored.vehicle?.indicators?.hazard === true
    && restored.vehicle?.speed === 0
    && restored.rootFlags.disabled
    && restored.rootFlags.defeated
    && restored.combat?.ammo === disabled.combat?.ammo
    && restored.heat?.heat <= beforeReloadHeat.heat
    && restored.heat?.heat >= beforeReloadHeat.heat - 2
    && restored.diagnostics?.vehicleDamageEvents === 0
    && restored.life?.cash === baseline.life.cash
    && JSON.stringify(restored.life?.lastTransaction) === JSON.stringify(baseline.life.lastTransaction),
  'reload did not preserve the exact disabled car or replayed consequences', restored);

  const partialStage = await page.evaluate((excludedId) => {
    const sim = window.__SF_SIM__;
    const candidate = sim.traffic.getVehicleLifeSnapshot().vehicles
      .filter((vehicle) => vehicle.id !== excludedId
        && vehicle.visible
        && vehicle.combatEligible !== false
        && vehicle.class !== 'bike'
        && vehicle.damage?.maxHealth % 4 !== 0
        && vehicle.damage?.state === 'clear')
      .sort((a, b) => Number(b.action?.key === 'parked') - Number(a.action?.key === 'parked'))[0];
    if (!candidate) return null;
    const root = sim.traffic.group.children[candidate.id];
    return {
      id: candidate.id,
      class: candidate.class,
      identity: candidate.identity.key,
      maxHealth: candidate.damage.maxHealth,
      player: {
        x: root.position.x - Math.sin(root.rotation.y) * 8,
        z: root.position.z - Math.cos(root.rotation.y) * 8,
      },
    };
  }, baseline.id);
  assert(partialStage?.id >= 0, 'no second target was available for partial reload coverage', partialStage);
  if (!partialStage) throw new Error('partial traffic aftermath staging failed');
  await aimAtTarget(partialStage);
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  const partialHit = await fireUntilDamage(partialStage, partialStage.maxHealth);
  await page.mouse.up({ button: 'right' });
  assert(partialHit.vehicle?.damage?.health
      === Math.round(partialStage.maxHealth * 0.75 * 10) / 10
    && partialHit.vehicle?.damage?.disabled === false,
  'single hit did not establish a partial quarter-damage state', partialHit);

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  await aimAtTarget(partialStage);
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  const resumedShots = [];
  previousHealth = partialHit.vehicle.damage.health;
  for (let index = 0; index < 3; index += 1) {
    const shot = await fireUntilDamage(partialStage, previousHealth);
    if (!shot) break;
    resumedShots.push(shot);
    previousHealth = shot.vehicle.damage.health;
  }
  await page.mouse.up({ button: 'right' });
  const resumed = resumedShots.at(-1);
  assert(resumedShots.map((shot) => shot.target?.health).join(',') === '2,1,0'
    && resumed.vehicle?.damage?.health === 0
    && resumed.vehicle?.damage?.disabled === true
    && resumed.target?.defeated === true
    && resumed.target?.targetable === false,
  'partial damage reload did not preserve the exact remaining three-hit consequence', resumedShots);

  const validation = await page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const beforeLedger = sim.traffic.exportCollisionAftermathState();
    const beforeLife = sim.lifeSim.exportState();
    const record = structuredClone(beforeLedger.vehicles[0]);
    const invalidSource = { version: 1, vehicles: [{ ...record, damage: {
      ...record.damage,
      lastDamage: { ...record.damage.lastDamage, source: 'traffic-impact' },
    } }] };
    const duplicate = { version: 1, vehicles: [record, structuredClone(record)] };
    const directResults = [invalidSource, duplicate].map(
      (snapshot) => sim.traffic.importCollisionAftermathState(snapshot),
    );
    const invalidProgress = structuredClone(sim.getSavedProgress().snapshot);
    invalidProgress.trafficAftermath = invalidSource;
    window.localStorage.setItem(sim.getSavedProgress().key, JSON.stringify(invalidProgress));
    const restoreResult = sim.restoreProgress();
    return {
      id,
      directResults,
      restoreResult,
      beforeLedger,
      afterLedger: sim.traffic.exportCollisionAftermathState(),
      lifeUnchanged: JSON.stringify(beforeLife) === JSON.stringify(sim.lifeSim.exportState()),
      vehicle: sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => entry.id === id),
    };
  }, baseline.id);
  assert(validation.directResults.every((result) => result === false)
    && validation.restoreResult === false
    && JSON.stringify(validation.afterLedger) === JSON.stringify(validation.beforeLedger)
    && validation.lifeUnchanged
    && validation.vehicle?.damage?.disabled === true,
  'malformed or duplicate combat aftermath did not reject atomically', validation);
} catch (error) {
  failures.push({ message: error.stack || error.message });
} finally {
  await browser.close();
}

assert(consoleErrors.length === 0, 'console/page errors were emitted', consoleErrors);
assert(httpErrors.length === 0, 'HTTP errors were emitted', httpErrors);
assert(requestFailures.length === 0, 'request failures were emitted', requestFailures);

if (failures.length) {
  console.error(inspect({ failures, consoleErrors, httpErrors, requestFailures }, {
    depth: 8,
    colors: false,
    maxArrayLength: 30,
  }));
  process.exit(1);
}

console.log('traffic combat aftermath invariants passed');
