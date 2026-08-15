#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';
import { SF_BUILDING_SOURCE_TONE_CONTRACT_V1 } from './sf-building-source-tone-contract-v1.mjs';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-source-tone-production-proof-v1');
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

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB byte length mismatch');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binHeader = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942, 'GLB BIN chunk missing');
  const binLength = bytes.readUInt32LE(binHeader);
  return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength) };
}

const component = Object.freeze({
  5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset), write: (buffer, value, offset) => buffer.writeUInt8(value, offset) },
  5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset), write: (buffer, value, offset) => buffer.writeUInt16LE(value, offset) },
  5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset), write: (buffer, value, offset) => buffer.writeUInt32LE(value, offset) },
  5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset), write: (buffer, value, offset) => buffer.writeFloatLE(value, offset) },
});
const width = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

function accessor(glb, accessorIndex) {
  const definition = glb.json.accessors[accessorIndex];
  const view = glb.json.bufferViews[definition.bufferView];
  const type = component[definition.componentType];
  const itemWidth = width[definition.type];
  assert(type && itemWidth, 'Unsupported accessor encoding');
  const stride = view.byteStride ?? type.bytes * itemWidth;
  const start = (view.byteOffset ?? 0) + (definition.byteOffset ?? 0);
  const values = [];
  for (let item = 0; item < definition.count; item += 1) {
    for (let axis = 0; axis < itemWidth; axis += 1) values.push(type.read(glb.bin, start + item * stride + axis * type.bytes));
  }
  const bytes = Buffer.alloc(values.length * type.bytes);
  values.forEach((value, index) => type.write(bytes, value, index * type.bytes));
  return { definition, values, bytes };
}

function geometryLedger(glb) {
  return glb.json.meshes[0].primitives.map((primitive) => {
    const positions = accessor(glb, primitive.attributes.POSITION);
    const indices = accessor(glb, primitive.indices);
    return {
      category: primitive.extras.category,
      chunkIndex: primitive.extras.chunkIndex,
      chunkCount: primitive.extras.chunkCount,
      sourceOsmWayIds: primitive.extras.sourceOsmWayIds,
      material: primitive.material,
      mode: primitive.mode,
      vertexCount: positions.definition.count,
      indexCount: indices.definition.count,
      positionSha256: `sha256:${sha256(positions.bytes)}`,
      indexSha256: `sha256:${sha256(indices.bytes)}`,
    };
  });
}

function sourceTonePayload(glb) {
  const payload = [];
  for (const primitive of glb.json.meshes[0].primitives) {
    const toneAccessorIndex = primitive.attributes._SF_SOURCE_TONE_V1;
    if (primitive.extras.category !== 'buildings') {
      assert.equal(toneAccessorIndex, undefined, `${primitive.extras.category} must not carry a building source tone`);
      continue;
    }
    assert.notEqual(toneAccessorIndex, undefined, 'Every building chunk must carry _SF_SOURCE_TONE_V1');
    const positions = accessor(glb, primitive.attributes.POSITION);
    const tones = accessor(glb, toneAccessorIndex);
    assert.equal(tones.definition.componentType, 5121);
    assert.equal(tones.definition.type, 'SCALAR');
    assert.equal(tones.definition.normalized, false);
    assert.equal(tones.definition.count, positions.definition.count);
    assert(tones.values.every((value) => Number.isInteger(value) && value >= 0 && value <= 3));
    payload.push(...tones.values);
  }
  return Buffer.from(payload);
}

async function buildTile(tile, manifestTile, sharedInputs, verifiedTerrainSourceDigests) {
  const baseOptions = { tile, write: false, sharedInputs, verifiedTerrainSourceDigests };
  const [legacy, first, second] = await Promise.all([
    buildSfMetricTile(baseOptions),
    buildSfMetricTile({ ...baseOptions, buildingSourceToneProof: true }),
    buildSfMetricTile({ ...baseOptions, buildingSourceToneProof: true }),
  ]);
  const productionBytes = await readFile(path.join(ROOT, manifestTile.lod0.path));
  assert(legacy.glbs[0].bytes.equals(productionBytes), `${tile.id} default builder path no longer matches production bytes`);
  assert(first.glbs[0].bytes.equals(second.glbs[0].bytes), `${tile.id} source-tone production proof is not byte deterministic`);
  assert(jsonBytes(first.receipt).equals(jsonBytes(second.receipt)), `${tile.id} source-tone build receipts are not deterministic`);
  assert(jsonBytes(first.packageDescriptor).equals(jsonBytes(second.packageDescriptor)), `${tile.id} source-tone package descriptors are not deterministic`);

  const productionGlb = parseGlb(productionBytes);
  const candidateGlb = parseGlb(first.glbs[0].bytes);
  const productionLedger = geometryLedger(productionGlb);
  const candidateLedger = geometryLedger(candidateGlb);
  assert.deepEqual(candidateLedger, productionLedger, `${tile.id} source-tone candidate changed production geometry, indices, material assignment, or primitive batching`);
  assert.deepEqual(candidateGlb.json.extras.presentation, SF_BUILDING_SOURCE_TONE_CONTRACT_V1);
  const tonePayload = sourceTonePayload(candidateGlb);
  assert.equal(`sha256:${sha256(tonePayload)}`, first.buildingSourceToneProof.ledgers.sourceToneAttributeSha256);
  assert.equal(tonePayload.length, first.buildingSourceToneProof.counts.serializedVertices);

  const tileOutput = path.join(OUTPUT_ROOT, tile.id);
  await mkdir(tileOutput, { recursive: true });
  const artifactName = `${tile.id}.source-tone-production-proof.glb`;
  const artifactPath = path.join(tileOutput, artifactName);
  await writeFile(artifactPath, first.glbs[0].bytes);
  const receipt = {
    schemaVersion: 1,
    kind: 'sf-building-source-tone-production-proof-receipt',
    status: 'write-disabled-production-shaped-proof',
    productionPromotionAuthorized: false,
    tile: { id: tile.id, role: tile.role, horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, verticalCertification: 'source-declared-navd88-unrealized' },
    contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
    productionReference: { path: manifestTile.lod0.path, sha256: manifestTile.lod0.sha256, bytes: productionBytes.length, exactDefaultRebuildBytes: true },
    artifact: { path: path.relative(ROOT, artifactPath), sha256: `sha256:${sha256(first.glbs[0].bytes)}`, bytes: first.glbs[0].bytes.length, byteDeltaFromProduction: first.glbs[0].bytes.length - productionBytes.length },
    invariants: { twoBuildCandidateBytesExact: true, twoBuildReceiptBytesExact: true, twoBuildPackageBytesExact: true, productionGeometryLedgerExact: true, productionPrimitiveCountExact: true, productionMaterialAssignmentsExact: true, sourceGeometryMoved: false, metricOriginOrScaleChanged: false, gameplayOrCollisionChanged: false },
    counts: { productionPrimitives: productionLedger.length, candidatePrimitives: candidateLedger.length, buildingPrimitives: candidateLedger.filter(({ category }) => category === 'buildings').length, sourceTonePayloadBytes: tonePayload.length },
    ledgers: { productionGeometrySha256: `sha256:${sha256(jsonBytes(productionLedger))}`, candidateGeometrySha256: `sha256:${sha256(jsonBytes(candidateLedger))}`, sourceToneAttributeSha256: `sha256:${sha256(tonePayload)}`, sourceRecordsSha256: first.buildingSourceToneProof.ledgers.sourceRecordsSha256 },
    sourceLocks: first.packageDescriptor.sourceLocks,
  };
  const metricReceiptBytes = jsonBytes(first.receipt);
  const metricReceiptPath = path.join(tileOutput, `${tile.id}.source-tone-production-proof.metric-receipt.json`);
  await writeFile(metricReceiptPath, metricReceiptBytes);
  receipt.metricReceipt = {
    path: path.relative(ROOT, metricReceiptPath),
    sha256: `sha256:${sha256(metricReceiptBytes)}`,
    bytes: metricReceiptBytes.length,
    kind: first.receipt.kind,
    presentationStatus: first.receipt.presentation.status,
    productionWriteEnabled: first.receipt.presentation.productionWriteEnabled,
  };
  const receiptPath = path.join(tileOutput, `${tile.id}.source-tone-production-proof.receipt.json`);
  await writeFile(receiptPath, jsonBytes(receipt));
  return { tile: tile.id, role: tile.role, artifact: receipt.artifact, receipt: path.relative(ROOT, receiptPath), metricReceipt: receipt.metricReceipt, counts: receipt.counts, ledgers: receipt.ledgers };
}

const productionManifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const byId = new Map(productionManifest.tiles.map((tile) => [tile.id, tile]));
const [sharedInputs, verifiedTerrainSourceDigests] = await Promise.all([loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests()]);
await mkdir(OUTPUT_ROOT, { recursive: true });
const tiles = [];
for (const tile of TILES) {
  const manifestTile = byId.get(tile.id);
  assert(manifestTile, `${tile.id} is not a production resident`);
  tiles.push(await buildTile(tile, manifestTile, sharedInputs, verifiedTerrainSourceDigests));
}
const proofManifest = { schemaVersion: 1, kind: 'sf-building-source-tone-production-proof-manifest', status: 'write-disabled-production-shaped-proof', productionPromotionAuthorized: false, productionManifestTileCount: productionManifest.tiles.length, contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1, tiles };
await writeFile(path.join(OUTPUT_ROOT, 'sf-building-source-tone-production-proof-v1.manifest.json'), jsonBytes(proofManifest));
process.stdout.write(`${JSON.stringify(proofManifest, null, 2)}\n`);
