/** Verify the deterministic, offline-only Ferry runtime-versus-3DEP diagnostic. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { bilinear3dep, buildSfFerryRuntimeVs3depOfflineDelta, decodeFloat32LittleEndian, runtimeElevationAt } from './build-sf-ferry-runtime-vs-3dep-offline-delta-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ID = 'sf-ferry-runtime-vs-3dep-offline-delta-v1';
const OUTPUT = path.join(ROOT, 'public/data/world/preview-artifacts', ID);
const jsonPath = path.join(OUTPUT, `${ID}.json`);
const csvPath = path.join(OUTPUT, `${ID}.csv`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const [artifactBytes, csvBytes] = await Promise.all([readFile(jsonPath), readFile(csvPath)]);
const artifact = JSON.parse(artifactBytes);
assert.equal(artifact.id, ID);
assert.equal(artifact.status, 'offline-diagnostic-not-for-runtime-manifest-rendering-water-collision-or-navigation');
assert.equal(artifact.scope.decision, 'diagnostic-only; no height is changed or approved by this artifact');
for (const key of ['offline', 'runtime', 'manifest', 'rendering', 'water', 'collision', 'navigation']) assert.equal(artifact.scope[key], key === 'offline' ? true : 'not-used');
assert.equal(artifact.runtimeSampler.loadedAsset.cellSizeMetres, 24.89480564597168);
assert.match(artifact.runtimeSampler.sourceConstruction, /3x3/);
assert.match(artifact.runtimeSampler.sourceConstruction, /0.1 m/);
assert.match(artifact.runtimeSampler.falsyAndOutOfBounds, /grid\[index\] \|\| 0/);
assert.match(artifact.runtimeSampler.phaseAmbiguity, /half-cell/);
assert.match(artifact.runtimeSampler.elevationBuilderLandPredicate, /boundary\[0\]/);
assert.equal(artifact.threeDepSampler.nodata, -999999);
assert.deepEqual(artifact.threeDepSampler.nativeNeighbourTupleOrder, ['parentLocalColumn', 'parentLocalRow', 'nativeColumn', 'nativeRow', 'valueMetres-or-null', 'elevationBuilderBoundary0LandAtPixelCentre']);
assert.equal(artifact.threeDepSampler.horizontalBridge.includes('4 m'), true);
assert.equal(artifact.leastSquaresDescriptiveOnly.aggregate, null);
assert.equal(artifact.leastSquaresDescriptiveOnly.named, null);
for (const fit of [artifact.leastSquaresDescriptiveOnly.canonical24m2x2, artifact.leastSquaresDescriptiveOnly.hero16m]) {
  assert.equal(fit.kind, 'leastSquaresDescriptiveOnly');
  assert.equal(fit.appliedToRuntimeHeights, false);
  assert.equal(fit.appliedTo3depHeights, false);
  assert.equal(fit.verticalConversion, false);
  assert.equal(fit.terrainAdjustment, false);
}
assert.match(artifact.leastSquaresDescriptiveOnly.note, /double-weight/);
assert.equal(artifact.records.length, 1725);
assert.equal(artifact.records.filter((record) => record.sampleSet === 'named').length, 11);
assert.equal(artifact.records.filter((record) => record.sampleSet === 'canonical-24m-2x2').length, 1089);
assert.equal(artifact.records.filter((record) => record.sampleSet === 'hero-16m').length, 625);
assert.deepEqual(Object.keys(artifact.summaries.bySampleSet), ['named', 'canonical-24m-2x2', 'hero-16m'], 'summary grid grouping drifted');
for (const [sampleSet, expectedCount] of Object.entries({ named: 11, 'canonical-24m-2x2': 1089, 'hero-16m': 625 })) {
  const summaries = artifact.summaries.bySampleSet[sampleSet];
  assert.equal(summaries.elevationBuilderBoundary0QueryPointLand.recordCount + summaries.elevationBuilderBoundary0WaterOrOutsideQueryPoint.recordCount, expectedCount, `${sampleSet}: query-point masks must partition the grid`);
}
assert.equal(artifact.summaries.aggregate.elevationBuilderBoundary0QueryPointLand.recordCount + artifact.summaries.aggregate.elevationBuilderBoundary0WaterOrOutsideQueryPoint.recordCount, artifact.records.length, 'aggregate query-point masks must partition records');
const sourceLock = JSON.parse(await readFile(path.join(ROOT, artifact.inputs.sourceLock.path)));
const parentReceipt = JSON.parse(await readFile(path.join(ROOT, artifact.inputs.parentReceipt.path)));
assert.equal(parentReceipt.source.actualRawSha256, parentReceipt.source.lockedRawSha256, 'parent receipt must preserve its actual raw hash verification');
assert.equal(parentReceipt.source.actualRawSha256, sourceLock.raster.sha256, 'parent receipt actual raw hash must chain to source lock');
assert.equal(parentReceipt.source.sourceBytes, sourceLock.raster.bytes, 'parent receipt raw bytes must chain to source lock');
assert.equal(parentReceipt.source.rawHashBytesRead, sourceLock.raster.bytes, 'parent receipt raw hash must have read the locked byte count');
assert.equal(parentReceipt.source.rawFileSizeChecked, true, 'parent receipt must have checked raw file size');
assert.equal(parentReceipt.source.rawHashVerifiedBeforeWindowRead, true, 'parent receipt must have verified raw hash before window read');
assert.equal(parentReceipt.raster.sampleEncoding, 'float32-le', 'parent receipt byte order drifted');
assert.equal(parentReceipt.raster.affine.rasterType, 'PixelIsArea', 'parent receipt raster type drifted');
assert.equal(parentReceipt.raster.byteLength, parentReceipt.raster.sampleCount * 4, 'parent receipt f32 byte count drifted');
for (const [key, input] of Object.entries(artifact.inputs)) {
  const bytes = await readFile(path.join(ROOT, input.path));
  assert.equal(bytes.length, input.byteLength, `${key}: input length changed`);
  assert.equal(sha256(bytes), input.sha256, `${key}: input SHA-256 changed`);
}
assert(Buffer.from(gunzipSync(await readFile(path.join(ROOT, artifact.inputs.elevationGzip.path)))).equals(await readFile(path.join(ROOT, artifact.inputs.elevation.path))), 'elevation gzip must decompress byte-identically to raw JSON');
assert(Buffer.from(gunzipSync(await readFile(path.join(ROOT, artifact.inputs.cityGzip.path)))).equals(await readFile(path.join(ROOT, artifact.inputs.city.path))), 'city gzip must decompress byte-identically to raw JSON');
for (const record of artifact.records) {
  assert(Number.isFinite(record.xMetres) && Number.isFinite(record.zMetres), `${record.id}: local coordinates must be finite`);
  assert(Number.isFinite(record.eastingMetres) && Number.isFinite(record.northingMetres), `${record.id}: pointwise bridge failed`);
  assert(['land', 'water-or-outside'].includes(record.elevationBuilderBoundary0LandMask), `${record.id}: bad elevation-builder query-point boundary classification`);
  assert.equal(record.elevationBuilderBoundary0LandMask === 'land', record.elevationBuilderBoundary0QueryPointLand, `${record.id}: query-point boundary shorthand drifted`);
  assert.equal(typeof record.elevationBuilderBoundary0AllFour3depNeighbourCentersLand, 'boolean', `${record.id}: missing strict four-neighbour boundary classification`);
  if (record.threeDepEligible) {
    assert.equal(record.threeDepReason, 'four-finite-non-nodata-pixelisarea-neighbours', `${record.id}: unexpected valid sampler claim`);
    assert(Number.isFinite(record.threeDepInspectedHeightMetres), `${record.id}: valid 3DEP sample missing height`);
    assert(Number.isFinite(record.rawRuntimeMinus3depMetres), `${record.id}: valid 3DEP sample missing raw delta`);
    assert.equal(record.threeDepNativePixelIsAreaNeighbors.length, 4, `${record.id}: bilinear sample lacks four neighbours`);
    for (const neighbour of record.threeDepNativePixelIsAreaNeighbors) {
      assert(Array.isArray(neighbour) && neighbour.length === 6, `${record.id}: native-neighbour tuple malformed`);
      assert(Number.isFinite(neighbour[4]) && neighbour[4] !== artifact.threeDepSampler.nodata, `${record.id}: invalid neighbour promoted to bilinear`);
      assert.equal(typeof neighbour[5], 'boolean', `${record.id}: neighbour elevation-builder boundary classification missing`);
    }
    assert.equal(record.elevationBuilderBoundary0AllFour3depNeighbourCentersLand, record.threeDepNativePixelIsAreaNeighbors.every((neighbour) => neighbour[5]), `${record.id}: strict boundary classification drifted`);
  } else {
    assert.equal(record.threeDepInspectedHeightMetres, null, `${record.id}: unavailable 3DEP must not carry height`);
    assert.equal(record.rawRuntimeMinus3depMetres, null, `${record.id}: unavailable 3DEP must not carry delta`);
  }
}
assert.equal(runtimeElevationAt(null, 1, 1), 0, 'missing terrain branch drifted');
assert.deepEqual(Array.from(decodeFloat32LittleEndian(Buffer.from('0000803f000020c0', 'hex'))), [1, -2.5], 'f32le decoder must not rely on host endian');
assert.equal(runtimeElevationAt({ originX: 0, originZ: 0, cellSize: 1, width: 2, height: 2, grid: [0, NaN, -2, 4] }, 0, 0), 0, 'falsy zero must remain zero');
assert.equal(runtimeElevationAt({ originX: 0, originZ: 0, cellSize: 1, width: 2, height: 2, grid: [0, NaN, -2, 4] }, 1, 0), 0, 'falsy NaN must become zero');
assert.equal(runtimeElevationAt({ originX: 0, originZ: 0, cellSize: 1, width: 1, height: 1, grid: [4] }, 0.5, 0), 2, 'OOB neighbour must blend with zero rather than clamp');
const adversarialReceipt = { raster: { dimensionsPixels: [2, 2], nativePixelWindow: { column: 0, row: 0 }, nodata: -999999, affine: { coefficients: [1, 0, 0, 0, -1, 2] } } };
assert.equal(bilinear3dep(Float32Array.from([1, -999999, 3, 4]), adversarialReceipt, 0.75, 1.25).eligible, false, '3DEP nodata neighbour must never be bilinearly promoted');
assert.equal(bilinear3dep(Float32Array.from([1, NaN, 3, 4]), adversarialReceipt, 0.75, 1.25).eligible, false, 'non-finite 3DEP neighbour must never be bilinearly promoted');
const named = Object.fromEntries(artifact.records.filter((record) => record.sampleSet === 'named').map((record) => [record.id, record]));
for (const id of ['hero-launch', 'ferry-clock-tower', 'ferry-building-centroid', 'hero-streetscape-road-26769726-midpoint', 'hero-streetscape-road-88463826-midpoint', 'shoreline-land-probe', 'bay-water-probe']) assert(named[id], `required named diagnostic point missing: ${id}`);
assert.deepEqual(artifact.sampleSets.named.selection.building, { collection: 'sf-city.detailBuildings', id: 558731934, field: 'centroid', expectedName: 'San Francisco Ferry Building' });
assert.deepEqual(artifact.sampleSets.named.selection.roads.ids, [26769726, 88463826, 88463827, 88463831, 283512618, 850162147]);
assert.equal(artifact.sampleSets.named.selection.roads.sourcePath, 'src/realmap/hero-streetscape.js');
assert.deepEqual(artifact.sampleSets.named.selection.probes, { verifierPath: 'scripts/verify-hero-shoreline.mjs', shorelineClassifierPath: 'src/realmap/hero-shoreline.js', points: ['verify-hero-shoreline:2380,1880', 'verify-hero-shoreline:2400,1880'] });
assert.equal(named['ferry-building-centroid'].namedSource.id, 558731934);
assert.equal(named['hero-streetscape-road-26769726-midpoint'].namedSource.name, 'Ferry Plaza');
assert.equal(named['hero-streetscape-road-88463826-midpoint'].namedSource.name, 'The Embarcadero');
const rebuilt = await buildSfFerryRuntimeVs3depOfflineDelta({ write: false });
assert(artifactBytes.equals(jsonBytes(rebuilt.artifact)), 'deterministic JSON rebuild differs');
assert(csvBytes.equals(rebuilt.csvBytes), 'deterministic CSV rebuild differs');
process.stdout.write(`${JSON.stringify({ result: 'offline Ferry runtime-vs-3DEP delta diagnostic verified', id: artifact.id, jsonSha256: sha256(artifactBytes), csvSha256: sha256(csvBytes), records: artifact.records.length, valid3dep: artifact.summaries.aggregate.elevationBuilderBoundary0QueryPointLand.inspected3depCount + artifact.summaries.aggregate.elevationBuilderBoundary0WaterOrOutsideQueryPoint.inspected3depCount, nodataOrOutsideParent: artifact.summaries.aggregate.nodataOrOutsideParent.recordCount, deterministicRebuild: true }, null, 2)}\n`);
