/** Fail-closed verifier for the native Ferry production-tile candidate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFerryProductionTile } from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const RECEIPT_PATH = path.join(DIR, 'ferry-production-tile-v1.receipt.json');
const PACKAGE_PATH = path.join(DIR, 'ferry-production-tile-v1.package.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch'); assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch'); assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB declared length mismatch');
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing'); const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binOffset = 20 + jsonLength; assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing'); const binLength = bytes.readUInt32LE(binOffset); assert.equal(binOffset + 8 + binLength, bytes.length, 'GLB BIN length mismatch');
  return { gltf, bin: bytes.subarray(binOffset + 8) };
}

function inspectPrimitive(gltf, bin, primitive) {
  const positionAccessor = gltf.accessors[primitive.attributes.POSITION]; const positionView = gltf.bufferViews[positionAccessor.bufferView]; const indexAccessor = gltf.accessors[primitive.indices]; const indexView = gltf.bufferViews[indexAccessor.bufferView];
  assert.equal(positionAccessor.componentType, 5126); assert.equal(positionAccessor.type, 'VEC3'); assert.equal(indexAccessor.componentType, 5125); assert.equal(indexAccessor.type, 'SCALAR'); assert.equal(indexAccessor.count % 3, 0);
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positionAccessor.count; index += 1) for (let axis = 0; axis < 3; axis += 1) { const value = bin.readFloatLE((positionView.byteOffset ?? 0) + (index * 3 + axis) * 4); min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); }
  for (let axis = 0; axis < 3; axis += 1) { assert(Math.abs(min[axis] - positionAccessor.min[axis]) <= 2e-5, `${primitive.extras.category} accessor min mismatch`); assert(Math.abs(max[axis] - positionAccessor.max[axis]) <= 2e-5, `${primitive.extras.category} accessor max mismatch`); }
  for (let index = 0; index < indexAccessor.count; index += 1) assert(bin.readUInt32LE((indexView.byteOffset ?? 0) + index * 4) < positionAccessor.count, `${primitive.extras.category} index out of range`);
  return { vertices: positionAccessor.count, indices: indexAccessor.count, triangles: indexAccessor.count / 3, sourceOsmWayCount: primitive.extras.sourceOsmWayIds.length, min: positionAccessor.min, max: positionAccessor.max };
}

const [receipt, mapPackage] = await Promise.all([readJson(RECEIPT_PATH), readJson(PACKAGE_PATH)]);
assert.equal(receipt.status, 'provisional-vertical-unrealized'); assert.equal(mapPackage.status, 'provisional-vertical-unrealized'); assert.equal(receipt.tile.identity, 'epsg26910-1441-10893');
assert.deepEqual(receipt.tile.boundsEpsg26910Metres, [553344, 4182912, 553728, 4183296]); assert.deepEqual(receipt.tile.originEpsg26910VerticalMetres, [553344, 4182912, 0]); assert.deepEqual(receipt.tile.originTupleOrder, ['easting', 'northing', 'vertical']);
assert.equal(receipt.tile.runtimeFrame, 'provisional-utm-source-declared-navd88-unrealized'); assert.deepEqual(receipt.lods.map(({ level }) => level), [0], 'Only truthful LOD0 may be emitted'); assert.deepEqual(mapPackage.lods.map(({ level }) => level), [0]);
assert.equal(receipt.ferryBuilding.present, true); assert.equal(receipt.ferryBuilding.sourceFeatureId, 'way/558731934'); assert.match(receipt.relationCoverage.statement, /remain unrepresented and are not claimed/);
assert.equal(receipt.surfaceClassification.authority, 'OpenStreetMap natural=coastline ways in the byte-locked PBF');
assert.equal(receipt.surfaceClassification.coastlineDirectionRule, 'OSM coastline direction: land on left, water on right');
assert.equal(receipt.surfaceClassification.terrainWaterOverlapAreaSquareMetres, 0);
assert(Math.abs(receipt.surfaceClassification.partitionAreaSquareMetres - 384 ** 2) <= 0.001, 'Land/water partition must cover the exact tile');
for (const lod of receipt.lods) {
  assert(lod.path.startsWith('public/data/world/production-artifacts/ferry-production-tile-v1/')); assert(!lod.path.includes('..')); const artifactPath = path.resolve(ROOT, lod.path); const bytes = await readFile(artifactPath);
  assert.equal(bytes.length, lod.bytes, 'LOD byte count mismatch'); assert.equal(`sha256:${sha256(bytes)}`, lod.artifactHash, 'LOD disk hash mismatch'); assert.equal(mapPackage.lods[lod.level].artifactHash, lod.artifactHash, 'Package/receipt LOD hash mismatch');
  const { gltf, bin } = parseGlb(bytes); assert.equal(gltf.extras.tileId, receipt.tile.identity); assert.equal(gltf.extras.lod, lod.level); assert.equal(gltf.extras.runtimeFrame, receipt.tile.runtimeFrame); assert.deepEqual(gltf.extras.tileOriginEpsg26910VerticalMetres, receipt.tile.originEpsg26910VerticalMetres); assert.deepEqual(gltf.extras.originTupleOrder, receipt.tile.originTupleOrder); assert.deepEqual(gltf.extras.vertexAxes, receipt.tile.vertexAxes);
  assert.equal(gltf.meshes.length, 1); assert.deepEqual(gltf.meshes[0].primitives.map(({ extras }) => extras.category), ['terrain', 'water', 'coastline', 'roads', 'buildings']); const stats = Object.fromEntries(gltf.meshes[0].primitives.map((primitive) => [primitive.extras.category, inspectPrimitive(gltf, bin, primitive)]));
  for (const category of ['terrain', 'water', 'coastline', 'roads', 'buildings']) { const { min: _min, max: _max, ...actual } = stats[category]; assert.deepEqual(actual, lod.meshStats[category], `${category} mesh stats mismatch`); }
  const min = [0, 1, 2].map((axis) => Math.min(...Object.values(stats).map((stat) => stat.min[axis]))); const max = [0, 1, 2].map((axis) => Math.max(...Object.values(stats).map((stat) => stat.max[axis]))); assert.deepEqual({ min, max }, lod.boundsLocalMetres, 'LOD local bounds mismatch'); assert(min[0] >= 0 && min[2] >= 0 && max[0] <= 384 && max[2] <= 384, 'Geometry escapes 384 m tile');
  const building = gltf.meshes[0].primitives.find(({ extras }) => extras.category === 'buildings'); assert(building.extras.sourceOsmWayIds.includes(558731934), 'Ferry Building OSM id missing from GLB');
}

const rebuilt = await buildFerryProductionTile({ write: false, finalizeDescriptor: true });
assert.equal(rebuilt.glbs.length, 1); assert.equal(`sha256:${sha256(rebuilt.glbs[0].bytes)}`, receipt.lods[0].artifactHash, 'Deterministic in-memory rebuild hash mismatch'); assert.deepEqual(rebuilt.receipt.lods, receipt.lods, 'Deterministic receipt LOD metadata mismatch'); assert.deepEqual(rebuilt.packageDescriptor, mapPackage, 'Deterministic package descriptor mismatch');

console.log(JSON.stringify({ result: 'Ferry production tile candidate passed', status: receipt.status, tile: receipt.tile.identity, artifact: receipt.lods[0].path, bytes: receipt.lods[0].bytes, sha256: receipt.lods[0].artifactHash, meshStats: receipt.lods[0].meshStats, deterministicRebuild: true, ferryBuildingOsmWay: 558731934 }, null, 2));
