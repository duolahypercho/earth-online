/** Verify the committed four-child, three-LOD offline Ferry terrain preview. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFerry3dep2x2ChildPreviewArtifacts } from './build-ferry-3dep-2x2-child-preview-artifacts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-children-v1');
const RECEIPT = path.join(OUTPUT, 'sf-ferry-3dep-2x2-child-preview-artifacts-v1.receipt.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const EXPECTED_SOURCE_CHAIN = {
  parentReceiptSha256: '8d34df70e93f92fb7b5076f3ee0260bd6c8605ca92de14703a2eb39e835419be',
  parentArtifactSha256: '4975b5f6542d0ff87af840d04cfaf25ab08398889da441efb043b0fae4fafcdc',
  rawGeoTiffSha256: '9cc9c03f4ddaf8ec6712951b980157ea02293c7723761466e6e60f21147a9424', rawGeoTiffBytes: 86461076,
  sourceLockSha256: '3751942da71cf0714827f809803ffb44dc1143430e350f8d0b1bd23da6da651b',
  horizontalLockSha256: 'd5a86d211be380eec4bc03ff5e97dbef4dfaf2866578ab5330c90c7b586fcc21',
  verticalLockSha256: 'fc054af8c2117c19b759e1c1b7150046d207c0ebd839975639b786446a2d2165',
};

const receiptBytes = await readFile(RECEIPT);
const receipt = JSON.parse(receiptBytes);
assert.equal(receipt.status, 'preview-artifact-not-for-runtime-or-manifest-promotion');
assert.equal(receipt.previewOnly, true);
assert.equal(receipt.relationship.runtimePlacement, 'none');
assert.equal(receipt.relationship.manifestPromotion, 'prohibited');
assert.equal(receipt.relationship.quadrantViews, 'existing parent-native quadrant views only; not sf-local tiles, 384m cores, 16m buffered source windows, canonical tile IDs, or sf-atlas placement');
assert.equal(receipt.horizontalReference.targetCrs, 'EPSG:26910');
assert.equal(receipt.horizontalReference.accuracyMetres, 4);
assert.equal(receipt.horizontalReference.subMetreClaim, false);
assert.equal(receipt.verticalReference.localTidalTransfer, 'not established and prohibited');
assert.equal(receipt.verticalReference.waterLevel, 'not represented');
assert.equal(receipt.verticalReference.parentVerticalDatumUnresolved, true);
assert.equal(receipt.verticalReference.unresolvedMeaning, 'the parent has no embedded vertical CRS, geoid, epoch, or local reconciliation; this does not negate the source product metadata NAVD88 declaration');
assert.equal(receipt.verticalReference.contextualLockUse, 'the NOAA station reference lock supplies limitations only and applies no transformation to these samples');
assert.equal(receipt.sourceChain.parentPreview.receiptSha256, EXPECTED_SOURCE_CHAIN.parentReceiptSha256);
assert.equal(receipt.sourceChain.parentPreview.artifactSha256, EXPECTED_SOURCE_CHAIN.parentArtifactSha256);
assert.equal(receipt.sourceChain.lockedRawGeoTiff.sha256, EXPECTED_SOURCE_CHAIN.rawGeoTiffSha256);
assert.equal(receipt.sourceChain.lockedRawGeoTiff.bytes, EXPECTED_SOURCE_CHAIN.rawGeoTiffBytes);
assert.equal(receipt.sourceChain.sourceLock.sha256, EXPECTED_SOURCE_CHAIN.sourceLockSha256);
assert.equal(receipt.sourceChain.horizontalLock.sha256, EXPECTED_SOURCE_CHAIN.horizontalLockSha256);
assert.equal(receipt.sourceChain.verticalReferenceLock.sha256, EXPECTED_SOURCE_CHAIN.verticalLockSha256);
assert.equal(receipt.sourceChain.verticalReferenceLock.role, 'contextual limitation evidence only; no vertical or tidal transformation is applied');
assert(receipt.limitations.includes('LOD1 and LOD2 are phase-locked selected sample lattices, not regular PixelIsArea coverage rasters. They must not be rendered, interpolated, resampled, or consumed by runtime or manifests.'));
assert.deepEqual(receipt.nodataSemantics, { sentinel: -999999, encoding: 'float32-le', sourceMeaning: 'locked parent raster nodata sentinel', preservation: 'the exact float32 sentinel bytes are copied unchanged at every LOD; no NaN, Infinity, substitution, averaging, or interpolation is permitted' });
assert.equal(receipt.artifacts.length, 12);
assert.equal(receipt.materialization.lodDescriptors.length, 3);
assert.equal(receipt.sharedEdgeProof.length, 12);
for (const proof of receipt.sharedEdgeProof) assert.equal(proof.byteIdentical, true);

let artifactBytes = 0;
const nodataBytes = Buffer.allocUnsafe(4); nodataBytes.writeFloatLE(receipt.nodataSemantics.sentinel, 0);
for (const artifact of receipt.artifacts) {
  assert.equal(artifact.sampleLayout.encoding, 'float32-le');
  assert.equal(artifact.sampleLayout.sampleCount * 4, artifact.sampleLayout.byteLength);
  assert.equal(artifact.sampleLayout.sampleCount, artifact.sampleLayout.dimensionsPixels[0] * artifact.sampleLayout.dimensionsPixels[1]);
  assert.equal(artifact.sourceFrame.modelCrs, 'EPSG:26910');
  assert.equal(artifact.sourceFrame.sourceRasterType, 'PixelIsArea');
  assert.equal(artifact.sourceFrame.geometryRule, 'bounds are inherited source PixelIsArea edges; source samples represent native pixel centers');
  assert.deepEqual(artifact.sourceFrame.parentAffine.coefficients, [1, 0, 549993.9999840065, 0, -1, 4190005.9999845778]);
  assert.equal(artifact.sourceFrame.parentAffine.eastingIncreasesWithSourceColumn, true);
  assert.equal(artifact.sourceFrame.parentAffine.northingDecreasesWithSourceRow, true);
  assert.equal(artifact.sourceFrame.parentAffine.sourcePixelCenterFormula, 'easting = tiepointX + (sourceColumn + 0.5) * scaleX; northing = tiepointY + (sourceRow + 0.5) * scaleY');
  assert.deepEqual(artifact.sourceFrame.nativeSourceSampleSpacingMetres, [1, -1]);
  assert.equal(artifact.sampleLayout.sourceNativeSampleSpacingMetres[0], 1);
  assert.equal(artifact.sampleLayout.sourceNativeSampleSpacingMetres[1], 1);
  assert.deepEqual(artifact.sampleLayout.parentPhase, [0, 0]);
  assert.equal(artifact.sampleLayout.phaseAlignment.parentColumnStartModuloStride, 0);
  assert.equal(artifact.sampleLayout.phaseAlignment.parentRowStartModuloStride, 0);
  assert.equal(artifact.sampleLayout.phaseAlignment.required, 'both starts and shared child seam indices are phase 0 modulo the LOD stride');
  assert.equal(artifact.sampleLayout.columns.sourcePixelStartIndex, artifact.sourceFrame.parentNativePixelWindow.column + artifact.sampleLayout.columns.parentStartIndex);
  assert.equal(artifact.sampleLayout.rows.sourcePixelStartIndex, artifact.sourceFrame.parentNativePixelWindow.row + artifact.sampleLayout.rows.parentStartIndex);
  assert.equal(artifact.sampleLayout.columns.sourcePixelStartIndex, artifact.sourceFrame.sourcePixelWindow.column);
  assert.equal(artifact.sampleLayout.rows.sourcePixelStartIndex, artifact.sourceFrame.sourcePixelWindow.row);
  if (artifact.lod.sourceSampleStride === 1) {
    assert.equal(artifact.representation.kind, 'native-PixelIsArea-raster-view');
    assert.equal(artifact.representation.regularCoverageRaster, true);
  } else {
    assert.equal(artifact.representation.kind, 'phase-locked-selected-sample-lattice-view');
    assert.equal(artifact.representation.regularCoverageRaster, false);
    assert.equal(artifact.representation.consumerRule, 'not a regular coverage raster: rendering, interpolation, resampling, runtime, and manifest consumers are prohibited');
  }
  const bytes = await readFile(path.join(OUTPUT, artifact.file));
  assert.equal(bytes.length, artifact.sampleLayout.byteLength, `${artifact.id} byte length drifted`);
  assert.equal(sha256(bytes), artifact.sha256, `${artifact.id} SHA-256 drifted`);
  let nodataCount = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const value = bytes.readFloatLE(offset);
    if (value === receipt.nodataSemantics.sentinel) {
      assert(bytes.subarray(offset, offset + 4).equals(nodataBytes), `${artifact.id} nodata sentinel bytes drifted`);
      nodataCount += 1;
    } else assert(Number.isFinite(value), `${artifact.id} contains a non-nodata NaN or Infinity`);
  }
  assert.equal(nodataCount, artifact.statistics.nodataCount, `${artifact.id} nodata count drifted`);
  artifactBytes += bytes.length;
}

const rebuilt = await buildFerry3dep2x2ChildPreviewArtifacts({ write: false });
assert(receiptBytes.equals(jsonBytes(rebuilt.receipt)), 'Deterministic child receipt rebuild differs from the checked-in receipt');
for (const artifact of rebuilt.materialized) {
  const checkedIn = await readFile(path.join(OUTPUT, `sf-ferry-3dep-2x2-${artifact.childId}-${artifact.lod.id}-preview-v1.f32le`));
  assert(checkedIn.equals(artifact.bytes), `Deterministic rebuild differs for ${artifact.id}`);
}
process.stdout.write(`${JSON.stringify({ result: 'Ferry 3DEP child engineering-preview artifacts verified', deterministicRebuild: true, artifactCount: receipt.artifacts.length, childArtifactBytes: artifactBytes, lods: receipt.materialization.lodDescriptors.map(({ id }) => id), sharedEdgeProofs: receipt.sharedEdgeProof.length, verticalReference: receipt.verticalReference.values }, null, 2)}\n`);
