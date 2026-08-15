#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDataSfBuildingFootprintExtracts } from './build-sf-datasf-building-footprint-extract-v1.mjs';

const ROOT = process.cwd();
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-datasf-building-footprints-2023-v1.lock.json');
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-building-footprints-v1');
const MANIFEST_PATH = path.join(OUTPUT_ROOT, 'sf-datasf-building-footprints-v1.manifest.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sourcePathFromArguments() {
  const index = process.argv.indexOf('--source');
  if (index >= 0) {
    assert(process.argv[index + 1], '--source requires a literal CSV path');
    return path.resolve(process.argv[index + 1]);
  }
  return process.env.SF_DATASF_BUILDING_FOOTPRINTS_CSV ? path.resolve(process.env.SF_DATASF_BUILDING_FOOTPRINTS_CSV) : null;
}

function intersects(left, right) {
  return !(left[2] < right[0] || left[0] > right[2] || left[3] < right[1] || left[1] > right[3]);
}

const [lockBytes, manifestBytes] = await Promise.all([readFile(LOCK_PATH), readFile(MANIFEST_PATH)]);
const lock = JSON.parse(lockBytes); const manifest = JSON.parse(manifestBytes);
assert.equal(lock.kind, 'earth-building-geometry-height-source-lock');
assert.equal(lock.status, 'preview-source-authorized-not-production');
assert.equal(lock.source.snapshot.bytes, 178760486);
assert.equal(lock.source.snapshot.sha256, '7128b9d3d0f350cde3d2f6571ad791beacd71f5d581f6fde6fc7811529ff22d2');
assert.equal(lock.source.snapshot.rowsExcludingHeader, 177023);
assert.equal(lock.source.snapshot.columns, 45);
assert.equal(lock.source.coordinateReference.vertical.gnd_min_m.includes('NAVD 1988'), true);
assert.equal(lock.source.coordinateReference.vertical.hgt_median_m.includes('does not declare this field as an absolute elevation'), true);
assert(lock.approvedScope.prohibited.includes('claiming facade materials, windows, doors, floor plans, occupancy, or current building use'));
assert(lock.approvedScope.prohibited.includes('combining NAVD 1988 absolute elevations with current production terrain before vertical reconciliation is implemented and verified'));

assert.equal(manifest.kind, 'sf-datasf-building-footprint-extract-manifest');
assert.equal(manifest.status, 'preview-source-evidence-only-not-production');
assert.deepEqual(manifest.source, { id: lock.id, bytes: 178760486, sha256: `sha256:${lock.source.snapshot.sha256}`, rows: 177023, columns: 45 });
assert.deepEqual(manifest.claims, {
  horizontalFootprints: 'source WKT only',
  heightFields: 'source fields retained verbatim',
  productionGeometryChanged: false,
  runtimeChanged: false,
  gameplayChanged: false,
  facadeSemanticsSupplied: false,
  verticalReconciliationComplete: false,
});
assert.equal(manifest.extracts.length, 2);

const expected = new Map([
  ['ferry', { tileId: 'epsg26910-1441-10893', features: 21, p2010Heights: 21, bounds: [-122.39412884053405, 37.79199340457852, -122.38973919965629, 37.795476793828165] }],
  ['district', { tileId: 'epsg26910-1430-10882', features: 419, p2010Heights: 0, bounds: [-122.44238805620932, 37.75416199101486, -122.43800288641724, 37.75764362832815] }],
]);
const verified = []; const seenExtractIds = new Set();
for (const descriptor of manifest.extracts) {
  const expectation = expected.get(descriptor.id); assert(expectation, `Unexpected extract ${descriptor.id}`);
  assert(!seenExtractIds.has(descriptor.id), `Duplicate extract descriptor ${descriptor.id}`); seenExtractIds.add(descriptor.id);
  assert.equal(descriptor.tileId, expectation.tileId); assert.equal(descriptor.features, expectation.features);
  const bytes = await readFile(path.join(ROOT, descriptor.path));
  assert.equal(bytes.length, descriptor.bytes, `${descriptor.id} byte count mismatch`);
  assert.equal(`sha256:${sha256(bytes)}`, descriptor.sha256, `${descriptor.id} SHA-256 mismatch`);
  const extract = JSON.parse(bytes);
  assert.equal(extract.kind, 'sf-datasf-building-footprint-extract');
  assert.equal(extract.status, 'preview-source-evidence-only-not-production');
  assert.equal(extract.sourceLock.id, lock.id); assert.equal(extract.sourceLock.sha256, `sha256:${sha256(lockBytes)}`);
  assert.equal(extract.region.tileId, expectation.tileId); assert.equal(extract.region.horizontalCrs, 'EPSG:26910'); assert.equal(extract.region.unitsPerMetre, 1);
  assert.deepEqual(extract.region.selectionBoundsWgs84, expectation.bounds);
  assert.equal(extract.features.length, expectation.features); assert.equal(extract.summary.features, expectation.features);
  assert.equal(extract.summary.completeness.hgt_median_m, expectation.features);
  assert.equal(extract.summary.completeness.gnd_min_m, expectation.features);
  assert.equal(extract.summary.completeness.median_1st_m, expectation.features);
  assert.equal(extract.summary.completeness.gnd1st_delta, expectation.features);
  assert.equal(extract.summary.completeness.peak_1st_m, expectation.features);
  assert.equal(extract.summary.completeness.p2010_zminn88ft, expectation.p2010Heights);
  assert.equal(extract.summary.completeness.p2010_zmaxn88ft, expectation.p2010Heights);
  assert(extract.prohibitedClaims.includes('facade-material')); assert(extract.prohibitedClaims.includes('window-inventory')); assert(extract.prohibitedClaims.includes('production-runtime-promotion'));
  const identities = new Set(); let previous = '';
  for (const feature of extract.features) {
    const source = feature.source;
    assert(source.sf16_bldgid && source.globalid && source.mblr && source.shape, `${descriptor.id} source identity is incomplete`);
    assert.match(source.shape, /^MULTIPOLYGON\s*\(\(/); assert.equal(source.data_as_of, '2023/09/11 12:00:00 PM'); assert.equal(source.data_loaded_at, '2026/08/14 10:21:32 AM');
    assert(!identities.has(source.sf16_bldgid), `${descriptor.id} duplicate building ID ${source.sf16_bldgid}`); identities.add(source.sf16_bldgid);
    assert(previous <= source.sf16_bldgid, `${descriptor.id} features are not deterministically sorted`); previous = source.sf16_bldgid;
    assert.equal(feature.wgs84Bounds.length, 4); assert(intersects(feature.wgs84Bounds, expectation.bounds), `${descriptor.id} feature does not intersect the selection bounds`);
    for (const field of ['gnd_min_m', 'median_1st_m', 'hgt_median_m', 'gnd1st_delta', 'peak_1st_m']) assert(Number.isFinite(Number(source[field])), `${source.sf16_bldgid} ${field} is not finite`);
  }
  verified.push({ id: descriptor.id, tileId: descriptor.tileId, features: descriptor.features, bytes: descriptor.bytes, sha256: descriptor.sha256, sourceIdentityUnique: true, sorted: true, fieldLevelVerticalProvenance: true });
}
assert.equal(expected.size, verified.length); assert.deepEqual(seenExtractIds, new Set(expected.keys()));

const sourcePath = sourcePathFromArguments();
let deterministicRebuild = null;
if (sourcePath) {
  const first = await buildDataSfBuildingFootprintExtracts({ sourcePath, write: false });
  const second = await buildDataSfBuildingFootprintExtracts({ sourcePath, write: false });
  assert(first.manifestBytes.equals(second.manifestBytes), 'DataSF extract manifest is not deterministic across two builds');
  assert(first.manifestBytes.equals(manifestBytes), 'DataSF checked-in extract manifest differs from a source rebuild');
  for (let index = 0; index < first.outputs.length; index += 1) {
    assert(first.outputs[index].extractBytes.equals(second.outputs[index].extractBytes), `${first.outputs[index].id} source rebuild is not deterministic`);
    assert.equal(first.outputs[index].sha256, manifest.extracts[index].sha256, `${first.outputs[index].id} source rebuild hash differs from checked-in evidence`);
  }
  deterministicRebuild = { sourcePath, twoBuildBytesExact: true, checkedInBytesExact: true };
}

process.stdout.write(`${JSON.stringify({ result: 'SF DataSF building footprint extracts passed', status: manifest.status, source: manifest.source, verified, deterministicRebuild }, null, 2)}\n`);
