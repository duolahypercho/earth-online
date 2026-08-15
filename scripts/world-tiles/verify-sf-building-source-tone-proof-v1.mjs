#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PROOF_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-source-tone-proof-v1');
const PROOF_MANIFEST_PATH = path.join(PROOF_ROOT, 'sf-building-source-tone-proof-v1.manifest.json');
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
  5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset) },
  5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset) },
  5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset) },
  5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset) },
});
const width = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

function accessorValues(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex];
  const view = glb.json.bufferViews[accessor.bufferView];
  const type = component[accessor.componentType];
  const itemWidth = width[accessor.type];
  assert(type && itemWidth, 'Unsupported accessor encoding');
  const stride = view.byteStride ?? type.bytes * itemWidth;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = [];
  for (let item = 0; item < accessor.count; item += 1) {
    for (let axis = 0; axis < itemWidth; axis += 1) values.push(type.read(glb.bin, start + item * stride + axis * type.bytes));
  }
  return values;
}

function primitiveLedger(glb, attributeName) {
  return glb.json.meshes[0].primitives.map((primitive) => ({
    attribute: accessorValues(glb, primitive.attributes[attributeName]),
    indices: accessorValues(glb, primitive.indices),
    material: primitive.material,
    extras: primitive.extras,
  }));
}

const [proofManifest, productionManifest] = await Promise.all([
  readFile(PROOF_MANIFEST_PATH, 'utf8').then(JSON.parse),
  readFile(PRODUCTION_MANIFEST_PATH, 'utf8').then(JSON.parse),
]);
assert.equal(proofManifest.kind, 'sf-building-source-tone-proof-manifest');
assert.equal(proofManifest.status, 'preview-proof-only-not-production');
assert.equal(proofManifest.productionPromotionAuthorized, false);
assert.equal(proofManifest.productionManifestTileCount, productionManifest.tiles.length);
assert.equal(proofManifest.tiles.length, 2);
assert.equal(proofManifest.contract.schema, 'sf-building-source-tone-v1');
assert.deepEqual(proofManifest.contract.attribute, { gltfSemantic: '_SF_SOURCE_TONE_V1', threeAttributeName: '_sf_source_tone_v1', componentType: 5121, type: 'SCALAR', normalized: false, domain: [0, 3] });

const productionById = new Map(productionManifest.tiles.map((tile) => [tile.id, tile]));
const verified = [];
for (const tile of proofManifest.tiles) {
  const receiptBytes = await readFile(path.join(ROOT, tile.receipt));
  const receipt = JSON.parse(receiptBytes);
  const production = productionById.get(tile.tile);
  assert(production, `${tile.tile} is no longer a production resident`);
  assert.equal(receipt.kind, 'sf-building-source-tone-proof-receipt');
  assert.equal(receipt.status, 'preview-proof-only-not-production');
  assert.equal(receipt.productionPromotionAuthorized, false);
  assert.deepEqual(receipt.contract, proofManifest.contract);
  assert.equal(receipt.tile.horizontalCrs, 'EPSG:26910');
  assert.equal(receipt.tile.unitsPerMetre, 1);
  assert.equal(receipt.tile.verticalCertification, 'source-declared-navd88-unrealized');
  assert.equal(receipt.invariants.twoBuildProofBytesExact, true);
  assert.equal(receipt.invariants.productionDefaultGlbBytesExact, true);
  assert.equal(receipt.invariants.legacyProofBytesExact, true);
  assert.equal(receipt.invariants.sourceGeometryMoved, false);
  assert.equal(receipt.invariants.gameplayOrCollisionChanged, false);

  const [proofBytes, productionBytes, productionReceiptBytes, legacyProofBytes, legacyReceiptBytes] = await Promise.all([
    readFile(path.join(ROOT, receipt.proofArtifact.path)),
    readFile(path.join(ROOT, production.lod0.path)),
    readFile(path.join(ROOT, production.receipt.path)),
    readFile(path.join(ROOT, receipt.legacyProofReference.path)),
    readFile(path.join(ROOT, receipt.legacyProofReference.receiptPath)),
  ]);
  assert.equal(`sha256:${sha256(proofBytes)}`, receipt.proofArtifact.sha256);
  assert.equal(`sha256:${sha256(productionBytes)}`, production.lod0.sha256);
  assert.equal(`sha256:${sha256(productionReceiptBytes)}`, production.receipt.sha256);
  assert.equal(`sha256:${sha256(legacyProofBytes)}`, receipt.legacyProofReference.sha256);
  assert.equal(`sha256:${sha256(legacyReceiptBytes)}`, receipt.legacyProofReference.receiptSha256);
  assert.equal(receipt.productionReference.declaredSha256, production.lod0.sha256);
  assert.equal(receipt.productionReference.exactDefaultBytesPreserved, true);

  const proofGlb = parseGlb(proofBytes);
  const legacyGlb = parseGlb(legacyProofBytes);
  assert.deepEqual(proofGlb.json.extras.presentation, receipt.contract);
  const proofPrimitives = proofGlb.json.meshes[0].primitives;
  const legacyPrimitives = legacyGlb.json.meshes[0].primitives;
  assert.equal(proofPrimitives.length, legacyPrimitives.length);
  assert.deepEqual(primitiveLedger(proofGlb, 'POSITION'), primitiveLedger(legacyGlb, 'POSITION'), `${tile.tile} source-tone proof changed positions, indices, materials, or batch metadata`);

  const firstPrimitive = proofPrimitives[0];
  const toneAccessor = proofGlb.json.accessors[firstPrimitive.attributes._SF_SOURCE_TONE_V1];
  assert.equal(toneAccessor.componentType, 5121);
  assert.equal(toneAccessor.type, 'SCALAR');
  assert.equal(toneAccessor.normalized, false);
  assert.deepEqual(toneAccessor.min, [0]);
  assert.deepEqual(toneAccessor.max, [3]);
  const toneValues = accessorValues(proofGlb, firstPrimitive.attributes._SF_SOURCE_TONE_V1);
  assert.equal(toneValues.length, receipt.counts.vertices);
  assert.equal(`sha256:${sha256(Buffer.from(toneValues))}`, receipt.ledgers.sourceToneAttributeSha256);
  assert.equal(`sha256:${sha256(jsonBytes(receipt.sourceToneRecords))}`, receipt.ledgers.sourceToneRecordsSha256);
  const expectedCounts = [0, 0, 0, 0];
  for (const record of receipt.sourceToneRecords) {
    assert.match(record.sourceFeatureId, /^way\/\d+$/);
    assert.equal(record.sourceToneV1, Number(BigInt(record.sourceFeatureId.split('/')[1]) % 4n));
    expectedCounts[record.sourceToneV1] += 1;
    for (let index = record.vertexStart; index < record.vertexStart + record.vertexCount; index += 1) assert.equal(toneValues[index], record.sourceToneV1, `${tile.tile} ${record.sourceFeatureId} tone attribute drifted`);
  }
  assert.deepEqual(expectedCounts, receipt.counts.tones);
  for (const primitive of proofPrimitives) {
    assert.equal(primitive.attributes._SF_SOURCE_TONE_V1, firstPrimitive.attributes._SF_SOURCE_TONE_V1);
    assert.equal(legacyPrimitives[proofPrimitives.indexOf(primitive)].attributes._SF_SOURCE_TONE_V1, undefined);
  }
  verified.push({ tile: tile.tile, role: tile.role, buildings: receipt.counts.buildings, tones: receipt.counts.tones, proofSha256: receipt.proofArtifact.sha256, exactLegacyGeometry: true, exactProductionBytes: true });
}

process.stdout.write(`${JSON.stringify({ result: 'SF building source-tone proof passed', status: 'preview-proof-only-not-production', productionPromotionAuthorized: false, productionManifestTiles: productionManifest.tiles.length, verified }, null, 2)}\n`);
