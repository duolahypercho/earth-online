import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createSanFranciscoSectorCatalog,
  createSanFranciscoStreaming,
} from '../src/streaming.js';

const SURFACE_PATCH_MAXIMUM = 8;
const MARKING_PATCH_MAXIMUM = 2;
const ROAD_TERRAIN_OFFSET = 0.014;
const PAINT_ROAD_OFFSET = 0.026;
const EPSILON = 1e-5;

function assertTriangles(geometry, maximumSpan, label) {
  const positions = geometry.getAttribute('position');
  const colors = geometry.getAttribute('color');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let checked = 0;
  let paintTriangles = 0;
  for (let index = 0; index < positions.count; index += 3) {
    a.fromBufferAttribute(positions, index);
    b.fromBufferAttribute(positions, index + 1);
    c.fromBufferAttribute(positions, index + 2);
    cross.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    assert(cross.lengthSq() > 1e-12, `${label} contains a degenerate triangle.`);
    const paint = colors && colors.getX(index) > 0.8;
    const limit = paint ? MARKING_PATCH_MAXIMUM : maximumSpan;
    assert(
      Math.max(a.x, b.x, c.x) - Math.min(a.x, b.x, c.x) <= limit + EPSILON,
      `${label} triangle exceeds its ${limit} m x patch limit.`,
    );
    assert(
      Math.max(a.z, b.z, c.z) - Math.min(a.z, b.z, c.z) <= limit + EPSILON,
      `${label} triangle exceeds its ${limit} m z patch limit.`,
    );
    if (paint) paintTriangles += 1;
    checked += 1;
  }
  return { checked, paintTriangles };
}

function interpolatedTerrain(catalog, worldX, worldZ) {
  const cellMinX = Math.floor((worldX + EPSILON) / SURFACE_PATCH_MAXIMUM)
    * SURFACE_PATCH_MAXIMUM;
  const cellMinZ = Math.floor((worldZ + EPSILON) / SURFACE_PATCH_MAXIMUM)
    * SURFACE_PATCH_MAXIMUM;
  const x = THREE.MathUtils.clamp((worldX - cellMinX) / SURFACE_PATCH_MAXIMUM, 0, 1);
  const z = THREE.MathUtils.clamp((worldZ - cellMinZ) / SURFACE_PATCH_MAXIMUM, 0, 1);
  const a = catalog.getSurfaceHeight(cellMinX, cellMinZ);
  const b = catalog.getSurfaceHeight(cellMinX, cellMinZ + SURFACE_PATCH_MAXIMUM);
  const c = catalog.getSurfaceHeight(
    cellMinX + SURFACE_PATCH_MAXIMUM,
    cellMinZ + SURFACE_PATCH_MAXIMUM,
  );
  const d = catalog.getSurfaceHeight(cellMinX + SURFACE_PATCH_MAXIMUM, cellMinZ);
  if (![a, b, c, d].every(Number.isFinite)) return catalog.getSurfaceHeight(worldX, worldZ);
  return z >= x
    ? a * (1 - z) + b * (z - x) + c * x
    : a * (1 - x) + c * z + d * (x - z);
}

function getDetailedSector(scene, key) {
  return scene.children.find(
    (child) => child.visible
      && child.name === 'Pooled detailed city sector'
      && child.userData.sectorKey === key,
  );
}

const scene = new THREE.Scene();
const catalog = createSanFranciscoSectorCatalog();
const streaming = createSanFranciscoStreaming({ scene, catalog });
const camera = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1800);
camera.position.set(576, 80, 200);
camera.lookAt(576, 0, 0);
camera.updateMatrixWorld(true);
streaming.update(new THREE.Vector3(576, 2, 0), camera, 0.3, 0.3);
for (let step = 0; step < 240; step += 1) {
  if (getDetailedSector(scene, '1:0') && getDetailedSector(scene, '2:0')) break;
  streaming.update(
    new THREE.Vector3(576, 2, 0),
    camera,
    0.25,
    0.3 + (step + 1) * 0.25,
  );
}
const west = getDetailedSector(scene, '1:0');
const east = getDetailedSector(scene, '2:0');
assert(west && east, 'Adjacent detailed sectors 1:0 and 2:0 were not active.');

for (const sector of [west, east]) {
  const roadMeshes = sector.children.filter(
    (child) => child.name === 'Pooled seam-aligned six-by-six road lattice',
  );
  const sidewalkMeshes = sector.children.filter(
    (child) => child.name === 'Pooled six-by-six raised sidewalks and curbs',
  );
  assert.equal(roadMeshes.length, 1, `${sector.userData.sectorKey} changed road draw topology.`);
  assert.equal(
    sidewalkMeshes.length,
    1,
    `${sector.userData.sectorKey} changed sidewalk draw topology.`,
  );
}

const road = west.userData.roads;
const ground = west.userData.ground;
const sidewalk = west.userData.sidewalks;
const roadPositions = road.geometry.getAttribute('position');
const roadColors = road.geometry.getAttribute('color');
const roadBase = road.geometry.userData.streamBasePositions;
assert(roadColors, 'Road geometry has no vertex-color attribute.');
assert.equal(roadColors.count, roadPositions.count, 'Road color and position counts differ.');

let asphaltVertices = 0;
let paintVertices = 0;
let maximumRoadTerrainDisagreement = 0;
let maximumPaintRoadDisagreement = 0;
for (let index = 0; index < roadPositions.count; index += 1) {
  const offset = index * 3;
  const worldX = west.position.x + roadBase[offset];
  const worldZ = west.position.z + roadBase[offset + 2];
  const sampledTerrain = catalog.getSurfaceHeight(worldX, worldZ);
  const actualY = west.position.y + road.position.y + roadPositions.getY(index);
  const paint = roadColors.getX(index) > 0.8;
  const expectedY = sampledTerrain + ROAD_TERRAIN_OFFSET + (paint ? PAINT_ROAD_OFFSET : 0);
  assert(
    Math.abs(actualY - expectedY) <= EPSILON,
    `Road vertex ${index} does not preserve its authored vertical offset.`,
  );
  const terrainInterpolation = interpolatedTerrain(catalog, worldX, worldZ);
  if (paint) {
    paintVertices += 1;
    maximumPaintRoadDisagreement = Math.max(
      maximumPaintRoadDisagreement,
      Math.abs(actualY - (terrainInterpolation + ROAD_TERRAIN_OFFSET) - PAINT_ROAD_OFFSET),
    );
  } else {
    asphaltVertices += 1;
    maximumRoadTerrainDisagreement = Math.max(
      maximumRoadTerrainDisagreement,
      Math.abs(actualY - terrainInterpolation - ROAD_TERRAIN_OFFSET),
    );
  }
}
assert(asphaltVertices > 0 && paintVertices > 0, 'Road colors do not identify asphalt and paint.');
assert(
  maximumRoadTerrainDisagreement <= 0.002 + EPSILON,
  'Road/terrain interpolation disagreement exceeds 2 mm.',
);
assert(
  maximumPaintRoadDisagreement <= 0.002 + EPSILON,
  'Paint/road interpolation disagreement exceeds 2 mm.',
);

const triangleResults = {
  ground: assertTriangles(ground.geometry, SURFACE_PATCH_MAXIMUM, 'ground'),
  road: assertTriangles(road.geometry, SURFACE_PATCH_MAXIMUM, 'road'),
  sidewalk: assertTriangles(sidewalk.geometry, SURFACE_PATCH_MAXIMUM, 'sidewalk'),
};
assert(triangleResults.road.paintTriangles > 0, 'No paint triangles were found in the road mesh.');

function collectGroundSeam(sector, localX) {
  const seam = new Map();
  const positions = sector.userData.ground.geometry.getAttribute('position');
  for (let index = 0; index < positions.count; index += 1) {
    if (Math.abs(positions.getX(index) - localX) > EPSILON) continue;
    const worldZ = sector.position.z + positions.getZ(index);
    const worldY = sector.position.y + positions.getY(index);
    seam.set(worldZ.toFixed(5), worldY);
  }
  return seam;
}

const westSeam = collectGroundSeam(west, catalog.sectorSize * 0.5);
const eastSeam = collectGroundSeam(east, -catalog.sectorSize * 0.5);
assert(westSeam.size > 0 && westSeam.size === eastSeam.size, 'Sector seam samples differ.');
let maximumSeamError = 0;
westSeam.forEach((westY, z) => {
  assert(eastSeam.has(z), `Adjacent sector is missing seam vertex z=${z}.`);
  maximumSeamError = Math.max(maximumSeamError, Math.abs(westY - eastSeam.get(z)));
});
assert(maximumSeamError <= EPSILON, 'Adjacent sector boundary world Y values do not match.');

const presentation = streaming.getSectorPresentation('1:0')?.presentation;
assert.equal(presentation?.crosswalkCount, 100);
assert.equal(presentation?.crosswalkStripeCount, 500);
assert.equal(presentation?.crosswalkStripesPerCrossing, 5);
assert.equal(presentation?.crosswalkStripeWidth, 0.45);
assert.equal(presentation?.crosswalkStripeGap, 0.35);
assert.equal(presentation?.crosswalkCurbInset, 0.15);
assert.equal(presentation?.crosswalkIntersectionSetback, 0.6);
assert.equal(presentation?.crosswalkLongDimensions?.eastWestRoad, 11.7);
assert.equal(presentation?.crosswalkLongDimensions?.northSouthRoad, 11.7);

console.log(JSON.stringify({
  result: 'road grade and marking geometry invariants passed',
  drawTopology: { roadsPerDetailedSector: 1, sidewalksPerDetailedSector: 1 },
  vertices: { asphalt: asphaltVertices, paint: paintVertices },
  triangles: triangleResults,
  maximumSeamError,
  maximumRoadTerrainDisagreement,
  maximumPaintRoadDisagreement,
  presentation: {
    crosswalkCount: presentation.crosswalkCount,
    crosswalkStripeCount: presentation.crosswalkStripeCount,
    crosswalkLongDimensions: presentation.crosswalkLongDimensions,
  },
}, null, 2));
