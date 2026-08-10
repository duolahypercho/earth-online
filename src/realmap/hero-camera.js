import * as THREE from 'three';

/**
 * A small, allocation-conscious third-person camera controller for the hero
 * tile. Call `update()` once per frame after the character position changes.
 * Collision boxes are normally the local building/vehicle AABBs already kept
 * by the map; `raycastCandidates` is useful for irregular scenery.
 */
export const HERO_CAMERA_DEFAULTS = Object.freeze({
  distance: 5.2,
  shoulderOffset: 0.52,
  verticalOffset: 1.22,
  lookAhead: 0.38,
  lookHeight: 0.08,
  focusHeight: 1.08,
  collisionRadius: 0.34,
  obstructionPadding: 0.18,
  hardMinimumDistance: 0.16,
  distanceDamping: 13,
  positionDamping: 18,
  lookDamping: 22,
  nearClip: 0.08,
  nearClipPadding: 0.06,
  teleportDistance: 7,
  maxDelta: 0.05,
});

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function positive(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
}

export function resolveHeroCameraOptions(options = {}) {
  return {
    distance: positive(options.distance, HERO_CAMERA_DEFAULTS.distance, 0.25),
    shoulderOffset: finite(options.shoulderOffset, HERO_CAMERA_DEFAULTS.shoulderOffset),
    verticalOffset: finite(options.verticalOffset, HERO_CAMERA_DEFAULTS.verticalOffset),
    lookAhead: finite(options.lookAhead, HERO_CAMERA_DEFAULTS.lookAhead),
    lookHeight: finite(options.lookHeight, HERO_CAMERA_DEFAULTS.lookHeight),
    focusHeight: positive(options.focusHeight, HERO_CAMERA_DEFAULTS.focusHeight, 0),
    collisionRadius: positive(options.collisionRadius, HERO_CAMERA_DEFAULTS.collisionRadius, 0),
    obstructionPadding: positive(options.obstructionPadding, HERO_CAMERA_DEFAULTS.obstructionPadding, 0),
    hardMinimumDistance: positive(options.hardMinimumDistance, HERO_CAMERA_DEFAULTS.hardMinimumDistance, 0.01),
    distanceDamping: positive(options.distanceDamping, HERO_CAMERA_DEFAULTS.distanceDamping, 0.01),
    positionDamping: positive(options.positionDamping, HERO_CAMERA_DEFAULTS.positionDamping, 0.01),
    lookDamping: positive(options.lookDamping, HERO_CAMERA_DEFAULTS.lookDamping, 0.01),
    nearClip: positive(options.nearClip, HERO_CAMERA_DEFAULTS.nearClip, 0.01),
    nearClipPadding: positive(options.nearClipPadding, HERO_CAMERA_DEFAULTS.nearClipPadding, 0),
    teleportDistance: positive(options.teleportDistance, HERO_CAMERA_DEFAULTS.teleportDistance, 0.1),
    maxDelta: positive(options.maxDelta, HERO_CAMERA_DEFAULTS.maxDelta, 0.001),
  };
}

function smoothFactor(damping, dt) {
  return 1 - Math.exp(-damping * dt);
}

function isIgnoredOccluder(object, characterRoot) {
  for (let current = object; current; current = current.parent) {
    if (current === characterRoot || current.userData?.cameraOccluder === false) return true;
  }
  return false;
}

/**
 * Creates a stateful, deterministic spring-arm camera. The controller never
 * traverses the scene: callers supply nearby collision boxes/candidates, which
 * makes cost predictable and avoids an accidental whole-city raycast.
 */
export function createHeroCamera(options = {}) {
  const defaults = resolveHeroCameraOptions(options);
  const raycaster = new THREE.Raycaster();
  const ray = new THREE.Ray();
  const expandedBox = new THREE.Box3();
  const boxHit = new THREE.Vector3();
  const rootPosition = new THREE.Vector3();
  const previousRootPosition = new THREE.Vector3();
  const focusPoint = new THREE.Vector3();
  const armOrigin = new THREE.Vector3();
  const desiredPosition = new THREE.Vector3();
  const desiredOffset = new THREE.Vector3();
  const armDirection = new THREE.Vector3();
  const cameraPosition = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  let initialized = false;
  let armDistance = defaults.distance;

  const diagnostics = {
    occluded: false,
    obstructionType: 'none',
    obstructionDistance: null,
    desiredDistance: defaults.distance,
    armDistance: defaults.distance,
    safeDistance: defaults.distance,
    collisionBoxesTested: 0,
    raycastCandidatesTested: 0,
    teleportReset: false,
    forcedCloseCamera: false,
    nearClip: defaults.nearClip,
    focus: focusPoint,
    desiredPosition,
    position: cameraPosition,
    lookTarget,
  };

  function reset() {
    initialized = false;
  }

  function update({
    camera,
    characterRoot = null,
    focus = null,
    yaw = 0,
    raycastCandidates = null,
    collisionBoxes = null,
    dt = 1 / 60,
    options: frameOptions = null,
    teleport = false,
  } = {}) {
    if (!camera?.position || typeof camera.lookAt !== 'function') {
      throw new TypeError('A THREE camera with position and lookAt() is required.');
    }
    const settings = frameOptions ? resolveHeroCameraOptions({ ...defaults, ...frameOptions }) : defaults;
    const safeDt = THREE.MathUtils.clamp(finite(dt, 0), 0, settings.maxDelta);
    const safeYaw = finite(yaw, 0);
    let hasRootPosition = false;

    if (focus?.isVector3) {
      focusPoint.copy(focus);
    } else if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.y) && Number.isFinite(focus.z)) {
      focusPoint.set(focus.x, focus.y, focus.z);
    } else if (characterRoot?.getWorldPosition) {
      characterRoot.getWorldPosition(focusPoint);
      focusPoint.y += settings.focusHeight;
      rootPosition.copy(focusPoint).setY(focusPoint.y - settings.focusHeight);
      hasRootPosition = true;
    } else if (characterRoot?.position) {
      focusPoint.copy(characterRoot.position);
      focusPoint.y += settings.focusHeight;
      rootPosition.copy(characterRoot.position);
      hasRootPosition = true;
    } else {
      throw new TypeError('Provide a focus vector or a characterRoot with a position.');
    }

    const teleported = Boolean(teleport)
      || (initialized && hasRootPosition && rootPosition.distanceToSquared(previousRootPosition) > settings.teleportDistance ** 2);
    if (hasRootPosition) previousRootPosition.copy(rootPosition);

    forward.set(Math.sin(safeYaw), 0, Math.cos(safeYaw));
    right.set(Math.cos(safeYaw), 0, -Math.sin(safeYaw));
    armOrigin.copy(focusPoint)
      .addScaledVector(forward, settings.lookAhead)
      .addScaledVector(THREE.Object3D.DEFAULT_UP, settings.lookHeight);
    desiredOffset.copy(forward).multiplyScalar(-settings.distance)
      .addScaledVector(right, settings.shoulderOffset)
      .addScaledVector(THREE.Object3D.DEFAULT_UP, settings.verticalOffset);
    const requestedDistance = desiredOffset.length();
    armDirection.copy(desiredOffset).multiplyScalar(1 / requestedDistance);
    desiredPosition.copy(armOrigin).add(desiredOffset);

    let obstructionDistance = Infinity;
    let obstructionType = 'none';
    let collisionBoxesTested = 0;
    let raycastCandidatesTested = 0;

    ray.origin.copy(armOrigin);
    ray.direction.copy(armDirection);
    if (Array.isArray(collisionBoxes)) {
      for (const box of collisionBoxes) {
        if (!box?.min || !box?.max) continue;
        collisionBoxesTested += 1;
        expandedBox.copy(box).expandByScalar(settings.collisionRadius);
        const hit = ray.intersectBox(expandedBox, boxHit);
        if (!hit) continue;
        const distance = hit.distanceTo(armOrigin);
        if (distance >= 0 && distance < obstructionDistance && distance <= requestedDistance) {
          obstructionDistance = distance;
          obstructionType = 'box';
        }
      }
    }

    if (Array.isArray(raycastCandidates) && raycastCandidates.length) {
      raycaster.set(armOrigin, armDirection);
      raycaster.near = 0.001;
      raycaster.far = requestedDistance;
      const hits = raycaster.intersectObjects(raycastCandidates, true);
      raycastCandidatesTested = raycastCandidates.length;
      for (const hit of hits) {
        if (isIgnoredOccluder(hit.object, characterRoot)) continue;
        if (hit.distance < obstructionDistance) {
          obstructionDistance = hit.distance;
          obstructionType = 'raycast';
        }
        break;
      }
    }

    const occluded = Number.isFinite(obstructionDistance);
    const nearSafeDistance = camera.near == null
      ? settings.nearClip + settings.nearClipPadding
      : Math.min(camera.near, settings.nearClip) + settings.nearClipPadding;
    const hardMinimum = Math.max(settings.hardMinimumDistance, nearSafeDistance);
    const safeDistance = occluded
      ? Math.max(hardMinimum, Math.min(requestedDistance, obstructionDistance - settings.obstructionPadding))
      : requestedDistance;
    const forcedCloseCamera = occluded && safeDistance < requestedDistance - 0.001;

    // Retraction must be immediate: smoothing a camera through a car/wall is
    // exactly the near-plane clipping this controller is intended to avoid.
    if (!initialized || teleported) {
      armDistance = safeDistance;
      cameraPosition.copy(armOrigin).addScaledVector(armDirection, armDistance);
      lookTarget.copy(armOrigin);
    } else {
      armDistance = safeDistance < armDistance
        ? safeDistance
        : THREE.MathUtils.lerp(armDistance, safeDistance, smoothFactor(settings.distanceDamping, safeDt));
      desiredPosition.copy(armOrigin).addScaledVector(armDirection, armDistance);
      cameraPosition.copy(camera.position).lerp(desiredPosition, smoothFactor(settings.positionDamping, safeDt));
      lookTarget.lerp(armOrigin, smoothFactor(settings.lookDamping, safeDt));
    }

    if (camera.near == null || Math.abs(camera.near - settings.nearClip) > 0.0001) {
      camera.near = settings.nearClip;
      camera.updateProjectionMatrix?.();
    }
    camera.position.copy(cameraPosition);
    camera.lookAt(lookTarget);
    initialized = true;

    diagnostics.occluded = occluded;
    diagnostics.obstructionType = obstructionType;
    diagnostics.obstructionDistance = occluded ? obstructionDistance : null;
    diagnostics.desiredDistance = requestedDistance;
    diagnostics.armDistance = armDistance;
    diagnostics.safeDistance = safeDistance;
    diagnostics.collisionBoxesTested = collisionBoxesTested;
    diagnostics.raycastCandidatesTested = raycastCandidatesTested;
    diagnostics.teleportReset = teleported;
    diagnostics.forcedCloseCamera = forcedCloseCamera;
    diagnostics.nearClip = camera.near;
    return diagnostics;
  }

  return Object.freeze({
    update,
    reset,
    get diagnostics() {
      return diagnostics;
    },
  });
}
