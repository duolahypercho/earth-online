#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDataSfBuildingHeightPreview } from './build-sf-datasf-building-height-preview-v1.mjs';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-building-height-preview-v1');
const MANIFEST_PATH = path.join(OUTPUT_ROOT, 'sf-datasf-building-height-preview-v1.manifest.json');
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12); const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()); const binHeader = 20 + jsonLength; const binLength = bytes.readUInt32LE(binHeader); const bin = bytes.subarray(binHeader + 8, binHeader + 8 + binLength); return { json, bin };
}

const component = Object.freeze({ 5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset) }, 5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset) }, 5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset) }, 5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset) } });
const width = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });
function accessorValues(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex]; const view = glb.json.bufferViews[accessor.bufferView]; const type = component[accessor.componentType]; const itemWidth = width[accessor.type]; assert(type && itemWidth);
  const stride = view.byteStride ?? type.bytes * itemWidth; const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const values = [];
  for (let item = 0; item < accessor.count; item += 1) for (let axis = 0; axis < itemWidth; axis += 1) values.push(type.read(glb.bin, start + item * stride + axis * type.bytes)); return values;
}

const [manifestBytes, productionManifestBytes] = await Promise.all([readFile(MANIFEST_PATH), readFile(PRODUCTION_MANIFEST_PATH)]); const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.kind, 'sf-datasf-building-height-preview-manifest'); assert.equal(manifest.status, 'preview-source-height-comparison-only-not-production');
assert.deepEqual(manifest.claims, { productionGeometryChanged: false, runtimeChanged: false, gameplayChanged: false, facadeSemanticsSupplied: false, verticalReconciliationComplete: false });
assert(!productionManifestBytes.includes(Buffer.from('sf-datasf-building-height-preview')), 'DataSF height preview leaked into production manifest'); assert.equal(manifest.regions.length, 2);
const expected = new Map([['ferry', { tileId: 'epsg26910-1441-10893', sourceBuildings: 24, matchedBuildings: 11, changedTopVertices: 111 }], ['district', { tileId: 'epsg26910-1430-10882', sourceBuildings: 390, matchedBuildings: 297, changedTopVertices: 3321 }]]);
const verified = [];
for (const descriptor of manifest.regions) {
  const expectation = expected.get(descriptor.id); assert(expectation); assert.equal(descriptor.tileId, expectation.tileId); assert.deepEqual(descriptor.counts, { sourceBuildings: expectation.sourceBuildings, matchedBuildings: expectation.matchedBuildings, changedTopVertices: expectation.changedTopVertices });
  const receiptBytes = await readFile(path.join(ROOT, descriptor.receipt)); const receipt = JSON.parse(receiptBytes); assert.equal(receipt.kind, 'sf-datasf-building-height-preview-receipt'); assert.equal(receipt.status, manifest.status); assert.equal(receipt.tile.unitsPerMetre, 1); assert.equal(receipt.tile.verticalCertification, 'source-declared-navd88-unrealized');
  assert.deepEqual(receipt.policy, { matchedBuildingsOnly: true, heightField: 'hgt_median_m', topVertexRule: 'uniformly translate every existing top vertex by DataSF hgt_median_m minus the existing extrusion height; preserves the exact source roof shape', horizontalGeometry: 'exact source proof X/Z retained', bottomVertices: 'exact source proof retained', unmatchedBuildings: 'exact source proof retained', facadeSemantics: 'not supplied', absoluteVerticalPlacement: 'not claimed', runtimePromotion: false });
  const [sourceBytes, sourceReceiptBytes, matchBytes, previewBytes] = await Promise.all([readFile(path.join(ROOT, receipt.source.buildingPresentationProof.path)), readFile(path.join(ROOT, receipt.source.buildingPresentationProofReceipt.path)), readFile(path.join(ROOT, receipt.source.matchProof.path)), readFile(path.join(ROOT, receipt.artifact.path))]);
  for (const [entry, bytes] of [[receipt.source.buildingPresentationProof, sourceBytes], [receipt.source.buildingPresentationProofReceipt, sourceReceiptBytes], [receipt.source.matchProof, matchBytes], [receipt.artifact, previewBytes]]) { assert.equal(bytes.length, entry.bytes); assert.equal(`sha256:${sha256(bytes)}`, entry.sha256); }
  const sourceReceipt = JSON.parse(sourceReceiptBytes); const source = parseGlb(sourceBytes); const preview = parseGlb(previewBytes); assert.equal(preview.json.extras.status, manifest.status); assert.equal(preview.json.extras.dataSfHeightField, 'hgt_median_m'); assert.equal(preview.json.extras.horizontalGeometryChanged, false); assert.equal(preview.json.extras.bottomVerticesChanged, false); assert.equal(preview.json.extras.unmatchedBuildingsChanged, false); assert.equal(preview.json.extras.verticalReconciliationComplete, false);
  const sourcePositionAccessor = source.json.meshes[0].primitives[0].attributes.POSITION; const previewPositionAccessor = preview.json.meshes[0].primitives[0].attributes.POSITION; const sourcePositions = accessorValues(source, sourcePositionAccessor); const previewPositions = accessorValues(preview, previewPositionAccessor); assert.equal(sourcePositions.length, previewPositions.length);
  const records = new Map(sourceReceipt.buildingRecords.map((record) => [record.sourceFeatureId, record])); const allowedTop = new Map();
  for (const change of receipt.changes) {
    const record = records.get(change.osmSourceFeatureId); assert(record); const ringLength = record.vertexCount / 2; assert.equal(change.topVerticesChanged, ringLength); assert.equal(change.heightDeltaMetres, Number((change.dataSfMedianHeightMetres - change.previousHeightMetres).toFixed(6)));
    for (let index = 0; index < ringLength; index += 1) allowedTop.set(record.vertexStart + index * 2 + 1, { heightDelta: change.dataSfMedianHeightMetres - change.previousHeightMetres });
  }
  assert.equal(allowedTop.size, expectation.changedTopVertices); let changedY = 0;
  for (let vertex = 0; vertex < sourcePositions.length / 3; vertex += 1) {
    assert.equal(previewPositions[vertex * 3], sourcePositions[vertex * 3], `${descriptor.id} X changed at ${vertex}`); assert.equal(previewPositions[vertex * 3 + 2], sourcePositions[vertex * 3 + 2], `${descriptor.id} Z changed at ${vertex}`);
    const allowed = allowedTop.get(vertex);
    if (allowed) {
      const expectedY = sourcePositions[vertex * 3 + 1] + allowed.heightDelta; assert(Math.abs(previewPositions[vertex * 3 + 1] - expectedY) <= 1e-5, `${descriptor.id} DataSF top Y mismatch at ${vertex}`); if (previewPositions[vertex * 3 + 1] !== sourcePositions[vertex * 3 + 1]) changedY += 1;
    } else assert.equal(previewPositions[vertex * 3 + 1], sourcePositions[vertex * 3 + 1], `${descriptor.id} unapproved Y change at ${vertex}`);
  }
  assert(changedY > 0); assert.equal(source.json.meshes[0].primitives.length, preview.json.meshes[0].primitives.length);
  for (let primitive = 0; primitive < source.json.meshes[0].primitives.length; primitive += 1) assert.deepEqual(accessorValues(source, source.json.meshes[0].primitives[primitive].indices), accessorValues(preview, preview.json.meshes[0].primitives[primitive].indices), `${descriptor.id} indices changed`);
  assert.equal(`sha256:${sha256(Buffer.from(`${JSON.stringify(receipt.changes.map((change) => canonical(change)), null, 2)}\n`))}`, descriptor.changesSha256);
  verified.push({ id: descriptor.id, tileId: descriptor.tileId, matchedBuildings: expectation.matchedBuildings, changedTopVertices: expectation.changedTopVertices, exactHorizontalCoordinates: true, exactBottomAndUnmatchedVertices: true, exactTriangleIndices: true });
}

const first = await buildDataSfBuildingHeightPreview({ write: false }); const second = await buildDataSfBuildingHeightPreview({ write: false }); assert(first.manifestBytes.equals(second.manifestBytes)); assert(first.manifestBytes.equals(manifestBytes));
process.stdout.write(`${JSON.stringify({ result: 'SF DataSF building height preview passed', status: manifest.status, verified, deterministicManifestRebuild: true, productionPromotionAuthorized: false }, null, 2)}\n`);

function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
