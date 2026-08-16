import * as THREE from 'three';

// Shared low-poly geometry for all vehicles keeps the flat-shaded style
// while making the fleet cheap: meshes clone geometry but get their own
// emissive-capable materials (taillights, turn signals) so each car can
// animate independently.
const GEO = {
  wheel: new THREE.CylinderGeometry(0.3, 0.3, 0.24, 8),
  hub: new THREE.CylinderGeometry(0.13, 0.13, 0.26, 8),
};
GEO.wheel.rotateZ(Math.PI / 2);
GEO.hub.rotateZ(Math.PI / 2);

export const CAR_DIMENSIONS = {
  bus: { halfWidth: 1.05, frontZ: 3.9, rearZ: -3.9, length: 7.8 },
  truck: { halfWidth: 0.98, frontZ: 2.4, rearZ: -2.3, length: 4.6 },
  sedan: { halfWidth: 0.7, frontZ: 1.8, rearZ: -1.8, length: 3.6 },
  taxi: { halfWidth: 0.7, frontZ: 1.8, rearZ: -1.8, length: 3.6 },
};

function box(parent, w, h, d, material, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function addWheel(parent, x, z, hubMaterial) {
  const pivot = new THREE.Group();
  pivot.position.set(x, 0.3, z);
  const tire = new THREE.Mesh(GEO.wheel, parent.userData.wheelMaterial);
  const hub = new THREE.Mesh(GEO.hub, hubMaterial);
  pivot.add(tire, hub);
  parent.add(pivot);
  return pivot;
}

/**
 * Build a flat-shaded low-poly vehicle. Returns a group whose userData.rig
 * carries everything the traffic sim animates: body (suspension bob),
 * wheels (spin), taillights (brake intensity), and turn-signal emitters.
 */
export function buildVehicle(kind, color) {
  const group = new THREE.Group();
  const dims = CAR_DIMENSIONS[kind] || CAR_DIMENSIONS.sedan;
  const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.55, flatShading: true });
  const cabMaterial = new THREE.MeshStandardMaterial({ color: 0xb9d3e0, roughness: 0.2, metalness: 0.2, flatShading: true });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.85 });
  group.userData.wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
  const hubMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.55, metalness: 0.4, flatShading: true });
  const bodyGroup = new THREE.Group();
  group.add(bodyGroup);

  if (kind === 'bus') {
    box(bodyGroup, 2.35, 1.7, 7.8, bodyMaterial, 0, 1.05, 0);
    box(bodyGroup, 2.38, 0.35, 7.82, cabMaterial, 0, 1.02, 0);
  } else if (kind === 'truck') {
    box(bodyGroup, 2.1, 1.35, 4.6, bodyMaterial, 0, 0.92, 0);
    box(bodyGroup, 1.9, 0.8, 1.6, cabMaterial, 0, 1.18, 1.7);
  } else {
    const width = kind === 'taxi' ? 1.75 : 1.7;
    box(bodyGroup, width, 0.62, 3.6, bodyMaterial, 0, 0.62, 0);
    box(bodyGroup, width * 0.9, 0.5, 1.6, cabMaterial, 0, 1.12, -0.4);
    if (kind === 'taxi') box(bodyGroup, 0.6, 0.18, 0.34, darkMaterial, 0, 1.55, -0.4);
  }

  // Turn-signal emitters sit on the front and rear corners; emissive
  // intensity is driven per-frame by the traffic sim while cornering.
  // Vehicles face +z, so +x is the left side.
  const signalColor = 0xff9d2e;
  const turnSignals = { left: [], right: [] };
  for (const side of [1, -1]) {
    const frontMat = new THREE.MeshStandardMaterial({ color: signalColor, emissive: signalColor, emissiveIntensity: 0 });
    const rearMat = new THREE.MeshStandardMaterial({ color: signalColor, emissive: signalColor, emissiveIntensity: 0 });
    box(bodyGroup, 0.16, 0.12, 0.1, frontMat, side * (dims.halfWidth + 0.06), kind === 'bus' ? 1.0 : kind === 'truck' ? 1.2 : 0.5, dims.frontZ - 0.3);
    box(bodyGroup, 0.16, 0.12, 0.1, rearMat, side * (dims.halfWidth + 0.06), kind === 'bus' ? 1.0 : kind === 'truck' ? 1.2 : 0.5, dims.rearZ + 0.3);
    (side > 0 ? turnSignals.left : turnSignals.right).push(frontMat, rearMat);
  }

  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe9a8, emissiveIntensity: 0.4 });
  const taillightMat = new THREE.MeshStandardMaterial({ color: 0xff4433, emissive: 0xff2a1a, emissiveIntensity: 0.25 });
  for (const wx of [-dims.halfWidth, dims.halfWidth]) {
    box(bodyGroup, 0.28, 0.16, 0.08, headlightMat, wx, kind === 'bus' ? 1.0 : kind === 'truck' ? 1.25 : 0.55, dims.frontZ + 0.01);
    box(bodyGroup, 0.26, 0.12, 0.08, taillightMat, wx, kind === 'bus' ? 1.0 : kind === 'truck' ? 1.2 : 0.5, dims.rearZ);
  }

  const wheels = [];
  const positions = kind === 'bus'
    ? [[-1.05, 2.45], [1.05, 2.45], [-1.05, -2.45], [1.05, -2.45]]
    : kind === 'truck'
      ? [[-0.98, 1.6], [0.98, 1.6], [-0.98, -1.7], [0.98, -1.7]]
      : [[-dims.halfWidth, 1.1], [dims.halfWidth, 1.1], [-dims.halfWidth, -1.1], [dims.halfWidth, -1.1]];
  for (const [wx, wz] of positions) wheels.push(addWheel(group, wx, wz, hubMaterial));

  group.userData.rig = {
    kind,
    dims,
    body: bodyGroup,
    wheels,
    taillightMat,
    turnSignals,
    spin: 0,
    bobTime: 0,
    bobOffset: 0,
    bobAmp: 0,
  };
  return group;
}

const SKIN_TONES = [0xc99a74, 0xa9744f, 0x8a5a3b, 0xe0b392, 0x6f4a33];
const HAIR_COLORS = [0x2e241f, 0x6b4a2f, 0xd9c9a0, 0x191919, 0x9c9c9c, 0x5a3a5e];
const OUTFIT_COLORS = [0x79a8c9, 0xd09a6f, 0xc75d8e, 0x6fbf73, 0x8f74c8, 0xd94f4a, 0x3f9e8f, 0xf2e9d8, 0xe8b23a];
const PEDESTRIAN_GEOMETRY = {
  body: new THREE.CapsuleGeometry(0.22, 0.68, 4, 6),
  head: new THREE.SphereGeometry(0.16, 8, 6),
  hair: new THREE.SphereGeometry(0.17, 8, 6),
};

/**
 * Build a sidewalk pedestrian with a distinct skin/hair/outfit and its own
 * walking-bob phase so crowds do not step in unison.
 */
export function buildPedestrian(random = Math.random) {
  const group = new THREE.Object3D();
  const outfit = OUTFIT_COLORS[Math.floor(random() * OUTFIT_COLORS.length)];
  const skin = SKIN_TONES[Math.floor(random() * SKIN_TONES.length)];
  const hairColor = HAIR_COLORS[Math.floor(random() * HAIR_COLORS.length)];
  const hairScale = random() < 0.35 ? 0.5 : 0.72;
  group.userData.walk = {
    time: random() * 10,
    cadence: 2.6 + random() * 1.6,
    bob: 0.09 + random() * 0.05,
  };
  group.userData.appearance = {
    outfit,
    skin,
    hairColor,
    hairScale,
  };
  return group;
}

/**
 * Three shared body-part batches replace the per-person meshes. Logical
 * pedestrian Object3Ds remain separate so simulation and QA keep stable
 * identity, position, and yaw without adding them to the scene graph.
 */
export function buildPedestrianBatch(count) {
  const group = new THREE.Group();
  group.name = 'pedestrian-batch';
  const parts = {
    body: new THREE.InstancedMesh(
      PEDESTRIAN_GEOMETRY.body,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true }),
      count,
    ),
    head: new THREE.InstancedMesh(
      PEDESTRIAN_GEOMETRY.head,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
      count,
    ),
    hair: new THREE.InstancedMesh(
      PEDESTRIAN_GEOMETRY.hair,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
      count,
    ),
  };
  for (const [name, mesh] of Object.entries(parts)) {
    mesh.name = `pedestrian-${name}-instances`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The crowd spans the whole streamed city and moves continuously. A
    // stale aggregate instance bound must not make nearby walkers disappear.
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return {
    group,
    parts,
    count,
    matrixHelper: new THREE.Object3D(),
    colorsNeedUpdate: false,
  };
}

export function writePedestrianInstance(batch, index, pedestrian) {
  const { group } = pedestrian;
  const { appearance } = group.userData;
  const helper = batch.matrixHelper;

  if (!pedestrian.instanceColorInitialized) {
    batch.parts.body.setColorAt(index, new THREE.Color(appearance.outfit));
    batch.parts.head.setColorAt(index, new THREE.Color(appearance.skin));
    batch.parts.hair.setColorAt(index, new THREE.Color(appearance.hairColor));
    batch.colorsNeedUpdate = true;
    pedestrian.instanceColorInitialized = true;
  }

  helper.rotation.set(0, group.rotation.y, 0);
  helper.scale.set(1, 1, 1);
  helper.position.set(group.position.x, group.position.y + 0.82, group.position.z);
  helper.updateMatrix();
  batch.parts.body.setMatrixAt(index, helper.matrix);

  helper.position.y = group.position.y + 1.42;
  helper.updateMatrix();
  batch.parts.head.setMatrixAt(index, helper.matrix);

  helper.position.y = group.position.y + 1.52;
  helper.scale.set(1, appearance.hairScale, 1);
  helper.updateMatrix();
  batch.parts.hair.setMatrixAt(index, helper.matrix);
}

export function commitPedestrianBatch(batch, count = batch.count) {
  for (const mesh of Object.values(batch.parts)) {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (batch.colorsNeedUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  batch.colorsNeedUpdate = false;
}
