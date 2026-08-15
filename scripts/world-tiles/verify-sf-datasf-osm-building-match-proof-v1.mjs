#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDataSfOsmBuildingMatchProof } from './build-sf-datasf-osm-building-match-proof-v1.mjs';

const ROOT = process.cwd();
const RECEIPT_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-osm-building-match-proof-v1/sf-datasf-osm-building-match-proof-v1.receipt.json');
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const [receiptBytes, productionManifestBytes] = await Promise.all([readFile(RECEIPT_PATH), readFile(PRODUCTION_MANIFEST_PATH)]); const receipt = JSON.parse(receiptBytes);

assert.equal(receipt.kind, 'sf-datasf-osm-building-match-proof-receipt');
assert.equal(receipt.status, 'preview-comparison-only-not-production');
assert.equal(receipt.horizontalOperation.accuracyFloorMetres, 4); assert.equal(receipt.horizontalOperation.realization, 'not-claimed'); assert.equal(receipt.horizontalOperation.coordinateEpoch, 'not-claimed');
assert.deepEqual(receipt.associationPolicy, {
  geometry: 'axis-aligned EPSG:26910 bounding boxes of exact source footprint coordinates',
  minimumBboxIou: 0.8,
  maximumCentroidDistanceMetres: 4,
  assignment: 'deterministic greedy one-to-one by descending IoU, ascending centroid distance, then lexical source IDs',
  identityClaim: false,
});
assert.equal(receipt.heightComparison.use, 'report-only source disagreement diagnostic'); assert.equal(receipt.heightComparison.absoluteElevationComparison, false); assert.equal(receipt.heightComparison.verticalReconciliationComplete, false);
assert.deepEqual(receipt.claims, { productionGeometryChanged: false, runtimeChanged: false, gameplayChanged: false, facadeSemanticsSupplied: false, unmatchedBuildingsRejectedFromComparison: true, highConfidenceAssociationIsNotIdentity: true });
assert(!productionManifestBytes.includes(Buffer.from('sf-datasf-building-footprints')), 'DataSF preview evidence leaked into the production manifest');
assert(!productionManifestBytes.includes(Buffer.from('sf-datasf-osm-building-match-proof')), 'DataSF/OSM comparison proof leaked into the production manifest');

const horizontalLockBytes = await readFile(path.join(ROOT, receipt.horizontalOperation.sourceLock));
assert.equal(`sha256:${sha256(horizontalLockBytes)}`, receipt.horizontalOperation.sha256, 'Horizontal lock bytes drifted');
const expected = new Map([
  ['ferry', { tileId: 'epsg26910-1441-10893', osm: 24, dataSf: 21, candidates: 11, matches: 11, rate: 45.8, medianIou: 0.89505627, medianDistance: 1.679694, medianAbsHeight: 4.42, p90AbsHeight: 7.9, maxAbsHeight: 10.04, heightPolicies: { 'deterministic-9.6m-fallback': 4, 'osm-building-levels-times-3.2m': 7 } }],
  ['district', { tileId: 'epsg26910-1430-10882', osm: 390, dataSf: 419, candidates: 297, matches: 297, rate: 76.2, medianIou: 0.916626545, medianDistance: 0.396019, medianAbsHeight: 0.24, p90AbsHeight: 0.46, maxAbsHeight: 4.02, heightPolicies: { 'deterministic-9.6m-fallback': 296, 'osm-building-levels-times-3.2m': 1 } }],
]);
assert.equal(receipt.regions.length, expected.size); const seenRegions = new Set(); const verified = [];
for (const region of receipt.regions) {
  const expectation = expected.get(region.id); assert(expectation, `Unexpected region ${region.id}`); assert(!seenRegions.has(region.id), `Duplicate region ${region.id}`); seenRegions.add(region.id);
  assert.equal(region.tileId, expectation.tileId);
  assert.deepEqual(region.counts, { osmBuildings: expectation.osm, dataSfBuildings: expectation.dataSf, eligibleCandidatePairs: expectation.candidates, oneToOneMatches: expectation.matches });
  assert.equal(region.summary.matchRateAgainstOsmPct, expectation.rate); assert.equal(region.summary.bboxIouMedian, expectation.medianIou); assert.equal(region.summary.centroidDistanceMedianMetres, expectation.medianDistance);
  assert.equal(region.summary.absoluteHeightDifferenceMedianMetres, expectation.medianAbsHeight); assert.equal(region.summary.absoluteHeightDifferenceP90Metres, expectation.p90AbsHeight); assert.equal(region.summary.absoluteHeightDifferenceMaxMetres, expectation.maxAbsHeight);
  assert.deepEqual(region.summary.matchedOsmHeightPolicyCounts, expectation.heightPolicies); assert.match(region.summary.independenceQualification, /not an independent validation/);
  for (const input of Object.values(region.inputs)) {
    const bytes = await readFile(path.join(ROOT, input.path)); assert.equal(bytes.length, input.bytes, `${region.id} input byte count drifted`); assert.equal(`sha256:${sha256(bytes)}`, input.sha256, `${region.id} input hash drifted`);
  }
  const osmIds = new Set(); const dataSfIds = new Set(); let previousOsm = '';
  for (const match of region.matches) {
    assert(match.bboxIou >= receipt.associationPolicy.minimumBboxIou, `${region.id} match falls below IoU gate`); assert(match.centroidDistanceMetres <= receipt.associationPolicy.maximumCentroidDistanceMetres, `${region.id} match exceeds centroid gate`);
    assert(!osmIds.has(match.osmSourceFeatureId), `${region.id} OSM source is matched twice`); osmIds.add(match.osmSourceFeatureId);
    assert(!dataSfIds.has(match.dataSfBuildingId), `${region.id} DataSF source is matched twice`); dataSfIds.add(match.dataSfBuildingId);
    assert(previousOsm <= match.osmSourceFeatureId, `${region.id} match order drifted`); previousOsm = match.osmSourceFeatureId;
    assert.equal(match.absoluteHeightDifferenceMetres, Math.abs(match.osmMinusDataSfMedianHeightMetres)); assert(['osm-height', 'osm-building-levels-times-3.2m', 'deterministic-9.6m-fallback'].includes(match.osmHeightPolicy));
  }
  assert.equal(osmIds.size, expectation.matches); assert.equal(dataSfIds.size, expectation.matches);
  if (region.id === 'ferry') assert(!osmIds.has('way/32862406'), 'The known 68.05 m weak Ferry false match was not rejected');
  verified.push({ id: region.id, tileId: region.tileId, oneToOneMatches: expectation.matches, matchRateAgainstOsmPct: expectation.rate, sourceHashesVerified: true, weakAssociationsRejected: true, heightComparisonQualified: true });
}
assert.deepEqual(seenRegions, new Set(expected.keys()));

const first = await buildDataSfOsmBuildingMatchProof({ write: false }); const second = await buildDataSfOsmBuildingMatchProof({ write: false });
assert(first.bytes.equals(second.bytes), 'OSM/DataSF match proof is not byte deterministic across two builds'); assert(first.bytes.equals(receiptBytes), 'Checked-in OSM/DataSF match proof differs from deterministic rebuild');

process.stdout.write(`${JSON.stringify({ result: 'SF DataSF/OSM building match proof passed', status: receipt.status, receipt: { path: path.relative(ROOT, RECEIPT_PATH), bytes: receiptBytes.length, sha256: `sha256:${sha256(receiptBytes)}` }, verified, deterministicRebuild: { twoBuildBytesExact: true, checkedInBytesExact: true }, promotionAuthorized: false }, null, 2)}\n`);
