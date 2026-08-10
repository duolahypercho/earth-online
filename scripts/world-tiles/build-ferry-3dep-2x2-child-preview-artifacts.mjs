/**
 * Materialize four bounded, offline Ferry 3DEP child preview artifacts from
 * the checked-in parent preview. This never reads source GeoTIFF data and is
 * deliberately not a runtime terrain/tile-manifest builder.
 *
 * Usage: node scripts/world-tiles/build-ferry-3dep-2x2-child-preview-artifacts.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PARENT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-parent-v1');
const PARENT_ARTIFACT = path.join(PARENT_DIR, 'sf-ferry-3dep-2x2-parent-preview-v1.f32le');
const PARENT_RECEIPT = path.join(PARENT_DIR, 'sf-ferry-3dep-2x2-parent-preview-v1.receipt.json');
const SOURCE_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const HORIZONTAL_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json');
const VERTICAL_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-vertical-water-reference-v1.lock.json');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-children-v1');
const RECEIPT_NAME = 'sf-ferry-3dep-2x2-child-preview-artifacts-v1.receipt.json';
const LODS = [
  { id: 'lod0-native', sourceSampleStride: 1, parentPhase: [0, 0], method: 'direct native parent samples' },
  { id: 'lod1-decimate-2', sourceSampleStride: 2, parentPhase: [0, 0], method: 'globally phase-aligned direct parent samples; no interpolation' },
  { id: 'lod2-decimate-4', sourceSampleStride: 4, parentPhase: [0, 0], method: 'globally phase-aligned direct parent samples; no interpolation' },
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const artifactName = (childId, lodId) => `sf-ferry-3dep-2x2-${childId}-${lodId}-preview-v1.f32le`;

function requireParent(parentBytes, parent) {
  assert.equal(parent.status, 'preview-artifact-not-for-runtime-or-manifest-promotion');
  assert.equal(parent.previewOnly, true);
  assert.equal(parent.relationship.runtimePlacement, 'none');
  assert.equal(parent.relationship.manifestPromotion, 'prohibited');
  assert.equal(parent.horizontalReference.targetCrs, 'EPSG:26910');
  assert.equal(parent.horizontalReference.accuracyMetres, 4);
  assert.equal(parent.horizontalReference.subMetreClaim, false);
  assert.equal(parent.raster.sampleEncoding, 'float32-le');
  assert.equal(parent.raster.nodata, -999999, 'Expected locked float32 nodata sentinel');
  assert.equal(parent.verticalDatumUnresolved, true, 'Parent preview must retain its unresolved vertical-reconciliation flag');
  assert.equal(parent.raster.byteLength, parentBytes.length);
  assert.equal(parent.raster.sha256, sha256(parentBytes));
  assert.equal(parent.childViews.length, 4);
}

function sourceIndices(start, count, stride) {
  assert(Number.isInteger(start) && Number.isInteger(count) && Number.isInteger(stride));
  assert(count > 0 && stride > 0);
  const last = start + count - 1;
  const indices = [];
  for (let value = start; value <= last; value += stride) indices.push(value);
  if (indices.at(-1) !== last) indices.push(last);
  return indices;
}

function selectionDescriptor(indices, stride, sourcePixelOrigin) {
  const steps = indices.slice(1).map((value, index) => value - indices[index]);
  return {
    rule: 'start + n * stride, including the final source index when the stride does not land on it',
    parentStartIndex: indices[0], parentEndIndexInclusive: indices.at(-1), sourcePixelStartIndex: sourcePixelOrigin + indices[0], sourcePixelEndIndexInclusive: sourcePixelOrigin + indices.at(-1), sourceSampleStride: stride,
    selectedSampleCount: indices.length, finalSourceStepSamples: steps.at(-1) ?? 0,
    uniformSourceStride: steps.every((step) => step === stride),
  };
}

function extract(parentBytes, parentWidth, columns, rows) {
  const bytes = Buffer.allocUnsafe(columns.length * rows.length * 4);
  let offset = 0;
  for (const row of rows) {
    for (const column of columns) {
      const sourceOffset = (row * parentWidth + column) * 4;
      parentBytes.copy(bytes, offset, sourceOffset, sourceOffset + 4);
      offset += 4;
    }
  }
  return bytes;
}

function statistics(bytes, nodata) {
  let nodataCount = 0; let min = Infinity; let max = -Infinity;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const value = bytes.readFloatLE(offset);
    if (value === nodata) nodataCount += 1;
    else { min = Math.min(min, value); max = Math.max(max, value); }
  }
  assert(Number.isFinite(min) && Number.isFinite(max), 'Child artifact contains no valid elevation samples');
  return { nodataCount, validSampleCount: bytes.length / 4 - nodataCount, minMetres: min, maxMetres: max };
}

function sourceFrame(parent, child) {
  const [scaleX, , tiepointX, , scaleY, tiepointY] = parent.raster.affine.coefficients;
  const parentWindow = parent.raster.nativePixelWindow;
  assert.equal(scaleX, 1, 'Expected native parent easting interval of one metre');
  assert.equal(scaleY, -1, 'Expected native parent northing interval of minus one metre');
  // The affine tiepoint is in the source GeoTIFF pixel frame, whereas child
  // columns/rows are parent-local. Move through the parent native window
  // before calculating the child PixelIsArea edges.
  const x0 = tiepointX + (parentWindow.column + child.column) * scaleX;
  const x1 = tiepointX + (parentWindow.column + child.column + child.width) * scaleX;
  const y0 = tiepointY + (parentWindow.row + child.row) * scaleY;
  const y1 = tiepointY + (parentWindow.row + child.row + child.height) * scaleY;
  return {
    modelCrs: 'EPSG:26910', coordinateOrder: 'easting, northing', sourceRasterType: parent.raster.affine.rasterType,
    parentNativePixelWindow: parent.raster.nativePixelWindow,
    parentSampleWindow: { column: child.column, row: child.row, width: child.width, height: child.height },
    sourcePixelWindow: child.sourcePixelWindow,
    sourceAreaEdgeBoundsMetres: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
    parentAffine: { coefficients: parent.raster.affine.coefficients, eastingIncreasesWithSourceColumn: true, northingDecreasesWithSourceRow: true, sourcePixelCenterFormula: 'easting = tiepointX + (sourceColumn + 0.5) * scaleX; northing = tiepointY + (sourceRow + 0.5) * scaleY', sourceAreaEdgeFormula: 'easting = tiepointX + sourceColumn * scaleX; northing = tiepointY + sourceRow * scaleY' },
    geometryRule: 'bounds are inherited source PixelIsArea edges; source samples represent native pixel centers',
    nativeSourceSampleSpacingMetres: [scaleX, scaleY],
  };
}

function outputRepresentation(lod) {
  if (lod.sourceSampleStride === 1) return {
    kind: 'native-PixelIsArea-raster-view', regularCoverageRaster: true,
    consumerRule: 'offline preview inspection only; runtime and manifest consumers are prohibited',
  };
  return {
    kind: 'phase-locked-selected-sample-lattice-view', regularCoverageRaster: false,
    consumerRule: 'not a regular coverage raster: rendering, interpolation, resampling, runtime, and manifest consumers are prohibited',
  };
}

function edge(bytes, width, height, side) {
  const segments = [];
  for (let index = 0; index < (side === 'west' || side === 'east' ? height : width); index += 1) {
    const column = side === 'east' ? width - 1 : side === 'west' ? 0 : index;
    const row = side === 'south' ? height - 1 : side === 'north' ? 0 : index;
    const offset = (row * width + column) * 4;
    segments.push(bytes.subarray(offset, offset + 4));
  }
  return Buffer.concat(segments);
}

function proveSharedEdges(materialized) {
  const byKey = new Map(materialized.map((artifact) => [`${artifact.childId}/${artifact.lod.id}`, artifact]));
  const proofs = [];
  for (const lod of LODS) {
    const nw = byKey.get(`northwest/${lod.id}`); const ne = byKey.get(`northeast/${lod.id}`);
    const sw = byKey.get(`southwest/${lod.id}`); const se = byKey.get(`southeast/${lod.id}`);
    for (const [id, a, sideA, b, sideB] of [
      ['north-west-east', nw, 'east', ne, 'west'], ['south-west-east', sw, 'east', se, 'west'],
      ['west-north-south', nw, 'south', sw, 'north'], ['east-north-south', ne, 'south', se, 'north'],
    ]) {
      const aBytes = edge(a.bytes, a.width, a.height, sideA);
      const bBytes = edge(b.bytes, b.width, b.height, sideB);
      assert(aBytes.equals(bBytes), `${lod.id}/${id} derived child edge differs`);
      proofs.push({ id: `${lod.id}-${id}`, lodId: lod.id, childArtifacts: [a.id, b.id], sampleCount: aBytes.length / 4, byteCount: aBytes.length, sha256: sha256(aBytes), byteIdentical: true });
    }
  }
  return proofs;
}

export async function buildFerry3dep2x2ChildPreviewArtifacts({ outputDir = DEFAULT_OUTPUT_DIR, write = true } = {}) {
  const [parentBytes, parentReceiptBytes, sourceLockBytes, horizontalLockBytes, verticalLockBytes] = await Promise.all([readFile(PARENT_ARTIFACT), readFile(PARENT_RECEIPT), readFile(SOURCE_LOCK_PATH), readFile(HORIZONTAL_LOCK_PATH), readFile(VERTICAL_LOCK_PATH)]);
  const parent = JSON.parse(parentReceiptBytes);
  const sourceLock = JSON.parse(sourceLockBytes);
  const horizontalLock = JSON.parse(horizontalLockBytes);
  const verticalLock = JSON.parse(verticalLockBytes);
  requireParent(parentBytes, parent);
  assert.equal(parent.source.sourceLockSha256, sha256(sourceLockBytes), 'Parent preview source-lock hash drifted');
  assert.equal(parent.source.lockedRawSha256, sourceLock.raster.sha256, 'Parent preview raw source hash drifted');
  assert.equal(parent.source.sourceBytes, sourceLock.raster.bytes, 'Parent preview raw source byte count drifted');
  assert.equal(parent.horizontalReference.lockSha256, sha256(horizontalLockBytes), 'Parent preview horizontal-lock hash drifted');
  assert.equal(verticalLock.id, 'sf-ferry-3dep-2023-vertical-water-reference-v1', 'Unexpected contextual vertical-reference lock');
  const [parentWidth, parentHeight] = parent.raster.dimensionsPixels;
  assert.equal(parentWidth * parentHeight * 4, parentBytes.length);
  const materialized = [];
  for (const child of parent.childViews) {
    assert.equal(child.parentBuffer.rowStrideSamples, parentWidth);
    for (const lod of LODS) {
      assert.equal(child.column % lod.sourceSampleStride, lod.parentPhase[0], `${child.id}/${lod.id} column start is not globally phase-aligned`);
      assert.equal(child.row % lod.sourceSampleStride, lod.parentPhase[1], `${child.id}/${lod.id} row start is not globally phase-aligned`);
      const columns = sourceIndices(child.column, child.width, lod.sourceSampleStride);
      const rows = sourceIndices(child.row, child.height, lod.sourceSampleStride);
      const bytes = extract(parentBytes, parentWidth, columns, rows);
      materialized.push({
        id: `${child.id}-${lod.id}`, childId: child.id, lod, bytes, width: columns.length, height: rows.length,
        columns, rows, frame: sourceFrame(parent, child),
      });
    }
  }
  const sharedEdges = proveSharedEdges(materialized);
  const receipt = {
    schemaVersion: 1,
    kind: 'earth-terrain-child-view-engineering-preview',
    status: 'preview-artifact-not-for-runtime-or-manifest-promotion',
    id: 'sf-ferry-3dep-2x2-child-preview-artifacts-v1',
    previewOnly: true,
    relationship: { sourceRegionId: parent.relationship.regionId, quadrantViews: 'existing parent-native quadrant views only; not sf-local tiles, 384m cores, 16m buffered source windows, canonical tile IDs, or sf-atlas placement', runtimePlacement: 'none', manifestPromotion: 'prohibited' },
    sourceChain: {
      parentPreview: { receipt: path.relative(ROOT, PARENT_RECEIPT), receiptSha256: sha256(parentReceiptBytes), artifact: path.relative(ROOT, PARENT_ARTIFACT), artifactSha256: parent.raster.sha256 },
      lockedRawGeoTiff: { path: parent.source.rawGeoTiff, sha256: sourceLock.raster.sha256, bytes: sourceLock.raster.bytes },
      sourceLock: { path: path.relative(ROOT, SOURCE_LOCK_PATH), sha256: sha256(sourceLockBytes) },
      horizontalLock: { path: path.relative(ROOT, HORIZONTAL_LOCK_PATH), sha256: sha256(horizontalLockBytes) },
      verticalReferenceLock: { path: path.relative(ROOT, VERTICAL_LOCK_PATH), sha256: sha256(verticalLockBytes), role: 'contextual limitation evidence only; no vertical or tidal transformation is applied' },
    },
    horizontalReference: { targetCrs: 'EPSG:26910', operation: parent.horizontalReference.operation, accuracyMetres: 4, realization: 'not claimed', coordinateEpoch: 'not claimed', subMetreClaim: false },
    verticalReference: { values: 'unconverted source-native elevation samples, declared NAVD88 metres by the locked USGS product metadata', parentVerticalDatumUnresolved: true, unresolvedMeaning: 'the parent has no embedded vertical CRS, geoid, epoch, or local reconciliation; this does not negate the source product metadata NAVD88 declaration', localTidalTransfer: 'not established and prohibited', waterLevel: 'not represented', geoidOrVerticalCrs: 'not resolved beyond the source declaration', contextualLockUse: 'the NOAA station reference lock supplies limitations only and applies no transformation to these samples' },
    nodataSemantics: { sentinel: -999999, encoding: 'float32-le', sourceMeaning: 'locked parent raster nodata sentinel', preservation: 'the exact float32 sentinel bytes are copied unchanged at every LOD; no NaN, Infinity, substitution, averaging, or interpolation is permitted' },
    materialization: { method: 'exact float32-le source-byte copies selected from the checked-in parent artifact', interpolation: 'none', hostEndianIndependent: true, childArtifactsPerLod: 4, lodDescriptors: LODS },
    artifacts: materialized.map((artifact) => ({
      id: artifact.id, childId: artifact.childId, lod: artifact.lod, file: artifactName(artifact.childId, artifact.lod.id),
      representation: outputRepresentation(artifact.lod), sourceFrame: artifact.frame,
      sampleLayout: {
        encoding: 'float32-le', dimensionsPixels: [artifact.width, artifact.height], sampleCount: artifact.width * artifact.height, byteLength: artifact.bytes.length,
        sourceNativeSampleSpacingMetres: [1, 1],
        parentPhase: artifact.lod.parentPhase, phaseAlignment: { parentColumnStartModuloStride: artifact.columns[0] % artifact.lod.sourceSampleStride, parentRowStartModuloStride: artifact.rows[0] % artifact.lod.sourceSampleStride, required: 'both starts and shared child seam indices are phase 0 modulo the LOD stride' },
        columns: selectionDescriptor(artifact.columns, artifact.lod.sourceSampleStride, artifact.frame.parentNativePixelWindow.column), rows: selectionDescriptor(artifact.rows, artifact.lod.sourceSampleStride, artifact.frame.parentNativePixelWindow.row),
      },
      sha256: sha256(artifact.bytes), statistics: statistics(artifact.bytes, parent.raster.nodata),
    })),
    sharedEdgeProof: sharedEdges,
    limitations: [
      'Offline engineering-preview views only; these are existing parent-native quadrants, not sf-local tiles, 384m cores, 16m buffered source windows, canonical tile IDs, or sf-atlas placement. No runtime code, terrain manifest, collision, navmesh, or water representation consumes these files.',
      'The horizontal reference is the generic locked operation to EPSG:26910 with 4 m accuracy; no realization, coordinate epoch, or sub-metre claim is made.',
      'Values remain unconverted source-native samples declared NAVD88 metres by the product metadata. The contextual NOAA station reference lock performs no transformation and does not establish a local Ferry tidal datum or water level.',
      'LOD1 and LOD2 are phase-locked selected sample lattices, not regular PixelIsArea coverage rasters. They must not be rendered, interpolated, resampled, or consumed by runtime or manifests.',
    ],
  };
  if (write) {
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
      ...materialized.map((artifact) => writeFile(path.join(outputDir, artifactName(artifact.childId, artifact.lod.id)), artifact.bytes)),
      writeFile(path.join(outputDir, RECEIPT_NAME), jsonBytes(receipt)),
    ]);
  }
  return { outputDir, receipt, receiptPath: path.join(outputDir, RECEIPT_NAME), materialized };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildFerry3dep2x2ChildPreviewArtifacts();
  process.stdout.write(`${JSON.stringify({ result: 'Ferry 3DEP child engineering-preview artifacts built', artifactCount: result.materialized.length, receipt: path.relative(ROOT, result.receiptPath), childArtifactBytes: result.materialized.reduce((total, artifact) => total + artifact.bytes.length, 0), sharedEdgeProofs: result.receipt.sharedEdgeProof.length }, null, 2)}\n`);
}
