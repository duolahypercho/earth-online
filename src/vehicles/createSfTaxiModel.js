// createSfTaxiModel.js — img2threejs reconstruction from
// assets/vehicles/sf-taxi-theme-polished.png
//
// Low-poly, polished SF taxi for Earth Online Chapter 01.
// Coordinate frame matches traffic.js: +Y up, +Z forward, +X right.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const COL = {
  body: 0xffc324,
  glass: 0x2a3340,
  rubber: 0x14161a,
  trim: 0x2c2a24,
  signFace: 0xfff0a8,
  headlight: 0xfff2c8,
  taillight: 0xd63a32,
  hub: 0x3a3d44,
};

/**
 * @param {{ castShadow?: boolean, receiveShadow?: boolean, scale?: number }} [options]
 * @returns {THREE.Group}
 */
export function createSfTaxiModel(options = {}) {
  const castShadow = options.castShadow ?? true;
  const receiveShadow = options.receiveShadow ?? true;
  const scale = options.scale ?? 1;

  const root = new THREE.Group();
  root.name = 'SF Taxi';

  const nodes = {};
  const meshes = {};

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: COL.body,
    roughness: 0.34,
    metalness: 0.16,
    clearcoat: 0.42,
    clearcoatRoughness: 0.18,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: COL.glass,
    roughness: 0.12,
    metalness: 0.04,
    transmission: 0.18,
    thickness: 0.2,
    transparent: true,
    opacity: 0.92,
  });
  const rubberMat = new THREE.MeshStandardMaterial({
    color: COL.rubber,
    roughness: 0.92,
    metalness: 0.02,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: COL.trim,
    roughness: 0.62,
    metalness: 0.08,
  });
  const hubMat = new THREE.MeshStandardMaterial({
    color: COL.hub,
    roughness: 0.48,
    metalness: 0.22,
  });
  const headlightMat = new THREE.MeshStandardMaterial({
    color: COL.headlight,
    emissive: COL.headlight,
    emissiveIntensity: 1.35,
    roughness: 0.35,
  });
  const taillightMat = new THREE.MeshStandardMaterial({
    color: COL.taillight,
    emissive: COL.taillight,
    emissiveIntensity: 0.95,
    roughness: 0.42,
  });
  const signMat = makeTaxiSignMaterial();

  const adopt = (mesh, name, parent = root) => {
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    parent.add(mesh);
    meshes[name] = mesh;
    return mesh;
  };

  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);
  nodes.body = body;

  // Main body slab
  adopt(
    new THREE.Mesh(new RoundedBoxGeometry(1.82, 0.62, 4.35, 0.1, 3), bodyMat),
    'bodyShell',
    body,
  ).position.set(0, 0.52, 0);

  // Hood / trunk decks
  adopt(
    new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.2, 1.15, 0.08, 2), bodyMat),
    'hood',
    body,
  ).position.set(0, 0.78, 1.45);
  adopt(
    new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.18, 0.95, 0.08, 2), bodyMat),
    'trunk',
    body,
  ).position.set(0, 0.76, -1.65);

  // Cabin (tapered prism)
  const cabinGeo = makeCabinGeometry();
  const cabin = new THREE.Mesh(cabinGeo, glassMat);
  cabin.scale.set(1.55, 0.58, 2.15);
  cabin.position.set(0, 1.18, -0.08);
  adopt(cabin, 'cabin', body);

  // Thin body pillars / roof rail suggestion
  for (const side of [-1, 1]) {
    adopt(
      new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 1.85), trimMat),
      side < 0 ? 'pillarL' : 'pillarR',
      body,
    ).position.set(side * 0.78, 1.12, -0.05);
  }

  // Bumper blocks
  adopt(
    new THREE.Mesh(new RoundedBoxGeometry(1.78, 0.22, 0.28, 0.06, 2), trimMat),
    'frontBumper',
    body,
  ).position.set(0, 0.28, 2.2);
  adopt(
    new THREE.Mesh(new RoundedBoxGeometry(1.78, 0.22, 0.26, 0.06, 2), trimMat),
    'rearBumper',
    body,
  ).position.set(0, 0.28, -2.18);

  // Lights
  for (const side of [-1, 1]) {
    adopt(
      new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.16, 0.1, 0.04, 2), headlightMat),
      side < 0 ? 'headlightL' : 'headlightR',
      body,
    ).position.set(side * 0.58, 0.52, 2.28);
    adopt(
      new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.14, 0.08, 0.03, 2), taillightMat),
      side < 0 ? 'taillightL' : 'taillightR',
      body,
    ).position.set(side * 0.62, 0.62, -2.24);
  }

  // Roof TAXI sign
  const sign = new THREE.Mesh(new RoundedBoxGeometry(0.58, 0.18, 0.34, 0.04, 2), signMat);
  sign.position.set(0, 1.62, -0.05);
  adopt(sign, 'taxiSign', body);

  // Wheels
  const wheelGroup = new THREE.Group();
  wheelGroup.name = 'wheels';
  root.add(wheelGroup);
  nodes.wheels = wheelGroup;

  const wheelPositions = [
    ['wheelFL', -0.82, 0.33, 1.35],
    ['wheelFR', 0.82, 0.33, 1.35],
    ['wheelRL', -0.82, 0.33, -1.35],
    ['wheelRR', 0.82, 0.33, -1.35],
  ];
  for (const [name, x, y, z] of wheelPositions) {
    const pivot = new THREE.Group();
    pivot.name = `${name}Pivot`;
    pivot.position.set(x, y, z);
    wheelGroup.add(pivot);
    nodes[`${name}Pivot`] = pivot;

    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 20), rubberMat);
    tire.rotation.z = Math.PI / 2;
    adopt(tire, name, pivot);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.23, 16), hubMat);
    hub.rotation.z = Math.PI / 2;
    adopt(hub, `${name}Hub`, pivot);
  }

  // Ground shadow disc (presentation only)
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.55, 32),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  shadow.name = 'contactShadow';
  root.add(shadow);
  meshes.contactShadow = shadow;

  root.scale.setScalar(scale);
  root.userData.sculptRuntime = {
    nodes,
    meshes,
    sockets: {
      driver: makeSocket(root, 'socketDriver', -0.42, 0.95, 0.15),
      roofSign: makeSocket(root, 'socketRoofSign', 0, 1.72, -0.05),
    },
    sourceImage: 'assets/vehicles/sf-taxi-theme-polished.png',
    pipeline: 'img2threejs',
  };

  let spin = 0;
  root.userData.tick = (dt = 0.016) => {
    spin += dt * 2.4;
    for (const key of ['wheelFLPivot', 'wheelFRPivot', 'wheelRLPivot', 'wheelRRPivot']) {
      const pivot = nodes[key];
      if (pivot) pivot.rotation.x = spin;
    }
    root.position.y = Math.sin(spin * 0.55) * 0.008;
  };

  return root;
}

function makeSocket(parent, name, x, y, z) {
  const socket = new THREE.Object3D();
  socket.name = name;
  socket.position.set(x, y, z);
  parent.add(socket);
  return socket;
}

function makeCabinGeometry() {
  const frontInset = 0.2;
  const rearInset = 0.16;
  const halfRoof = 0.42;
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5,
    0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    -halfRoof, 0.5, -0.5 + rearInset,
    halfRoof, 0.5, -0.5 + rearInset,
    halfRoof, 0.5, 0.5 - frontInset,
    -halfRoof, 0.5, 0.5 - frontInset,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex([
    0, 1, 2, 0, 2, 3,
    0, 5, 1, 0, 4, 5,
    1, 6, 2, 1, 5, 6,
    2, 7, 3, 2, 6, 7,
    3, 4, 0, 3, 7, 4,
    4, 6, 5, 4, 7, 6,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

function makeTaxiSignMaterial() {
  if (typeof document === 'undefined') {
    return new THREE.MeshStandardMaterial({
      color: COL.signFace,
      emissive: 0xffe27a,
      emissiveIntensity: 0.55,
      roughness: 0.5,
    });
  }
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff0a8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#242018';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  ctx.fillStyle = '#1f1b14';
  ctx.font = '800 52px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TAXI', canvas.width * 0.5, canvas.height * 0.54);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    emissive: 0xffe27a,
    emissiveIntensity: 0.65,
    roughness: 0.5,
  });
}
