import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const HERO_IDS = [
  'sf-building-132127809',
  'sf-building-132127810',
  'sf-building-149335979',
  'sf-building-149335987',
  'sf-building-149335988',
  'sf-building-151183777',
];
const EXPECTED_KIND_COUNTS = Object.freeze({
  planter: 400,
  bench: 158,
  hydrant: 151,
  cone: 108,
  sign: 83,
});
const EXPECTED_ENTRY_ROLES = Object.freeze({ planter: 12, bench: 4, sign: 4, hydrant: 3 });
const EXPECTED_RELOCATED_ROLES = Object.freeze({ planter: 14, bench: 5, sign: 5, hydrant: 4, cone: 2 });
const EXPECTED_CORRIDOR_ROLES = Object.freeze({ planter: 2, bench: 1, sign: 1, hydrant: 1, cone: 2 });
const BASE_PROP_RADII = Object.freeze({ planter: 0.57, bench: 0.86, sign: 0.35, hydrant: 0.3, cone: 0.21 });
const FOOTPRINT_HALF_EXTENTS = Object.freeze({
  planter: Object.freeze({ x: 0.57, z: 0.57 }),
  bench: Object.freeze({ x: 0.8, z: 0.31 }),
  sign: Object.freeze({ x: 0.31, z: 0.04 }),
  hydrant: Object.freeze({ x: 0.22, z: 0.22 }),
  cone: Object.freeze({ x: 0.20, z: 0.20 }),
  'trash-can': Object.freeze({ x: 0.32, z: 0.32 }),
  'bike-rack': Object.freeze({ x: 0.54, z: 0.12 }),
  'newspaper-box': Object.freeze({ x: 0.28, z: 0.23 }),
  'pay-station': Object.freeze({ x: 0.22, z: 0.15 }),
});
const PRESENTATION_RADII = Object.freeze({
  'trash-can': 0.46,
  'bike-rack': 0.60,
  'newspaper-box': 0.42,
  'pay-station': 0.30,
});
const EXPECTED_PRESENTATION_RESOURCES = Object.freeze({
  logicalProps: 0,
  drawGroups: 3,
  triangles: 308,
  geometries: 3,
  materials: 0,
  textures: 0,
  gpuInstances: 3,
  hiddenBaseInstances: 12,
  visibleAccentInstances: 3,
});
const EXPECTED_INCREMENTAL = Object.freeze({
  instances: 5,
  drawGroups: 4,
  triangles: 520,
  geometries: 4,
  materials: 0,
  textures: 0,
});
const EXPECTED_ACCENTS = Object.freeze({
  'trash-can': Object.freeze({ meshName: 'sf-trash-cans', triangles: 140, count: 2 }),
  'bike-rack': Object.freeze({ meshName: 'sf-bike-racks', triangles: 120, count: 1 }),
  'newspaper-box': Object.freeze({ meshName: 'sf-newspaper-boxes', triangles: 48, count: 1 }),
  'pay-station': Object.freeze({ meshName: 'sf-pay-stations', triangles: 72, count: 1 }),
});
const EXPECTED_FRONTAGE_OVERRIDES = Object.freeze([
  Object.freeze({
    id: 'market-pay-station-north',
    heroFrontageId: 'sf-building-149335979',
    role: 'planter-left',
    logicalKind: 'planter',
    presentationKind: 'pay-station',
    meshName: 'sf-pay-stations',
    triangles: 72,
    indexCount: 216,
    vertexCount: 136,
  }),
  Object.freeze({
    id: 'market-trash-can-south',
    heroFrontageId: 'sf-building-149335987',
    role: 'planter-right',
    logicalKind: 'planter',
    presentationKind: 'trash-can',
    meshName: 'sf-trash-cans',
    triangles: 140,
    indexCount: 420,
    vertexCount: 173,
  }),
]);
const EXPECTED_FRONTAGE_RESOURCES = Object.freeze({
  logicalProps: 0,
  drawGroups: 1,
  triangles: 212,
  geometries: 1,
  materials: 0,
  textures: 0,
  gpuInstances: 2,
  hiddenBaseInstances: 10,
  visibleAccentInstances: 2,
});
const EXPECTED_CORRIDOR = Object.freeze({
  id: 'market-street-curb-rhythm',
  segmentId: 'sf-seg-308',
  streetId: 'sf-street-228196396',
  side: 1,
  t: Object.freeze([0.34, 0.39, 0.47, 0.63, 0.70, 0.75, 0.84]),
  kinds: Object.freeze(['planter', 'sign', 'cone', 'bench', 'hydrant', 'planter', 'cone']),
  visualKinds: Object.freeze(['trash-can', 'sign', 'bike-rack', 'bench', 'hydrant', 'newspaper-box', 'cone']),
  lateralOffsetsMeters: Object.freeze([4.10, 3.96, 4.15, 4.38, 3.90, 4.10, 3.84]),
  presentationScales: Object.freeze([1.00, 1.15, 1.00, 1.00, 1.15, 1.00, 1.10]),
  rotationOffsetsRadians: Object.freeze([
    0.18,
    -Math.PI / 2,
    -Math.PI / 2,
    -Math.PI / 2,
    0.12,
    -Math.PI / 2,
    -0.34,
  ]),
  clusters: Object.freeze([
    'entrance',
    'entrance',
    'entrance',
    'intersection',
    'intersection',
    'intersection',
    'intersection',
  ]),
  source: Object.freeze({
    endpoints: Object.freeze([{ x: 1444.4, z: 1109.2 }, { x: 1404.6, z: 1069.9 }]),
    widthMeters: 6.4,
    sidewalkWidthMeters: 2.4,
  }),
});
const EXPECTED_EDGE_LENGTHS = [
  7.816009211867666,
  8.796590248499736,
  14.920120642943894,
  22.132555207205563,
  22.953213282675723,
  30.44946633358305,
];
const EXPECTED_PROP_SCENE = Object.freeze({
  instancedMeshes: 14,
  uniqueGeometries: 14,
  materials: 8,
  textureMaps: 0,
  triangles: 75112,
  instances: 2854,
});
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

function assertFinite(value, label) {
  assert.equal(Number.isFinite(value), true, `${label} is finite (${value})`);
}

function assertFinitePoint(point, label) {
  assert.ok(point && typeof point === 'object', `${label} is present`);
  assertFinite(point.x, `${label}.x`);
  assertFinite(point.y, `${label}.y`);
  assertFinite(point.z, `${label}.z`);
}

function assertFiniteXZ(point, label) {
  assert.ok(point && typeof point === 'object', `${label} is present`);
  assertFinite(point.x, `${label}.x`);
  assertFinite(point.z, `${label}.z`);
}

function assertEndpoints(actual, expected, label) {
  assert.ok(Array.isArray(actual) && actual.length === 2,
    `${label} has exactly two source endpoints`);
  actual.forEach((point, index) => {
    assertFiniteXZ(point, `${label}[${index}]`);
    assertApprox(point.x, expected[index].x, `${label}[${index}].x`, 1e-9);
    assertApprox(point.z, expected[index].z, `${label}[${index}].z`, 1e-9);
  });
}

function assertApprox(actual, expected, label, epsilon = 1e-6) {
  assertFinite(actual, label);
  assert.ok(Math.abs(actual - expected) <= epsilon,
    `${label} is ${actual}; expected ${expected} ± ${epsilon}`);
}

function assertExactKindCounts(actual, label) {
  assert.deepEqual(actual, EXPECTED_KIND_COUNTS, `${label}: unchanged global prop kind counts`);
}

function assertExactHeroIds(actual, label) {
  assert.ok(Array.isArray(actual), `${label} is an array`);
  assert.deepEqual([...actual].sort(), [...HERO_IDS].sort(), `${label}: exact six hero IDs`);
  assert.equal(new Set(actual).size, HERO_IDS.length, `${label}: hero IDs are unique`);
}

function assertPropSceneContract(scene, label) {
  for (const [field, expected] of Object.entries(EXPECTED_PROP_SCENE)) {
    assert.equal(scene?.[field], expected, `${label}: ${field} remains ${expected}`);
  }
}

function assertIncremental(incremental, label) {
  assert.deepEqual(incremental, EXPECTED_INCREMENTAL,
    `${label}: hero sidewalk presentation has the exact bounded render delta`);
}

function canonicalSnapshotEqual(a, b, label) {
  assert.deepEqual(a.records, b.records, `${label}: staged record positions are deterministic`);
  assert.deepEqual(a.hero, b.hero, `${label}: hero frontage diagnostics are deterministic`);
  assert.deepEqual(a.sourceSegment, b.sourceSegment, `${label}: corridor source segment is deterministic`);
  assert.deepEqual(a.portals, b.portals, `${label}: canonical hero portal transforms are deterministic`);
  assert.deepEqual(a.footprints, b.footprints, `${label}: source hero footprints are deterministic`);
  assert.deepEqual(a.sourceRoadEdges, b.sourceRoadEdges, `${label}: source road geometry is deterministic`);
  assert.deepEqual(a.sourceBuildings, b.sourceBuildings, `${label}: source building geometry is deterministic`);
  assert.deepEqual(a.terrainSamples, b.terrainSamples, `${label}: terrain grounding samples are deterministic`);
  const stableAccents = (snapshot) => Object.fromEntries(Object.entries(snapshot.accentMeshes).map(([kind, accent]) => [kind, {
    name: accent.name,
    count: accent.count,
      visible: accent.visible,
      triangles: accent.triangles,
      maps: accent.maps,
      instanceColor: accent.instanceColor,
      elements: accent.elements,
      elementsByIndex: accent.elementsByIndex,
      localPositions: accent.localPositions,
  }]));
  assert.deepEqual(stableAccents(a), stableAccents(b), `${label}: accent meshes and matrices are deterministic`);
  assert.deepEqual(a.zeroScaleBaseInstances, b.zeroScaleBaseInstances,
    `${label}: hidden base component matrices are deterministic`);
}

function pointToSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq))
    : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = ((a.z > point.z) !== (b.z > point.z))
      && point.x < (b.x - a.x) * (point.z - a.z) / ((b.z - a.z) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonBoundaryDistance(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return Infinity;
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    distance = Math.min(distance,
      pointToSegmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]));
  }
  return pointInPolygon(point, polygon) ? -distance : distance;
}

function matrixPoint(elements, point) {
  return {
    x: elements[0] * point.x + elements[4] * point.y + elements[8] * point.z + elements[12],
    z: elements[2] * point.x + elements[6] * point.y + elements[10] * point.z + elements[14],
  };
}

function independentlyMeasureCorridor(snapshot, corridor) {
  const source = snapshot.sourceSegment;
  const a = source.points[0];
  const b = source.points[1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  const normal = { x: -dz / length, z: dx / length };
  return corridor.placements.map((placement, index) => {
    const presentationKind = EXPECTED_CORRIDOR.visualKinds[index];
    const radius = (PRESENTATION_RADII[presentationKind] ?? BASE_PROP_RADII[placement.kind])
      * placement.presentationScale;
    const ownerAsphalt = pointToSegmentDistance(placement.position, a, b) - source.width / 2 - radius;
    let absoluteAsphalt = Infinity;
    let otherAsphalt = Infinity;
    for (const road of snapshot.sourceRoadEdges) {
      const clearance = pointToSegmentDistance(placement.position, road.a, road.b) - road.width / 2 - radius;
      absoluteAsphalt = Math.min(absoluteAsphalt, clearance);
      if (String(road.streetId) !== String(source.streetId)) otherAsphalt = Math.min(otherAsphalt, clearance);
    }
    let building = Infinity;
    for (const sourceBuilding of snapshot.sourceBuildings) {
      building = Math.min(building,
        polygonBoundaryDistance(placement.position, sourceBuilding.polygon) - radius);
    }
    let portal = Infinity;
    for (const sourcePortal of snapshot.portals) {
      portal = Math.min(portal,
        pointToSegmentDistance(placement.position, sourcePortal.position, sourcePortal.approach) - radius - 0.6);
    }
    let interProp = Infinity;
    for (const record of snapshot.records) {
      const isSelf = record.corridorId === corridor.id
        && Math.abs(Number(record.sourceT) - placement.sourceT) <= 1e-9;
      if (isSelf) continue;
      const otherRadius = Number(record.effectiveCollisionRadiusMeters)
        || BASE_PROP_RADII[record.kind]
        || 0.25;
      interProp = Math.min(interProp,
        Math.hypot(placement.position.x - record.x, placement.position.z - record.z) - radius - otherRadius);
    }
    const endpoint = Math.min(placement.sourceT * length, (1 - placement.sourceT) * length) - radius;
    let lateralFootprint;
    const accent = snapshot.accentMeshes[presentationKind];
    if (accent) {
      const accentElements = accent.elements || accent.elementsByIndex?.reduce((best, elements) => {
        const distance = Math.hypot(elements[12] - placement.position.x, elements[14] - placement.position.z);
        return !best || distance < best.distance ? { distance, elements } : best;
      }, null)?.elements;
      if (!accentElements) throw new Error(`missing rendered matrix for corridor ${presentationKind}`);
      lateralFootprint = Math.max(...accent.localPositions.map((localPoint) => {
        const world = matrixPoint(accentElements, localPoint);
        return Math.abs((world.x - placement.position.x) * normal.x
          + (world.z - placement.position.z) * normal.z);
      }));
    } else {
      const halfExtents = FOOTPRINT_HALF_EXTENTS[presentationKind];
      lateralFootprint = ['planter', 'hydrant', 'cone'].includes(presentationKind)
        ? halfExtents.x * placement.presentationScale
        : (
          Math.abs(Math.cos(placement.rotationOffsetRadians)) * halfExtents.x
          + Math.abs(Math.sin(placement.rotationOffsetRadians)) * halfExtents.z
        ) * placement.presentationScale;
    }
    const sidewalkWidth = Number(source.sidewalkLeft);
    const lane = source.width / 2 + sidewalkWidth - placement.lateralOffsetMeters - lateralFootprint;
    return { radius, ownerAsphalt, absoluteAsphalt, otherAsphalt, building, portal, interProp, endpoint, lateralFootprint, lane };
  });
}

function independentlyMeasureFrontage(snapshot, entry, placement) {
  const presentationKind = placement.presentationKind || placement.kind;
  const presentationScale = Number(placement.presentationScale ?? 1);
  // Hero frontage diagnostics intentionally preserve the logical donor
  // collision envelope even when the visual presentation is overridden.
  const radius = (BASE_PROP_RADII[placement.kind] ?? 0.25) * presentationScale;
  const point = placement.position;
  let absoluteAsphalt = Infinity;
  let otherAsphalt = Infinity;
  let ownerAsphalt = Infinity;
  for (const road of snapshot.sourceRoadEdges) {
    const clearance = pointToSegmentDistance(point, road.a, road.b) - road.width / 2 - radius;
    absoluteAsphalt = Math.min(absoluteAsphalt, clearance);
    if (String(road.streetId) === String(placement.ownerStreetId)) ownerAsphalt = Math.min(ownerAsphalt, clearance);
    else otherAsphalt = Math.min(otherAsphalt, clearance);
  }
  let building = Infinity;
  for (const sourceBuilding of snapshot.sourceBuildings) {
    building = Math.min(building,
      polygonBoundaryDistance(point, sourceBuilding.polygon) - radius);
  }
  let portal = Infinity;
  for (const sourcePortal of snapshot.portals) {
    portal = Math.min(portal,
      pointToSegmentDistance(point, sourcePortal.position, sourcePortal.approach) - radius - 0.6);
  }
  let interProp = Infinity;
  for (const record of snapshot.records) {
    const isSelf = record.heroFrontageId === entry.id
      && record.role === placement.role
      && Math.hypot(record.x - point.x, record.z - point.z) <= 1e-6;
    if (isSelf) continue;
    const otherRadius = Number(record.effectiveCollisionRadiusMeters)
      || BASE_PROP_RADII[record.kind]
      || 0.25;
    interProp = Math.min(interProp,
      Math.hypot(point.x - record.x, point.z - record.z) - radius - otherRadius);
  }
  const halfExtents = FOOTPRINT_HALF_EXTENTS[presentationKind] || FOOTPRINT_HALF_EXTENTS[placement.kind];
  const rotation = Number(placement.rotation || 0);
  const lateralFootprint = ['planter', 'hydrant', 'cone', 'trash-can'].includes(presentationKind)
    ? halfExtents.x * presentationScale
    : (
      Math.abs(Math.cos(rotation)) * halfExtents.x
      + Math.abs(Math.sin(rotation)) * halfExtents.z
    ) * presentationScale;
  const road = snapshot.sourceRoadEdges.find((candidate) => candidate.id === placement.ownerSegmentId);
  const lane = road && Number.isFinite(placement.band?.lateralOffsetMeters)
    ? road.width / 2 + Number(placement.band.sidewalkWidthMeters) - placement.band.lateralOffsetMeters
      - lateralFootprint
    : Infinity;
  const endpoint = entry.sourceEdgeLength * 0.5
    - Math.abs(Number(placement.sourceEdgeOffsetMeters))
    - (BASE_PROP_RADII[placement.kind] || 0.25);
  return { radius, absoluteAsphalt, otherAsphalt, ownerAsphalt, building, portal, interProp, lane, endpoint };
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu
      && window.__CITYGEN__?.getState().generator === 'sf-builtin'
      && window.__CITYGEN__?.getState().furniture?.props === 900
      && window.__CITYGEN__?.getRenderer()?.sidewalkPropDiagnostics?.heroFrontages?.finite === true
      && window.__CITYGEN__?.getRenderer()?.sidewalkPropDiagnostics?.heroFrontages?.treatedIds?.length === 6,
    { timeout: 30000 },
  );
  const readSnapshot = async () => page.evaluate((heroIds) => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const records = renderer.sidewalkPropRecords || [];
    const kinds = records.reduce((counts, record) => {
      counts[record.kind] = (counts[record.kind] || 0) + 1;
      return counts;
    }, {});
    const measuredBandViolations = records.filter((record) => !record.segmentId
      || !Number.isFinite(record.lateralOffset)
      || record.lateralOffset < record.minOffset - 1e-6
      || record.lateralOffset > record.maxOffset + 1e-6).length;
    const propRoot = renderer.root?.getObjectByName('sidewalk-props');
    const propMeshes = [];
    propRoot?.traverse((object) => {
      if (object.isInstancedMesh) propMeshes.push(object);
    });
    const trianglesFor = (mesh) => {
      const count = mesh.geometry?.index?.count ?? mesh.geometry?.attributes?.position?.count ?? 0;
      return (count / 3) * mesh.count;
    };
    const materials = new Set(propMeshes.flatMap((mesh) => (
      Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    ).filter(Boolean)));
    const textureMaps = new Set();
    for (const material of materials) {
      for (const [key, value] of Object.entries(material)) {
        if (/map$/i.test(key) && value) textureMaps.add(value);
      }
    }
    const scene = {
      instancedMeshes: propMeshes.length,
      uniqueGeometries: new Set(propMeshes.map((mesh) => mesh.geometry)).size,
      materials: materials.size,
      textureMaps: textureMaps.size,
      triangles: propMeshes.reduce((sum, mesh) => sum + trianglesFor(mesh), 0),
      instances: propMeshes.reduce((sum, mesh) => sum + mesh.count, 0),
    };
    const corridor = renderer.sidewalkPropDiagnostics?.heroFrontages?.corridor || null;
    const heroFrontages = renderer.sidewalkPropDiagnostics?.heroFrontages || null;
    const meshNameForKind = {
      planter: 'planter-pots',
      bench: 'bench-seats',
      sign: 'street-sign-poles',
      hydrant: 'hydrants',
      cone: 'traffic-cones',
    };
    const componentOffsetsForKind = {
      planter: [['planter-pots', 0.28], ['planter-leaves', 1.05], ['planter-flowers', 1.32]],
      bench: [['bench-seats', 0.45], ['bench-backs', 0.8]],
      sign: [['street-sign-poles', 0.75], ['street-sign-boards', 1.55]],
      hydrant: [['hydrants', 0.4]],
      cone: [['traffic-cones', 0.28], ['traffic-cone-bands', 0.24]],
    };
    const closestInstance = (mesh, placement, matrix) => {
      let best = null;
      if (!mesh || !matrix) return best;
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        const e = matrix.elements;
        const distance = Math.hypot(e[12] - placement.position.x, e[14] - placement.position.z);
        if (!best || distance < best.distance) {
          best = {
            index,
            distance,
            translationY: e[13],
            scale: {
              x: Math.hypot(e[0], e[1], e[2]),
              y: Math.hypot(e[4], e[5], e[6]),
              z: Math.hypot(e[8], e[9], e[10]),
            },
            elements: [...e],
          };
        }
      }
      return best;
    };
    const matrixScales = [];
    if (corridor?.placements?.length) {
      const matrix = propMeshes[0]?.matrixWorld?.clone?.();
      for (const placement of corridor.placements) {
        const mesh = propRoot?.getObjectByName(meshNameForKind[placement.kind]);
        const best = closestInstance(mesh, placement, matrix);
        const components = componentOffsetsForKind[placement.kind].map(([name, yOffset]) => ({
          name,
          yOffset,
          matrix: closestInstance(propRoot?.getObjectByName(name), placement, matrix),
        }));
        matrixScales.push({
          kind: placement.kind,
          role: placement.role,
          presentationScale: placement.presentationScale,
          matrix: best,
          components,
        });
      }
    }
    const portals = (api.getBuildingPortals?.() || [])
      .filter((portal) => heroIds.includes(portal.buildingId))
      .map((portal) => ({
        id: portal.id,
        buildingId: portal.buildingId,
        position: portal.position,
        approach: portal.approach,
        normal: portal.normal,
        heading: portal.heading,
        edgeIndex: portal.sourceMetadata?.edgeIndex,
      }))
      .sort((a, b) => a.buildingId.localeCompare(b.buildingId));
    const footprints = (renderer.city?.buildings || [])
      .filter((building) => heroIds.includes(building.id))
      .map((building) => ({
        id: building.id,
        polygon: (building.polygon || []).map((point) => ({ x: point.x, y: point.y, z: point.z })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const sourceSegment = (renderer.city?.segments || [])
      .find((segment) => segment.id === 'sf-seg-308');
    const sourceSegmentSnapshot = sourceSegment ? {
      id: sourceSegment.id,
      streetId: sourceSegment.streetId,
      points: (sourceSegment.points || []).map((point) => ({ x: point.x, z: point.z })),
      width: sourceSegment.width,
      sidewalkW: sourceSegment.sidewalkW,
      sidewalkLeft: sourceSegment.sidewalkLeft,
      sidewalkRight: sourceSegment.sidewalkRight,
    } : null;
    const sourceRoadEdges = (renderer.city?.segments || [])
      .filter((segment) => !['pedestrian', 'footway', 'cycleway', 'motorway'].includes(segment.highway))
      .flatMap((segment) => (segment.points || []).slice(1).map((point, index) => ({
        id: segment.id,
        streetId: segment.streetId,
        width: Number(segment.width || 0),
        a: { x: segment.points[index].x, z: segment.points[index].z },
        b: { x: point.x, z: point.z },
      })));
    const sourceBuildings = (renderer.city?.buildings || []).map((building) => ({
      id: building.id,
      polygon: (building.polygon || []).map((point) => ({ x: point.x, z: point.z })),
    }));
    const terrainSamples = Object.fromEntries((heroFrontages?.entries || []).flatMap((entry) => (
      (entry.placements || []).map((placement) => {
        const key = `${entry.id}:${placement.role}`;
        const heightMeters = renderer.terrain?.heightAt
          ? renderer.terrain.heightAt(placement.position.x, placement.position.z)
          : 0;
        return [key, { x: placement.position.x, z: placement.position.z, heightMeters }];
      })
    )));
    const accentMeshNames = {
      'trash-can': 'sf-trash-cans',
      'bike-rack': 'sf-bike-racks',
      'newspaper-box': 'sf-newspaper-boxes',
      'pay-station': 'sf-pay-stations',
    };
    const matrix = propMeshes[0]?.matrixWorld?.clone?.();
    const accentMeshes = Object.fromEntries(Object.entries(accentMeshNames).map(([kind, name]) => {
      const mesh = propRoot?.getObjectByName(name);
      const positions = mesh?.geometry?.attributes?.position;
      const localPositions = positions
        ? Array.from({ length: positions.count }, (_, index) => ({
          x: positions.getX(index),
          y: positions.getY(index),
          z: positions.getZ(index),
        }))
        : [];
      let elements = null;
      const elementsByIndex = [];
      if (mesh?.count === 1 && matrix) {
        mesh.getMatrixAt(0, matrix);
        elements = [...matrix.elements];
      }
      if (mesh && matrix) {
        for (let index = 0; index < mesh.count; index += 1) {
          mesh.getMatrixAt(index, matrix);
          elementsByIndex.push([...matrix.elements]);
        }
      }
      const meshMaterials = (Array.isArray(mesh?.material) ? mesh.material : [mesh?.material]).filter(Boolean);
      const maps = meshMaterials.flatMap((material) => Object.entries(material)
        .filter(([key, value]) => /map$/i.test(key) && value)
        .map(([key]) => key));
      return [kind, {
        name,
        count: mesh?.count ?? -1,
        visible: mesh?.visible === true,
        triangles: (mesh?.geometry?.index?.count || 0) / 3,
        geometryUuid: mesh?.geometry?.uuid || null,
        materialUuids: meshMaterials.map((material) => material.uuid),
        maps,
        instanceColor: mesh?.instanceColor ? [...mesh.instanceColor.array] : null,
        elements,
        elementsByIndex,
        localPositions,
      }];
    }));
    const baseMeshNames = ['planter-pots', 'planter-leaves', 'planter-flowers', 'traffic-cones', 'traffic-cone-bands'];
    const zeroScaleBaseInstances = Object.fromEntries(baseMeshNames.map((name) => {
      const mesh = propRoot?.getObjectByName(name);
      let count = 0;
      if (mesh && matrix) {
        for (let index = 0; index < mesh.count; index += 1) {
          mesh.getMatrixAt(index, matrix);
          const e = matrix.elements;
          if (Math.hypot(e[0], e[1], e[2]) <= 1e-9) count += 1;
        }
      }
      return [name, count];
    }));
    const identityRenderer = api.getRenderer();
    const identity = {
      backend: renderer.rendererBackend,
      rendererStable: renderer === identityRenderer,
      rootInScene: Boolean(renderer.root && renderer.scene?.children?.includes(renderer.root)),
      canvasIdentity: Boolean(renderer.renderer?.domElement
        && renderer.renderer.domElement === document.getElementById('scene-canvas')),
      canvasConnected: Boolean(renderer.renderer?.domElement?.isConnected),
      sceneCanvasCount: document.querySelectorAll('#scene-canvas').length,
      webgpuCanvas: renderer.renderer?.domElement?.tagName === 'CANVAS',
    };
    return {
      backend: renderer.rendererBackend,
      props: records.length,
      segmentOwners: new Set(records.map((record) => record.segmentId)).size,
      kinds,
      measuredBandViolations,
      records,
      hero: renderer.sidewalkPropDiagnostics?.heroFrontages || null,
      diagnostics: renderer.sidewalkPropDiagnostics,
      scene,
      matrixScales,
      corridor,
      sourceSegment: sourceSegmentSnapshot,
      sourceRoadEdges,
      sourceBuildings,
      terrainSamples,
      accentMeshes,
      zeroScaleBaseInstances,
      portals,
      footprints,
      identity,
    };
  }, HERO_IDS);

  const first = await readSnapshot();
  assert.equal(first.backend, 'webgpu');
  assert.equal(first.props, 900);
  assert.ok(first.segmentOwners >= 100);
  assert.deepEqual(Object.keys(first.kinds).sort(), ['bench', 'cone', 'hydrant', 'planter', 'sign']);
  assertExactKindCounts(first.kinds, 'first load');
  assert.equal(first.measuredBandViolations, 0);
  assert.equal(first.diagnostics.bandViolations, 0);
  assert.equal(first.diagnostics.asphaltOverlaps, 4,
    'top-level sidewalk diagnostics report the four inherited source-road overlaps');
  assertPropSceneContract(first.scene, 'first load sidewalk-props scene');

  const hero = first.hero;
  assert.ok(hero, 'heroFrontages diagnostics are required; hero sidewalk staging contract is absent');
  assert.equal(hero.schemaVersion, 5, 'hero sidewalk contract schema version is 5');
  assert.equal(hero.pass, 'hero-sidewalk-life-v5', 'hero sidewalk contract version is explicit');
  assertExactHeroIds(hero.expectedIds, 'heroFrontages.expectedIds');
  assertExactHeroIds(hero.treatedIds, 'heroFrontages.treatedIds');
  assert.equal(hero.donorRecords, 30, 'hero sidewalk staging relocates exactly 30 same-kind donors');
  assert.equal(hero.logicalPropsBefore, 900, 'hero sidewalk staging starts from 900 logical props');
  assert.equal(hero.logicalPropsAfter, 900, 'hero sidewalk staging ends at 900 logical props');
  assert.deepEqual(hero.roles, EXPECTED_RELOCATED_ROLES,
    'hero sidewalk staging has the exact aggregate relocated role mix');
  assert.equal(hero.entries?.length, HERO_IDS.length, 'hero sidewalk diagnostics expose six entries');
  assert.equal(hero.absoluteAsphaltOverlaps, 4,
    'hero sidewalk diagnostics honestly report absolute source-road overlaps');
  assert.equal(hero.additionalAsphaltIntrusions, 0,
    'hero sidewalk staging adds no asphalt intrusion beyond canonical frontage overlap');
  assert.equal(hero.asphaltOverlaps, 4,
    'hero sidewalk diagnostics retain four inherited canonical asphalt overlaps');
  assert.equal(hero.buildingOverlaps, 0, 'hero sidewalk props have no building overlap');
  assert.equal(hero.portalCorridorIntrusions, 0, 'hero sidewalk props preserve every portal corridor');
  assert.equal(hero.sourceFootprintsUnchanged, true, 'hero staging preserves source building footprints');
  assert.equal(hero.sourcePortalsUnchanged, true, 'hero staging preserves canonical source portals');
  assert.equal(hero.finite, true, 'hero sidewalk diagnostics are finite');
  assertIncremental(hero.incremental, 'hero sidewalk staging');
  assert.deepEqual(hero.frontagePresentationResources, EXPECTED_FRONTAGE_RESOURCES,
    'frontage presentation resource delta is exact');
  assert.deepEqual(hero.frontagePresentationOverrides.map((override) => ({
    id: override.id,
    heroFrontageId: override.heroFrontageId,
    role: override.role,
    logicalKind: override.logicalKind,
    presentationKind: override.presentationKind,
    groundPivoted: override.groundPivoted,
    baseInstanceHidden: override.baseInstanceHidden,
    hiddenBaseComponents: override.hiddenBaseComponents,
  })), EXPECTED_FRONTAGE_OVERRIDES.map((override) => ({
    id: override.id,
    heroFrontageId: override.heroFrontageId,
    role: override.role,
    logicalKind: override.logicalKind,
    presentationKind: override.presentationKind,
    groundPivoted: true,
    baseInstanceHidden: true,
    hiddenBaseComponents: {
      'planter-pots': 1,
      'planter-leaves': 1,
      'planter-flowers': 3,
    },
  })), 'exact frontage override identities and hidden component provenance');
  assert.deepEqual(hero.frontagePresentationTopologies.map((topology) => ({
    kind: topology.kind,
    meshName: topology.meshName,
    indexCount: topology.indexCount,
    triangleCount: topology.triangleCount,
    vertexCount: topology.vertexCount,
    instanceCapacity: topology.instanceCapacity,
    visibleInstances: topology.visibleInstances,
  })), EXPECTED_FRONTAGE_OVERRIDES.map((override) => ({
    kind: override.presentationKind,
    meshName: override.meshName,
    indexCount: override.indexCount,
    triangleCount: override.triangles,
    vertexCount: override.vertexCount,
    instanceCapacity: override.presentationKind === 'trash-can' ? 2 : 1,
    visibleInstances: override.presentationKind === 'trash-can' ? 2 : 1,
  })).sort((a, b) => a.kind.localeCompare(b.kind)),
  'exact frontage override topologies and capacities');
  assert.ok(hero.donorSelection && typeof hero.donorSelection === 'object',
    'hero donor selection diagnostics are present');
  assert.equal(hero.donorSelection.strategy, 'same-kind-farthest-v3',
    'hero donor selection uses the v3 deterministic strategy');
  assert.equal(hero.donorSelection.alreadyStagedExcluded, true,
    'hero donor selection excludes already-staged records');
  assert.equal(hero.donorSelection.distanceScope, 'hero-edges-and-corridor-segment',
    'hero donor selection reports both hero-edge and corridor distance scopes');
  assert.equal(hero.donorSelection.minimumRequiredDistanceMeters, 80,
    'hero donor selection keeps the 80m exclusion radius');
  assert.equal(hero.donorSelection.selectedRecords, 30,
    'hero donor selection reports exactly 30 selected records');
  assert.deepEqual(hero.donorSelection.poolKinds,
    ['bench', 'cone', 'hydrant', 'planter', 'sign'],
    'hero donor selection exposes every same-kind pool including cones');
  assert.deepEqual(hero.donorSelection.requiredByKind, EXPECTED_RELOCATED_ROLES,
    'hero donor selection requires the exact aggregate kind mix');
  assert.deepEqual(hero.donorSelection.selectedByKind, EXPECTED_RELOCATED_ROLES,
    'hero donor selection assigns every required kind including two cones');
  assert.ok(hero.donorSelection.availableByKind && typeof hero.donorSelection.availableByKind === 'object',
    'hero donor selection reports available pool counts');
  for (const [kind, required] of Object.entries(EXPECTED_RELOCATED_ROLES)) {
    assert.equal(Number.isInteger(hero.donorSelection.availableByKind[kind]), true,
      `hero donor pool ${kind} count is an integer`);
    assert.ok(hero.donorSelection.availableByKind[kind] >= required,
      `hero donor pool ${kind} contains at least its required records`);
  }
  for (const field of [
    'minimumHeroEdgeDistanceMeters',
    'minimumCorridorDistanceMeters',
  ]) assertFinite(hero.donorSelection[field], `hero.donorSelection.${field}`);
  assert.equal(hero.donorSelection.finite, true, 'hero donor selection metadata is finite');

  const actualEdgeLengths = [];
  const totalRoles = {};
  const entryById = new Map((hero.entries || []).map((entry) => [entry.id, entry]));
  assert.equal(entryById.size, HERO_IDS.length, 'hero sidewalk entries contain no duplicate IDs');
  for (const id of HERO_IDS) {
    const entry = entryById.get(id);
    assert.ok(entry, `${id}: hero sidewalk entry is present`);
    assert.equal(Number.isInteger(entry.sourceEdgeIndex), true,
      `${id}: sourceEdgeIndex is an integer`);
    assert.ok(entry.sourceEdgeIndex >= 0, `${id}: sourceEdgeIndex is non-negative`);
    assertFinite(entry.sourceEdgeLength, `${id}: sourceEdgeLength`);
    actualEdgeLengths.push(entry.sourceEdgeLength);
    assert.ok(Array.isArray(entry.ownerSegmentIds), `${id}: ownerSegmentIds is an array`);
    assert.ok(entry.ownerSegmentIds.length > 0, `${id}: at least one source segment owns the frontage`);
    for (const segmentId of entry.ownerSegmentIds) {
      assert.equal(typeof segmentId, 'string', `${id}: owner segment id is a string`);
      assert.ok(segmentId.length > 0, `${id}: owner segment id is non-empty`);
    }
    assert.ok(Array.isArray(entry.placements), `${id}: placements is an array`);
    assert.ok(entry.placements.length > 0, `${id}: at least one hero prop is staged`);
    for (const field of [
      'minimumAsphaltClearanceMeters',
      'minimumAbsoluteAsphaltClearanceMeters',
      'minimumBuildingClearanceMeters',
      'minimumPortalCorridorClearanceMeters',
      'minimumInterPropClearanceMeters',
    ]) {
      assertFinite(entry[field], `${id}: ${field}`);
      if (field !== 'minimumAbsoluteAsphaltClearanceMeters') {
        assert.ok(entry[field] >= 0, `${id}: ${field} is an honest non-negative clearance`);
      }
    }
    if (id !== 'sf-building-132127809') {
      assert.ok(entry.minimumAbsoluteAsphaltClearanceMeters >= 0.3 - 1e-6,
        `${id}: non-inherited frontage keeps the absolute asphalt margin`);
    }
    assert.equal(entry.finite, true, `${id}: hero sidewalk placement metadata is finite`);
    for (const placement of entry.placements) {
      assert.ok(placement && typeof placement === 'object', `${id}: placement is an object`);
      const role = placement.role || placement.kind;
      const expectedKind = role.startsWith('planter') ? 'planter' : role;
      assert.ok(Object.hasOwn(EXPECTED_RELOCATED_ROLES, expectedKind),
        `${id}: placement role is one of planter-left/planter-right/bench/sign/hydrant (${role})`);
      assert.equal(placement.kind, expectedKind,
        `${id}/${role}: presentation kind matches its authored role`);
      if (placement.ownerSegmentId != null) {
        assert.ok(entry.ownerSegmentIds.includes(placement.ownerSegmentId),
          `${id}/${role}: placement owner belongs to the entry source segment set`);
      }
      totalRoles[expectedKind] = (totalRoles[expectedKind] || 0) + 1;
      const point = placement.position || placement;
      assertFinite(point.x, `${id}/${role}: staged x`);
      assertFinite(point.z, `${id}/${role}: staged z`);
      if (point.y != null) assertFinite(point.y, `${id}/${role}: staged y`);
      for (const field of [
        'asphaltClearanceMeters',
        'buildingClearanceMeters',
        'portalCorridorClearanceMeters',
        'interPropClearanceMeters',
      ]) {
        if (placement[field] != null) {
          assertFinite(placement[field], `${id}/${role}: ${field}`);
          assert.ok(placement[field] >= 0, `${id}/${role}: ${field} is non-negative`);
        }
      }
      const mode = placement.mode || placement.placementMode;
      assert.ok(mode === 'vehicle-sidewalk-band' || mode === 'source-frontage-ribbon',
        `${id}/${role}: placement mode is honest (${mode})`);
      assertFinite(placement.rotation, `${id}/${role}: staged rotation`);
      assertFinite(placement.sourceEdgeOffsetMeters, `${id}/${role}: source edge offset`);
      assert.ok(Math.abs(placement.sourceEdgeOffsetMeters) <= entry.sourceEdgeLength * 0.5 + 1e-6,
        `${id}/${role}: source edge offset remains on the source frontage`);
      assertFinite(placement.sourceEndpointClearanceMeters,
        `${id}/${role}: source endpoint clearance`);
      assert.ok(placement.sourceEndpointClearanceMeters >= 0.15 - 1e-6,
        `${id}/${role}: source endpoint clearance preserves the 0.15m footprint margin`);
      if (Number.isFinite(placement.roadEndpointClearanceMeters)) {
        assert.ok(placement.roadEndpointClearanceMeters >= 0.3 - 1e-6,
          `${id}/${role}: road endpoint clearance preserves the 0.3m road margin`);
      } else {
        assert.equal(placement.roadEndpointClearanceMeters, Infinity,
          `${id}/${role}: frontage ribbon honestly reports no vehicle-road endpoint`);
      }
      assertFinite(placement.asphaltClearanceMeters, `${id}/${role}: asphalt clearance`);
      assert.equal(placement.asphaltClearanceScope, 'non-owner-street',
        `${id}/${role}: asphalt clearance declares its non-owner-street scope`);
      assert.ok(placement.asphaltClearanceMeters >= 0.3 - 1e-6,
        `${id}/${role}: prop footprint clears asphalt by at least 0.3m`);
      assertFinite(placement.absoluteAsphaltClearanceMeters,
        `${id}/${role}: absolute asphalt clearance`);
      assertFinite(placement.baselineAsphaltClearanceMeters,
        `${id}/${role}: baseline asphalt clearance`);
      assert.equal(typeof placement.inheritedSourceAsphaltOverlap, 'boolean',
        `${id}/${role}: inherited asphalt overlap provenance is explicit`);
      assert.equal(placement.additionalAsphaltIntrusion, false,
        `${id}/${role}: placement adds no asphalt intrusion beyond its canonical baseline`);
      if (!placement.inheritedSourceAsphaltOverlap) {
        assert.ok(placement.absoluteAsphaltClearanceMeters >= 0.3 - 1e-6,
          `${id}/${role}: non-inherited placement clears absolute asphalt by at least 0.3m`);
      }
      assertFinite(placement.buildingClearanceMeters, `${id}/${role}: building clearance`);
      assert.ok(placement.buildingClearanceMeters >= 0.15 - 1e-6,
        `${id}/${role}: prop footprint clears buildings by at least 0.15m`);
      assertFinite(placement.portalCorridorClearanceMeters,
        `${id}/${role}: portal corridor clearance`);
      assert.ok(placement.portalCorridorClearanceMeters >= 1.2 - 1e-6,
        `${id}/${role}: prop footprint clears the 1.2m portal capsule`);
      assertFinite(placement.interPropClearanceMeters,
        `${id}/${role}: inter-prop clearance`);
      assert.ok(placement.interPropClearanceMeters >= 0.2 - 1e-6,
        `${id}/${role}: prop footprint clears neighboring props by at least 0.2m`);
      assert.ok(placement.band && typeof placement.band === 'object',
        `${id}/${role}: placement carries the source sidewalk/frontage band`);
      for (const field of [
        'lateralOffsetMeters',
        'minimumOffsetMeters',
        'maximumOffsetMeters',
        'sidewalkWidthMeters',
      ]) {
        assertFinite(placement.band[field], `${id}/${role}: band.${field}`);
      }
      assert.ok(placement.band.maximumOffsetMeters >= placement.band.minimumOffsetMeters,
        `${id}/${role}: band maximum offset is not inside the road`);
      assert.ok(placement.band.lateralOffsetMeters >= placement.band.minimumOffsetMeters - 1e-6
        && placement.band.lateralOffsetMeters <= placement.band.maximumOffsetMeters + 1e-6,
      `${id}/${role}: staged prop remains inside its source band`);
      assert.equal(placement.band.fullyContained, true,
        `${id}/${role}: placement footprint is fully contained in its source band`);
      assert.ok(placement.terrain && typeof placement.terrain === 'object',
        `${id}/${role}: terrain grounding metadata is present`);
      for (const field of ['heightMeters', 'roadLiftMeters', 'groundedY']) {
        assertFinite(placement.terrain[field], `${id}/${role}: terrain.${field}`);
      }
      assert.equal(placement.terrain.finite, true, `${id}/${role}: terrain metadata is finite`);
      assertApprox(
        placement.terrain.groundedY,
        placement.terrain.heightMeters + placement.terrain.roadLiftMeters + 0.04,
        `${id}/${role}: terrain-grounded y`,
        1e-5,
      );
      const terrainSample = first.terrainSamples[`${id}:${role}`];
      assert.ok(terrainSample, `${id}/${role}: independent terrain sample is present`);
      assertApprox(terrainSample.x, point.x, `${id}/${role}: terrain sample x matches placement`, 1e-9);
      assertApprox(terrainSample.z, point.z, `${id}/${role}: terrain sample z matches placement`, 1e-9);
      assertFinite(terrainSample.heightMeters, `${id}/${role}: independent terrain height`);
      assertApprox(
        point.y,
        terrainSample.heightMeters + placement.terrain.roadLiftMeters + 0.04,
        `${id}/${role}: independent terrain-grounded y`,
        1e-5,
      );
      const independent = independentlyMeasureFrontage(first, entry, placement);
      for (const [field, value] of Object.entries(independent)) {
        if (value !== Infinity) assertFinite(value, `${id}/${role}: independent ${field}`);
      }
      for (const [field, diagnostic] of [
        ['absoluteAsphaltClearanceMeters', independent.absoluteAsphalt],
        ['buildingClearanceMeters', independent.building],
        ['portalCorridorClearanceMeters', independent.portal],
      ]) {
        assertApprox(diagnostic, placement[field], `${id}/${role}: independent ${field} agrees`, 1e-5);
      }
      if (Number.isFinite(independent.otherAsphalt)) {
        assertApprox(independent.otherAsphalt, placement.asphaltClearanceMeters,
          `${id}/${role}: independent non-owner asphalt agrees`, 1e-5);
      }
      if (Number.isFinite(independent.ownerAsphalt)) {
        if (!placement.inheritedSourceAsphaltOverlap) {
          assert.ok(independent.ownerAsphalt >= 0.3 - 1e-6,
            `${id}/${role}: independent owner asphalt clearance is safe`);
        }
      }
      if (!placement.inheritedSourceAsphaltOverlap) {
        assert.ok(independent.absoluteAsphalt >= 0.3 - 1e-6,
          `${id}/${role}: independent absolute asphalt clearance is source-safe`);
      }
      assert.ok(independent.building >= 0.15 - 1e-6,
        `${id}/${role}: independent building clearance is source-safe`);
      assert.ok(independent.portal >= 1.2 - 1e-6,
        `${id}/${role}: independent portal clearance is source-safe`);
      assert.ok(independent.interProp >= 0.2 - 1e-6,
        `${id}/${role}: independent inter-prop clearance is source-safe`);
      assert.ok(independent.endpoint >= 0.15 - 1e-6,
        `${id}/${role}: independent source endpoint clearance is source-safe`);
      if (Number.isFinite(independent.lane)) {
        assert.ok(independent.lane >= 0,
          `${id}/${role}: independent rendered lane measurement is finite and non-negative (${independent.lane})`);
      }
      if (mode === 'vehicle-sidewalk-band') {
        assert.ok(typeof placement.ownerSegmentId === 'string' && placement.ownerSegmentId.length > 0,
          `${id}/${role}: vehicle-sidewalk-band names its owning segment`);
        assert.ok(typeof placement.ownerStreetId === 'string' && placement.ownerStreetId.length > 0,
          `${id}/${role}: vehicle-sidewalk-band names its owning street`);
        assert.equal(placement.band.side === 1 || placement.band.side === -1, true,
          `${id}/${role}: vehicle-sidewalk-band records a signed road side`);
        assert.ok(placement.band.sidewalkWidthMeters >= 0.8,
          `${id}/${role}: vehicle-sidewalk-band has a usable sidewalk width`);
      } else {
        assert.equal(mode, 'source-frontage-ribbon', `${id}/${role}: source-frontage-ribbon mode is explicit`);
        assert.ok(placement.ownerSegmentId == null || typeof placement.ownerSegmentId === 'string',
          `${id}/${role}: frontage ribbon owner segment is either absent or a source id`);
        assert.ok(placement.ownerStreetId == null || typeof placement.ownerStreetId === 'string',
          `${id}/${role}: frontage ribbon owner street is either absent or a source id`);
        assertApprox(placement.band.minimumOffsetMeters, 1, `${id}/${role}: frontage ribbon inner offset`, 1e-6);
        assertApprox(placement.band.maximumOffsetMeters, 2.2, `${id}/${role}: frontage ribbon outer offset`, 1e-6);
      }
    }
  }
  actualEdgeLengths.sort((a, b) => a - b);
  assert.equal(actualEdgeLengths.length, EXPECTED_EDGE_LENGTHS.length,
    'hero source edge audit exposes six lengths');
  actualEdgeLengths.forEach((value, index) => assertApprox(
    value,
    EXPECTED_EDGE_LENGTHS[index],
    `hero source edge length ${index}`,
    1e-9,
  ));
  assert.deepEqual(totalRoles, EXPECTED_ENTRY_ROLES,
    'hero frontage entries retain the exact v1 relocated role mix');

  assert.equal(first.identity.backend, 'webgpu', 'canonical prop scene uses WebGPU');
  assert.equal(first.identity.rendererStable, true, 'canonical renderer identity is stable');
  assert.equal(first.identity.rootInScene, true, 'canonical world root remains attached to the scene');
  assert.equal(first.identity.canvasIdentity, true, 'canonical renderer owns the scene canvas');
  assert.equal(first.identity.canvasConnected, true, 'canonical scene canvas remains connected');
  assert.equal(first.identity.sceneCanvasCount, 1, 'canonical runtime exposes one scene canvas');
  assert.equal(first.identity.webgpuCanvas, true, 'canonical WebGPU renderer exposes a canvas');
  assert.equal(first.portals.length, HERO_IDS.length, 'canonical API exposes six hero portals');
  assert.equal(first.footprints.length, HERO_IDS.length, 'canonical city exposes six hero footprints');
  const footprintById = new Map(first.footprints.map((footprint) => [footprint.id, footprint]));
  for (const portal of first.portals) {
    assertFinitePoint(portal.position, `${portal.buildingId}: canonical portal position`);
    assertFinitePoint(portal.approach, `${portal.buildingId}: canonical portal approach`);
    assertFinitePoint(portal.normal, `${portal.buildingId}: canonical portal normal`);
    assertFinite(portal.heading, `${portal.buildingId}: canonical portal heading`);
    const footprint = footprintById.get(portal.buildingId);
    assert.ok(Array.isArray(footprint?.polygon) && footprint.polygon.length >= 3,
      `${portal.buildingId}: source footprint polygon remains available`);
    footprint.polygon.forEach((point, index) => assertFiniteXZ(
      point,
      `${portal.buildingId}: source footprint vertex ${index}`,
    ));
    const entry = entryById.get(portal.buildingId);
    const edgeIndex = entry.sourceEdgeIndex;
    const a = footprint.polygon[edgeIndex];
    const b = footprint.polygon[(edgeIndex + 1) % footprint.polygon.length];
    assert.ok(a && b, `${portal.buildingId}: source edge index remains inside the footprint`);
    assertApprox(
      Math.hypot(b.x - a.x, b.z - a.z),
      entry.sourceEdgeLength,
      `${portal.buildingId}: source edge length matches the unchanged footprint`,
      1e-9,
    );
  }

  const sourceSegment = first.sourceSegment;
  assert.ok(sourceSegment, 'corridor source segment sf-seg-308 is present in the canonical city');
  assert.equal(sourceSegment.id, EXPECTED_CORRIDOR.segmentId,
    'corridor source segment id is canonical');
  assert.equal(sourceSegment.streetId, EXPECTED_CORRIDOR.streetId,
    'corridor source street id is canonical');
  assertEndpoints(sourceSegment.points, EXPECTED_CORRIDOR.source.endpoints,
    'canonical corridor source segment endpoints');
  assertApprox(sourceSegment.width, EXPECTED_CORRIDOR.source.widthMeters,
    'canonical corridor source segment width', 1e-9);
  assertApprox(sourceSegment.sidewalkW, EXPECTED_CORRIDOR.source.sidewalkWidthMeters,
    'canonical corridor source sidewalk width', 1e-9);
  assertApprox(sourceSegment.sidewalkLeft, EXPECTED_CORRIDOR.source.sidewalkWidthMeters,
    'canonical corridor left sidewalk width', 1e-9);
  assertApprox(sourceSegment.sidewalkRight, EXPECTED_CORRIDOR.source.sidewalkWidthMeters,
    'canonical corridor right sidewalk width', 1e-9);

  const corridor = hero.corridor;
  assert.ok(corridor && typeof corridor === 'object',
    'heroFrontages.corridor diagnostics are present');
  assert.equal(corridor.id, EXPECTED_CORRIDOR.id, 'corridor id is explicit');
  assert.equal(corridor.segmentId, EXPECTED_CORRIDOR.segmentId, 'corridor segment id is explicit');
  assert.equal(corridor.streetId, EXPECTED_CORRIDOR.streetId, 'corridor street id is explicit');
  assert.equal(corridor.side, EXPECTED_CORRIDOR.side, 'corridor uses the authored signed road side');
  assert.deepEqual(corridor.t, EXPECTED_CORRIDOR.t, 'corridor exposes the exact authored t sequence');
  assert.deepEqual(corridor.logicalKinds, EXPECTED_CORRIDOR.kinds,
    'corridor preserves the exact logical donor kinds');
  assert.deepEqual(corridor.visualKinds, EXPECTED_CORRIDOR.visualKinds,
    'corridor exposes the exact SF presentation kinds');
  assert.deepEqual(corridor.lateralOffsetsMeters, EXPECTED_CORRIDOR.lateralOffsetsMeters,
    'corridor exposes the exact authored lateral offsets');
  assert.deepEqual(corridor.presentationScales, EXPECTED_CORRIDOR.presentationScales,
    'corridor exposes the exact authored presentation scales');
  assert.deepEqual(corridor.rotationOffsetsRadians, EXPECTED_CORRIDOR.rotationOffsetsRadians,
    'corridor exposes the exact authored rotation offsets');
  assert.deepEqual(corridor.clusters, EXPECTED_CORRIDOR.clusters,
    'corridor exposes the exact authored visual clusters');
  assert.equal(corridor.presentationReplacementCount, 3,
    'corridor replaces exactly three repeated base presentations');
  assert.equal(corridor.hiddenBaseInstances, 12,
    'corridor hides the exact twelve composite base instances');
  assert.equal(corridor.visibleAccentInstances, 3,
    'corridor exposes exactly three accent instances');
  assert.deepEqual(corridor.presentationResources, EXPECTED_PRESENTATION_RESOURCES,
    'corridor presentation resource delta is exact');
  assert.equal(corridor.sourceSnapshotUnchanged, true,
    'corridor source snapshot is explicitly unchanged');
  assert.ok(corridor.source && typeof corridor.source === 'object',
    'corridor carries a source snapshot');
  assertEndpoints(corridor.source.endpoints, EXPECTED_CORRIDOR.source.endpoints,
    'corridor source snapshot endpoints');
  assertApprox(corridor.source.widthMeters, EXPECTED_CORRIDOR.source.widthMeters,
    'corridor source snapshot width', 1e-9);
  assertApprox(corridor.source.sidewalkWidthMeters, EXPECTED_CORRIDOR.source.sidewalkWidthMeters,
    'corridor source snapshot sidewalk width', 1e-9);
  assert.equal(corridor.source.unchanged, true,
    'corridor source snapshot marks endpoints and widths unchanged');
  assertFinite(corridor.minimumSpacingMeters, 'corridor.minimumSpacingMeters');
  assert.ok(corridor.minimumSpacingMeters >= 0.2 - 1e-6,
    'corridor minimum spacing meets the 0.2m inter-prop contract');
  for (const field of [
    'minimumOwnerAsphaltClearanceMeters',
    'minimumOtherAsphaltClearanceMeters',
    'minimumBuildingClearanceMeters',
    'minimumPortalCorridorClearanceMeters',
    'minimumInterPropClearanceMeters',
    'minimumSourceEndpointClearanceMeters',
    'minimumPedestrianLaneMeters',
  ]) {
    assertFinite(corridor[field], `corridor.${field}`);
  }
  assert.ok(corridor.minimumOwnerAsphaltClearanceMeters >= 0.3 - 1e-6,
    'corridor aggregate keeps 0.3m clearance from owner asphalt');
  assert.ok(corridor.minimumOtherAsphaltClearanceMeters >= 0.3 - 1e-6,
    'corridor aggregate keeps 0.3m clearance from other asphalt');
  assert.ok(corridor.minimumBuildingClearanceMeters >= 0.15 - 1e-6,
    'corridor aggregate keeps 0.15m building clearance');
  assert.ok(corridor.minimumPortalCorridorClearanceMeters >= 1.2 - 1e-6,
    'corridor aggregate keeps 1.2m portal-capsule clearance');
  assert.ok(corridor.minimumInterPropClearanceMeters >= 0.2 - 1e-6,
    'corridor aggregate keeps 0.2m prop clearance');
  assert.ok(corridor.minimumSourceEndpointClearanceMeters >= 0.3 - 1e-6,
    'corridor aggregate keeps 0.3m source endpoint clearance');
  assert.ok(corridor.minimumPedestrianLaneMeters >= 0.9 - 1e-6,
    'corridor aggregate preserves a 0.90m pedestrian lane');
  assert.equal(corridor.finite, true, 'corridor diagnostics are finite');
  assert.ok(Array.isArray(corridor.placements) && corridor.placements.length === EXPECTED_CORRIDOR.t.length,
    'corridor exposes exactly seven placements');
  const corridorRoles = {};
  corridor.placements.forEach((placement, index) => {
    const label = `corridor[${index}]`;
    assert.ok(placement && typeof placement === 'object', `${label} placement is present`);
    assert.equal(placement.kind, EXPECTED_CORRIDOR.kinds[index], `${label} kind is authored`);
    assert.equal(placement.logicalKind, EXPECTED_CORRIDOR.kinds[index], `${label} logical kind is preserved`);
    assert.equal(placement.presentationKind, EXPECTED_CORRIDOR.visualKinds[index], `${label} presentation kind is authored`);
    assert.equal(placement.groundPivoted, true, `${label} presentation uses a ground pivot`);
    assert.equal(placement.baseInstanceHidden, placement.presentationKind !== placement.logicalKind,
      `${label} hides only replaced base presentations`);
    assert.equal(placement.role, EXPECTED_CORRIDOR.kinds[index], `${label} role is authored`);
    corridorRoles[placement.kind] = (corridorRoles[placement.kind] || 0) + 1;
    assertApprox(placement.sourceT, EXPECTED_CORRIDOR.t[index], `${label}.sourceT`, 1e-9);
    assertApprox(placement.lateralOffsetMeters, EXPECTED_CORRIDOR.lateralOffsetsMeters[index],
      `${label}.lateralOffsetMeters`, 1e-9);
    assertApprox(placement.presentationScale, EXPECTED_CORRIDOR.presentationScales[index],
      `${label}.presentationScale`, 1e-9);
    assertApprox(placement.rotationOffsetRadians, EXPECTED_CORRIDOR.rotationOffsetsRadians[index],
      `${label}.rotationOffsetRadians`, 1e-9);
    assert.equal(placement.cluster, EXPECTED_CORRIDOR.clusters[index], `${label} cluster is authored`);
    assert.equal(placement.ownerSegmentId, EXPECTED_CORRIDOR.segmentId, `${label} owner segment is canonical`);
    assert.equal(placement.ownerStreetId, EXPECTED_CORRIDOR.streetId, `${label} owner street is canonical`);
    assertFinitePoint(placement.position, `${label}.position`);
    assertFinite(placement.rotation, `${label}.rotation`);
    for (const field of [
      'ownerAsphaltClearanceMeters',
      'otherAsphaltClearanceMeters',
      'asphaltClearanceMeters',
      'absoluteAsphaltClearanceMeters',
      'buildingClearanceMeters',
      'portalCorridorClearanceMeters',
      'interPropClearanceMeters',
      'sourceEndpointClearanceMeters',
      'baseCollisionRadiusMeters',
      'effectiveCollisionRadiusMeters',
      'footprintLateralRadiusMeters',
      'pedestrianLaneMeters',
    ]) assertFinite(placement[field], `${label}.${field}`);
    const expectedBaseRadius = PRESENTATION_RADII[placement.presentationKind] ?? BASE_PROP_RADII[placement.kind];
    assertApprox(placement.baseCollisionRadiusMeters, expectedBaseRadius,
      `${label} base collision radius`, 1e-9);
    assertApprox(
      placement.effectiveCollisionRadiusMeters,
      expectedBaseRadius * placement.presentationScale,
      `${label} effective collision radius`,
      1e-9,
    );
    const halfExtents = FOOTPRINT_HALF_EXTENTS[placement.presentationKind];
    const expectedFootprintLateralRadius = ['planter', 'hydrant', 'cone', 'trash-can'].includes(placement.presentationKind)
      ? halfExtents.x * placement.presentationScale
      : (
        Math.abs(Math.cos(placement.rotationOffsetRadians)) * halfExtents.x
        + Math.abs(Math.sin(placement.rotationOffsetRadians)) * halfExtents.z
      ) * placement.presentationScale;
    assertApprox(placement.footprintLateralRadiusMeters, expectedFootprintLateralRadius,
      `${label} rotation-aware footprint lateral radius`, 1e-9);
    assert.ok(placement.ownerAsphaltClearanceMeters >= 0.3 - 1e-6,
      `${label} owner asphalt clearance is at least 0.3m`);
    assert.ok(placement.otherAsphaltClearanceMeters >= 0.3 - 1e-6,
      `${label} other asphalt clearance is at least 0.3m`);
    assert.ok(placement.asphaltClearanceMeters >= 0.3 - 1e-6,
      `${label} declared asphalt clearance is at least 0.3m`);
    assert.ok(placement.absoluteAsphaltClearanceMeters >= 0.3 - 1e-6,
      `${label} absolute asphalt clearance is at least 0.3m`);
    assert.ok(placement.buildingClearanceMeters >= 0.15 - 1e-6,
      `${label} building clearance is at least 0.15m`);
    assert.ok(placement.portalCorridorClearanceMeters >= 1.2 - 1e-6,
      `${label} portal clearance is at least 1.2m`);
    assert.ok(placement.interPropClearanceMeters >= 0.2 - 1e-6,
      `${label} inter-prop clearance is at least 0.2m`);
    assert.ok(placement.sourceEndpointClearanceMeters >= 0.3 - 1e-6,
      `${label} source endpoint clearance is at least 0.3m`);
    assert.ok(placement.pedestrianLaneMeters >= 0.9 - 1e-6,
      `${label} preserves a 0.90m pedestrian lane`);
    assert.ok(placement.band && typeof placement.band === 'object', `${label} source-safe band is present`);
    assert.equal(placement.band.side, EXPECTED_CORRIDOR.side, `${label} band side is +1`);
    assertApprox(placement.band.lateralOffsetMeters, EXPECTED_CORRIDOR.lateralOffsetsMeters[index],
      `${label} band lateral offset`, 1e-9);
    for (const field of ['minimumOffsetMeters', 'maximumOffsetMeters', 'sidewalkWidthMeters']) {
      assertFinite(placement.band[field], `${label}.band.${field}`);
    }
    assert.ok(placement.band.maximumOffsetMeters >= placement.band.minimumOffsetMeters,
      `${label} band has a valid source-safe range`);
    assert.ok(placement.band.lateralOffsetMeters >= placement.band.minimumOffsetMeters - 1e-6
      && placement.band.lateralOffsetMeters <= placement.band.maximumOffsetMeters + 1e-6,
    `${label} remains inside the source-safe band`);
    assert.equal(placement.band.fullyContained, true, `${label} source-safe band fully contains the prop`);
    assert.ok(placement.terrain && typeof placement.terrain === 'object', `${label} terrain metadata is present`);
    for (const field of ['heightMeters', 'roadLiftMeters', 'groundedY']) {
      assertFinite(placement.terrain[field], `${label}.terrain.${field}`);
    }
    assert.equal(placement.terrain.finite, true, `${label} terrain metadata is finite`);
    assertApprox(placement.terrain.groundedY,
      placement.terrain.heightMeters + placement.terrain.roadLiftMeters + 0.04,
      `${label}.terrain.groundedY`, 1e-5);
    assert.ok(placement.donorOrigin && typeof placement.donorOrigin === 'object',
      `${label} donor origin metadata is present`);
    assert.equal(placement.donorOrigin.alreadyStaged, false,
      `${label} donor selection excludes already-staged records`);
    assertFiniteXZ(placement.donorOrigin.position, `${label}.donorOrigin.position`);
    for (const field of ['distanceToHeroEdgesMeters', 'distanceToCorridorMeters', 'minimumDistanceMeters']) {
      assertFinite(placement.donorOrigin[field], `${label}.donorOrigin.${field}`);
      assert.ok(placement.donorOrigin[field] >= 80 - 1e-6,
        `${label}.donorOrigin.${field} keeps donors outside the 80m exclusion radius`);
    }
  });
  assert.deepEqual(corridorRoles, EXPECTED_CORRIDOR_ROLES,
    'corridor has the exact role mix');
  assert.equal(hero.donorSelection.alreadyStagedExcluded, true,
    'donor selection excludes all already-staged records before corridor placement');
  assert.equal(first.matrixScales.length, corridor.placements.length,
    'corridor matrix inspection covers all seven placements');
  first.matrixScales.forEach((entry, index) => {
    const placement = corridor.placements[index];
    const expectedBaseScale = placement.baseInstanceHidden ? 0 : placement.presentationScale;
    assert.ok(entry.matrix && entry.matrix.distance <= 1e-3,
      `corridor[${index}] runtime matrix locates the authored placement`);
    for (const axis of ['x', 'y', 'z']) {
      assertApprox(entry.matrix.scale[axis], expectedBaseScale,
        `corridor[${index}] matrix ${axis} scale`, 1e-3);
    }
    for (const component of entry.components) {
      assert.ok(component.matrix, `corridor[${index}] ${component.name} matrix is present`);
      const maximumComponentDistance = component.name === 'planter-flowers'
        ? 0.8
        : (component.name === 'bench-backs' ? 0.4 : 1e-3);
      assert.ok(component.matrix.distance <= maximumComponentDistance,
        `corridor[${index}] ${component.name} belongs to the authored prop`);
      assertApprox(
        component.matrix.translationY,
        placement.position.y + component.yOffset * placement.presentationScale,
        `corridor[${index}] ${component.name} scales about the ground pivot`,
        1e-3,
      );
      for (const axis of ['x', 'y', 'z']) {
        assertApprox(component.matrix.scale[axis], expectedBaseScale,
          `corridor[${index}] ${component.name} matrix ${axis} scale`, 1e-3);
      }
    }
  });
  assert.deepEqual(first.zeroScaleBaseInstances, {
    'planter-pots': 4,
    'planter-leaves': 4,
    'planter-flowers': 12,
    'traffic-cones': 1,
    'traffic-cone-bands': 1,
  }, 'exactly twenty-two replaced base component instances are hidden across corridor and frontage overrides');
  assert.equal(Object.values(first.zeroScaleBaseInstances).reduce((sum, count) => sum + count, 0), 22,
    'total hidden base component matrices remain exactly 22');
  const accentMaterialUuids = new Set();
  for (const [kind, expected] of Object.entries(EXPECTED_ACCENTS)) {
    const accent = first.accentMeshes[kind];
    const corridorPlacement = corridor.placements.find((candidate) => candidate.presentationKind === kind) || null;
    const frontagePlacement = hero.frontagePresentationOverrides
      .find((candidate) => candidate.presentationKind === kind) || null;
    const placement = corridorPlacement || frontagePlacement;
    assert.ok(accent && placement, `${kind}: accent mesh and placement are present`);
    assert.equal(accent.name, expected.meshName, `${kind}: accent mesh name is stable`);
    assert.equal(accent.count, expected.count, `${kind}: accent mesh has exact instance count`);
    assert.equal(accent.visible, true, `${kind}: accent mesh is visible after staging`);
    assert.equal(accent.triangles, expected.triangles, `${kind}: merged geometry triangle budget is exact`);
    assert.deepEqual(accent.maps, [], `${kind}: accent material has no texture maps`);
    assert.equal(accent.materialUuids.length, 1, `${kind}: accent uses exactly one material`);
    accentMaterialUuids.add(accent.materialUuids[0]);
    assert.ok(Array.isArray(accent.elementsByIndex)
      && accent.elementsByIndex.length === expected.count
      && accent.elementsByIndex.every((elements) => elements.length === 16),
    `${kind}: every accent instance has a matrix`);
    const expectedPlacements = [
      ...(corridor.placements.filter((candidate) => candidate.presentationKind === kind)),
      ...(hero.frontagePresentationOverrides.filter((candidate) => candidate.presentationKind === kind)),
    ];
    assert.equal(expectedPlacements.length, expected.count,
      `${kind}: diagnostics expose every authored accent instance`);
    const unmatchedMatrices = accent.elementsByIndex.map((elements) => ({ elements, matched: false }));
    for (const expectedPlacement of expectedPlacements) {
      const matrixCandidate = unmatchedMatrices.find((candidate) => !candidate.matched
        && Math.hypot(candidate.elements[12] - expectedPlacement.position.x,
          candidate.elements[14] - expectedPlacement.position.z) <= 1e-4);
      assert.ok(matrixCandidate, `${kind}: rendered instance matches an authored placement`);
      matrixCandidate.matched = true;
      assertApprox(matrixCandidate.elements[13], expectedPlacement.position.y,
        `${kind}: rendered y uses the ground pivot`, 1e-4);
    }
    const minimumLocalY = Math.min(...accent.localPositions.map((point) => point.y));
    assert.ok(minimumLocalY >= -1e-6 && minimumLocalY <= 1e-6,
      `${kind}: merged geometry is authored from local ground y=0`);
  }
  assert.equal(accentMaterialUuids.size, 1,
    'all four accent meshes share one existing material');
  const independentCorridor = independentlyMeasureCorridor(first, corridor);
  independentCorridor.forEach((measurement, index) => {
    const placement = corridor.placements[index];
    const label = `independent corridor[${index}]`;
    for (const [field, value] of Object.entries(measurement)) assertFinite(value, `${label}.${field}`);
    assert.ok(measurement.ownerAsphalt >= 0.3 - 1e-6, `${label} clears owner asphalt`);
    assert.ok(measurement.absoluteAsphalt >= 0.3 - 1e-6, `${label} clears every asphalt edge`);
    assert.ok(measurement.otherAsphalt >= 0.3 - 1e-6, `${label} clears non-owner asphalt`);
    assert.ok(measurement.building >= 0.15 - 1e-6, `${label} clears every source building polygon`);
    assert.ok(measurement.portal >= 1.2 - 1e-6, `${label} clears every hero portal capsule`);
    assert.ok(measurement.interProp >= 0.2 - 1e-6, `${label} clears every other logical prop`);
    assert.ok(measurement.endpoint >= 0.3 - 1e-6, `${label} clears both source endpoints`);
    assert.ok(measurement.lane >= 0.9 - 1e-6, `${label} preserves a rendered 0.90m pedestrian lane`);
    assertApprox(placement.ownerAsphaltClearanceMeters, measurement.ownerAsphalt,
      `${label} agrees with owner-asphalt diagnostics`, 1e-5);
    assertApprox(placement.absoluteAsphaltClearanceMeters, measurement.absoluteAsphalt,
      `${label} agrees with absolute-asphalt diagnostics`, 1e-5);
    assertApprox(placement.otherAsphaltClearanceMeters, measurement.otherAsphalt,
      `${label} agrees with other-asphalt diagnostics`, 1e-5);
    assertApprox(placement.buildingClearanceMeters, measurement.building,
      `${label} agrees with building diagnostics`, 1e-5);
    assertApprox(placement.portalCorridorClearanceMeters, measurement.portal,
      `${label} agrees with portal diagnostics`, 1e-5);
    assertApprox(placement.sourceEndpointClearanceMeters, measurement.endpoint,
      `${label} agrees with endpoint diagnostics`, 1e-5);
  });
  assertApprox(corridor.minimumInterPropClearanceMeters,
    Math.min(...independentCorridor.map((measurement) => measurement.interProp)),
    'corridor aggregate agrees with independent all-pairs prop clearance', 1e-5);

  const cameraComposition = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const placements = renderer.sidewalkPropDiagnostics?.heroFrontages?.corridor?.placements || [];
    const camera = renderer.camera;
    const controls = renderer.controls;
    const first = placements[0]?.position;
    const last = placements.at(-1)?.position;
    if (!first || !last) return null;
    const dx = last.x - first.x;
    const dz = last.z - first.z;
    const length = Math.hypot(dx, dz) || 1;
    const tx = dx / length;
    const tz = dz / length;
    const nx = -tz;
    const nz = tx;
    const midpoint = {
      x: (first.x + last.x) * 0.5,
      z: (first.z + last.z) * 0.5,
    };
    const terrainY = renderer.terrain?.heightAt
      ? renderer.terrain.heightAt(midpoint.x, midpoint.z)
      : 0;
    // A matched, street-height shot: looking down the authored SF curb from
    // outside the sidewalk, not the previous city-wide aerial framing.
    const eye = {
      x: midpoint.x - tx * 34 + nx * 8,
      y: terrainY + 6.2,
      z: midpoint.z - tz * 34 + nz * 8,
    };
    const target = {
      x: midpoint.x + tx * 2,
      y: terrainY + 1.05,
      z: midpoint.z + tz * 2,
    };
    camera.fov = 48;
    camera.updateProjectionMatrix();
    camera.position.set(eye.x, eye.y, eye.z);
    camera.lookAt(target.x, target.y, target.z);
    if (controls) {
      controls.target.set(target.x, target.y, target.z);
      controls.update();
      controls.enabled = false;
    }
    camera.updateMatrixWorld(true);
    const project = (position) => {
      const point = camera.position.clone().set(position.x, position.y, position.z).project(camera);
      return {
        x: (point.x * 0.5 + 0.5) * innerWidth,
        y: (-point.y * 0.5 + 0.5) * innerHeight,
        depth: point.z,
        ndcX: point.x,
        ndcY: point.y,
        visible: point.z >= -1 && point.z <= 1 && point.x >= -1 && point.x <= 1
          && point.y >= -1 && point.y <= 1,
      };
    };
    return {
      fov: camera.fov,
      eye,
      target,
      direction: { x: tx, z: tz },
      projections: placements.map((placement) => project(placement.position)),
    };
  });
  assert.ok(cameraComposition, 'matched SF corridor camera composition is available');
  assertApprox(cameraComposition.fov, 48, 'matched SF corridor camera fov', 1e-9);
  assert.equal(cameraComposition.projections.length, EXPECTED_CORRIDOR.t.length,
    'matched SF camera projects all seven corridor placements');
  cameraComposition.projections.forEach((projection, index) => {
    assert.equal(projection.visible, true, `corridor[${index}] is inside the matched SF camera frame`);
    assertFinite(projection.x, `corridor[${index}] projected screen x`);
    assertFinite(projection.y, `corridor[${index}] projected screen y`);
    assertFinite(projection.depth, `corridor[${index}] projected depth`);
  });
  const projectedDepth = cameraComposition.projections.map((projection) => projection.depth);
  const projectedX = cameraComposition.projections.map((projection) => projection.x);
  const projectedY = cameraComposition.projections.map((projection) => projection.y);
  for (let index = 1; index < projectedDepth.length; index += 1) {
    assert.ok(projectedDepth[index] > projectedDepth[index - 1] + 1e-6,
      `corridor screen order recedes monotonically at placement ${index}`);
  }
  const monotonic = (values, direction) => values.every((value, index) => index === 0
    || direction * (value - values[index - 1]) > 1e-3);
  assert.ok(monotonic(projectedX, 1) || monotonic(projectedX, -1)
    || monotonic(projectedY, 1) || monotonic(projectedY, -1),
  'corridor placements preserve a monotonic screen order in the matched SF camera');

  await page.evaluate(() => {
    document.querySelectorAll('#app > :not(#scene-canvas)').forEach((element) => {
      element.style.display = 'none';
    });
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: '.qa-citygen-hero-sidewalk.png' });

  // A second fresh document is the determinism gate: one fixed seed, one source
  // map, one canonical runtime, and one exact set of staged positions.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu
      && window.__CITYGEN__?.getState().generator === 'sf-builtin'
      && window.__CITYGEN__?.getState().furniture?.props === 900
      && window.__CITYGEN__?.getRenderer()?.sidewalkPropDiagnostics?.heroFrontages?.finite === true
      && window.__CITYGEN__?.getRenderer()?.sidewalkPropDiagnostics?.heroFrontages?.treatedIds?.length === 6,
    { timeout: 30000 },
  );
  const second = await readSnapshot();
  assert.equal(second.backend, 'webgpu');
  assertExactKindCounts(second.kinds, 'second load');
  assertPropSceneContract(second.scene, 'second load sidewalk-props scene');
  canonicalSnapshotEqual(first, second, 'fresh-load determinism');
  assert.equal(second.identity.backend, 'webgpu', 'fresh load keeps WebGPU backend');
  assert.equal(second.identity.rendererStable, true, 'fresh load keeps renderer identity stable');
  assert.equal(second.identity.rootInScene, true, 'fresh load keeps world root attached');
  assert.equal(second.identity.canvasIdentity, true, 'fresh load keeps renderer/canvas identity');
  assert.deepEqual(errors, []);
  const report = {
    backend: first.backend,
    props: first.props,
    segmentOwners: first.segmentOwners,
    kinds: first.kinds,
    measuredBandViolations: first.measuredBandViolations,
    propScene: first.scene,
    heroFrontages: {
      expectedIds: first.hero.expectedIds,
      treatedIds: first.hero.treatedIds,
      donorRecords: first.hero.donorRecords,
      logicalPropsBefore: first.hero.logicalPropsBefore,
      logicalPropsAfter: first.hero.logicalPropsAfter,
      roles: first.hero.roles,
      donorSelection: first.hero.donorSelection,
      entries: first.hero.entries,
      corridor: first.hero.corridor,
      frontagePresentationOverrides: first.hero.frontagePresentationOverrides,
      frontagePresentationResources: first.hero.frontagePresentationResources,
      frontagePresentationTopologies: first.hero.frontagePresentationTopologies,
      hiddenBaseComponentInstances: first.zeroScaleBaseInstances,
      incremental: first.hero.incremental,
      asphaltOverlaps: first.hero.asphaltOverlaps,
      buildingOverlaps: first.hero.buildingOverlaps,
      portalCorridorIntrusions: first.hero.portalCorridorIntrusions,
      absoluteAsphaltOverlaps: first.hero.absoluteAsphaltOverlaps,
      additionalAsphaltIntrusions: first.hero.additionalAsphaltIntrusions,
      sourceFootprintsUnchanged: first.hero.sourceFootprintsUnchanged,
      sourcePortalsUnchanged: first.hero.sourcePortalsUnchanged,
      finite: first.hero.finite,
    },
    cameraComposition,
    identity: first.identity,
    deterministicFreshLoad: true,
    screenshot: '.qa-citygen-hero-sidewalk.png',
    errors,
  };
  console.log(JSON.stringify({ result: 'PASS', url, report, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
