import * as THREE from 'three';

// This is an authored presentation layer, not survey-grade or photogrammetric
// reconstruction.  The OSM terminal footprint and the caller's ground sample
// remain the source of truth for its location and base volume.
export const FERRY_BUILDING_LANDMARK_SOURCE = Object.freeze({
  dataset: 'OpenStreetMap SF city snapshot',
  osmWay: 558731934,
  name: 'San Francisco Ferry Building',
});
export const FERRY_SANDSTONE_ALBEDO_URL = '/assets/sf-ferry-sandstone-albedo-v1.png';

export const FERRY_BUILDING_LANDMARK_BUDGET = Object.freeze({
  // The authored facade stays batched by architectural role, never by bay.
  maxDrawCalls: 15,
  maxTriangles: 12000,
  maxInstances: 240,
});

const EPSILON = 0.08;
const FERRY_CLOCK_TOWER_HEIGHT_METRES = 74;
// The clock tower is the presentation anchor captured from the shipped OSM
// world tile. Its Y coordinate is the sampled ground elevation plus baseLift.
export const FERRY_CLOCK_TOWER_ANCHOR = Object.freeze([2281.5306, 1.88, 1936.6459]);

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
  let minAlongPoint = null;
  let maxAlongPoint = null;
  for (const [x, z] of points) {
    const relativeX = x - center.x;
    const relativeZ = z - center.y;
    const projectedAlong = relativeX * along.x + relativeZ * along.y;
    const projectedAcross = relativeX * across.x + relativeZ * across.y;
    if (projectedAlong < minAlong) {
      minAlong = projectedAlong;
      minAlongPoint = new THREE.Vector2(x, z);
    }
    if (projectedAlong > maxAlong) {
      maxAlong = projectedAlong;
      maxAlongPoint = new THREE.Vector2(x, z);
    }
    minAcross = Math.min(minAcross, projectedAcross);
    maxAcross = Math.max(maxAcross, projectedAcross);
  }
  return {
    center,
    along,
    across,
    // Three's positive Y rotation maps local +X to (cos(yaw), -sin(yaw))
    // in this X/Z world. Negating the mathematical X/Z heading makes local
    // +X = `along` and local +Z = `across`, exactly matching this frame.
    threeYaw: -Math.atan2(along.y, along.x),
    minAlong,
    maxAlong,
    minAcross,
    maxAcross,
    minAlongPoint,
    maxAlongPoint,
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

function boxMatrix(matrix, frame, along, across, y, length, height, width, yaw = frame.threeYaw) {
  return matrix.compose(
    localToWorld(frame, along, across, y),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
    new THREE.Vector3(length, height, width),
  );
}

function createSandstoneTexture() {
  if (typeof document === 'undefined') return null;
  const texture = new THREE.TextureLoader().load(FERRY_SANDSTONE_ALBEDO_URL);
  texture.name = 'Ferry Building sandstone albedo v1';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.6, 3.2);
  texture.anisotropy = 4;
  return texture;
}

function createMaterials(sandstoneMap) {
  return {
    // Ferry Building reads as sun-aged masonry rather than a saturated game
    // prop: the base is warmer, while ledges and the tower catch more light.
    sandstone: new THREE.MeshStandardMaterial({ color: 0xf0dfc8, map: sandstoneMap, roughness: 0.86, metalness: 0.0 }),
    trimStone: new THREE.MeshStandardMaterial({ color: 0xc6ab83, roughness: 0.8, metalness: 0.0 }),
    weatherStone: new THREE.MeshStandardMaterial({ color: 0x8e765c, roughness: 0.94, metalness: 0.0 }),
    towerStone: new THREE.MeshStandardMaterial({ color: 0xe7d3b7, map: sandstoneMap, roughness: 0.82, metalness: 0.0 }),
    // A weathered, low-sheen roof catches broad daylight without reading as
    // chrome. The small metal component is for its seams, not a mirror gloss.
    roof: new THREE.MeshStandardMaterial({ color: 0x465257, roughness: 0.78, metalness: 0.14 }),
    // Separate upper glazing and warmer ground-floor storefronts prevent the
    // facade from collapsing into one repeated black rectangle grid.
    glass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.06, clearcoat: 0.12, transparent: false }),
    storefrontGlass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.03, clearcoat: 0.08, transparent: false, side: THREE.DoubleSide }),
    mullion: new THREE.MeshStandardMaterial({ color: 0x3e362d, roughness: 0.68, metalness: 0.18 }),
    clock: new THREE.MeshStandardMaterial({ color: 0xd8c99f, roughness: 0.68, metalness: 0.02, emissive: 0x000000, emissiveIntensity: 0 }),
    clockHand: new THREE.MeshStandardMaterial({ color: 0x202b2d, roughness: 0.5, metalness: 0.38 }),
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

function put(batch, matrix, color = null) {
  if (batch.mesh.count >= batch.capacity) return false;
  const index = batch.mesh.count;
  batch.mesh.setMatrixAt(index, matrix);
  if (color != null) batch.mesh.setColorAt(index, color instanceof THREE.Color ? color : new THREE.Color(color));
  batch.mesh.count += 1;
  return true;
}

function createArchPanelGeometry(segments = 10) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.5, -0.5);
  shape.lineTo(0.5, 0);
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI;
    shape.lineTo(Math.cos(angle) * 0.5, Math.sin(angle) * 0.5);
  }
  shape.lineTo(-0.5, -0.5);
  return new THREE.ShapeGeometry(shape, 1);
}

function createGableRoofGeometry() {
  const positions = new Float32Array([
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
    0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex([
    0, 2, 1, 3, 4, 5,
    0, 3, 5, 0, 5, 2,
    1, 2, 5, 1, 5, 4,
    0, 1, 4, 0, 4, 3,
  ]);
  geometry.computeVertexNormals();
  return geometry;
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
    if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
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
  // The Market Street axis crosses the source footprint near its oriented
  // centre, not at either terminal end. The oriented-bounds midpoint is the
  // deterministic footprint-only equivalent of that source-road intersection.
  // Preserve the known OSM-world tower position instead of allowing minor
  // footprint simplification differences to make its skyline anchor drift.
  const canonicalTowerOffset = new THREE.Vector2(
    FERRY_CLOCK_TOWER_ANCHOR[0] - frame.center.x,
    FERRY_CLOCK_TOWER_ANCHOR[2] - frame.center.y,
  );
  const towerAlong = canonicalTowerOffset.dot(frame.along);
  const towerAcross = canonicalTowerOffset.dot(frame.across);
  const towerAnchor = localToWorld(frame, towerAlong, towerAcross, baseY);
  const sandstoneMap = createSandstoneTexture();
  const materials = createMaterials(sandstoneMap);
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
  const archPanel = createArchPanelGeometry();
  const gableRoof = createGableRoofGeometry();
  const clockDisc = new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20);
  clockDisc.rotateX(Math.PI / 2);
  const clockRing = new THREE.TorusGeometry(0.5, 0.045, 6, 20);
  const pyramid = new THREE.ConeGeometry(0.5, 1, 4);
  ownedGeometries.push(cube, archPanel, gableRoof, clockDisc, clockRing, pyramid);
  const batches = [
    makeBatch(root, 'Ferry Building gabled terminal roof volumes', gableRoof, materials.roof, 4),
    makeBatch(root, 'Ferry Building ground-floor arched storefronts', archPanel, materials.storefrontGlass, 56),
    makeBatch(root, 'Ferry Building recessed upper windows and tower louvers', cube, materials.glass, 68),
    makeBatch(root, 'Ferry Building projecting arcade piers', cube, materials.trimStone, 56),
    makeBatch(root, 'Ferry Building masonry courses and cornices', cube, materials.trimStone, 16),
    makeBatch(root, 'Ferry Building bronze storefront and window divisions', cube, materials.mullion, 60),
    makeBatch(root, 'Ferry Building weathered plinth and tower shadow courses', cube, materials.weatherStone, 12),
    makeBatch(root, 'Ferry Building clock tower tiers', cube, materials.towerStone, 8),
    makeBatch(root, 'Ferry Building clock faces', clockDisc, materials.clock, 4),
    makeBatch(root, 'Ferry Building clock face stone bezels', clockRing, materials.trimStone, 4),
    makeBatch(root, 'Ferry Building clock hands', cube, materials.clockHand, 8),
  ];
  const [roof, storefront, upperWindow, pier, cornice, mullion, weathering, tower, clockFace, clockBezel, clockHands] = batches;
  const matrix = new THREE.Matrix4();

  // Two pitched terminal wings terminate cleanly at the tower instead of one
  // flat lid spanning the entire OSM shell.
  const hallMinAlong = hallCenterAlong - hallLength * 0.5;
  const hallMaxAlong = hallCenterAlong + hallLength * 0.5;
  const roofGap = Math.min(15, hallLength * 0.09);
  const westRoofLength = Math.max(8, towerAlong - roofGap * 0.5 - hallMinAlong);
  const eastRoofLength = Math.max(8, hallMaxAlong - towerAlong - roofGap * 0.5);
  put(roof, boxMatrix(matrix, frame, hallMinAlong + westRoofLength * 0.5, 0, baseY + hallHeight, westRoofLength, 3.25, hallWidth * 0.94));
  put(roof, boxMatrix(matrix, frame, towerAlong + roofGap * 0.5 + eastRoofLength * 0.5, 0, baseY + hallHeight, eastRoofLength, 3.25, hallWidth * 0.94));
  for (const side of [-1, 1]) {
    const facadeAcross = side < 0 ? frame.minAcross : frame.maxAcross;
    put(cornice, boxMatrix(matrix, frame, hallCenterAlong, facadeAcross + side * 0.34, baseY + hallHeight - 0.18, hallLength + 0.55, 0.62, 0.52));
    put(cornice, boxMatrix(matrix, frame, hallCenterAlong, facadeAcross + side * 0.30, baseY + hallHeight * 0.60, hallLength * 0.985, 0.28, 0.38));
    put(cornice, boxMatrix(matrix, frame, hallCenterAlong, facadeAcross + side * 0.28, baseY + hallHeight * 0.20, hallLength * 0.985, 0.18, 0.32));
    put(weathering, boxMatrix(matrix, frame, hallCenterAlong, facadeAcross + side * 0.24, baseY + 0.52, hallLength * 0.99, 0.92, 0.28));
  }

  // Broad historic bays read more clearly at pedestrian distance than the
  // previous dense grid, and leave room for visible masonry between openings.
  const bayCount = clamp(Math.round(hallLength / 8.4), 18, 24);
  const baySpacing = hallLength / bayCount;
  const openingReliefMetres = 0.30;
  const upperGlassColors = [0x6f858b, 0x536c73, 0x829195, 0x5e747a];
  const storefrontColors = [0x536d69, 0x715d44, 0x3f6265, 0x806b4b, 0x486069];
  for (const side of [-1, 1]) {
    const facadeAcross = side < 0 ? frame.minAcross : frame.maxAcross;
    const panelAcross = facadeAcross + side * 0.08;
    const frameAcross = facadeAcross + side * (0.08 + openingReliefMetres);
    for (let index = 0; index < bayCount; index += 1) {
      const along = hallCenterAlong - hallLength * 0.5 + baySpacing * (index + 0.5);
      const entranceBay = Math.abs(along - towerAlong) < baySpacing * 1.25;
      const serviceBay = index % 6 === (side > 0 ? 1 : 4);
      const upperWidth = baySpacing * (index % 3 === 0 ? 0.48 : index % 3 === 1 ? 0.60 : 0.54);
      const upperHeight = entranceBay ? 3.35 : serviceBay ? 2.75 : 3.05;
      const upperY = baseY + (entranceBay ? 11.05 : serviceBay ? 10.25 : 10.55);
      const upperShift = index % 4 === 0 ? baySpacing * 0.07 : index % 4 === 2 ? -baySpacing * 0.06 : 0;
      put(upperWindow, boxMatrix(matrix, frame, along + upperShift, panelAcross, upperY, upperWidth, upperHeight, 0.16), upperGlassColors[(index + (side > 0 ? 1 : 0)) % upperGlassColors.length]);

      const storefrontWidth = baySpacing * (entranceBay ? 0.72 : serviceBay ? 0.50 : 0.62);
      const storefrontHeight = entranceBay ? 5.25 : serviceBay ? 4.25 : 4.75;
      put(storefront, boxMatrix(matrix, frame, along, panelAcross + side * 0.015, baseY + 3.02, storefrontWidth, storefrontHeight, 1), storefrontColors[(index * 2 + (side > 0 ? 1 : 0)) % storefrontColors.length]);

      // Projecting stone piers and brows sit in front of both glazing layers;
      // that 30 cm relief is enough to cast readable near-field self-shadow.
      put(pier, boxMatrix(matrix, frame, along - baySpacing * 0.43, frameAcross, baseY + 6.65, 0.46, 12.25, 0.62), index % 5 === 0 ? 0xd0b891 : 0xbca078);
      if (index % 3 !== 1) {
        put(mullion, boxMatrix(matrix, frame, along + upperShift, frameAcross + side * 0.02, upperY, 0.11, upperHeight * 0.96, 0.13));
      }
      if (index % 4 === 0 || entranceBay) {
        put(mullion, boxMatrix(matrix, frame, along, frameAcross + side * 0.025, baseY + 3.12, 0.12, storefrontHeight * 0.82, 0.14));
      }
      if (index % 4 === 2) {
        put(mullion, boxMatrix(matrix, frame, along, frameAcross + side * 0.03, baseY + 4.05, storefrontWidth * 0.88, 0.11, 0.14));
      }
    }
  }

  // Market Street axis: the clocked campanile provides the dominant hierarchy.
  const entranceAcross = towerAcross;
  const towerBase = Math.min(hallWidth * 0.5, 10.5);
  // The historic clock tower is approximately 245 ft tall. Keep that known
  // landmark scale explicit instead of deriving it from the 15 m terminal hall.
  const towerHeight = FERRY_CLOCK_TOWER_HEIGHT_METRES;
  const towerRoofHeight = towerBase * 0.54;
  const towerTierTopY = baseY + towerHeight - towerRoofHeight;
  const lowerTierHeight = towerHeight * 0.44;
  const middleTierHeight = towerHeight * 0.29;
  const clockTierHeight = towerTierTopY - baseY - lowerTierHeight - middleTierHeight;
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + lowerTierHeight * 0.5, towerBase, lowerTierHeight, towerBase));
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + lowerTierHeight + middleTierHeight * 0.5, towerBase * 0.77, middleTierHeight, towerBase * 0.77));
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, towerTierTopY - clockTierHeight * 0.5, towerBase * 0.94, clockTierHeight, towerBase * 0.94));
  // Shadow courses articulate the otherwise tall shaft and visually seat the
  // enlarged clock stage without adding a mesh per tower face.
  put(weathering, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + lowerTierHeight, towerBase * 1.05, 0.42, towerBase * 1.05));
  put(weathering, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + lowerTierHeight + middleTierHeight, towerBase * 0.87, 0.38, towerBase * 0.87));
  const towerRoof = new THREE.Mesh(pyramid, materials.roof);
  towerRoof.name = 'Ferry Building clock tower pyramidal roof';
  towerRoof.position.copy(localToWorld(frame, towerAlong, entranceAcross, towerTierTopY + towerRoofHeight * 0.5));
  towerRoof.scale.set(towerBase * 1.12, towerRoofHeight, towerBase * 1.12);
  towerRoof.rotation.y = frame.threeYaw + Math.PI / 4;
  towerRoof.castShadow = true;
  root.add(towerRoof);

  const louverY = baseY + lowerTierHeight + middleTierHeight * 0.48;
  const louverHeight = 4.6;
  for (const side of [-1, 1]) {
    const faceAcross = entranceAcross + side * (towerBase * 0.385 + 0.05);
    for (const offset of [-towerBase * 0.17, towerBase * 0.17]) {
      put(upperWindow, boxMatrix(matrix, frame, towerAlong + offset, faceAcross, louverY, towerBase * 0.20, louverHeight, 0.12), 0x35474a);
    }
  }
  for (const side of [-1, 1]) {
    const yaw = frame.threeYaw + Math.PI / 2;
    const faceAlong = towerAlong + side * (towerBase * 0.385 + 0.05);
    for (const offset of [-towerBase * 0.17, towerBase * 0.17]) {
      put(upperWindow, boxMatrix(matrix, frame, faceAlong, entranceAcross + offset, louverY, towerBase * 0.20, louverHeight, 0.12, yaw), 0x35474a);
    }
  }

  const clockY = towerTierTopY - clockTierHeight * 0.47;
  const clockDiameter = towerBase * 0.64;
  for (const side of [-1, 1]) {
    const faceAcross = entranceAcross + side * (towerBase * 0.5 + 0.06);
    const handAcross = entranceAcross + side * (towerBase * 0.5 + 0.12);
    put(clockFace, boxMatrix(matrix, frame, towerAlong, faceAcross, clockY, clockDiameter, clockDiameter, 1));
    put(clockBezel, boxMatrix(matrix, frame, towerAlong, faceAcross + side * 0.07, clockY, clockDiameter * 1.08, clockDiameter * 1.08, 1));
    put(clockHands, boxMatrix(matrix, frame, towerAlong + clockDiameter * 0.08, handAcross, clockY + clockDiameter * 0.035, clockDiameter * 0.04, clockDiameter * 0.05, clockDiameter * 0.55));
    put(clockHands, boxMatrix(matrix, frame, towerAlong - clockDiameter * 0.06, handAcross, clockY - clockDiameter * 0.035, clockDiameter * 0.42, clockDiameter * 0.05, clockDiameter * 0.04));
  }
  for (const side of [-1, 1]) {
    const yaw = frame.threeYaw + Math.PI / 2;
    const faceAlong = towerAlong + side * (towerBase * 0.5 + 0.06);
    const handAlong = towerAlong + side * (towerBase * 0.5 + 0.12);
    put(clockFace, boxMatrix(matrix, frame, faceAlong, entranceAcross, clockY, clockDiameter, clockDiameter, 1, yaw));
    put(clockBezel, boxMatrix(matrix, frame, faceAlong + side * 0.07, entranceAcross, clockY, clockDiameter * 1.08, clockDiameter * 1.08, 1, yaw));
    put(clockHands, boxMatrix(matrix, frame, handAlong, entranceAcross + clockDiameter * 0.08, clockY + clockDiameter * 0.035, clockDiameter * 0.04, clockDiameter * 0.05, clockDiameter * 0.55, yaw));
    put(clockHands, boxMatrix(matrix, frame, handAlong, entranceAcross - clockDiameter * 0.06, clockY - clockDiameter * 0.035, clockDiameter * 0.42, clockDiameter * 0.05, clockDiameter * 0.04, yaw));
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
    facadeBaysPerSide: bayCount,
    storefrontVariants: storefrontColors.length,
    openingReliefMetres,
  });
  if (stats.drawCalls > FERRY_BUILDING_LANDMARK_BUDGET.maxDrawCalls
    || stats.triangles > FERRY_BUILDING_LANDMARK_BUDGET.maxTriangles
    || stats.instances > FERRY_BUILDING_LANDMARK_BUDGET.maxInstances) {
    root.removeFromParent();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
    sandstoneMap?.dispose();
    throw new Error(`Ferry Building landmark exceeded its rendering budget (${stats.drawCalls} draws, ${stats.triangles} triangles, ${stats.instances} instances).`);
  }

  const sourceMesh = options.sourceMesh?.isObject3D && sourceRenderMatches(options.sourceMesh) ? options.sourceMesh : null;
  const originalSourceVisibility = sourceMesh?.visible;
  if (sourceMesh) sourceMesh.visible = false;
  let disposed = false;
  function update() {
    if (disposed) return;
    // Materials deliberately stay passive: the landmark has no emissive
    // clock pulse. Keep this method for the streaming lifecycle contract.
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (sourceMesh) sourceMesh.visible = originalSourceVisibility;
    root.removeFromParent();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
    sandstoneMap?.dispose();
  }
  function getDiagnostics() {
    return {
      source: FERRY_BUILDING_LANDMARK_SOURCE,
      attached: Boolean(root.parent),
      hiddenSourceRender: Boolean(sourceMesh && !sourceMesh.visible),
      proceduralApproximation: true,
      frame: {
        along: [frame.along.x, frame.along.y],
        across: [frame.across.x, frame.across.y],
        threeYaw: frame.threeYaw,
        bounds: {
          minAlong: frame.minAlong,
          maxAlong: frame.maxAlong,
          minAcross: frame.minAcross,
          maxAcross: frame.maxAcross,
        },
        marketEndTarget: [frame.maxAlongPoint.x, frame.maxAlongPoint.y],
        oppositeEndTarget: [frame.minAlongPoint.x, frame.minAlongPoint.y],
      },
      towerAnchor: [towerAnchor.x, towerAnchor.y, towerAnchor.z],
      towerHeightMetres: towerHeight,
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
