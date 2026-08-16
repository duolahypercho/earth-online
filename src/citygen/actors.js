import * as THREE from 'three';

// Shared low-poly geometry keeps the whole moving fleet to three geometry
// allocations. Invariant parts are drawn by aggregate instance batches; only
// the independently animated rear and turn lights remain per vehicle.
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
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
  const mesh = new THREE.Mesh(GEO.box, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(w, h, d);
  parent.add(mesh);
  return mesh;
}

function wheelPivot(x, z) {
  const pivot = new THREE.Group();
  pivot.position.set(x, 0.3, z);
  return pivot;
}

const DEFAULT_CAB_COLOR = 0xb9d3e0;
const DEFAULT_TAXI_TOPPER_COLOR = 0x1c1c1c;

const VEHICLE_MATERIALS = {
  body: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.55, flatShading: true }),
  cab: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.2, flatShading: true }),
  taxiTopper: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
  transitWindows: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.18, metalness: 0.28, flatShading: true }),
  headlights: new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe9a8, emissiveIntensity: 0.4 }),
  tires: new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 }),
  hubs: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.55, metalness: 0.4, flatShading: true }),
};

const SF_TRANSIT_IDENTITIES = [
  {
    id: 'muni-red-silver-coach',
    style: 'muni-coach',
    bodyColor: 0xd8dcda,
    cabColor: 0xb21f38,
    roofColor: 0xf2eee3,
    windowColor: 0x17343e,
    body: { position: [0, 0.93, 0], scale: [2.35, 1.46, 7.8] },
    cab: { position: [0, 1.14, 0], scale: [2.39, 0.25, 7.82] },
    windows: { position: [0, 1.56, 0], scale: [2.32, 0.62, 7.48] },
    topper: { position: [0, 2.0, -0.35], scale: [1.5, 0.16, 2.3] },
  },
  {
    id: 'muni-heritage-burgundy',
    style: 'cable-car-inspired',
    bodyColor: 0x7d1d2f,
    cabColor: 0xf0cf93,
    roofColor: 0x171513,
    windowColor: 0x24363a,
    body: { position: [0, 0.86, 0], scale: [2.32, 1.3, 7.8] },
    cab: { position: [0, 1.53, 0], scale: [2.08, 0.84, 6.7] },
    windows: { position: [0, 1.58, 0], scale: [2.1, 0.46, 6.72] },
    topper: { position: [0, 2.02, 0], scale: [2.2, 0.16, 7.15] },
  },
];

function applySfTransitIdentity(rig, ordinal) {
  const identity = SF_TRANSIT_IDENTITIES[ordinal % SF_TRANSIT_IDENTITIES.length];
  rig.color = identity.bodyColor;
  rig.layout.body = identity.body;
  rig.layout.cab = identity.cab;
  rig.layout.windows = identity.windows;
  rig.layout.topper = identity.topper;
  rig.sfTransit = {
    ordinal,
    id: identity.id,
    style: identity.style,
    bodyColor: identity.bodyColor,
    cabColor: identity.cabColor,
    roofColor: identity.roofColor,
    windowColor: identity.windowColor,
  };
}

function vehicleLayout(kind, dims) {
  const lightY = kind === 'bus' ? 1.0 : kind === 'truck' ? 1.25 : 0.55;
  const rearLightY = kind === 'bus' ? 1.0 : kind === 'truck' ? 1.2 : 0.5;
  const wheels = kind === 'bus'
    ? [[-1.05, 2.45], [1.05, 2.45], [-1.05, -2.45], [1.05, -2.45]]
    : kind === 'truck'
      ? [[-0.98, 1.6], [0.98, 1.6], [-0.98, -1.7], [0.98, -1.7]]
      : [[-dims.halfWidth, 1.1], [dims.halfWidth, 1.1], [-dims.halfWidth, -1.1], [dims.halfWidth, -1.1]];

  if (kind === 'bus') {
    return {
      body: { position: [0, 1.05, 0], scale: [2.35, 1.7, 7.8] },
      cab: { position: [0, 1.02, 0], scale: [2.38, 0.35, 7.82] },
      topper: null,
      headlights: [-dims.halfWidth, dims.halfWidth].map((x) => ({ position: [x, lightY, dims.frontZ + 0.01], scale: [0.28, 0.16, 0.08] })),
      wheels,
      rearLightY,
    };
  }
  if (kind === 'truck') {
    return {
      body: { position: [0, 0.92, 0], scale: [2.1, 1.35, 4.6] },
      cab: { position: [0, 1.18, 1.7], scale: [1.9, 0.8, 1.6] },
      topper: null,
      headlights: [-dims.halfWidth, dims.halfWidth].map((x) => ({ position: [x, lightY, dims.frontZ + 0.01], scale: [0.28, 0.16, 0.08] })),
      wheels,
      rearLightY,
    };
  }
  const width = kind === 'taxi' ? 1.75 : 1.7;
  return {
    body: { position: [0, 0.62, 0], scale: [width, 0.62, 3.6] },
    cab: { position: [0, 1.12, -0.4], scale: [width * 0.9, 0.5, 1.6] },
    topper: kind === 'taxi' ? { position: [0, 1.55, -0.4], scale: [0.6, 0.18, 0.34] } : null,
    headlights: [-dims.halfWidth, dims.halfWidth].map((x) => ({ position: [x, lightY, dims.frontZ + 0.01], scale: [0.28, 0.16, 0.08] })),
    wheels,
    rearLightY,
  };
}

/**
 * Build a flat-shaded low-poly vehicle. Returns a group whose userData.rig
 * carries everything the traffic sim animates: body (suspension bob),
 * wheels (spin), taillights (brake intensity), and turn-signal emitters.
 */
export function buildVehicle(kind, color) {
  const group = new THREE.Group();
  const dims = CAR_DIMENSIONS[kind] || CAR_DIMENSIONS.sedan;
  const layout = vehicleLayout(kind, dims);
  const bodyGroup = new THREE.Group();
  group.add(bodyGroup);

  // Turn-signal emitters sit on the front and rear corners; emissive
  // intensity is driven per-frame by the traffic sim while cornering.
  // Vehicles face +z, so +x is the left side.
  const signalColor = 0xff9d2e;
  const turnSignals = { left: [], right: [] };
  for (const side of [1, -1]) {
    const signalMat = new THREE.MeshStandardMaterial({ color: signalColor, emissive: signalColor, emissiveIntensity: 0 });
    box(bodyGroup, 0.16, 0.12, 0.1, signalMat, side * (dims.halfWidth + 0.06), layout.rearLightY, dims.frontZ - 0.3);
    box(bodyGroup, 0.16, 0.12, 0.1, signalMat, side * (dims.halfWidth + 0.06), layout.rearLightY, dims.rearZ + 0.3);
    (side > 0 ? turnSignals.left : turnSignals.right).push(signalMat);
  }

  const taillightMat = new THREE.MeshStandardMaterial({ color: 0xff4433, emissive: 0xff2a1a, emissiveIntensity: 0.25 });
  for (const wx of [-dims.halfWidth, dims.halfWidth]) {
    box(bodyGroup, 0.26, 0.12, 0.08, taillightMat, wx, layout.rearLightY, dims.rearZ);
  }

  // The wheel pivots preserve the existing animation contract without adding
  // scene nodes. Their matrices are copied into the tire/hub batches.
  const wheels = layout.wheels.map(([x, z]) => wheelPivot(x, z));

  group.userData.rig = {
    kind,
    dims,
    color,
    layout,
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

/**
 * Scene-wide batches replace invariant vehicle meshes. Logical vehicle groups
 * remain separate for entry, driving, collision, camera, and stateful lights.
 * The aggregate bounds are intentionally disabled because cars move across the
 * full city and stale instance bounds can otherwise cull them.
 */
export function buildVehicleBatch(count) {
  const group = new THREE.Group();
  group.name = 'vehicle-presentation-batch';
  const parts = {
    body: new THREE.InstancedMesh(GEO.box, VEHICLE_MATERIALS.body, count),
    cab: new THREE.InstancedMesh(GEO.box, VEHICLE_MATERIALS.cab, count),
    taxiTopper: new THREE.InstancedMesh(GEO.box, VEHICLE_MATERIALS.taxiTopper, count),
    transitWindows: new THREE.InstancedMesh(GEO.box, VEHICLE_MATERIALS.transitWindows, count),
    headlights: new THREE.InstancedMesh(GEO.box, VEHICLE_MATERIALS.headlights, count * 2),
    tires: new THREE.InstancedMesh(GEO.wheel, VEHICLE_MATERIALS.tires, count * 4),
    hubs: new THREE.InstancedMesh(GEO.hub, VEHICLE_MATERIALS.hubs, count * 4),
  };
  for (const [name, mesh] of Object.entries(parts)) {
    mesh.name = `vehicle-${name}-instances`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return {
    group,
    parts,
    capacity: count,
    taxiCount: 0,
    topperCount: 0,
    transitCount: 0,
    colorsNeedUpdate: false,
    helper: new THREE.Object3D(),
    carMatrix: new THREE.Matrix4(),
    bodyMatrix: new THREE.Matrix4(),
    partMatrix: new THREE.Matrix4(),
  };
}

export function registerVehicleInstance(batch, car, index) {
  const rig = car.group.userData.rig;
  car.instanceIndex = index;
  if (rig.kind === 'bus') {
    rig.transitInstanceIndex = batch.transitCount;
    applySfTransitIdentity(rig, batch.transitCount++);
  }
  rig.topperInstanceIndex = rig.layout.topper ? batch.topperCount++ : -1;
  rig.taxiInstanceIndex = rig.kind === 'taxi' ? rig.topperInstanceIndex : -1;
  if (rig.kind === 'taxi') batch.taxiCount += 1;
  car.color = rig.color;
  batch.parts.body.setColorAt(index, new THREE.Color(rig.color));
  batch.parts.cab.setColorAt(index, new THREE.Color(rig.sfTransit?.cabColor ?? DEFAULT_CAB_COLOR));
  if (rig.sfTransit) {
    batch.parts.transitWindows.setColorAt(rig.transitInstanceIndex, new THREE.Color(rig.sfTransit.windowColor));
  }
  if (rig.layout.topper) {
    batch.parts.taxiTopper.setColorAt(
      rig.topperInstanceIndex,
      new THREE.Color(rig.sfTransit?.roofColor ?? DEFAULT_TAXI_TOPPER_COLOR),
    );
  }
  batch.colorsNeedUpdate = true;
}

function writePartMatrix(batch, mesh, index, parentMatrix, part) {
  const helper = batch.helper;
  helper.position.fromArray(part.position);
  helper.rotation.set(0, 0, 0);
  helper.scale.fromArray(part.scale);
  helper.updateMatrix();
  batch.partMatrix.multiplyMatrices(parentMatrix, helper.matrix);
  mesh.setMatrixAt(index, batch.partMatrix);
}

export function writeVehicleInstance(batch, car) {
  const rig = car.group.userData.rig;
  const index = car.instanceIndex;
  car.group.updateMatrix();
  rig.body.updateMatrix();
  batch.carMatrix.copy(car.group.matrix);
  batch.bodyMatrix.multiplyMatrices(batch.carMatrix, rig.body.matrix);

  writePartMatrix(batch, batch.parts.body, index, batch.bodyMatrix, rig.layout.body);
  writePartMatrix(batch, batch.parts.cab, index, batch.bodyMatrix, rig.layout.cab);
  if (rig.sfTransit) {
    writePartMatrix(batch, batch.parts.transitWindows, rig.transitInstanceIndex, batch.bodyMatrix, rig.layout.windows);
  }
  if (rig.layout.topper) {
    writePartMatrix(batch, batch.parts.taxiTopper, rig.topperInstanceIndex, batch.bodyMatrix, rig.layout.topper);
  }
  for (let i = 0; i < rig.layout.headlights.length; i += 1) {
    writePartMatrix(batch, batch.parts.headlights, index * 2 + i, batch.bodyMatrix, rig.layout.headlights[i]);
  }
  for (let i = 0; i < rig.wheels.length; i += 1) {
    const wheel = rig.wheels[i];
    wheel.updateMatrix();
    batch.partMatrix.multiplyMatrices(batch.carMatrix, wheel.matrix);
    batch.parts.tires.setMatrixAt(index * 4 + i, batch.partMatrix);
    batch.parts.hubs.setMatrixAt(index * 4 + i, batch.partMatrix);
  }
}

export function commitVehicleBatch(batch, count) {
  const counts = {
    body: count,
    cab: count,
    taxiTopper: batch.topperCount,
    transitWindows: batch.transitCount,
    headlights: count * 2,
    tires: count * 4,
    hubs: count * 4,
  };
  for (const [name, mesh] of Object.entries(batch.parts)) {
    mesh.count = counts[name];
    mesh.instanceMatrix.needsUpdate = true;
    if (batch.colorsNeedUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  batch.colorsNeedUpdate = false;
}

const SKIN_TONES = [0xc99a74, 0xa9744f, 0x8a5a3b, 0xe0b392, 0x6f4a33];
const HAIR_COLORS = [0x2e241f, 0x6b4a2f, 0xd9c9a0, 0x191919, 0x9c9c9c, 0x5a3a5e];
const OUTFIT_COLORS = [0x79a8c9, 0xd09a6f, 0xc75d8e, 0x6fbf73, 0x8f74c8, 0xd94f4a, 0x3f9e8f, 0xf2e9d8, 0xe8b23a];

function taperedTorsoGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.2, -0.26, 0.12, 0.2, -0.26, 0.12, 0.2, -0.26, -0.12, -0.2, -0.26, -0.12,
    -0.32, 0.26, 0.14, 0.32, 0.26, 0.14, 0.32, 0.26, -0.14, -0.32, 0.26, -0.14,
  ], 3));
  geometry.setIndex([
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
    4, 5, 6, 4, 6, 7,
    3, 2, 1, 3, 1, 0,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

const PEDESTRIAN_GEOMETRY = {
  torso: taperedTorsoGeometry(),
  limb: new THREE.CylinderGeometry(0.052, 0.062, 1, 5, 1),
  head: new THREE.SphereGeometry(0.14, 6, 4),
  hair: new THREE.SphereGeometry(0.146, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2),
  face: new THREE.BoxGeometry(0.12, 0.08, 0.018),
  hand: new THREE.OctahedronGeometry(0.065, 0),
  shoe: new THREE.BoxGeometry(0.16, 0.1, 0.27),
  shadow: new THREE.CircleGeometry(0.24, 10).rotateX(-Math.PI / 2),
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
    gait: 0,
  };
  group.userData.appearance = {
    outfit,
    trousers: new THREE.Color(outfit).multiplyScalar(0.5).getHex(),
    shoes: new THREE.Color(hairColor).multiplyScalar(0.38).getHex(),
    face: new THREE.Color(skin).lerp(new THREE.Color(0xffffff), 0.08).getHex(),
    skin,
    hairColor,
    hairScale,
  };
  return group;
}

/**
 * Eleven shared body-part batches replace the per-person meshes. Bilateral parts
 * use two instances per pedestrian, keeping elbows, knees, hands, and shoes
 * readable without adding per-person scene nodes. Logical
 * pedestrian Object3Ds remain separate so simulation and QA keep stable
 * identity, position, and yaw without adding them to the scene graph.
 */
export function buildPedestrianBatch(count) {
  const group = new THREE.Group();
  group.name = 'pedestrian-batch';
  const outfitMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, flatShading: true });
  const trouserMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, flatShading: true });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 });
  const shoeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, flatShading: true });
  const parts = {
    torso: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.torso, outfitMaterial, count),
    head: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.head, skinMaterial, count),
    hair: new THREE.InstancedMesh(
      PEDESTRIAN_GEOMETRY.hair,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
      count,
    ),
    face: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.face, skinMaterial, count),
    upperArms: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.limb, outfitMaterial, count * 2),
    forearms: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.limb, skinMaterial, count * 2),
    hands: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.hand, skinMaterial, count * 2),
    thighs: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.limb, trouserMaterial, count * 2),
    shins: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.limb, trouserMaterial, count * 2),
    shoes: new THREE.InstancedMesh(PEDESTRIAN_GEOMETRY.shoe, shoeMaterial, count * 2),
    shadow: new THREE.InstancedMesh(
      PEDESTRIAN_GEOMETRY.shadow,
      new THREE.MeshBasicMaterial({ color: 0x17221c, transparent: true, opacity: 0.22, depthWrite: false }),
      count,
    ),
  };
  for (const [name, mesh] of Object.entries(parts)) {
    mesh.name = `pedestrian-${name}-instances`;
    mesh.userData.instancesPerPedestrian = ['upperArms', 'forearms', 'hands', 'thighs', 'shins', 'shoes'].includes(name) ? 2 : 1;
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
    rootHelper: new THREE.Object3D(),
    rootMatrix: new THREE.Matrix4(),
    partMatrix: new THREE.Matrix4(),
    up: new THREE.Vector3(0, 1, 0),
    start: new THREE.Vector3(),
    end: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    colorsNeedUpdate: false,
  };
}

export function writePedestrianInstance(batch, index, pedestrian) {
  const { group } = pedestrian;
  const { walk } = group.userData;
  const { appearance } = group.userData;
  const helper = batch.matrixHelper;

  if (!pedestrian.instanceColorInitialized) {
    const outfit = new THREE.Color(appearance.outfit);
    const trousers = new THREE.Color(appearance.trousers);
    const skin = new THREE.Color(appearance.skin);
    const shoes = new THREE.Color(appearance.shoes);
    batch.parts.torso.setColorAt(index, outfit);
    batch.parts.head.setColorAt(index, skin);
    batch.parts.hair.setColorAt(index, new THREE.Color(appearance.hairColor));
    batch.parts.face.setColorAt(index, new THREE.Color(appearance.face));
    for (let side = 0; side < 2; side += 1) {
      const pairIndex = index * 2 + side;
      batch.parts.upperArms.setColorAt(pairIndex, outfit);
      batch.parts.forearms.setColorAt(pairIndex, skin);
      batch.parts.hands.setColorAt(pairIndex, skin);
      batch.parts.thighs.setColorAt(pairIndex, trousers);
      batch.parts.shins.setColorAt(pairIndex, trousers);
      batch.parts.shoes.setColorAt(pairIndex, shoes);
    }
    batch.colorsNeedUpdate = true;
    pedestrian.instanceColorInitialized = true;
  }

  const root = batch.rootHelper;
  root.position.set(group.position.x, group.position.y - (walk.bobOffset || 0), group.position.z);
  root.rotation.set(0, group.rotation.y, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrix();
  batch.rootMatrix.copy(root.matrix);
  const writePart = (part, instanceIndex, position, scale = [1, 1, 1]) => {
    helper.position.fromArray(position);
    helper.rotation.set(0, 0, 0);
    helper.quaternion.identity();
    helper.scale.fromArray(scale);
    helper.updateMatrix();
    batch.partMatrix.multiplyMatrices(batch.rootMatrix, helper.matrix);
    batch.parts[part].setMatrixAt(instanceIndex, batch.partMatrix);
  };
  const writeSegment = (part, instanceIndex, start, end) => {
    batch.start.fromArray(start);
    batch.end.fromArray(end);
    batch.direction.subVectors(batch.end, batch.start);
    const length = Math.max(0.01, batch.direction.length());
    batch.direction.multiplyScalar(1 / length);
    helper.position.copy(batch.start).add(batch.end).multiplyScalar(0.5);
    helper.quaternion.setFromUnitVectors(batch.up, batch.direction);
    helper.scale.set(1, length, 1);
    helper.updateMatrix();
    batch.partMatrix.multiplyMatrices(batch.rootMatrix, helper.matrix);
    batch.parts[part].setMatrixAt(instanceIndex, batch.partMatrix);
  };

  const bounce = Math.abs(walk.gait) * 0.018;
  writePart('torso', index, [0, 1.17 + bounce, 0]);
  writePart('head', index, [0, 1.58 + bounce, 0]);
  writePart('hair', index, [0, 1.58 + bounce, 0], [1, appearance.hairScale, 1]);
  writePart('face', index, [0, 1.57 + bounce, 0.137]);
  writePart('shadow', index, [0, 0.008, 0], [1 + Math.abs(walk.gait) * 0.12, 1, 1]);

  for (const side of [-1, 1]) {
    const pairIndex = index * 2 + (side > 0 ? 1 : 0);
    const phase = walk.gait * side;
    const shoulder = [side * 0.32, 1.36 + bounce, 0];
    const hand = [side * 0.37, 0.86 + bounce, -phase * 0.17];
    const elbow = [side * 0.39, 1.1 + bounce, -phase * 0.1 + 0.045];
    writeSegment('upperArms', pairIndex, shoulder, elbow);
    writeSegment('forearms', pairIndex, elbow, hand);
    writePart('hands', pairIndex, hand);

    const hip = [side * 0.12, 0.93 + bounce, 0];
    const shoeZ = phase * 0.16;
    const ankle = [side * 0.12, 0.12, shoeZ];
    const knee = [side * 0.12, 0.53 + bounce * 0.45, shoeZ * 0.42 + Math.max(0, -phase) * 0.12 + 0.035];
    writeSegment('thighs', pairIndex, hip, knee);
    writeSegment('shins', pairIndex, knee, ankle);
    writePart('shoes', pairIndex, [side * 0.12, 0.05, shoeZ + 0.055]);
  }
}

export function commitPedestrianBatch(batch, count = batch.count) {
  for (const mesh of Object.values(batch.parts)) {
    mesh.count = count * (mesh.userData.instancesPerPedestrian || 1);
    mesh.instanceMatrix.needsUpdate = true;
    if (batch.colorsNeedUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  batch.colorsNeedUpdate = false;
}
