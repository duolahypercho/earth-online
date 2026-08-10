import * as THREE from 'three';

// This is an authored presentation layer, not survey-grade or photogrammetric
// reconstruction.  The OSM terminal footprint and the caller's ground sample
// remain the source of truth for its location and base volume.
export const FERRY_BUILDING_LANDMARK_SOURCE = Object.freeze({
  dataset: 'OpenStreetMap SF city snapshot',
  osmWay: 558731934,
  name: 'San Francisco Ferry Building',
});

export const FERRY_BUILDING_LANDMARK_BUDGET = Object.freeze({
  maxDrawCalls: 25,
  maxTriangles: 12000,
  maxInstances: 240,
});

const MAX_DELTA_SECONDS = 1 / 20;
const EPSILON = 0.08;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalisePoints(points) {
  if (!Array.isArray(points)) return [];
  const pairs = points.every(Number.isFinite)
    ? Array.from({ length: Math.floor(points.length / 2) }, (_, index) => [points[index * 2], points[index * 2 + 1]])
    : points.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (pairs.length > 2 && Math.hypot(pairs[0][0] - pairs.at(-1)[0], pairs[0][1] - pairs.at(-1)[1]) < EPSILON) pairs.pop();
  return pairs;
}

function sourceIdMatches(value) {
  return String(value) === String(FERRY_BUILDING_LANDMARK_SOURCE.osmWay);
}

function isFerryBuilding(building) {
  return sourceIdMatches(building?.id) && normalisePoints(building?.points).length >= 3;
}

function sourceRenderMatches(mesh) {
  const data = mesh?.userData || {};
  // A multi-building instanced/chunked mesh cannot be hidden safely: doing so
  // would suppress unrelated OSM buildings, so it is intentionally refused.
  return sourceIdMatches(data.buildingId) || sourceIdMatches(data.building?.id);
}

function resolveElevation(building, elevationAt) {
  const points = normalisePoints(building.points);
  const samples = points.map(([x, z]) => Number(elevationAt(x, z))).filter(Number.isFinite);
  if (samples.length) return Math.min(...samples);
  const [x, z] = building.centroid || points[0];
  const sampled = Number(elevationAt(x, z));
  return Number.isFinite(sampled) ? sampled : 0;
}

function principalFrame(points, fallbackCentroid) {
  const center = fallbackCentroid?.length === 2 && fallbackCentroid.every(Number.isFinite)
    ? new THREE.Vector2(fallbackCentroid[0], fallbackCentroid[1])
    : points.reduce((sum, [x, z]) => sum.add(new THREE.Vector2(x, z)), new THREE.Vector2()).multiplyScalar(1 / points.length);
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const [x, z] of points) {
    const dx = x - center.x;
    const dz = z - center.y;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const along = new THREE.Vector2(Math.cos(angle), Math.sin(angle));
  // Make the terminal direction deterministic. On the shipped OSM footprint
  // this points from the Market Street tower end toward the water-side wing.
  if (along.x < 0 || (Math.abs(along.x) < EPSILON && along.y < 0)) along.multiplyScalar(-1);
  const across = new THREE.Vector2(-along.y, along.x);
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (const [x, z] of points) {
    const relativeX = x - center.x;
    const relativeZ = z - center.y;
    const projectedAlong = relativeX * along.x + relativeZ * along.y;
    const projectedAcross = relativeX * across.x + relativeZ * across.y;
    minAlong = Math.min(minAlong, projectedAlong);
    maxAlong = Math.max(maxAlong, projectedAlong);
    minAcross = Math.min(minAcross, projectedAcross);
    maxAcross = Math.max(maxAcross, projectedAcross);
  }
  return {
    center,
    along,
    across,
    yaw: Math.atan2(along.y, along.x),
    minAlong,
    maxAlong,
    minAcross,
    maxAcross,
    length: maxAlong - minAlong,
    width: maxAcross - minAcross,
  };
}

function localToWorld(frame, along, across, y) {
  return new THREE.Vector3(
    frame.center.x + frame.along.x * along + frame.across.x * across,
    y,
    frame.center.y + frame.along.y * along + frame.across.y * across,
  );
}

function boxMatrix(matrix, frame, along, across, y, length, height, width, yaw = frame.yaw) {
  return matrix.compose(
    localToWorld(frame, along, across, y),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
    new THREE.Vector3(length, height, width),
  );
}

function createMaterials() {
  return {
    sandstone: new THREE.MeshStandardMaterial({ color: 0xb89c72, roughness: 0.74, metalness: 0.03 }),
    stoneShadow: new THREE.MeshStandardMaterial({ color: 0x745b42, roughness: 0.8, metalness: 0.02 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x576064, roughness: 0.71, metalness: 0.31 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x2d4850, roughness: 0.2, metalness: 0.18, clearcoat: 0.2, transparent: true, opacity: 0.92 }),
    clock: new THREE.MeshStandardMaterial({ color: 0xefdfb4, roughness: 0.48, metalness: 0.08, emissive: 0x483a1d, emissiveIntensity: 0.12 }),
    clockHand: new THREE.MeshStandardMaterial({ color: 0x1b2528, roughness: 0.42, metalness: 0.62 }),
  };
}

function makeBatch(root, name, geometry, material, capacity) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return { mesh, capacity };
}

function put(batch, matrix) {
  if (batch.mesh.count >= batch.capacity) return false;
  batch.mesh.setMatrixAt(batch.mesh.count, matrix);
  batch.mesh.count += 1;
  return true;
}

function createFootprintShell(points, baseY, height, material) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, baseY + height, 0);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Ferry Building authoritative OSM footprint shell';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function finishBatches(batches) {
  for (const batch of batches) {
    batch.mesh.instanceMatrix.needsUpdate = true;
    batch.mesh.computeBoundingSphere();
  }
}

function meshTriangleCount(mesh) {
  const vertices = mesh.geometry.index?.count || mesh.geometry.attributes.position?.count || 0;
  return (vertices / 3) * (mesh.isInstancedMesh ? mesh.count : 1);
}

function countMeshes(root) {
  const meshes = [];
  root.traverse((object) => { if (object.isMesh) meshes.push(object); });
  return meshes;
}

/**
 * Builds a low-call, source-aligned Ferry Building presentation. `building`
 * must be the exact OSM way; there is deliberately no coordinate fallback.
 * `sourceMesh` is optional and hidden only when it is itself the exact source
 * building render, then restored verbatim by dispose().
 */
export function createFerryBuildingLandmark(options = {}) {
  const scene = options.scene;
  if (!scene?.isObject3D) throw new Error('createFerryBuildingLandmark requires a Three.js scene or parent group.');
  const building = options.building;
  if (!isFerryBuilding(building)) {
    throw new Error(`Ferry Building landmark refused: expected OSM way ${FERRY_BUILDING_LANDMARK_SOURCE.osmWay} with a valid footprint.`);
  }
  const parent = options.parent?.isObject3D ? options.parent : scene;
  const points = normalisePoints(building.points);
  const frame = principalFrame(points, building.centroid);
  if (frame.length < 30 || frame.width < 10) {
    throw new Error('Ferry Building landmark refused: authoritative footprint is too small to articulate safely.');
  }
  const elevationAt = typeof options.elevationAt === 'function'
    ? options.elevationAt
    : typeof options.getElevation === 'function' ? options.getElevation : () => 0;
  const baseY = resolveElevation(building, elevationAt) + (Number.isFinite(options.baseLift) ? options.baseLift : 0.08);
  const sourceHeight = Number(building.height);
  const hallHeight = clamp(Number.isFinite(sourceHeight) ? sourceHeight : 15, 12, 18);
  const hallLength = frame.length * 0.91;
  const hallWidth = frame.width * 0.74;
  const hallCenterAlong = (frame.minAlong + frame.maxAlong) * 0.5;
  const towerAlong = frame.minAlong + Math.max(7.5, frame.length * 0.105);
  const materials = createMaterials();
  const root = new THREE.Group();
  root.name = 'San Francisco Ferry Building landmark (OSM way 558731934)';
  root.userData.heroLandmark = true;
  root.userData.source = FERRY_BUILDING_LANDMARK_SOURCE;
  root.userData.proceduralApproximation = true;
  parent.add(root);

  const ownedGeometries = [];
  const shell = createFootprintShell(points, baseY, hallHeight, materials.sandstone);
  root.add(shell);
  ownedGeometries.push(shell.geometry);

  const cube = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const clockDisc = new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20);
  clockDisc.rotateX(Math.PI / 2);
  const pyramid = new THREE.ConeGeometry(0.5, 1, 4);
  ownedGeometries.push(cube, cylinder, clockDisc, pyramid);
  const batches = [
    makeBatch(root, 'Ferry Building roof masses', cube, materials.roof, 4),
    makeBatch(root, 'Ferry Building arcade piers', cube, materials.stoneShadow, 72),
    makeBatch(root, 'Ferry Building deep window bays', cube, materials.glass, 84),
    makeBatch(root, 'Ferry Building cornices and awnings', cube, materials.sandstone, 48),
    makeBatch(root, 'Ferry Building clock tower tiers', cube, materials.sandstone, 8),
    makeBatch(root, 'Ferry Building clock faces', clockDisc, materials.clock, 4),
    makeBatch(root, 'Ferry Building clock hands', cube, materials.clockHand, 8),
  ];
  const [roof, pier, windowBay, cornice, tower, clockFace, clockHands] = batches;
  const matrix = new THREE.Matrix4();

  // A stepped roof and continuous cornice break the old monolithic slab into
  // terminal hall wings while remaining strictly inside the OSM shell bounds.
  put(roof, boxMatrix(matrix, frame, hallCenterAlong, 0, baseY + hallHeight + 0.65, hallLength, 1.3, hallWidth, frame.yaw));
  put(roof, boxMatrix(matrix, frame, hallCenterAlong + hallLength * 0.21, 0, baseY + hallHeight + 1.48, hallLength * 0.46, 0.42, hallWidth * 0.48, frame.yaw));
  for (const side of [-1, 1]) {
    put(cornice, boxMatrix(matrix, frame, hallCenterAlong, side * (hallWidth * 0.5 + 0.12), baseY + hallHeight - 0.35, hallLength + 0.45, 0.48, 0.34, frame.yaw));
  }
  put(cornice, boxMatrix(matrix, frame, hallCenterAlong, 0, baseY + 1.0, hallLength + 0.25, 0.45, hallWidth + 0.2, frame.yaw));

  const bayCount = clamp(Math.round(hallLength / 7.2), 18, 28);
  const baySpacing = hallLength / bayCount;
  for (const side of [-1, 1]) {
    const across = side * (hallWidth * 0.5 + 0.13);
    for (let index = 0; index < bayCount; index += 1) {
      const along = hallCenterAlong - hallLength * 0.5 + baySpacing * (index + 0.5);
      put(windowBay, boxMatrix(matrix, frame, along, across, baseY + hallHeight * 0.47, baySpacing * 0.66, hallHeight * 0.54, 0.11, frame.yaw));
      put(pier, boxMatrix(matrix, frame, along - baySpacing * 0.42, across + side * 0.16, baseY + hallHeight * 0.48, 0.34, hallHeight * 0.85, 0.36, frame.yaw));
      if (index % 2 === 0) put(cornice, boxMatrix(matrix, frame, along, across + side * 0.17, baseY + hallHeight * 0.73, baySpacing * 0.82, 0.17, 0.22, frame.yaw));
    }
  }

  // Market Street end: a heavier arcade and a deliberately oversized, clocked
  // campanile make the landmark legible well before facade detail resolves.
  const entranceAcross = 0;
  for (const offset of [-hallWidth * 0.3, 0, hallWidth * 0.3]) {
    put(windowBay, boxMatrix(matrix, frame, towerAlong - 1.4, offset, baseY + hallHeight * 0.37, 0.12, hallHeight * 0.55, hallWidth * 0.21, frame.yaw));
    put(pier, boxMatrix(matrix, frame, towerAlong - 1.58, offset + hallWidth * 0.12, baseY + hallHeight * 0.46, 0.4, hallHeight * 0.82, 0.4, frame.yaw));
  }
  const towerBase = Math.min(hallWidth * 0.5, 10.5);
  const towerHeight = Math.max(58, hallHeight * 4.4);
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + towerHeight * 0.22, towerBase, towerHeight * 0.44, towerBase, frame.yaw));
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + towerHeight * 0.58, towerBase * 0.77, towerHeight * 0.30, towerBase * 0.77, frame.yaw));
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + towerHeight * 0.80, towerBase * 0.92, towerHeight * 0.12, towerBase * 0.92, frame.yaw));
  const towerRoof = new THREE.Mesh(pyramid, materials.roof);
  towerRoof.name = 'Ferry Building clock tower pyramidal roof';
  towerRoof.position.copy(localToWorld(frame, towerAlong, entranceAcross, baseY + towerHeight + towerBase * 0.27));
  towerRoof.scale.set(towerBase * 1.12, towerBase * 0.54, towerBase * 1.12);
  towerRoof.rotation.y = frame.yaw + Math.PI / 4;
  towerRoof.castShadow = true;
  root.add(towerRoof);

  const clockY = baseY + towerHeight * 0.73;
  for (const side of [-1, 1]) {
    put(clockFace, boxMatrix(matrix, frame, towerAlong, side * (towerBase * 0.5 + 0.06), clockY, towerBase * 0.47, towerBase * 0.47, 1, frame.yaw));
    put(clockHands, boxMatrix(matrix, frame, towerAlong + towerBase * 0.07, side * (towerBase * 0.5 + 0.12), clockY + towerBase * 0.035, towerBase * 0.04, towerBase * 0.05, towerBase * 0.28, frame.yaw));
    put(clockHands, boxMatrix(matrix, frame, towerAlong - towerBase * 0.06, side * (towerBase * 0.5 + 0.12), clockY - towerBase * 0.035, towerBase * 0.21, towerBase * 0.05, towerBase * 0.04, frame.yaw));
  }
  for (const side of [-1, 1]) {
    const yaw = frame.yaw + Math.PI / 2;
    put(clockFace, boxMatrix(matrix, frame, towerAlong + side * (towerBase * 0.5 + 0.06), 0, clockY, towerBase * 0.47, towerBase * 0.47, 1, yaw));
    put(clockHands, boxMatrix(matrix, frame, towerAlong + side * (towerBase * 0.5 + 0.12), towerBase * 0.07, clockY + towerBase * 0.035, towerBase * 0.04, towerBase * 0.05, towerBase * 0.28, yaw));
    put(clockHands, boxMatrix(matrix, frame, towerAlong + side * (towerBase * 0.5 + 0.12), -towerBase * 0.06, clockY - towerBase * 0.035, towerBase * 0.21, towerBase * 0.05, towerBase * 0.04, yaw));
  }
  finishBatches(batches);

  const meshes = countMeshes(root);
  const stats = Object.freeze({
    drawCalls: meshes.length,
    triangles: meshes.reduce((total, mesh) => total + meshTriangleCount(mesh), 0),
    instances: batches.reduce((total, batch) => total + batch.mesh.count, 0),
    sourceWay: FERRY_BUILDING_LANDMARK_SOURCE.osmWay,
    footprintPoints: points.length,
    hiddenSourceRender: Boolean(options.sourceMesh?.isObject3D && sourceRenderMatches(options.sourceMesh)),
  });
  if (stats.drawCalls > FERRY_BUILDING_LANDMARK_BUDGET.maxDrawCalls
    || stats.triangles > FERRY_BUILDING_LANDMARK_BUDGET.maxTriangles
    || stats.instances > FERRY_BUILDING_LANDMARK_BUDGET.maxInstances) {
    root.removeFromParent();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
    throw new Error('Ferry Building landmark exceeded its rendering budget.');
  }

  const sourceMesh = options.sourceMesh?.isObject3D && sourceRenderMatches(options.sourceMesh) ? options.sourceMesh : null;
  const originalSourceVisibility = sourceMesh?.visible;
  if (sourceMesh) sourceMesh.visible = false;
  let elapsed = 0;
  let disposed = false;
  function update(deltaSeconds = 0) {
    if (disposed) return;
    elapsed += clamp(Number(deltaSeconds) || 0, 0, MAX_DELTA_SECONDS);
    // Preserve fixed clock geometry while lending a subtle, material-only
    // nighttime read to its faces; this never allocates or changes draw calls.
    materials.clock.emissiveIntensity = 0.11 + Math.sin(elapsed * 0.32) * 0.015;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (sourceMesh) sourceMesh.visible = originalSourceVisibility;
    root.removeFromParent();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
  }
  function getDiagnostics() {
    return {
      source: FERRY_BUILDING_LANDMARK_SOURCE,
      attached: Boolean(root.parent),
      hiddenSourceRender: Boolean(sourceMesh && !sourceMesh.visible),
      proceduralApproximation: true,
      disposed,
      stats,
    };
  }
  return Object.freeze({
    root,
    stats,
    update,
    getDiagnostics,
    dispose,
    get disposed() { return disposed; },
  });
}
