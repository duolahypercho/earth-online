#!/usr/bin/env node
/**
 * Build a preview-only source-derived per-building relative-height attribute.
 *
 * This script intentionally never writes a production artifact.  It rebuilds
 * the byte-locked tile with the existing geometry path, derives one 0..1
 * value from each emitted source building's bottom/top pair, and appends only
 * that attribute to a copy of the current production GLB.  Ferry retains the
 * authorized _SF_SOURCE_TONE_V1 payload; District retains its legacy payload.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-relative-height-proof-v1');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const TILES = Object.freeze([
  { id: 'epsg26910-1441-10893', gridEasting: 1441, gridNorthing: 10893, role: 'ferry', retainsSourceTone: true },
  { id: 'epsg26910-1430-10882', gridEasting: 1430, gridNorthing: 10882, role: 'district', retainsSourceTone: false },
]);
const HEIGHT_ATTRIBUTE = Object.freeze({
  gltfSemantic: '_SF_BUILDING_RELATIVE_HEIGHT_V1',
  threeAttributeName: '_sf_building_relative_height_v1',
  componentType: 5126,
  type: 'SCALAR',
  normalized: false,
  domain: [0, 1],
  encoding: 'float32-le',
  derivation: 'per-source-building emitted bottom/top pair: (vertexY-bottomY)/(topY-bottomY); bottom=0, top=1',
});
const HEIGHT_CONTRACT = Object.freeze({ schema: 'sf-building-relative-height-v1', attribute: HEIGHT_ATTRIBUTE, status: 'preview-proof-only-not-production' });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
const float32Bytes = (values) => { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeFloatLE(value, index * 4)); return bytes; };
const uint16Bytes = (values) => { const bytes = Buffer.alloc(values.length * 2); values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2)); return bytes; };
const uint32Bytes = (values) => { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes; };

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB byte length mismatch');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const jsonStart = 20; const jsonEnd = jsonStart + jsonLength;
  const json = JSON.parse(bytes.subarray(jsonStart, jsonEnd).toString('utf8').trim());
  const binHeader = jsonEnd;
  assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942, 'GLB BIN chunk missing');
  const binLength = bytes.readUInt32LE(binHeader);
  assert.equal(binHeader + 8 + binLength, bytes.length, 'GLB BIN length does not consume the artifact');
  return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength) };
}

const COMPONENTS = Object.freeze({ 5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset) }, 5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset) }, 5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset) }, 5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset) } });
const WIDTHS = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

function accessorValues(glb, accessorIndex) {
  assert(Number.isInteger(accessorIndex), 'Accessor index is missing');
  const accessor = glb.json.accessors[accessorIndex]; const view = glb.json.bufferViews[accessor.bufferView]; const component = COMPONENTS[accessor.componentType]; const width = WIDTHS[accessor.type];
  assert(accessor && view && component && width, 'Malformed accessor contract');
  const stride = view.byteStride ?? component.bytes * width; const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  assert(start >= 0 && start + (accessor.count - 1) * stride + component.bytes * width <= glb.bin.length, 'Accessor exceeds GLB BIN');
  const values = [];
  for (let item = 0; item < accessor.count; item += 1) for (let axis = 0; axis < width; axis += 1) values.push(component.read(glb.bin, start + item * stride + axis * component.bytes));
  return values;
}

function accessorRawBytes(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex]; const view = glb.json.bufferViews[accessor.bufferView]; const component = COMPONENTS[accessor.componentType]; const width = WIDTHS[accessor.type];
  assert(accessor && view && component && width && !view.byteStride, 'Proof requires tightly packed accessors');
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const length = accessor.count * component.bytes * width;
  assert(start >= 0 && start + length <= glb.bin.length, 'Raw accessor exceeds GLB BIN');
  return glb.bin.subarray(start, start + length);
}

function partitionWithSourceIndices(data, maxVertices = 65_535) {
  const chunks = []; let positions = []; let indices = []; let sourceIndices = []; let remap = new Map();
  const flush = () => { if (indices.length) chunks.push({ positions, indices, sourceIndices }); positions = []; indices = []; sourceIndices = []; remap = new Map(); };
  for (let index = 0; index < data.indices.length; index += 3) {
    const triangle = data.indices.slice(index, index + 3); const additional = triangle.filter((sourceIndex) => !remap.has(sourceIndex)).length;
    if (remap.size + additional > maxVertices) flush();
    for (const sourceIndex of triangle) {
      if (!remap.has(sourceIndex)) { remap.set(sourceIndex, remap.size); sourceIndices.push(sourceIndex); positions.push(...data.positions.slice(sourceIndex * 3, sourceIndex * 3 + 3)); }
      indices.push(remap.get(sourceIndex));
    }
  }
  flush();
  return chunks;
}

function deriveRelativeHeightValues(categories, proof) {
  const buildings = categories.buildings; const vertexCount = buildings.positions.length / 3;
  assert(vertexCount > 0 && buildings.indices.length > 0, 'Tile has no building geometry');
  const values = new Array(vertexCount).fill(Number.NaN); const owners = new Array(vertexCount).fill(-1);
  const records = proof.records.map((record, ordinal) => {
    assert(Number.isInteger(record.vertexStart) && Number.isInteger(record.vertexCount) && record.vertexCount > 0, 'Building record vertex range is malformed');
    assert.equal(record.vertexCount % 2, 0, `way/${record.sourceOsmWayId} bottom/top pairing is malformed`);
    assert(record.vertexStart >= 0 && record.vertexStart + record.vertexCount <= vertexCount, `way/${record.sourceOsmWayId} vertex range exceeds geometry`);
    assert(Number.isInteger(record.indexStart) && Number.isInteger(record.indexCount) && record.indexCount > 0 && record.indexCount % 3 === 0, `way/${record.sourceOsmWayId} index range is malformed`);
    const relative = [];
    for (let pair = 0; pair < record.vertexCount / 2; pair += 1) {
      const bottomIndex = record.vertexStart + pair * 2; const topIndex = bottomIndex + 1;
      const bottomY = buildings.positions[bottomIndex * 3 + 1]; const topY = buildings.positions[topIndex * 3 + 1]; const height = topY - bottomY;
      assert(Number.isFinite(bottomY) && Number.isFinite(topY) && Number.isFinite(height) && height > 0, `way/${record.sourceOsmWayId} has zero/invalid emitted height`);
      for (const [vertexIndex, vertexY] of [[bottomIndex, bottomY], [topIndex, topY]]) {
        assert.equal(owners[vertexIndex], -1, `way/${record.sourceOsmWayId} overlaps another source-building record at vertex ${vertexIndex}`);
        const value = (vertexY - bottomY) / height;
        assert(Number.isFinite(value) && value >= 0 && value <= 1, `way/${record.sourceOsmWayId} emitted relative height is outside 0..1`);
        owners[vertexIndex] = ordinal; values[vertexIndex] = value; relative.push(value);
      }
    }
    return { ordinal, sourceFeatureId: `way/${record.sourceOsmWayId}`, sourceTags: record.sourceTags, vertexStart: record.vertexStart, vertexCount: record.vertexCount, indexStart: record.indexStart, indexCount: record.indexCount, heightMetres: record.heightMetres, relativeValuesSha256: `sha256:${sha256(float32Bytes(relative))}` };
  });
  assert(values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1), 'Building relative-height ownership is incomplete');
  assert.equal(owners.filter((owner) => owner >= 0).length, vertexCount, 'Building relative-height ownership coverage is incomplete');
  return { values, records };
}

function geometryPrimitiveLedger(glb) {
  return glb.json.meshes[0].primitives.map((primitive) => ({
    category: primitive.extras?.category ?? null,
    chunkIndex: primitive.extras?.chunkIndex ?? null,
    material: primitive.material,
    mode: primitive.mode,
    extras: primitive.extras,
    positionSha256: `sha256:${sha256(accessorRawBytes(glb, primitive.attributes.POSITION))}`,
    indexSha256: `sha256:${sha256(accessorRawBytes(glb, primitive.indices))}`,
    triangleCount: glb.json.accessors[primitive.indices].count / 3,
  }));
}

function appendRelativeHeightAttribute(productionBytes, categories, relativeValues) {
  const sourceGlb = parseGlb(productionBytes); const json = JSON.parse(JSON.stringify(sourceGlb.json)); const primitiveList = json.meshes?.[0]?.primitives;
  assert(Array.isArray(primitiveList) && primitiveList.length > 0, 'Production GLB has no mesh primitives');
  const partitions = partitionWithSourceIndices(categories.buildings); const buildingPrimitives = primitiveList.filter((primitive) => primitive.extras?.category === 'buildings');
  assert.equal(buildingPrimitives.length, partitions.length, 'Building primitive/chunk count drifted from production partitioning');
  const attributeBytes = []; let partitionIndex = 0; let offset = sourceGlb.bin.length;
  const pad = () => { const count = (4 - offset % 4) % 4; if (count) { attributeBytes.push(Buffer.alloc(count)); offset += count; } };
  for (const primitive of primitiveList) {
    if (primitive.extras?.category !== 'buildings') continue;
    const partition = partitions[partitionIndex]; const positionBytes = float32Bytes(partition.positions); const indexBytes = partition.indices.length && Math.max(...partition.indices) > 65_535 ? uint32Bytes(partition.indices) : uint16Bytes(partition.indices);
    assert(accessorRawBytes(sourceGlb, primitive.attributes.POSITION).equals(positionBytes), `Production POSITION bytes drifted for building chunk ${partitionIndex}`);
    assert(accessorRawBytes(sourceGlb, primitive.indices).equals(indexBytes), `Production index bytes drifted for building chunk ${partitionIndex}`);
    assert.equal(sourceGlb.json.accessors[primitive.attributes.POSITION].count, partition.sourceIndices.length, 'Production POSITION count drifted');
    const serializedValues = partition.sourceIndices.map((sourceIndex) => relativeValues[sourceIndex]);
    assert(serializedValues.every((value) => Number.isFinite(value) && value >= 0 && value <= 1), 'Serialized relative-height value is malformed');
    const bytes = float32Bytes(serializedValues); pad(); const viewIndex = json.bufferViews.length; json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 }); attributeBytes.push(bytes); offset += bytes.length;
    const accessorIndex = json.accessors.length; json.accessors.push({ bufferView: viewIndex, componentType: HEIGHT_ATTRIBUTE.componentType, normalized: HEIGHT_ATTRIBUTE.normalized, count: serializedValues.length, type: HEIGHT_ATTRIBUTE.type, min: [0], max: [1] });
    primitive.attributes[HEIGHT_ATTRIBUTE.gltfSemantic] = accessorIndex;
    partitionIndex += 1;
  }
  assert.equal(partitionIndex, partitions.length, 'Not every building partition received relative-height values');
  json.buffers[0].byteLength = offset;
  json.extras = { ...(json.extras ?? {}), buildingRelativeHeight: HEIGHT_CONTRACT };
  const bin = Buffer.concat([sourceGlb.bin, ...attributeBytes]); const jsonChunk = Buffer.from(JSON.stringify(json)); const jsonPad = (4 - jsonChunk.length % 4) % 4; const paddedJson = jsonPad ? Buffer.concat([jsonChunk, Buffer.alloc(jsonPad, 0x20)]) : jsonChunk;
  const output = Buffer.alloc(12 + 8 + paddedJson.length + 8 + bin.length); output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8); output.writeUInt32LE(paddedJson.length, 12); output.writeUInt32LE(0x4e4f534a, 16); paddedJson.copy(output, 20); const binAt = 20 + paddedJson.length; output.writeUInt32LE(bin.length, binAt); output.writeUInt32LE(0x004e4942, binAt + 4); bin.copy(output, binAt + 8);
  return { bytes: output, sourceGlb, candidateGlb: parseGlb(output), serializedAttributeBytes: Buffer.concat(primitiveList.filter((primitive) => primitive.extras?.category === 'buildings').map((primitive) => accessorRawBytes(parseGlb(output), primitive.attributes[HEIGHT_ATTRIBUTE.gltfSemantic]))) };
}

async function buildTile(tile, manifestTile, productionManifestBytes, sharedInputs, verifiedTerrainSourceDigests) {
  const options = { tile, write: false, sharedInputs, verifiedTerrainSourceDigests, buildingRelativeHeightProof: true, ...(tile.retainsSourceTone ? { buildingSourceToneProof: true } : {}) };
  const first = await buildSfMetricTile(options); const second = await buildSfMetricTile(options);
  assert(first.glbs[0].bytes.equals(second.glbs[0].bytes), `${tile.id} two proof baseline builds are not byte-identical`);
  const productionBytes = await readFile(path.join(ROOT, manifestTile.lod0.path)); const productionReceiptBytes = await readFile(path.join(ROOT, manifestTile.receipt.path));
  assert(first.glbs[0].bytes.equals(productionBytes), `${tile.id} default production bytes changed while relative-height proof was enabled`);
  const relative = deriveRelativeHeightValues(first.categories, first.buildingRelativeHeightProof);
  const augmented = appendRelativeHeightAttribute(productionBytes, first.categories, relative.values);
  const relativeSecond = deriveRelativeHeightValues(second.categories, second.buildingRelativeHeightProof);
  const augmentedSecond = appendRelativeHeightAttribute(second.glbs[0].bytes, second.categories, relativeSecond.values);
  assert(augmented.bytes.equals(augmentedSecond.bytes), `${tile.id} two relative-height proof artifacts are not byte-identical`);
  const productionGlb = augmented.sourceGlb; const candidateGlb = augmented.candidateGlb;
  const tileOutput = path.join(OUTPUT_ROOT, tile.id); await mkdir(tileOutput, { recursive: true }); const proofName = `${tile.id}.building-relative-height-proof.glb`; const proofPath = path.join(tileOutput, proofName); await writeFile(proofPath, augmented.bytes);
  const productionManifestSha256 = `sha256:${sha256(productionManifestBytes)}`; const productionReceiptSha256 = `sha256:${sha256(productionReceiptBytes)}`;
  const receipt = {
    schemaVersion: 1,
    kind: 'sf-building-relative-height-proof-receipt',
    status: 'preview-proof-only-not-production',
    productionWriteEnabled: false,
    productionPromotionAuthorized: false,
    tile: { id: tile.id, role: tile.role, gridIndex: [tile.gridEasting, tile.gridNorthing], horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, verticalCertification: 'source-declared-navd88-unrealized' },
    attributeContractSha256: `sha256:${sha256(jsonBytes(HEIGHT_CONTRACT))}`,
    attributeContract: HEIGHT_CONTRACT,
    productionReference: { path: manifestTile.lod0.path, declaredSha256: manifestTile.lod0.sha256, verifiedSha256: `sha256:${sha256(productionBytes)}`, receiptPath: manifestTile.receipt.path, receiptSha256: productionReceiptSha256, manifestPath: path.relative(ROOT, MANIFEST_PATH), manifestSha256: productionManifestSha256, exactDefaultBytesPreserved: true },
    proofArtifact: { path: path.relative(ROOT, proofPath), bytes: augmented.bytes.length, sha256: `sha256:${sha256(augmented.bytes)}` },
    invariants: {
      twoProofBaselineBuildsByteExact: true,
      twoProofArtifactsByteExact: true,
      sourceRelativeHeightValuesByteExact: true,
      sourcePositionFloat32BytesExact: true,
      sourceIndexBytesExact: true,
      exactPositionLedgerPreserved: true,
      exactIndexLedgerPreserved: true,
      exactPrimitiveLedgerPreserved: true,
      exactTriangleLedgerPreserved: true,
      sourceTonePayloadPreserved: tile.retainsSourceTone,
      sourceBuildingCoverageComplete: true,
      sourceBuildingOwnershipNonOverlapping: true,
      emittedHeightsFinitePositive: true,
      sourceGeometryMoved: false,
      gameplayOrCollisionChanged: false,
    },
    counts: { buildings: relative.records.length, sourceVertices: first.categories.buildings.positions.length / 3, serializedVertices: candidateGlb.json.accessors[candidateGlb.json.meshes[0].primitives.find((primitive) => primitive.extras?.category === 'buildings').attributes.POSITION].count, indices: first.categories.buildings.indices.length, triangles: first.categories.buildings.indices.length / 3, primitives: candidateGlb.json.meshes[0].primitives.length, buildingPrimitives: candidateGlb.json.meshes[0].primitives.filter((primitive) => primitive.extras?.category === 'buildings').length },
    ledgers: { sourcePositionFloat32Sha256: `sha256:${sha256(float32Bytes(first.categories.buildings.positions))}`, sourceIndexSha256: `sha256:${sha256(first.categories.buildings.indices.length && Math.max(...first.categories.buildings.indices) > 65_535 ? uint32Bytes(first.categories.buildings.indices) : uint16Bytes(first.categories.buildings.indices))}`, sourceRelativeHeightAttributeSha256: `sha256:${sha256(float32Bytes(relative.values))}`, serializedRelativeHeightAttributeSha256: `sha256:${sha256(augmented.serializedAttributeBytes)}`, geometryPrimitiveLedgerSha256: `sha256:${sha256(jsonBytes(geometryPrimitiveLedger(productionGlb)))}`, geometryTriangleIndexSha256: `sha256:${sha256(Buffer.from(productionGlb.json.meshes[0].primitives.filter((primitive) => primitive.extras?.category === 'buildings').flatMap((primitive) => accessorValues(productionGlb, primitive.indices)).join(',')))}` },
    buildingRecords: relative.records,
    sourceLocks: first.packageDescriptor.sourceLocks,
  };
  const receiptPath = path.join(tileOutput, `${tile.id}.building-relative-height-proof.receipt.json`); await writeFile(receiptPath, jsonBytes(receipt));
  return { tile: tile.id, role: tile.role, proofArtifact: receipt.proofArtifact, receipt: path.relative(ROOT, receiptPath), counts: receipt.counts, ledgers: receipt.ledgers };
}

export async function buildSfBuildingRelativeHeightProofV1() {
  const productionManifestBytes = await readFile(MANIFEST_PATH); const productionManifest = JSON.parse(productionManifestBytes); const productionById = new Map(productionManifest.tiles.map((tile) => [tile.id, tile]));
  const [sharedInputs, verifiedTerrainSourceDigests] = await Promise.all([loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests()]);
  await mkdir(OUTPUT_ROOT, { recursive: true }); const tiles = [];
  for (const tile of TILES) { const manifestTile = productionById.get(tile.id); assert(manifestTile, `${tile.id} is no longer a production resident`); tiles.push(await buildTile(tile, manifestTile, productionManifestBytes, sharedInputs, verifiedTerrainSourceDigests)); }
  const proofManifest = { schemaVersion: 1, kind: 'sf-building-relative-height-proof-manifest', status: 'preview-proof-only-not-production', productionWriteEnabled: false, productionPromotionAuthorized: false, productionManifestTileCount: productionManifest.tiles.length, productionManifestSha256: `sha256:${sha256(productionManifestBytes)}`, attributeContractSha256: `sha256:${sha256(jsonBytes(HEIGHT_CONTRACT))}`, attributeContract: HEIGHT_CONTRACT, tiles };
  await writeFile(path.join(OUTPUT_ROOT, 'sf-building-relative-height-proof-v1.manifest.json'), jsonBytes(proofManifest));
  process.stdout.write(`${JSON.stringify(proofManifest, null, 2)}\n`);
  return proofManifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildSfBuildingRelativeHeightProofV1();

export { HEIGHT_ATTRIBUTE, HEIGHT_CONTRACT, appendRelativeHeightAttribute, deriveRelativeHeightValues, parseGlb, partitionWithSourceIndices };
