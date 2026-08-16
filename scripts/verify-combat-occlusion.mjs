import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const MAX_RANGE = 48;
const EPSILON = 0.015;

if (process.platform !== 'darwin') {
  throw new Error('verify-combat-occlusion requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-combat-occlusion requires SF_QA_ANGLE=metal, received ${angle}`);
}
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
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

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

async function launch() {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.clear());
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(700);
}

async function setFocus(source) {
  const focus = await page.evaluate((requestedSource) => {
    const sim = window.__SF_SIM__;
    const stagedResident = sim.pedestrians?.getCombatCandidates?.([])?.[0] ?? null;
    sim.pedestrians?.setQaWitnessAnchor?.();
    if (requestedSource === 'core') {
      const position = { x: 28, z: 38 };
      sim.setRoamPose(position);
      return { position, sectorKey: '0:0', residentId: stagedResident?.id ?? null };
    }
    const stop = sim.getStreamingEvidenceStops?.()
      ?.find((candidate) => candidate.sectorKey && candidate.sectorKey !== '0:0');
    if (!stop) return null;
    const position = { x: stop.lookAt.x, z: stop.lookAt.z };
    sim.setRoamPose(position);
    return { position, sectorKey: stop.sectorKey, residentId: stagedResident?.id ?? null };
  }, source);
  assert(focus, `no ${source} focus position is exposed for the occlusion verifier`);
  if (!focus) throw new Error(`unable to focus ${source} blocker scenario`);
  await page.waitForFunction((expected) => {
    const sim = window.__SF_SIM__;
    return sim.streaming?.stats?.focusSector === expected.sectorKey
      && sim.streaming?.isSectorActive?.(expected.sectorKey) === true
      && (expected.sectorKey === '0:0' || sim.streaming?.isSectorDetailed?.(expected.sectorKey) === true);
  }, focus, { timeout: 20000, polling: 50 });
  if (source === 'streamed' && focus.residentId) {
    const staged = await page.evaluate(({ sectorKey, residentId }) => {
      const sim = window.__SF_SIM__;
      const volume = (sim.streaming?.getSectorBuildingVolumes?.(sectorKey) || [])
        .filter((candidate) => candidate?.min && candidate?.max)
        .sort((left, right) => (
          (right.max.y - right.min.y) - (left.max.y - left.min.y)
        ))[0];
      if (!volume) return null;
      const x = volume.max.x + 2.4;
      const z = (volume.min.z + volume.max.z) * 0.5;
      const y = sim.streaming?.getSurfaceHeight?.({ x, z }) ?? volume.min.y;
      sim.pedestrians?.setFocus?.({ x: 0, z: 0 }, 340);
      const anchored = sim.pedestrians?.setQaWitnessAnchor?.(residentId, { x, y, z }) === true;
      sim.pedestrians?.setFocus?.({ x, z }, 32);
      sim.pedestrians?.update?.(0.001, performance.now() / 1000);
      const vehicle = (sim.traffic?.getVehicleLifeSnapshot?.().vehicles || [])
        .find((candidate) => candidate?.combatEligible !== false
          && candidate?.damage?.disabled !== true
          && candidate?.class !== 'bike');
      const vehicleRoot = Number.isInteger(vehicle?.id)
        ? sim.traffic?.group?.children?.[vehicle.id]
        : null;
      const vehiclePosition = vehicleRoot ? {
        x: volume.max.x + 3.2,
        y: sim.streaming?.getSurfaceHeight?.({ x: volume.max.x + 3.2, z: z - 1.2 })
          ?? volume.min.y,
        z: z - 1.2,
      } : null;
      if (vehicleRoot && vehiclePosition) {
        vehicleRoot.position.set(vehiclePosition.x, vehiclePosition.y, vehiclePosition.z);
        vehicleRoot.updateMatrixWorld(true);
      }
      return {
        resident: anchored ? { residentId, x, y, z, volumeId: volume.id ?? null } : null,
        vehicle: vehicleRoot && vehiclePosition
          ? { vehicleId: vehicle.id, position: vehiclePosition, volumeId: volume.id ?? null }
          : null,
      };
    }, focus);
    focus.stagedResident = staged?.resident ?? null;
    focus.stagedVehicle = staged?.vehicle ?? null;
    assert(focus.stagedResident, 'streamed focus could not stage an existing resident by an active volume', focus);
    assert(focus.stagedVehicle, 'streamed focus could not stage an existing traffic vehicle by an active volume', focus);
  }
  return focus;
}

async function findScenario({ source, kind, blocked, focus = null }) {
  return page.evaluate(({ expectedSource, expectedKind, requireBlocked, maxRange, streamStage }) => {
    const sim = window.__SF_SIM__;
    const cityRay = sim.city?.getNearestRayBlocker;
    const streamingRay = sim.streaming?.getNearestRayBlocker;
    if (typeof cityRay !== 'function' || typeof streamingRay !== 'function') {
      return {
        apiError: 'Both city.getNearestRayBlocker and streaming.getNearestRayBlocker must be functions.',
      };
    }

    const isFinitePoint = (point) => ['x', 'y', 'z'].every((axis) => Number.isFinite(point?.[axis]));
    const readBlocker = (raw, expectedBlockerSource) => {
      if (raw == null) return null;
      if (!Number.isFinite(raw.distance) || raw.distance <= 0 || !isFinitePoint(raw.point)) {
        return { invalid: true, source: expectedBlockerSource, raw };
      }
      return {
        id: raw.id ?? null,
        source: raw.source,
        expectedSource: expectedBlockerSource,
        distance: raw.distance,
        point: { x: raw.point.x, y: raw.point.y, z: raw.point.z },
      };
    };
    if (expectedSource === 'streamed'
      && expectedKind === 'traffic'
      && Number.isInteger(streamStage?.stagedVehicle?.vehicleId)) {
      const root = sim.traffic?.group?.children?.[streamStage.stagedVehicle.vehicleId];
      const position = streamStage.stagedVehicle.position;
      if (root && isFinitePoint(position)) {
        root.position.set(position.x, position.y, position.z);
        root.visible = true;
        root.updateMatrixWorld(true);
      }
    }
    const actors = [];
    const appendActor = (candidate, kind, id, label, vehicle = null) => {
      const mesh = candidate?.mesh
        || (kind === 'traffic' ? sim.traffic?.group?.children?.[vehicle?.id] : null);
      if (!mesh?.getWorldPosition || mesh.visible === false || mesh.userData?.combatDisabled === true) return;
      const position = mesh.getWorldPosition(new mesh.position.constructor());
      const height = Number.isFinite(candidate?.height)
        ? candidate.height
        : kind === 'traffic' ? 0.82 : 1.15;
      actors.push({
        kind,
        id: String(id),
        label: String(label || kind),
        vehicleId: kind === 'traffic' ? Number(vehicle?.id) : null,
        basePosition: { x: position.x, y: position.y, z: position.z },
        position: { x: position.x, y: position.y + height, z: position.z },
      });
    };

    if (expectedKind === 'pedestrian') {
      const candidates = [
        ...(sim.pedestrians?.getCombatCandidates?.([]) || []),
        ...(sim.streamedAgents?.getCombatCandidates?.([]) || []),
      ];
      const seen = new Set();
      candidates.forEach((candidate) => {
        const id = String(candidate?.id ?? candidate?.residentId ?? '');
        if (!id || seen.has(id)) return;
        seen.add(id);
        appendActor(candidate, 'pedestrian', id, candidate.label || candidate.role || 'Pedestrian');
      });
    } else {
      const vehicles = sim.traffic?.getVehicleLifeSnapshot?.().vehicles || [];
      vehicles.forEach((vehicle) => {
        if (vehicle?.visible === false
          || vehicle?.combatEligible === false
          || vehicle?.damage?.disabled === true
          || vehicle?.class === 'bike') return;
        appendActor(null, 'traffic', `traffic:${vehicle.id}`, vehicle.identity?.label || vehicle.class, vehicle);
      });
    }

    const angles = Array.from({ length: 24 }, (_entry, index) => index * Math.PI / 12);
    const radii = [8, 12, 16, 22, 30, 38];
    const candidates = [];
    actors.forEach((actor) => {
      angles.forEach((angle) => {
        radii.forEach((radius) => {
          const origin = {
            x: actor.position.x + Math.cos(angle) * radius,
            y: actor.position.y,
            z: actor.position.z + Math.sin(angle) * radius,
          };
          const dx = actor.position.x - origin.x;
          const dy = actor.position.y - origin.y;
          const dz = actor.position.z - origin.z;
          const distance = Math.hypot(dx, dy, dz);
          if (distance < 2 || distance >= maxRange) return;
          const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
          const blockerRange = distance - 0.35;
          const core = readBlocker(cityRay.call(sim.city, origin, direction, blockerRange), 'core');
          const streamed = readBlocker(
            streamingRay.call(sim.streaming, origin, direction, blockerRange),
            'streamed',
          );
          if (core?.invalid || streamed?.invalid) return;
          const ordered = [core, streamed].filter(Boolean).sort((left, right) => (
            left.distance - right.distance || left.expectedSource.localeCompare(right.expectedSource)
          ));
          const nearest = ordered[0] || null;
          if (requireBlocked) {
            if (!nearest || nearest.distance < 1 || nearest.expectedSource !== expectedSource) return;
            // The method itself must identify the layer it owns. Otherwise a
            // stale or ambiguous collision source could silently pass.
            if (nearest.source !== expectedSource) return;
          } else if (nearest) {
            return;
          }
          candidates.push({
            actor,
            origin,
            direction,
            target: actor.position,
            targetDistance: distance,
            core,
            streamed,
            nearest,
          });
        });
      });
    });
    candidates.sort((left, right) => (
      (left.nearest?.distance ?? Infinity) - (right.nearest?.distance ?? Infinity)
      || left.actor.id.localeCompare(right.actor.id)
      || left.targetDistance - right.targetDistance
    ));
    return {
      actorCount: actors.length,
      scenario: candidates[0] || null,
      apiSources: {
        core: typeof cityRay,
        streamed: typeof streamingRay,
      },
    };
  }, {
    expectedSource: source,
    expectedKind: kind,
    requireBlocked: blocked,
    maxRange: MAX_RANGE,
    streamStage: focus,
  });
}

async function addNearMissEvidenceActors(scenario) {
  return page.evaluate((stage) => {
    const sim = window.__SF_SIM__;
    const candidates = (sim.pedestrians?.getCombatCandidates?.([]) || [])
      .filter((candidate) => candidate?.mesh?.visible !== false
        && candidate?.mesh?.userData?.combatDisabled !== true
        && String(candidate.id ?? candidate.residentId) !== stage.actor.id);
    const horizontalLength = Math.hypot(stage.direction.x, stage.direction.z);
    if (candidates.length < 2 || horizontalLength < 1e-5
      || !Number.isFinite(stage.nearest?.distance)) return null;
    const sideX = -stage.direction.z / horizontalLength;
    const sideZ = stage.direction.x / horizontalLength;
    const actorAt = (candidate, distance) => ({
      id: String(candidate.id ?? candidate.residentId),
      position: {
        x: stage.origin.x + stage.direction.x * distance + sideX * 1.55,
        y: stage.origin.y + stage.direction.y * distance - 1.18,
        z: stage.origin.z + stage.direction.z * distance + sideZ * 1.55,
      },
      originalPosition: {
        x: candidate.mesh.position.x,
        y: candidate.mesh.position.y,
        z: candidate.mesh.position.z,
      },
    });
    return {
      ...stage,
      nearMissActors: {
        front: actorAt(candidates[0], Math.max(0.8, stage.nearest.distance * 0.45)),
        rear: actorAt(candidates[1], stage.nearest.distance + 3.4),
      },
    };
  }, scenario);
}

async function armScenario(scenario) {
  await page.evaluate((stage) => {
    const sim = window.__SF_SIM__;
    sim.setCameraPose?.(null, null);
    sim.pedestrians?.setQaWitnessAnchor?.();
    if (stage.actor.kind === 'pedestrian') {
      sim.pedestrians?.setQaWitnessAnchor?.(stage.actor.id, stage.actor.basePosition);
    } else {
      const root = sim.traffic?.group?.children?.[stage.actor.vehicleId];
      if (root) {
        root.position.set(stage.actor.basePosition.x, stage.actor.basePosition.y, stage.actor.basePosition.z);
        root.visible = true;
        root.updateMatrixWorld(true);
      }
    }
    for (const actor of Object.values(stage.nearMissActors || {})) {
      const candidate = sim.pedestrians?.getCombatCandidates?.([])
        ?.find((entry) => String(entry.id ?? entry.residentId) === actor.id);
      if (!candidate?.mesh) continue;
      candidate.mesh.position.set(actor.position.x, actor.position.y, actor.position.z);
      candidate.mesh.updateMatrixWorld(true);
    }
    sim.setRoamPose({ x: stage.origin.x, z: stage.origin.z });
  }, scenario);
  await page.mouse.move(640, 360);
}

async function fireRealShot(scenario) {
  await armScenario(scenario);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.().aiming === true,
    null, { timeout: 3000 });
  await page.evaluate((stage) => {
    const sim = window.__SF_SIM__;
    if (stage.actor.kind === 'traffic') {
      const root = sim.traffic?.group?.children?.[stage.actor.vehicleId];
      if (root) {
        root.position.set(stage.actor.basePosition.x, stage.actor.basePosition.y, stage.actor.basePosition.z);
        root.visible = true;
        root.updateMatrixWorld(true);
      }
    }
    for (const actor of Object.values(stage.nearMissActors || {})) {
      const candidate = sim.pedestrians?.getCombatCandidates?.([])
        ?.find((entry) => String(entry.id ?? entry.residentId) === actor.id);
      if (!candidate?.mesh) continue;
      candidate.mesh.position.set(actor.position.x, actor.position.y, actor.position.z);
      candidate.mesh.updateMatrixWorld(true);
    }
    sim.camera.position.set(stage.origin.x, stage.origin.y, stage.origin.z);
    sim.camera.lookAt(stage.target.x, stage.target.y, stage.target.z);
    sim.camera.updateMatrixWorld(true);
  }, scenario);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(55);
  const evidence = await page.evaluate((stage) => {
    const sim = window.__SF_SIM__;
    const targetMesh = stage.actor.kind === 'traffic'
      ? sim.traffic?.group?.children?.[stage.actor.vehicleId]
      : [...(sim.pedestrians?.getCombatCandidates?.([]) || []), ...(sim.streamedAgents?.getCombatCandidates?.([]) || [])]
        .find((candidate) => String(candidate.id ?? candidate.residentId) === stage.actor.id)?.mesh;
    const trafficVehicle = stage.actor.kind === 'traffic'
      ? sim.traffic?.getVehicleLifeSnapshot?.().vehicles?.find((vehicle) => vehicle.id === stage.actor.vehicleId) ?? null
      : null;
    const shotEvent = sim.getCombatState()?.lastEvent ?? null;
    const shotRay = shotEvent?.ray;
    const coreBlocker = shotRay
      ? sim.city?.getNearestRayBlocker?.(shotRay.origin, shotRay.direction, stage.maxRange) ?? null
      : null;
    const streamedBlocker = shotRay
      ? sim.streaming?.getNearestRayBlocker?.(shotRay.origin, shotRay.direction, stage.maxRange) ?? null
      : null;
    const nearestBlocker = [coreBlocker, streamedBlocker]
      .filter((blocker) => Number.isFinite(blocker?.distance))
      .sort((left, right) => left.distance - right.distance
        || String(left.source || '').localeCompare(String(right.source || '')))[0] ?? null;
    const nearMissActors = Object.fromEntries(Object.entries(stage.nearMissActors || {}).map(([key, actor]) => {
      const candidate = sim.pedestrians?.getCombatCandidates?.([])
        ?.find((entry) => String(entry.id ?? entry.residentId) === actor.id);
      return [key, candidate?.mesh ? {
        id: actor.id,
        reaction: candidate.mesh.userData?.combatReaction ?? null,
        reactionSource: candidate.mesh.userData?.combatReactionSource ?? null,
      } : null];
    }));
    const tracers = [];
    sim.scene?.traverse?.((object) => {
      if (!object?.isLine || !String(object.name).startsWith('Combat tracer')) return;
      const attribute = object.geometry?.getAttribute?.('position');
      if (!object.visible || !attribute || attribute.count < 2) return;
      tracers.push({
        name: object.name,
        end: {
          x: attribute.getX(1),
          y: attribute.getY(1),
          z: attribute.getZ(1),
        },
      });
    });
    return {
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      save: sim.getSavedProgress?.().snapshot ?? null,
      pedestrianAftermath: sim.pedestrians?.exportCombatAftermathState?.() ?? null,
      trafficAftermath: sim.traffic?.exportCollisionAftermathState?.() ?? null,
      target: targetMesh ? {
        disabled: targetMesh.userData?.combatDisabled === true,
        defeated: targetMesh.userData?.combatDefeated === true,
        reaction: targetMesh.userData?.combatReaction ?? null,
        reactionSource: targetMesh.userData?.combatReactionSource ?? null,
      } : null,
      vehicle: trafficVehicle ? {
        id: trafficVehicle.id,
        damage: trafficVehicle.damage,
      } : null,
      tracers,
      blockers: { core: coreBlocker, streamed: streamedBlocker, nearest: nearestBlocker },
      nearMissActors,
    };
  }, { ...scenario, maxRange: MAX_RANGE });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(45);
  return evidence;
}

async function baselineFor(scenario) {
  return page.evaluate((stage) => {
    const sim = window.__SF_SIM__;
    sim.streetHeat?.restart?.();
    sim.restartCombat?.();
    const targetMesh = stage.actor.kind === 'traffic'
      ? sim.traffic?.group?.children?.[stage.actor.vehicleId]
      : [...(sim.pedestrians?.getCombatCandidates?.([]) || []), ...(sim.streamedAgents?.getCombatCandidates?.([]) || [])]
        .find((candidate) => String(candidate.id ?? candidate.residentId) === stage.actor.id)?.mesh;
    const trafficVehicle = stage.actor.kind === 'traffic'
      ? sim.traffic?.getVehicleLifeSnapshot?.().vehicles?.find((vehicle) => vehicle.id === stage.actor.vehicleId) ?? null
      : null;
    const nearMissActors = Object.fromEntries(Object.entries(stage.nearMissActors || {}).map(([key, actor]) => {
      const candidate = sim.pedestrians?.getCombatCandidates?.([])
        ?.find((entry) => String(entry.id ?? entry.residentId) === actor.id);
      return [key, candidate?.mesh ? {
        id: actor.id,
        reaction: candidate.mesh.userData?.combatReaction ?? null,
        reactionSource: candidate.mesh.userData?.combatReactionSource ?? null,
      } : null];
    }));
    return {
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      save: sim.getSavedProgress?.().snapshot ?? null,
      pedestrianAftermath: sim.pedestrians?.exportCombatAftermathState?.() ?? null,
      trafficAftermath: sim.traffic?.exportCollisionAftermathState?.() ?? null,
      target: targetMesh ? {
        disabled: targetMesh.userData?.combatDisabled === true,
        defeated: targetMesh.userData?.combatDefeated === true,
        reaction: targetMesh.userData?.combatReaction ?? null,
        reactionSource: targetMesh.userData?.combatReactionSource ?? null,
      } : null,
      vehicle: trafficVehicle ? {
        id: trafficVehicle.id,
        damage: trafficVehicle.damage,
      } : null,
      nearMissActors,
    };
  }, scenario);
}

function closeEnough(left, right, epsilon = EPSILON) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= epsilon;
}

function samePoint(left, right) {
  return ['x', 'y', 'z'].every((axis) => closeEnough(left?.[axis], right?.[axis]));
}

function verifyBlockedCase({ source, kind, stage, before, after }) {
  const event = after.combat?.lastEvent;
  const expected = after.blockers?.nearest;
  const matchingTracer = after.tracers?.some((tracer) => samePoint(tracer.end, event?.point));
  assert(stage.core == null || stage.core.source === 'core',
    `${source}/${kind} city blocker did not self-identify as core`, stage);
  assert(stage.streamed == null || stage.streamed.source === 'streamed',
    `${source}/${kind} streaming blocker did not self-identify as streamed`, stage);
  assert(expected?.source === source
    && (after.blockers?.core == null || after.blockers.core.distance >= expected.distance - EPSILON)
    && (after.blockers?.streamed == null || after.blockers.streamed.distance >= expected.distance - EPSILON),
  `${source}/${kind} did not select the exact nearest blocker from the fired ray`, after.blockers);
  assert(after.combat?.ammo === before.combat?.ammo - 1
    && after.combat?.shots === before.combat?.shots + 1,
  `${source}/${kind} blocked LMB did not consume exactly one round`, { before, after });
  assert(event?.blocked === true
    && event?.source === source
    && closeEnough(event?.distance, expected?.distance)
    && samePoint(event?.point, expected?.point),
  `${source}/${kind} blocked shot omitted the authoritative blocker event payload`, { expected, event });
  assert(matchingTracer,
    `${source}/${kind} tracer did not terminate at the reported blocker point`, { expected, tracers: after.tracers });
  assert(after.combat?.hits === before.combat?.hits
    && after.combat?.defeats === before.combat?.defeats
    && sameJson(after.target, before.target)
    && sameJson(after.vehicle, before.vehicle),
  `${source}/${kind} blocked shot produced an actor reaction, defeat, or vehicle damage`, { before, after });
  assert(after.heat?.witnessReports === before.heat?.witnessReports
    && sameJson(after.pedestrianAftermath, before.pedestrianAftermath)
    && sameJson(after.trafficAftermath, before.trafficAftermath)
    && sameJson(after.save, before.save),
  `${source}/${kind} blocked shot mutated witnesses, aftermath, or the saved ledger`, { before, after });
  if (stage.nearMissActors) {
    assert(event?.nearReactions >= 1
      && after.nearMissActors?.front?.reactionSource === 'near-miss',
    `${source}/${kind} blocked shot did not preserve the front-side near-miss reaction`, { before, after });
    assert(after.nearMissActors?.rear?.reactionSource !== 'near-miss'
      && sameJson(after.nearMissActors?.rear, before.nearMissActors?.rear),
    `${source}/${kind} blocked shot leaked a near-miss reaction through the wall`, { before, after });
  }
}

function verifyUnobstructedControl({ kind, stage, before, after }) {
  const event = after.combat?.lastEvent;
  assert(stage.nearest == null && stage.core == null && stage.streamed == null,
    `${kind} unobstructed control had a collision blocker`, stage);
  assert(after.combat?.ammo === before.combat?.ammo - 1
    && after.combat?.shots === before.combat?.shots + 1
    && after.combat?.hits === before.combat?.hits + 1
    && event?.blocked !== true,
  `${kind} unobstructed control did not register a real hit`, { before, after });
  if (kind === 'traffic') {
    assert(Number(after.vehicle?.damage?.health) < Number(before.vehicle?.damage?.health),
      'traffic unobstructed control did not damage the aimed vehicle', { before, after });
  } else {
    assert(after.combat?.reactionCount > before.combat?.reactionCount
      && after.target?.reactionSource === 'hit',
    'pedestrian unobstructed control did not produce a hit reaction', { before, after });
  }
}

try {
  await launch();
  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string'
    && /apple.*metal|metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe|angle \(.*(swiftshader|software))/i.test(renderer),
  'a verified Apple Metal hardware renderer was required; software rendering is rejected', { angle, renderer });

  const blockedCases = [];
  for (const source of ['core', 'streamed']) {
    const focus = await setFocus(source);
    for (const kind of ['pedestrian', 'traffic']) {
      const discovered = await findScenario({ source, kind, blocked: true, focus });
      assert(!discovered.apiError, `${source}/${kind} blocker API contract is unavailable`, discovered);
      assert(discovered.scenario, `${source}/${kind} did not expose a live actor behind its nearest blocker`, discovered);
      if (!discovered.scenario) continue;
      const stage = source === 'core' && kind === 'pedestrian'
        ? await addNearMissEvidenceActors(discovered.scenario) ?? discovered.scenario
        : discovered.scenario;
      assert(source !== 'core' || kind !== 'pedestrian' || stage.nearMissActors,
        'front/rear near-miss evidence actors could not be staged', stage);
      const before = await baselineFor(stage);
      const after = await fireRealShot(stage);
      verifyBlockedCase({ source, kind, stage, before, after });
      blockedCases.push({ source, kind, discovered, stage, before, after });
    }
  }

  await setFocus('core');
  const controls = [];
  for (const kind of ['pedestrian', 'traffic']) {
    const discovered = await findScenario({ source: 'core', kind, blocked: false });
    assert(!discovered.apiError, `${kind} unobstructed control blocker API contract is unavailable`, discovered);
    assert(discovered.scenario, `${kind} unobstructed control could not find a clear live shot`, discovered);
    if (!discovered.scenario) continue;
    const before = await baselineFor(discovered.scenario);
    const after = await fireRealShot(discovered.scenario);
    verifyUnobstructedControl({ kind, stage: discovered.scenario, before, after });
    controls.push({ kind, discovered, before, after });
  }

  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1300);
  const performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'combat occlusion verification exceeded the 16.67 ms application p99 budget', performance);
  assert(consoleErrors.length === 0, 'console errors leaked during combat occlusion verification', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors leaked during combat occlusion verification', httpErrors);
  assert(requestFailures.length === 0, 'failed requests leaked during combat occlusion verification', requestFailures);

  const report = {
    pass: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestFailures.length === 0,
    baseUrl,
    angle,
    renderer,
    blockedCases,
    controls,
    performance,
    consoleErrors,
    httpErrors,
    requestFailures,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'combat occlusion verifier failed',
    error: error.message,
    stack: error.stack,
    consoleErrors,
    httpErrors,
    requestFailures,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
