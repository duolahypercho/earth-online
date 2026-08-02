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
