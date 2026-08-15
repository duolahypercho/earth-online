#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SF_BUILDING_SOURCE_TONE_CONTRACT_V1 } from './sf-building-source-tone-contract-v1.mjs';

const ROOT = process.cwd();
const PROOF_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-source-tone-production-proof-v1');
const PROOF_MANIFEST_PATH = path.join(PROOF_ROOT, 'sf-building-source-tone-production-proof-v1.manifest.json');
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const VISUAL_PROOF_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-source-tone-proof-v1');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`); }

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binHeader = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942);
  return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + bytes.readUInt32LE(binHeader)) };
}

const component = Object.freeze({
  5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset), write: (buffer, value, offset) => buffer.writeUInt8(value, offset) },
  5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset), write: (buffer, value, offset) => buffer.writeUInt16LE(value, offset) },
  5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset), write: (buffer, value, offset) => buffer.writeUInt32LE(value, offset) },
  5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset), write: (buffer, value, offset) => buffer.writeFloatLE(value, offset) },
});
const width = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

function accessor(glb, index) {
  const definition = glb.json.accessors[index];
  const view = glb.json.bufferViews[definition.bufferView];
  const type = component[definition.componentType];
  const itemWidth = width[definition.type];
  assert(type && itemWidth);
  const stride = view.byteStride ?? type.bytes * itemWidth;
  const start = (view.byteOffset ?? 0) + (definition.byteOffset ?? 0);
  const values = [];
  for (let item = 0; item < definition.count; item += 1) for (let axis = 0; axis < itemWidth; axis += 1) values.push(type.read(glb.bin, start + item * stride + axis * type.bytes));
  const bytes = Buffer.alloc(values.length * type.bytes);
  values.forEach((value, valueIndex) => type.write(bytes, value, valueIndex * type.bytes));
  return { definition, values, bytes };
}

function geometryLedger(glb) {
  return glb.json.meshes[0].primitives.map((primitive) => {
    const positions = accessor(glb, primitive.attributes.POSITION);
    const indices = accessor(glb, primitive.indices);
    return { category: primitive.extras.category, chunkIndex: primitive.extras.chunkIndex, chunkCount: primitive.extras.chunkCount, sourceOsmWayIds: primitive.extras.sourceOsmWayIds, material: primitive.material, mode: primitive.mode, vertexCount: positions.definition.count, indexCount: indices.definition.count, positionSha256: `sha256:${sha256(positions.bytes)}`, indexSha256: `sha256:${sha256(indices.bytes)}` };
  });
}

function tonePayload(glb) {
  const values = [];
  for (const primitive of glb.json.meshes[0].primitives) {
    const toneIndex = primitive.attributes._SF_SOURCE_TONE_V1;
    if (primitive.extras.category !== 'buildings') {
      assert.equal(toneIndex, undefined, `${primitive.extras.category} unexpectedly carries a source tone`);
      continue;
    }
    assert.notEqual(toneIndex, undefined);
    const positions = accessor(glb, primitive.attributes.POSITION);
    const tones = accessor(glb, toneIndex);
    assert.equal(tones.definition.componentType, 5121);
    assert.equal(tones.definition.type, 'SCALAR');
    assert.equal(tones.definition.normalized, false);
    assert.equal(tones.definition.count, positions.definition.count);
    assert(tones.values.every((value) => Number.isInteger(value) && value >= 0 && value <= 3));
    values.push(...tones.values);
  }
  return Buffer.from(values);
}

const [proofManifest, productionManifest] = await Promise.all([
  readFile(PROOF_MANIFEST_PATH, 'utf8').then(JSON.parse),
  readFile(PRODUCTION_MANIFEST_PATH, 'utf8').then(JSON.parse),
]);
assert.equal(proofManifest.kind, 'sf-building-source-tone-production-proof-manifest');
assert.equal(proofManifest.status, 'write-disabled-production-shaped-proof');
assert.equal(proofManifest.productionPromotionAuthorized, false);
assert.equal(proofManifest.productionManifestTileCount, productionManifest.tiles.length);
assert.deepEqual(proofManifest.contract, SF_BUILDING_SOURCE_TONE_CONTRACT_V1);
assert.equal(proofManifest.tiles.length, 2);
const productionById = new Map(productionManifest.tiles.map((tile) => [tile.id, tile]));
const verified = [];

for (const tile of proofManifest.tiles) {
  const receipt = JSON.parse(await readFile(path.join(ROOT, tile.receipt), 'utf8'));
  const production = productionById.get(tile.tile);
  assert(production, `${tile.tile} is no longer resident`);
  assert.equal(receipt.kind, 'sf-building-source-tone-production-proof-receipt');
  assert.equal(receipt.status, 'write-disabled-production-shaped-proof');
  assert.equal(receipt.productionPromotionAuthorized, false);
  assert.deepEqual(tile.metricReceipt, receipt.metricReceipt);
  const metricReceiptBytes = await readFile(path.join(ROOT, receipt.metricReceipt.path));
  assert.equal(`sha256:${sha256(metricReceiptBytes)}`, receipt.metricReceipt.sha256);
  assert.equal(metricReceiptBytes.length, receipt.metricReceipt.bytes);
  const metricReceipt = JSON.parse(metricReceiptBytes);
  assert.equal(metricReceipt.kind, 'sf-metric-tile-build-receipt');
  assert.equal(metricReceipt.tile.identity, tile.tile);
  assert.equal(metricReceipt.tile.scale, 1);
  assert.deepEqual(metricReceipt.presentation.contract, SF_BUILDING_SOURCE_TONE_CONTRACT_V1);
  assert.equal(metricReceipt.presentation.productionWriteEnabled, false);
  assert.equal(receipt.metricReceipt.presentationStatus, 'write-disabled-production-shaped-proof');
  assert.equal(receipt.metricReceipt.productionWriteEnabled, false);
  assert.deepEqual(receipt.contract, SF_BUILDING_SOURCE_TONE_CONTRACT_V1);
  assert.equal(receipt.tile.horizontalCrs, 'EPSG:26910');
  assert.equal(receipt.tile.unitsPerMetre, 1);
  assert.equal(receipt.tile.verticalCertification, 'source-declared-navd88-unrealized');
  assert.equal(receipt.invariants.twoBuildCandidateBytesExact, true);
  assert.equal(receipt.invariants.twoBuildReceiptBytesExact, true);
  assert.equal(receipt.invariants.twoBuildPackageBytesExact, true);
  assert.equal(receipt.invariants.productionGeometryLedgerExact, true);
  assert.equal(receipt.invariants.productionPrimitiveCountExact, true);
  assert.equal(receipt.invariants.productionMaterialAssignmentsExact, true);
  assert.equal(receipt.invariants.sourceGeometryMoved, false);
  assert.equal(receipt.invariants.metricOriginOrScaleChanged, false);
  assert.equal(receipt.invariants.gameplayOrCollisionChanged, false);

  const [candidateBytes, productionBytes, visualReceipt] = await Promise.all([
    readFile(path.join(ROOT, receipt.artifact.path)),
    readFile(path.join(ROOT, production.lod0.path)),
    readFile(path.join(VISUAL_PROOF_ROOT, tile.tile, `${tile.tile}.building-source-tone-proof.receipt.json`), 'utf8').then(JSON.parse),
  ]);
  assert.equal(`sha256:${sha256(candidateBytes)}`, receipt.artifact.sha256);
  assert.equal(`sha256:${sha256(productionBytes)}`, production.lod0.sha256);
  assert.equal(receipt.productionReference.sha256, production.lod0.sha256);
  assert.equal(receipt.artifact.byteDeltaFromProduction, candidateBytes.length - productionBytes.length);
  const candidate = parseGlb(candidateBytes);
  const legacy = parseGlb(productionBytes);
  assert.deepEqual(candidate.json.extras.presentation, SF_BUILDING_SOURCE_TONE_CONTRACT_V1);
  const candidateLedger = geometryLedger(candidate);
  const productionLedger = geometryLedger(legacy);
  assert.deepEqual(candidateLedger, productionLedger);
  assert.equal(`sha256:${sha256(jsonBytes(candidateLedger))}`, receipt.ledgers.candidateGeometrySha256);
  assert.equal(receipt.ledgers.candidateGeometrySha256, receipt.ledgers.productionGeometrySha256);
  const payload = tonePayload(candidate);
  assert.equal(payload.length, receipt.counts.sourceTonePayloadBytes);
  assert.equal(`sha256:${sha256(payload)}`, receipt.ledgers.sourceToneAttributeSha256);
  assert.equal(receipt.ledgers.sourceToneAttributeSha256, visualReceipt.ledgers.sourceToneAttributeSha256);
  assert.equal(receipt.counts.productionPrimitives, productionLedger.length);
  assert.equal(receipt.counts.candidatePrimitives, candidateLedger.length);
  assert.equal(receipt.counts.buildingPrimitives, candidateLedger.filter(({ category }) => category === 'buildings').length);
  verified.push({ tile: tile.tile, role: tile.role, primitives: receipt.counts.candidatePrimitives, buildingPrimitives: receipt.counts.buildingPrimitives, sourceTonePayloadBytes: payload.length, byteDeltaFromProduction: receipt.artifact.byteDeltaFromProduction, artifactSha256: receipt.artifact.sha256 });
}

process.stdout.write(`${JSON.stringify({ result: 'SF building source-tone production-shaped proof passed', status: 'write-disabled-production-shaped-proof', productionPromotionAuthorized: false, productionManifestTiles: productionManifest.tiles.length, verified }, null, 2)}\n`);
