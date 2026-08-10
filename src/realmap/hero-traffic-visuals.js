// Near-field traffic presentation for the Ferry Building hero corridor.
//
// This module deliberately does not own traffic simulation.  It reads the
// transforms from existing traffic records and renders a capped, instanced
// automotive shell over them.  Keeping presentation separate means paths,
// signals, speed, and player-driving state remain the source system's job.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const DEFAULT_PALETTE = Object.freeze([
  0xd84a3a, 0x2f6fb5, 0xe0b32e, 0x4a9e77,
  0xdfe1e4, 0x8e5a9e, 0xc98a3d, 0x3f8f8f,
]);

const STYLE_BY_KIND = Object.freeze({
  car: { width: 1.86, length: 4.5, height: 1.44, cabinLength: 2.25, wheel: 0.33 },
  sedan: { width: 1.88, length: 4.68, height: 1.46, cabinLength: 2.38, wheel: 0.34 },
  taxi: { width: 1.88, length: 4.68, height: 1.46, cabinLength: 2.38, wheel: 0.34 },
  suv: { width: 2.0, length: 4.9, height: 1.75, cabinLength: 2.6, wheel: 0.38 },
  pickup: { width: 2.04, length: 5.45, height: 1.8, cabinLength: 2.1, wheel: 0.39 },
  truck: { width: 2.08, length: 5.55, height: 1.92, cabinLength: 2.05, wheel: 0.4 },
  van: { width: 2.04, length: 5.35, height: 2.08, cabinLength: 2.9, wheel: 0.38 },
  bus: { width: 2.5, length: 8.4, height: 2.95, cabinLength: 5.3, wheel: 0.46 },
});

function vehicleRoot(record) {
  const candidate = record?.mesh?.root || record?.mesh || record?.root || null;
  return candidate?.isObject3D ? candidate : null;
}

function vehicleKind(record) {
  const kind = String(record?.cls || record?.variant || record?.type || 'sedan').toLowerCase();
  return STYLE_BY_KIND[kind] ? kind : 'sedan';
}

function vehicleColor(record, index) {
  const candidate = record?.color ?? record?.mesh?.userData?.vehicleColor
    ?? record?.mesh?.root?.userData?.vehicleColor;
  return new THREE.Color(typeof candidate === 'number' ? candidate : DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]);
}

function makeCabinGeometry() {
  // A single tapered cabin topology gives the hero fleet windshield and roof
  // rake without allocating a bespoke GLB or a geometry per car.
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    -0.38, 0.5, -0.32, 0.38, 0.5, -0.32, 0.42, 0.5, 0.36, -0.42, 0.5, 0.36,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex([
    0, 2, 1, 0, 3, 2, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

function makeInstance(geometry, material, capacity, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.count = capacity;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Creates a low-call hero vehicle renderer.
 *
 * @param {{scene: THREE.Object3D, maxVehicles?: number, cameraExclusionRadius?: number,
 *   cameraFadeDistance?: number, heroRadius?: number, detailDistance?: number}} options
 */
export function createHeroTrafficVisuals(options = {}) {
  if (!options.scene?.isObject3D) throw new Error('createHeroTrafficVisuals requires a Three.js scene or group');

  const maxVehicles = Math.max(1, Math.min(48, Math.floor(options.maxVehicles ?? 36)));
  const exclusionRadius = Math.max(0.1, options.cameraExclusionRadius ?? 4.5);
  const fadeDistance = Math.max(0.1, options.cameraFadeDistance ?? 1.5);
  const heroRadius = Math.max(exclusionRadius, options.heroRadius ?? 14);
  const detailDistance = Math.max(heroRadius, options.detailDistance ?? 58);
  const group = new THREE.Group();
  group.name = 'Ferry Building hero traffic presentation (instanced)';
  group.userData.heroTrafficPresentation = true;
  options.scene.add(group);

  // Eight meshes / seven materials is the hard rendering budget, independent
  // of traffic count. Each vehicle expands to instances rather than draw calls.
  const bodyGeometry = new RoundedBoxGeometry(1, 1, 1, 0.12, 3);
  const deckGeometry = new RoundedBoxGeometry(1, 1, 1, 0.08, 2);
  const cabinGeometry = makeCabinGeometry();
  const wheelGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
  wheelGeometry.rotateZ(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
  hubGeometry.rotateZ(Math.PI / 2);
  const lampGeometry = new RoundedBoxGeometry(1, 1, 1, 0.08, 2);
  const shadowGeometry = new THREE.CircleGeometry(1, 20);
  shadowGeometry.rotateX(-Math.PI / 2);

  const bodyMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.31, metalness: 0.2,
    clearcoat: 0.38, clearcoatRoughness: 0.16,
  });
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x1f3a49, roughness: 0.14, metalness: 0.12, clearcoat: 0.25,
    transparent: true, opacity: 0.84, depthWrite: true,
  });
  const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x151719, roughness: 0.91 });
  const hubMaterial = new THREE.MeshStandardMaterial({ color: 0x505860, roughness: 0.38, metalness: 0.62 });
  const headMaterial = new THREE.MeshStandardMaterial({ color: 0xffedbd, emissive: 0xffd98a, emissiveIntensity: 1.3 });
  const tailMaterial = new THREE.MeshStandardMaterial({ color: 0x741410, emissive: 0xf23224, emissiveIntensity: 1.6 });
  const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x061014, transparent: true, opacity: 0.22, depthWrite: false });

  const meshes = {
    body: makeInstance(bodyGeometry, bodyMaterial, maxVehicles, 'Hero traffic chassis'),
    deck: makeInstance(deckGeometry, bodyMaterial, maxVehicles * 2, 'Hero traffic hood and trunk'),
    cabin: makeInstance(cabinGeometry, glassMaterial, maxVehicles, 'Hero traffic raked cabins'),
    wheel: makeInstance(wheelGeometry, tireMaterial, maxVehicles * 4, 'Hero traffic wheels'),
    hub: makeInstance(hubGeometry, hubMaterial, maxVehicles * 4, 'Hero traffic wheel hubs'),
    head: makeInstance(lampGeometry, headMaterial, maxVehicles * 2, 'Hero traffic headlights'),
    tail: makeInstance(lampGeometry, tailMaterial, maxVehicles * 2, 'Hero traffic tail lights'),
    shadow: makeInstance(shadowGeometry, shadowMaterial, maxVehicles, 'Hero traffic contact shadows'),
  };
  Object.values(meshes).forEach((mesh) => group.add(mesh));

  const records = [];
  const emptyMatrix = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
  const localMatrix = new THREE.Matrix4();
  const finalMatrix = new THREE.Matrix4();
  const localPosition = new THREE.Vector3();
  const localScale = new THREE.Vector3();
  const sourcePosition = new THREE.Vector3();
  const sourceQuaternion = new THREE.Quaternion();
  const presentationScale = new THREE.Vector3(1, 1, 1);
  const sourceWorldMatrix = new THREE.Matrix4();
  const presentationMatrix = new THREE.Matrix4();
  const presentationParentInverse = new THREE.Matrix4();
  const identityQuaternion = new THREE.Quaternion();
  const stats = { attached: 0, dropped: 0, active: 0, excluded: 0, detailed: 0, drawCalls: 8, materials: 7 };

  function clearInstanceRange() {
    for (const mesh of Object.values(meshes)) {
      for (let index = 0; index < mesh.count; index += 1) mesh.setMatrixAt(index, emptyMatrix);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function setTransform(mesh, index, worldMatrix, position, scale, rotation = identityQuaternion) {
    localMatrix.compose(position, rotation, scale);
    finalMatrix.multiplyMatrices(worldMatrix, localMatrix);
    mesh.setMatrixAt(index, finalMatrix);
  }

  function setEmpty(mesh, index) {
    mesh.setMatrixAt(index, emptyMatrix);
  }

  function populate(slot, entry, cameraPosition, heroPosition) {
    const { source, record, color } = entry;
    source.updateWorldMatrix(true, false);
    source.getWorldPosition(sourcePosition);
    source.getWorldQuaternion(sourceQuaternion);
    // Legacy traffic primitives use arbitrary authoring scales (realmap's
    // block car is 1.2x, while other pools can be much smaller).  Their world
    // position and heading are simulation truth, but their scale is not. Build
    // a clean rigid transform so the real-world style dimensions are applied
    // exactly once below.
    sourceWorldMatrix.compose(sourcePosition, sourceQuaternion, presentationScale);
    presentationMatrix.multiplyMatrices(presentationParentInverse, sourceWorldMatrix);
    const style = STYLE_BY_KIND[vehicleKind(record)];
    const cameraDistance = cameraPosition ? sourcePosition.distanceTo(cameraPosition) : Infinity;
    const heroDistance = heroPosition ? Math.hypot(sourcePosition.x - heroPosition.x, sourcePosition.z - heroPosition.z) : Infinity;
    const isHeroNear = heroDistance <= heroRadius;
    const proximity = isHeroNear && cameraDistance < exclusionRadius + fadeDistance
      ? THREE.MathUtils.smoothstep(cameraDistance, exclusionRadius, exclusionRadius + fadeDistance)
      : 1;
    // Per-instance alpha would require a custom shader. Shrinking a vehicle
    // through this band made it read as a toy, so use the band as a tight
    // visibility gate and always render an admitted vehicle at full scale.
    const admitted = proximity >= 0.5;
    const isDetailed = cameraDistance <= detailDistance && admitted;
    entry.fade = admitted ? 1 : 0;
    entry.detail = isDetailed;
    if (!admitted || !source.visible && source.userData.heroTrafficPresentation !== true) {
      setEmpty(meshes.body, slot);
      setEmpty(meshes.cabin, slot);
      setEmpty(meshes.shadow, slot);
      for (let part = 0; part < 2; part += 1) {
        setEmpty(meshes.deck, slot * 2 + part);
        setEmpty(meshes.head, slot * 2 + part);
        setEmpty(meshes.tail, slot * 2 + part);
      }
      for (let part = 0; part < 4; part += 1) {
        setEmpty(meshes.wheel, slot * 4 + part);
        setEmpty(meshes.hub, slot * 4 + part);
      }
      stats.excluded += 1;
      return;
    }

    const worldMatrix = presentationMatrix;
    const formScale = isDetailed ? 1 : 0.94;
    const set = (mesh, index, x, y, z, sx, sy, sz, rotation = identityQuaternion) => {
      localPosition.set(x, y, z);
      localScale.set(sx, sy, sz);
      setTransform(mesh, index, worldMatrix, localPosition, localScale, rotation);
    };
    const bodyHeight = style.height * 0.46;
    set(meshes.body, slot, 0, style.wheel * 1.03, 0, style.width * 0.98 * formScale, bodyHeight, style.length * 0.98 * formScale);
    set(meshes.deck, slot * 2, 0, style.height * 0.61, style.length * 0.34, style.width * 0.92, style.height * 0.14, style.length * 0.25);
    set(meshes.deck, slot * 2 + 1, 0, style.height * 0.59, -style.length * 0.39, style.width * 0.92, style.height * 0.13, style.length * 0.18);
    set(meshes.cabin, slot, 0, style.height * 0.83, -style.length * 0.035, style.width * 0.86 * formScale, style.height * 0.43, style.cabinLength * formScale);
    set(meshes.shadow, slot, 0, 0.025, 0, style.width * 0.78 * formScale, style.length * 0.46 * formScale, 1);

    if (isDetailed) {
      const wheelZ = style.length * 0.31;
      for (let part = 0; part < 4; part += 1) {
        const side = part % 2 === 0 ? -1 : 1;
        const z = part < 2 ? wheelZ : -wheelZ;
        set(meshes.wheel, slot * 4 + part, side * style.width * 0.49, style.wheel, z, style.width * 0.125, style.wheel, style.wheel);
        set(meshes.hub, slot * 4 + part, side * style.width * 0.505, style.wheel, z, style.width * 0.132, style.wheel * 0.44, style.wheel * 0.44);
      }
      for (let part = 0; part < 2; part += 1) {
        const side = part === 0 ? -1 : 1;
        set(meshes.head, slot * 2 + part, side * style.width * 0.3, style.height * 0.48, style.length * 0.505, style.width * 0.18, style.height * 0.105, 0.07);
        set(meshes.tail, slot * 2 + part, side * style.width * 0.31, style.height * 0.47, -style.length * 0.505, style.width * 0.2, style.height * 0.095, 0.06);
      }
      stats.detailed += 1;
    } else {
      for (let part = 0; part < 4; part += 1) {
        setEmpty(meshes.wheel, slot * 4 + part);
        setEmpty(meshes.hub, slot * 4 + part);
      }
      for (let part = 0; part < 2; part += 1) {
        setEmpty(meshes.head, slot * 2 + part);
        setEmpty(meshes.tail, slot * 2 + part);
      }
    }
    // Instanced body paint remains shared: one material, per-instance color.
    meshes.body.setColorAt(slot, color);
    meshes.deck.setColorAt(slot * 2, color);
    meshes.deck.setColorAt(slot * 2 + 1, color);
    stats.active += 1;
  }

  function flush() {
    for (const mesh of Object.values(meshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  function attach(nextRecords = []) {
    disposeAttachments();
    const valid = Array.from(nextRecords).filter((record) => vehicleRoot(record));
    stats.dropped = Math.max(0, valid.length - maxVehicles);
    for (let index = 0; index < Math.min(maxVehicles, valid.length); index += 1) {
      const record = valid[index];
      const source = vehicleRoot(record);
      records.push({ record, source, wasVisible: source.visible, color: vehicleColor(record, index), fade: 1, detail: false });
      source.visible = false;
      source.userData.heroTrafficPresentation = true;
    }
    stats.attached = records.length;
    clearInstanceRange();
    return api;
  }

  function update({ camera = null, hero = null } = {}) {
    const cameraPosition = camera?.isObject3D ? camera.getWorldPosition(new THREE.Vector3()) : camera?.position || camera || null;
    const heroPosition = hero?.isObject3D ? hero.getWorldPosition(new THREE.Vector3()) : hero?.position || hero || null;
    group.updateWorldMatrix(true, false);
    presentationParentInverse.copy(group.matrixWorld).invert();
    stats.active = 0;
    stats.excluded = 0;
    stats.detailed = 0;
    for (let slot = 0; slot < records.length; slot += 1) populate(slot, records[slot], cameraPosition, heroPosition);
    flush();
    return { ...stats };
  }

  function disposeAttachments() {
    for (const entry of records) {
      entry.source.visible = entry.wasVisible;
      delete entry.source.userData.heroTrafficPresentation;
    }
    records.length = 0;
    stats.attached = 0;
  }

  function dispose() {
    disposeAttachments();
    group.removeFromParent();
    Object.values(meshes).forEach((mesh) => mesh.geometry.dispose());
    [bodyMaterial, glassMaterial, tireMaterial, hubMaterial, headMaterial, tailMaterial, shadowMaterial].forEach((material) => material.dispose());
  }

  const api = Object.freeze({ attach, update, dispose, getStats: () => ({ ...stats }), group });
  return api;
}
