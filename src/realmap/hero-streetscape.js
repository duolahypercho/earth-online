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
  maxInstances: 220,
  maxTriangles: 9200,
});

export const FERRY_BUILDING_STREETSCAPE_SOURCE = Object.freeze({
  dataset: 'OpenStreetMap SF city snapshot',
  roadIds: Object.freeze([26769726, 88463826, 88463827, 88463831]),
  ferryBuildingWay: 558731934,
});

const DEFAULT_BOUNDS = Object.freeze({ minX: 2144, minZ: 1728, maxX: 2528, maxZ: 2112 });
const MAX_DELTA_SECONDS = 0.05;
const DEFAULT_ROADS = Object.freeze([
  { id: 26769726, name: 'Ferry Plaza', width: 7.1, points: [[2320.3, 1820.6], [2372.5, 1871.6]] },
  { id: 88463826, name: 'The Embarcadero', width: 11.8, points: [[2314.9, 1815.0], [2295.6, 1837.9]] },
  { id: 88463827, name: 'The Embarcadero', width: 11.8, points: [[2357.4, 1738.2], [2389.0, 1702.0]] },
  { id: 88463831, name: 'Mission Street', width: 10.2, points: [[2357.4, 1738.2], [2304.7, 1685.8]] },
]);

const PALETTE = Object.freeze({
  curb: 0x9da3a1,
  sidewalk: 0x7c8584,
  marking: 0xe7dfc2,
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

function put(batch, matrix, color) {
  const index = batch.mesh.count;
  if (index >= batch.capacity) return false;
  batch.mesh.setMatrixAt(index, matrix);
  if (color) batch.mesh.setColorAt(index, color);
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

function makeMaterials() {
  return {
    curb: createStandardMaterial(PALETTE.curb, 0.82),
    sidewalk: createStandardMaterial(PALETTE.sidewalk, 0.9),
    marking: createStandardMaterial(PALETTE.marking, 0.5),
    utility: createStandardMaterial(PALETTE.utility, 0.42, 0.54),
    iron: createStandardMaterial(PALETTE.iron, 0.34, 0.78),
    planter: createStandardMaterial(PALETTE.planter, 0.72, 0.14),
    leaf: createStandardMaterial(PALETTE.leaf, 0.96),
    facade: createStandardMaterial(PALETTE.facade, 0.74),
    facadeShadow: createStandardMaterial(PALETTE.facadeShadow, 0.82),
    glass: createStandardMaterial(PALETTE.glass, 0.26, 0.38),
  };
}

function makeBatches(root, materials) {
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const disc = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
  return {
    curb: makeBatch(root, 'OSM-aligned curb returns', cube, materials.curb, 36),
    sidewalk: makeBatch(root, 'Ferry Plaza sidewalk slabs', cube, materials.sidewalk, 48),
    seams: makeBatch(root, 'Sidewalk expansion seams', cube, materials.facadeShadow, 80),
    marking: makeBatch(root, 'OSM road markings', cube, materials.marking, 66),
    utility: makeBatch(root, 'Drain and access covers', disc, materials.utility, 30),
    bollard: makeBatch(root, 'Ferry Plaza bollards', cylinder, materials.iron, 40),
    benchSeat: makeBatch(root, 'Public benches seats', cube, materials.iron, 10),
    benchLeg: makeBatch(root, 'Public benches legs', cube, materials.iron, 20),
    planter: makeBatch(root, 'Plaza planters', disc, materials.planter, 10),
    planting: makeBatch(root, 'Plaza planting', cylinder, materials.leaf, 10),
    facade: makeBatch(root, 'Ferry Building facade relief', cube, materials.facade, 12),
    facadeTrim: makeBatch(root, 'Ferry Building facade trim', cube, materials.facadeShadow, 22),
    facadeGlass: makeBatch(root, 'Ferry Building storefront glazing', cube, materials.glass, 24),
    geometries: [cube, cylinder, disc],
    materials: Object.values(materials),
  };
}

function setBatchColors(batch, colorAt) {
  for (let index = 0; index < batch.mesh.count; index += 1) batch.mesh.setColorAt(index, colorAt(index));
  if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
  batch.mesh.instanceMatrix.needsUpdate = true;
}

function isUsablePoint(x, z, bounds, isSea) {
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ && !isSea(x, z);
}

function addRoadDetail(batches, roads, roadElevation, sidewalkElevation, bounds, isSea, layers, matrix) {
  const curbColor = new THREE.Color();
  const slabColor = new THREE.Color();
  let detailSeed = 1;
  for (const road of roads) {
    forEachSegment(road, ({ a, b, dx, dz, length, angle }) => {
      const nx = -dz / length;
      const nz = dx / length;
      const midpointX = (a[0] + b[0]) * 0.5;
      const midpointZ = (a[1] + b[1]) * 0.5;
      const halfRoad = road.width * 0.5;
      const edgeInset = Math.max(0.18, halfRoad - 0.28);

      // Two shallow curb runs and sidewalk bands follow existing OSM centerlines.
      for (const side of [-1, 1]) {
        const curbX = midpointX + nx * side * (halfRoad + 0.08);
        const curbZ = midpointZ + nz * side * (halfRoad + 0.08);
        if (isUsablePoint(curbX, curbZ, bounds, isSea)) {
          if (layers.curbs) {
            put(batches.curb, boxMatrix(matrix, curbX, roadElevation(curbX, curbZ) + 0.08, curbZ, length + 0.2, 0.16, 0.24, angle));
          }
          if (layers.sidewalkSlabs) {
            put(batches.sidewalk, boxMatrix(matrix,
              midpointX + nx * side * (halfRoad + 1.22), roadElevation(curbX, curbZ) + 0.04,
              midpointZ + nz * side * (halfRoad + 1.22), length + 0.14, 0.08, 2.05, angle));
          }
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
 * runtime already rendered those volumes. Their meshes remain empty while
 * seams, utility detail, furniture, and markings stay enabled. Optional
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
  const root = new THREE.Group();
  root.name = 'Ferry Plaza source-aligned hero streetscape';
  root.userData.heroStreetscape = true;
  root.userData.source = FERRY_BUILDING_STREETSCAPE_SOURCE;
  parent.add(root);

  const materials = makeMaterials();
  const batches = makeBatches(root, materials);
  const matrix = new THREE.Matrix4();
  addRoadDetail(batches, roads, roadElevation, sidewalkElevation, bounds, isSea, layers, matrix);
  addPlazaFurniture(batches, sidewalkElevation, bounds, isSea, matrix);
  addFerryFacadeRelief(batches, terrainElevation, bounds, isSea, matrix);
  const meshes = finishBatches(batches);
  const stats = Object.freeze({
    drawCalls: meshes.filter((mesh) => mesh.count > 0).length,
    instances: meshes.reduce((total, mesh) => total + mesh.count, 0),
    triangles: countTriangles(meshes),
    roads: roads.map(({ id, name, width }) => ({ id, name, width })),
    layers,
  });
  if (stats.drawCalls > FERRY_BUILDING_STREETSCAPE_BUDGET.maxDrawCalls
    || stats.instances > FERRY_BUILDING_STREETSCAPE_BUDGET.maxInstances
    || stats.triangles > FERRY_BUILDING_STREETSCAPE_BUDGET.maxTriangles) {
    root.removeFromParent();
    for (const geometry of batches.geometries) geometry.dispose();
    for (const material of batches.materials) material.dispose();
    throw new Error('Ferry Building streetscape exceeded its static rendering budget.');
  }

  let elapsed = 0;
  let wetness = clamp(Number(options.wetness) || 0, 0, 1);
  let disposed = false;
  const dryRoughness = new Map(batches.materials.map((material) => [material, material.roughness]));

  function setConditions(next = {}) {
    if (disposed) return wetness;
    wetness = clamp(Number.isFinite(next.wetness) ? next.wetness : wetness, 0, 1);
    for (const material of batches.materials) {
      const dry = dryRoughness.get(material);
      material.roughness = THREE.MathUtils.lerp(dry, Math.min(dry, 0.2), wetness * (material === materials.leaf ? 0.25 : 0.75));
      material.needsUpdate = true;
    }
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
    for (const material of batches.materials) material.dispose();
  }

  setConditions({ wetness });
  return Object.freeze({
    root,
    stats,
    update,
    setConditions,
    dispose,
    get disposed() { return disposed; },
  });
}
