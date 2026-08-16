import * as THREE from 'three';

/**
 * A compact, source-aligned near-field dressing pass for the Ferry Building
 * launch tile. It deliberately has no knowledge of the world builder: callers
 * pass terrain and water samplers so streamed tiles can attach / detach it
 * without changing the OSM road or building meshes underneath.
 *
 * Default feature coordinates are from the bundled OSM SF snapshot:
 * Ferry Plaza 26769726, The Embarcadero 88463826/88463827, Mission St
 * 88463831, and the named Ferry Building footprint (way 558731934).
 */
export const FERRY_BUILDING_STREETSCAPE_BUDGET = Object.freeze({
  maxDrawCalls: 18,
  maxInstances: 360,
  maxTriangles: 12400,
});

export const FERRY_BUILDING_STREETSCAPE_SOURCE = Object.freeze({
  dataset: 'OpenStreetMap SF city snapshot',
  roadIds: Object.freeze([26769726, 88463826, 88463827, 88463831, 283512618, 850162147]),
  pavingPathIds: Object.freeze([
    779448275, 779448274, 779448273, 151632675, 779448272, 779448271, 1189071403,
    196662077, 196662081,
  ]),
  ferryBuildingWay: 558731934,
});

const DEFAULT_BOUNDS = Object.freeze({ minX: 2144, minZ: 1728, maxX: 2528, maxZ: 2112 });
const MAX_DELTA_SECONDS = 0.05;
const FERRY_PLAZA_PAVER_ALBEDO_PATH = '/assets/sf-ferry-plaza-pavers-albedo-v1.png';
const FERRY_PLAZA_PAVER_REPEAT_METERS = 2.5;
const FERRY_PLAZA_PAVER_TEXTURE_MIX = 0.64;
const DEFAULT_ROADS = Object.freeze([
  { id: 26769726, name: 'Ferry Plaza', width: 7.1, points: [[2320.3, 1820.6], [2372.5, 1871.6]] },
  { id: 88463826, name: 'The Embarcadero', width: 11.8, points: [[2314.9, 1815.0], [2295.6, 1837.9]] },
  { id: 88463827, name: 'The Embarcadero', width: 11.8, points: [[2357.4, 1738.2], [2389.0, 1702.0]] },
  { id: 88463831, name: 'Mission Street', width: 10.2, points: [[2357.4, 1738.2], [2304.7, 1685.8]] },
  { id: 283512618, name: 'The Embarcadero', width: 6.5, points: [[2169.7, 1947.1], [2264.2, 1824.2]] },
  { id: 850162147, name: 'The Embarcadero', width: 9.75, points: [[2258.5, 1885.4], [2224.4, 1932.4]] },
]);
const DEFAULT_PAVING_PATHS = Object.freeze([
  { id: 779448275, name: 'Market Street', surface: 'paving_stones', width: 3.8, points: [[2173, 1831.4], [2206.4, 1865.1]] },
  { id: 779448274, name: '', surface: 'asphalt', width: 3.2, points: [[2206.4, 1865.1], [2215.9, 1873.6]] },
  { id: 779448273, name: '', surface: 'paving_stones', width: 3.8, points: [[2215.9, 1873.6], [2229.2, 1897.2]] },
  { id: 151632675, name: '', surface: 'asphalt', width: 3.2, points: [[2236.1, 1902.4], [2240.8, 1906.6]] },
  { id: 779448272, name: '', surface: 'paving_stones', width: 3.8, points: [[2240.8, 1906.6], [2248.9, 1913.1]] },
  { id: 779448271, name: '', surface: 'paving_stones', width: 3.8, points: [[2248.9, 1913.1], [2258.8, 1920.2]] },
  { id: 1189071403, name: '', surface: 'paving_stones', width: 3.8, points: [[2258.8, 1920.2], [2267.7, 1925.3]] },
  { id: 196662077, name: '', surface: 'concrete', width: 3.4, points: [[2161.8, 1842.5], [2247.2, 1757.9]] },
  { id: 196662081, name: '', surface: 'paving_stones', width: 3.8, points: [[2172.5, 1854.1], [2229.2, 1796.8]] },
]);

const PALETTE = Object.freeze({
  curb: 0x9da3a1,
  sidewalk: 0x888984,
  tactile: 0xb28c3f,
  pavingStone: 0x8e8b80,
  pavingConcrete: 0x999994,
  pavingBorder: 0x9a9992,
  pavingAsphalt: 0x4f5555,
  marking: 0xe7dfc2,
  gutter: 0x72868b,
  drain: 0x4c5557,
  utility: 0x394042,
  iron: 0x202729,
  planter: 0x555a55,
  leaf: 0x415845,
  facade: 0xb7a382,
  facadeShadow: 0x6e604f,
  glass: 0x273b41,
});

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hash11(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function validPoint(point) {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function normalisePoints(points) {
  if (!Array.isArray(points)) return [];
  if (points.every(Number.isFinite)) {
    if (points.length % 2) return [];
    const pairs = [];
    for (let index = 0; index + 1 < points.length; index += 2) pairs.push([points[index], points[index + 1]]);
    return pairs;
  }
  return points.filter(validPoint).map(([x, z]) => [x, z]);
}

function numberFrom(...values) {
  for (const value of values) {
    const result = typeof value === 'number' ? value : Number.parseFloat(value);
    if (Number.isFinite(result) && result > 0) return result;
  }
  return null;
}

function resolveRoadWidth(road) {
  const tags = road?.tags || road?.properties || {};
  const explicitWidth = numberFrom(
    road?.widthM, road?.width, road?.roadWidthM, road?.roadWidth,
    road?.asphaltWidthM, road?.asphaltWidth, tags.width, tags['width:m'],
  );
  if (explicitWidth !== null) return clamp(explicitWidth, 3, 18);
  const lanes = numberFrom(road?.lanes, tags.lanes);
  const laneWidth = numberFrom(road?.laneWidthM, road?.laneWidth, tags.lane_width);
  if (lanes !== null) return clamp(lanes * (laneWidth || 3.25), 3, 18);
  return 8;
}

function sourceRoadIdMatches(road) {
  return FERRY_BUILDING_STREETSCAPE_SOURCE.roadIds.some((id) => String(id) === String(road?.id));
}

function normaliseRoads(roads) {
  const callerRoads = Array.isArray(roads) ? roads.filter(sourceRoadIdMatches) : [];
  const normalised = callerRoads.flatMap((road) => {
    const points = normalisePoints(road?.points);
    if (points.length < 2) return [];
    return [{
      id: road.id ?? 'caller-road',
      name: road.name || '',
      width: resolveRoadWidth(road),
      points,
    }];
  });
  if (normalised.length) return normalised;
  return DEFAULT_ROADS.map((road) => ({ ...road, points: normalisePoints(road.points) }));
}

function sourcePavingPathIdMatches(road) {
  return FERRY_BUILDING_STREETSCAPE_SOURCE.pavingPathIds.some((id) => String(id) === String(road?.id));
}

function normalisePavingPaths(roads) {
  const callerPaths = Array.isArray(roads) ? roads.filter(sourcePavingPathIdMatches) : [];
  const normalised = callerPaths.flatMap((path) => {
    const points = normalisePoints(path?.points);
    if (points.length < 2) return [];
    const surface = String(path.surface || path.tags?.surface || path.properties?.surface || 'paving_stones');
    const explicitWidth = numberFrom(path.widthM, path.width, path.tags?.width, path.properties?.width);
    return [{
      id: path.id,
      name: path.name || '',
      surface,
      width: explicitWidth === null ? (surface === 'asphalt' ? 3.2 : 3.8) : clamp(explicitWidth, 2.4, 6),
      points,
    }];
  });
  if (normalised.length) return normalised;
  return DEFAULT_PAVING_PATHS.map((path) => ({ ...path, points: normalisePoints(path.points) }));
}

function segmentIntersection(first, second) {
  const rx = first.b[0] - first.a[0];
  const rz = first.b[1] - first.a[1];
  const sx = second.b[0] - second.a[0];
  const sz = second.b[1] - second.a[1];
  const denominator = rx * sz - rz * sx;
  if (Math.abs(denominator) < 1e-7) return null;
  const qx = second.a[0] - first.a[0];
  const qz = second.a[1] - first.a[1];
  const firstT = (qx * sz - qz * sx) / denominator;
  const secondT = (qx * rz - qz * rx) / denominator;
  if (firstT < 0 || firstT > 1 || secondT < 0 || secondT > 1) return null;
  return {
    x: first.a[0] + rx * firstT,
    z: first.a[1] + rz * firstT,
    firstT,
    secondT,
  };
}

function forEachSegment(road, visit) {
  for (let index = 1; index < road.points.length; index += 1) {
    const a = road.points[index - 1];
    const b = road.points[index];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length > 0.1) visit({ a, b, dx, dz, length, angle: Math.atan2(dz, dx), index });
  }
}

function createStandardMaterial(color, roughness, metalness = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

function makeBatch(root, name, geometry, material, maxCount) {
  const mesh = new THREE.InstancedMesh(geometry, material, maxCount);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  mesh.frustumCulled = true;
  root.add(mesh);
  return { mesh, capacity: maxCount };
}

function put(batch, matrix, color, pavingAlbedoMix) {
  const index = batch.mesh.count;
  if (index >= batch.capacity) return false;
  batch.mesh.setMatrixAt(index, matrix);
  if (color) batch.mesh.setColorAt(index, color);
  const albedoMix = batch.mesh.geometry.getAttribute('pavingAlbedoMix');
  if (albedoMix) albedoMix.setX(index, Number(pavingAlbedoMix) || 0);
  batch.mesh.count += 1;
  return true;
}

function boxMatrix(target, x, y, z, sx, sy, sz, yaw = 0) {
  // Three.js positive Y rotation sends local +X toward world -Z. Segment
  // headings use atan2(dz, dx), so negate the heading to make a box's local
  // +X axis follow the source segment's world-space +X/+Z direction.
  target.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -yaw, 0)),
    new THREE.Vector3(sx, sy, sz),
  );
  return target;
}

function cylinderMatrix(target, x, y, z, sx, sy, sz, yaw = 0) {
  return boxMatrix(target, x, y, z, sx, sy, sz, yaw);
}

function createPavingTexture({ roughness = false } = {}) {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const course = Math.floor(y / 8);
    for (let x = 0; x < size; x += 1) {
      const shiftedX = (x + (course % 2) * 8) % 16;
      const mortar = y % 8 === 0 || shiftedX === 0;
      const noise = hash11(x * 73 + y * 131 + course * 17);
      const value = roughness
        ? (mortar ? 224 : Math.round(176 + noise * 38))
        : (mortar ? 138 : Math.round(166 + noise * 24));
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = roughness ? value : Math.round(value * 0.98);
      data[offset + 2] = roughness ? value : Math.round(value * 0.91);
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  if (!roughness) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function configurePavingAlbedoTexture(texture) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.physicalRepeatMeters = FERRY_PLAZA_PAVER_REPEAT_METERS;
  texture.userData.source = FERRY_PLAZA_PAVER_ALBEDO_PATH;
  texture.needsUpdate = true;
  return texture;
}

function createPavingAlbedo() {
  const fallback = configurePavingAlbedoTexture(createPavingTexture());
  fallback.userData.physicalRepeatMeters = FERRY_PLAZA_PAVER_REPEAT_METERS;
  fallback.userData.source = 'procedural-fallback';
  const textures = new Set([fallback]);
  let generated = null;

  function loadInto(material, canApply) {
    // The deterministic node verifier has no DOM image loader. Keep its small
    // procedural fallback rather than importing a browser-only loader there.
    if (typeof document === 'undefined' || typeof Image === 'undefined') return false;
    try {
      generated = new THREE.TextureLoader().load(
        FERRY_PLAZA_PAVER_ALBEDO_PATH,
        (texture) => {
          configurePavingAlbedoTexture(texture);
          if (!canApply()) {
            texture.dispose();
            return;
          }
          material.map = texture;
          material.needsUpdate = true;
        },
        undefined,
        () => {
          // Network or asset-server failures intentionally retain the fallback.
          generated?.dispose();
          generated = null;
        },
      );
      configurePavingAlbedoTexture(generated);
      textures.add(generated);
      return true;
    } catch {
      generated?.dispose();
      generated = null;
      return false;
    }
  }

  return {
    fallback,
    get textures() { return [...textures]; },
    loadInto,
  };
}

function addWorldProjectedPavingShader(material) {
  const repeat = FERRY_PLAZA_PAVER_REPEAT_METERS.toFixed(3);
  const textureMix = FERRY_PLAZA_PAVER_TEXTURE_MIX.toFixed(3);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float pavingAlbedoMix;
varying vec3 vFerryPavingWorldPosition;
varying float vFerryPavingAlbedoMix;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vec4 ferryPavingWorldPosition = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
vFerryPavingWorldPosition = ferryPavingWorldPosition.xyz;
vFerryPavingAlbedoMix = pavingAlbedoMix;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vFerryPavingWorldPosition;
varying float vFerryPavingAlbedoMix;`)
      .replace('#include <map_fragment>', `#ifdef USE_MAP
  vec2 ferryPavingUv = vFerryPavingWorldPosition.xz / ${repeat};
  vec4 ferryPavingSample = texture2D(map, ferryPavingUv);
  ferryPavingSample.rgb *= vec3(0.94, 0.91, 0.85);
  diffuseColor *= mix(vec4(1.0), ferryPavingSample, vFerryPavingAlbedoMix * ${textureMix});
#endif`);
  };
  material.customProgramCacheKey = () => `ferry-world-paving-${repeat}-${textureMix}`;
}

function makeMaterials() {
  const pavingAlbedo = createPavingAlbedo();
  const pavingRoughnessMap = createPavingTexture({ roughness: true });
  const materials = {
    curb: createStandardMaterial(PALETTE.curb, 0.82),
    sidewalk: createStandardMaterial(PALETTE.sidewalk, 0.9),
    tactile: createStandardMaterial(PALETTE.tactile, 0.78, 0.04),
    paving: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: pavingAlbedo.fallback,
      roughnessMap: pavingRoughnessMap,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.72,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    pavingBorder: createStandardMaterial(PALETTE.pavingBorder, 0.86),
    marking: createStandardMaterial(PALETTE.marking, 0.5),
    // This remains an instanced road-edge batch. The cooler, lower-roughness
    // finish makes the real curb return legible as a layered road-to-plaza
    // threshold instead of a single flat asphalt edge.
    drain: createStandardMaterial(PALETTE.gutter, 0.34, 0.42, { vertexColors: true }),
    utility: createStandardMaterial(PALETTE.utility, 0.42, 0.54),
    iron: createStandardMaterial(PALETTE.iron, 0.34, 0.78),
    planter: createStandardMaterial(PALETTE.planter, 0.72, 0.14),
    leaf: createStandardMaterial(PALETTE.leaf, 0.96),
    facade: createStandardMaterial(PALETTE.facade, 0.74),
    facadeShadow: createStandardMaterial(PALETTE.facadeShadow, 0.82),
    glass: createStandardMaterial(PALETTE.glass, 0.26, 0.38),
  };
  addWorldProjectedPavingShader(materials.paving);
  return { materials, pavingAlbedo, pavingRoughnessMap };
}

function makeBatches(root, materialState) {
  const { materials, pavingAlbedo, pavingRoughnessMap } = materialState;
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const pavingCube = cube.clone();
  pavingCube.setAttribute('pavingAlbedoMix', new THREE.InstancedBufferAttribute(new Float32Array(96), 1));
  const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const disc = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
  const batches = {
    curb: makeBatch(root, 'OSM-aligned curb returns', cube, materials.curb, 36),
    sidewalk: makeBatch(root, 'Ferry Plaza sidewalk slabs', cube, materials.sidewalk, 48),
    tactile: makeBatch(root, 'Source-derived tactile crossing plates', cube, materials.tactile, 8),
    tactileDots: makeBatch(root, 'Source-derived tactile warning dots', disc, materials.tactile, 16),
    drain: makeBatch(root, 'Road-edge gutters and curb drains', cube, materials.drain, 24),
    paving: makeBatch(root, 'Market Street OSM paving finish', pavingCube, materials.paving, 96),
    pavingBorder: makeBatch(root, 'Market Street paving edge courses', cube, materials.pavingBorder, 48),
    // The tactile warning field uses eleven released seam instances while
    // preserving the compact 360-instance near-field budget.
    seams: makeBatch(root, 'Sidewalk expansion seams', cube, materials.facadeShadow, 69),
    marking: makeBatch(root, 'OSM road markings', cube, materials.marking, 96),
    utility: makeBatch(root, 'Drain and access covers', disc, materials.utility, 30),
    bollard: makeBatch(root, 'Ferry Plaza bollards', cylinder, materials.iron, 40),
    benchSeat: makeBatch(root, 'Public benches seats', cube, materials.iron, 10),
    benchLeg: makeBatch(root, 'Public benches legs', cube, materials.iron, 20),
    planter: makeBatch(root, 'Plaza planters', disc, materials.planter, 10),
    planting: makeBatch(root, 'Plaza planting', cylinder, materials.leaf, 10),
    facade: makeBatch(root, 'Ferry Building facade relief', cube, materials.facade, 12),
    facadeTrim: makeBatch(root, 'Ferry Building facade trim', cube, materials.facadeShadow, 22),
    facadeGlass: makeBatch(root, 'Ferry Building storefront glazing', cube, materials.glass, 24),
    geometries: [cube, pavingCube, cylinder, disc],
    textures: [...pavingAlbedo.textures, pavingRoughnessMap],
    materials: Object.values(materials),
  };
  batches.paving.mesh.castShadow = false;
  batches.pavingBorder.mesh.castShadow = false;
  return batches;
}

function setBatchColors(batch, colorAt) {
  for (let index = 0; index < batch.mesh.count; index += 1) batch.mesh.setColorAt(index, colorAt(index));
  if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
  batch.mesh.instanceMatrix.needsUpdate = true;
}

function isUsablePoint(x, z, bounds, isSea) {
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ && !isSea(x, z);
}

function addPavingDetail(batches, pavingPaths, terrainElevation, bounds, isSea, matrix) {
  const stoneColor = new THREE.Color(PALETTE.pavingStone);
  const concreteColor = new THREE.Color(PALETTE.pavingConcrete);
  const asphaltColor = new THREE.Color(PALETTE.pavingAsphalt);
  for (const path of pavingPaths) {
    forEachSegment(path, ({ a, dx, dz, length, angle }) => {
      const nx = -dz / length;
      const nz = dx / length;
      const chunks = Math.max(1, Math.ceil(length / 4.8));
      const chunkLength = length / chunks;
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        const distance = chunkLength * (chunk + 0.5);
        const x = a[0] + (dx / length) * distance;
        const z = a[1] + (dz / length) * distance;
        if (!isUsablePoint(x, z, bounds, isSea)) continue;
        const surfaceY = terrainElevation(x, z);
        const isPavingStone = path.surface === 'paving_stones';
        const baseColor = path.surface === 'asphalt'
          ? asphaltColor
          : path.surface === 'concrete' ? concreteColor : stoneColor;
        // The source-derived paving tone remains the base. The image is mixed
        // in the shader, rather than multiplied at full strength, to keep the
        // route continuous with its warm-gray surrounding surfaces.
        const color = (isPavingStone
          ? stoneColor.clone().lerp(new THREE.Color(0xffffff), 0.28)
          : baseColor.clone())
          .offsetHSL(0, 0, (hash11(path.id + chunk * 17) - 0.5) * (isPavingStone ? 0.018 : 0.08));
        put(batches.paving, boxMatrix(matrix, x, surfaceY + 0.014, z,
          Math.max(0.4, chunkLength + 0.012), 0.028, path.width, angle), color,
        isPavingStone ? 1 : 0);
      }

      for (const side of [-1, 1]) {
        const x = a[0] + dx * 0.5 + nx * side * (path.width * 0.5 - 0.045);
        const z = a[1] + dz * 0.5 + nz * side * (path.width * 0.5 - 0.045);
        if (!isUsablePoint(x, z, bounds, isSea)) continue;
        put(batches.pavingBorder, boxMatrix(matrix, x, terrainElevation(x, z) + 0.014, z,
          Math.max(0.4, length + 0.01), 0.028, 0.045, angle));
      }
    });
  }
}

function addDerivedCrossings(batches, roads, pavingPaths, roadElevation, bounds, isSea, matrix) {
  const crossingRoadIds = new Set([283512618, 850162147]);
  const marketApproachPathIds = new Set([779448275, 779448274, 779448273, 151632675, 779448272, 779448271, 1189071403]);
  let crossingCount = 0;
  for (const road of roads) {
    if (!crossingRoadIds.has(Number(road.id))) continue;
    forEachSegment(road, (roadSegment) => {
      const ux = roadSegment.dx / roadSegment.length;
      const uz = roadSegment.dz / roadSegment.length;
      for (const path of pavingPaths) {
        if (!marketApproachPathIds.has(Number(path.id))) continue;
        forEachSegment(path, (pathSegment) => {
          const intersection = segmentIntersection(roadSegment, pathSegment);
          if (!intersection || !isUsablePoint(intersection.x, intersection.z, bounds, isSea)) return;
          for (let stripe = -3; stripe <= 3; stripe += 1) {
            const x = intersection.x + ux * stripe * 0.76;
            const z = intersection.z + uz * stripe * 0.76;
            put(batches.marking, boxMatrix(matrix, x, roadElevation(x, z) + 0.016, z,
              0.46, 0.024, Math.max(2.8, road.width - 0.7), roadSegment.angle));
          }
          crossingCount += 1;
        });
      }
    });
  }
  return crossingCount;
}

function deriveCurbTransitions(roads, pavingPaths, bounds, isSea) {
  // These transitions are inferred only where a named source road and a
  // source pedestrian approach geometrically meet. They are not guessed at
  // arbitrary junctions, which keeps curb cuts bounded to the OSM evidence.
  const crossingRoadIds = new Set([283512618, 850162147]);
  const marketApproachPathIds = new Set([
    779448275, 779448274, 779448273, 151632675, 779448272, 779448271, 1189071403,
  ]);
  const transitions = [];
  for (const road of roads) {
    if (!crossingRoadIds.has(Number(road.id))) continue;
    forEachSegment(road, (roadSegment) => {
      for (const path of pavingPaths) {
        if (!marketApproachPathIds.has(Number(path.id))) continue;
        forEachSegment(path, (pathSegment) => {
          const intersection = segmentIntersection(roadSegment, pathSegment);
          if (!intersection || !isUsablePoint(intersection.x, intersection.z, bounds, isSea)) return;
          transitions.push(Object.freeze({
            roadId: Number(road.id),
            segmentIndex: roadSegment.index,
            distance: roadSegment.length * intersection.firstT,
            x: intersection.x,
            z: intersection.z,
          }));
        });
      }
    });
  }
  return transitions;
}

function addCurbTransitionDetail(
  batches, transitions, roads, roadElevation, sidewalkElevation, bounds, isSea, layers, matrix,
) {
  const tactileColor = new THREE.Color(PALETTE.tactile);
  let tactilePlates = 0;
  let tactileDots = 0;
  let drainBars = 0;
  let curbRamps = 0;
  for (const transition of transitions) {
    const road = roads.find((candidate) => Number(candidate.id) === transition.roadId);
    if (!road) continue;
    let segment = null;
    forEachSegment(road, (candidate) => {
      if (candidate.index === transition.segmentIndex) segment = candidate;
    });
    if (!segment) continue;
    const nx = -segment.dz / segment.length;
    const nz = segment.dx / segment.length;
    const halfRoad = road.width * 0.5;
    for (const side of [-1, 1]) {
      const curbX = transition.x + nx * side * (halfRoad + 0.08);
      const curbZ = transition.z + nz * side * (halfRoad + 0.08);
      if (!isUsablePoint(curbX, curbZ, bounds, isSea)) continue;
      const roadY = roadElevation(curbX, curbZ);
      // A shallow transition replaces the missing raised curb section. It is
      // emitted only when this module owns curbs; live base curbs remain the
      // authoritative curb volume and are never double-ribboned here.
      if (layers.curbs) {
        put(batches.curb, boxMatrix(matrix, curbX, roadY + 0.028, curbZ,
          2.55, 0.056, 0.42, segment.angle));
        curbRamps += 1;
      }
      const tactileX = transition.x + nx * side * (halfRoad + 0.47);
      const tactileZ = transition.z + nz * side * (halfRoad + 0.47);
      if (isUsablePoint(tactileX, tactileZ, bounds, isSea)) {
        put(batches.tactile, boxMatrix(matrix, tactileX, sidewalkElevation(tactileX, tactileZ) + 0.012, tactileZ,
          1.62, 0.024, 0.58, segment.angle), tactileColor);
        tactilePlates += 1;
        // Four shallow warning dots form a readable tactile field without
        // widening the source-derived plate. Their bottom sits on the plate,
        // so neither clear nor wet presentation can show a floating gap.
        for (const along of [-0.31, 0.31]) {
          for (const across of [-0.13, 0.13]) {
            const dotX = tactileX + (segment.dx / segment.length) * along + nx * side * across;
            const dotZ = tactileZ + (segment.dz / segment.length) * along + nz * side * across;
            put(batches.tactileDots, cylinderMatrix(matrix, dotX,
              sidewalkElevation(dotX, dotZ) + 0.044, dotZ, 0.074, 0.04, 0.074));
            tactileDots += 1;
          }
        }
      }
      // Three inset bars give each source-derived drain a readable grate
      // rhythm without creating a broad road overlay or a new road ribbon.
      for (const offset of [-0.17, 0, 0.17]) {
        const drainX = transition.x + segment.dx / segment.length * offset + nx * side * (halfRoad - 0.13);
        const drainZ = transition.z + segment.dz / segment.length * offset + nz * side * (halfRoad - 0.13);
        if (!isUsablePoint(drainX, drainZ, bounds, isSea)) continue;
        put(batches.drain, boxMatrix(matrix, drainX, roadElevation(drainX, drainZ) + 0.014, drainZ,
          0.055, 0.018, 0.42, segment.angle));
        drainBars += 1;
      }
    }
  }
  if (batches.tactile.mesh.instanceColor) batches.tactile.mesh.instanceColor.needsUpdate = true;
  return Object.freeze({ tactilePlates, tactileDots, drainBars, curbRamps });
}

function addRoadDetail(batches, roads, roadElevation, sidewalkElevation, bounds, isSea, layers, transitions, matrix) {
  const curbColor = new THREE.Color();
  const slabColor = new THREE.Color();
  let detailSeed = 1;
  let roadEdgeGutters = 0;
  for (const road of roads) {
    forEachSegment(road, ({ a, b, dx, dz, length, angle, index }) => {
      const nx = -dz / length;
      const nz = dx / length;
      const midpointX = (a[0] + b[0]) * 0.5;
      const midpointZ = (a[1] + b[1]) * 0.5;
      const halfRoad = road.width * 0.5;
      const edgeInset = Math.max(0.18, halfRoad - 0.28);
      const curbCuts = transitions
        .filter((transition) => Number(road.id) === transition.roadId && transition.segmentIndex === index)
        .map((transition) => ({
          start: clamp(transition.distance - 1.3, 0, length),
          end: clamp(transition.distance + 1.3, 0, length),
        }))
        .sort((first, second) => first.start - second.start);
      const curbRuns = [];
      let curbRunStart = 0;
      for (const cut of curbCuts) {
        if (cut.start - curbRunStart > 0.22) curbRuns.push([curbRunStart, cut.start]);
        curbRunStart = Math.max(curbRunStart, cut.end);
      }
      if (length - curbRunStart > 0.22) curbRuns.push([curbRunStart, length]);

      // Curb faces and capstones are separate shallow pieces. The split gives
      // a near camera an actual top highlight and vertical edge, while curb
      // cuts remove only source-derived crossing spans.
      for (const side of [-1, 1]) {
        const curbX = midpointX + nx * side * (halfRoad + 0.08);
        const curbZ = midpointZ + nz * side * (halfRoad + 0.08);
        if (isUsablePoint(curbX, curbZ, bounds, isSea)) {
          if (layers.curbs) {
            for (const [start, end] of curbRuns) {
              const span = end - start;
              const distance = (start + end) * 0.5;
              const x = a[0] + dx * (distance / length) + nx * side * (halfRoad + 0.08);
              const z = a[1] + dz * (distance / length) + nz * side * (halfRoad + 0.08);
              const y = roadElevation(x, z);
              put(batches.curb, boxMatrix(matrix, x, y + 0.055, z, span, 0.11, 0.14, angle));
              put(batches.curb, boxMatrix(matrix, x, y + 0.13, z, span + 0.012, 0.04, 0.27, angle));
            }
          }
          if (layers.sidewalkSlabs) {
            put(batches.sidewalk, boxMatrix(matrix,
              midpointX + nx * side * (halfRoad + 1.22), roadElevation(curbX, curbZ) + 0.04,
              midpointZ + nz * side * (halfRoad + 1.22), length + 0.14, 0.08, 2.05, angle));
          }
        }
        // The narrow gutter is a material-only road-edge variation. It stays
        // inboard of an authoritative base curb, so it does not recreate or
        // stack a curb/sidewalk ribbon when the caller owns those layers.
        const gutterX = midpointX + nx * side * (halfRoad - 0.17);
        const gutterZ = midpointZ + nz * side * (halfRoad - 0.17);
        if (isUsablePoint(gutterX, gutterZ, bounds, isSea)) {
          put(batches.drain, boxMatrix(matrix, gutterX, roadElevation(gutterX, gutterZ) + 0.013, gutterZ,
            length - 0.16, 0.018, 0.28, angle));
          roadEdgeGutters += 1;
        }
      }

      // Centre dashes use OSM lane centerlines rather than a replacement road mesh.
      for (let distance = 3.2; distance < length - 2; distance += 8.6) {
        const progress = distance / length;
        const x = a[0] + dx * progress;
        const z = a[1] + dz * progress;
        if (isUsablePoint(x, z, bounds, isSea)) {
          put(batches.marking, boxMatrix(matrix, x, roadElevation(x, z) + 0.012, z, 3.35, 0.018, 0.13, angle));
        }
      }

      if (road.id === 283512618 || road.id === 850162147) {
        for (const side of [-1, 1]) {
          const edgeX = midpointX + nx * side * road.width * 0.42;
          const edgeZ = midpointZ + nz * side * road.width * 0.42;
          if (isUsablePoint(edgeX, edgeZ, bounds, isSea)) {
            put(batches.marking, boxMatrix(matrix, edgeX, roadElevation(edgeX, edgeZ) + 0.013, edgeZ,
              length - 0.3, 0.018, 0.1, angle));
          }
        }
      }

      const seamCount = Math.floor(length / 5.8);
      for (let seam = 1; seam <= seamCount; seam += 1) {
        const progress = seam / (seamCount + 1);
        for (const side of [-1, 1]) {
          const x = a[0] + dx * progress + nx * side * (halfRoad + 1.22);
          const z = a[1] + dz * progress + nz * side * (halfRoad + 1.22);
          if (isUsablePoint(x, z, bounds, isSea)) {
            put(batches.seams, boxMatrix(matrix, x, sidewalkElevation(x, z) + 0.004, z, 0.034, 0.008, 1.97, angle));
          }
        }
      }

      // Crosswalk stripes occur only at this segment's OSM endpoint, avoiding
      // a guessed intersection surface.
      if (road.id === 26769726 || road.id === 88463826) {
        const crossAt = road.id === 26769726 ? 0.12 : 0.78;
        for (let stripe = -2; stripe <= 2; stripe += 1) {
          const progress = clamp(crossAt + (stripe * 0.017), 0.04, 0.96);
          const x = a[0] + dx * progress;
          const z = a[1] + dz * progress;
          if (isUsablePoint(x, z, bounds, isSea)) {
            put(batches.marking, boxMatrix(matrix, x, roadElevation(x, z) + 0.013, z, 0.58, 0.02, Math.max(2.8, road.width - 0.95), angle));
          }
        }
      }

      // Grates sit just inboard from a real curb; access covers stay inside the
      // road. Placement is deterministic but visually non-repeating.
      for (let distance = 8; distance < length - 4; distance += 18) {
        const progress = distance / length;
        const side = detailSeed % 2 ? 1 : -1;
        const x = a[0] + dx * progress + nx * side * edgeInset;
        const z = a[1] + dz * progress + nz * side * edgeInset;
        if (isUsablePoint(x, z, bounds, isSea)) {
          const size = detailSeed % 3 === 0 ? 0.78 : 0.46;
          put(batches.utility, cylinderMatrix(matrix, x, roadElevation(x, z) + 0.01, z, size, 0.02, size, angle + Math.PI / 4));
        }
        detailSeed += 1;
      }
    });
  }
  setBatchColors(batches.curb, (index) => curbColor.setHex(PALETTE.curb).offsetHSL(0, 0, (hash11(index + 4) - 0.5) * 0.09));
  setBatchColors(batches.sidewalk, (index) => slabColor.setHex(PALETTE.sidewalk).offsetHSL(0, 0, (hash11(index + 19) - 0.5) * 0.11));
  return roadEdgeGutters;
}

function addPlazaFurniture(batches, sidewalkElevation, bounds, isSea, matrix) {
  const fixtures = [
    [2317.2, 1833.8, 0.78], [2299.6, 1821.9, 0.78], [2339.5, 1851.6, 0.78],
    [2350.1, 1862.3, 0.78], [2311.5, 1832.3, 0.78], [2287.1, 1793.9, 0.78],
  ];
  fixtures.forEach(([x, z, scale], index) => {
    if (!isUsablePoint(x, z, bounds, isSea)) return;
    const y = sidewalkElevation(x, z);
    put(batches.bollard, cylinderMatrix(matrix, x, y + 0.48, z, 0.16 * scale, 0.92, 0.16 * scale));
    if (index % 2 === 0) {
      put(batches.planter, cylinderMatrix(matrix, x + 1.35, y + 0.28, z - 0.7, 0.72, 0.5, 0.72));
      put(batches.planting, cylinderMatrix(matrix, x + 1.35, y + 0.72, z - 0.7, 0.66, 0.48, 0.66));
    }
  });

  const benches = [[2326.2, 1842.2, 0.78], [2343.8, 1859.6, 0.78], [2306.9, 1828.1, 0.78]];
  for (const [x, z, yaw] of benches) {
    if (!isUsablePoint(x, z, bounds, isSea)) continue;
    const y = sidewalkElevation(x, z);
    put(batches.benchSeat, boxMatrix(matrix, x, y + 0.47, z, 1.65, 0.11, 0.45, yaw));
    for (const side of [-1, 1]) {
      const lx = x + Math.cos(yaw) * side * 0.57;
      const lz = z + Math.sin(yaw) * side * 0.57;
      put(batches.benchLeg, boxMatrix(matrix, lx, y + 0.25, lz, 0.1, 0.45, 0.38, yaw));
    }
  }
}

function addFerryFacadeRelief(batches, terrainElevation, bounds, isSea, matrix) {
  // This is a shallow overlay on the named OSM Ferry Building footprint edge,
  // not an alternative landmark volume. It reads as storefront depth at street
  // distance while letting the existing footprint / height remain authoritative.
  const a = [2307.3, 1869.2];
  const b = [2324.9, 1845.3];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);
  const nx = -dz / length;
  const nz = dx / length;
  const midX = (a[0] + b[0]) * 0.5 + nx * 0.08;
  const midZ = (a[1] + b[1]) * 0.5 + nz * 0.08;
  if (!isUsablePoint(midX, midZ, bounds, isSea)) return;
  // Building relief follows terrain/building datum, never the raised road
  // surface. Applying roadSurfaceLift here detached the storefront vertically.
  const base = terrainElevation(midX, midZ) + 0.02;
  put(batches.facade, boxMatrix(matrix, midX, base + 2.06, midZ, length, 4.1, 0.18, angle));
  put(batches.facadeTrim, boxMatrix(matrix, midX, base + 0.38, midZ + nz * 0.12, length + 0.26, 0.18, 0.3, angle));
  put(batches.facadeTrim, boxMatrix(matrix, midX, base + 4.05, midZ + nz * 0.12, length + 0.42, 0.22, 0.34, angle));
  const bays = 7;
  for (let index = 0; index < bays; index += 1) {
    const progress = (index + 0.5) / bays;
    const x = a[0] + dx * progress + nx * 0.19;
    const z = a[1] + dz * progress + nz * 0.19;
    put(batches.facadeGlass, boxMatrix(matrix, x, base + 2.06, z, 1.42, 2.42, 0.05, angle));
    put(batches.facadeTrim, boxMatrix(matrix, x, base + 3.43, z + nz * 0.07, 1.55, 0.13, 0.14, angle));
  }
}

function finishBatches(batches) {
  const meshes = Object.values(batches).filter((item) => item?.mesh).map((item) => item.mesh);
  for (const mesh of meshes) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const albedoMix = mesh.geometry.getAttribute('pavingAlbedoMix');
    if (albedoMix) albedoMix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
  return meshes;
}

function countTriangles(meshes) {
  return meshes.reduce((total, mesh) => total + ((mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3) * mesh.count, 0);
}

/**
 * Create a detachable Ferry Plaza detail group.
 *
 * `elevationAt(x, z)` (or legacy `getElevation`) should return terrain height.
 * `isSea(x, z)` can reject shoreline positions; a seaLevel fallback is kept for
 * integrations that have no shoreline predicate. `roads` may contain either
 * flat OSM `[x, z, ...]` arrays or nested `[x, z]` pairs. Only known hero
 * source IDs are consumed; defaults are used when none of those caller roads
 * contain a valid line. Width resolves from explicit source width fields, then
 * lanes/lane width, then the conservative eight-metre fallback.
 *
 * Pass `existingSurfaceLayers: { curbs: true, sidewalks: true }` when the
 * runtime already rendered those volumes. Their curb/sidewalk meshes remain
 * empty while narrow road-surface details, seams, utility detail, furniture,
 * and markings stay enabled. Optional
 * `roadSurfaceElevationAt` and `sidewalkSurfaceElevationAt` callbacks return
 * final world-space surface heights and take precedence over lift inference.
 */
export function createFerryBuildingStreetscape(options = {}) {
  const scene = options.scene;
  if (!scene?.isObject3D) throw new Error('createFerryBuildingStreetscape requires a Three.js scene or parent group.');
  const parent = options.parent?.isObject3D ? options.parent : scene;
  const bounds = { ...DEFAULT_BOUNDS, ...(options.tileBounds || options.bounds || {}) };
  const elevationAt = typeof options.elevationAt === 'function'
    ? options.elevationAt
    : typeof options.getElevation === 'function' ? options.getElevation : () => 0;
  const roadSurfaceLift = Number.isFinite(options.roadSurfaceLift) ? options.roadSurfaceLift : 0.04;
  const existingSurfaceLayers = options.existingSurfaceLayers || {};
  const layers = Object.freeze({
    curbs: options.includeCurbs !== false && !existingSurfaceLayers.curbs,
    sidewalkSlabs: options.includeSidewalkSlabs !== false && !existingSurfaceLayers.sidewalks,
  });
  const seaLevel = Number.isFinite(options.seaLevel) ? options.seaLevel : -Infinity;
  const isSea = typeof options.isSea === 'function'
    ? options.isSea
    : (x, z) => elevationAt(x, z) <= seaLevel;
  const terrainElevation = (x, z) => {
    const result = Number(elevationAt(x, z));
    return Number.isFinite(result) ? result : 0;
  };
  const roadSurfaceElevationAt = typeof options.roadSurfaceElevationAt === 'function'
    ? options.roadSurfaceElevationAt
    : null;
  const sidewalkSurfaceElevationAt = typeof options.sidewalkSurfaceElevationAt === 'function'
    ? options.sidewalkSurfaceElevationAt
    : null;
  const roadElevation = (x, z) => {
    const sampled = roadSurfaceElevationAt ? Number(roadSurfaceElevationAt(x, z)) : NaN;
    return Number.isFinite(sampled) ? sampled : terrainElevation(x, z) + roadSurfaceLift;
  };
  const sidewalkElevation = (x, z) => {
    const sampled = sidewalkSurfaceElevationAt ? Number(sidewalkSurfaceElevationAt(x, z)) : NaN;
    return Number.isFinite(sampled) ? sampled : roadElevation(x, z) + 0.08;
  };
  const roads = normaliseRoads(options.roads);
  const pavingPaths = normalisePavingPaths(options.roads);
  const root = new THREE.Group();
  root.name = 'Ferry Plaza source-aligned hero streetscape';
  root.userData.heroStreetscape = true;
  root.userData.source = FERRY_BUILDING_STREETSCAPE_SOURCE;
  parent.add(root);

  const materialState = makeMaterials();
  const { materials, pavingAlbedo } = materialState;
  const batches = makeBatches(root, materialState);
  const matrix = new THREE.Matrix4();
  addPavingDetail(batches, pavingPaths, terrainElevation, bounds, isSea, matrix);
  const curbTransitions = deriveCurbTransitions(roads, pavingPaths, bounds, isSea);
  const roadEdgeGutters = addRoadDetail(
    batches, roads, roadElevation, sidewalkElevation, bounds, isSea, layers, curbTransitions, matrix,
  );
  const curbTransitionDetail = addCurbTransitionDetail(
    batches, curbTransitions, roads, roadElevation, sidewalkElevation, bounds, isSea, layers, matrix,
  );
  const derivedCrossings = addDerivedCrossings(
    batches, roads, pavingPaths, roadElevation, bounds, isSea, matrix,
  );
  addPlazaFurniture(batches, sidewalkElevation, bounds, isSea, matrix);
  addFerryFacadeRelief(batches, terrainElevation, bounds, isSea, matrix);
  const drainColor = new THREE.Color();
  setBatchColors(batches.drain, (index) => (index < roadEdgeGutters
    ? drainColor.setHex(PALETTE.gutter).offsetHSL(0, 0, (hash11(index + 37) - 0.5) * 0.08)
    : drainColor.setHex(PALETTE.drain).offsetHSL(0, 0, (hash11(index + 61) - 0.5) * 0.06)));
  const meshes = finishBatches(batches);
  const stats = Object.freeze({
    drawCalls: meshes.filter((mesh) => mesh.count > 0).length,
    instances: meshes.reduce((total, mesh) => total + mesh.count, 0),
    triangles: countTriangles(meshes),
    roads: roads.map(({ id, name, width }) => ({ id, name, width })),
    pavingPaths: pavingPaths.map(({ id, name, surface, width }) => ({ id, name, surface, width })),
    derivedCrossings,
    curbTransitions: curbTransitions.map(({ roadId, segmentIndex, distance, x, z }) => ({
      roadId, segmentIndex, distance, x, z,
    })),
    curbTransitionDetail,
    roadEdgeGutters,
    layers,
  });
  if (stats.drawCalls > FERRY_BUILDING_STREETSCAPE_BUDGET.maxDrawCalls
    || stats.instances > FERRY_BUILDING_STREETSCAPE_BUDGET.maxInstances
    || stats.triangles > FERRY_BUILDING_STREETSCAPE_BUDGET.maxTriangles) {
    root.removeFromParent();
    for (const geometry of batches.geometries) geometry.dispose();
    for (const texture of [...new Set([...batches.textures, ...pavingAlbedo.textures])]) texture.dispose();
    for (const material of batches.materials) material.dispose();
    throw new Error('Ferry Building streetscape exceeded its static rendering budget.');
  }

  let elapsed = 0;
  let wetness = clamp(Number(options.wetness) || 0, 0, 1);
  let disposed = false;
  const generatedAlbedoRequested = pavingAlbedo.loadInto(materials.paving, () => !disposed);
  const dryRoughness = new Map(batches.materials.map((material) => [material, material.roughness]));
  const pavingDryColor = materials.paving.color.clone();

  function setConditions(next = {}) {
    if (disposed) return wetness;
    wetness = clamp(Number.isFinite(next.wetness) ? next.wetness : wetness, 0, 1);
    for (const material of batches.materials) {
      const dry = dryRoughness.get(material);
      // Wet plaza stone and curb-edge channels need a broad enough PBR shift
      // to read in a moving drizzle card, not merely in an inspector. This is
      // material-only: source road/shore geometry and batch counts stay fixed.
      const wetTarget = material === materials.leaf ? Math.min(dry, 0.58) : Math.min(dry, 0.14);
      const response = material === materials.leaf ? 0.25 : 0.92;
      material.roughness = THREE.MathUtils.lerp(dry, wetTarget, wetness * response);
      material.needsUpdate = true;
    }
    materials.paving.color.copy(pavingDryColor).lerp(new THREE.Color(0x5e6b70), wetness * 0.34);
    materials.paving.envMapIntensity = THREE.MathUtils.lerp(0.72, 1.34, wetness);
    materials.paving.needsUpdate = true;
    return wetness;
  }

  function update(deltaSeconds = 0) {
    if (disposed) return;
    elapsed += clamp(Number(deltaSeconds) || 0, 0, MAX_DELTA_SECONDS);
    // A restrained wet sheen is material-only: no animated geometry or new draw.
    materials.glass.emissive.setRGB(0.01 + wetness * 0.012, 0.014 + wetness * 0.012, 0.014 + wetness * 0.014);
    materials.glass.emissiveIntensity = 0.08 + Math.sin(elapsed * 0.45) * 0.006;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    for (const geometry of batches.geometries) geometry.dispose();
    for (const texture of [...new Set([...batches.textures, ...pavingAlbedo.textures])]) texture.dispose();
    for (const material of batches.materials) material.dispose();
  }

  setConditions({ wetness });
  return Object.freeze({
    root,
    stats: Object.freeze({
      ...stats,
      pavingAlbedo: Object.freeze({
        source: generatedAlbedoRequested ? FERRY_PLAZA_PAVER_ALBEDO_PATH : 'procedural-fallback',
        physicalRepeatMeters: FERRY_PLAZA_PAVER_REPEAT_METERS,
        generatedAlbedoRequested,
      }),
    }),
    update,
    setConditions,
    dispose,
    get disposed() { return disposed; },
  });
}
