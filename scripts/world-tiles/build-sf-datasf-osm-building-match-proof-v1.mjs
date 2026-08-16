#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSfMetricSharedInputs } from './build-ferry-production-tile-v1.mjs';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-osm-building-match-proof-v1');
const OUTPUT_PATH = path.join(OUTPUT_ROOT, 'sf-datasf-osm-building-match-proof-v1.receipt.json');
const HORIZONTAL_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json');
const REGIONS = Object.freeze([
  { id: 'ferry', tileId: 'epsg26910-1441-10893', origin: [553344, 4182912] },
  { id: 'district', tileId: 'epsg26910-1430-10882', origin: [549120, 4178688] },
]);
const MIN_BBOX_IOU = 0.8;
const MAX_CENTROID_DISTANCE_METRES = 4;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

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

function accessorFloat32(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex]; const view = glb.json.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType, 5126, 'Expected float32 accessor'); assert.equal(accessor.type, 'VEC3', 'Expected VEC3 accessor');
  const stride = view.byteStride ?? 12; const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const values = [];
  for (let item = 0; item < accessor.count; item += 1) for (let axis = 0; axis < 3; axis += 1) values.push(glb.bin.readFloatLE(start + item * stride + axis * 4));
  return values;
}

function makeForwardProjection(lock) {
  const projection = lock.claims.operation.authorityPath[1]; const parameters = projection.parameters; const ellipsoid = projection.ellipsoidFromEpsg4269;
  assert.deepEqual(parameters, { latitudeOfNaturalOriginDegrees: 0, longitudeOfNaturalOriginDegrees: -123, scaleFactor: 0.9996, falseEastingMetres: 500000, falseNorthingMetres: 0 });
  assert.deepEqual(ellipsoid, { semiMajorAxisMetres: 6378137, inverseFlattening: 298.257222101 });
  const a = ellipsoid.semiMajorAxisMetres; const f = 1 / ellipsoid.inverseFlattening; const e2 = f * (2 - f); const ep2 = e2 / (1 - e2);
  const k0 = parameters.scaleFactor; const lon0 = parameters.longitudeOfNaturalOriginDegrees * Math.PI / 180; const degree = Math.PI / 180;
  const meridionalArc = (latitude) => a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * latitude
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * latitude)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * latitude)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * latitude));
  return (longitudeDegrees, latitudeDegrees) => {
    const phi = latitudeDegrees * degree; const sinPhi = Math.sin(phi); const cosPhi = Math.cos(phi); const tanPhi = Math.tan(phi);
    const n = a / Math.sqrt(1 - e2 * sinPhi ** 2); const t = tanPhi ** 2; const c = ep2 * cosPhi ** 2; const aa = cosPhi * (longitudeDegrees * degree - lon0); const m = meridionalArc(phi);
    return [
      parameters.falseEastingMetres + k0 * n * (aa + (1 - t + c) * aa ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120),
      parameters.falseNorthingMetres + k0 * (m + n * tanPhi * (aa ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720)),
    ];
  };
}

function projectedWktBounds(wkt, forward, origin) {
  const coordinate = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g; let match; let count = 0;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  while ((match = coordinate.exec(wkt)) !== null) {
    const [easting, northing] = forward(Number(match[1]), Number(match[2])); const x = easting - origin[0]; const z = northing - origin[1];
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], z); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], z); count += 1;
  }
  assert(count >= 4, 'DataSF WKT contains too few projected coordinates'); return bounds;
}

function bboxIou(left, right) {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const depth = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1])); const intersection = width * depth;
  const leftArea = (left[2] - left[0]) * (left[3] - left[1]); const rightArea = (right[2] - right[0]) * (right[3] - right[1]);
  return intersection / (leftArea + rightArea - intersection);
}
function centroid(bounds) { return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]; }
function distance(left, right) { return Math.hypot(left[0] - right[0], left[1] - right[1]); }
function quantile(sorted, fraction) { if (!sorted.length) return null; return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]; }
function rounded(value, digits = 6) { return Number(value.toFixed(digits)); }

async function loadRegion(region, horizontalLock, forward, osmTagsByWayId) {
  const dataSfPath = path.join(ROOT, `public/data/world/preview-artifacts/sf-datasf-building-footprints-v1/${region.tileId}.datasf-building-footprints.json`);
  const proofRoot = path.join(ROOT, `public/data/world/preview-artifacts/sf-building-presentation-proof-v1/${region.tileId}`);
  const proofPath = path.join(proofRoot, `${region.tileId}.building-presentation-proof.glb`);
  const proofReceiptPath = path.join(proofRoot, `${region.tileId}.building-presentation-proof.receipt.json`);
  const [dataSfBytes, proofBytes, proofReceiptBytes] = await Promise.all([readFile(dataSfPath), readFile(proofPath), readFile(proofReceiptPath)]);
  const dataSf = JSON.parse(dataSfBytes); const proofReceipt = JSON.parse(proofReceiptBytes); const glb = parseGlb(proofBytes);
  assert.equal(dataSf.region.tileId, region.tileId); assert.deepEqual(proofReceipt.tile.gridIndex.map((value) => value * 384), region.origin);
  assert.equal(glb.json.extras.unitsPerMetre, 1); assert.equal(horizontalLock.claims.operation.combinedAccuracyMetres, 4);
  const positionAccessor = glb.json.meshes[0].primitives[0].attributes.POSITION; const positions = accessorFloat32(glb, positionAccessor);
  const osm = proofReceipt.buildingRecords.map((record) => {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (let vertex = record.vertexStart; vertex < record.vertexStart + record.vertexCount; vertex += 1) {
      const x = positions[vertex * 3]; const z = positions[vertex * 3 + 2];
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], z); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], z);
    }
    const sourceWayId = Number(record.sourceFeatureId.slice('way/'.length));
    const sourceTags = osmTagsByWayId.get(sourceWayId);
    assert(sourceTags?.building, `${record.sourceFeatureId} is absent from the byte-locked OSM building tag authority`);
    const explicitHeight = Number.parseFloat(sourceTags.height);
    const levels = Number.parseFloat(sourceTags['building:levels']);
    const expectedHeightMetres = Number.isFinite(explicitHeight) && explicitHeight >= 2 && explicitHeight <= 500
      ? explicitHeight
      : Number.isFinite(levels) && levels > 0
        ? Math.min(500, levels * 3.2)
        : 9.6;
    assert.equal(rounded(record.heightMetres), rounded(expectedHeightMetres), `${record.sourceFeatureId} production extrusion differs from the byte-locked OSM height policy`);
    const heightPolicy = Number.isFinite(explicitHeight) && explicitHeight >= 2 && explicitHeight <= 500
      ? 'osm-height'
      : Number.isFinite(levels) && levels > 0
        ? 'osm-building-levels-times-3.2m'
        : 'deterministic-9.6m-fallback';
    return { sourceFeatureId: record.sourceFeatureId, bounds, centre: centroid(bounds), heightMetres: record.heightMetres, heightPolicy };
  });
  const dataSfProjected = dataSf.features.map((feature) => {
    const bounds = projectedWktBounds(feature.source.shape, forward, region.origin);
    return { buildingId: feature.source.sf16_bldgid, bounds, centre: centroid(bounds), heightMedianMetres: Number(feature.source.hgt_median_m) };
  });
  const candidates = [];
  for (const osmBuilding of osm) for (const dataSfBuilding of dataSfProjected) {
    const iou = bboxIou(osmBuilding.bounds, dataSfBuilding.bounds); const centroidDistanceMetres = distance(osmBuilding.centre, dataSfBuilding.centre);
    if (iou >= MIN_BBOX_IOU && centroidDistanceMetres <= MAX_CENTROID_DISTANCE_METRES) candidates.push({ osm: osmBuilding, dataSf: dataSfBuilding, iou, centroidDistanceMetres });
  }
  candidates.sort((left, right) => right.iou - left.iou || left.centroidDistanceMetres - right.centroidDistanceMetres || left.osm.sourceFeatureId.localeCompare(right.osm.sourceFeatureId) || left.dataSf.buildingId.localeCompare(right.dataSf.buildingId));
  const usedOsm = new Set(); const usedDataSf = new Set(); const matches = [];
  for (const candidate of candidates) {
    if (usedOsm.has(candidate.osm.sourceFeatureId) || usedDataSf.has(candidate.dataSf.buildingId)) continue;
    usedOsm.add(candidate.osm.sourceFeatureId); usedDataSf.add(candidate.dataSf.buildingId);
    const heightDeltaMetres = candidate.osm.heightMetres - candidate.dataSf.heightMedianMetres;
    matches.push({
      osmSourceFeatureId: candidate.osm.sourceFeatureId,
      osmHeightMetres: candidate.osm.heightMetres,
      osmHeightPolicy: candidate.osm.heightPolicy,
      dataSfBuildingId: candidate.dataSf.buildingId,
      dataSfMedianHeightMetres: candidate.dataSf.heightMedianMetres,
      bboxIou: rounded(candidate.iou, 9),
      centroidDistanceMetres: rounded(candidate.centroidDistanceMetres, 6),
      osmMinusDataSfMedianHeightMetres: rounded(heightDeltaMetres, 6),
      absoluteHeightDifferenceMetres: rounded(Math.abs(heightDeltaMetres), 6),
    });
  }
  matches.sort((left, right) => left.osmSourceFeatureId.localeCompare(right.osmSourceFeatureId));
  const ious = matches.map(({ bboxIou }) => bboxIou).sort((a, b) => a - b); const distances = matches.map(({ centroidDistanceMetres }) => centroidDistanceMetres).sort((a, b) => a - b);
  const deltas = matches.map(({ osmMinusDataSfMedianHeightMetres }) => osmMinusDataSfMedianHeightMetres).sort((a, b) => a - b); const absolute = matches.map(({ absoluteHeightDifferenceMetres }) => absoluteHeightDifferenceMetres).sort((a, b) => a - b);
  const heightPolicyCounts = Object.fromEntries([...new Set(osm.map(({ heightPolicy }) => heightPolicy))].sort().map((policy) => [policy, matches.filter(({ osmHeightPolicy }) => osmHeightPolicy === policy).length]));
  return {
    id: region.id,
    tileId: region.tileId,
    inputs: {
      dataSfExtract: { path: path.relative(ROOT, dataSfPath), bytes: dataSfBytes.length, sha256: `sha256:${sha256(dataSfBytes)}` },
      osmBuildingProof: { path: path.relative(ROOT, proofPath), bytes: proofBytes.length, sha256: `sha256:${sha256(proofBytes)}` },
      osmBuildingProofReceipt: { path: path.relative(ROOT, proofReceiptPath), bytes: proofReceiptBytes.length, sha256: `sha256:${sha256(proofReceiptBytes)}` },
    },
    counts: { osmBuildings: osm.length, dataSfBuildings: dataSfProjected.length, eligibleCandidatePairs: candidates.length, oneToOneMatches: matches.length },
    summary: {
      matchRateAgainstOsmPct: rounded(matches.length / osm.length * 100, 1),
      bboxIouMedian: quantile(ious, 0.5),
      centroidDistanceMedianMetres: quantile(distances, 0.5),
      osmMinusDataSfHeightMedianMetres: quantile(deltas, 0.5),
      absoluteHeightDifferenceMedianMetres: quantile(absolute, 0.5),
      absoluteHeightDifferenceP90Metres: quantile(absolute, 0.9),
      absoluteHeightDifferenceMaxMetres: absolute.at(-1) ?? null,
      matchedOsmHeightPolicyCounts: heightPolicyCounts,
      independenceQualification: matches.every(({ osmHeightPolicy }) => osmHeightPolicy === 'osm-height') ? 'OSM source supplies direct height tags' : 'OSM comparison includes derived or default extrusion heights and is not an independent validation of DataSF height accuracy',
    },
    matches,
  };
}

export async function buildDataSfOsmBuildingMatchProof({ write = true } = {}) {
  const [horizontalLockBytes, sharedInputs] = await Promise.all([readFile(HORIZONTAL_LOCK_PATH), loadSfMetricSharedInputs()]); const horizontalLock = JSON.parse(horizontalLockBytes); const forward = makeForwardProjection(horizontalLock);
  for (const vector of horizontalLock.testVectors) {
    const actual = forward(...vector.inputLonLatDegrees); assert(Math.abs(actual[0] - vector.forwardEnMetres[0]) <= 0.0002 && Math.abs(actual[1] - vector.forwardEnMetres[1]) <= 0.0002, `${vector.id} projection drifted`);
  }
  const osmTagsByWayId = new Map(sharedInputs.osmFeatureCache.filter(({ tags }) => tags.building).map(({ id, tags }) => [id, tags]));
  const regions = []; for (const region of REGIONS) regions.push(await loadRegion(region, horizontalLock, forward, osmTagsByWayId));
  const receipt = {
    schemaVersion: 1,
    kind: 'sf-datasf-osm-building-match-proof-receipt',
    status: 'preview-comparison-only-not-production',
    horizontalOperation: { sourceLock: path.relative(ROOT, HORIZONTAL_LOCK_PATH), sha256: `sha256:${sha256(horizontalLockBytes)}`, accuracyFloorMetres: horizontalLock.claims.operation.combinedAccuracyMetres, realization: 'not-claimed', coordinateEpoch: 'not-claimed' },
    associationPolicy: { geometry: 'axis-aligned EPSG:26910 bounding boxes of exact source footprint coordinates', minimumBboxIou: MIN_BBOX_IOU, maximumCentroidDistanceMetres: MAX_CENTROID_DISTANCE_METRES, assignment: 'deterministic greedy one-to-one by descending IoU, ascending centroid distance, then lexical source IDs', identityClaim: false },
    osmTagAuthority: { path: 'public/data/sf/SanFrancisco.osm.pbf', bytes: sharedInputs.pbfHash.bytes, sha256: `sha256:${sharedInputs.pbfHash.sha256}`, policy: 'OSM height tag when finite within 2–500m, else building:levels times 3.2m, else deterministic 9.6m fallback' },
    heightComparison: { osm: 'existing production extrusion height policy verified against byte-locked raw OSM tags', dataSf: 'hgt_median_m retained from the locked DataSF source', use: 'report-only source disagreement diagnostic', absoluteElevationComparison: false, verticalReconciliationComplete: false },
    claims: { productionGeometryChanged: false, runtimeChanged: false, gameplayChanged: false, facadeSemanticsSupplied: false, unmatchedBuildingsRejectedFromComparison: true, highConfidenceAssociationIsNotIdentity: true },
    regions,
  };
  const bytes = jsonBytes(receipt); if (write) { await mkdir(OUTPUT_ROOT, { recursive: true }); await writeFile(OUTPUT_PATH, bytes); }
  return { receipt, bytes, path: OUTPUT_PATH, sha256: `sha256:${sha256(bytes)}` };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await buildDataSfOsmBuildingMatchProof(); process.stdout.write(`${JSON.stringify({ path: path.relative(ROOT, result.path), bytes: result.bytes.length, sha256: result.sha256, regions: result.receipt.regions.map(({ id, tileId, counts, summary }) => ({ id, tileId, counts, summary })) }, null, 2)}\n`);
}
