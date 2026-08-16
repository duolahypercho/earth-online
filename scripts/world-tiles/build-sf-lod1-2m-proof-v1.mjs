/**
 * Build an isolated, non-runtime 2 m terrain LOD1 proof for the same four
 * source-locked Ferry-area tiles exercised by the rejected 4 m proof.
 * This never writes a package, manifest, receipt, or production artifact.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-lod1-2m-proof-v1');
const METRIC_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const FERRY_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const CONTRACT_PATH = path.join(ROOT, 'public/data/world/contracts/sf-one-to-one-map.contract.json');
const STEP = 2;
const TILE_SIZE = 384;
const SAMPLE = Object.freeze([[1440, 10892], [1440, 10893], [1441, 10893], [1440, 10894]]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes) => `sha256:${sha256(bytes)}`;
const relative = (pathname) => path.relative(ROOT, pathname).split(path.sep).join('/');
const idFor = ([easting, northing]) => `epsg26910-${easting}-${northing}`;
const productionStem = (id) => id === 'epsg26910-1441-10893' ? 'ferry-production-tile-v1' : id;
const productionDir = (id) => id === 'epsg26910-1441-10893' ? FERRY_ROOT : path.join(METRIC_ROOT, id);

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch'); assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch'); assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length mismatch');
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()); const binOffset = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing'); return { gltf, bin: bytes.subarray(binOffset + 8) };
}

function categoryPayload(bytes, wanted) {
  const { gltf, bin } = parseGlb(bytes); const positions = []; const indices = []; let vertexOffset = 0; let found = false;
  for (const primitive of gltf.meshes[0].primitives) {
    const category = primitive.extras?.category; assert(category, 'GLB primitive category missing'); if (category !== wanted) continue;
    const position = gltf.accessors[primitive.attributes.POSITION]; const index = gltf.accessors[primitive.indices]; const positionView = gltf.bufferViews[position.bufferView]; const indexView = gltf.bufferViews[index.bufferView];
    assert.equal(position.componentType, 5126, `${category} positions must be float32`); assert.equal(index.componentType, 5123, `${category} indices must be uint16`);
    positions.push(bin.subarray(positionView.byteOffset ?? 0, (positionView.byteOffset ?? 0) + position.count * 12)); const normalized = Buffer.alloc(index.count * 4);
    for (let i = 0; i < index.count; i += 1) normalized.writeUInt32LE(bin.readUInt16LE((indexView.byteOffset ?? 0) + i * 2) + vertexOffset, i * 4);
    indices.push(normalized); vertexOffset += position.count; found = true;
  }
  return found ? Buffer.concat([...positions, ...indices]) : Buffer.alloc(0);
}

function sourceSurface(lod0Bytes) {
  const { gltf, bin } = parseGlb(lod0Bytes); const integer = new Map(); const vertices = new Map();
  for (const primitive of gltf.meshes[0].primitives) {
    if (!['terrain', 'water'].includes(primitive.extras?.category)) continue;
    const accessor = gltf.accessors[primitive.attributes.POSITION]; const view = gltf.bufferViews[accessor.bufferView]; const offset = view.byteOffset ?? 0;
    for (let i = 0; i < accessor.count; i += 1) {
      const at = offset + i * 12; const x = bin.readFloatLE(at); const y = bin.readFloatLE(at + 4); const z = bin.readFloatLE(at + 8); const key = `${x.toFixed(6)},${z.toFixed(6)}`;
      const previous = vertices.get(key); assert(previous === undefined || Math.abs(previous.y - y) <= 1e-6, `LOD0 terrain/water disagreement at ${key}`); vertices.set(key, { x, y, z });
      if (Math.abs(x - Math.round(x)) > 1e-5 || Math.abs(z - Math.round(z)) > 1e-5) continue;
      const integerKey = `${Math.round(x)},${Math.round(z)}`; const height = integer.get(integerKey); assert(height === undefined || Math.abs(height - y) <= 1e-6, `LOD0 source disagreement at ${integerKey}`); integer.set(integerKey, y);
    }
  }
  assert.equal(integer.size, (TILE_SIZE + 1) ** 2, 'LOD0 terrain/water omits 1 m source samples'); return { integer, vertices };
}

function triangleCells(geometry) {
  const cells = new Map();
  for (const name of ['terrain', 'water']) for (let i = 0; i < geometry[name].indices.length; i += 3) {
    const triangle = geometry[name].indices.slice(i, i + 3).map((vertex) => geometry[name].positions.slice(vertex * 3, vertex * 3 + 3));
    const minX = Math.min(...triangle.map(([x]) => x)); const maxX = Math.max(...triangle.map(([x]) => x)); const minZ = Math.min(...triangle.map(([, , z]) => z)); const maxZ = Math.max(...triangle.map(([, , z]) => z));
    for (let z = Math.max(0, Math.floor(minZ / STEP)); z <= Math.min(TILE_SIZE / STEP - 1, Math.floor(maxZ / STEP)); z += 1) for (let x = Math.max(0, Math.floor(minX / STEP)); x <= Math.min(TILE_SIZE / STEP - 1, Math.floor(maxX / STEP)); x += 1) { const key = `${x},${z}`; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(triangle); }
  }
  return cells;
}

function interpolatedHeight(cells, x, z) {
  const key = `${Math.min(TILE_SIZE / STEP - 1, Math.floor(x / STEP))},${Math.min(TILE_SIZE / STEP - 1, Math.floor(z / STEP))}`;
  for (const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] of cells.get(key) ?? []) {
    const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(denominator) < 1e-10) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator; const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator; const w = 1 - u - v;
    if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * ay + v * by + w * cy;
  }
  assert.fail(`No LOD1 terrain/water triangle covers ${x},${z}`);
}

function edgeSamples(geometry, side) {
  const points = new Map();
  for (const name of ['terrain', 'water']) for (let i = 0; i < geometry[name].positions.length; i += 3) {
    const [x, y, z] = geometry[name].positions.slice(i, i + 3); const coordinate = side === 'east' || side === 'west' ? z : x;
    const onEdge = side === 'east' ? x === TILE_SIZE : side === 'west' ? x === 0 : side === 'north' ? z === TILE_SIZE : z === 0;
    if (!onEdge || Math.abs(coordinate / STEP - Math.round(coordinate / STEP)) > 1e-6) continue;
    const previous = points.get(coordinate); assert(previous === undefined || Math.abs(previous - y) <= 1e-6, `LOD1 terrain/water edge disagreement ${side}:${coordinate}`); points.set(coordinate, y);
  }
  assert.equal(points.size, TILE_SIZE / STEP + 1, `LOD1 ${side} edge lacks phase-locked samples`); return points;
}

function validateSeam(a, aSide, b, bSide) {
  const left = edgeSamples(a.geometry, aSide); const right = edgeSamples(b.geometry, bSide); let maxVerticalDifferenceMetres = 0;
  for (const [coordinate, height] of left) { assert(right.has(coordinate), `LOD1 seam lacks ${coordinate}`); maxVerticalDifferenceMetres = Math.max(maxVerticalDifferenceMetres, Math.abs(height - right.get(coordinate))); }
  assert.equal(maxVerticalDifferenceMetres, 0, `LOD1 seam ${a.id}/${b.id} is not phase-locked`); return { tiles: [a.id, b.id], sides: [aSide, bSide], samples: left.size, maxVerticalDifferenceMetres };
}

async function readProduction(id) {
  const dir = productionDir(id); const stem = productionStem(id); const [glb, receiptBytes, packageBytes] = await Promise.all([readFile(path.join(dir, `${stem}.lod0.glb`)), readFile(path.join(dir, `${stem}.receipt.json`)), readFile(path.join(dir, `${stem}.package.json`))]);
  const receipt = JSON.parse(receiptBytes); const mapPackage = JSON.parse(packageBytes); assert.equal(receipt.tile.identity, id); assert.equal(receipt.lods[0].artifactHash, digest(glb), `LOD0 hash drifted for ${id}`); assert.equal(mapPackage.lods[0].artifactHash, digest(glb), `Package LOD0 hash drifted for ${id}`);
  const sourceLocks = []; for (const lock of mapPackage.sourceLocks) { const bytes = await readFile(path.join(ROOT, lock.path)); assert.equal(sha256(bytes), lock.sha256, `Source lock drifted for ${id}: ${lock.id}`); sourceLocks.push(lock); }
  return { id, dir, stem, glb, receiptBytes, packageBytes, sourceLocks };
}

const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8')); const budgets = contract.lod; assert.equal(budgets.maxHorizontalDeviationMetres, 0.5); assert.equal(budgets.maxVerticalDeviationMetres, 0.25);
const production = await Promise.all(SAMPLE.map((grid) => readProduction(idFor(grid))));
const preflight = new Map(production.flatMap(({ id, glb, receiptBytes, packageBytes }) => [[`${id}:lod0`, digest(glb)], [`${id}:receipt`, digest(receiptBytes)], [`${id}:package`, digest(packageBytes)]]));
const sharedInputs = await loadSfMetricSharedInputs(); const terrainDigests = await loadSfMetricVerifiedTerrainSourceDigests(); const built = [];
for (const [gridEasting, gridNorthing] of SAMPLE) {
  const id = idFor([gridEasting, gridNorthing]); const source = production.find((entry) => entry.id === id); const first = await buildSfMetricTile({ tile: { gridEasting, gridNorthing }, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, terrainGridStepMetres: STEP, lodLevel: 1 }); const second = await buildSfMetricTile({ tile: { gridEasting, gridNorthing }, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, terrainGridStepMetres: STEP, lodLevel: 1 });
  assert.equal(digest(first.glbs[0].bytes), digest(second.glbs[0].bytes), `LOD1 rebuild drifted for ${id}`); for (const category of ['coastline', 'roads', 'buildings']) assert.deepEqual(categoryPayload(first.glbs[0].bytes, category), categoryPayload(source.glb, category), `${id} ${category} changed under terrain-only proof`);
  const { integer, vertices } = sourceSurface(source.glb); const cells = triangleCells(first.categories); let maximum = 0;
  for (let z = 0; z <= TILE_SIZE; z += 1) for (let x = 0; x <= TILE_SIZE; x += 1) { const y = integer.get(`${x},${z}`); assert.notEqual(y, undefined, `${id} LOD0 integer sample absent ${x},${z}`); maximum = Math.max(maximum, Math.abs(interpolatedHeight(cells, x, z) - y)); }
  for (const { x, y, z } of vertices.values()) maximum = Math.max(maximum, Math.abs(interpolatedHeight(cells, x, z) - y));
  const lod = first.receipt.lods[0]; built.push({ id, geometry: first.categories, lod1: first.glbs[0], source, maximum, measuredSourceSurfaceVertices: vertices.size, triangles: Object.fromEntries(Object.entries(lod.meshStats).map(([name, stats]) => [name, stats.triangles])), bytes: first.glbs[0].bytes.length });
}
const seams = [validateSeam(built[0], 'north', built[1], 'south'), validateSeam(built[1], 'east', built[2], 'west'), validateSeam(built[1], 'north', built[3], 'south')];
const maxVerticalDeviationMetres = Math.max(...built.map(({ maximum }) => maximum)); const maxHorizontalDeviationMetres = 0;
// Sampling is a lower bound only. If it ever clears the budget, this builder fails closed rather than calling it eligible without an exact overlay check.
const sampledExceedsBudget = maxVerticalDeviationMetres > budgets.maxVerticalDeviationMetres;
assert(sampledExceedsBudget, '2m sampled result is within budget; continuous triangle-overlay intersection proof is required before eligibility can be claimed');
const totals = built.reduce((sum, entry) => ({ bytes: sum.bytes + entry.bytes, triangles: sum.triangles + Object.values(entry.triangles).reduce((part, count) => part + count, 0) }), { bytes: 0, triangles: 0 });
const proof = { schemaVersion: 1, kind: 'sf-lod1-2m-terrain-proof', id: 'sf-lod1-2m-proof-v1', status: 'proof-rejected-contract-error-budget', nonPromotion: 'preview/proof only; not a production package, runtime asset, manifest entry, or streaming input', terrainGridStepMetres: STEP, coordinateFrame: { horizontalCrs: 'EPSG:26910', runtimeFrame: 'provisional-utm-source-declared-navd88-unrealized', unitsPerMetre: 1, scale: [1, 1, 1], translationMetres: [0, 0, 0], verticalStatus: 'provisional-source-declared-navd88-unrealized' }, sample: { tiles: built.map(({ id }) => id), topology: 'connected Ferry three-tile L plus west/south neighbor; exactly the four-tile sample from sf-lod1-4m-proof-v1' }, sourceBinding: built.map(({ id, source }) => ({ id, lod0: { path: relative(path.join(source.dir, `${source.stem}.lod0.glb`)), sha256: digest(source.glb) }, receipt: { path: relative(path.join(source.dir, `${source.stem}.receipt.json`)), sha256: digest(source.receiptBytes) }, mapPackage: { path: relative(path.join(source.dir, `${source.stem}.package.json`)), sha256: digest(source.packageBytes) }, sourceLocks: source.sourceLocks })), validation: { method: 'all 385x385 integer LOD0 terrain/water source samples plus every unique fractional LOD0 terrain/water vertex (including coastline intersections) projected vertically to the 2m triangle surface; horizontal sample coordinates are unchanged', continuousSupremumQualification: 'maximum among measured LOD0 surface vertices; a lower bound sufficient to reject this proof, not a claimed continuous triangle-overlay supremum', integerSourceSamplesPerTile: 385 ** 2, maxHorizontalDeviationMetres, maxVerticalDeviationMetres, contractBudgets: { maxHorizontalDeviationMetres: budgets.maxHorizontalDeviationMetres, maxVerticalDeviationMetres: budgets.maxVerticalDeviationMetres }, contractEligible: false, sampledExceedsBudget: true, continuousTriangleOverlayCheck: 'not-run; sampled lower bound already exceeds the vertical contract budget and is sufficient to reject', seams, seamEvidenceQualification: 'phase-locked terrain/water edge-height equality at 2m samples; edge triangle topology, ordering, coastline geometry, and full bytes are not claimed identical', deterministicRebuild: true, nonTerrainGeometry: 'serialized position/index payloads for coastline, roads, and buildings match source LOD0 exactly; GLB JSON, materials, primitive extras, and chunk layout are not claimed identical' }, tiles: built.map(({ id, lod1, maximum, measuredSourceSurfaceVertices, triangles, bytes }) => ({ id, artifact: { path: relative(path.join(OUTPUT_DIR, `${id}.lod1-2m.glb`)), sha256: digest(lod1.bytes), bytes }, triangles, measuredSourceSurfaceVertices, maxHorizontalDeviationMetres: 0, maxVerticalDeviationMetres: maximum })), budgets: { measuredSample: totals, sampleAveragePerTile: { bytes: totals.bytes / built.length, triangles: totals.triangles / built.length }, projected598AtSampleAverage: { bytes: totals.bytes / built.length * 598, triangles: totals.triangles / built.length * 598 }, qualification: 'arithmetic projection from this four-tile proof sample only; not a citywide forecast or promotion claim' } };
for (const entry of production) { const after = await readProduction(entry.id); assert.equal(preflight.get(`${entry.id}:lod0`), digest(after.glb), `Production LOD0 mutated during proof: ${entry.id}`); assert.equal(preflight.get(`${entry.id}:receipt`), digest(after.receiptBytes), `Production receipt mutated during proof: ${entry.id}`); assert.equal(preflight.get(`${entry.id}:package`), digest(after.packageBytes), `Production package mutated during proof: ${entry.id}`); }
await mkdir(OUTPUT_DIR, { recursive: true }); await Promise.all([...built.map(({ id, lod1 }) => writeFile(path.join(OUTPUT_DIR, `${id}.lod1-2m.glb`), lod1.bytes)), writeFile(path.join(OUTPUT_DIR, 'sf-lod1-2m-proof-v1.receipt.json'), Buffer.from(`${JSON.stringify(proof, null, 2)}\n`))]);
console.log(JSON.stringify({ result: proof.status, proof: relative(path.join(OUTPUT_DIR, 'sf-lod1-2m-proof-v1.receipt.json')), maxVerticalDeviationMetres, contractEligible: false, projected598AtSampleAverage: proof.budgets.projected598AtSampleAverage }, null, 2));
