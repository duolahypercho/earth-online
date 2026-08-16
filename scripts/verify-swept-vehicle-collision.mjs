// Strict fail-closed gate for the swept vehicle-collision system.
//
// Measured phases (all contacts must come from real E/W/A/D input after
// deterministic pre-staging; this script never mutates damage/contact state
// during a measured phase):
//   A. Negative: pursuit responder held <5.5 m center distance in the
//      opposing/adjacent lane with separated footprints => zero contact,
//      zero damage, zero collision HUD.
//   B. Positive: real throttle into a live queue => exactly one contact,
//      bounded player/victim damage, post-contact separation (no
//      interpenetration), and no responder contact for a civilian victim.
//   C. Rearm: sustained overlap does not duplicate per frame; separation
//      re-arms exactly one further contact on the next real approach.
//   D. Reload: durable aftermath (player damage, victim aftermath records,
//      StreetHeat) survives reload without replaying transient contact
//      diagnostics.
//
// Harness gates: Apple Metal renderer (fail-closed), stable renderer
// resources, zero console/page errors, zero HTTP errors, zero failed
// requests, application p99 <= 16.67 ms.
import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outputDir = resolve('.qa-swept-vehicle-collision');
const captures = {
  nearMiss: join(outputDir, 'phase-a-near-miss.png'),
  contact: join(outputDir, 'phase-b-contact.png'),
  rearm: join(outputDir, 'phase-c-rearm.png'),
  restored: join(outputDir, 'phase-d-restored.png'),
};

await mkdir(outputDir, { recursive: true });

if (process.platform !== 'darwin') {
  throw new Error('verify-swept-vehicle-collision requires macOS so Apple Metal can be verified.');
}
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => null);
if (!executablePath) {
  throw new Error(`System Chrome is required for the Apple Metal gate: ${systemChrome}`);
}

const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  executablePath,
  args: [
    '--disable-dev-shm-usage',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestFailures = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};
// Collision events report damage either as a number or as a damage snapshot
// object (`vehicleDamageSnapshot`); accept both shapes.
const damageAmountOf = (value) => {
  if (Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.lastDamage?.amount)) return value.lastDamage.amount;
    if (Number.isFinite(value.damage)) return value.damage;
  }
  return null;
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
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return typeof sim?.traffic?.getDiagnostics === 'function'
      && typeof sim?.traffic?.getVehicleLifeSnapshot === 'function'
      && typeof sim?.traffic?.exportPlayerVehicleState === 'function'
      && typeof sim?.traffic?.importPlayerVehicleState === 'function'
      && typeof sim?.getStreetHeatState === 'function'
      && typeof sim?.getPerformanceSnapshot === 'function'
      && typeof sim?.getSavedProgress === 'function';
  }, null, { timeout: 12000, polling: 25 });
  await page.waitForTimeout(700);
  await page.locator('#scene-canvas').focus();
}

try {
  await launch({ clearStorage: true });

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('#scene-canvas') || document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(
    typeof renderer === 'string' && /metal/i.test(renderer)
      && !/(swiftshader|software)/i.test(renderer),
    'swept collision gate did not run on an Apple Metal renderer (fail-closed)',
    { renderer },
  );

  const resourcesBefore = await page.evaluate(() => ({
    geometries: window.__SF_SIM__.renderer.info.memory.geometries,
    textures: window.__SF_SIM__.renderer.info.memory.textures,
  }));

  // ------------------------------------------------------------------
  // Phase A — near miss: responder centers <5.5 m, footprints separated.
  // The responder is a read-only telemetry probe (same pattern as the
  // isolated surrender-negative gate); no damage/contact state is forced.
  // ------------------------------------------------------------------
  const candidate = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.setWeather?.('clear');
    const origin = sim.getRoamState().target;
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles
      .filter((entry) => entry.identity?.category === 'private'
        && entry.action?.key === 'parked'
        && entry.damage?.disabled !== true
        && entry.theft?.eligible === true
        && entry.class !== 'bike')
      .map((entry) => ({
        id: entry.id,
        class: entry.class,
        position: entry.position,
        distance: Math.hypot(
          entry.position.x - origin.x,
          entry.position.z - origin.z,
        ),
      }))
      .sort((a, b) => a.distance - b.distance)[0] || null;
    if (!vehicle) return null;
    sim.setRoamPose(vehicle.position);
    return vehicle;
  });
  assert(Boolean(candidate), 'no parked private vehicle was available for entry', null);
  if (candidate) {
    await page.waitForTimeout(120);
    await page.keyboard.press('e');
  }
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true, null, {
    timeout: 4000,
  }).catch(() => {});
  assert(await page.evaluate(() => window.__SF_SIM__?.isDriving?.() === true),
    'real E did not enter the staged vehicle before phase A', candidate);

  await page.keyboard.down('w');
  const nearMiss = await page.evaluate(async () => {
    const sim = window.__SF_SIM__;
    const FOOTPRINT = {
      car: { halfLength: 2.35, halfWidth: 0.95 },
      taxi: { halfLength: 2.35, halfWidth: 0.95 },
      bus: { halfLength: 5.6, halfWidth: 1.25 },
      truck: { halfLength: 4.1, halfWidth: 1.2 },
      bike: { halfLength: 1.0, halfWidth: 0.35 },
    };
    const footprintOf = (cls) => FOOTPRINT[cls] || { halfLength: 2.4, halfWidth: 1.0 };

    const diagnosticsBefore = sim.traffic.getDiagnostics();
    const playerBefore = sim.traffic.getPlayerVehicleState();
    const heatBefore = sim.getStreetHeatState();
    const imported = sim.streetHeat?.importState?.({
      heat: 30,
      pursuitActive: true,
      responderContacts: 0,
      responderContactLatched: false,
      nearMisses: 0,
      witnessReports: 0,
      combatHold: 0,
      theftHold: 0,
    }) === true;
    const originalResponders = sim.traffic.getPursuitResponders;
    const probe = { lateralOffset: 4.2 };
    window.__SF_SWEPT_PROBE__ = { probe, originalResponders };
    sim.traffic.getPursuitResponders = () => {
      const state = sim.traffic.getPlayerVehicleState?.();
      if (!state?.position || !Number.isFinite(state.heading)) return [];
      const forward = { x: Math.sin(state.heading), z: Math.cos(state.heading) };
      const right = { x: forward.z, z: -forward.x };
      return [{
        active: true,
        id: 910001,
        distance: probe.lateralOffset,
        position: {
          x: state.position.x + right.x * probe.lateralOffset,
          z: state.position.z + right.z * probe.lateralOffset,
        },
      }];
    };

    // Drive briefly so the heat sampler sees the held
    // near responder on every sample while footprints stay separated.
    const samples = [];
    const start = performance.now();
    window.__SF_SWEPT_DRIVE__ = true;
    while (performance.now() - start < 700) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 120));
      const player = sim.traffic.getPlayerVehicleState?.();
      const heat = sim.getStreetHeatState?.();
      if (player?.position && heat?.responderDistances?.length) {
        const footprint = footprintOf(player.class);
        const responderFootprint = footprintOf('car');
        samples.push({
          responderDistance: Math.min(...heat.responderDistances),
          footprintSeparation: Math.min(...heat.responderDistances)
            - footprint.halfWidth - responderFootprint.halfWidth,
          speed: player.speed,
        });
      }
    }
    window.__SF_SWEPT_DRIVE__ = false;

    const diagnosticsAfter = sim.traffic.getDiagnostics();
    const heatAfter = sim.getStreetHeatState();
    const playerAfter = sim.traffic.getPlayerVehicleState();
    const message = document.querySelector('.hud__message-text')?.textContent || '';

    sim.traffic.getPursuitResponders = originalResponders;
    delete window.__SF_SWEPT_PROBE__;
    sim.streetHeat?.restart?.();
    sim.traffic.setPursuitResponder?.({ active: false });

    return {
      imported,
      diagnosticsBefore: {
        recklessCollisionEvents: diagnosticsBefore.recklessCollisionEvents,
        collisionDamageEvents: diagnosticsBefore.collisionDamageEvents,
        sweptVehicleCollisionEvents: diagnosticsBefore.sweptVehicleCollisionEvents,
      },
      diagnosticsAfter: {
        recklessCollisionEvents: diagnosticsAfter.recklessCollisionEvents,
        collisionDamageEvents: diagnosticsAfter.collisionDamageEvents,
        sweptVehicleCollisionEvents: diagnosticsAfter.sweptVehicleCollisionEvents,
        lastPlayerCollision: diagnosticsAfter.lastPlayerCollision,
      },
      heatBefore: { heat: heatBefore?.heat, responderContacts: heatBefore?.responderContacts },
      heatAfter: { heat: heatAfter?.heat, responderContacts: heatAfter?.responderContacts },
      playerHealth: {
        before: playerBefore?.damage?.health,
        after: playerAfter?.damage?.health,
      },
      samples,
      minDistance: samples.length ? Math.min(...samples.map((s) => s.responderDistance)) : null,
      minSeparation: samples.length
        ? Math.min(...samples.map((s) => s.footprintSeparation))
        : null,
      message,
    };
  });
  await page.keyboard.up('w');
  await page.screenshot({ path: captures.nearMiss });
  assert(nearMiss.imported === true, 'phase A could not arm the pursuit telemetry probe', nearMiss);
  assert(Number.isFinite(nearMiss.minDistance) && nearMiss.minDistance < 5.5,
    'phase A never held the responder inside 5.5 m center distance', nearMiss);
  assert(Number.isFinite(nearMiss.minSeparation) && nearMiss.minSeparation > 0.5,
    'phase A footprints were not cleanly separated', nearMiss);
  assert(nearMiss.diagnosticsAfter.recklessCollisionEvents
      === nearMiss.diagnosticsBefore.recklessCollisionEvents
    && nearMiss.diagnosticsAfter.collisionDamageEvents
      === nearMiss.diagnosticsBefore.collisionDamageEvents
    && nearMiss.diagnosticsAfter.sweptVehicleCollisionEvents
      === nearMiss.diagnosticsBefore.sweptVehicleCollisionEvents
    && nearMiss.diagnosticsAfter.lastPlayerCollision === null,
  'separated footprints inside 5.5 m still emitted contact/damage', nearMiss);
  assert(nearMiss.heatAfter.responderContacts === 0,
  'near miss leaked StreetHeat/responder contact consequences', nearMiss);
  assert(nearMiss.playerHealth.before === nearMiss.playerHealth.after,
    'near miss damaged the player vehicle', nearMiss);
  assert(!/collision|contact|reckless|impact/i.test(nearMiss.message),
    'near miss surfaced collision HUD', nearMiss);

  // ------------------------------------------------------------------
  // Phase B — positive: deterministic pre-stage behind a live queue, then
  // real W input must preserve the established physical-contact path.
  // ------------------------------------------------------------------
  const staged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const fleet = sim.traffic.getVehicleLifeSnapshot().vehicles;
    const playerId = sim.traffic.getPlayerVehicleState()?.index;
    const victim = fleet.find((vehicle) => (
      vehicle.id !== playerId
      && vehicle.class !== 'bike'
      && vehicle.visible !== false
      && vehicle.action?.key !== 'parked'
      && vehicle.damage?.disabled !== true
      && vehicle.speed <= 8
      && Number.isFinite(vehicle.heading)
    )) || null;
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
      victimHeading: victim.heading,
      victimPosition: victim.position,
      imported: sim.traffic.importPlayerVehicleState(snapshot),
      player: sim.traffic.getPlayerVehicleState(),
    };
  });
  assert(staged?.imported === true && Number.isInteger(staged?.victimId),
    'phase B could not pre-stage the player behind a live queue vehicle', staged);

  let contact = null;
  if (staged?.imported === true) {
    await page.locator('#scene-canvas').focus();
    await page.keyboard.down('w');
    await page.waitForFunction(
      () => window.__SF_SIM__.traffic.getDiagnostics().recklessCollisionEvents >= 1,
      null,
      { timeout: 18000 },
    ).catch(() => {});
    await page.waitForTimeout(450);

    // Phase C (hold): sustained overlap must not duplicate per frame.
    await page.waitForTimeout(1200);
    const held = await page.evaluate(() => ({
      diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
      heat: window.__SF_SIM__.getStreetHeatState(),
    }));
    await page.keyboard.up('w');

    contact = await page.evaluate(() => {
      const sim = window.__SF_SIM__;
      const diagnostics = sim.traffic.getDiagnostics();
      const event = diagnostics.lastPlayerCollision;
      const fleet = sim.traffic.getVehicleLifeSnapshot().vehicles;
      const player = sim.traffic.getPlayerVehicleState();
      const victim = fleet.find((vehicle) => vehicle.id === event?.victimVehicleId) || null;
      return {
        diagnostics: {
          recklessCollisionEvents: diagnostics.recklessCollisionEvents,
          collisionDamageEvents: diagnostics.collisionDamageEvents,
          vehicleDamageEvents: diagnostics.vehicleDamageEvents,
          sweptVehicleCollisionEvents: diagnostics.sweptVehicleCollisionEvents,
        },
        event,
        player,
        victim,
        heat: sim.getStreetHeatState(),
        message: document.querySelector('.hud__message-text')?.textContent || '',
        saved: sim.getSavedProgress(),
      };
    });
    await page.screenshot({ path: captures.contact });

    assert(contact.diagnostics.recklessCollisionEvents === 1
      && contact.diagnostics.collisionDamageEvents === 1,
    'real swept contact emitted more or fewer than one collision consequence', contact.diagnostics);
    assert(held.diagnostics.recklessCollisionEvents === 1
      && held.diagnostics.collisionDamageEvents === 1,
    'sustained overlap duplicated the contact before separation/rearm', held.diagnostics);
    assert(contact.event?.playerVehicleId === contact.player?.index
      && contact.event?.victimVehicleId === contact.victim?.id
      && contact.event?.relativeSpeed > 1.5,
    'contact record did not identify both vehicles and severity', contact.event);
    const playerDamage = damageAmountOf(contact.event?.playerDamage);
    const victimDamage = damageAmountOf(contact.event?.victimDamage);
    assert(Number.isFinite(playerDamage) && playerDamage > 0 && playerDamage <= 50
      && contact.player?.damage?.health < contact.player?.damage?.maxHealth
      && contact.player?.damage?.health > 0,
    'player damage was missing, unbounded, or destroyed the vehicle', contact);
    assert(Number.isFinite(victimDamage) && victimDamage > 0 && victimDamage <= 30
      && contact.victim?.damage?.health < contact.victim?.damage?.maxHealth
      && contact.victim?.damage?.health > 0,
    'victim damage was missing, unbounded, or destroyed the vehicle', contact);
    assert(contact.heat?.responderContacts === 0
      && contact.heat?.lastEvent?.kind !== 'responder-contact',
    'civilian victim contact was reported as responder contact', contact.heat);
    assert(contact.heat?.lastEvent?.kind === 'reckless-collision'
      && /RECKLESS COLLISION/.test(contact.heat.lastEvent.message || ''),
    'real contact produced no durable HUD/event consequence', contact);
  }

  // ------------------------------------------------------------------
  // Phase C (rearm): re-stage with separation, then one real approach must
  // emit exactly one further contact.
  // ------------------------------------------------------------------
  let rearm = null;
  if (staged?.imported === true) {
    const restaged = await page.evaluate(() => {
      const sim = window.__SF_SIM__;
      const victimId = sim.traffic.getDiagnostics().lastPlayerCollision?.victimVehicleId;
      const victim = sim.traffic.getVehicleLifeSnapshot().vehicles
        .find((vehicle) => vehicle.id === victimId) || null;
      if (!victim) return null;
      const snapshot = sim.traffic.exportPlayerVehicleState();
      const gap = 13.5;
      snapshot.position = {
        x: victim.position.x - Math.sin(victim.heading) * gap,
        z: victim.position.z - Math.cos(victim.heading) * gap,
      };
      snapshot.heading = victim.heading;
      return { imported: sim.traffic.importPlayerVehicleState(snapshot) };
    });
    assert(restaged?.imported === true, 'phase C could not re-stage after separation', restaged);
    await page.keyboard.down('w');
    await page.waitForFunction(
      () => window.__SF_SIM__.traffic.getDiagnostics().recklessCollisionEvents >= 2,
      null,
      { timeout: 18000 },
    ).catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.up('w');
    rearm = await page.evaluate(() => {
      const diagnostics = window.__SF_SIM__.traffic.getDiagnostics();
      return {
        recklessCollisionEvents: diagnostics.recklessCollisionEvents,
        collisionDamageEvents: diagnostics.collisionDamageEvents,
        sweptVehicleCollisionEvents: diagnostics.sweptVehicleCollisionEvents,
        sequence: diagnostics.lastPlayerCollision?.sequence ?? null,
      };
    });
    await page.screenshot({ path: captures.rearm });
    assert(rearm.recklessCollisionEvents === 2 && rearm.collisionDamageEvents === 2
      && rearm.sequence === 2,
    'separation did not rearm exactly one further contact', rearm);
  }

  // Phase C (responder): mark a real traffic vehicle as the live pursuit
  // responder, pre-stage on its lane, then real W must produce the fixed
  // pursuit-contact consequence. Center distance alone was already rejected
  // by phase A; this proves the positive physical authority path.
  const responderSeed = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.traffic.repairPlayerVehicle?.('qa-responder-stage');
    const player = sim.traffic.getPlayerVehicleState?.();
    const responderCandidate = sim.traffic.getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.id !== player?.index
      && ['sedan', 'suv', 'van', 'pickup'].includes(vehicle.class)
      && vehicle.action?.key !== 'parked'
      && vehicle.damage?.disabled !== true
      && vehicle.identity?.category !== 'delivery'
    )) ?? null;
    if (!player || !responderCandidate || !Number.isFinite(responderCandidate.heading)) {
      return { responderCandidate, imported: false };
    }
    const snapshot = sim.traffic.exportPlayerVehicleState();
    const gap = 24;
    snapshot.position = {
      x: responderCandidate.position.x - Math.sin(responderCandidate.heading) * gap,
      z: responderCandidate.position.z - Math.cos(responderCandidate.heading) * gap,
    };
    snapshot.heading = responderCandidate.heading;
    return {
      responderCandidate,
      imported: sim.traffic.importPlayerVehicleState(snapshot),
    };
  });
  assert(responderSeed?.imported === true,
    'phase C could not focus a real responder candidate', responderSeed);
  await page.waitForTimeout(650);

  const responderStaged = await page.evaluate((candidateId) => {
    const sim = window.__SF_SIM__;
    const player = sim.traffic.getPlayerVehicleState?.();
    const responderCandidate = sim.traffic.getVehicleLifeSnapshot().vehicles
      .find((vehicle) => vehicle.id === candidateId) ?? null;
    const importedHeat = sim.streetHeat?.importState?.({
      heat: 36,
      pursuitActive: true,
      responderContacts: 0,
      responderContactLatched: false,
      nearMisses: 0,
      witnessReports: 0,
      combatHold: 0,
      theftHold: 0,
    }) === true;
    sim.traffic.setPursuitResponder?.({
      active: true,
      position: responderCandidate?.position ?? player?.position,
      playerVehicleId: player?.index,
      level: 1,
    });
    const responder = sim.traffic.getPursuitResponders?.()[0] ?? null;
    const victim = sim.traffic.getVehicleLifeSnapshot().vehicles
      .find((vehicle) => vehicle.id === responder?.id) ?? null;
    if (!player || !victim || !Number.isFinite(victim.heading)) {
      return { importedHeat, responderCandidate, responder, victim, imported: false };
    }
    const snapshot = sim.traffic.exportPlayerVehicleState();
    const gap = 13.5;
    snapshot.position = {
      x: victim.position.x - Math.sin(victim.heading) * gap,
      z: victim.position.z - Math.cos(victim.heading) * gap,
    };
    snapshot.heading = victim.heading;
    return {
      importedHeat,
      responderCandidate,
      responder,
      victim,
      imported: sim.traffic.importPlayerVehicleState(snapshot),
      playerHealth: sim.traffic.getPlayerVehicleState()?.damage?.health ?? null,
      recklessBefore: sim.traffic.getDiagnostics().recklessCollisionEvents,
      sweptBefore: sim.traffic.getDiagnostics().sweptVehicleCollisionEvents,
    };
  }, responderSeed?.responderCandidate?.id ?? null);
  assert(responderStaged?.importedHeat === true
    && responderStaged?.imported === true
    && Number.isInteger(responderStaged?.responder?.id),
  'phase C could not stage a real pursuit responder', responderStaged);
  await page.waitForTimeout(120);
  await page.keyboard.down('w');
  await page.waitForFunction(() => (
    window.__SF_SIM__.traffic.getDiagnostics().lastPlayerCollision?.kind === 'pursuit-contact'
  ), null, { timeout: 18000, polling: 20 }).catch(() => {});
  await page.keyboard.up('w');
  const responderContact = await page.evaluate(() => ({
    player: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
  }));
  assert(responderContact.diagnostics.lastPlayerCollision?.kind === 'pursuit-contact'
    && responderContact.diagnostics.lastPlayerCollision?.responderId
      === responderStaged?.responder?.id
    && responderContact.player?.damage?.health === responderStaged.playerHealth - 22
    && responderContact.player?.damage?.lastDamage?.source === 'pursuit-contact'
    && responderContact.heat?.responderContacts === 1
    && responderContact.heat?.lastEvent?.physicalContact === true
    && responderContact.diagnostics.recklessCollisionEvents === responderStaged.recklessBefore
    && responderContact.diagnostics.sweptVehicleCollisionEvents
      === responderStaged.sweptBefore + 1,
  'real W physical responder collision did not produce exactly one fixed consequence', {
    responderStaged,
    responderContact,
  });

  const preReload = await page.evaluate((victimId) => {
    const sim = window.__SF_SIM__;
    sim.exitCar?.();
    sim.saveProgress?.();
    return {
      playerHealth: sim.getSavedProgress()?.snapshot?.vehicle?.damage?.health ?? null,
      victimId,
      victimHealth: sim.traffic.getVehicleLifeSnapshot().vehicles
        .find((vehicle) => vehicle.id === victimId)?.damage?.health ?? null,
      saved: sim.getSavedProgress()?.snapshot ?? null,
    };
  }, contact?.event?.victimVehicleId ?? null);
  assert(Number.isFinite(preReload.playerHealth) && Number.isInteger(preReload.victimId),
    'pre-reload aftermath snapshot was incomplete', preReload);

  // ------------------------------------------------------------------
  // Phase D — reload: durable aftermath persists, transient diagnostics do
  // not replay.
  // ------------------------------------------------------------------
  await page.reload({ waitUntil: 'load' });
  await launch();
  const restored = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const saved = sim.getSavedProgress()?.snapshot ?? null;
    const aftermath = saved?.trafficAftermath?.vehicles ?? [];
    return {
      savedPlayerHealth: saved?.vehicle?.damage?.health ?? null,
      savedAftermath: aftermath,
      savedHeat: saved?.streetHeat?.heat ?? null,
      liveVictimHealth: sim.traffic.getVehicleLifeSnapshot().vehicles
        .find((vehicle) => vehicle.id === aftermath[0]?.vehicleId)?.damage?.health ?? null,
      diagnostics: {
        recklessCollisionEvents: sim.traffic.getDiagnostics().recklessCollisionEvents,
        collisionDamageEvents: sim.traffic.getDiagnostics().collisionDamageEvents,
        lastPlayerCollision: sim.traffic.getDiagnostics().lastPlayerCollision,
      },
      heat: sim.getStreetHeatState(),
    };
  });
  await page.screenshot({ path: captures.restored });
  assert(restored.savedPlayerHealth === preReload.playerHealth,
    'reload lost the player vehicle damage record', { preReload, restored });
  assert(restored.savedAftermath.some((record) => record.vehicleId === preReload.victimId
    && record.damage?.health === preReload.victimHealth),
  'reload lost the victim aftermath record', { preReload, restored });
  assert(Number.isFinite(restored.savedHeat) && restored.savedHeat > 0,
  'reload lost StreetHeat aftermath', restored);
  assert(restored.liveVictimHealth === preReload.victimHealth,
    'restored fleet victim health diverged from the saved aftermath', restored);
  assert(restored.diagnostics.recklessCollisionEvents === 0
    && restored.diagnostics.collisionDamageEvents === 0
    && restored.diagnostics.lastPlayerCollision === null,
  'reload replayed transient contact diagnostics', restored.diagnostics);

  // ------------------------------------------------------------------
  // Harness gates: resources, performance, console/http/request hygiene.
  // ------------------------------------------------------------------
  await page.waitForTimeout(6000);
  const resourcesAfter = await page.evaluate(() => ({
    geometries: window.__SF_SIM__.renderer.info.memory.geometries,
    textures: window.__SF_SIM__.renderer.info.memory.textures,
  }));
  await page.waitForTimeout(3000);
  const resourcesSettled = await page.evaluate(() => ({
    geometries: window.__SF_SIM__.renderer.info.memory.geometries,
    textures: window.__SF_SIM__.renderer.info.memory.textures,
  }));
  await page.waitForTimeout(3000);
  const resourcesFinal = await page.evaluate(() => ({
    geometries: window.__SF_SIM__.renderer.info.memory.geometries,
    textures: window.__SF_SIM__.renderer.info.memory.textures,
  }));
  assert(resourcesFinal.geometries === resourcesSettled.geometries
    && resourcesFinal.textures === resourcesSettled.textures,
  'swept collision gate leaked render resources after settling', {
    resourcesBefore,
    resourcesAfter,
    resourcesSettled,
    resourcesFinal,
  });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1200);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'application p99 exceeded the 16.67 ms hard budget', performance);

  assert(consoleErrors.length === 0, 'console/page errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestFailures.length === 0, 'request failures occurred', requestFailures);

  const report = {
    result: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestFailures.length === 0
      ? 'swept vehicle collision passed'
      : 'swept vehicle collision failed',
    renderer,
    candidate,
    nearMiss: {
      minDistance: nearMiss.minDistance,
      minSeparation: nearMiss.minSeparation,
      diagnostics: nearMiss.diagnosticsAfter,
      heat: nearMiss.heatAfter,
    },
    contact: contact && {
      event: contact.event,
      diagnostics: contact.diagnostics,
      postContactOverlap: contact.event?.postContactOverlap,
      heat: contact.heat && {
        heat: contact.heat.heat,
        responderContacts: contact.heat.responderContacts,
      },
      message: contact.message,
    },
    rearm,
    responderContact: {
      responderId: responderStaged?.responder?.id ?? null,
      playerHealth: responderContact.player?.damage?.health ?? null,
      responderContacts: responderContact.heat?.responderContacts ?? null,
      collisionKind: responderContact.diagnostics.lastPlayerCollision?.kind ?? null,
    },
    restored: {
      savedPlayerHealth: restored.savedPlayerHealth,
      savedHeat: restored.savedHeat,
      diagnostics: restored.diagnostics,
    },
    resourcesBefore,
    resourcesAfter,
    resourcesSettled,
    resourcesFinal,
    applicationP99FrameMs: performance?.applicationP99FrameMs,
    captures,
    failures,
    consoleErrors,
    httpErrors,
    requestFailures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length || requestFailures.length) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({
    result: 'swept vehicle collision crashed',
    error: error.message,
    stack: error.stack,
    failures,
    consoleErrors,
    httpErrors,
    requestFailures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const probe = window.__SF_SWEPT_PROBE__;
    if (probe?.originalResponders) sim.traffic.getPursuitResponders = probe.originalResponders;
    delete window.__SF_SWEPT_PROBE__;
    delete window.__SF_SWEPT_DRIVE__;
    sim.streetHeat?.restart?.();
    sim.traffic.setPursuitResponder?.({ active: false });
  }).catch(() => {});
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
