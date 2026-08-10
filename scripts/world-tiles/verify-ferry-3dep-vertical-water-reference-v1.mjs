/**
 * Verify the station-scoped, preview-only vertical water-reference lock.
 *
 * This has no network, geospatial, DEM, or runtime dependency. It verifies
 * only arithmetic between published station 9414290 datums and NAVD88.
 *
 * Usage: node scripts/world-tiles/verify-ferry-3dep-vertical-water-reference-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-vertical-water-reference-v1.lock.json');
const PARENT_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const lockBytes = readFileSync(LOCK_PATH);
const lock = JSON.parse(lockBytes);
const parentLock = JSON.parse(readFileSync(PARENT_LOCK_PATH, 'utf8'));

function close(actual, expected, label) {
  assert(Math.abs(actual - expected) <= 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

function navd88FromStationDatum(stationDatumMetres) {
  return stationDatumMetres - lock.claims.stationDatumConversion.constantHStndNavd88Metres;
}

function stationDatumFromNavd88(navd88Metres) {
  return navd88Metres + lock.claims.stationDatumConversion.constantHStndNavd88Metres;
}

function haversineDistanceMetres([lon1, lat1], [lon2, lat2]) {
  const radians = Math.PI / 180;
  const latitudeDelta = (lat2 - lat1) * radians;
  const longitudeDelta = (lon2 - lon1) * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(haversine));
}

assert.equal(lock.schemaVersion, 1, 'Unsupported vertical water-reference lock schema');
assert.equal(lock.kind, 'earth-vertical-water-reference-source-lock', 'Unexpected source-lock kind');
assert.equal(lock.status, 'source-locked-station-datum-conversion-preview-only', 'Lock must remain preview-only');
assert.equal(lock.id, 'sf-ferry-3dep-2023-vertical-water-reference-v1', 'Vertical water-reference identity drifted');
assert.match(lock.scope, /station 9414290/, 'Scope must remain station-specific');
assert.match(lock.scope, /preview-only/, 'Scope must remain preview-only');
assert.equal(lock.sourceEvidence.locked3depProduct.productMetadataSha256, parentLock.source.productMetadataSha256, 'USGS XML hash must match the parent source lock');
assert.equal(lock.sourceEvidence.locked3depProduct.productMetadataUrl, parentLock.source.productMetadataUrl, 'USGS XML URL must match the parent source lock');
assert.equal(lock.sourceEvidence.locked3depProduct.exactVerticalDeclaration, 'All bare earth elevation values are in meters and are referenced to the North American Vertical Datum of 1988 (NAVD88).', 'USGS product vertical declaration drifted');
assert.equal(lock.claims.dem.verticalDatum, 'NAVD88', 'DEM vertical datum must remain NAVD88');
assert.equal(lock.claims.dem.verticalUnits, 'metres', 'DEM vertical unit must remain metres');
assert.equal(lock.claims.dem.geoidModel, 'not claimed; no model is present in the product XML or embedded GeoTIFF keys', 'Geoid must not be inferred');
assert.equal(lock.claims.dem.verticalCoordinateEpoch, 'not claimed; NAVD88 is declared, but no vertical coordinate epoch is supplied', 'Vertical epoch must not be inferred');
assert.equal(lock.authorityReceipts.retrievedOn, '2026-08-10', 'Authority retrieval date drifted');
assert.equal(lock.authorityReceipts.hashAlgorithm, 'SHA-256 over the retrieved response bytes', 'Authority hash method drifted');
assert.deepEqual(lock.sourceEvidence.usgsSpecification.acquisitionEraSpecification, {
  title: 'Lidar Base Specification 2022 rev. A',
  url: 'https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/Lidar-Base-Specification-2022-rev-A.docx',
  sha256: '454e2b333c2ccfc52e3a85bf878d410312ae82b5a0c8884675fe1d0db158eeba',
  relevance: 'For CONUS, its default is NAVD88 orthometric heights and the latest NGS hybrid geoid, then GEOID18; it permits an advance USGS/user agreement to specify otherwise and requires the delivered vertical CRS and geoid model to be identified.',
}, 'Acquisition-era USGS specification receipt drifted');
assert.equal(lock.sourceEvidence.usgsSpecification.currentSpecification.sha256, '9469ff8235c850dd8fb3629a1d1b5e8b71ae9af27cfa1532299aecc68f62285e', 'Current USGS specification receipt drifted');
assert.equal(lock.sourceEvidence.ngs.verticalDatums.sha256, '359c062b1fa19cd6d15a1dbe650db3bbaea82d958264ea5731f6197d738f1a95', 'NGS vertical-datum receipt drifted');
assert.equal(lock.sourceEvidence.ngs.geoid18.sha256, '074ba712722a680d3225ea5a240a626943d5c19cf1e710be1fede657a4d7e430', 'NGS GEOID18 receipt drifted');

const station = lock.sourceEvidence.coopsStation9414290;
assert.equal(station.id, '9414290', 'CO-OPS station identity drifted');
assert.equal(station.name, 'San Francisco', 'CO-OPS station name drifted');
assert.deepEqual(station.positionWgs84, [-122.46589, 37.806305], 'CO-OPS station position drifted');
assert.equal(station.units, 'meters', 'CO-OPS station datum units drifted');
assert.equal(station.orthometricDatum, 'NAVD88', 'CO-OPS orthometric datum drifted');
assert.equal(station.accepted, 'Apr 17 2003', 'CO-OPS accepted date drifted');
assert.equal(station.tidalDatumEpoch, '1983-2001', 'CO-OPS tidal datum epoch drifted');
assert.equal(station.datumAnalysisPeriod, '01/01/1983 - 12/31/2001', 'CO-OPS datum analysis period drifted');
assert.deepEqual(station.publishedStationDatumValuesMetres, {
  STND: 0, MHHW: 3.602, MHW: 3.416, MSL: 2.773, MLLW: 1.822, NAVD88: 1.804,
}, 'CO-OPS source datum values drifted');
assert.match(station.stationUrl, /^https:\/\/api\.tidesandcurrents\.noaa\.gov\//, 'Station source must be official CO-OPS');
assert.match(station.datumsUrl, /^https:\/\/api\.tidesandcurrents\.noaa\.gov\//, 'Datum source must be official CO-OPS');
assert.match(station.stationSha256, /^[a-f0-9]{64}$/, 'Station receipt hash must be SHA-256');
assert.match(station.datumsSha256, /^[a-f0-9]{64}$/, 'Datum receipt hash must be SHA-256');

const conversion = lock.claims.stationDatumConversion;
assert.equal(conversion.direction, 'positive up', 'Vertical sign convention drifted');
assert.equal(conversion.constantHStndNavd88Metres, station.publishedStationDatumValuesMetres.NAVD88, 'NAVD88 station-datum constant must come from CO-OPS');
assert.equal(conversion.equation, 'H_NAVD88(D) = H_STND(D) - H_STND(NAVD88)', 'Forward equation drifted');
assert.equal(conversion.inverseEquation, 'H_STND = H_NAVD88 + H_STND(NAVD88)', 'Inverse equation drifted');

for (const vector of lock.testVectors.filter((vector) => 'stationDatum' in vector)) {
  close(
    navd88FromStationDatum(vector.stationDatumHeightMetres),
    vector.expectedNavd88Metres,
    `${vector.id} forward conversion`,
  );
}
const inverseVector = lock.testVectors.find((vector) => 'inputNavd88Metres' in vector);
assert(inverseVector, 'An inverse test vector is required');
close(stationDatumFromNavd88(inverseVector.inputNavd88Metres), inverseVector.expectedStationDatumMetres, `${inverseVector.id} inverse conversion`);
for (const [datum, expected] of Object.entries(conversion.computedTidalDatumHeightsNavd88Metres)) {
  close(navd88FromStationDatum(station.publishedStationDatumValuesMetres[datum]), expected, `${datum} computed conversion`);
}

const applicability = lock.claims.previewApplicability;
const [west, south, east, north] = parentLock.requestedCoverageWgs84;
const expectedCenter = [(west + east) / 2, (south + north) / 2];
assert.deepEqual(applicability.lockedFerryExtentCenterWgs84, expectedCenter, 'Locked Ferry extent center must derive from the parent source lock');
close(
  haversineDistanceMetres(station.positionWgs84, applicability.lockedFerryExtentCenterWgs84),
  applicability.stationToLockedExtentCenterDistanceMetres,
  'Station-to-Ferry distance',
);
assert.match(applicability.notEstablished, /not be described as the local Ferry waterfront MSL or MHW/, 'Local Ferry equivalence must remain unclaimed');
assert.equal(lock.limitations.geoid, 'No geoid conversion is performed or needed to subtract two values already published against NAVD88. GEOID18 is only a specification/default-model inference, not evidence that this specific distributable GeoTIFF used it.', 'Geoid limitation drifted');
assert.match(lock.limitations.accuracy, /no combined uncertainty may be claimed/, 'Accuracy limitation must remain explicit');
assert.equal(lock.integrationStatus.terrainArtifact, 'not-built', 'This lock must not imply a terrain artifact');
assert.equal(lock.integrationStatus.terrainManifestChanged, false, 'This lock must not change terrain manifests');
assert.equal(lock.integrationStatus.runtimeChanged, false, 'This lock must not change runtime behavior');
assert.equal(lock.integrationStatus.productionClaim, false, 'This lock must not authorize a production claim');

const receipt = {
  result: 'Ferry 3DEP station-scoped vertical water-reference source lock passed',
  lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
  station: {
    id: station.id,
    tidalDatumEpoch: station.tidalDatumEpoch,
    units: station.units,
    orthometricDatum: station.orthometricDatum,
  },
  conversionsNavd88Metres: conversion.computedTidalDatumHeightsNavd88Metres,
  previewLimit: `Station 9414290 is ${applicability.stationToLockedExtentCenterDistanceMetres} m from the locked Ferry extent center; no local tidal transfer or uncertainty is claimed.`,
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
