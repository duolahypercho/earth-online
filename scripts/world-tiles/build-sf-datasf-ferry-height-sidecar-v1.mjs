#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const TILE_ID = 'epsg26910-1441-10893';
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-ferry-height-sidecar-v1');
const OUTPUT_PATH = path.join(OUTPUT_ROOT, 'sf-datasf-ferry-height-sidecar-v1.receipt.json');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const MATCH_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-osm-building-match-proof-v1/sf-datasf-osm-building-match-proof-v1.receipt.json');
const DATASF_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-datasf-building-footprints-2023-v1.lock.json');
const HEIGHT_PREVIEW_MANIFEST_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-building-height-preview-v1/sf-datasf-building-height-preview-v1.manifest.json');

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const q = (value) => Number(value.toFixed(6));
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);

async function lockedJson(filePath) {
  const bytes = await readFile(filePath);
  return { bytes, value: JSON.parse(bytes) };
}

export async function buildSfDataSfFerryHeightSidecarV1({ write = true } = {}) {
  const [manifest, matchProof, dataSfLock, heightPreviewManifest] = await Promise.all([
    lockedJson(MANIFEST_PATH), lockedJson(MATCH_PATH), lockedJson(DATASF_LOCK_PATH), lockedJson(HEIGHT_PREVIEW_MANIFEST_PATH),
  ]);
  assert.equal(dataSfLock.value.status, 'preview-source-authorized-not-production');
  assert.equal(dataSfLock.value.source.coordinateReference.vertical.hgt_median_m, 'zonal median height-surface value, metres; the source description does not declare this field as an absolute elevation');
  assert.equal(matchProof.value.kind, 'sf-datasf-osm-building-match-proof-receipt');
  assert.equal(matchProof.value.status, 'preview-comparison-only-not-production');
  assert.notEqual(matchProof.value.productionPromotionAuthorized, true);
  assert.equal(matchProof.value.claims.productionGeometryChanged, false);
  assert.equal(matchProof.value.claims.runtimeChanged, false);
  const ferryMatches = matchProof.value.regions.find(({ id }) => id === 'ferry');
  assert(ferryMatches && ferryMatches.tileId === TILE_ID);
  assert.equal(ferryMatches.matches.length, 11);
  assert.equal(heightPreviewManifest.value.status, 'preview-source-height-comparison-only-not-production');
  const ferryHeightPreview = heightPreviewManifest.value.regions.find(({ id }) => id === 'ferry');
  assert(ferryHeightPreview && ferryHeightPreview.tileId === TILE_ID);
  assert.equal(ferryHeightPreview.counts.matchedBuildings, 11);
  assert.equal(ferryHeightPreview.counts.changedTopVertices, 111);
  const [heightPreviewArtifactBytes, heightPreviewReceipt] = await Promise.all([
    readFile(path.join(ROOT, ferryHeightPreview.artifact.path)),
    lockedJson(path.join(ROOT, ferryHeightPreview.receipt)),
  ]);
  assert.equal(sha256(heightPreviewArtifactBytes), ferryHeightPreview.artifact.sha256);

  const tile = manifest.value.tiles.find(({ id }) => id === TILE_ID);
  assert(tile, `${TILE_ID} is not a production resident`);
  assert.equal(tile.presentation?.mode, 'source-tone-v1');
  assert.equal(tile.presentation.productionWriteEnabled, true);
  assert.equal(tile.presentation.productionPromotionAuthorized, true);
  assert(!JSON.stringify(manifest.value).toLowerCase().includes('datasf'), 'DataSF preview evidence leaked into the production manifest');

  const [glbBytes, metricReceipt, packageDescriptor] = await Promise.all([
    readFile(path.join(ROOT, tile.lod0.path)),
    lockedJson(path.join(ROOT, tile.receipt.path)),
    lockedJson(path.join(ROOT, path.dirname(tile.receipt.path), `${TILE_ID}.package.json`)),
  ]);
  assert.equal(sha256(glbBytes), tile.lod0.sha256);
  assert.equal(sha256(metricReceipt.bytes), tile.receipt.sha256);
  assert.equal(metricReceipt.value.tile.identity, TILE_ID);
  assert.equal(metricReceipt.value.tile.scale, 1);
  assert.equal(metricReceipt.value.status, 'provisional-vertical-unrealized');
  assert.equal(metricReceipt.value.presentation.mode, 'source-tone-v1');
  assert.equal(metricReceipt.value.presentation.productionPromotionAuthorized, true);
  assert.equal(packageDescriptor.value.scale.runtimeUnitsPerMetre, 1);
  assert.equal(packageDescriptor.value.verticalCertification, 'source-declared-navd88-unrealized');

  const authorization = metricReceipt.value.presentation.authorization;
  const authorizationBytes = await readFile(path.join(ROOT, authorization.path));
  assert.equal(sha256(authorizationBytes), authorization.sha256);
  const sourceRecords = new Map(metricReceipt.value.presentation.sourceRecords.map((record) => [record.sourceFeatureId, record]));
  assert.equal(sourceRecords.size, 24);
  const records = ferryMatches.matches.map((match) => {
    const source = sourceRecords.get(match.osmSourceFeatureId);
    assert(source, `${match.osmSourceFeatureId} is absent from the current Ferry source-tone receipt`);
    assert.equal(source.vertexCount % 2, 0, `${match.osmSourceFeatureId} vertex count cannot identify paired top vertices`);
    return {
      osmSourceFeatureId: match.osmSourceFeatureId,
      dataSfBuildingId: match.dataSfBuildingId,
      bboxIou: match.bboxIou,
      centroidDistanceMetres: match.centroidDistanceMetres,
      vertexStart: source.vertexStart,
      vertexCount: source.vertexCount,
      topVerticesIfApplied: source.vertexCount / 2,
      sourceToneV1: source.sourceToneV1,
      sourceTagsSha256: source.sourceTagsSha256,
      currentOsmHeightMetres: match.osmHeightMetres,
      currentOsmHeightPolicy: match.osmHeightPolicy,
      dataSfMedianHeightSurfaceMetres: match.dataSfMedianHeightMetres,
      relativeHeightDeltaMetres: q(match.dataSfMedianHeightMetres - match.osmHeightMetres),
    };
  }).sort((left, right) => left.osmSourceFeatureId.localeCompare(right.osmSourceFeatureId, 'en', { numeric: true }));
  const heightPreviewChanges = new Map(heightPreviewReceipt.value.changes.map((change) => [change.osmSourceFeatureId, change]));
  assert.equal(heightPreviewChanges.size, records.length, 'Ferry height-preview change count differs from the sidecar');
  for (const record of records) {
    const previewChange = heightPreviewChanges.get(record.osmSourceFeatureId);
    assert(previewChange, `${record.osmSourceFeatureId} is absent from the Ferry height-preview receipt`);
    assert.equal(previewChange.dataSfBuildingId, record.dataSfBuildingId, `${record.osmSourceFeatureId} DataSF identity differs from the height preview`);
    assert.equal(previewChange.previousHeightMetres, record.currentOsmHeightMetres, `${record.osmSourceFeatureId} baseline height differs from the height preview`);
    assert.equal(previewChange.dataSfMedianHeightMetres, record.dataSfMedianHeightSurfaceMetres, `${record.osmSourceFeatureId} DataSF height differs from the height preview`);
    assert.equal(previewChange.heightDeltaMetres, record.relativeHeightDeltaMetres, `${record.osmSourceFeatureId} height delta differs from the height preview`);
    assert.equal(previewChange.topVerticesChanged, record.topVerticesIfApplied, `${record.osmSourceFeatureId} top-vertex count differs from the height preview`);
  }
  const deltas = records.map(({ relativeHeightDeltaMetres }) => relativeHeightDeltaMetres).sort((a, b) => a - b);
  const absoluteDeltas = deltas.map(Math.abs).sort((a, b) => a - b);
  assert.equal(records.reduce((sum, record) => sum + record.topVerticesIfApplied, 0), 111);

  const receipt = {
    schemaVersion: 1,
    kind: 'sf-datasf-ferry-height-sidecar-receipt',
    status: 'preview-source-height-sidecar-only-not-production',
    productionWriteEnabled: false,
    productionPromotionAuthorized: false,
    runtimeIntegrationEnabled: false,
    claims: {
      sourceIdentity: false,
      absoluteVerticalPlacement: false,
      verticalDatumReconciled: false,
      current2026BuildingHeights: false,
      relativeMassingComparisonOnly: true,
    },
    tile: {
      id: TILE_ID,
      gridIndex: tile.gridIndex,
      originEpsg26910VerticalMetres: tile.originEpsg26910VerticalMetres,
      horizontalCrs: 'EPSG:26910',
      runtimeUnitsPerMetre: 1,
      verticalCertification: 'source-declared-navd88-unrealized',
    },
    productionReference: {
      manifest: { path: path.relative(ROOT, MANIFEST_PATH), bytes: manifest.bytes.length, sha256: sha256(manifest.bytes), tileCount: manifest.value.tiles.length },
      glb: { path: tile.lod0.path, bytes: glbBytes.length, sha256: sha256(glbBytes) },
      metricReceipt: { path: tile.receipt.path, bytes: metricReceipt.bytes.length, sha256: sha256(metricReceipt.bytes) },
      package: { path: path.relative(ROOT, path.join(ROOT, path.dirname(tile.receipt.path), `${TILE_ID}.package.json`)), bytes: packageDescriptor.bytes.length, sha256: sha256(packageDescriptor.bytes) },
      presentation: {
        mode: metricReceipt.value.presentation.mode,
        authorization,
        contractSha256: tile.presentation.contractSha256,
        geometryLedgerSha256: metricReceipt.value.presentation.geometryLedgerSha256,
        sourceRecordsSha256: metricReceipt.value.presentation.ledgers.sourceRecordsSha256,
        sourceToneAttributeSha256: metricReceipt.value.presentation.ledgers.sourceToneAttributeSha256,
      },
    },
    sources: {
      dataSfLock: { path: path.relative(ROOT, DATASF_LOCK_PATH), bytes: dataSfLock.bytes.length, sha256: sha256(dataSfLock.bytes), id: dataSfLock.value.id, status: dataSfLock.value.status },
      rawSnapshot: dataSfLock.value.source.snapshot,
      methodologySnapshot: dataSfLock.value.source.methodologySnapshot,
      matchProof: { path: path.relative(ROOT, MATCH_PATH), bytes: matchProof.bytes.length, sha256: sha256(matchProof.bytes), associationPolicy: matchProof.value.associationPolicy },
      field: { id: 'hgt_median_m', semantics: dataSfLock.value.source.coordinateReference.vertical.hgt_median_m },
      offlineRebuildQualification: { checkedInEvidenceVerifiableWithoutRawSnapshot: true, fullSourceRebuildRequiresLockedRawCsvAndMethodology: true, rawCsvPath: dataSfLock.value.source.snapshot.localPath },
    },
    comparisonPreview: {
      status: heightPreviewManifest.value.status,
      productionPromotionAuthorized: false,
      manifest: { path: path.relative(ROOT, HEIGHT_PREVIEW_MANIFEST_PATH), bytes: heightPreviewManifest.bytes.length, sha256: sha256(heightPreviewManifest.bytes) },
      artifact: { ...ferryHeightPreview.artifact, bytes: heightPreviewArtifactBytes.length },
      receipt: { path: ferryHeightPreview.receipt, bytes: heightPreviewReceipt.bytes.length, sha256: sha256(heightPreviewReceipt.bytes) },
      horizontalGeometryPolicy: heightPreviewReceipt.value.policy.horizontalGeometry,
      bottomVertexPolicy: heightPreviewReceipt.value.policy.bottomVertices,
      unmatchedBuildingPolicy: heightPreviewReceipt.value.policy.unmatchedBuildings,
      verifier: 'scripts/world-tiles/verify-sf-datasf-building-height-preview-v1.mjs',
    },
    coverage: { productionSourceBuildings: sourceRecords.size, highConfidenceMatches: records.length, unmatchedSourceBuildings: sourceRecords.size - records.length, topVerticesIfApplied: records.reduce((sum, record) => sum + record.topVerticesIfApplied, 0) },
    deltaSummaryMetres: { min: deltas[0], median: deltas[Math.floor(deltas.length / 2)], max: deltas.at(-1), absoluteMedian: absoluteDeltas[Math.floor(absoluteDeltas.length / 2)] },
    invariants: {
      productionArtifactUnmodified: true,
      productionManifestUnmodified: true,
      productionReceiptAndPackageUnmodified: true,
      sourceTonePresentationBound: true,
      everyMatchMapsToCurrentSourceRecord: true,
      everyRecordMatchesHeightPreview: true,
      horizontalCoordinatesUnchanged: true,
      bottomVerticesUnchanged: true,
      triangleIndicesUnchanged: true,
      unmatchedBuildingsUnchanged: true,
    },
    records,
    recordsSha256: sha256(jsonBytes(records)),
  };
  const bytes = jsonBytes(receipt);
  if (write) {
    await mkdir(OUTPUT_ROOT, { recursive: true });
    await writeFile(OUTPUT_PATH, bytes);
  }
  return { receipt, bytes, outputPath: OUTPUT_PATH };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildSfDataSfFerryHeightSidecarV1();
  process.stdout.write(`${JSON.stringify({ result: 'SF DataSF Ferry height sidecar built', path: path.relative(ROOT, result.outputPath), bytes: result.bytes.length, sha256: sha256(result.bytes), records: result.receipt.records.length, productionPromotionAuthorized: false }, null, 2)}\n`);
}
