#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';
import { sourceToneV1ForOsmWayId } from './sf-building-source-tone-contract-v1.mjs';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-presentation-proof-v1');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const TILES = Object.freeze([
  { id: 'epsg26910-1441-10893', gridEasting: 1441, gridNorthing: 10893, role: 'ferry' },
  { id: 'epsg26910-1430-10882', gridEasting: 1430, gridNorthing: 10882, role: 'district' },
]);

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`); }
function float32Bytes(values) { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeFloatLE(value, index * 4)); return bytes; }
function uint16Bytes(values) { const bytes = Buffer.alloc(values.length * 2); values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2)); return bytes; }
function uint32Bytes(values) { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes; }
function uint8Bytes(values) { return Buffer.from(values); }

function minMax(values, stride) {
  const min = Array(stride).fill(Infinity); const max = Array(stride).fill(-Infinity);
  for (let index = 0; index < values.length; index += stride) for (let axis = 0; axis < stride; axis += 1) {
    min[axis] = Math.min(min[axis], values[index + axis]); max[axis] = Math.max(max[axis], values[index + axis]);
  }
  return { min, max };
}

function materialFamily(sourceTags) {
  const value = `${sourceTags['building:material'] ?? ''} ${sourceTags['facade:material'] ?? ''}`.toLowerCase();
  if (/glass|metal|steel|aluminium|aluminum/.test(value)) return 1;
  if (/wood|timber/.test(value)) return 2;
  if (/brick|stone|masonry|concrete|stucco|plaster/.test(value)) return 0;
  return 3;
}

function sourceLevels(sourceTags) {
  const value = Number.parseFloat(sourceTags['building:levels']);
  return Number.isFinite(value) && value > 0 && value <= 200 ? value : 0;
}

function triangleIndexLedger(indices) {
  const triangles = [];
  for (let index = 0; index < indices.length; index += 3) triangles.push(`${indices[index]},${indices[index + 1]},${indices[index + 2]}`);
  triangles.sort(); return `sha256:${sha256(Buffer.from(triangles.join('\n')))}`;
}

export function makePresentationGlb(tile, categories, proof, { sourceToneContract = null } = {}) {
  const buildings = categories.buildings;
  const vertexCount = buildings.positions.length / 3;
  assert(vertexCount > 0 && buildings.indices.length > 0, `${tile.id} has no building geometry`);
  const local = new Array(buildings.positions.length).fill(0);
  const buildingOrdinal = new Array(vertexCount).fill(0);
  const tone = new Array(vertexCount).fill(0);
  const sourceTone = sourceToneContract ? new Array(vertexCount).fill(0) : null;
  const family = new Array(vertexCount).fill(0);
  const levels = new Array(vertexCount).fill(0);
  const records = proof.records.map((record, ordinal) => {
    assert.equal(record.vertexCount % 2, 0, `${tile.id} way/${record.sourceOsmWayId} vertex pairing is invalid`);
    const ringLength = record.vertexCount / 2;
    let centreX = 0; let centreZ = 0;
    for (let index = 0; index < ringLength; index += 1) {
      centreX += buildings.positions[(record.vertexStart + index * 2) * 3];
      centreZ += buildings.positions[(record.vertexStart + index * 2) * 3 + 2];
    }
    centreX /= ringLength; centreZ /= ringLength;
    const familyKey = materialFamily(record.sourceTags); const levelCount = sourceLevels(record.sourceTags);
    const toneKey = familyKey * 2 + Number(BigInt(record.sourceOsmWayId) % 2n);
    const sourceToneKey = sourceTone ? sourceToneV1ForOsmWayId(record.sourceOsmWayId) : null;
    for (let index = 0; index < record.vertexCount; index += 1) {
      const vertexIndex = record.vertexStart + index;
      local[vertexIndex * 3] = buildings.positions[vertexIndex * 3] - centreX;
      local[vertexIndex * 3 + 1] = index % 2 === 0 ? 0 : record.heightMetres;
      local[vertexIndex * 3 + 2] = buildings.positions[vertexIndex * 3 + 2] - centreZ;
      buildingOrdinal[vertexIndex] = ordinal;
      tone[vertexIndex] = toneKey;
      if (sourceTone) sourceTone[vertexIndex] = sourceToneKey;
      family[vertexIndex] = familyKey;
      levels[vertexIndex] = levelCount;
    }
    const facadeEdgeLengths = record.wallSegments.map(({ edgeLengthMetres }) => edgeLengthMetres);
    const presentationRecord = {
      ordinal,
      sourceFeatureId: `way/${record.sourceOsmWayId}`,
      sourceTags: record.sourceTags,
      materialFamily: familyKey,
      sourceBuildingLevels: levelCount || null,
      deterministicToneKey: toneKey,
      heightMetres: record.heightMetres,
      vertexStart: record.vertexStart,
      vertexCount: record.vertexCount,
      indexStart: record.indexStart,
      indexCount: record.indexCount,
      roofIndexCount: record.roofIndexCount,
      wallIndexCount: record.indexCount - record.roofIndexCount,
      facadeEdges: { count: facadeEdgeLengths.length, minLengthMetres: Math.min(...facadeEdgeLengths), maxLengthMetres: Math.max(...facadeEdgeLengths), ledgerSha256: `sha256:${sha256(float32Bytes(facadeEdgeLengths))}` },
    };
    if (sourceTone) presentationRecord.sourceToneV1 = sourceToneKey;
    return presentationRecord;
  });
  assert.equal(records.reduce((sum, record) => sum + record.vertexCount, 0), vertexCount, `${tile.id} building vertex ownership is incomplete`);
  assert.equal(records.reduce((sum, record) => sum + record.indexCount, 0), buildings.indices.length, `${tile.id} building triangle ownership is incomplete`);

  const useUint32 = vertexCount > 65_535;
  const chunks = []; const bufferViews = []; const accessors = []; let offset = 0;
  const addView = (bytes, target) => {
    const padding = (4 - offset % 4) % 4; if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding; }
    const index = bufferViews.length; bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target }); chunks.push(bytes); offset += bytes.length; return index;
  };
  const positionView = addView(float32Bytes(buildings.positions), 34962);
  const localView = addView(float32Bytes(local), 34962);
  const buildingView = addView(uint16Bytes(buildingOrdinal), 34962);
  const toneView = addView(uint8Bytes(tone), 34962);
  const sourceToneView = sourceTone ? addView(uint8Bytes(sourceTone), 34962) : null;
  const familyView = addView(uint8Bytes(family), 34962);
  const levelsView = addView(float32Bytes(levels), 34962);
  const groups = new Map();
  for (const record of records) for (const surface of ['roof', 'wall']) {
    const count = surface === 'roof' ? record.roofIndexCount : record.wallIndexCount; if (!count) continue;
    const firstIndex = record.indexStart + (surface === 'roof' ? 0 : record.roofIndexCount); const key = `${record.materialFamily}:${surface}`;
    if (!groups.has(key)) groups.set(key, { materialFamily: record.materialFamily, surfaceKind: surface, indices: [], buildingOrdinals: new Set() });
    groups.get(key).indices.push(...buildings.indices.slice(firstIndex, firstIndex + count)); groups.get(key).buildingOrdinals.add(record.ordinal);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => a.materialFamily - b.materialFamily || a.surfaceKind.localeCompare(b.surfaceKind));
  assert(orderedGroups.length <= 8, `${tile.id} presentation batch budget exceeded`);
  const presentationIndices = orderedGroups.flatMap((group) => group.indices);
  assert.equal(triangleIndexLedger(presentationIndices), triangleIndexLedger(buildings.indices), `${tile.id} batching changed the exact source triangle multiset`);
  const indexBytes = useUint32 ? uint32Bytes(presentationIndices) : uint16Bytes(presentationIndices);
  const indexView = addView(indexBytes, 34963);
  const positionBounds = minMax(buildings.positions, 3); const localBounds = minMax(local, 3);
  const positionAccessor = accessors.length; accessors.push({ bufferView: positionView, componentType: 5126, count: vertexCount, type: 'VEC3', ...positionBounds });
  const localAccessor = accessors.length; accessors.push({ bufferView: localView, componentType: 5126, count: vertexCount, type: 'VEC3', ...localBounds });
  const buildingAccessor = accessors.length; accessors.push({ bufferView: buildingView, componentType: 5123, count: vertexCount, type: 'SCALAR', min: [0], max: [records.length - 1] });
  const toneAccessor = accessors.length; accessors.push({ bufferView: toneView, componentType: 5121, count: vertexCount, type: 'SCALAR', min: [0], max: [7] });
  const sourceToneAccessor = sourceTone ? accessors.length : null;
  if (sourceTone) accessors.push({ bufferView: sourceToneView, componentType: 5121, normalized: false, count: vertexCount, type: 'SCALAR', min: [Math.min(...sourceTone)], max: [Math.max(...sourceTone)] });
  const familyAccessor = accessors.length; accessors.push({ bufferView: familyView, componentType: 5121, count: vertexCount, type: 'SCALAR', min: [0], max: [3] });
  const levelsAccessor = accessors.length; accessors.push({ bufferView: levelsView, componentType: 5126, count: vertexCount, type: 'SCALAR', ...minMax(levels, 1) });
  const primitives = [];
  let firstIndex = 0;
  for (const group of orderedGroups) {
    const count = group.indices.length;
    const indexAccessor = accessors.length;
    accessors.push({ bufferView: indexView, byteOffset: firstIndex * (useUint32 ? 4 : 2), componentType: useUint32 ? 5125 : 5123, count, type: 'SCALAR', min: [Math.min(...group.indices)], max: [Math.max(...group.indices)] });
    const attributes = { POSITION: positionAccessor, _SF_LOCAL_METRES: localAccessor, _SF_BUILDING_ORDINAL: buildingAccessor, _SF_TONE_KEY: toneAccessor, _SF_MATERIAL_FAMILY: familyAccessor, _SF_LEVELS: levelsAccessor };
    if (sourceTone) attributes._SF_SOURCE_TONE_V1 = sourceToneAccessor;
    primitives.push({ attributes, indices: indexAccessor, material: group.materialFamily * 2 + (group.surfaceKind === 'wall' ? 1 : 0), mode: 4, extras: { materialFamily: group.materialFamily, surfaceKind: group.surfaceKind, sourceBuildingCount: group.buildingOrdinals.size, presentationOnly: true } });
    firstIndex += count;
  }
  const padding = (4 - offset % 4) % 4; if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding; }
  const bin = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'build-sf-building-presentation-proof-v1' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: `${tile.id}-building-presentation-proof` }],
    meshes: [{ name: `${tile.id}-building-presentation-proof`, primitives }],
    materials: ['masonry', 'glass-metal', 'wood', 'unspecified'].flatMap((name) => [
      { name: `building-${name}-roof-proof`, pbrMetallicRoughness: { baseColorFactor: [0.56, 0.49, 0.42, 1], metallicFactor: 0, roughnessFactor: 0.94 } },
      { name: `building-${name}-wall-proof`, pbrMetallicRoughness: { baseColorFactor: [0.46, 0.36, 0.3, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
    ]),
    buffers: [{ byteLength: bin.length }], bufferViews, accessors,
    extras: { tileId: tile.id, horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, verticalCertification: 'source-declared-navd88-unrealized', status: 'preview-proof-only-not-production', sourceWindowInventoryClaim: false, ...(sourceToneContract ? { presentation: sourceToneContract } : {}) },
  };
  let json = Buffer.from(JSON.stringify(gltf)); const jsonPadding = (4 - json.length % 4) % 4; if (jsonPadding) json = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const output = Buffer.alloc(12 + 8 + json.length + 8 + bin.length); output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8); output.writeUInt32LE(json.length, 12); output.writeUInt32LE(0x4e4f534a, 16); json.copy(output, 20); const binAt = 20 + json.length; output.writeUInt32LE(bin.length, binAt); output.writeUInt32LE(0x004e4942, binAt + 4); bin.copy(output, binAt + 8);
  return { bytes: output, records, sourcePositionBytes: float32Bytes(buildings.positions), sourceIndexBytes: useUint32 ? uint32Bytes(buildings.indices) : uint16Bytes(buildings.indices), sourceToneBytes: sourceTone ? uint8Bytes(sourceTone) : null, sourceTriangleLedgerSha256: triangleIndexLedger(buildings.indices), presentationTriangleLedgerSha256: triangleIndexLedger(presentationIndices), vertexCount, indexCount: buildings.indices.length, primitiveCount: primitives.length, indexComponentType: useUint32 ? 5125 : 5123 };
}

async function buildTile(tile, manifestTile, sharedInputs, verifiedTerrainSourceDigests) {
  const options = { tile, write: false, sharedInputs, verifiedTerrainSourceDigests, buildingPresentationProof: true };
  const first = await buildSfMetricTile(options); const second = await buildSfMetricTile(options);
  const firstProof = makePresentationGlb(tile, first.categories, first.buildingPresentationProof);
  const secondProof = makePresentationGlb(tile, second.categories, second.buildingPresentationProof);
  assert(firstProof.bytes.equals(secondProof.bytes), `${tile.id} proof GLB is not byte deterministic`);
  assert(firstProof.sourcePositionBytes.equals(secondProof.sourcePositionBytes), `${tile.id} source positions drifted between builds`);
  assert(firstProof.sourceIndexBytes.equals(secondProof.sourceIndexBytes), `${tile.id} source indices drifted between builds`);
  const productionGlbPath = path.join(ROOT, manifestTile.lod0.path);
  const productionGlb = await readFile(productionGlbPath);
  assert(first.glbs[0].bytes.equals(productionGlb), `${tile.id} default production GLB bytes changed while proof metadata was enabled`);
  const tileOutput = path.join(OUTPUT_ROOT, tile.id); await mkdir(tileOutput, { recursive: true });
  const proofName = `${tile.id}.building-presentation-proof.glb`; await writeFile(path.join(tileOutput, proofName), firstProof.bytes);
  const receipt = {
    schemaVersion: 1,
    kind: 'sf-building-presentation-proof-receipt',
    status: 'preview-proof-only-not-production',
    tile: { id: tile.id, gridIndex: [tile.gridEasting, tile.gridNorthing], horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, verticalCertification: 'source-declared-navd88-unrealized' },
    productionReference: { path: manifestTile.lod0.path, declaredSha256: manifestTile.lod0.sha256, verifiedSha256: `sha256:${sha256(productionGlb)}`, exactDefaultBytesPreserved: true },
    proofArtifact: { path: path.relative(ROOT, path.join(tileOutput, proofName)), bytes: firstProof.bytes.length, sha256: `sha256:${sha256(firstProof.bytes)}` },
    invariants: { twoBuildProofBytesExact: true, sourcePositionFloat32BytesExact: true, sourceCategoryIndexLedgerBound: true, productionTrianglePositionMultisetExact: true, presentationPrimitiveCountAtMostEight: true, sourceGeometryMoved: false, buildingOwnershipComplete: true, interleavedBottomTopPairingVerified: true },
    claims: { facadeCoordinates: 'building-local metric coordinates derived from exact source-bound extrusion vertices', roofWallClassification: 'batched primitive partition follows the existing roof/wall triangle ranges', deterministicToneKey: 'source material family plus OSM way parity; presentation-only', storyBands: 'only enabled where byte-locked OSM building:levels exists; not a sourced window inventory', sourcedWindowInventory: false, sourceBuildingFootprintChanged: false, gameplayOrCollisionChanged: false },
    counts: { buildings: firstProof.records.length, vertices: firstProof.vertexCount, indices: firstProof.indexCount, triangles: firstProof.indexCount / 3, primitives: firstProof.primitiveCount },
    ledgers: { positionFloat32Sha256: `sha256:${sha256(firstProof.sourcePositionBytes)}`, sourceIndexSha256: `sha256:${sha256(firstProof.sourceIndexBytes)}`, sourceTriangleMultisetSha256: firstProof.sourceTriangleLedgerSha256, presentationTriangleMultisetSha256: firstProof.presentationTriangleLedgerSha256, buildingRecordsSha256: `sha256:${sha256(jsonBytes(firstProof.records))}` },
    buildingRecords: firstProof.records,
    sourceLocks: first.packageDescriptor.sourceLocks,
  };
  const receiptPath = path.join(tileOutput, `${tile.id}.building-presentation-proof.receipt.json`); await writeFile(receiptPath, jsonBytes(receipt));
  return { tile: tile.id, role: tile.role, artifact: receipt.proofArtifact, receipt: path.relative(ROOT, receiptPath), counts: receipt.counts, ledgers: receipt.ledgers };
}

export async function buildSfBuildingPresentationProofV1() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')); const byId = new Map(manifest.tiles.map((tile) => [tile.id, tile]));
  const [sharedInputs, verifiedTerrainSourceDigests] = await Promise.all([loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests()]);
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const tiles = [];
  for (const tile of TILES) { const manifestTile = byId.get(tile.id); assert(manifestTile, `${tile.id} is not a production resident`); tiles.push(await buildTile(tile, manifestTile, sharedInputs, verifiedTerrainSourceDigests)); }
  const proofManifest = { schemaVersion: 1, kind: 'sf-building-presentation-proof-manifest', status: 'preview-proof-only-not-production', productionManifestTileCount: manifest.tiles.length, tiles };
  await writeFile(path.join(OUTPUT_ROOT, 'sf-building-presentation-proof-v1.manifest.json'), jsonBytes(proofManifest));
  process.stdout.write(`${JSON.stringify(proofManifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildSfBuildingPresentationProofV1();
