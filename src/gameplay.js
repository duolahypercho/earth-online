import * as THREE from 'three';

const SHIFT_STEPS = Object.freeze([
  {
    id: 'welcome-center',
    label: 'Reach the Embarcadero Welcome Center',
    shortLabel: 'Welcome Center',
    hint: 'Follow the amber beacon to the public lobby and enter.',
    tag: 'ARRIVE',
    kind: 'portal',
    portalLabel: 'Embarcadero Welcome Center',
  },
  {
    id: 'welcome-desk',
    label: 'Ask Mara for the waterfront route',
    shortLabel: 'Ask Mara',
    hint: 'Inside, find the lit WELCOME DESK and press E.',
    tag: 'TALK',
    kind: 'hotspot',
    hotspotId: 'welcome-desk',
  },
  {
    id: 'bay-route-model',
    label: 'Mark the Bay route on the tactile model',
    shortLabel: 'Mark the Bay route',
    hint: 'Inspect the amber-lit BAY ROUTE MODEL.',
    tag: 'INSPECT',
    kind: 'hotspot',
    hotspotId: 'bay-route-model',
  },
  {
    id: 'map-archive',
    label: 'Open the map archive',
    shortLabel: 'Open the archive',
    hint: 'Find the MAP ARCHIVE and unlock the waterfront records.',
    tag: 'UNLOCK',
    kind: 'hotspot',
    hotspotId: 'map-archive',
  },
  {
    id: 'ferry-building',
    label: 'Finish the loop at the Ferry Building',
    shortLabel: 'Ferry Building',
    hint: 'Exit to the avenue, then follow the waterfront route north.',
    tag: 'DELIVER',
    kind: 'portal',
    portalLabel: 'Ferry Building market hall',
  },
  {
    id: 'coit-tower',
    label: 'Take the route to Coit Tower',
    shortLabel: 'Coit Tower',
    hint: 'Climb the hill and enter the observation deck before sunset.',
    tag: 'COMPLETE',
    kind: 'portal',
    portalLabel: 'Coit Tower observation deck',
  },
]);
const SHIFT_TIME_LIMIT_SECONDS = 480;
const SHIFT_BASE_CASH_REWARD = 180;

function findPortal(city, label) {
  return city?.portals?.find((portal) => portal.room && portal.label === label) || null;
}

function formatClock(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, '0');
  const remainder = (safeSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

/**
 * Adds a small, replayable game loop to the simulation without changing the
 * authored city systems. The shift reuses real portals and the flagship room's
 * existing interactions, so the player is rewarded for seeing the work that is
 * already in the world rather than chasing abstract UI-only checkpoints.
 */
export function createCityShift({ scene, city, onAdvance } = {}) {
  if (!scene?.isScene || !city) {
    throw new TypeError('createCityShift requires a THREE.Scene and city runtime.');
  }

  const steps = SHIFT_STEPS.map((step) => ({
    ...step,
    portal: step.kind === 'portal' ? findPortal(city, step.portalLabel) : null,
  }));

  const state = {
    status: 'ready',
    stepIndex: 0,
    score: 0,
    elapsed: 0,
    lastAdvance: null,
    cashReward: 0,
    failureReason: null,
  };

  const marker = new THREE.Group();
  marker.name = 'City Shift objective beacon';
  marker.visible = false;
  marker.renderOrder = 9;
  marker.frustumCulled = false;

  const markerGlow = new THREE.MeshStandardMaterial({
    color: 0xf3bd6d,
    emissive: 0xd56a31,
    emissiveIntensity: 2.2,
    roughness: 0.32,
    metalness: 0.08,
    transparent: true,
    opacity: 0.96,
    depthWrite: false,
  });
  const markerRingMaterial = new THREE.MeshBasicMaterial({
    color: 0x6bd6c5,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  const markerCore = new THREE.Mesh(
    new THREE.ConeGeometry(0.26, 0.72, 5),
    markerGlow,
  );
  markerCore.position.y = 1.92;
  markerCore.castShadow = false;
  const markerStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 2.1, 5),
    markerGlow,
  );
  markerStem.position.y = 0.9;
  markerStem.castShadow = false;
  const markerRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.76, 0.045, 6, 18),
    markerRingMaterial,
  );
  markerRing.rotation.x = Math.PI * 0.5;
  markerRing.position.y = 0.08;
  markerRing.castShadow = false;
  marker.add(markerCore, markerStem, markerRing);
  scene.add(marker);

  const targetVector = new THREE.Vector3();
  const markerVector = new THREE.Vector3();
  let markerTime = 0;

  function currentStep() {
    return steps[state.stepIndex] || null;
  }

  function hotspotTarget(step, activePortal) {
    if (!step || step.kind !== 'hotspot' || !activePortal?.room) return null;
    const interior = city.getInteriorState?.();
    const hotspot = interior?.flagship?.hotspots?.find(
      (candidate) => candidate.id === step.hotspotId,
    );
    if (!hotspot?.position) return null;
    return new THREE.Vector3(
      activePortal.room.position.x + hotspot.position.x,
      activePortal.room.position.y + 0.18,
      activePortal.room.position.z + hotspot.position.z,
    );
  }

  function targetPosition(activePortal) {
    const step = currentStep();
    if (!step) return null;
    if (step.kind === 'portal') {
      if (!step.portal?.position) return null;
      return targetVector.copy(step.portal.position);
    }
    return hotspotTarget(step, activePortal);
  }

  function getTargetDistance(position, activePortal) {
    if (!position) return null;
    const target = targetPosition(activePortal);
    if (!target) return null;
    return Math.hypot(position.x - target.x, position.z - target.z);
  }

  function emitAdvance(step, completed) {
    const baseReward = 280;
    const timeBonus = Math.max(80, 520 - Math.round(state.elapsed * 4));
    state.score += baseReward + timeBonus;
    state.lastAdvance = step.id;
    state.cashReward = completed
      ? SHIFT_BASE_CASH_REWARD + Math.max(0, Math.ceil((SHIFT_TIME_LIMIT_SECONDS - state.elapsed) / 60) * 10)
      : 0;
    const message = completed
      ? `Waterfront loop complete · ${formatClock(state.elapsed)} · $${state.cashReward} paid`
      : `${step.shortLabel} logged · next: ${currentStep()?.shortLabel || 'free roam'}`;
    onAdvance?.({
      step,
      completed,
      message,
      score: state.score,
      cashReward: state.cashReward,
    });
  }

  function fail(reason = 'time-limit') {
    if (state.status !== 'running') return null;
    state.status = 'failed';
    state.failureReason = String(reason || 'time-limit');
    state.cashReward = 0;
    marker.visible = false;
    const message = `Shift failed · ${formatClock(state.elapsed)} · replay to try again`;
    onAdvance?.({
      step: currentStep(),
      completed: false,
      failed: true,
      message,
      score: state.score,
      cashReward: 0,
    });
    return { failed: true, reason: state.failureReason };
  }

  function advance(step) {
    if (state.status !== 'running' || !step || step !== currentStep()) return null;
    state.stepIndex += 1;
    const completed = state.stepIndex >= steps.length;
    if (completed) state.status = 'complete';
    emitAdvance(step, completed);
    return { completed, step };
  }

  function start() {
    state.status = 'running';
    state.stepIndex = 0;
    state.score = 0;
    state.elapsed = 0;
    state.lastAdvance = null;
    state.cashReward = 0;
    state.failureReason = null;
    marker.visible = true;
  }

  function restart() {
    start();
  }

  function exportState() {
    return {
      status: state.status,
      stepIndex: state.stepIndex,
      score: state.score,
      elapsed: state.elapsed,
      lastAdvance: state.lastAdvance,
      cashReward: state.cashReward,
      failureReason: state.failureReason,
    };
  }

  function importState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const allowedStatuses = new Set(['running', 'complete', 'failed']);
    if (!allowedStatuses.has(snapshot.status)) return false;
    const stepIndex = Number(snapshot.stepIndex);
    const score = Number(snapshot.score);
    const elapsed = Number(snapshot.elapsed);
    if (!Number.isFinite(stepIndex) || !Number.isFinite(score) || !Number.isFinite(elapsed)) {
      return false;
    }
    state.status = snapshot.status;
    state.stepIndex = THREE.MathUtils.clamp(Math.round(stepIndex), 0, steps.length);
    if (state.status === 'complete') state.stepIndex = steps.length;
    if (state.status === 'running' && elapsed >= SHIFT_TIME_LIMIT_SECONDS) {
      state.status = 'failed';
    }
    state.score = Math.max(0, Math.round(score));
    state.elapsed = THREE.MathUtils.clamp(elapsed, 0, SHIFT_TIME_LIMIT_SECONDS);
    state.lastAdvance = typeof snapshot.lastAdvance === 'string'
      ? snapshot.lastAdvance.slice(0, 64)
      : null;
    state.cashReward = state.status === 'complete'
      ? Math.max(0, Math.round(Number(snapshot.cashReward) || 0))
      : 0;
    state.failureReason = state.status === 'failed'
      ? String(snapshot.failureReason || 'time-limit').slice(0, 64)
      : null;
    marker.visible = state.status === 'running';
    return true;
  }

  function awardBonus(amount = 0) {
    const bonus = Math.max(0, Math.round(Number(amount) || 0));
    state.score += bonus;
    return state.score;
  }

  function onPortalEntered(portal) {
    const step = currentStep();
    if (state.status !== 'running' || step?.kind !== 'portal' || !portal) return null;
    const matchingPortal = step.portal && portal.id === step.portal.id;
    if (!matchingPortal) return null;
    return advance(step);
  }

  function onHotspotUsed(result) {
    const step = currentStep();
    if (state.status !== 'running' || step?.kind !== 'hotspot' || !result) return null;
    if (result.id !== step.hotspotId) return null;
    return advance(step);
  }

  function update(dt = 0, position = null, activePortal = null) {
    const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    if (state.status === 'running') {
      state.elapsed += delta;
      if (state.elapsed >= SHIFT_TIME_LIMIT_SECONDS) {
        state.elapsed = SHIFT_TIME_LIMIT_SECONDS;
        fail('time-limit');
      }
    }
    markerTime += delta;

    const target = targetPosition(activePortal);
    if (!target || state.status !== 'running') {
      marker.visible = false;
    } else {
      marker.visible = true;
      markerVector.copy(target);
      markerVector.y += 0.1;
      marker.position.lerp(markerVector, 1 - Math.exp(-12 * Math.max(delta, 1 / 120)));
      markerCore.position.y = 1.86 + Math.sin(markerTime * 3.6) * 0.13;
      markerCore.rotation.y = markerTime * 1.9;
      markerRing.rotation.z = markerTime * 1.3;
      markerRing.scale.setScalar(0.92 + Math.sin(markerTime * 3.6) * 0.08);
      markerGlow.emissiveIntensity = 1.9 + (Math.sin(markerTime * 4.2) * 0.5 + 0.5) * 0.9;
    }

    return getState(position, activePortal);
  }

  function getState(position = null, activePortal = null) {
    const step = currentStep();
    const distance = getTargetDistance(position, activePortal);
    return {
      status: state.status,
      title: 'The Waterfront Loop',
      objective: step?.label || 'Free roam the city and make your own route.',
      hint: state.status === 'failed'
        ? 'Time expired · replay the shift to restart the route.'
        : step?.hint || 'Shift complete · H to hide the HUD and enjoy the view.',
      tag: state.status === 'failed' ? 'FAILED' : step?.tag || 'DONE',
      score: state.score,
      cashReward: state.cashReward,
      failureReason: state.failureReason,
      timeLimit: SHIFT_TIME_LIMIT_SECONDS,
      elapsed: state.elapsed,
      clock: formatClock(state.elapsed),
      distance,
      progress: steps.length ? state.stepIndex / steps.length : 1,
      completedSteps: state.stepIndex,
      totalSteps: steps.length,
      steps: steps.map((candidate, index) => ({
        id: candidate.id,
        label: candidate.shortLabel,
        completed: index < state.stepIndex,
        current: index === state.stepIndex && state.status === 'running',
      })),
    };
  }

  function dispose() {
    marker.removeFromParent();
    markerGlow.dispose();
    markerRingMaterial.dispose();
    markerCore.geometry.dispose();
    markerStem.geometry.dispose();
    markerRing.geometry.dispose();
  }

  return {
    start,
    restart,
    awardBonus,
    update,
    getState,
    exportState,
    importState,
    onPortalEntered,
    onHotspotUsed,
    fail,
    dispose,
    steps,
    get status() {
      return state.status;
    },
  };
}

const STREET_HEAT_SAMPLE_INTERVAL = 0.18;
const STREET_HEAT_SPEED_THRESHOLD = 8.2;
const STREET_HEAT_PURSUIT_THRESHOLD = 30;
const STREET_HEAT_HIGH_THRESHOLD = 58;
const STREET_HEAT_CRITICAL_THRESHOLD = 82;
const STREET_HEAT_ESCAPE_THRESHOLD = 14;
const STREET_HEAT_NEARBY_RADIUS = 9;
const STREET_HEAT_NEAR_MISS_RADIUS = 4.8;
const STREET_HEAT_NEAR_MISS_COOLDOWN = 2.2;
const STREET_HEAT_ESCAPE_WINDOW = 3.4;
const STREET_HEAT_PURSUIT_COOL_RATE = 6.2;
const STREET_HEAT_COMBAT_HOLD_SECONDS = 2.8;
const STREET_HEAT_THEFT_HOLD_SECONDS = 4;
const STREET_HEAT_COMBAT_DECAY = 2.4;
const STREET_HEAT_COMBAT_PURSUIT_DECAY = 2.8;
const STREET_HEAT_RESPONDER_CONTACT_RADIUS = 5.5;
// A deliberate brake hold acts as surrender within roughly one vehicle length
// of the live responder. Traffic safety can keep the shells out of overlap;
// releasing the brake or moving the player still cancels the hold.
const STREET_HEAT_ARREST_CONTINUATION_RADIUS = 10;
const STREET_HEAT_ARREST_SPEED = 1.2;
const STREET_HEAT_ARREST_HOLD_SECONDS = 1.2;

function formatHeat(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

/**
 * A compact driving risk loop layered over the existing traffic simulation.
 * Speeding and close passes build heat; once a moving vehicle notices the
 * player, the target beacon stays on that traffic actor until the player
 * slows down and creates a clean gap. It is intentionally data-driven so the
 * traffic system remains the only owner of vehicle motion and collision
 * safety.
 */
export function createStreetHeat({
  scene,
  getTrafficSnapshot,
  getPursuitResponder,
  getPursuitResponders,
  onEvent,
} = {}) {
  if (!scene?.isScene) {
    throw new TypeError('createStreetHeat requires a THREE.Scene.');
  }

  const state = {
    status: 'ready',
    heat: 0,
    pursuitActive: false,
    level: 0,
    targetId: null,
    targetPosition: null,
    responderId: null,
    responderDistance: null,
    responderIds: [],
    responderDistances: [],
    responderContacts: 0,
    arrestHold: 0,
    arrests: 0,
    nearestDistance: null,
    nearMisses: 0,
    witnessReports: 0,
    safeElapsed: 0,
    sampleElapsed: STREET_HEAT_SAMPLE_INTERVAL,
    nearMissCooldown: 0,
    combatHold: 0,
    theftHold: 0,
    lastEvent: null,
    lastWitnessEvent: null,
  };

  let lastWitnessIncidentId = null;

  const marker = new THREE.Group();
  marker.name = 'Street heat pursuit beacon';
  marker.visible = false;
  marker.renderOrder = 10;
  marker.frustumCulled = false;

  const markerCoreMaterial = new THREE.MeshStandardMaterial({
    color: 0xff6e46,
    emissive: 0xc22d20,
    emissiveIntensity: 2.4,
    roughness: 0.28,
    metalness: 0.08,
    transparent: true,
    opacity: 0.96,
    depthWrite: false,
  });
  const markerRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xff9d6e,
    transparent: true,
    opacity: 0.76,
    depthWrite: false,
  });
  const markerCore = new THREE.Mesh(
    new THREE.ConeGeometry(0.3, 0.82, 5),
    markerCoreMaterial,
  );
  markerCore.position.y = 2.25;
  const markerStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 2.35, 5),
    markerCoreMaterial,
  );
  markerStem.position.y = 1.1;
  const markerRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.86, 0.052, 6, 18),
    markerRingMaterial,
  );
  markerRing.rotation.x = Math.PI * 0.5;
  markerRing.position.y = 0.08;
  marker.add(markerCore, markerStem, markerRing);
  scene.add(marker);

  let markerTime = 0;
  let latestPosition = null;
  let latestSpeed = 0;
  let latestDriving = false;

  function currentLevel() {
    if (!state.pursuitActive) return 0;
    if (state.heat >= STREET_HEAT_CRITICAL_THRESHOLD) return 3;
    if (state.heat >= STREET_HEAT_HIGH_THRESHOLD) return 2;
    return 1;
  }

  function emitEvent(kind, message, score = 0, details = null) {
    state.lastEvent = { kind, message, score, ...(details || {}) };
    onEvent?.({
      kind,
      message,
      score,
      ...(details || {}),
      state: getState(),
    });
  }

  // Public incident ingress for non-driving systems (for example the on-foot
  // combat loop). Keeping heat mutation here means every source shares the
  // same pursuit thresholds, level transitions, and HUD event stream instead
  // of maintaining a second, conflicting heat counter in the caller.
  function addHeat(amount = 0, {
    kind = 'incident',
    message = null,
    score = 0,
    notify = true,
    source = 'street',
  } = {}) {
    const delta = THREE.MathUtils.clamp(Number(amount) || 0, 0, 100);
    if (state.status !== 'running' || delta <= 0) return getState();
    const previousHeat = state.heat;
    state.heat = THREE.MathUtils.clamp(state.heat + delta, 0, 100);
    state.safeElapsed = 0;
    if (source === 'combat') {
      state.combatHold = Math.max(state.combatHold, STREET_HEAT_COMBAT_HOLD_SECONDS);
    } else if (source === 'vehicle-theft') {
      state.theftHold = Math.max(state.theftHold, STREET_HEAT_THEFT_HOLD_SECONDS);
    }
    if (notify && (message || state.heat > previousHeat)) {
      emitEvent(
        kind,
        message || `Street heat +${formatHeat(delta)} · heat ${formatHeat(state.heat)}`,
        score,
      );
    }
    if (!state.pursuitActive && state.heat >= STREET_HEAT_PURSUIT_THRESHOLD) {
      state.pursuitActive = true;
      state.responderContacts = 0;
      state.targetId = null;
      state.targetPosition = null;
      state.responderId = null;
      state.responderDistance = null;
      state.responderIds = [];
      state.responderDistances = [];
      state.safeElapsed = 0;
      state.level = currentLevel();
      emitEvent(
        'pursuit-start',
        'Traffic heat · a tail picked you up. Keep moving, then cool off.',
      );
    }
    state.level = currentLevel();
    return getState();
  }

  function reset() {
    state.status = 'running';
    state.heat = 0;
    state.pursuitActive = false;
    state.level = 0;
    state.targetId = null;
    state.targetPosition = null;
    state.responderId = null;
    state.responderDistance = null;
    state.responderIds = [];
    state.responderDistances = [];
    state.responderContacts = 0;
    state.arrestHold = 0;
    state.arrests = 0;
    state.nearestDistance = null;
    state.nearMisses = 0;
    state.witnessReports = 0;
    state.safeElapsed = 0;
    state.sampleElapsed = STREET_HEAT_SAMPLE_INTERVAL;
    state.nearMissCooldown = 0;
    state.combatHold = 0;
    state.theftHold = 0;
    state.lastEvent = null;
    state.lastWitnessEvent = null;
    lastWitnessIncidentId = null;
    latestPosition = null;
    latestSpeed = 0;
    latestDriving = false;
    marker.visible = false;
  }

  function start() {
    reset();
  }

  function restart() {
    reset();
  }

  function sampleTraffic(position, playerVehicleId) {
    const snapshot = getTrafficSnapshot?.();
    const vehicles = Array.isArray(snapshot?.vehicles) ? snapshot.vehicles : [];
    let nearest = null;
    let nearestDistance = Infinity;
    vehicles.forEach((vehicle) => {
      if (!vehicle || vehicle.id === playerVehicleId || vehicle.visible === false) return;
      if (!Number.isFinite(vehicle.position?.x) || !Number.isFinite(vehicle.position?.z)) return;
      if (!Number.isFinite(vehicle.speed) || vehicle.speed < 0.8) return;
      const distance = Math.hypot(
        vehicle.position.x - position.x,
        vehicle.position.z - position.z,
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = vehicle;
      }
    });
    state.nearestDistance = nearest ? nearestDistance : null;
    if (state.pursuitActive) {
      const targetStillVisible = vehicles.find(
        (vehicle) => vehicle?.id === state.targetId && vehicle.visible !== false,
      );
      if (targetStillVisible?.position) {
        state.targetPosition = {
          x: targetStillVisible.position.x,
          z: targetStillVisible.position.z,
        };
      } else if (nearest) {
        state.targetId = nearest.id;
        state.targetPosition = {
          x: nearest.position.x,
          z: nearest.position.z,
        };
      } else {
        state.targetId = null;
        state.targetPosition = null;
      }
    } else if (nearest && nearestDistance <= STREET_HEAT_NEARBY_RADIUS) {
      state.targetId = nearest.id;
      state.targetPosition = {
        x: nearest.position.x,
        z: nearest.position.z,
      };
    }
    return nearestDistance;
  }

  function update(dt = 0, {
    driving = false,
    speed = 0,
    position = null,
    playerVehicleId = null,
    surrendering = false,
  } = {}) {
    const delta = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    markerTime += delta;
    if (state.status !== 'running') {
      marker.visible = false;
      return getState();
    }

    latestDriving = driving === true;
    latestSpeed = Math.max(0, Number(speed) || 0);
    latestPosition = position?.isVector3
      ? position
      : Number.isFinite(position?.x) && Number.isFinite(position?.z)
        ? position
        : null;
    if (!latestDriving) {
      state.nearestDistance = null;
      state.targetId = null;
      state.targetPosition = null;
    }
    state.nearMissCooldown = Math.max(0, state.nearMissCooldown - delta);
    state.combatHold = Math.max(0, state.combatHold - delta);
    state.theftHold = Math.max(0, state.theftHold - delta);
    state.sampleElapsed += delta;

    let nearestDistance = state.nearestDistance ?? Infinity;
    if (latestDriving && latestPosition && state.sampleElapsed >= STREET_HEAT_SAMPLE_INTERVAL) {
      state.sampleElapsed = 0;
      nearestDistance = sampleTraffic(latestPosition, playerVehicleId);
    }
    if (state.pursuitActive) {
      const responderList = getPursuitResponders?.();
      const responders = Array.isArray(responderList) && responderList.length
        ? responderList.filter((entry) => entry?.active)
        : [getPursuitResponder?.()].filter((entry) => entry?.active);
      const responder = responders[0];
      if (responder?.active && Number.isFinite(responder.position?.x)
        && Number.isFinite(responder.position?.z)) {
        state.responderIds = responders.map((entry) => entry.id);
        state.responderDistances = responders.map((entry) => (
          Number.isFinite(entry.distance)
            ? entry.distance
            : Math.hypot(
              entry.position.x - (latestPosition?.x ?? 0),
              entry.position.z - (latestPosition?.z ?? 0),
            )
        ));
        state.responderId = responder.id;
        state.responderDistance = state.responderDistances[0];
        state.targetId = responder.id;
        state.targetPosition = {
          x: responder.position.x,
          z: responder.position.z,
        };
        nearestDistance = Math.min(...state.responderDistances);
      } else {
        state.responderId = null;
        state.responderDistance = null;
        state.responderIds = [];
        state.responderDistances = [];
        if (!latestDriving) {
          state.targetId = null;
          state.targetPosition = null;
        }
      }
    } else {
      state.responderId = null;
      state.responderDistance = null;
      state.responderIds = [];
      state.responderDistances = [];
    }

    if (state.pursuitActive
      && state.responderContacts === 0
      && state.responderDistances.length > 0
      && Math.min(...state.responderDistances) <= STREET_HEAT_RESPONDER_CONTACT_RADIUS) {
      state.responderContacts = 1;
      emitEvent(
        'responder-contact',
        latestDriving
          ? 'Responder contact · vehicle integrity hit.'
          : 'Responder contact · you took damage.',
      );
    }

    const nearestResponderDistance = state.responderDistances.length > 0
      ? Math.min(...state.responderDistances)
      : null;
    const arresting = state.pursuitActive
      && nearestResponderDistance !== null
      && nearestResponderDistance <= STREET_HEAT_ARREST_CONTINUATION_RADIUS
      && latestDriving
      && surrendering === true
      && latestSpeed <= STREET_HEAT_ARREST_SPEED;
    state.arrestHold = arresting ? state.arrestHold + delta : 0;
    if (state.pursuitActive && state.arrestHold >= STREET_HEAT_ARREST_HOLD_SECONDS) {
      const heatBefore = state.heat;
      const wasDriving = latestDriving;
      state.heat = 0;
      state.pursuitActive = false;
      state.level = 0;
      state.targetId = null;
      state.targetPosition = null;
      state.responderId = null;
      state.responderDistance = null;
      state.responderIds = [];
      state.responderDistances = [];
      state.responderContacts = 0;
      state.nearestDistance = null;
      state.safeElapsed = 0;
      state.combatHold = 0;
      state.theftHold = 0;
      state.arrestHold = 0;
      state.arrests += 1;
      marker.visible = false;
      emitEvent(
        'arrested',
        'Responder boxed you in · booking and roadside release.',
        0,
        { heatBefore: formatHeat(heatBefore), wasDriving },
      );
      return getState();
    }

    const speedRisk = latestDriving
      ? THREE.MathUtils.clamp(
        (latestSpeed - STREET_HEAT_SPEED_THRESHOLD) / 4.8,
        0,
        1,
      )
      : 0;
    const closeRisk = latestDriving && nearestDistance < STREET_HEAT_NEARBY_RADIUS
      ? 1 - THREE.MathUtils.clamp(nearestDistance / STREET_HEAT_NEARBY_RADIUS, 0, 1)
      : 0;
    const drivingRisk = speedRisk * 8.8 + closeRisk * 4.5;
    if (latestDriving && drivingRisk > 0.01) {
      state.heat += delta * drivingRisk;
    } else if (latestDriving && state.theftHold <= 0) {
      state.heat -= delta * (state.pursuitActive ? STREET_HEAT_PURSUIT_COOL_RATE : 12);
    } else if (!latestDriving && state.theftHold <= 0) {
      const combatDecay = state.combatHold > 0
        ? (state.pursuitActive ? STREET_HEAT_COMBAT_PURSUIT_DECAY : STREET_HEAT_COMBAT_DECAY)
        : (state.pursuitActive ? 10.5 : 17);
      state.heat -= delta * combatDecay;
    }
    state.heat = THREE.MathUtils.clamp(state.heat, 0, 100);

    const closePass = latestDriving
      && latestSpeed > 5.2
      && nearestDistance <= STREET_HEAT_NEAR_MISS_RADIUS;
    if (closePass && state.nearMissCooldown <= 0) {
      state.nearMisses += 1;
      state.nearMissCooldown = STREET_HEAT_NEAR_MISS_COOLDOWN;
      state.heat = Math.min(100, state.heat + 7.5);
      emitEvent('near-miss', `Close pass +60 · heat ${formatHeat(state.heat)}`, 60);
    }

    if (!state.pursuitActive && state.heat >= STREET_HEAT_PURSUIT_THRESHOLD) {
      state.pursuitActive = true;
      state.responderContacts = 0;
      state.arrestHold = 0;
      state.targetId = null;
      state.targetPosition = null;
      state.responderId = null;
      state.responderDistance = null;
      state.responderIds = [];
      state.responderDistances = [];
      state.safeElapsed = 0;
      state.level = currentLevel();
      emitEvent(
        'pursuit-start',
        'Traffic heat · a tail picked you up. Keep moving, then cool off.',
      );
    }

    const previousLevel = state.level;
    state.level = currentLevel();
    if (state.pursuitActive && state.level > previousLevel && state.level > 1) {
      emitEvent(
        state.level === 3 ? 'critical' : 'high-heat',
        state.level === 3
          ? 'Critical heat · break contact before the grid closes in.'
          : 'High heat · brake clean and create distance from the tail.',
      );
    }

    const safeToEscape = state.pursuitActive
      && latestSpeed < 4.2
      && nearestDistance > STREET_HEAT_NEARBY_RADIUS;
    state.safeElapsed = safeToEscape ? state.safeElapsed + delta : 0;
    if (
      state.pursuitActive
      && state.heat <= STREET_HEAT_ESCAPE_THRESHOLD
      && state.safeElapsed >= STREET_HEAT_ESCAPE_WINDOW
    ) {
      state.pursuitActive = false;
      state.level = 0;
      state.targetId = null;
      state.targetPosition = null;
      state.responderId = null;
      state.responderDistance = null;
      state.responderIds = [];
      state.responderDistances = [];
      state.responderContacts = 0;
      state.arrestHold = 0;
      state.safeElapsed = 0;
      state.heat = 0;
      emitEvent('escaped', 'Tail lost · clean getaway +420', 420);
    }

    state.level = currentLevel();
    if (state.pursuitActive && state.targetPosition) {
      marker.visible = true;
      marker.position.set(
        state.targetPosition.x,
        (latestPosition?.y ?? 0) + 2.55,
        state.targetPosition.z,
      );
      markerCore.position.y = 2.22 + Math.sin(markerTime * 4.2) * 0.15;
      markerCore.rotation.y = markerTime * 2.1;
      markerRing.rotation.z = markerTime * 1.25;
      markerRing.scale.setScalar(0.92 + Math.sin(markerTime * 4.2) * 0.08);
      markerCoreMaterial.emissiveIntensity = 2.05 + state.level * 0.7;
      markerRingMaterial.opacity = 0.62 + state.level * 0.07;
    } else {
      marker.visible = false;
    }
    return getState();
  }

  function reportWitness({
    incidentId = null,
    witnessId = null,
    witnessLabel = 'A resident',
    victimId = null,
    incidentLabel = 'impact',
  } = {}) {
    const normalizedIncidentId = Number(incidentId);
    const normalizedWitnessId = typeof witnessId === 'string' ? witnessId.slice(0, 96) : '';
    const normalizedVictimId = typeof victimId === 'string' ? victimId.slice(0, 96) : '';
    const normalizedIncidentLabel = typeof incidentLabel === 'string' && incidentLabel.trim()
      ? incidentLabel.trim().slice(0, 32)
      : 'impact';
    if (state.status !== 'running'
      || !Number.isInteger(normalizedIncidentId)
      || normalizedIncidentId <= 0
      || !normalizedWitnessId
      || !normalizedVictimId
      || normalizedWitnessId === normalizedVictimId) return null;
    if (lastWitnessIncidentId === normalizedIncidentId) {
      return {
        reported: false,
        reason: 'incident-latched',
        incidentId: normalizedIncidentId,
        witnessReports: state.witnessReports,
      };
    }
    lastWitnessIncidentId = normalizedIncidentId;
    state.witnessReports += 1;
    state.lastWitnessEvent = {
      kind: 'witness-report',
      incidentId: normalizedIncidentId,
      witnessId: normalizedWitnessId,
      victimId: normalizedVictimId,
      witnessReports: state.witnessReports,
      message: `${String(witnessLabel || 'A resident').slice(0, 64)} called in the ${normalizedIncidentLabel}.`,
    };
    onEvent?.({
      ...state.lastWitnessEvent,
      score: 0,
      state: getState(),
    });
    return {
      reported: true,
      ...state.lastWitnessEvent,
    };
  }

  function getState() {
    const heat = formatHeat(state.heat);
    const escapeSeconds = Math.max(
      STREET_HEAT_ESCAPE_WINDOW - state.safeElapsed,
      (state.heat - STREET_HEAT_ESCAPE_THRESHOLD) / STREET_HEAT_PURSUIT_COOL_RATE,
      0,
    );
    const hint = state.pursuitActive
      ? `Break contact: slow under 4 m/s and stay clear for ${Math.max(
        0,
        Math.ceil(escapeSeconds),
      )} s.`
      : heat > 0
        ? `Traffic heat ${heat} · ease off to cool down.`
        : 'Drive clean or push your luck to wake the street heat.';
    return {
      status: state.status,
      active: state.status === 'running',
      heat,
      level: state.level,
      pursuitActive: state.pursuitActive,
      targetId: state.targetId,
      responderId: state.responderId,
      responderIds: [...state.responderIds],
      responderCount: state.responderIds.length,
      responderDistance: state.responderDistance === null
        ? null
        : Math.round(state.responderDistance * 10) / 10,
      responderDistances: state.responderDistances.map(
        (distance) => Math.round(distance * 10) / 10,
      ),
      responderContacts: state.responderContacts,
      arrestHold: Math.round(state.arrestHold * 100) / 100,
      arrests: state.arrests,
      nearestDistance: state.nearestDistance,
      nearMisses: state.nearMisses,
      witnessReports: state.witnessReports,
      combatHold: Math.round(state.combatHold * 10) / 10,
      combatActive: state.combatHold > 0,
      theftHold: Math.round(state.theftHold * 10) / 10,
      safeElapsed: state.safeElapsed,
      hint,
      label: state.pursuitActive ? `HEAT ${state.level}` : heat > 0 ? `HEAT ${heat}` : 'HEAT CLEAR',
      lastEvent: state.lastEvent,
      lastWitnessEvent: state.lastWitnessEvent,
    };
  }

  function exportState() {
    return {
      heat: state.heat,
      pursuitActive: state.pursuitActive,
      responderContacts: state.responderContacts,
      nearMisses: state.nearMisses,
      witnessReports: state.witnessReports,
      combatHold: state.combatHold,
      theftHold: state.theftHold,
    };
  }

  function importState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const heat = Number(snapshot.heat);
    const responderContacts = Number(snapshot.responderContacts);
    const nearMisses = Number(snapshot.nearMisses);
    const witnessReports = snapshot.witnessReports === undefined
      ? 0
      : Number(snapshot.witnessReports);
    const combatHold = Number(snapshot.combatHold);
    const theftHold = snapshot.theftHold === undefined ? 0 : Number(snapshot.theftHold);
    if (!Number.isFinite(heat)
      || typeof snapshot.pursuitActive !== 'boolean'
      || !Number.isFinite(responderContacts)
      || !Number.isFinite(nearMisses)
      || !Number.isFinite(witnessReports)
      || !Number.isFinite(combatHold)
      || !Number.isFinite(theftHold)) {
      return false;
    }
    const clampedHeat = THREE.MathUtils.clamp(heat, 0, 100);
    if ((snapshot.pursuitActive && clampedHeat <= 0)
      || (!snapshot.pursuitActive && clampedHeat >= STREET_HEAT_PURSUIT_THRESHOLD)) {
      return false;
    }
    state.status = 'running';
    state.heat = clampedHeat;
    state.pursuitActive = snapshot.pursuitActive;
    state.responderContacts = state.pursuitActive
      ? THREE.MathUtils.clamp(Math.round(responderContacts), 0, 1)
      : 0;
    state.nearMisses = Math.max(0, Math.round(nearMisses));
    state.witnessReports = THREE.MathUtils.clamp(Math.round(witnessReports), 0, 100000);
    state.combatHold = THREE.MathUtils.clamp(
      combatHold,
      0,
      STREET_HEAT_COMBAT_HOLD_SECONDS,
    );
    state.theftHold = THREE.MathUtils.clamp(
      theftHold,
      0,
      STREET_HEAT_THEFT_HOLD_SECONDS,
    );
    state.level = currentLevel();
    state.targetId = null;
    state.targetPosition = null;
    state.responderId = null;
    state.responderDistance = null;
    state.responderIds = [];
    state.responderDistances = [];
    state.arrestHold = 0;
    state.arrests = 0;
    state.nearestDistance = null;
    state.safeElapsed = 0;
    state.sampleElapsed = STREET_HEAT_SAMPLE_INTERVAL;
    state.nearMissCooldown = 0;
    state.lastEvent = null;
    state.lastWitnessEvent = null;
    lastWitnessIncidentId = null;
    latestPosition = null;
    latestSpeed = 0;
    latestDriving = false;
    marker.visible = false;
    return true;
  }

  function dispose() {
    marker.removeFromParent();
    markerCoreMaterial.dispose();
    markerRingMaterial.dispose();
    markerCore.geometry.dispose();
    markerStem.geometry.dispose();
    markerRing.geometry.dispose();
  }

  return {
    start,
    restart,
    addHeat,
    reportIncident: addHeat,
    reportWitness,
    update,
    getState,
    exportState,
    importState,
    dispose,
    get status() {
      return state.status;
    },
  };
}

const COMBAT_MAGAZINE_SIZE = 12;
const COMBAT_STARTING_RESERVE = 48;
const COMBAT_RESERVE_CAPACITY = 120;
const COMBAT_FIRE_INTERVAL = 0.18;
const COMBAT_RELOAD_SECONDS = 1.18;
const COMBAT_MAX_RANGE = 42;
const COMBAT_HEALTH_MAX = 100;
const COMBAT_HEALTH_RECOVERY_DELAY = 2.1;
const COMBAT_HEALTH_RECOVERY_RATE = 18;
const COMBAT_DOWNED_SECONDS = 2.4;
const COMBAT_TRACER_POOL_SIZE = 8;
const COMBAT_MUZZLE_POOL_SIZE = 4;
const COMBAT_IMPACT_POOL_SIZE = 10;
const COMBAT_PED_NEAR_MISS_RADIUS = 3.25;
const COMBAT_TRAFFIC_NEAR_MISS_RADIUS = 4.4;
const COMBAT_PED_REACTION_SECONDS = 2.35;
const COMBAT_TRAFFIC_REACTION_SECONDS = 2.05;

function combatVectorFrom(value, target, fallbackY = 0) {
  if (value?.isVector3) {
    target.copy(value);
    return true;
  }
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.z)) return false;
  target.set(value.x, Number.isFinite(value.y) ? value.y : fallbackY, value.z);
  return true;
}

/**
 * Small, deterministic third-person action layer. The city remains the owner
 * of pedestrian/traffic motion; this module only samples their public pose
 * snapshots when a shot is fired and adds pooled presentation effects.
 */
export function createCombatLoop({
  scene,
  camera = null,
  getPlayerPosition,
  getPlayerHeading,
  getAimDirection,
  getPedestrianCandidates,
  getTrafficSnapshot,
  getTrafficRoot,
  getTargets,
  getMuzzleOrigin,
  streetHeat = null,
  onEvent,
  onRecoil,
} = {}) {
  if (!scene?.isScene) {
    throw new TypeError('createCombatLoop requires a THREE.Scene.');
  }

  const state = {
    status: 'ready',
    enabled: false,
    aiming: false,
    triggerHeld: false,
    ammo: COMBAT_MAGAZINE_SIZE,
    reserveAmmo: COMBAT_STARTING_RESERVE,
    reloadTimer: 0,
    cooldown: 0,
    health: COMBAT_HEALTH_MAX,
    damageFlash: 0,
    downedTimer: 0,
    recoveryDelay: 0,
    recoil: 0,
    shots: 0,
    hits: 0,
    misses: 0,
    hitStreak: 0,
    lockedTargetId: null,
    lastHit: null,
    hitConfirmTimer: 0,
    lastEvent: null,
    lastReaction: null,
    reactionCount: 0,
    defeats: 0,
    lastDefeat: null,
    clock: 0,
  };

  const playerPosition = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3();
  const muzzleOrigin = new THREE.Vector3();
  const aimDirection = new THREE.Vector3(0, 0, -1);
  const fallbackDirection = new THREE.Vector3();
  const candidatePoint = new THREE.Vector3();
  const closestPoint = new THREE.Vector3();
  const linePoint = new THREE.Vector3();
  const upAxis = new THREE.Vector3(0, 1, 0);
  const forwardAxis = new THREE.Vector3(0, 0, 1);
  const effectQuaternion = new THREE.Quaternion();
  const targetCandidates = [];
  const targetStates = new Map();
  const reactionMeshes = new Set();

  const tracerPool = [];
  const muzzlePool = [];
  const impactPool = [];

  function makeTracer(index) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({
      color: 0xffd18a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geometry, material);
    line.name = `Combat tracer ${index + 1}`;
    line.frustumCulled = false;
    line.visible = false;
    scene.add(line);
    return {
      line,
      material,
      life: 0,
      maxLife: 0.16,
      index,
    };
  }

  function makeMuzzle(index) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffb45b,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.72, 5), material);
    mesh.name = `Combat muzzle flash ${index + 1}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return {
      mesh,
      material,
      life: 0,
      maxLife: 0.11,
      index,
    };
  }

  function makeImpact(index) {
    const group = new THREE.Group();
    group.name = `Combat impact ${index + 1}`;
    group.visible = false;
    group.frustumCulled = false;
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: 0x71e0ce,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc86b,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 0), coreMaterial);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.05, 5, 10), ringMaterial);
    const shardA = new THREE.Mesh(new THREE.TetrahedronGeometry(0.1, 0), ringMaterial);
    const shardB = new THREE.Mesh(new THREE.TetrahedronGeometry(0.1, 0), ringMaterial);
    const shardC = new THREE.Mesh(new THREE.TetrahedronGeometry(0.1, 0), ringMaterial);
    shardA.position.set(0.31, 0.08, 0);
    shardB.position.set(-0.2, 0.27, 0.04);
    shardC.position.set(-0.06, -0.3, -0.03);
    group.add(core, ring, shardA, shardB, shardC);
    scene.add(group);
    return {
      group,
      core,
      ring,
      shards: [shardA, shardB, shardC],
      coreMaterial,
      ringMaterial,
      life: 0,
      maxLife: 0.42,
      index,
      attachMesh: null,
      attachHeight: 1.15,
    };
  }

  for (let index = 0; index < COMBAT_TRACER_POOL_SIZE; index += 1) {
    tracerPool.push(makeTracer(index));
  }
  for (let index = 0; index < COMBAT_MUZZLE_POOL_SIZE; index += 1) {
    muzzlePool.push(makeMuzzle(index));
  }
  for (let index = 0; index < COMBAT_IMPACT_POOL_SIZE; index += 1) {
    impactPool.push(makeImpact(index));
  }

  let tracerCursor = 0;
  let muzzleCursor = 0;
  let impactCursor = 0;

  function emitEvent(kind, message, details = {}) {
    state.lastEvent = {
      kind,
      message,
      at: Math.round(state.clock * 1000) / 1000,
      ...details,
    };
    onEvent?.({
      kind,
      message,
      ...details,
      state: getState(),
    });
  }

  function clearEffects() {
    tracerPool.forEach((effect) => {
      effect.life = 0;
      effect.line.visible = false;
      effect.material.opacity = 0;
    });
    muzzlePool.forEach((effect) => {
      effect.life = 0;
      effect.mesh.visible = false;
      effect.material.opacity = 0;
    });
    impactPool.forEach((effect) => {
      effect.life = 0;
      effect.group.visible = false;
      effect.coreMaterial.opacity = 0;
      effect.ringMaterial.opacity = 0;
      effect.attachMesh = null;
    });
  }

  function reset({ running = true } = {}) {
    state.status = running ? 'running' : 'ready';
    state.enabled = running;
    state.aiming = false;
    state.triggerHeld = false;
    state.ammo = COMBAT_MAGAZINE_SIZE;
    state.reserveAmmo = COMBAT_STARTING_RESERVE;
    state.reloadTimer = 0;
    state.cooldown = 0;
    state.health = COMBAT_HEALTH_MAX;
    state.damageFlash = 0;
    state.downedTimer = 0;
    state.recoveryDelay = 0;
    state.recoil = 0;
    state.shots = 0;
    state.hits = 0;
    state.misses = 0;
    state.hitStreak = 0;
    state.lockedTargetId = null;
    state.lastHit = null;
    state.hitConfirmTimer = 0;
    state.lastEvent = null;
    state.lastReaction = null;
    state.reactionCount = 0;
    state.defeats = 0;
    state.lastDefeat = null;
    state.clock = 0;
    tracerCursor = 0;
    muzzleCursor = 0;
    impactCursor = 0;
    reactionMeshes.forEach((mesh) => {
      const userData = mesh?.userData;
      if (!userData) return;
      mesh.rotation.z = 0;
      userData.combatReaction = 'settled';
      userData.combatReactionUntil = 0;
      userData.combatReactionSource = null;
      userData.combatReactionDirectionX = 0;
      userData.combatReactionDirectionZ = 0;
      userData.combatReactionStrength = 0;
      userData.combatBrakeUntil = 0;
      userData.combatDisabled = false;
      userData.combatDefeated = false;
      userData.combatDefeatedAt = null;
    });
    reactionMeshes.clear();
    targetStates.forEach((target) => {
      if (target.mesh) {
        target.mesh.rotation.z = 0;
        if (target.mesh.userData) target.mesh.userData.combatReaction = 'settled';
      }
    });
    targetStates.clear();
    clearEffects();
  }

  function start() {
    reset({ running: true });
    return getState();
  }

  function restart() {
    reset({ running: true });
    emitEvent('restart', 'On-foot kit reset · 12 rounds ready.');
    return getState();
  }

  function stop() {
    reset({ running: false });
    return getState();
  }

  function setEnabled(enabled = true) {
    state.enabled = Boolean(enabled) && state.status === 'running';
    if (!state.enabled) {
      state.aiming = false;
      state.triggerHeld = false;
    }
    return state.enabled;
  }

  function setAiming(aiming = false) {
    if (state.status !== 'running' || !state.enabled) {
      state.aiming = false;
      return false;
    }
    state.aiming = Boolean(aiming);
    return state.aiming;
  }

  function setTriggerHeld(held = false) {
    state.triggerHeld = Boolean(held) && state.status === 'running' && state.enabled;
    return state.triggerHeld;
  }

  function exportState() {
    return {
      ammo: state.ammo,
      reserveAmmo: state.reserveAmmo,
      health: state.health,
    };
  }

  function importState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const ammo = Number(snapshot.ammo);
    const reserveAmmo = Number(snapshot.reserveAmmo);
    const health = Number(snapshot.health);
    if (!Number.isFinite(ammo) || !Number.isFinite(reserveAmmo) || !Number.isFinite(health)) return false;
    state.ammo = THREE.MathUtils.clamp(Math.round(ammo), 0, COMBAT_MAGAZINE_SIZE);
    state.reserveAmmo = THREE.MathUtils.clamp(Math.round(reserveAmmo), 0, COMBAT_RESERVE_CAPACITY);
    state.health = THREE.MathUtils.clamp(health, 1, COMBAT_HEALTH_MAX);
    state.aiming = false;
    state.triggerHeld = false;
    state.reloadTimer = 0;
    state.cooldown = 0;
    state.damageFlash = 0;
    state.downedTimer = 0;
    state.recoveryDelay = state.health < COMBAT_HEALTH_MAX
      ? COMBAT_HEALTH_RECOVERY_DELAY
      : 0;
    state.recoil = 0;
    clearEffects();
    return true;
  }

  function getPlayerOrigin(target, height = 1.38) {
    const source = getPlayerPosition?.();
    if (!combatVectorFrom(source, target, 0)) return false;
    target.y += height;
    return true;
  }

  function getAimRay() {
    if (!getPlayerOrigin(rayOrigin, 0)) return false;
    if (camera?.isCamera) {
      camera.getWorldPosition(rayOrigin);
      camera.getWorldDirection(aimDirection).normalize();
    } else if (getAimDirection) {
      const result = getAimDirection(aimDirection);
      if (result?.isVector3) aimDirection.copy(result).normalize();
      else if (aimDirection.lengthSq() < 0.5) return false;
    } else {
      const heading = Number(getPlayerHeading?.());
      const safeHeading = Number.isFinite(heading) ? heading : 0;
      fallbackDirection.set(Math.sin(safeHeading), 0, Math.cos(safeHeading));
      aimDirection.copy(fallbackDirection);
    }
    if (aimDirection.lengthSq() < 0.5) return false;
    aimDirection.normalize();
    return true;
  }

  function collectTargets() {
    targetCandidates.length = 0;
    if (getTargets) {
      const supplied = getTargets(rayOrigin, COMBAT_MAX_RANGE, targetCandidates);
      if (Array.isArray(supplied) && supplied !== targetCandidates) {
        supplied.forEach((target) => targetCandidates.push(target));
      }
      return targetCandidates;
    }
    const pedestrianTargets = getPedestrianCandidates?.(
      rayOrigin,
      COMBAT_MAX_RANGE,
      targetCandidates,
    );
    if (Array.isArray(pedestrianTargets) && pedestrianTargets !== targetCandidates) {
      pedestrianTargets.forEach((target) => targetCandidates.push(target));
    }
    const trafficSnapshot = getTrafficSnapshot?.();
    const vehicles = Array.isArray(trafficSnapshot?.vehicles)
      ? trafficSnapshot.vehicles
      : [];
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      if (!vehicle || vehicle.visible === false || !Number.isFinite(vehicle.position?.x)) continue;
      targetCandidates.push({
        kind: 'traffic',
        id: `traffic:${vehicle.id ?? index}`,
        label: vehicle.identity?.label || vehicle.class || 'Traffic',
        position: vehicle.position,
        mesh: getTrafficRoot?.(vehicle.id ?? index) || null,
        radius: vehicle.class === 'bus' ? 1.65 : 1.2,
        height: vehicle.class === 'bus' ? 1.15 : 0.82,
        vehicle,
      });
    }
    return targetCandidates;
  }

  function candidateCenter(candidate, target) {
    if (candidate?.mesh?.getWorldPosition) {
      candidate.mesh.getWorldPosition(target);
    } else if (!combatVectorFrom(candidate?.position, target, 0)) {
      return false;
    }
    target.y += Number.isFinite(candidate?.height)
      ? candidate.height
      : candidate?.kind === 'traffic' ? 0.82 : 1.15;
    return true;
  }

  function findHit() {
    if (!getAimRay()) return null;
    const candidates = collectTargets();
    let best = null;
    let bestDistance = Infinity;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate
        || candidate.visible === false
        || candidate.mesh?.visible === false
        || candidate.mesh?.userData?.combatDisabled === true) continue;
      if (!candidateCenter(candidate, candidatePoint)) continue;
      linePoint.copy(candidatePoint).sub(rayOrigin);
      const distance = linePoint.dot(aimDirection);
      if (distance < 0 || distance > COMBAT_MAX_RANGE || distance >= bestDistance) continue;
      closestPoint.copy(aimDirection).multiplyScalar(distance).add(rayOrigin);
      const radius = Number.isFinite(candidate.radius)
        ? candidate.radius
        : candidate.kind === 'traffic' ? 1.2 : 0.72;
      if (closestPoint.distanceToSquared(candidatePoint) > radius * radius) continue;
      best = candidate;
      bestDistance = distance;
    }
    if (!best) return null;
    return {
      candidate: best,
      distance: bestDistance,
      point: closestPoint.clone(),
    };
  }

  function setWorldReaction(candidate, reaction, duration, directionX = 0, directionZ = 0, source = 'combat') {
    const mesh = candidate?.mesh;
    if (!mesh) return false;
    const userData = mesh.userData || (mesh.userData = {});
    const length = Math.hypot(directionX, directionZ);
    const normalizedX = length > 0.001 ? directionX / length : 0;
    const normalizedZ = length > 0.001 ? directionZ / length : 0;
    const until = state.clock + Math.max(0.25, duration);
    userData.combatReaction = reaction;
    userData.combatReactionUntil = until;
    userData.combatReactionSource = source;
    userData.combatReactionDirectionX = normalizedX;
    userData.combatReactionDirectionZ = normalizedZ;
    userData.combatReactionStrength = 1;
    userData.combatBrakeUntil = reaction === 'brake' ? until : 0;
    reactionMeshes.add(mesh);
    state.reactionCount += 1;
    state.lastReaction = {
      targetId: String(candidate.id ?? `${candidate.kind || 'actor'}:unknown`),
      kind: candidate.kind === 'traffic' || candidate.vehicle ? 'traffic' : 'pedestrian',
      reaction,
      source,
      at: Math.round(state.clock * 1000) / 1000,
    };
    return true;
  }

  function markNearMisses() {
    let reactionCount = 0;
    for (let index = 0; index < targetCandidates.length; index += 1) {
      const candidate = targetCandidates[index];
      if (!candidate
        || !candidate.mesh
        || candidate.visible === false
        || candidate.mesh.visible === false
        || candidate.mesh.userData?.combatDisabled === true) continue;
      const kind = candidate.kind === 'traffic' || candidate.vehicle ? 'traffic' : 'pedestrian';
      const maxRadius = kind === 'traffic'
        ? COMBAT_TRAFFIC_NEAR_MISS_RADIUS
        : COMBAT_PED_NEAR_MISS_RADIUS;
      if (!candidateCenter(candidate, candidatePoint)) continue;
      linePoint.copy(candidatePoint).sub(rayOrigin);
      const distance = linePoint.dot(aimDirection);
      if (distance < 0 || distance > COMBAT_MAX_RANGE || distance > 32) continue;
      closestPoint.copy(aimDirection).multiplyScalar(distance).add(rayOrigin);
      if (closestPoint.distanceToSquared(candidatePoint) > maxRadius * maxRadius) continue;
      const userData = candidate.mesh.userData || (candidate.mesh.userData = {});
      if (Number(userData.combatReactionUntil) > state.clock
        && userData.combatReactionSource === 'combat') continue;
      let directionX = candidatePoint.x - closestPoint.x;
      let directionZ = candidatePoint.z - closestPoint.z;
      if (directionX * directionX + directionZ * directionZ < 0.0001) {
        directionX = -aimDirection.z;
        directionZ = aimDirection.x;
      }
      if (setWorldReaction(
        candidate,
        kind === 'traffic' ? 'brake' : 'flee',
        kind === 'traffic' ? COMBAT_TRAFFIC_REACTION_SECONDS : COMBAT_PED_REACTION_SECONDS,
        directionX,
        directionZ,
        'near-miss',
      )) reactionCount += 1;
      if (reactionCount >= 3) break;
    }
    return reactionCount;
  }

  function spawnTracer(start, end) {
    const effect = tracerPool[tracerCursor % tracerPool.length];
    tracerCursor += 1;
    const attribute = effect.line.geometry.getAttribute('position');
    attribute.setXYZ(0, start.x, start.y, start.z);
    attribute.setXYZ(1, end.x, end.y, end.z);
    attribute.needsUpdate = true;
    effect.line.geometry.computeBoundingSphere();
    effect.life = effect.maxLife;
    effect.line.visible = true;
    effect.material.opacity = 0.94;
  }

  function spawnMuzzle(origin, direction) {
    const effect = muzzlePool[muzzleCursor % muzzlePool.length];
    muzzleCursor += 1;
    effectQuaternion.setFromUnitVectors(upAxis, direction);
    effect.mesh.position.copy(origin);
    effect.mesh.quaternion.copy(effectQuaternion);
    // Deterministic alternating flare length keeps replay probes stable.
    effect.mesh.scale.set(1, 0.84 + ((state.shots + effect.index) % 3) * 0.08, 1);
    effect.life = effect.maxLife;
    effect.mesh.visible = true;
    effect.material.opacity = 0.98;
  }

  function spawnImpact(position, kind = 'pedestrian', targetMesh = null, targetHeight = 1.15) {
    const effect = impactPool[impactCursor % impactPool.length];
    impactCursor += 1;
    effect.group.position.copy(position);
    effectQuaternion.setFromUnitVectors(forwardAxis, aimDirection);
    effect.group.quaternion.copy(effectQuaternion);
    effect.group.scale.setScalar(kind === 'traffic' ? 1.22 : 1);
    effect.life = effect.maxLife;
    effect.group.visible = true;
    effect.attachMesh = targetMesh || null;
    effect.attachHeight = Number.isFinite(targetHeight) ? targetHeight : 1.15;
    effect.coreMaterial.color.setHex(kind === 'traffic' ? 0xffc86b : 0x71e0ce);
    effect.coreMaterial.opacity = 0.96;
    effect.ringMaterial.opacity = 0.84;
    effect.shards.forEach((shard, index) => {
      shard.rotation.set(0.4 * index, 0.8 - index * 0.22, index * 1.1);
    });
  }

  function markReaction(candidate, kind) {
    const id = String(candidate.id ?? `${kind}:unknown`);
    let target = targetStates.get(id);
    if (!target) {
      target = {
        id,
        kind,
        label: String(candidate.label || (kind === 'traffic' ? 'Traffic' : 'Pedestrian')),
        health: kind === 'traffic' ? 4 : 2,
        hits: 0,
        reactionUntil: 0,
        defeated: false,
        consequence: null,
        mesh: candidate.mesh || null,
      };
      targetStates.set(id, target);
    }
    target.hits += 1;
    target.health = Math.max(0, target.health - 1);
    target.reactionUntil = state.clock + (kind === 'traffic'
      ? COMBAT_TRAFFIC_REACTION_SECONDS
      : COMBAT_PED_REACTION_SECONDS);
    target.mesh = candidate.mesh || target.mesh;
    target.defeated = target.health <= 0;
    if (target.mesh) {
      const userData = target.mesh.userData || (target.mesh.userData = {});
      userData.combatHitCount = target.hits;
      userData.combatHitUntil = target.reactionUntil;
    }
    const reaction = kind === 'traffic'
      ? target.defeated ? 'staggered' : 'brake'
      : target.defeated ? 'staggered' : 'hit-react';
    setWorldReaction(
      candidate,
      reaction,
      kind === 'traffic' ? COMBAT_TRAFFIC_REACTION_SECONDS : COMBAT_PED_REACTION_SECONDS,
      0,
      0,
      'hit',
    );
    if (target.defeated) {
      target.consequence = kind === 'traffic' ? 'vehicle-disabled' : 'actor-downed';
    }
    if (target.defeated && target.mesh) {
      const userData = target.mesh.userData || (target.mesh.userData = {});
      userData.combatDisabled = true;
      userData.combatDefeated = true;
      userData.combatDefeatedAt = Math.round(state.clock * 1000) / 1000;
      userData.combatReaction = 'staggered';
      userData.combatReactionUntil = Number.MAX_SAFE_INTEGER;
      userData.combatReactionSource = 'defeat';
      if (kind === 'traffic') userData.combatBrakeUntil = Number.MAX_SAFE_INTEGER;
    }
    return target;
  }

  function reportHeat(kind, hit) {
    if (!streetHeat?.addHeat) return null;
    const amount = hit
      ? kind === 'pedestrian' ? 14 : 9
      : 2.5;
    const message = hit
      ? `${kind === 'pedestrian' ? 'Civilian' : 'Traffic'} impact · street heat +${amount}`
      : `Unsafe fire · street heat +${amount}`;
    return streetHeat.addHeat(amount, {
      kind: hit ? 'combat-impact' : 'combat-fire',
      message,
      notify: false,
      source: 'combat',
    });
  }

  function reload() {
    if (state.status !== 'running' || !state.enabled) return false;
    if (state.reloadTimer > 0 || state.ammo >= COMBAT_MAGAZINE_SIZE || state.reserveAmmo <= 0) return false;
    state.reloadTimer = COMBAT_RELOAD_SECONDS;
    state.triggerHeld = false;
    emitEvent('reload-start', 'Reloading · keep your head up.');
    return true;
  }

  function addReserveAmmo(amount = 0) {
    if (state.status !== 'running') return null;
    const requested = Math.max(0, Math.round(Number(amount) || 0));
    if (requested <= 0 || state.reserveAmmo >= COMBAT_RESERVE_CAPACITY) return null;
    const before = state.reserveAmmo;
    state.reserveAmmo = Math.min(COMBAT_RESERVE_CAPACITY, before + requested);
    return {
      added: state.reserveAmmo - before,
      reserveAmmo: state.reserveAmmo,
      capacity: COMBAT_RESERVE_CAPACITY,
    };
  }

  function fire() {
    if (state.status !== 'running' || !state.enabled) return { fired: false, reason: 'inactive' };
    if (state.reloadTimer > 0) return { fired: false, reason: 'reloading' };
    if (state.cooldown > 0) return { fired: false, reason: 'cooldown' };
    if (state.ammo <= 0) {
      reload();
      return { fired: false, reason: 'empty' };
    }
    state.ammo -= 1;
    state.shots += 1;
    state.cooldown = COMBAT_FIRE_INTERVAL;
    state.recoil = Math.min(1, state.recoil + 0.68);
    onRecoil?.(0.026);

    if (!getAimRay()) return { fired: false, reason: 'no-aim' };
    const customMuzzle = getMuzzleOrigin?.(muzzleOrigin, aimDirection);
    if (!customMuzzle) {
      muzzleOrigin.copy(rayOrigin).addScaledVector(aimDirection, 0.32);
      // Pull the visual muzzle back to the avatar when a player pose is
      // available; the ray itself remains camera-centre so third-person aim
      // is predictable and independent of camera distance.
      const playerMuzzle = getPlayerOrigin(playerPosition, 1.22);
      if (playerMuzzle) muzzleOrigin.copy(playerPosition).addScaledVector(aimDirection, 0.48);
    }
    const hit = findHit();
    linePoint.copy(rayOrigin).addScaledVector(aimDirection, hit?.distance ?? COMBAT_MAX_RANGE);
    spawnTracer(muzzleOrigin, hit?.point || linePoint);
    spawnMuzzle(muzzleOrigin, aimDirection);
    if (!hit) {
      state.misses += 1;
      state.hitStreak = 0;
      state.lockedTargetId = null;
      const nearReactions = markNearMisses();
      reportHeat('street', false);
      emitEvent('shot', 'Shot fired · watch the street heat.', {
        hit: false,
        targetId: null,
        nearReactions,
      });
      return { fired: true, hit: false, nearReactions, ammo: state.ammo };
    }

    const kind = hit.candidate.kind === 'traffic' || hit.candidate.vehicle ? 'traffic' : 'pedestrian';
    const target = markReaction(hit.candidate, kind);
    state.hits += 1;
    state.hitStreak += 1;
    state.lockedTargetId = target.id;
    state.lastHit = {
      targetId: target.id,
      kind,
      label: target.label,
      distance: Math.round(hit.distance * 100) / 100,
      hits: target.hits,
      defeated: target.defeated,
      at: Math.round(state.clock * 1000) / 1000,
    };
    state.hitConfirmTimer = 1.15;
    spawnImpact(hit.point, kind, target.mesh, hit.candidate.height);
    reportHeat(kind, true);
    emitEvent('shot', 'Shot fired · impact registered.', {
      hit: true,
      targetId: target.id,
      targetKind: kind,
    });
    emitEvent(
      'impact',
      `${kind === 'traffic' ? 'Vehicle' : 'Pedestrian'} staggered · ${target.defeated ? 'reaction complete' : 'hit confirmed'}`,
      {
        hit: true,
        incidentId: 1_000_000 + state.shots,
        targetId: target.id,
        targetKind: kind,
        residentId: hit.candidate.residentId ?? target.id,
        defeated: target.defeated,
      },
    );
    if (target.defeated) {
      state.defeats += 1;
      state.lastDefeat = {
        targetId: target.id,
        targetKind: kind,
        label: target.label,
        consequence: target.consequence,
        at: Math.round(state.clock * 1000) / 1000,
      };
      emitEvent(
        'defeat',
        `${target.label} disabled · no longer an active target.`,
        { ...state.lastDefeat },
      );
    }
    return {
      fired: true,
      hit: true,
      targetId: target.id,
      targetKind: kind,
      defeated: target.defeated,
      consequence: target.consequence,
      ammo: state.ammo,
    };
  }

  function damage(amount = 0, source = 'street') {
    if (state.status !== 'running' || !state.enabled) return false;
    const delta = THREE.MathUtils.clamp(Number(amount) || 0, 0, COMBAT_HEALTH_MAX);
    if (delta <= 0) return false;
    state.health = Math.max(0, state.health - delta);
    state.damageFlash = Math.max(state.damageFlash, 0.42);
    state.recoveryDelay = COMBAT_HEALTH_RECOVERY_DELAY;
    state.lastEvent = {
      kind: 'damage',
      message: `Damage received · ${Math.round(delta)} health`,
      source,
      at: Math.round(state.clock * 1000) / 1000,
    };
    onEvent?.({
      kind: 'damage',
      message: state.lastEvent.message,
      source,
      amount: delta,
      state: getState(),
    });
    if (state.health <= 0) {
      state.status = 'downed';
      state.enabled = false;
      state.aiming = false;
      state.triggerHeld = false;
      state.downedTimer = COMBAT_DOWNED_SECONDS;
      emitEvent('downed', 'You are down · recovering in the street.');
    }
    return true;
  }

  function heal(amount = 0) {
    const delta = THREE.MathUtils.clamp(Number(amount) || 0, 0, COMBAT_HEALTH_MAX);
    if (delta <= 0 || state.status !== 'running') return false;
    state.health = Math.min(COMBAT_HEALTH_MAX, state.health + delta);
    return true;
  }

  function updateWorldReactions() {
    reactionMeshes.forEach((mesh) => {
      const userData = mesh?.userData;
      if (userData?.combatDisabled === true) return;
      if (!userData || Number(userData.combatReactionUntil) > state.clock) return;
      userData.combatReaction = 'settled';
      userData.combatReactionUntil = 0;
      userData.combatReactionSource = null;
      userData.combatReactionDirectionX = 0;
      userData.combatReactionDirectionZ = 0;
      userData.combatReactionStrength = 0;
      userData.combatBrakeUntil = 0;
      reactionMeshes.delete(mesh);
    });
  }

  function updateReactions() {
    targetStates.forEach((target) => {
      const mesh = target.mesh;
      if (!mesh) return;
      const userData = mesh.userData || (mesh.userData = {});
      if (target.defeated) {
        mesh.rotation.z = THREE.MathUtils.damp(
          mesh.rotation.z,
          target.kind === 'traffic' ? 0 : -1.05,
          7,
          1 / 60,
        );
        userData.combatReaction = 'staggered';
        userData.combatReactionUntil = Number.MAX_SAFE_INTEGER;
        userData.combatReactionSource = 'defeat';
        if (target.kind === 'traffic') userData.combatBrakeUntil = Number.MAX_SAFE_INTEGER;
        return;
      }
      const remaining = target.reactionUntil - state.clock;
      if (remaining > 0) {
        const duration = target.kind === 'traffic'
          ? COMBAT_TRAFFIC_REACTION_SECONDS
          : COMBAT_PED_REACTION_SECONDS;
        const pulse = THREE.MathUtils.clamp(remaining / duration, 0, 1);
        mesh.rotation.z = Math.sin(state.clock * 28 + target.hits) * 0.2 * pulse;
        userData.combatReaction = target.kind === 'traffic'
          ? 'brake'
          : target.defeated ? 'staggered' : 'hit-react';
      } else if (userData.combatReaction) {
        mesh.rotation.z = THREE.MathUtils.damp(mesh.rotation.z, 0, 16, 1 / 60);
        if (Math.abs(mesh.rotation.z) < 0.005) {
          mesh.rotation.z = 0;
          userData.combatReaction = 'settled';
        }
      }
    });
  }

  function updateEffects(delta) {
    tracerPool.forEach((effect) => {
      if (effect.life <= 0) return;
      effect.life -= delta;
      if (effect.life <= 0) {
        effect.life = 0;
        effect.line.visible = false;
        effect.material.opacity = 0;
        return;
      }
      effect.material.opacity = THREE.MathUtils.clamp(effect.life / effect.maxLife, 0, 1) * 0.94;
    });
    muzzlePool.forEach((effect) => {
      if (effect.life <= 0) return;
      effect.life -= delta;
      if (effect.life <= 0) {
        effect.life = 0;
        effect.mesh.visible = false;
        effect.material.opacity = 0;
        return;
      }
      effect.material.opacity = THREE.MathUtils.clamp(effect.life / effect.maxLife, 0, 1);
      effect.mesh.scale.x = 0.78 + effect.life / effect.maxLife * 0.36;
      effect.mesh.scale.z = effect.mesh.scale.x;
    });
    impactPool.forEach((effect) => {
      if (effect.life <= 0) return;
      effect.life -= delta;
      if (effect.life <= 0) {
        effect.life = 0;
        effect.group.visible = false;
        effect.coreMaterial.opacity = 0;
        effect.ringMaterial.opacity = 0;
        effect.attachMesh = null;
        return;
      }
      if (effect.attachMesh?.visible && effect.attachMesh.getWorldPosition) {
        effect.attachMesh.getWorldPosition(candidatePoint);
        candidatePoint.y += effect.attachHeight;
        effect.group.position.copy(candidatePoint);
      }
      const progress = 1 - effect.life / effect.maxLife;
      effect.coreMaterial.opacity = (1 - progress) * 0.96;
      effect.ringMaterial.opacity = (1 - progress) * 0.84;
      effect.group.scale.setScalar(0.84 + progress * 1.45);
      effect.ring.rotation.z += delta * 7;
      effect.shards.forEach((shard, index) => {
        shard.rotation.x += delta * (4.2 + index * 0.7);
        shard.rotation.y -= delta * (3.5 + index * 0.5);
      });
    });
  }

  function update(dt = 0, { active = true } = {}) {
    const delta = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    state.clock += delta;
    if (state.status === 'ready') {
      updateEffects(delta);
      return getState();
    }
    if (active === false) setEnabled(false);
    else if (state.status === 'running') state.enabled = true;

    state.cooldown = Math.max(0, state.cooldown - delta);
    state.recoil = Math.max(0, state.recoil - delta * 4.8);
    state.damageFlash = Math.max(0, state.damageFlash - delta);
    state.hitConfirmTimer = Math.max(0, state.hitConfirmTimer - delta);
    updateEffects(delta);
    updateWorldReactions();
    updateReactions();

    if (state.status === 'downed') {
      state.downedTimer = Math.max(0, state.downedTimer - delta);
      if (state.downedTimer <= 0) {
        state.status = 'running';
        state.enabled = true;
        state.health = 58;
        state.recoveryDelay = COMBAT_HEALTH_RECOVERY_DELAY;
        emitEvent('revive', 'Back on your feet · stay sharp.');
      }
      return getState();
    }
    if (state.reloadTimer > 0) {
      state.reloadTimer = Math.max(0, state.reloadTimer - delta);
      if (state.reloadTimer <= 0) {
        const needed = COMBAT_MAGAZINE_SIZE - state.ammo;
        const loaded = Math.min(needed, state.reserveAmmo);
        state.ammo += loaded;
        state.reserveAmmo -= loaded;
        emitEvent('reload-complete', `Reloaded · ${state.ammo}/${COMBAT_MAGAZINE_SIZE}`);
      }
    }
    if (state.recoveryDelay > 0) {
      state.recoveryDelay = Math.max(0, state.recoveryDelay - delta);
    } else if (state.health < COMBAT_HEALTH_MAX) {
      state.health = Math.min(COMBAT_HEALTH_MAX, state.health + delta * COMBAT_HEALTH_RECOVERY_RATE);
    }
    if (state.enabled && state.triggerHeld && state.reloadTimer <= 0 && state.cooldown <= 0) {
      fire();
    }
    return getState();
  }

  function getState() {
    return {
      status: state.status,
      active: state.status === 'running' && state.enabled,
      aiming: state.aiming,
      triggerHeld: state.triggerHeld,
      ammo: state.ammo,
      magazineSize: COMBAT_MAGAZINE_SIZE,
      reserveAmmo: state.reserveAmmo,
      reserveCapacity: COMBAT_RESERVE_CAPACITY,
      reloading: state.reloadTimer > 0,
      reloadProgress: state.reloadTimer > 0
        ? THREE.MathUtils.clamp(1 - state.reloadTimer / COMBAT_RELOAD_SECONDS, 0, 1)
        : 0,
      cooldown: state.cooldown,
      health: Math.round(state.health * 10) / 10,
      maxHealth: COMBAT_HEALTH_MAX,
      damageFlash: state.damageFlash,
      downedTimer: state.downedTimer,
      recovering: state.health < COMBAT_HEALTH_MAX && state.recoveryDelay <= 0,
      recoil: state.recoil,
      shots: state.shots,
      hits: state.hits,
      misses: state.misses,
      hitStreak: state.hitStreak,
      lockedTargetId: state.lockedTargetId,
      lastHit: state.lastHit ? { ...state.lastHit } : null,
      hitConfirm: state.hitConfirmTimer > 0,
      hitConfirmTimer: Math.round(state.hitConfirmTimer * 1000) / 1000,
      hitLabel: state.lastHit?.label || null,
      lastReaction: state.lastReaction ? { ...state.lastReaction } : null,
      reactionCount: state.reactionCount,
      defeats: state.defeats,
      lastDefeat: state.lastDefeat ? { ...state.lastDefeat } : null,
      activeWorldReactions: reactionMeshes.size,
      lastEvent: state.lastEvent ? { ...state.lastEvent } : null,
    };
  }

  function getTargetState(id) {
    const target = targetStates.get(String(id));
    if (!target) return null;
    return {
      id: target.id,
      kind: target.kind,
      label: target.label,
      health: target.health,
      hits: target.hits,
      defeated: target.defeated,
      consequence: target.consequence,
      targetable: !target.defeated,
      reaction: target.defeated
        ? 'disabled'
        : target.reactionUntil > state.clock ? 'staggered' : 'settled',
    };
  }

  function dispose() {
    tracerPool.forEach((effect) => {
      effect.line.removeFromParent();
      effect.line.geometry.dispose();
      effect.material.dispose();
    });
    muzzlePool.forEach((effect) => {
      effect.mesh.removeFromParent();
      effect.mesh.geometry.dispose();
      effect.material.dispose();
    });
    impactPool.forEach((effect) => {
      effect.group.removeFromParent();
      effect.core.geometry.dispose();
      effect.ring.geometry.dispose();
      effect.shards.forEach((shard) => shard.geometry.dispose());
      effect.coreMaterial.dispose();
      effect.ringMaterial.dispose();
    });
    targetStates.clear();
    reactionMeshes.clear();
  }

  return {
    start,
    restart,
    stop,
    update,
    fire,
    reload,
    addReserveAmmo,
    damage,
    damagePlayer: damage,
    heal,
    setAiming,
    aim: setAiming,
    setTriggerHeld,
    setEnabled,
    exportState,
    importState,
    getState,
    getTargetState,
    dispose,
    get status() {
      return state.status;
    },
  };
}
