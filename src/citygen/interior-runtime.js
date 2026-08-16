import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

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
const INTERIOR_ROUNDED_GEOMETRY = new RoundedBoxGeometry(1, 1, 1, 3, 0.08);
const INTERIOR_CYLINDER_GEOMETRY = new THREE.CylinderGeometry(0.5, 0.42, 1, 12);
const INTERIOR_SPHERE_GEOMETRY = new THREE.SphereGeometry(0.5, 12, 8);
const INTERIOR_PLANE_GEOMETRY = new THREE.PlaneGeometry(1, 1);
const INTERIOR_SHADOW_GEOMETRY = new THREE.CircleGeometry(0.5, 24);

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.04, ...options });
}

function addBox(group, {
  name,
  category,
  size,
  position,
  surface,
  rounded = false,
  rotation = null,
}) {
  const mesh = new THREE.Mesh(rounded ? INTERIOR_ROUNDED_GEOMETRY : INTERIOR_BOX_GEOMETRY, surface);
  mesh.name = name;
  mesh.userData.category = category;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.scale.set(size[0], size[1], size[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);
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
    const y = portal.position.y + 1.04;
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

function createSurfaceTexture(seedText, kind) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const seed = Math.floor(seededUnit(`${seedText}:${kind}`) * 0xffffffff) >>> 0;
  let value = seed || 1;
  const random = () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0xffffffff;
  };
  if (kind === 'marble') {
    context.fillStyle = '#c2b8a8';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 20; index += 1) {
      context.strokeStyle = `rgba(231,220,201,${0.08 + random() * 0.14})`;
      context.lineWidth = 0.5 + random() * 1.2;
      context.beginPath();
      const startY = random() * 128;
      context.moveTo(-8, startY);
      context.bezierCurveTo(36, startY - 18 + random() * 36, 78, startY - 16 + random() * 32, 136, startY + (random() - 0.5) * 28);
      context.stroke();
    }
    context.strokeStyle = 'rgba(69,61,53,0.12)';
    context.lineWidth = 1;
    for (let line = 0; line <= 128; line += 32) {
      context.beginPath();
      context.moveTo(line, 0);
      context.lineTo(line, 128);
      context.stroke();
      context.beginPath();
      context.moveTo(0, line);
      context.lineTo(128, line);
      context.stroke();
    }
  } else if (kind === 'wood') {
    context.fillStyle = '#70402d';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 32; index += 1) {
      const y = index * 4 + random() * 2;
      context.strokeStyle = `rgba(239,179,118,${0.035 + random() * 0.08})`;
      context.beginPath();
      context.moveTo(0, y);
      context.bezierCurveTo(36, y - 2 + random() * 4, 84, y - 2 + random() * 4, 128, y);
      context.stroke();
    }
  } else if (kind === 'fabric') {
    context.fillStyle = '#31525e';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 64; index += 2) {
      context.strokeStyle = 'rgba(210,229,226,0.045)';
      context.beginPath();
      context.moveTo(index, 0);
      context.lineTo(index, 128);
      context.stroke();
      context.beginPath();
      context.moveTo(0, index);
      context.lineTo(128, index);
      context.stroke();
    }
  } else if (kind === 'stone') {
    context.fillStyle = '#3d3b38';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 850; index += 1) {
      const shade = 74 + Math.floor(random() * 42);
      context.fillStyle = `rgba(${shade},${shade - 2},${shade - 5},0.24)`;
      context.fillRect(random() * 128, random() * 128, 1.2, 1.2);
    }
  } else if (kind === 'rug') {
    context.fillStyle = '#6e342f';
    context.fillRect(0, 0, 128, 128);
    context.strokeStyle = 'rgba(224,177,132,0.16)';
    context.lineWidth = 2;
    context.strokeRect(8, 8, 112, 112);
    context.strokeRect(14, 14, 100, 100);
    for (let index = 0; index < 420; index += 1) {
      context.fillStyle = `rgba(236,205,177,${0.025 + random() * 0.04})`;
      context.fillRect(random() * 128, random() * 128, 1, 1);
    }
  } else {
    context.fillStyle = '#d8d0c2';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 1800; index += 1) {
      const shade = Math.floor(178 + random() * 36);
      context.fillStyle = `rgba(${shade},${shade - 5},${shade - 12},0.08)`;
      context.fillRect(random() * 128, random() * 128, 1, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const repeat = kind === 'marble' ? [4, 6] : kind === 'wood' ? [3, 3] : kind === 'fabric' ? [5, 5] : [3, 3];
  texture.repeat.set(repeat[0], repeat[1]);
  texture.anisotropy = 4;
  return texture;
}

function createSignTexture(portal) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const context = canvas.getContext('2d');
  context.fillStyle = '#172129';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#bd9760';
  context.lineWidth = 5;
  context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  context.fillStyle = '#f3e5ca';
  context.textAlign = 'center';
  context.font = '600 24px system-ui, sans-serif';
  context.fillText('SAN FRANCISCO', 256, 56);
  context.fillStyle = '#bd9760';
  context.font = '700 34px system-ui, sans-serif';
  const label = String(portal.label || portal.street?.name || 'CITY LOBBY').toUpperCase().slice(0, 27);
  context.fillText(label, 256, 112, 454);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function createSfArtTexture(seedText) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 192;
  const context = canvas.getContext('2d');
  const warm = seededUnit(seedText) > 0.5;
  context.fillStyle = warm ? '#b44a35' : '#315d70';
  context.fillRect(0, 0, 256, 192);
  context.fillStyle = '#f0d4a1';
  context.fillRect(0, 144, 256, 48);
  context.strokeStyle = '#f5e3bd';
  context.lineWidth = 7;
  context.beginPath();
  context.moveTo(42, 150);
  context.lineTo(42, 40);
  context.moveTo(214, 150);
  context.lineTo(214, 40);
  context.moveTo(28, 74);
  context.bezierCurveTo(84, 118, 172, 118, 228, 74);
  context.stroke();
  context.lineWidth = 3;
  for (let x = 52; x < 214; x += 20) {
    context.beginPath();
    context.moveTo(x, 94 + Math.abs(133 - x) * 0.18);
    context.lineTo(x, 150);
    context.stroke();
  }
  context.fillStyle = '#172129';
  context.font = '700 18px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText('THE CITY BY THE BAY', 128, 177);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function createStreamedInterior(renderer, portal, cityBounds) {
  const descriptor = portal.interior.rooms[0];
  const width = THREE.MathUtils.clamp(Number(descriptor.width) || 13, 11, 16);
  const depth = THREE.MathUtils.clamp(Number(descriptor.depth) || 17, 14, 22);
  const height = 4.15;
  const anchor = {
    x: Number(cityBounds?.maxX || 0) + 260,
    y: 18,
    z: Number(cityBounds?.maxZ || 0) + 260,
  };
  const group = new THREE.Group();
  group.name = 'active-building-interior';
  const materials = new Set();
  const textures = [
    createSurfaceTexture(portal.id, 'marble'),
    createSurfaceTexture(portal.id, 'plaster'),
    createSurfaceTexture(portal.id, 'wood'),
    createSurfaceTexture(portal.id, 'fabric'),
    createSurfaceTexture(portal.id, 'stone'),
    createSurfaceTexture(portal.id, 'rug'),
    createSignTexture(portal),
    createSfArtTexture(portal.id),
  ];
  const makeMaterial = (color, options = {}) => {
    const surface = material(color, options);
    materials.add(surface);
    return surface;
  };
  const palette = ROOM_PALETTES[portal.interior.archetype] || ROOM_PALETTES.residential;
  const surfaces = {
    floor: makeMaterial('#b5a28c', { map: textures[0], roughness: 0.3, metalness: 0.04 }),
    wall: makeMaterial(palette.wall, { map: textures[1], roughness: 0.84, metalness: 0 }),
    ceiling: makeMaterial('#f4efe6', { emissive: '#ffffff', emissiveIntensity: 0.3, roughness: 0.9, metalness: 0 }),
    trim: makeMaterial('#30383c', { roughness: 0.42, metalness: 0.38 }),
    wood: makeMaterial('#f4dfc9', { map: textures[2], bumpMap: textures[2], bumpScale: 0.025, roughness: 0.38, metalness: 0.04 }),
    stone: makeMaterial('#d8d3cb', { map: textures[4], bumpMap: textures[4], bumpScale: 0.018, roughness: 0.24, metalness: 0.08 }),
    glass: makeMaterial('#8fc1ca', { transparent: true, opacity: 0.28, depthWrite: false, roughness: 0.08, metalness: 0.08 }),
    brass: makeMaterial('#b68a49', { roughness: 0.26, metalness: 0.72 }),
    fabric: makeMaterial('#e0edf0', { map: textures[3], bumpMap: textures[3], bumpScale: 0.035, roughness: 0.92, metalness: 0 }),
    rug: makeMaterial('#f0d5d0', { map: textures[5], bumpMap: textures[5], bumpScale: 0.025, roughness: 0.96, metalness: 0 }),
    foliage: makeMaterial('#355c43', { roughness: 0.82, metalness: 0 }),
    terracotta: makeMaterial('#8b5441', { roughness: 0.78, metalness: 0 }),
    safety: makeMaterial('#a63a32', { roughness: 0.48, metalness: 0.1 }),
    light: makeMaterial('#fff1c9', { emissive: '#ffd08a', emissiveIntensity: 1.2, roughness: 0.32, metalness: 0 }),
    sign: makeMaterial('#ffffff', { map: textures[6], emissive: '#6a5333', emissiveIntensity: 0.18, roughness: 0.38, metalness: 0.06 }),
    art: makeMaterial('#ffffff', { map: textures[7], roughness: 0.5, metalness: 0.02 }),
    screen: makeMaterial('#182a32', { emissive: '#68a4b5', emissiveIntensity: 0.34, roughness: 0.18, metalness: 0.12 }),
  };
  const add = (options) => addBox(group, options);
  const addInstances = (name, category, surface, records, rounded = false) => {
    const mesh = new THREE.InstancedMesh(rounded ? INTERIOR_ROUNDED_GEOMETRY : INTERIOR_BOX_GEOMETRY, surface, records.length);
    mesh.name = name;
    mesh.userData.category = category;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const instance = new THREE.Object3D();
    records.forEach((record, index) => {
      instance.position.set(record.position[0], record.position[1], record.position[2]);
      instance.rotation.set(...(record.rotation || [0, 0, 0]));
      instance.scale.set(record.size[0], record.size[1], record.size[2]);
      instance.updateMatrix();
      mesh.setMatrixAt(index, instance.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    return mesh;
  };

  add({ name: 'lobby-floor-marble', category: 'floor', size: [width, 0.18, depth], position: [anchor.x, anchor.y - 0.09, anchor.z], surface: surfaces.floor });
  add({ name: 'lobby-coffered-ceiling', category: 'ceiling', size: [width, 0.14, depth], position: [anchor.x, anchor.y + height, anchor.z], surface: surfaces.ceiling });
  add({ name: 'lobby-back-wall', category: 'wall', size: [width, height, 0.18], position: [anchor.x, anchor.y + height / 2, anchor.z - depth / 2], surface: surfaces.wall });
  add({ name: 'lobby-left-wall', category: 'wall', size: [0.18, height, depth], position: [anchor.x - width / 2, anchor.y + height / 2, anchor.z], surface: surfaces.wall });
  add({ name: 'lobby-right-wall', category: 'wall', size: [0.18, height, depth], position: [anchor.x + width / 2, anchor.y + height / 2, anchor.z], surface: surfaces.wall });
  const frontSection = Math.max(1.2, (width - 6.2) / 2);
  add({ name: 'lobby-front-left', category: 'entrance', size: [frontSection, height, 0.18], position: [anchor.x - (width + 6.2) / 4, anchor.y + height / 2, anchor.z + depth / 2], surface: surfaces.wall });
  add({ name: 'lobby-front-right', category: 'entrance', size: [frontSection, height, 0.18], position: [anchor.x + (width + 6.2) / 4, anchor.y + height / 2, anchor.z + depth / 2], surface: surfaces.wall });

  add({ name: 'lobby-baseboard-back', category: 'trim', size: [width - 0.2, 0.18, 0.1], position: [anchor.x, anchor.y + 0.09, anchor.z - depth / 2 + 0.13], surface: surfaces.trim });
  add({ name: 'lobby-baseboard-left', category: 'trim', size: [0.1, 0.18, depth - 0.2], position: [anchor.x - width / 2 + 0.13, anchor.y + 0.09, anchor.z], surface: surfaces.trim });
  add({ name: 'lobby-baseboard-right', category: 'trim', size: [0.1, 0.18, depth - 0.2], position: [anchor.x + width / 2 - 0.13, anchor.y + 0.09, anchor.z], surface: surfaces.trim });
  addInstances('lobby-back-wall-pilasters', 'architecture', surfaces.brass, [
    { position: [anchor.x + width * 0.12, anchor.y + height / 2, anchor.z - depth / 2 + 0.18], size: [0.16, height - 0.22, 0.16] },
    { position: [anchor.x + width * 0.47, anchor.y + height / 2, anchor.z - depth / 2 + 0.18], size: [0.16, height - 0.22, 0.16] },
  ], true);
  addInstances('lobby-ceiling-coffers', 'ceiling', surfaces.wood, [
    { position: [anchor.x - width * 0.28, anchor.y + height - 0.13, anchor.z - depth * 0.1], size: [0.075, 0.1, depth * 0.56] },
    { position: [anchor.x + width * 0.28, anchor.y + height - 0.13, anchor.z - depth * 0.1], size: [0.075, 0.1, depth * 0.56] },
    { position: [anchor.x, anchor.y + height - 0.13, anchor.z - depth * 0.28], size: [width * 0.62, 0.1, 0.075] },
    { position: [anchor.x, anchor.y + height - 0.13, anchor.z + depth * 0.08], size: [width * 0.62, 0.1, 0.075] },
  ], true);

  const doorZ = anchor.z + depth / 2 - 0.08;
  add({ name: 'lobby-glass-left', category: 'glass', size: [1.45, 2.9, 0.06], position: [anchor.x - 2.25, anchor.y + 1.48, doorZ], surface: surfaces.glass });
  add({ name: 'lobby-glass-right', category: 'glass', size: [1.45, 2.9, 0.06], position: [anchor.x + 2.25, anchor.y + 1.48, doorZ], surface: surfaces.glass });
  add({ name: 'lobby-door-left', category: 'door', size: [1.35, 2.65, 0.08], position: [anchor.x - 0.7, anchor.y + 1.34, doorZ], surface: surfaces.glass });
  add({ name: 'lobby-door-right', category: 'door', size: [1.35, 2.65, 0.08], position: [anchor.x + 0.7, anchor.y + 1.34, doorZ], surface: surfaces.glass });
  add({ name: 'lobby-door-transom', category: 'door', size: [6.2, 0.14, 0.13], position: [anchor.x, anchor.y + 3.0, doorZ], surface: surfaces.brass, rounded: true });

  const deskX = anchor.x - width * 0.17;
  const deskZ = anchor.z - depth * 0.25;
  add({ name: 'lobby-reception-desk', category: 'reception', size: [5.2, 1.02, 0.86], position: [deskX, anchor.y + 0.51, deskZ], surface: surfaces.wood, rounded: true });
  add({ name: 'lobby-reception-counter', category: 'reception', size: [5.5, 0.11, 1.05], position: [deskX, anchor.y + 1.08, deskZ], surface: surfaces.stone, rounded: true });
  add({ name: 'lobby-reception-plinth', category: 'reception', size: [3.0, 0.18, 0.98], position: [deskX, anchor.y + 0.09, deskZ], surface: surfaces.brass, rounded: true });
  for (const side of [-1, 1]) {
    add({ name: `lobby-reception-terminal-${side}`, category: 'equipment', size: [0.62, 0.46, 0.12], position: [deskX + side * 1.2, anchor.y + 1.38, deskZ - 0.24], surface: surfaces.screen, rounded: true });
  }

  const sign = new THREE.Mesh(INTERIOR_PLANE_GEOMETRY, surfaces.sign);
  sign.name = 'lobby-san-francisco-sign';
  sign.userData.category = 'signage';
  sign.position.set(deskX, anchor.y + 2.55, anchor.z - depth / 2 + 0.11);
  sign.scale.set(4.6, 1.35, 1);
  group.add(sign);
  addInstances('lobby-elevator-doors', 'elevator', surfaces.trim, [
    { position: [anchor.x + width * 0.25, anchor.y + 1.28, anchor.z - depth / 2 + 0.12], size: [1.5, 2.55, 0.1] },
    { position: [anchor.x + width * 0.4, anchor.y + 1.28, anchor.z - depth / 2 + 0.12], size: [1.5, 2.55, 0.1] },
    { position: [anchor.x + width * 0.25, anchor.y + 2.68, anchor.z - depth / 2 + 0.14], size: [1.66, 0.12, 0.14] },
    { position: [anchor.x + width * 0.4, anchor.y + 2.68, anchor.z - depth / 2 + 0.14], size: [1.66, 0.12, 0.14] },
  ], true);

  const sofaZ = anchor.z + depth * 0.06;
  const sofaCenters = [-1, 1].map((side) => anchor.x + side * width * 0.29);
  addInstances('lobby-sofa-frames', 'seating', surfaces.fabric, sofaCenters.flatMap((x) => [
    { position: [x, anchor.y + 0.34, sofaZ], size: [2.65, 0.38, 0.94] },
    { position: [x, anchor.y + 0.88, sofaZ + 0.35], size: [2.65, 0.78, 0.24] },
  ]), true);
  addInstances('lobby-sofa-arms', 'seating', surfaces.fabric, sofaCenters.flatMap((x) => [-1, 1].map((side) => ({
    position: [x + side * 1.24, anchor.y + 0.62, sofaZ], size: [0.2, 0.62, 0.94],
  }))), true);
  addInstances('lobby-sofa-cushions', 'seating', surfaces.fabric, sofaCenters.flatMap((x) => [-1, 1].map((side) => ({
    position: [x + side * 0.62, anchor.y + 0.57, sofaZ - 0.03], size: [1.14, 0.2, 0.78],
  }))), true);
  addInstances('lobby-sofa-legs', 'seating', surfaces.brass, sofaCenters.flatMap((x) => [-1, 1].flatMap((sideX) => [-1, 1].map((sideZ) => ({
    position: [x + sideX * 1.12, anchor.y + 0.12, sofaZ + sideZ * 0.32], size: [0.08, 0.24, 0.08],
  })))), true);
  const tableCenters = [-1, 1].map((side) => anchor.x + side * width * 0.13);
  addInstances('lobby-table-tops', 'table', surfaces.stone, tableCenters.map((x) => ({
    position: [x, anchor.y + 0.42, sofaZ - 0.1], size: [1.25, 0.12, 0.72],
  })), true);
  addInstances('lobby-table-pedestals', 'table', surfaces.brass, tableCenters.map((x) => ({
    position: [x, anchor.y + 0.21, sofaZ - 0.1], size: [0.16, 0.42, 0.16],
  })), true);
  add({ name: 'lobby-runner-rug', category: 'rug', size: [2.25, 0.035, Math.min(3.8, depth * 0.23)], position: [anchor.x - width * 0.04, anchor.y + 0.02, anchor.z + depth * 0.17], surface: surfaces.rug, rounded: true });

  const addPlant = (side) => {
    const pot = new THREE.Mesh(INTERIOR_CYLINDER_GEOMETRY, surfaces.terracotta);
    pot.name = `lobby-planter-${side}`;
    pot.userData.category = 'greenery';
    pot.position.set(anchor.x + side * width * 0.4, anchor.y + 0.46, anchor.z - depth * 0.34);
    pot.scale.set(0.76, 0.9, 0.76);
    pot.castShadow = true;
    group.add(pot);
    const foliage = new THREE.Mesh(INTERIOR_SPHERE_GEOMETRY, surfaces.foliage);
    foliage.name = `lobby-foliage-${side}`;
    foliage.userData.category = 'greenery';
    foliage.position.set(pot.position.x, anchor.y + 1.35, pot.position.z);
    foliage.scale.set(1.05, 1.6, 1.05);
    foliage.castShadow = true;
    group.add(foliage);
  };
  addPlant(-1);
  addPlant(1);

  const artOffset = (seededUnit(portal.id) - 0.5) * 0.6;
  const art = new THREE.InstancedMesh(INTERIOR_PLANE_GEOMETRY, surfaces.art, 2);
  art.name = 'lobby-san-francisco-art';
  art.userData.category = 'decor';
  const artDummy = new THREE.Object3D();
  [-1, 1].forEach((side, index) => {
    artDummy.position.set(anchor.x + side * (width / 2 - 0.11), anchor.y + 2.15, anchor.z - depth * (0.1 + artOffset * 0.02));
    artDummy.rotation.set(0, side < 0 ? Math.PI / 2 : -Math.PI / 2, 0);
    artDummy.scale.set(1.7, 1.28, 1);
    artDummy.updateMatrix();
    art.setMatrixAt(index, artDummy.matrix);
  });
  art.instanceMatrix.needsUpdate = true;
  group.add(art);
  add({ name: 'lobby-fire-safety', category: 'safety', size: [0.24, 0.7, 0.2], position: [anchor.x - width / 2 + 0.28, anchor.y + 0.65, anchor.z - depth * 0.05], surface: surfaces.safety, rounded: true });

  const shadowMaterial = new THREE.MeshBasicMaterial({ color: '#17130f', transparent: true, opacity: 0.17, depthWrite: false });
  materials.add(shadowMaterial);
  const shadowSpots = [
    [anchor.x - width * 0.29, sofaZ, 3.2, 1.35],
    [anchor.x + width * 0.29, sofaZ, 3.2, 1.35],
    [anchor.x - width * 0.4, anchor.z - depth * 0.34, 1.45, 1.45],
    [anchor.x + width * 0.4, anchor.z - depth * 0.34, 1.45, 1.45],
    [deskX, deskZ, 5.4, 1.2],
  ];
  const contactShadows = new THREE.InstancedMesh(INTERIOR_SHADOW_GEOMETRY, shadowMaterial, shadowSpots.length);
  contactShadows.name = 'lobby-contact-shadows';
  contactShadows.userData.category = 'grounding';
  const shadowDummy = new THREE.Object3D();
  shadowSpots.forEach(([x, z, scaleX, scaleZ], index) => {
    shadowDummy.position.set(x, anchor.y + 0.012, z);
    shadowDummy.rotation.set(-Math.PI / 2, 0, 0);
    shadowDummy.scale.set(scaleX, scaleZ, 1);
    shadowDummy.updateMatrix();
    contactShadows.setMatrixAt(index, shadowDummy.matrix);
  });
  contactShadows.instanceMatrix.needsUpdate = true;
  group.add(contactShadows);

  const lightCount = 4;
  const fixtureRecords = Array.from({ length: lightCount }, (_, index) => ({
    position: [anchor.x + (index % 2 ? width * 0.22 : -width * 0.22), anchor.y + height - 0.1, anchor.z + (index < 2 ? depth * 0.2 : -depth * 0.2)],
    size: [1.82, 0.08, 0.68],
  }));
  addInstances('lobby-fixture-bezels', 'lighting', surfaces.trim, fixtureRecords, true);
  const panels = new THREE.InstancedMesh(INTERIOR_PANEL_GEOMETRY, surfaces.light, lightCount);
  panels.name = 'lobby-ceiling-fixtures';
  panels.userData.category = 'lighting';
  const dummy = new THREE.Object3D();
  for (let index = 0; index < lightCount; index += 1) {
    dummy.position.set(anchor.x + (index % 2 ? width * 0.22 : -width * 0.22), anchor.y + height - 0.12, anchor.z + (index < 2 ? depth * 0.2 : -depth * 0.2));
    dummy.updateMatrix();
    panels.setMatrixAt(index, dummy.matrix);
  }
  panels.instanceMatrix.needsUpdate = true;
  group.add(panels);
  for (let index = 0; index < lightCount; index += 1) {
    const light = new THREE.PointLight(0xffd7a2, 2.4, 10, 2);
    light.name = 'lobby-fixture-light';
    light.userData.category = 'lighting';
    light.position.set(anchor.x + (index % 2 ? width * 0.22 : -width * 0.22), anchor.y + height - 0.32, anchor.z + (index < 2 ? depth * 0.2 : -depth * 0.2));
    group.add(light);
  }
  const interiorFill = new THREE.HemisphereLight(0xfff4e7, 0x685a4b, 0.72);
  interiorFill.name = 'lobby-neutral-fill';
  interiorFill.userData.category = 'lighting';
  group.add(interiorFill);

  const propCategories = [...new Set(group.children.map((child) => child.userData.category).filter(Boolean))].sort();
  group.userData = {
    kind: 'streamed-building-interior',
    buildingId: portal.buildingId,
    portalId: portal.id,
    roomId: descriptor.id,
    archetype: portal.interior.archetype,
    propCategories,
    dispose: () => {
      for (const surface of materials) surface.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
  renderer.root.add(group);
  const lobbyView = {
    x: anchor.x - width * 0.18,
    z: anchor.z + depth / 2 - 5.35,
    yaw: Math.atan2(deskX - (anchor.x - width * 0.18), deskZ - (anchor.z + depth / 2 - 5.35)),
    pitch: -0.04,
  };
  const entranceView = {
    x: anchor.x + width * 0.15,
    z: anchor.z - depth / 2 + 4.8,
    yaw: Math.atan2(anchor.x - (anchor.x + width * 0.15), doorZ - (anchor.z - depth / 2 + 4.8)),
    pitch: -0.03,
  };
  return {
    group,
    floorY: anchor.y,
    spawn: lobbyView,
    views: { lobby: lobbyView, entrance: entranceView },
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
