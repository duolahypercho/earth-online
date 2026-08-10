import { access } from 'node:fs/promises';
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
page.on('requestfailed', (request) => requestFailures.push(
  `${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`,
));

async function launch({ clearStorage = false } = {}) {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  if (clearStorage) await page.evaluate(() => window.localStorage.clear());
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(700);
}

try {
  await launch({ clearStorage: true });
  const renderer = await page.evaluate(() => {
    const gl = document.querySelector('#scene-canvas')?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string' && renderer.includes('Metal'),
    'collision gate did not run on a Metal renderer', renderer);

  const candidate = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const origin = sim.getRoamState().target;
    return sim.traffic.getVehicleLifeSnapshot().vehicles
      .filter((vehicle) => vehicle.action?.key === 'parked'
        && vehicle.identity?.category === 'private'
        && vehicle.damage?.state === 'clear')
      .map((vehicle) => ({
        ...vehicle,
        distance: Math.hypot(vehicle.position.x - origin.x, vehicle.position.z - origin.z),
      }))
      .sort((a, b) => a.distance - b.distance)[0] || null;
  });
  assert(candidate?.id >= 0, 'no parked private vehicle was available', candidate);

  if (candidate) {
    // Deterministic setup only: the entry and impact themselves use normal E/W input.
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
    await page.waitForTimeout(80);
    await page.keyboard.press('e');
  }

  await page.waitForFunction(() => window.__SF_SIM__.isDriving(), null, { timeout: 4000 });
  const entered = await page.evaluate(() => ({
    vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
  }));
  assert(entered.vehicle?.index === candidate?.id
    && entered.vehicle?.damage?.state === 'clear'
    && entered.heat?.heat === 18,
  'real E did not enter a fresh stolen vehicle', { candidate, entered });

  const staged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const fleet = sim.traffic.getVehicleLifeSnapshot().vehicles;
    const playerId = sim.traffic.getPlayerVehicleState()?.index;
    const victim = fleet.find((vehicle) => {
      if (vehicle.id === playerId
        || vehicle.class === 'bike'
        || vehicle.visible === false
        || vehicle.action?.key === 'parked'
        || vehicle.damage?.disabled
        || vehicle.speed > 8
        || !Number.isFinite(vehicle.heading)) return false;
      return true;
    }) || null;
    if (!victim) return null;
    const snapshot = sim.traffic.exportPlayerVehicleState();
    const gap = 13.5;
    snapshot.position = {
      x: victim.position.x - Math.sin(victim.heading) * gap,
      z: victim.position.z - Math.cos(victim.heading) * gap,
    };
    snapshot.heading = victim.heading;
    return {
      victimId: victim.id,
      victimClass: victim.class,
      imported: sim.traffic.importPlayerVehicleState(snapshot),
      player: sim.traffic.getPlayerVehicleState(),
    };
  });
  assert(staged?.imported === true && staged.victimId >= 0,
    'deterministic collision setup could not place the entered car behind a live queue', staged);

  await page.keyboard.down('w');
  await page.waitForFunction(
    () => window.__SF_SIM__.traffic.getDiagnostics().recklessCollisionEvents === 1,
    null,
    { timeout: 18000 },
  );
  await page.waitForTimeout(450);
  await page.keyboard.up('w');

  const collision = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const diagnostics = sim.traffic.getDiagnostics();
    const event = diagnostics.lastPlayerCollision;
    const fleet = sim.traffic.getVehicleLifeSnapshot().vehicles;
    return {
      diagnostics,
      event,
      player: sim.traffic.getPlayerVehicleState(),
      victim: fleet.find((vehicle) => vehicle.id === event?.victimVehicleId) || null,
      heat: sim.getStreetHeatState(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
      saved: sim.getSavedProgress(),
      performance: sim.getPerformanceSnapshot(),
    };
  });
  assert(collision.diagnostics?.recklessCollisionEvents === 1
    && collision.diagnostics?.collisionDamageEvents === 1,
  'real overlap emitted more or fewer than one collision consequence', collision.diagnostics);
  assert(collision.event?.playerVehicleId === collision.player?.index
    && collision.event?.victimVehicleId === collision.victim?.id
    && collision.event?.relativeSpeed > 1.5,
  'collision record did not identify both vehicles and severity', collision.event);
  assert(collision.player?.damage?.lastDamage?.source === 'traffic-impact'
    && collision.player.damage.health < collision.player.damage.maxHealth,
  'rear-end did not damage the player vehicle', collision.player);
  assert(collision.victim?.damage?.lastDamage?.source === 'reckless-collision'
    && collision.victim.damage.health < collision.victim.damage.maxHealth
    && collision.victim.indicators?.hazard === true,
  'struck vehicle did not receive bounded damage and hazards', collision.victim);
  assert(collision.event?.aftermath?.heatAdded === 10
    && collision.event.aftermath.heatAfter - collision.event.aftermath.heatBefore === 10
    && collision.heat?.heat <= collision.event.aftermath.heatAfter
    && collision.heat?.heat > collision.event.aftermath.heatBefore
    && collision.heat?.lastEvent?.kind === 'reckless-collision'
    && collision.message.includes('RECKLESS COLLISION'),
  'collision did not add exactly one bounded StreetHeat/HUD consequence', collision);
  assert(Math.round(collision.saved?.snapshot?.streetHeat?.heat ?? -1)
      === collision.event?.aftermath?.heatAfter
    && collision.saved?.snapshot?.vehicle?.damage?.health === collision.player.damage.health
    && collision.saved?.snapshot?.trafficAftermath?.vehicles?.some((record) => (
      record.vehicleId === collision.victim.id
      && record.damage.health === collision.victim.damage.health
      && record.damage.lastDamage?.source === 'reckless-collision'
    )),
  'collision aftermath was not saved immediately', collision.saved);
  assert(Number.isFinite(collision.performance?.applicationP99FrameMs)
    && collision.performance.applicationP99FrameMs <= 16.67,
  'application p99 exceeded the hard budget', collision.performance);

  await page.reload({ waitUntil: 'load' });
  await launch();
  const restored = await page.evaluate(() => ({
    player: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
    victim: window.__SF_SIM__.traffic.getVehicleLifeSnapshot().vehicles.find(
      (vehicle) => vehicle.id === window.__SF_SIM__.getSavedProgress()
        .snapshot?.trafficAftermath?.vehicles?.[0]?.vehicleId,
    ) || null,
  }));
  assert(restored.player?.damage?.health === collision.player?.damage?.health
    && restored.player?.damage?.lastDamage?.source === 'traffic-impact'
    && restored.heat?.heat > 0
    && restored.heat?.heat <= collision.saved?.snapshot?.streetHeat?.heat
    && restored.victim?.id === collision.victim?.id
    && restored.victim?.damage?.health === collision.victim?.damage?.health
    && restored.victim?.damage?.lastDamage?.source === 'reckless-collision'
    && restored.victim?.indicators?.hazard === false
    && restored.diagnostics?.recklessCollisionEvents === 0,
  'reload did not preserve both vehicle damage records/heat or replayed the transient collision', restored);

  const validation = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.exitCar();
    const parkedBefore = sim.traffic.exportPlayerVehicleState();
    sim.saveProgress();
    const invalidRestore = structuredClone(sim.getSavedProgress().snapshot);
    invalidRestore.vehicle.mode = 'driving';
    invalidRestore.trafficAftermath.vehicles[0].vehicleId = 99999;
    window.localStorage.setItem(
      sim.getSavedProgress().key,
      JSON.stringify(invalidRestore),
    );
    const restoreResult = sim.restoreProgress();
    const parkedAfter = sim.traffic.exportPlayerVehicleState();
    const before = sim.traffic.exportCollisionAftermathState();
    const beforePlayer = sim.traffic.exportPlayerVehicleState();
    const beforeLife = sim.lifeSim.getState();
    const duplicate = structuredClone(before);
    duplicate.vehicles.push(structuredClone(duplicate.vehicles[0]));
    const unknown = structuredClone(before);
    unknown.vehicles[0].vehicleId = 99999;
    const mismatch = structuredClone(before);
    mismatch.vehicles[0].class = 'bike';
    const overlap = structuredClone(before);
    overlap.vehicles[0] = {
      ...overlap.vehicles[0],
      vehicleId: beforePlayer.vehicleId,
      class: beforePlayer.class,
      identity: beforePlayer.identity,
      damage: {
        ...overlap.vehicles[0].damage,
        maxHealth: beforePlayer.damage.maxHealth,
      },
    };
    const rejected = [duplicate, unknown, mismatch, overlap].map(
      (snapshot) => sim.traffic.importCollisionAftermathState(snapshot),
    );
    const afterRejected = sim.traffic.exportCollisionAftermathState();
    const disabled = structuredClone(before);
    disabled.vehicles[0].damage.health = 0;
    disabled.vehicles[0].damage.disabled = true;
    const disabledImported = sim.traffic.importCollisionAftermathState(disabled);
    const victimId = disabled.vehicles[0].vehicleId;
    const victim = sim.traffic.getVehicleLifeSnapshot().vehicles.find(
      (vehicle) => vehicle.id === victimId,
    ) || null;
    const nearest = victim
      ? sim.traffic.getNearestEnterableVehicle(victim.position, 1.5)
      : null;
    return {
      rejected,
      restoreResult,
      parkedBefore,
      parkedAfter,
      before,
      afterRejected,
      beforePlayer,
      afterPlayer: sim.traffic.exportPlayerVehicleState(),
      beforeLife,
      afterLife: sim.lifeSim.getState(),
      disabledImported,
      victim,
      nearestId: nearest?.index ?? null,
    };
  });
  assert(validation.rejected.every((value) => value === false)
    && validation.restoreResult === false
    && validation.parkedBefore?.mode === 'parked'
    && validation.parkedAfter?.mode === 'parked'
    && validation.parkedAfter.vehicleId === validation.parkedBefore.vehicleId
    && JSON.stringify(validation.afterRejected) === JSON.stringify(validation.before)
    && validation.afterPlayer?.vehicleId === validation.beforePlayer?.vehicleId
    && validation.afterPlayer?.damage?.health === validation.beforePlayer?.damage?.health
    && validation.afterLife.cash === validation.beforeLife.cash
    && validation.afterLife.lastTransaction?.at === validation.beforeLife.lastTransaction?.at,
  'malformed/duplicate collision aftermath was not rejected atomically', validation);
  assert(validation.disabledImported === true
    && validation.victim?.damage?.disabled === true
    && validation.victim.speed === 0
    && validation.victim.action?.key === 'vehicle-disabled'
    && validation.nearestId !== validation.victim?.id,
  'restored disabled victim remained moving or enterable', validation);

  assert(consoleErrors.length === 0, 'console/page errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestFailures.length === 0, 'request failures occurred', requestFailures);

  const report = {
    result: failures.length ? 'vehicle collision consequence failed' : 'vehicle collision consequence passed',
    renderer,
    candidate: candidate && { id: candidate.id, class: candidate.class, distance: candidate.distance },
    collision: {
      event: collision.event,
      heat: collision.heat?.heat,
      victimHazards: collision.victim?.indicators?.hazard,
      savedAt: collision.saved?.lastSave?.savedAt,
    },
    restored: {
      heat: restored.heat?.heat,
      damage: restored.player?.damage,
      victimDamage: restored.victim?.damage,
    },
    validation: {
      rejected: validation.rejected,
      disabledImported: validation.disabledImported,
      disabledVictimId: validation.victim?.id,
      nearestId: validation.nearestId,
    },
    applicationP99FrameMs: collision.performance?.applicationP99FrameMs,
    failures,
    consoleErrors,
    httpErrors,
    requestFailures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'vehicle collision consequence crashed',
    error: error.message,
    stack: error.stack,
    failures,
    consoleErrors,
    httpErrors,
    requestFailures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
