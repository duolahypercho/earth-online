/**
 * Build an isolated, non-runtime 4 m terrain LOD1 proof for a small Ferry
 * connected sample.  It deliberately does not touch manifests, packages, or
 * production artifacts.  A proof that exceeds the one-to-one contract is
 * recorded as rejected, never promoted.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-lod1-4m-proof-v1');
const METRIC_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const FERRY_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const CONTRACT_PATH = path.join(ROOT, 'public/data/world/contracts/sf-one-to-one-map.contract.json');
const STEP = 4;
const TILE_SIZE = 384;
const SAMPLE = Object.freeze([
  [1440, 10892], [1440, 10893], [1441, 10893], [1440, 10894],
]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes) => `sha256:${sha256(bytes)}`;
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const idFor = ([easting, northing]) => `epsg26910-${easting}-${northing}`;
const productionStem = (id) => id === 'epsg26910-1441-10893' ? 'ferry-production-tile-v1' : id;
const productionDir = (id) => id === 'epsg26910-1441-10893' ? FERRY_ROOT : path.join(METRIC_ROOT, id);

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length mismatch');
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binOffset = 20 + jsonLength; assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing');
  return { gltf, bin: bytes.subarray(binOffset + 8) };
}

function glbCategorySemanticPayload(bytes, expectedCategory) {
  const { gltf, bin } = parseGlb(bytes); const positionsOut = []; const indicesOut = []; let vertexOffset = 0; let found = false;
  for (const primitive of gltf.meshes[0].primitives) {
    const category = primitive.extras?.category; assert(category, 'GLB primitive category missing');
    if (category !== expectedCategory) continue;
    const positions = gltf.accessors[primitive.attributes.POSITION]; const indices = gltf.accessors[primitive.indices];
    const positionView = gltf.bufferViews[positions.bufferView]; const indexView = gltf.bufferViews[indices.bufferView];
    assert.equal(positions.componentType, 5126, `${category} positions must be float32`); assert.equal(indices.componentType, 5123, `${category} indices must be uint16`);
    const positionOffset = positionView.byteOffset ?? 0; const indexOffset = indexView.byteOffset ?? 0;
    positionsOut.push(bin.subarray(positionOffset, positionOffset + positions.count * 12));
    const normalized = Buffer.alloc(indices.count * 4); for (let index = 0; index < indices.count; index += 1) normalized.writeUInt32LE(bin.readUInt16LE(indexOffset + index * 2) + vertexOffset, index * 4);
    indicesOut.push(normalized); vertexOffset += positions.count; found = true;
  }
  return found ? Buffer.concat([...positionsOut, ...indicesOut]) : Buffer.alloc(0);
}

function sourceGrid(lod0Bytes) {
  const { gltf, bin } = parseGlb(lod0Bytes); const values = new Map(); const surfaceVertices = new Map();
  for (const primitive of gltf.meshes[0].primitives) {
    if (!['terrain', 'water'].includes(primitive.extras?.category)) continue;
    const accessor = gltf.accessors[primitive.attributes.POSITION]; const view = gltf.bufferViews[accessor.bufferView]; const offset = view.byteOffset ?? 0;
    for (let index = 0; index < accessor.count; index += 1) {
      const at = offset + index * 12; const x = bin.readFloatLE(at); const y = bin.readFloatLE(at + 4); const z = bin.readFloatLE(at + 8);
      const surfaceKey = `${x.toFixed(6)},${z.toFixed(6)}`; const surfacePrevious = surfaceVertices.get(surfaceKey);
      assert(surfacePrevious === undefined || Math.abs(surfacePrevious.y - y) <= 1e-6, `LOD0 terrain/water surface disagreement at ${surfaceKey}`); surfaceVertices.set(surfaceKey, { x, y, z });
      if (Math.abs(x - Math.round(x)) > 1e-5 || Math.abs(z - Math.round(z)) > 1e-5) continue;
      const key = `${Math.round(x)},${Math.round(z)}`; const existing = values.get(key);
      assert(existing === undefined || Math.abs(existing - y) <= 1e-6, `LOD0 terrain/water source sample disagreement at ${key}`); values.set(key, y);
    }
  }
  assert.equal(values.size, (TILE_SIZE + 1) ** 2, 'LOD0 terrain/water does not expose every 1 m source sample');
  return { values, surfaceVertices };
}

function terrainTriangles(geometry) {
  const cells = new Map();
  for (const name of ['terrain', 'water']) {
    const data = geometry[name];
    for (let index = 0; index < data.indices.length; index += 3) {
      const triangle = data.indices.slice(index, index + 3).map((vertex) => data.positions.slice(vertex * 3, vertex * 3 + 3));
      const minX = Math.min(...triangle.map(([x]) => x)); const maxX = Math.max(...triangle.map(([x]) => x));
      const minZ = Math.min(...triangle.map(([, , z]) => z)); const maxZ = Math.max(...triangle.map(([, , z]) => z));
      const fromX = Math.max(0, Math.floor(minX / STEP)); const toX = Math.min(TILE_SIZE / STEP - 1, Math.floor(maxX / STEP));
      const fromZ = Math.max(0, Math.floor(minZ / STEP)); const toZ = Math.min(TILE_SIZE / STEP - 1, Math.floor(maxZ / STEP));
      for (let z = fromZ; z <= toZ; z += 1) for (let x = fromX; x <= toX; x += 1) { const key = `${x},${z}`; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(triangle); }
    }
  }
  return cells;
}

function interpolatedHeight(cells, x, z) {
  const cell = `${Math.min(TILE_SIZE / STEP - 1, Math.floor(x / STEP))},${Math.min(TILE_SIZE / STEP - 1, Math.floor(z / STEP))}`;
  const candidates = cells.get(cell) ?? [];
  for (const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] of candidates) {
    const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(denominator) < 1e-10) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator; const w = 1 - u - v;
    if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * ay + v * by + w * cy;
  }
  assert.fail(`No LOD1 terrain/water triangle covers source sample ${x},${z}`);
}

function edgeSamples(geometry, side) {
  const points = new Map();
  for (const name of ['terrain', 'water']) for (let index = 0; index < geometry[name].positions.length; index += 3) {
    const [x, y, z] = geometry[name].positions.slice(index, index + 3); const coordinate = side === 'east' || side === 'west' ? z : x;
    const onEdge = side === 'east' ? x === TILE_SIZE : side === 'west' ? x === 0 : side === 'north' ? z === TILE_SIZE : z === 0;
    if (!onEdge || Math.abs(coordinate / STEP - Math.round(coordinate / STEP)) > 1e-6) continue;
    const previous = points.get(coordinate); assert(previous === undefined || Math.abs(previous - y) <= 1e-6, `LOD1 edge terrain/water disagreement at ${side}:${coordinate}`); points.set(coordinate, y);
  }
  assert.equal(points.size, TILE_SIZE / STEP + 1, `LOD1 ${side} edge misses a phase-locked source sample`);
  return points;
}

function validateSeam(a, aSide, b, bSide) {
  const aEdge = edgeSamples(a.geometry, aSide); const bEdge = edgeSamples(b.geometry, bSide); let maxVerticalDifference = 0;
  for (const [coordinate, aHeight] of aEdge) { assert(bEdge.has(coordinate), `LOD1 seam lacks ${coordinate}`); maxVerticalDifference = Math.max(maxVerticalDifference, Math.abs(aHeight - bEdge.get(coordinate))); }
  assert.equal(maxVerticalDifference, 0, `LOD1 seam ${a.id}/${b.id} phase-locked edge heights differ`);
  return { tiles: [a.id, b.id], sides: [aSide, bSide], samples: aEdge.size, maxVerticalDifferenceMetres: maxVerticalDifference };
}

async function readProduction(id) {
  const dir = productionDir(id); const stem = productionStem(id); const [glb, receiptBytes, packageBytes] = await Promise.all([
    readFile(path.join(dir, `${stem}.lod0.glb`)), readFile(path.join(dir, `${stem}.receipt.json`)), readFile(path.join(dir, `${stem}.package.json`)),
  ]);
  const receipt = JSON.parse(receiptBytes); const mapPackage = JSON.parse(packageBytes);
  assert.equal(receipt.tile.identity, id, `Wrong production receipt for ${id}`); assert.equal(receipt.lods[0].artifactHash, digest(glb), `Production LOD0 hash drifted for ${id}`);
  assert.equal(mapPackage.lods[0].artifactHash, digest(glb), `Production package LOD0 hash drifted for ${id}`);
  const sourceLocks = [];
  for (const lock of mapPackage.sourceLocks) { const bytes = await readFile(path.join(ROOT, lock.path)); assert.equal(sha256(bytes), lock.sha256, `Source lock drifted for ${id}: ${lock.id}`); sourceLocks.push(lock); }
  return { id, dir, stem, glb, receiptBytes, packageBytes, receipt, mapPackage, sourceLocks };
}

const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'));
const budgets = contract.lod;
assert.equal(budgets.maxHorizontalDeviationMetres, 0.5); assert.equal(budgets.maxVerticalDeviationMetres, 0.25);
const production = await Promise.all(SAMPLE.map((grid) => readProduction(idFor(grid))));
const preflightHashes = new Map(production.flatMap(({ id, glb, receiptBytes, packageBytes }) => [[`${id}:lod0`, digest(glb)], [`${id}:receipt`, digest(receiptBytes)], [`${id}:package`, digest(packageBytes)]]));
const sharedInputs = await loadSfMetricSharedInputs(); const terrainDigests = await loadSfMetricVerifiedTerrainSourceDigests();
const built = [];
for (const [gridEasting, gridNorthing] of SAMPLE) {
  const id = idFor([gridEasting, gridNorthing]); const source = production.find((entry) => entry.id === id); assert(source, `Missing prepared production input ${id}`);
  const first = await buildSfMetricTile({ tile: { gridEasting, gridNorthing }, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, terrainGridStepMetres: STEP, lodLevel: 1 });
  const second = await buildSfMetricTile({ tile: { gridEasting, gridNorthing }, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, terrainGridStepMetres: STEP, lodLevel: 1 });
  assert.equal(digest(first.glbs[0].bytes), digest(second.glbs[0].bytes), `LOD1 rebuild drifted for ${id}`);
  for (const category of ['coastline', 'roads', 'buildings']) assert.deepEqual(glbCategorySemanticPayload(first.glbs[0].bytes, category), glbCategorySemanticPayload(source.glb, category), `${id} ${category} changed under terrain-only LOD1 proof`);
  const { values: samples, surfaceVertices } = sourceGrid(source.glb); const cells = terrainTriangles(first.categories); let maxVerticalDeviationMetres = 0;
  for (let z = 0; z <= TILE_SIZE; z += 1) for (let x = 0; x <= TILE_SIZE; x += 1) {
    const sourceHeight = samples.get(`${x},${z}`); assert.notEqual(sourceHeight, undefined, `${id} LOD0 sample missing ${x},${z}`);
    const lod1Height = interpolatedHeight(cells, x, z); maxVerticalDeviationMetres = Math.max(maxVerticalDeviationMetres, Math.abs(lod1Height - sourceHeight));
  }
  for (const { x, y, z } of surfaceVertices.values()) maxVerticalDeviationMetres = Math.max(maxVerticalDeviationMetres, Math.abs(interpolatedHeight(cells, x, z) - y));
  const lod = first.receipt.lods[0]; built.push({ id, geometry: first.categories, lod1: first.glbs[0], source, maxVerticalDeviationMetres, measuredSourceSurfaceVertices: surfaceVertices.size, triangles: Object.fromEntries(Object.entries(lod.meshStats).map(([name, stats]) => [name, stats.triangles])), bytes: first.glbs[0].bytes.length, sourceLocks: source.sourceLocks });
}
const seams = [
  validateSeam(built[0], 'north', built[1], 'south'), validateSeam(built[1], 'east', built[2], 'west'), validateSeam(built[1], 'north', built[3], 'south'),
];
const maxVerticalDeviationMetres = Math.max(...built.map((entry) => entry.maxVerticalDeviationMetres));
const maxHorizontalDeviationMetres = 0;
const contractEligible = maxHorizontalDeviationMetres <= budgets.maxHorizontalDeviationMetres && maxVerticalDeviationMetres <= budgets.maxVerticalDeviationMetres;
const totals = built.reduce((sum, entry) => ({ bytes: sum.bytes + entry.bytes, triangles: sum.triangles + Object.values(entry.triangles).reduce((part, count) => part + count, 0) }), { bytes: 0, triangles: 0 });
const proof = {
  schemaVersion: 1, kind: 'sf-lod1-4m-terrain-proof', id: 'sf-lod1-4m-proof-v1', status: contractEligible ? 'proof-passed-not-promoted' : 'proof-rejected-contract-error-budget',
  nonPromotion: 'preview/proof only; not a production package, runtime asset, manifest entry, or streaming input', terrainGridStepMetres: STEP,
  coordinateFrame: { horizontalCrs: 'EPSG:26910', runtimeFrame: 'provisional-utm-source-declared-navd88-unrealized', unitsPerMetre: 1, scale: [1, 1, 1], translationMetres: [0, 0, 0], verticalStatus: 'provisional-source-declared-navd88-unrealized' },
  sample: { tiles: built.map(({ id }) => id), topology: 'connected Ferry three-tile L plus west/south neighbor; known non-ready epsg26910-1441-10894 intentionally excluded' },
  sourceBinding: built.map(({ id, source, sourceLocks }) => ({ id, lod0: { path: relative(path.join(source.dir, `${source.stem}.lod0.glb`)), sha256: digest(source.glb) }, receipt: { path: relative(path.join(source.dir, `${source.stem}.receipt.json`)), sha256: digest(source.receiptBytes) }, mapPackage: { path: relative(path.join(source.dir, `${source.stem}.package.json`)), sha256: digest(source.packageBytes) }, sourceLocks })),
  validation: { method: 'all 385x385 integer LOD0 terrain/water source samples plus every unique fractional LOD0 terrain/water vertex (including coastline intersections) projected vertically to the 4m triangle surface; horizontal sample coordinates are unchanged', continuousSupremumQualification: 'maximum among measured LOD0 surface vertices; a lower bound sufficient to reject this proof, not a claimed continuous triangle-overlay supremum', integerSourceSamplesPerTile: 385 ** 2, maxHorizontalDeviationMetres, maxVerticalDeviationMetres, contractBudgets: { maxHorizontalDeviationMetres: budgets.maxHorizontalDeviationMetres, maxVerticalDeviationMetres: budgets.maxVerticalDeviationMetres }, contractEligible, seams, seamEvidenceQualification: 'phase-locked terrain/water edge-height equality at 4m samples; edge triangle topology, ordering, coastline geometry, and full bytes are not claimed identical', deterministicRebuild: true, nonTerrainGeometry: 'serialized position/index payloads for coastline, roads, and buildings match source LOD0 exactly; GLB JSON, materials, primitive extras, and chunk layout are not claimed identical' },
  tiles: built.map(({ id, lod1, maxVerticalDeviationMetres: vertical, measuredSourceSurfaceVertices, triangles, bytes }) => ({ id, artifact: { path: relative(path.join(OUTPUT_DIR, `${id}.lod1-4m.glb`)), sha256: digest(lod1.bytes), bytes }, triangles, measuredSourceSurfaceVertices, maxHorizontalDeviationMetres: 0, maxVerticalDeviationMetres: vertical })),
  budgets: { measuredSample: totals, sampleAveragePerTile: { bytes: totals.bytes / built.length, triangles: totals.triangles / built.length }, projected598AtSampleAverage: { bytes: totals.bytes / built.length * 598, triangles: totals.triangles / built.length * 598 }, qualification: 'arithmetic projection from this four-tile proof sample only; not a citywide forecast or promotion claim' },
};
for (const entry of production) {
  const after = await readProduction(entry.id);
  assert.equal(preflightHashes.get(`${entry.id}:lod0`), digest(after.glb), `Production LOD0 mutated during proof: ${entry.id}`);
  assert.equal(preflightHashes.get(`${entry.id}:receipt`), digest(after.receiptBytes), `Production receipt mutated during proof: ${entry.id}`);
  assert.equal(preflightHashes.get(`${entry.id}:package`), digest(after.packageBytes), `Production package mutated during proof: ${entry.id}`);
}
await mkdir(OUTPUT_DIR, { recursive: true });
await Promise.all([...built.map(({ id, lod1 }) => writeFile(path.join(OUTPUT_DIR, `${id}.lod1-4m.glb`), lod1.bytes)), writeFile(path.join(OUTPUT_DIR, 'sf-lod1-4m-proof-v1.receipt.json'), jsonBytes(proof))]);
console.log(JSON.stringify({ result: proof.status, proof: relative(path.join(OUTPUT_DIR, 'sf-lod1-4m-proof-v1.receipt.json')), maxVerticalDeviationMetres, contractEligible, projected598AtSampleAverage: proof.budgets.projected598AtSampleAverage }, null, 2));
