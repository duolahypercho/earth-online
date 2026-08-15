#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PROOF_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-presentation-proof-v1');
const PROOF_MANIFEST_PATH = path.join(PROOF_ROOT, 'sf-building-presentation-proof-v1.manifest.json');
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB byte length mismatch');
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binHeader = 20 + jsonLength; assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942, 'GLB BIN chunk missing');
  const binLength = bytes.readUInt32LE(binHeader); const bin = bytes.subarray(binHeader + 8, binHeader + 8 + binLength);
  return { json, bin };
}

const component = Object.freeze({
  5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset) },
  5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset) },
  5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset) },
  5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset) },
});
const width = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

function accessorValues(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex]; const view = glb.json.bufferViews[accessor.bufferView]; const type = component[accessor.componentType]; const itemWidth = width[accessor.type];
  assert(type && itemWidth, 'Unsupported accessor encoding');
  const stride = view.byteStride ?? type.bytes * itemWidth; const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const values = [];
  for (let item = 0; item < accessor.count; item += 1) for (let axis = 0; axis < itemWidth; axis += 1) values.push(type.read(glb.bin, start + item * stride + axis * type.bytes));
  return values;
}

function expandedTrianglePositionBytes(glb, primitives) {
  const output = [];
  for (const primitive of primitives) {
    const positions = accessorValues(glb, primitive.attributes.POSITION); const indices = accessorValues(glb, primitive.indices);
    for (const index of indices) output.push(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
  }
  const bytes = Buffer.alloc(output.length * 4); output.forEach((value, index) => bytes.writeFloatLE(value, index * 4)); return bytes;
}

const [proofManifest, productionManifest] = await Promise.all([readFile(PROOF_MANIFEST_PATH, 'utf8').then(JSON.parse), readFile(PRODUCTION_MANIFEST_PATH, 'utf8').then(JSON.parse)]);
assert.equal(proofManifest.kind, 'sf-building-presentation-proof-manifest'); assert.equal(proofManifest.status, 'preview-proof-only-not-production');
assert.equal(proofManifest.productionManifestTileCount, productionManifest.tiles.length); assert.equal(proofManifest.tiles.length, 2);
const productionById = new Map(productionManifest.tiles.map((tile) => [tile.id, tile])); const verified = [];
for (const tile of proofManifest.tiles) {
  const production = productionById.get(tile.tile); assert(production, `${tile.tile} is no longer a production resident`);
  const receiptBytes = await readFile(path.join(ROOT, tile.receipt)); const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.kind, 'sf-building-presentation-proof-receipt'); assert.equal(receipt.status, 'preview-proof-only-not-production');
  assert.equal(receipt.tile.horizontalCrs, 'EPSG:26910'); assert.equal(receipt.tile.unitsPerMetre, 1); assert.equal(receipt.tile.verticalCertification, 'source-declared-navd88-unrealized');
  assert.equal(receipt.claims.sourcedWindowInventory, false); assert.equal(receipt.claims.sourceBuildingFootprintChanged, false); assert.equal(receipt.claims.gameplayOrCollisionChanged, false);
  assert.equal(receipt.invariants.twoBuildProofBytesExact, true); assert.equal(receipt.invariants.sourcePositionFloat32BytesExact, true); assert.equal(receipt.invariants.sourceCategoryIndexSequencePreserved, true); assert.equal(receipt.invariants.productionTrianglePositionSequenceExact, true);
  const [proofBytes, productionBytes] = await Promise.all([readFile(path.join(ROOT, receipt.proofArtifact.path)), readFile(path.join(ROOT, production.lod0.path))]);
  assert.equal(`sha256:${sha256(proofBytes)}`, receipt.proofArtifact.sha256, `${tile.tile} proof hash mismatch`);
  assert.equal(`sha256:${sha256(productionBytes)}`, production.lod0.sha256, `${tile.tile} production hash mismatch`);
  assert.equal(receipt.productionReference.declaredSha256, production.lod0.sha256); assert.equal(receipt.productionReference.exactDefaultBytesPreserved, true);
  const proofGlb = parseGlb(proofBytes); const productionGlb = parseGlb(productionBytes);
  assert.equal(proofGlb.json.extras.unitsPerMetre, 1); assert.equal(proofGlb.json.extras.status, 'preview-proof-only-not-production'); assert.equal(proofGlb.json.extras.sourceWindowInventoryClaim, false);
  const proofPrimitives = proofGlb.json.meshes[0].primitives; const productionPrimitives = productionGlb.json.meshes[0].primitives.filter((primitive) => primitive.extras?.category === 'buildings');
  assert(productionPrimitives.length > 0, `${tile.tile} production building primitive missing`); assert.equal(proofPrimitives.length, receipt.counts.primitives);
  const proofExpanded = expandedTrianglePositionBytes(proofGlb, proofPrimitives); const productionExpanded = expandedTrianglePositionBytes(productionGlb, productionPrimitives);
  assert(proofExpanded.equals(productionExpanded), `${tile.tile} proof triangle positions/order differ from production`);
  assert.equal(proofExpanded.length / 12, receipt.counts.indices); assert.equal(receipt.counts.indices / 3, receipt.counts.triangles);
  const seenBuildings = new Set(); let roof = 0; let wall = 0;
  for (const primitive of proofPrimitives) {
    assert.deepEqual(Object.keys(primitive.attributes).sort(), ['POSITION', '_SF_BUILDING_ORDINAL', '_SF_LOCAL_METRES', '_SF_TONE_KEY'].sort());
    assert.equal(primitive.extras.presentationOnly, true); assert.match(primitive.extras.sourceFeatureId, /^way\/\d+$/); seenBuildings.add(primitive.extras.sourceFeatureId);
    if (primitive.extras.surfaceKind === 'roof') roof += 1; else if (primitive.extras.surfaceKind === 'wall') wall += 1; else assert.fail('Unknown proof surface kind');
  }
  assert.equal(seenBuildings.size, receipt.counts.buildings); assert.equal(roof, receipt.counts.buildings); assert.equal(wall, receipt.counts.buildings);
  verified.push({ tile: tile.tile, role: tile.role, buildings: receipt.counts.buildings, triangles: receipt.counts.triangles, primitives: receipt.counts.primitives, proofSha256: receipt.proofArtifact.sha256, exactProductionTriangleSequence: true });
}
process.stdout.write(`${JSON.stringify({ result: 'SF building presentation proof passed', status: 'preview-proof-only-not-production', productionManifestTiles: productionManifest.tiles.length, verified }, null, 2)}\n`);
