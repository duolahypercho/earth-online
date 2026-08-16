import * as THREE from 'three';

const DOOR_COLORS = Object.freeze({
  civic: '#355d72',
  hospitality: '#6f4a30',
  industrial: '#44515a',
  office: '#36556a',
  residential: '#654333',
  retail: '#7a3f34',
});

const ROOM_PALETTES = Object.freeze({
  civic: { wall: '#d8d2c4', accent: '#3d6170', floor: '#827568' },
  hospitality: { wall: '#e1d1bd', accent: '#7f4b35', floor: '#715b4e' },
  industrial: { wall: '#b9b8b1', accent: '#4c5558', floor: '#666865' },
  office: { wall: '#d6d8d4', accent: '#466476', floor: '#6d7478' },
  residential: { wall: '#ddd0bb', accent: '#73513d', floor: '#786354' },
  retail: { wall: '#e2d4c3', accent: '#8b4438', floor: '#78675a' },
});

const INTERIOR_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const INTERIOR_PANEL_GEOMETRY = new THREE.BoxGeometry(1.6, 0.06, 0.5);

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.04, ...options });
}

function addBox(group, materialCache, {
  name,
  size,
  position,
  color,
  roughness,
  metalness,
  emissive,
  emissiveIntensity,
}) {
  const surface = material(color, { roughness, metalness, emissive, emissiveIntensity });
  const mesh = new THREE.Mesh(INTERIOR_BOX_GEOMETRY, surface);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.scale.set(size[0], size[1], size[2]);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);
  materialCache.push(surface);
  return mesh;
}

function seededUnit(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

export function installBuildingPortals(renderer, portals) {
  if (!renderer?.root || !portals.length) return null;
  const group = new THREE.Group();
  group.name = 'building-portals';
  group.userData = { kind: 'building-portals', portalCount: portals.length };

  const panelGeometry = new THREE.BoxGeometry(1, 2.05, 0.12);
  const panelMaterial = material('#ffffff', { roughness: 0.54, metalness: 0.08 });
  const panels = new THREE.InstancedMesh(panelGeometry, panelMaterial, portals.length);
  panels.name = 'building-portal-panels';
  panels.castShadow = true;
  panels.receiveShadow = true;

  const frameGeometry = new THREE.BoxGeometry(1, 1, 1);
  const frameMaterial = material('#c3b59c', { roughness: 0.48, metalness: 0.16 });
  const frames = new THREE.InstancedMesh(frameGeometry, frameMaterial, portals.length * 3);
  frames.name = 'building-portal-frames';
  frames.castShadow = true;

  const lightGeometry = new THREE.BoxGeometry(0.42, 0.11, 0.08);
  const lightMaterial = new THREE.MeshStandardMaterial({
    color: '#ffd9a1',
    emissive: '#ffb65d',
    emissiveIntensity: 0.42,
    roughness: 0.34,
    metalness: 0.08,
  });
  const lights = new THREE.InstancedMesh(lightGeometry, lightMaterial, portals.length);
  lights.name = 'building-portal-lights';

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let frameIndex = 0;
  portals.forEach((portal, index) => {
    const y = (renderer.terrain?.heightAt ? renderer.terrain.heightAt(portal.position.x, portal.position.z) : 0) + 1.04;
    portal.position.y = y - 1.04;
    portal.approach.y = (renderer.terrain?.heightAt
      ? renderer.terrain.heightAt(portal.approach.x, portal.approach.z)
      : 0);
    dummy.position.set(portal.position.x, y, portal.position.z);
    dummy.rotation.set(0, portal.heading, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    panels.setMatrixAt(index, dummy.matrix);
    color.set(DOOR_COLORS[portal.interior.archetype] || DOOR_COLORS.residential);
    panels.setColorAt(index, color);

    for (const [offsetX, offsetY, scaleX, scaleY] of [
      [-0.59, 0, 0.12, 2.24],
      [0.59, 0, 0.12, 2.24],
      [0, 1.075, 1.3, 0.11],
    ]) {
      dummy.position.set(portal.position.x, y, portal.position.z);
      dummy.rotation.set(0, portal.heading, 0);
      dummy.translateX(offsetX);
      dummy.translateY(offsetY);
      dummy.translateZ(-0.025);
      dummy.scale.set(scaleX, scaleY, 0.18);
      dummy.updateMatrix();
      frames.setMatrixAt(frameIndex, dummy.matrix);
      frameIndex += 1;
    }

    dummy.position.set(portal.position.x, y + 1.38, portal.position.z);
    dummy.rotation.set(0, portal.heading, 0);
    dummy.translateZ(-0.1);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    lights.setMatrixAt(index, dummy.matrix);
  });
  for (const mesh of [panels, frames, lights]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere?.();
    group.add(mesh);
  }
  renderer.root.add(group);
  return group;
}

export function createStreamedInterior(renderer, portal, cityBounds) {
  const descriptor = portal.interior.rooms[0];
  const width = THREE.MathUtils.clamp(Number(descriptor.width) || 11, 8, 18);
  const depth = THREE.MathUtils.clamp(Number(descriptor.depth) || 15, 10, 24);
  const height = 3.45;
  const anchor = {
    x: Number(cityBounds?.maxX || 0) + 260,
    y: 18,
    z: Number(cityBounds?.maxZ || 0) + 260,
  };
  const group = new THREE.Group();
  group.name = 'active-building-interior';
  group.userData = {
    kind: 'streamed-building-interior',
    buildingId: portal.buildingId,
    portalId: portal.id,
    roomId: descriptor.id,
  };
  const materials = [];
  const palette = ROOM_PALETTES[portal.interior.archetype] || ROOM_PALETTES.residential;
  const add = (options) => addBox(group, materials, options);

  add({ name: 'interior-floor', size: [width, 0.18, depth], position: [anchor.x, anchor.y - 0.09, anchor.z], color: palette.floor, roughness: 0.64, metalness: 0.02 });
  add({ name: 'interior-ceiling', size: [width, 0.16, depth], position: [anchor.x, anchor.y + height, anchor.z], color: '#dedbd3', roughness: 0.9, metalness: 0 });
  add({ name: 'interior-back-wall', size: [width, height, 0.18], position: [anchor.x, anchor.y + height / 2, anchor.z - depth / 2], color: palette.wall, roughness: 0.82, metalness: 0 });
  add({ name: 'interior-left-wall', size: [0.18, height, depth], position: [anchor.x - width / 2, anchor.y + height / 2, anchor.z], color: palette.wall, roughness: 0.82, metalness: 0 });
  add({ name: 'interior-right-wall', size: [0.18, height, depth], position: [anchor.x + width / 2, anchor.y + height / 2, anchor.z], color: palette.wall, roughness: 0.82, metalness: 0 });
  const frontSection = Math.max(1.2, (width - 1.8) / 2);
  add({ name: 'interior-front-left', size: [frontSection, height, 0.18], position: [anchor.x - (width + 1.8) / 4, anchor.y + height / 2, anchor.z + depth / 2], color: palette.wall, roughness: 0.82, metalness: 0 });
  add({ name: 'interior-front-right', size: [frontSection, height, 0.18], position: [anchor.x + (width + 1.8) / 4, anchor.y + height / 2, anchor.z + depth / 2], color: palette.wall, roughness: 0.82, metalness: 0 });
  add({ name: 'interior-door-header', size: [1.8, height - 2.35, 0.18], position: [anchor.x, anchor.y + 2.35 + (height - 2.35) / 2, anchor.z + depth / 2], color: palette.accent, roughness: 0.58, metalness: 0.05 });

  const counterWidth = Math.min(width * 0.52, 6.8);
  const counterDepth = portal.interior.archetype === 'retail' ? 1.05 : 0.72;
  add({ name: 'interior-counter', size: [counterWidth, 1.02, counterDepth], position: [anchor.x, anchor.y + 0.51, anchor.z - depth * 0.23], color: palette.accent, roughness: 0.52, metalness: 0.1 });
  add({ name: 'interior-counter-top', size: [counterWidth + 0.22, 0.1, counterDepth + 0.18], position: [anchor.x, anchor.y + 1.07, anchor.z - depth * 0.23], color: '#2f3030', roughness: 0.32, metalness: 0.18 });

  const artOffset = (seededUnit(portal.id) - 0.5) * Math.max(0, width - 4);
  add({ name: 'interior-wall-art', size: [2.2, 1.15, 0.08], position: [anchor.x + artOffset, anchor.y + 2.0, anchor.z - depth / 2 + 0.13], color: palette.accent, roughness: 0.45, metalness: 0.03 });

  const panelMaterial = new THREE.MeshStandardMaterial({
    color: '#fff4dc', emissive: '#ffe3ad', emissiveIntensity: 0.82, roughness: 0.45, metalness: 0,
  });
  materials.push(panelMaterial);
  const lightCount = Math.max(2, Math.floor(depth / 5));
  const panels = new THREE.InstancedMesh(INTERIOR_PANEL_GEOMETRY, panelMaterial, lightCount);
  panels.name = 'interior-ceiling-panels';
  const dummy = new THREE.Object3D();
  for (let index = 0; index < lightCount; index += 1) {
    dummy.position.set(anchor.x, anchor.y + height - 0.12, anchor.z - depth * 0.32 + index * (depth * 0.64 / Math.max(1, lightCount - 1)));
    dummy.updateMatrix();
    panels.setMatrixAt(index, dummy.matrix);
  }
  panels.instanceMatrix.needsUpdate = true;
  group.add(panels);

  group.userData.dispose = () => {
    for (const surface of materials) surface.dispose();
  };
  renderer.root.add(group);
  return {
    group,
    floorY: anchor.y,
    spawn: { x: anchor.x, z: anchor.z + depth / 2 - 2.1, yaw: Math.PI, pitch: -0.08 },
    bounds: {
      minX: anchor.x - width / 2 + 0.45,
      maxX: anchor.x + width / 2 - 0.45,
      minZ: anchor.z - depth / 2 + 0.45,
      maxZ: anchor.z + depth / 2 - 0.45,
    },
    meshes: group.children.filter((child) => child.isMesh).length,
  };
}

export function disposeStreamedInterior(renderer, active) {
  if (!active?.group) return;
  active.group.parent?.remove(active.group);
  active.group.userData.dispose?.();
}
