// Bounded human-scale life and practical-light presentation for the Ferry
// Building hero view. This deliberately reads simulation records; it never
// writes their positions, rotations, paths, or behaviour state.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { animatePlayerAvatar, createPlayerAvatar } from '../player.js';

export const HERO_LIFE_LIGHTING_BUDGET = Object.freeze({
  maxPedestrians: 24,
  maxVehicles: 16,
  maxPracticals: 6,
  maxDetailedActors: 4,
  drawCalls: 10,
  materials: 8,
});

const EMPTY_MATRIX = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
const PEDESTRIAN_PALETTE = Object.freeze([
  0x2f536d, 0x765043, 0x536e59, 0x74546f, 0xa06d3e, 0x426b74,
]);
const SKIN_PALETTE = Object.freeze([0xd5aa86, 0xb77d5b, 0xe0ba94, 0x80502f, 0xc4926c]);
const VEHICLE_PALETTE = Object.freeze([0xc44737, 0x2f6fae, 0xd6ad35, 0xdedfe0, 0x4a856c]);
// An adapter-owned, cyclic set keeps close actors individually readable even
// when the underlying avatar implementation does not expose variant metadata.
// Palette index remains the existing shared-material wardrobe selector; the
// small rig scales and gait offsets add no geometry, materials, or draw calls.
const CIVILIAN_PRESENTATION_PROFILES = Object.freeze([
  Object.freeze({
    silhouette: 'lean', gaitStyle: 'light', phase: 0.42, cadence: 1.06,
    armSwing: 0.9, posture: -0.006, shoulderTilt: -0.018, headBias: 0.035,
    scale: Object.freeze([0.95, 1.03, 0.96]),
  }),
  Object.freeze({
    silhouette: 'layered', gaitStyle: 'steady', phase: 2.16, cadence: 0.98,
    armSwing: 1, posture: 0, shoulderTilt: 0.012, headBias: -0.025,
    scale: Object.freeze([1.045, 0.985, 1.055]),
  }),
  Object.freeze({
    silhouette: 'brisk', gaitStyle: 'brisk', phase: 3.88, cadence: 1.12,
    armSwing: 1.1, posture: 0.012, shoulderTilt: -0.008, headBias: 0.018,
    scale: Object.freeze([0.985, 1.025, 0.94]),
  }),
  Object.freeze({
    silhouette: 'tailored', gaitStyle: 'steady', phase: 5.31, cadence: 1.01,
    armSwing: 0.96, posture: -0.003, shoulderTilt: 0.006, headBias: -0.012,
    scale: Object.freeze([1.015, 1.005, 1.02]),
  }),
  Object.freeze({
    silhouette: 'relaxed', gaitStyle: 'light', phase: 0.91, cadence: 0.94,
    armSwing: 0.84, posture: -0.012, shoulderTilt: -0.016, headBias: -0.04,
    scale: Object.freeze([1.035, 1.015, 0.975]),
  }),
  Object.freeze({
    silhouette: 'compact', gaitStyle: 'steady', phase: 4.47, cadence: 1.04,
    armSwing: 1.04, posture: 0.006, shoulderTilt: 0.02, headBias: 0.045,
    scale: Object.freeze([0.97, 0.975, 1.035]),
  }),
  Object.freeze({
    silhouette: 'long-step', gaitStyle: 'brisk', phase: 5.92, cadence: 1.09,
    armSwing: 1.14, posture: 0.015, shoulderTilt: -0.012, headBias: 0.01,
    scale: Object.freeze([1.005, 1.045, 0.965]),
  }),
]);
const PRACTICAL_COLORS = Object.freeze({ storefront: 0xffb46f, street: 0xffc786, vehicle: 0xffd99a });
// Ferry facade anchors are authored at pavement elevation + 2.35 m. Keep the
// local additive pool on that pavement instead of hovering below the fixture.
const PRACTICAL_HALO_DROP = 2.35;
const PRACTICAL_GLOW_VARIATION = Object.freeze([0.76, 0.94, 0.68, 0.86, 0.62, 0.8]);
// Detailed civilians deliberately stay out of the static city shadow map:
// their source-driven motion would otherwise leave a stale hard shadow after
// the renderer freezes the map.  This slightly denser local contact is the
// stable, source-safe grounding cue for the moving near-field rigs.
const DETAILED_CONTACT_SHADOW_OPACITY = 0.66;

function colorGeometry(geometry, color, centerColor = null) {
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  const outer = new THREE.Color(color);
  const center = new THREE.Color(centerColor || color);
  for (let index = 0; index < geometry.attributes.position.count; index += 1) {
    // CircleGeometry keeps its centre at index zero. A dark outer ring makes
    // the practical's additive pool feather out instead of reading as a decal.
    const source = centerColor && index === 0 ? center : outer;
    colors[index * 3] = source.r;
    colors[index * 3 + 1] = source.g;
    colors[index * 3 + 2] = source.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createPracticalGeometry() {
  const bulb = colorGeometry(new THREE.SphereGeometry(0.11, 8, 6), 0xffffff);
  const halfWidth = 2.05;
  const bottom = -2.05;
  const spring = -0.88;
  const arch = new THREE.Shape()
    .moveTo(-halfWidth, bottom)
    .lineTo(halfWidth, bottom)
    .lineTo(halfWidth, spring)
    .absarc(0, spring, halfWidth, 0, Math.PI, false)
    .lineTo(-halfWidth, bottom);
  // Arched silhouettes align the glow to the authored first-floor rhythm;
  // these are not rectangular emissive billboards. The perpendicular pair is
  // deliberately shallow so one card faces any camera-facing OSM facade.
  const facadeX = colorGeometry(new THREE.ShapeGeometry(arch, 12).translate(0, 0, -0.035), 0xcf6d24);
  const facadeZ = colorGeometry(
    new THREE.ShapeGeometry(arch, 12).rotateY(Math.PI / 2).translate(0.035, 0, 0),
    0xcf6d24,
  );
  // Two subdued crossed ellipses reach along the approach from the facade.
  // Vertex color falls from a warm centre to near-black at the rim, leaving
  // the upper facade and sky entirely unaltered.
  const poolAlongX = colorGeometry(
    new THREE.CircleGeometry(1, 28).scale(19, 7.2, 1).rotateX(-Math.PI / 2).translate(0, -PRACTICAL_HALO_DROP, 0),
    0x160500,
    0xff9c46,
  );
  const poolAlongZ = colorGeometry(
    new THREE.CircleGeometry(1, 28).scale(7.2, 19, 1).rotateX(-Math.PI / 2).translate(0, -PRACTICAL_HALO_DROP, 0),
    0x160500,
    0xff9c46,
  );
  const merged = mergeGeometries([bulb, facadeX, facadeZ, poolAlongX, poolAlongZ]);
  [bulb, facadeX, facadeZ, poolAlongX, poolAlongZ].forEach((geometry) => geometry.dispose());
  if (!merged) throw new Error('Ferry hero practical geometry merge is unavailable');
  return merged;
}

function clamp(value, min, max) {
  return THREE.MathUtils.clamp(Number(value) || 0, min, max);
}

function rootFor(record) {
  if (record?.isObject3D) return record;
  const candidate = record?.mesh?.root || record?.mesh || record?.root || record?.avatar || record?.group || null;
  return candidate?.isObject3D ? candidate : null;
}

function colorFor(record, index, palette, fallbackKey) {
  const candidate = record?.color ?? record?.[fallbackKey] ?? record?.mesh?.userData?.[fallbackKey];
  return new THREE.Color(typeof candidate === 'number' ? candidate : palette[index % palette.length]);
}

function conditionState(input = {}) {
  const timeOfDay = input.timeOfDay === 'night' || input.timeOfDay === 'dusk' ? input.timeOfDay : 'day';
  const weather = ['drizzle', 'fog', 'overcast'].includes(input.weather) ? input.weather : 'clear';
  const inferredNight = timeOfDay === 'night' ? 1 : timeOfDay === 'dusk' ? 0.48 : 0;
  return {
    timeOfDay,
    weather,
    night: clamp(input.night ?? inferredNight, 0, 1),
    wetness: clamp(input.wetness ?? (weather === 'drizzle' ? 0.9 : weather === 'fog' ? 0.25 : 0), 0, 1),
  };
}

function instanced(geometry, material, capacity, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.count = capacity;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Creates a non-invasive near-field life presentation layer.
 *
 * @param {{scene: THREE.Object3D, maxPedestrians?: number, maxVehicles?: number,
 *   maxDetailedActors?: number,
 *   cameraExclusionRadius?: number, heroExclusionRadius?: number,
 *   vehicleDetailDistance?: number, pedestrianDetailDistance?: number,
 *   replaceSources?: boolean,
 *   conditions?: object}} options
 */
export function createHeroLifeLighting(options = {}) {
  if (!options.scene?.isObject3D) throw new Error('createHeroLifeLighting requires a Three.js scene or group');

  const maxPedestrians = Math.floor(clamp(options.maxPedestrians ?? HERO_LIFE_LIGHTING_BUDGET.maxPedestrians, 1, HERO_LIFE_LIGHTING_BUDGET.maxPedestrians));
  const maxVehicles = Math.floor(clamp(options.maxVehicles ?? HERO_LIFE_LIGHTING_BUDGET.maxVehicles, 1, HERO_LIFE_LIGHTING_BUDGET.maxVehicles));
  const maxDetailedActors = Math.floor(clamp(
    options.maxDetailedActors ?? HERO_LIFE_LIGHTING_BUDGET.maxDetailedActors,
    1,
    maxPedestrians,
  ));
  const replaceSources = options.replaceSources ?? true;
  const cameraExclusionRadius = Math.max(0.5, Number(options.cameraExclusionRadius) || 3.25);
  const heroExclusionRadius = Math.max(0.5, Number(options.heroExclusionRadius) || 2.35);
  const vehicleDetailDistance = Math.max(6, Number(options.vehicleDetailDistance) || 48);
  const pedestrianDetailDistance = Math.max(4, Number(options.pedestrianDetailDistance) || 22);
  let conditions = conditionState(options.conditions);

  const group = new THREE.Group();
  group.name = 'Ferry Building hero life and practical lighting';
  group.userData.heroLifeLighting = true;
  options.scene.add(group);

  // Ten fixed instanced calls and eight shared materials are the intentional
  // ceiling. The presentation will not scale draw calls with simulation size.
  // The distant pool still has to read as people in the Ferry establishing
  // shot.  Keep its five instanced calls, but give the shared forms a real
  // shoulder line, jacket hem, face direction, and rounded limb ends instead
  // of the old featureless capsule-and-stick construction.
  const torsoCore = new THREE.CapsuleGeometry(0.24, 0.57, 4, 8);
  const shoulders = new THREE.SphereGeometry(0.25, 10, 6).scale(1.12, 0.48, 0.78).translate(0, 0.37, 0);
  const jacketHem = new THREE.CylinderGeometry(0.235, 0.27, 0.16, 10).translate(0, -0.35, 0);
  const torsoGeometry = mergeGeometries([torsoCore, shoulders, jacketHem]);
  [torsoCore, shoulders, jacketHem].forEach((geometry) => geometry.dispose());
  if (!torsoGeometry) throw new Error('Ferry hero pedestrian torso geometry merge is unavailable');
  const cranium = new THREE.SphereGeometry(0.145, 10, 8);
  const nose = new THREE.SphereGeometry(0.035, 6, 4).scale(0.68, 0.82, 1).translate(0, -0.012, 0.142);
  const headGeometry = mergeGeometries([cranium, nose]);
  [cranium, nose].forEach((geometry) => geometry.dispose());
  if (!headGeometry) throw new Error('Ferry hero pedestrian head geometry merge is unavailable');
  const limbGeometry = new THREE.CapsuleGeometry(0.07, 0.56, 3, 6);
  const shadowGeometry = new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2);
  const vehicleBodyGeometry = new THREE.BoxGeometry(1, 1, 1);
  const vehicleCabinGeometry = new THREE.BoxGeometry(1, 1, 1);
  const wheelGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
  wheelGeometry.rotateZ(Math.PI / 2);
  const practicalGeometry = createPracticalGeometry();

  const clothingMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.72, metalness: 0.02 });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.82 });
  const trouserMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.88 });
  const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x081015, transparent: true, opacity: 0.22, depthWrite: false });
  const vehicleMaterial = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.33, metalness: 0.22, clearcoat: 0.35, clearcoatRoughness: 0.15 });
  const glassMaterial = new THREE.MeshPhysicalMaterial({ color: 0x1c2e39, roughness: 0.18, metalness: 0.12, transparent: true, opacity: 0.84 });
  const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x151719, roughness: 0.93 });
  const practicalMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0xa94c17,
    emissiveIntensity: 0,
    roughness: 0.44,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const meshes = {
    torso: instanced(torsoGeometry, clothingMaterial, maxPedestrians, 'Hero life pedestrian torsos'),
    head: instanced(headGeometry, skinMaterial, maxPedestrians, 'Hero life pedestrian heads'),
    leg: instanced(limbGeometry, trouserMaterial, maxPedestrians * 2, 'Hero life pedestrian legs'),
    arm: instanced(limbGeometry, clothingMaterial, maxPedestrians * 2, 'Hero life pedestrian arms'),
    pedestrianShadow: instanced(shadowGeometry, shadowMaterial, maxPedestrians, 'Hero life pedestrian contact shadows'),
    vehicleBody: instanced(vehicleBodyGeometry, vehicleMaterial, maxVehicles, 'Hero life vehicle bodies'),
    vehicleCabin: instanced(vehicleCabinGeometry, glassMaterial, maxVehicles, 'Hero life vehicle cabins'),
    wheel: instanced(wheelGeometry, tireMaterial, maxVehicles * 4, 'Hero life vehicle wheels'),
    vehicleShadow: instanced(shadowGeometry, shadowMaterial, maxVehicles, 'Hero life vehicle contact shadows'),
    practical: instanced(practicalGeometry, practicalMaterial, HERO_LIFE_LIGHTING_BUDGET.maxPracticals, 'Hero life warm practical fixtures'),
  };
  Object.values(meshes).forEach((mesh) => group.add(mesh));

  const lights = Array.from({ length: HERO_LIFE_LIGHTING_BUDGET.maxPracticals }, (_, index) => {
    const light = new THREE.PointLight(0xffbd79, 0, 14, 2);
    light.castShadow = false;
    light.name = `Hero life practical ${index + 1}`;
    group.add(light);
    return light;
  });
  const pedestrians = [];
  const vehicles = [];
  const practicals = [];
  // A small player-grade pool carries the close read while the instanced
  // presentation remains responsible for the rest of the crowd. The rigs use
  // the existing pedestrian material cache; never dispose that cache here.
  const detailedActors = Array.from({ length: maxDetailedActors }, (_, index) => {
    const root = createPlayerAvatar({
      name: `Ferry civilian ${index + 1}`,
      paletteIndex: index,
      scale: 1,
    });
    root.name = `Ferry detailed civilian ${index + 1}`;
    root.visible = false;
    root.userData.heroLifeDetailedActor = true;
    root.userData.heroLifeSource = null;
    const profile = CIVILIAN_PRESENTATION_PROFILES[index % CIVILIAN_PRESENTATION_PROFILES.length];
    // Set before the first animator call so the newly created layer preserves
    // this deterministic civilian phase instead of starting every adult at 0.
    root.userData.phase = profile.phase;
    root.userData.heroLifePresentation = Object.freeze({
      silhouette: profile.silhouette,
      gaitStyle: profile.gaitStyle,
      paletteIndex: index,
    });
    // Labels and reaction UI turn a close civilian pass into HUD clutter.
    root.traverse((object) => {
      if (object.isSprite) object.visible = false;
      if (object.isMesh) {
        object.castShadow = false;
        object.receiveShadow = true;
      }
    });
    const shadow = root.userData.shadow;
    if (shadow) {
      shadow.visible = true;
      shadow.position.y = -0.105;
      shadow.material.opacity = DETAILED_CONTACT_SHADOW_OPACITY;
    }
    group.add(root);
    return {
      root,
      source: null,
      paletteIndex: index,
      presentationProfile: profile,
      previousPosition: new THREE.Vector3(),
      hasPreviousPosition: false,
      previousForward: new THREE.Vector3(),
      hasPreviousForward: false,
    };
  });
  const stats = {
    pedestriansAttached: 0, pedestriansActive: 0, pedestriansExcluded: 0, pedestriansDropped: 0,
    detailedActors: 0, fallbackActors: 0, swaps: 0, detailDrawCost: 0, detailMaterials: 0,
    detailAssignments: [],
    pedestrianDetailDistance, performanceTargetFps: 60,
    vehiclesAttached: 0, vehiclesActive: 0, vehiclesExcluded: 0, vehiclesDetailed: 0, vehiclesDropped: 0,
    practicals: 0, activePracticals: 0, pointLights: HERO_LIFE_LIGHTING_BUDGET.maxPracticals,
    practicalLightPower: 0, practicalGlowOpacity: 0,
    drawCalls: HERO_LIFE_LIGHTING_BUDGET.drawCalls, materials: HERO_LIFE_LIGHTING_BUDGET.materials,
  };
  const sourcePosition = new THREE.Vector3();
  const sourceQuaternion = new THREE.Quaternion();
  const sourceWorld = new THREE.Matrix4();
  const inverseGroupWorld = new THREE.Matrix4();
  const presentationWorld = new THREE.Matrix4();
  const localMatrix = new THREE.Matrix4();
  const finalMatrix = new THREE.Matrix4();
  const localPosition = new THREE.Vector3();
  const localScale = new THREE.Vector3();
  const identity = new THREE.Quaternion();
  const warmColor = new THREE.Color();
  const practicalGlowColor = new THREE.Color();
  const detailCandidates = [];
  const detailSourceSet = new Set();
  const detailWorldPosition = new THREE.Vector3();
  const detailLocalPosition = new THREE.Vector3();
  const detailWorldQuaternion = new THREE.Quaternion();
  const detailLocalQuaternion = new THREE.Quaternion();
  const detailInverseGroupQuaternion = new THREE.Quaternion();
  const detailCurrentForward = new THREE.Vector3();
  const limbSwing = new THREE.Quaternion();
  const counterSwing = new THREE.Quaternion();
  const torsoSway = new THREE.Quaternion();
  const fallbackTrouser = new THREE.Color();
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);

  function sourceMatrix(source) {
    source.updateWorldMatrix(true, false);
    source.getWorldPosition(sourcePosition);
    source.getWorldQuaternion(sourceQuaternion);
    sourceWorld.compose(sourcePosition, sourceQuaternion, new THREE.Vector3(1, 1, 1));
    return presentationWorld.multiplyMatrices(inverseGroupWorld, sourceWorld);
  }

  function set(mesh, index, world, x, y, z, sx, sy, sz, rotation = identity) {
    localPosition.set(x, y, z);
    localScale.set(sx, sy, sz);
    localMatrix.compose(localPosition, rotation, localScale);
    finalMatrix.multiplyMatrices(world, localMatrix);
    mesh.setMatrixAt(index, finalMatrix);
  }

  function hide(mesh, index) {
    mesh.setMatrixAt(index, EMPTY_MATRIX);
  }

  function clearMeshes() {
    for (const mesh of Object.values(meshes)) {
      for (let index = 0; index < mesh.count; index += 1) hide(mesh, index);
    }
  }

  function attachRecords(target, nextRecords, maximum, palette, fallbackKey, attachedKey, droppedKey) {
    restoreRecords(target);
    const valid = Array.from(nextRecords || []).filter((record) => rootFor(record));
    stats[droppedKey] = Math.max(0, valid.length - maximum);
    valid.slice(0, maximum).forEach((record, index) => {
      const source = rootFor(record);
      target.push({ source, color: colorFor(record, index, palette, fallbackKey), wasVisible: source.visible });
      if (replaceSources) {
        source.visible = false;
        source.userData.heroLifeLightingReplacement = true;
      }
    });
    stats[attachedKey] = target.length;
  }

  function restoreRecords(records) {
    for (const entry of records) {
      if (replaceSources) {
        entry.source.visible = entry.wasVisible;
        delete entry.source.userData.heroLifeLightingReplacement;
      }
    }
    records.length = 0;
  }

  function disposePrivateAvatarResources(root) {
    // createPlayerAvatar only adds the tag and contact shadow privately. Its
    // wardrobe geometries/materials are shared by the nearby crowd cache.
    const tag = root.userData?.nameTag;
    if (tag) {
      tag.material?.map?.dispose?.();
      tag.material?.dispose?.();
      root.remove(tag);
    }
    const shadow = root.userData?.shadow;
    if (shadow) {
      shadow.material?.alphaMap?.dispose?.();
      shadow.material?.dispose?.();
      shadow.geometry?.dispose?.();
      root.remove(shadow);
    }
  }

  function attachPedestrians(records = []) {
    attachRecords(pedestrians, records, maxPedestrians, PEDESTRIAN_PALETTE, 'topColor', 'pedestriansAttached', 'pedestriansDropped');
    detailedActors.forEach(hideDetailedActor);
    stats.swaps = 0;
    return api;
  }

  function attachVehicles(records = []) {
    attachRecords(vehicles, records, maxVehicles, VEHICLE_PALETTE, 'vehicleColor', 'vehiclesAttached', 'vehiclesDropped');
    return api;
  }

  function setPracticals(anchors = []) {
    practicals.length = 0;
    Array.from(anchors || []).slice(0, HERO_LIFE_LIGHTING_BUDGET.maxPracticals).forEach((anchor, index) => {
      const kind = PRACTICAL_COLORS[anchor?.kind] ? anchor.kind : index < 3 ? 'storefront' : index < 5 ? 'street' : 'vehicle';
      practicals.push({ anchor, kind, intensity: clamp(anchor?.intensity ?? 1, 0.2, 2) });
    });
    stats.practicals = practicals.length;
    return api;
  }

  function setConditions(nextConditions = {}) {
    // Time and weather own their derived values. Do not carry a previous
    // night/rain override into an explicit day/clear transition.
    const hasNight = Object.prototype.hasOwnProperty.call(nextConditions, 'night');
    const hasWetness = Object.prototype.hasOwnProperty.call(nextConditions, 'wetness');
    const changesTime = Object.prototype.hasOwnProperty.call(nextConditions, 'timeOfDay');
    const changesWeather = Object.prototype.hasOwnProperty.call(nextConditions, 'weather');
    conditions = conditionState({
      ...conditions,
      ...nextConditions,
      night: hasNight ? nextConditions.night : changesTime ? undefined : conditions.night,
      wetness: hasWetness ? nextConditions.wetness : changesWeather ? undefined : conditions.wetness,
    });
    return { ...conditions };
  }

  function excluded(position, cameraPosition, heroPosition) {
    return Boolean((cameraPosition && position.distanceTo(cameraPosition) < cameraExclusionRadius)
      || (heroPosition && position.distanceTo(heroPosition) < heroExclusionRadius));
  }

  function actorDrawStats() {
    const materials = new Set();
    let drawCost = 0;
    for (const actor of detailedActors) {
      if (!actor.root.visible) continue;
      actor.root.traverse((object) => {
        if (!object.isMesh || !object.visible) return;
        drawCost += 1;
        if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
        else if (object.material) materials.add(object.material);
      });
    }
    stats.detailDrawCost = drawCost;
    stats.detailMaterials = materials.size;
  }

  function hideDetailedActor(actor) {
    actor.root.visible = false;
    actor.root.userData.heroLifeSource = null;
    actor.source = null;
    actor.hasPreviousPosition = false;
    actor.hasPreviousForward = false;
  }

  function chooseDetailedActors(cameraPosition, heroPosition) {
    detailCandidates.length = 0;
    detailSourceSet.clear();
    if (!cameraPosition) {
      detailedActors.forEach(hideDetailedActor);
      return;
    }
    for (let slot = 0; slot < pedestrians.length; slot += 1) {
      const entry = pedestrians[slot];
      entry.source.getWorldPosition(detailWorldPosition);
      const distance = detailWorldPosition.distanceTo(cameraPosition);
      if (distance > pedestrianDetailDistance || excluded(detailWorldPosition, cameraPosition, heroPosition)) continue;
      detailCandidates.push({ entry, slot, distance });
    }
    detailCandidates.sort((first, second) => (
      Number(Boolean(second.entry.source.userData.heroLifeDetailPriority))
        - Number(Boolean(first.entry.source.userData.heroLifeDetailPriority))
      || first.distance - second.distance
      || String(first.entry.source.userData.ambientCohortId || first.entry.source.uuid)
        .localeCompare(String(second.entry.source.userData.ambientCohortId || second.entry.source.uuid))
      || first.slot - second.slot
    ));
    const selected = detailCandidates.slice(0, maxDetailedActors);
    const selectedSources = new Set(selected.map(({ entry }) => entry.source));
    // Keep an actor on its source whenever it remains selected. This prevents
    // a wardrobe identity from teleporting between two close walkers.
    for (const actor of detailedActors) {
      if (actor.source && !selectedSources.has(actor.source)) hideDetailedActor(actor);
      if (actor.source) detailSourceSet.add(actor.source);
    }
    for (const candidate of selected) {
      if (detailSourceSet.has(candidate.entry.source)) continue;
      const actor = detailedActors.find((candidateActor) => !candidateActor.source);
      if (!actor) break;
      actor.source = candidate.entry.source;
      actor.root.userData.heroLifeSource = actor.source.uuid;
      actor.root.visible = true;
      actor.hasPreviousPosition = false;
      actor.hasPreviousForward = false;
      stats.swaps += 1;
      detailSourceSet.add(actor.source);
    }
  }

  function updateDetailedActors(cameraPosition, heroPosition, elapsedSeconds, deltaSeconds) {
    chooseDetailedActors(cameraPosition, heroPosition);
    group.getWorldQuaternion(detailWorldQuaternion);
    detailInverseGroupQuaternion.copy(detailWorldQuaternion).invert();
    for (const actor of detailedActors) {
      if (!actor.source) continue;
      actor.source.getWorldPosition(detailWorldPosition);
      actor.source.getWorldQuaternion(detailWorldQuaternion);
      group.worldToLocal(detailLocalPosition.copy(detailWorldPosition));
      detailLocalQuaternion.copy(detailInverseGroupQuaternion).multiply(detailWorldQuaternion);
      actor.root.position.copy(detailLocalPosition);
      actor.root.quaternion.copy(detailLocalQuaternion);
      // Source scale is intentionally not inherited: simulation meshes can
      // be LOD-scaled, but a nearby person must keep adult proportions.
      actor.root.scale.setScalar(1);
      const distance = actor.hasPreviousPosition
        ? actor.previousPosition.distanceTo(detailWorldPosition)
        : 0;
      const moving = actor.hasPreviousPosition && distance > Math.max(0.008, deltaSeconds * 0.09);
      const speedRatio = THREE.MathUtils.clamp(deltaSeconds > 0 ? distance / deltaSeconds / 1.2 : 0, 0, 1);
      detailCurrentForward.set(0, 0, 1).applyQuaternion(detailWorldQuaternion).setY(0);
      if (detailCurrentForward.lengthSq() > 0.0001) detailCurrentForward.normalize();
      const turnLean = actor.hasPreviousForward && deltaSeconds > 0
        ? THREE.MathUtils.clamp(
          (actor.previousForward.x * detailCurrentForward.z - actor.previousForward.z * detailCurrentForward.x)
            / deltaSeconds * 0.055,
          -0.14,
          0.14,
        )
        : 0;
      animatePlayerAvatar(actor.root, {
        moving,
        speedRatio: moving ? Math.max(0.48, speedRatio) : 0,
        elapsed: elapsedSeconds + actor.paletteIndex * 0.37,
        delta: deltaSeconds * actor.presentationProfile.cadence,
        turnLean,
      });
      // Keep the existing palette-index wardrobe selector while these bounded
      // rig/pose cues make the actor read as an individual at Ferry card
      // distance; none of them feed back into source transforms.
      const rig = actor.root.userData.rig;
      const body = actor.root.userData.body;
      const headPivot = actor.root.userData.headPivot;
      if (rig) rig.scale.set(...actor.presentationProfile.scale);
      if (body) {
        body.rotation.x += actor.presentationProfile.posture;
        body.rotation.z += actor.presentationProfile.shoulderTilt;
      }
      if (headPivot) headPivot.rotation.y += actor.presentationProfile.headBias;
      if (actor.root.userData.leftArm) actor.root.userData.leftArm.rotation.x *= actor.presentationProfile.armSwing;
      if (actor.root.userData.rightArm) actor.root.userData.rightArm.rotation.x *= actor.presentationProfile.armSwing;
      actor.previousPosition.copy(detailWorldPosition);
      actor.hasPreviousPosition = true;
      actor.previousForward.copy(detailCurrentForward);
      actor.hasPreviousForward = true;
      stats.detailedActors += 1;
      stats.pedestriansActive += 1;
      stats.detailAssignments.push({
        actor: actor.root.name,
        sourceUuid: actor.source.uuid,
        sourceIdentity: actor.source.userData.ambientCohortId || null,
        silhouette: actor.presentationProfile.silhouette,
        gaitStyle: actor.presentationProfile.gaitStyle,
        paletteIndex: actor.paletteIndex,
        rigScale: actor.presentationProfile.scale,
        shoulderTilt: actor.presentationProfile.shoulderTilt,
        headBias: actor.presentationProfile.headBias,
        position: [
          Number(detailWorldPosition.x.toFixed(3)),
          Number(detailWorldPosition.y.toFixed(3)),
          Number(detailWorldPosition.z.toFixed(3)),
        ],
      });
    }
    actorDrawStats();
  }

  function updatePedestrian(slot, entry, cameraPosition, heroPosition, elapsedSeconds) {
    const world = sourceMatrix(entry.source);
    if (!entry.source.visible && !entry.source.userData.heroLifeLightingReplacement || excluded(sourcePosition, cameraPosition, heroPosition)) {
      stats.pedestriansExcluded += 1;
      return;
    }
    if (detailSourceSet.has(entry.source)) return;
    const cadence = 4.75 + (slot % 4) * 0.22;
    const stride = Math.sin(elapsedSeconds * cadence + slot * 1.71) * 0.16;
    const step = Math.sin(elapsedSeconds * cadence + slot * 1.71);
    const adultScale = 0.94 + (slot % 5) * 0.025;
    // The source owns heading and ground position. These rotations are local
    // presentation-only motion, so they cannot alter path following or the
    // authored Ferry crossing timings.
    torsoSway.setFromAxisAngle(axisZ, step * 0.018);
    limbSwing.setFromAxisAngle(axisX, step * 0.34);
    counterSwing.setFromAxisAngle(axisX, -step * 0.34);
    set(meshes.torso, slot, world, 0, 1.13, 0, 0.51 * adultScale, 0.98 * adultScale, 0.4 * adultScale, torsoSway);
    set(meshes.head, slot, world, 0, 1.77 * adultScale, 0.012, 0.3 * adultScale, 0.3 * adultScale, 0.3 * adultScale);
    set(meshes.pedestrianShadow, slot, world, 0, 0.018, 0, 0.33 * adultScale, 0.5 * adultScale, 1);
    set(meshes.leg, slot * 2, world, -0.12, 0.48 * adultScale, stride, 0.13 * adultScale, 0.64 * adultScale, 0.13 * adultScale, limbSwing);
    set(meshes.leg, slot * 2 + 1, world, 0.12, 0.48 * adultScale, -stride, 0.13 * adultScale, 0.64 * adultScale, 0.13 * adultScale, counterSwing);
    set(meshes.arm, slot * 2, world, -0.31, 1.17 * adultScale, -stride * 0.9, 0.11 * adultScale, 0.61 * adultScale, 0.11 * adultScale, counterSwing);
    set(meshes.arm, slot * 2 + 1, world, 0.31, 1.17 * adultScale, stride * 0.9, 0.11 * adultScale, 0.61 * adultScale, 0.11 * adultScale, limbSwing);
    meshes.torso.setColorAt(slot, entry.color);
    meshes.head.setColorAt(slot, new THREE.Color(SKIN_PALETTE[slot % SKIN_PALETTE.length]));
    meshes.arm.setColorAt(slot * 2, entry.color);
    meshes.arm.setColorAt(slot * 2 + 1, entry.color);
    // Carry a muted version of each jacket palette into the trousers. This
    // adds individual wardrobe reads without spending another material/draw.
    fallbackTrouser.copy(entry.color).multiplyScalar(0.38 + (slot % 3) * 0.035);
    meshes.leg.setColorAt(slot * 2, fallbackTrouser);
    meshes.leg.setColorAt(slot * 2 + 1, fallbackTrouser);
    stats.pedestriansActive += 1;
    stats.fallbackActors += 1;
  }

  function updateVehicle(slot, entry, cameraPosition, heroPosition) {
    const world = sourceMatrix(entry.source);
    if (!entry.source.visible && !entry.source.userData.heroLifeLightingReplacement || excluded(sourcePosition, cameraPosition, heroPosition)) {
      stats.vehiclesExcluded += 1;
      return;
    }
    const detailed = !cameraPosition || sourcePosition.distanceTo(cameraPosition) <= vehicleDetailDistance;
    set(meshes.vehicleBody, slot, world, 0, 0.48, 0, 1.88, 0.76, 4.58);
    set(meshes.vehicleCabin, slot, world, 0, 1.0, -0.14, 1.62, 0.52, 2.3);
    set(meshes.vehicleShadow, slot, world, 0, 0.02, 0, 1.45, 2.1, 1);
    meshes.vehicleBody.setColorAt(slot, entry.color);
    if (detailed) {
      for (let wheel = 0; wheel < 4; wheel += 1) {
        const side = wheel % 2 ? 1 : -1;
        const front = wheel < 2 ? 1 : -1;
        set(meshes.wheel, slot * 4 + wheel, world, side * 0.92, 0.34, front * 1.48, 0.24, 0.34, 0.34);
      }
      stats.vehiclesDetailed += 1;
    }
    stats.vehiclesActive += 1;
  }

  function anchorWorldPosition(anchor, target) {
    if (anchor?.source?.isObject3D) return anchor.source.getWorldPosition(target);
    if (anchor?.position?.isVector3) return target.copy(anchor.position);
    return target.set(Number(anchor?.x) || 0, Number(anchor?.y) || 0, Number(anchor?.z) || 0);
  }

  function updatePracticals() {
    const weatherDamping = conditions.weather === 'fog' ? 0.68 : conditions.weather === 'drizzle' ? 0.86 : 1;
    const baseIntensity = (0.08 + conditions.night * 1.25) * weatherDamping;
    // The two runtime Ferry anchors are intentionally local. This gain lifts
    // only their facade and immediate paving response, rather than changing
    // ambient/exposure or expanding the practical-light budget.
    const localizedNightGain = conditions.night > 0.02
      ? 2.6 + conditions.wetness * 0.4
      : 1;
    practicalMaterial.opacity = conditions.night > 0.02 ? 0.68 + conditions.wetness * 0.1 : 0;
    practicalMaterial.emissiveIntensity = conditions.night > 0.02
      ? 1.15 + conditions.wetness * 0.35
      : 0;
    stats.practicalGlowOpacity = practicalMaterial.opacity;
    for (let index = 0; index < HERO_LIFE_LIGHTING_BUDGET.maxPracticals; index += 1) {
      const practical = practicals[index];
      const light = lights[index];
      if (!practical) {
        light.intensity = 0;
        hide(meshes.practical, index);
        continue;
      }
      anchorWorldPosition(practical.anchor, sourcePosition);
      group.worldToLocal(sourcePosition);
      warmColor.setHex(PRACTICAL_COLORS[practical.kind]);
      light.color.copy(warmColor);
      practicalGlowColor.copy(warmColor).multiplyScalar(PRACTICAL_GLOW_VARIATION[index]);
      meshes.practical.setColorAt(index, practicalGlowColor);
      light.position.copy(sourcePosition);
      light.intensity = baseIntensity * localizedNightGain * practical.intensity;
      light.distance = practical.kind === 'vehicle' ? 8 : practical.kind === 'storefront' ? 32 : 16;
      const presentationScale = practical.kind === 'storefront' ? 1 : 0.16;
      set(meshes.practical, index, new THREE.Matrix4(), sourcePosition.x, sourcePosition.y, sourcePosition.z, presentationScale, presentationScale, presentationScale);
      stats.practicalLightPower += light.intensity;
      if (conditions.night > 0.02) stats.activePracticals += 1;
    }
  }

  function update({ camera = null, hero = null, elapsedSeconds = 0, deltaSeconds = 1 / 60 } = {}) {
    const cameraObject = camera?.isObject3D ? camera : null;
    const cameraPosition = cameraObject ? cameraObject.getWorldPosition(new THREE.Vector3()) : camera?.position || camera || null;
    const heroPosition = hero?.isObject3D ? hero.getWorldPosition(new THREE.Vector3()) : hero?.position || hero || null;
    group.updateWorldMatrix(true, false);
    inverseGroupWorld.copy(group.matrixWorld).invert();
    clearMeshes();
    stats.pedestriansActive = 0;
    stats.pedestriansExcluded = 0;
    stats.detailedActors = 0;
    stats.fallbackActors = 0;
    stats.detailDrawCost = 0;
    stats.detailMaterials = 0;
    stats.detailAssignments = [];
    stats.vehiclesActive = 0;
    stats.vehiclesExcluded = 0;
    stats.vehiclesDetailed = 0;
    stats.activePracticals = 0;
    stats.practicalLightPower = 0;
    stats.practicalGlowOpacity = 0;
    const safeDelta = clamp(deltaSeconds, 0, 0.05) || 1 / 60;
    updateDetailedActors(cameraPosition, heroPosition, Number(elapsedSeconds) || 0, safeDelta);
    pedestrians.forEach((entry, index) => updatePedestrian(index, entry, cameraPosition, heroPosition, Number(elapsedSeconds) || 0));
    vehicles.forEach((entry, index) => updateVehicle(index, entry, cameraPosition, heroPosition));
    updatePracticals();
    for (const mesh of Object.values(meshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return getStats();
  }

  function getStats() {
    return {
      ...stats,
      conditions: { ...conditions },
      budget: { ...HERO_LIFE_LIGHTING_BUDGET, maxDetailedActors },
    };
  }

  function dispose() {
    restoreRecords(pedestrians);
    restoreRecords(vehicles);
    detailedActors.forEach((actor) => {
      actor.root.removeFromParent();
      disposePrivateAvatarResources(actor.root);
    });
    group.removeFromParent();
    [torsoGeometry, headGeometry, limbGeometry, shadowGeometry, vehicleBodyGeometry, vehicleCabinGeometry, wheelGeometry, practicalGeometry].forEach((geometry) => geometry.dispose());
    [clothingMaterial, skinMaterial, trouserMaterial, shadowMaterial, vehicleMaterial, glassMaterial, tireMaterial, practicalMaterial].forEach((material) => material.dispose());
  }

  const api = Object.freeze({ attachPedestrians, attachVehicles, setPracticals, setConditions, update, getStats, dispose, group });
  return api;
}
