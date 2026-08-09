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
    const message = completed
      ? `Waterfront loop complete · ${formatClock(state.elapsed)} · score ${state.score}`
      : `${step.shortLabel} logged · next: ${currentStep()?.shortLabel || 'free roam'}`;
    onAdvance?.({
      step,
      completed,
      message,
      score: state.score,
    });
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
    marker.visible = true;
  }

  function restart() {
    start();
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
    if (state.status === 'running') state.elapsed += delta;
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
      hint: step?.hint || 'Shift complete · H to hide the HUD and enjoy the view.',
      tag: step?.tag || 'DONE',
      score: state.score,
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
    onPortalEntered,
    onHotspotUsed,
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
export function createStreetHeat({ scene, getTrafficSnapshot, onEvent } = {}) {
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
    nearestDistance: null,
    nearMisses: 0,
    safeElapsed: 0,
    sampleElapsed: STREET_HEAT_SAMPLE_INTERVAL,
    nearMissCooldown: 0,
    lastEvent: null,
  };

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

  function emitEvent(kind, message, score = 0) {
    state.lastEvent = { kind, message, score };
    onEvent?.({
      kind,
      message,
      score,
      state: getState(),
    });
  }

  function reset() {
    state.status = 'running';
    state.heat = 0;
    state.pursuitActive = false;
    state.level = 0;
    state.targetId = null;
    state.targetPosition = null;
    state.nearestDistance = null;
    state.nearMisses = 0;
    state.safeElapsed = 0;
    state.sampleElapsed = STREET_HEAT_SAMPLE_INTERVAL;
    state.nearMissCooldown = 0;
    state.lastEvent = null;
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
    state.sampleElapsed += delta;

    let nearestDistance = state.nearestDistance ?? Infinity;
    if (latestDriving && latestPosition && state.sampleElapsed >= STREET_HEAT_SAMPLE_INTERVAL) {
      state.sampleElapsed = 0;
      nearestDistance = sampleTraffic(latestPosition, playerVehicleId);
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
    } else if (latestDriving) {
      state.heat -= delta * (state.pursuitActive ? STREET_HEAT_PURSUIT_COOL_RATE : 12);
    } else {
      state.heat -= delta * (state.pursuitActive ? 10.5 : 17);
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
      state.targetId = null;
      state.targetPosition = null;
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
      nearestDistance: state.nearestDistance,
      nearMisses: state.nearMisses,
      safeElapsed: state.safeElapsed,
      hint,
      label: state.pursuitActive ? `HEAT ${state.level}` : heat > 0 ? `HEAT ${heat}` : 'HEAT CLEAR',
      lastEvent: state.lastEvent,
    };
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
    update,
    getState,
    dispose,
    get status() {
      return state.status;
    },
  };
}
