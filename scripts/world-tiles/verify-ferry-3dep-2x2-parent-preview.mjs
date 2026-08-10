/** Verify the checked-in bounded-I/O Ferry 3DEP engineering-preview artifact. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFerry3dep2x2ParentPreview, encodeFloat32LittleEndian } from './build-ferry-3dep-2x2-parent-preview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-parent-v1');
const ARTIFACT = path.join(OUTPUT, 'sf-ferry-3dep-2x2-parent-preview-v1.f32le');
const RECEIPT = path.join(OUTPUT, 'sf-ferry-3dep-2x2-parent-preview-v1.receipt.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const [artifactBytes, receiptBytes] = await Promise.all([readFile(ARTIFACT), readFile(RECEIPT)]);
const receipt = JSON.parse(receiptBytes);
assert.deepEqual(encodeFloat32LittleEndian(Float32Array.from([1, -2.5])), Buffer.from('0000803f000020c0', 'hex'), 'Float32 preview serialization must be explicit little-endian bytes on every host');
assert.equal(receipt.status, 'preview-artifact-not-for-runtime-or-manifest-promotion');
assert.equal(receipt.relationship.regionId, 'sf-ferry-building-hero');
assert.equal(receipt.relationship.plannedCoverage, '2x2');
assert.equal(receipt.relationship.runtimePlacement, 'none');
assert.equal(receipt.relationship.manifestPromotion, 'prohibited');
assert.equal(receipt.horizontalReference.targetCrs, 'EPSG:26910');
assert.equal(receipt.horizontalReference.accuracyMetres, 4);
assert.equal(receipt.horizontalReference.subMetreClaim, false);
assert.equal(receipt.verticalDatumUnresolved, true);
assert.equal(receipt.raster.sampleEncoding, 'float32-le');
assert.equal(receipt.raster.serialization, 'explicit Buffer.writeFloatLE per sample; host-endian independent');
assert.equal(receipt.raster.interpolation, 'none; direct native samples');
assert.equal(receipt.raster.byteLength, artifactBytes.length);
assert.equal(receipt.raster.sha256, sha256(artifactBytes));
assert.equal(receipt.source.reader.boundedRead, true);
assert.equal(receipt.source.actualRawSha256, receipt.source.lockedRawSha256, 'Actual raw TIFF hash must match the source lock');
assert.equal(receipt.source.rawHashVerifiedBeforeWindowRead, true);
assert.equal(receipt.source.rawHashBytesRead, receipt.source.sourceBytes);
assert(receipt.source.reader.tileIndices.length > 0 && receipt.source.reader.tileIndices.length < 400, 'Preview must read only a bounded subset of source tiles');
assert.equal(receipt.source.reader.exactCompressedTileBytesRead + receipt.source.reader.metadataBytesRead, receipt.source.reader.totalBytesRead);
assert.deepEqual(receipt.source.reader.tileCoordinates.map(({ index }) => index), receipt.source.reader.tileIndices);
assert.equal(receipt.childViews.length, 4);
assert.equal(receipt.sharedBoundaryProof.length, 4);
for (const proof of receipt.sharedBoundaryProof) assert.equal(proof.byteIdentical, true);

const rebuilt = await buildFerry3dep2x2ParentPreview({ write: false });
assert(artifactBytes.equals(rebuilt.artifactBytes), 'Deterministic rebuild binary differs from checked-in artifact');
assert(receiptBytes.equals(jsonBytes(rebuilt.receipt)), 'Deterministic rebuild receipt differs from checked-in receipt');
assert.equal(rebuilt.receipt.raster.sha256, receipt.raster.sha256);
process.stdout.write(`${JSON.stringify({ result: 'Ferry 3DEP 2x2 engineering preview verified', deterministicRebuild: true, artifactSha256: receipt.raster.sha256, dimensionsPixels: receipt.raster.dimensionsPixels, sourceTileIndices: receipt.source.reader.tileIndices, sourceTileBytesRead: receipt.source.reader.exactCompressedTileBytesRead, nodataCount: receipt.raster.statistics.nodataCount, minMetres: receipt.raster.statistics.minMetres, maxMetres: receipt.raster.statistics.maxMetres, verticalDatumUnresolved: receipt.verticalDatumUnresolved }, null, 2)}\n`);
