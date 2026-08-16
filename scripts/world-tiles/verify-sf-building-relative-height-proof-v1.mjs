#!/usr/bin/env node
/** Verify the source-locked, write-disabled relative-height preview proof. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';
import { HEIGHT_ATTRIBUTE, HEIGHT_CONTRACT, deriveRelativeHeightValues, parseGlb, partitionWithSourceIndices } from './build-sf-building-relative-height-proof-v1.mjs';

const ROOT = process.cwd();
const PROOF_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-relative-height-proof-v1');
const PROOF_MANIFEST_PATH = path.join(PROOF_ROOT, 'sf-building-relative-height-proof-v1.manifest.json');
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
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

const COMPONENTS = Object.freeze({ 5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset) }, 5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset) }, 5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset) }, 5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset) } });
const WIDTHS = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

function accessorValues(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex]; const view = glb.json.bufferViews[accessor?.bufferView]; const component = COMPONENTS[accessor?.componentType]; const width = WIDTHS[accessor?.type];
  assert(accessor && view && component && width, 'Malformed accessor contract');
  const stride = view.byteStride ?? component.bytes * width; const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const values = [];
  assert(start >= 0 && start + (accessor.count - 1) * stride + component.bytes * width <= glb.bin.length, 'Accessor exceeds GLB BIN');
  for (let item = 0; item < accessor.count; item += 1) for (let axis = 0; axis < width; axis += 1) values.push(component.read(glb.bin, start + item * stride + axis * component.bytes));
  return values;
}

function accessorRawBytes(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex]; const view = glb.json.bufferViews[accessor?.bufferView]; const component = COMPONENTS[accessor?.componentType]; const width = WIDTHS[accessor?.type];
  assert(accessor && view && component && width && !view.byteStride, 'Relative-height proof requires tightly packed accessors');
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const length = accessor.count * component.bytes * width;
  assert(start >= 0 && start + length <= glb.bin.length, 'Raw accessor exceeds GLB BIN');
  return glb.bin.subarray(start, start + length);
}

function geometryPrimitiveLedger(glb) {
  return glb.json.meshes[0].primitives.map((primitive) => ({ category: primitive.extras?.category ?? null, chunkIndex: primitive.extras?.chunkIndex ?? null, material: primitive.material, mode: primitive.mode, extras: primitive.extras, positionSha256: `sha256:${sha256(accessorRawBytes(glb, primitive.attributes.POSITION))}`, indexSha256: `sha256:${sha256(accessorRawBytes(glb, primitive.indices))}`, triangleCount: glb.json.accessors[primitive.indices].count / 3 }));
}

function triangleLedgerSha256(glb) {
  const values = glb.json.meshes[0].primitives.filter((primitive) => primitive.extras?.category === 'buildings').flatMap((primitive) => accessorValues(glb, primitive.indices));
  return `sha256:${sha256(Buffer.from(values.join(',')))}`;
}

function comparePrimitiveGeometry(candidate, production) {
  const candidatePrimitives = candidate.json.meshes[0].primitives; const productionPrimitives = production.json.meshes[0].primitives;
  assert.equal(candidatePrimitives.length, productionPrimitives.length, 'Primitive count changed');
  for (let index = 0; index < productionPrimitives.length; index += 1) {
    const actual = candidatePrimitives[index]; const expected = productionPrimitives[index];
    assert.deepEqual(actual.extras, expected.extras, `Primitive ${index} extras changed`); assert.equal(actual.material, expected.material, `Primitive ${index} material changed`); assert.equal(actual.mode, expected.mode, `Primitive ${index} mode changed`);
    assert(accessorRawBytes(candidate, actual.attributes.POSITION).equals(accessorRawBytes(production, expected.attributes.POSITION)), `Primitive ${index} POSITION bytes changed`);
    assert(accessorRawBytes(candidate, actual.indices).equals(accessorRawBytes(production, expected.indices)), `Primitive ${index} index bytes changed`);
    for (const [semantic, expectedAccessor] of Object.entries(expected.attributes)) {
      assert(Object.hasOwn(actual.attributes, semantic), `Primitive ${index} lost ${semantic}`);
      assert(accessorRawBytes(candidate, actual.attributes[semantic]).equals(accessorRawBytes(production, expectedAccessor)), `Primitive ${index} ${semantic} payload changed`);
    }
    const extraAttributes = Object.keys(actual.attributes).filter((semantic) => !Object.hasOwn(expected.attributes, semantic));
    assert.deepEqual(extraAttributes, expected.extras?.category === 'buildings' ? [HEIGHT_ATTRIBUTE.gltfSemantic] : [], `Primitive ${index} received an unexpected attribute`);
  }
}

async function verifyTile(tile, manifestTile, receiptEntry, productionManifestBytes, sharedInputs, verifiedTerrainSourceDigests) {
  const receiptPath = path.join(ROOT, receiptEntry.receipt); const receiptBytes = await readFile(receiptPath); const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.kind, 'sf-building-relative-height-proof-receipt'); assert.equal(receipt.status, 'preview-proof-only-not-production'); assert.equal(receipt.productionWriteEnabled, false); assert.equal(receipt.productionPromotionAuthorized, false); assert.equal(receipt.invariants.twoProofArtifactsByteExact, true);
  assert.deepEqual(receipt.attributeContract, HEIGHT_CONTRACT); assert.equal(receipt.attributeContractSha256, `sha256:${sha256(jsonBytes(HEIGHT_CONTRACT))}`); assert.equal(receipt.productionReference.manifestSha256, `sha256:${sha256(productionManifestBytes)}`);
  assert.equal(receipt.productionReference.declaredSha256, manifestTile.lod0.sha256);
  const [productionBytes, proofBytes, productionReceiptBytes] = await Promise.all([readFile(path.join(ROOT, manifestTile.lod0.path)), readFile(path.join(ROOT, receipt.proofArtifact.path)), readFile(path.join(ROOT, manifestTile.receipt.path))]);
  assert.equal(`sha256:${sha256(proofBytes)}`, receipt.proofArtifact.sha256); assert.equal(`sha256:${sha256(productionBytes)}`, manifestTile.lod0.sha256); assert.equal(`sha256:${sha256(productionReceiptBytes)}`, manifestTile.receipt.sha256); assert.equal(receipt.productionReference.receiptSha256, `sha256:${sha256(productionReceiptBytes)}`);
  const production = parseGlb(productionBytes); const candidate = parseGlb(proofBytes);
  assert.deepEqual(candidate.json.extras?.buildingRelativeHeight, HEIGHT_CONTRACT, `${tile.id} candidate contract missing`);
  comparePrimitiveGeometry(candidate, production);
  const productionBuilding = production.json.meshes[0].primitives.filter((primitive) => primitive.extras?.category === 'buildings'); const candidateBuilding = candidate.json.meshes[0].primitives.filter((primitive) => primitive.extras?.category === 'buildings');
  assert(candidateBuilding.length > 0, `${tile.id} has no building primitive`); assert.equal(candidateBuilding.length, productionBuilding.length);
  const sourceTonePresent = productionBuilding.some((primitive) => Object.hasOwn(primitive.attributes, '_SF_SOURCE_TONE_V1'));
  assert.equal(receipt.invariants.sourceTonePayloadPreserved, sourceTonePresent);
  const options = { tile, write: false, sharedInputs, verifiedTerrainSourceDigests, buildingRelativeHeightProof: true, ...(sourceTonePresent ? { buildingSourceToneProof: true } : {}) };
  const rebuilt = await buildSfMetricTile(options); assert(rebuilt.glbs[0].bytes.equals(productionBytes), `${tile.id} rebuilt baseline bytes do not equal production`);
  const relative = deriveRelativeHeightValues(rebuilt.categories, rebuilt.buildingRelativeHeightProof); const partitions = partitionWithSourceIndices(rebuilt.categories.buildings);
  assert.deepEqual(receipt.buildingRecords, relative.records, `${tile.id} source-building relative ledger drifted`);
  assert.equal(receipt.ledgers.sourcePositionFloat32Sha256, `sha256:${sha256(float32Bytes(rebuilt.categories.buildings.positions))}`);
  const sourceIndexBytes = rebuilt.categories.buildings.indices.length && Math.max(...rebuilt.categories.buildings.indices) > 65_535 ? uint32Bytes(rebuilt.categories.buildings.indices) : uint16Bytes(rebuilt.categories.buildings.indices);
  assert.equal(receipt.ledgers.sourceIndexSha256, `sha256:${sha256(sourceIndexBytes)}`); assert.equal(receipt.ledgers.sourceRelativeHeightAttributeSha256, `sha256:${sha256(float32Bytes(relative.values))}`);
  const serializedAttributeBytes = [];
  for (let index = 0; index < candidateBuilding.length; index += 1) {
    const primitive = candidateBuilding[index]; const productionPrimitive = productionBuilding[index]; const accessorIndex = primitive.attributes[HEIGHT_ATTRIBUTE.gltfSemantic]; const accessor = candidate.json.accessors[accessorIndex];
    assert(accessor, `${tile.id} relative-height accessor missing`); assert.equal(accessor.componentType, HEIGHT_ATTRIBUTE.componentType); assert.equal(accessor.type, HEIGHT_ATTRIBUTE.type); assert.equal(accessor.normalized, HEIGHT_ATTRIBUTE.normalized); assert.deepEqual(accessor.min, [0]); assert.deepEqual(accessor.max, [1]); assert.equal(accessor.count, candidate.json.accessors[primitive.attributes.POSITION].count);
    const values = accessorValues(candidate, accessorIndex); assert(values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1), `${tile.id} relative-height values leave 0..1`); const bytes = accessorRawBytes(candidate, accessorIndex); serializedAttributeBytes.push(bytes);
    const expectedBytes = float32Bytes(partitions[index].sourceIndices.map((sourceIndex) => relative.values[sourceIndex])); assert(bytes.equals(expectedBytes), `${tile.id} relative-height values were not remapped through chunk ${index}`);
    assert.equal(accessorRawBytes(candidate, primitive.attributes.POSITION).length, accessor.count * 3 * 4); assert.equal(productionPrimitive.extras.chunkIndex, primitive.extras.chunkIndex);
  }
  assert.equal(receipt.ledgers.serializedRelativeHeightAttributeSha256, `sha256:${sha256(Buffer.concat(serializedAttributeBytes))}`);
  assert.equal(receipt.ledgers.geometryPrimitiveLedgerSha256, `sha256:${sha256(jsonBytes(geometryPrimitiveLedger(production)))}`); assert.equal(receipt.ledgers.geometryTriangleIndexSha256, triangleLedgerSha256(production));
  const lockIds = new Set();
  for (const lock of receipt.sourceLocks) {
    assert(lock?.id && lock.path && lock.sha256, `${tile.id} source lock binding is incomplete`); assert(!lockIds.has(lock.id), `${tile.id} source lock is duplicated: ${lock.id}`); lockIds.add(lock.id);
    const bytes = await readFile(path.isAbsolute(lock.path) ? lock.path : path.join(ROOT, lock.path)); assert.equal(lock.sha256.replace(/^sha256:/, ''), sha256(bytes), `${tile.id} source lock bytes drifted: ${lock.id}`);
  }
  return { tile: tile.id, role: tile.role, buildings: receipt.counts.buildings, sourceVertices: receipt.counts.sourceVertices, serializedVertices: receipt.counts.serializedVertices, triangles: receipt.counts.triangles, proofSha256: receipt.proofArtifact.sha256, sourceTonePayloadPreserved: sourceTonePresent, exactProductionBytes: true, exactGeometryLedgers: true, sourceLocks: lockIds.size };
}

const [proofManifestBytes, productionManifestBytes] = await Promise.all([readFile(PROOF_MANIFEST_PATH), readFile(PRODUCTION_MANIFEST_PATH)]); const proofManifest = JSON.parse(proofManifestBytes); const productionManifest = JSON.parse(productionManifestBytes);
assert.equal(Buffer.compare(proofManifestBytes, jsonBytes(proofManifest)), 0, 'Relative-height proof manifest is not canonical'); assert.equal(proofManifest.kind, 'sf-building-relative-height-proof-manifest'); assert.equal(proofManifest.status, 'preview-proof-only-not-production'); assert.equal(proofManifest.productionWriteEnabled, false); assert.equal(proofManifest.productionPromotionAuthorized, false); assert.equal(proofManifest.productionManifestTileCount, productionManifest.tiles.length); assert.equal(proofManifest.productionManifestSha256, `sha256:${sha256(productionManifestBytes)}`); assert.deepEqual(proofManifest.attributeContract, HEIGHT_CONTRACT);
const productionById = new Map(productionManifest.tiles.map((tile) => [tile.id, tile])); const [sharedInputs, verifiedTerrainSourceDigests] = await Promise.all([loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests()]); const verified = [];
for (const entry of proofManifest.tiles) { const manifestTile = productionById.get(entry.tile); assert(manifestTile, `${entry.tile} is not a production resident`); verified.push(await verifyTile({ id: entry.tile, gridEasting: entry.tile.split('-')[1] * 1, gridNorthing: entry.tile.split('-')[2] * 1 }, manifestTile, entry, productionManifestBytes, sharedInputs, verifiedTerrainSourceDigests)); }
process.stdout.write(`${JSON.stringify({ result: 'SF building relative-height proof passed', status: proofManifest.status, productionWriteEnabled: false, productionPromotionAuthorized: false, productionManifestTiles: productionManifest.tiles.length, verified }, null, 2)}\n`);
