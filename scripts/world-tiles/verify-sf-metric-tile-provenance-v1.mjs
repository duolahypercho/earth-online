/**
 * Fail-closed source/provenance gate for the landed SF metric tile manifest.
 *
 * This deliberately does not rebuild GLBs; the seam verifier owns that costly
 * check.  It proves that every advertised tile is source-ready in the complete
 * city plan and that its checked-in receipt/package still binds the byte-locked
 * horizontal, terrain, and provisional-vertical evidence.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const PLAN_PATH = path.join(ROOT, 'public/data/world/plans/sf-metric-tile-coverage-v1.json');
const GEOMETRY_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-osm-horizontal-geometry-v1.lock.json');
const HORIZONTAL_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json');
const TILE_SIZE = 384;
const PROVISIONAL_STATUS = 'provisional-vertical-unrealized';
const PROVISIONAL_VERTICAL = 'source-declared-navd88-unrealized';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const [manifest, plan, geometryLockBytes, horizontalLockBytes] = await Promise.all([
  readJson(MANIFEST_PATH),
  readJson(PLAN_PATH),
  readFile(GEOMETRY_LOCK_PATH),
  readFile(HORIZONTAL_LOCK_PATH),
]);
const geometryLock = JSON.parse(geometryLockBytes);
const horizontalLock = JSON.parse(horizontalLockBytes);
const planById = new Map(plan.tiles.map((tile) => [tile.id, tile]));

assert.equal(manifest.kind, 'sf-metric-tile-set');
assert.equal(manifest.status, PROVISIONAL_STATUS);
assert.equal(manifest.coordinateReference?.horizontal?.crs, 'EPSG:26910');
assert.equal(manifest.coordinateReference?.horizontal?.unit, 'metre');
assert.equal(manifest.tiling?.tileSizeMetres, TILE_SIZE);
assert.equal(plan.kind, 'sf-metric-tile-coverage-plan');
assert.equal(plan.coordinateReference?.horizontal?.crs, 'EPSG:26910');
assert.equal(plan.tiling?.tileSizeMetres, TILE_SIZE);
assert.equal(geometryLock.source.snapshot.sha256, 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae');
assert.equal(horizontalLock.claims.target.crs, 'EPSG:26910');

const reports = [];
for (const tile of manifest.tiles) {
  const planned = planById.get(tile.id);
  assert(planned, `${tile.id} is not in the locked complete-SF coverage plan`);
  assert.equal(planned.sourceReadiness.buildReady, true, `${tile.id} is advertised despite unavailable terrain: ${planned.sourceReadiness.terrainElevation}`);
  assert.deepEqual(planned.gridIndex, tile.gridIndex, `${tile.id} grid index differs from the coverage plan`);
  assert.deepEqual(tile.originEpsg26910VerticalMetres, [tile.gridIndex[0] * TILE_SIZE, tile.gridIndex[1] * TILE_SIZE, 0], `${tile.id} is not on the 384 m EPSG:26910 grid`);

  const receiptPath = path.resolve(ROOT, tile.receipt.path);
  const packagePath = receiptPath.replace(/\.receipt\.json$/, '.package.json');
  const [receiptBytes, receipt, mapPackage] = await Promise.all([readFile(receiptPath), readJson(receiptPath), readJson(packagePath)]);
  assert.equal(`sha256:${sha256(receiptBytes)}`, tile.receipt.sha256, `${tile.id} receipt hash drifted`);
  assert.equal(receipt.status, PROVISIONAL_STATUS, `${tile.id} receipt must remain vertically provisional`);
  assert.equal(mapPackage.status, PROVISIONAL_STATUS, `${tile.id} package must remain vertically provisional`);
  assert.equal(mapPackage.verticalCertification, PROVISIONAL_VERTICAL, `${tile.id} package vertical certification drifted`);
  assert.deepEqual(mapPackage.scale, { runtimeUnitsPerMetre: 1, horizontalScale: 1, verticalScale: 1, verticalExaggeration: 0 }, `${tile.id} is not one runtime unit per metre without vertical exaggeration`);
  assert.equal(receipt.tile.identity, tile.id, `${tile.id} receipt identity drifted`);
  assert.deepEqual(receipt.tile.originEpsg26910VerticalMetres, tile.originEpsg26910VerticalMetres, `${tile.id} receipt origin drifted`);
  assert.equal(receipt.tile.runtimeFrame, manifest.coordinateReference.runtimeFrame, `${tile.id} runtime frame drifted`);
  assert.equal(receipt.source.osmPbf.sha256, geometryLock.source.snapshot.sha256, `${tile.id} OSM byte identity is not source-locked`);
  assert.equal(receipt.source.osmPbf.bytes, geometryLock.source.snapshot.bytes, `${tile.id} OSM byte count is not source-locked`);
  assert(receipt.source.geoTiffs.length > 0, `${tile.id} has no terrain source receipt`);

  const packageLocks = new Map(mapPackage.sourceLocks.map((lock) => [lock.id, lock]));
  for (const [id, lockPath, lockBytes, purpose] of [
    [geometryLock.id, GEOMETRY_LOCK_PATH, geometryLockBytes, 'geometry'],
    [horizontalLock.id, HORIZONTAL_LOCK_PATH, horizontalLockBytes, 'horizontal-coordinate-operation'],
  ]) {
    const packageLock = packageLocks.get(id);
    assert(packageLock, `${tile.id} package is missing ${purpose} lock ${id}`);
    assert.equal(packageLock.path, relative(lockPath), `${tile.id} ${purpose} lock path drifted`);
    assert.equal(packageLock.sha256, sha256(lockBytes), `${tile.id} ${purpose} lock hash drifted`);
  }
  for (const terrain of receipt.source.geoTiffs) {
    assert.equal(terrain.verticalCertification, PROVISIONAL_VERTICAL, `${tile.id} terrain receipt overclaims vertical certification`);
    const packageLock = packageLocks.get(terrain.elevationSourceLockId);
    assert(packageLock && packageLock.purpose === 'terrain-elevation', `${tile.id} terrain authorization is absent from the package`);
    const authorizationPath = path.resolve(ROOT, packageLock.path);
    const authorizationBytes = await readFile(authorizationPath);
    const authorization = JSON.parse(authorizationBytes);
    assert.equal(packageLock.sha256, sha256(authorizationBytes), `${tile.id} terrain authorization lock hash drifted`);
    assert.equal(authorization.kind, 'earth-terrain-elevation-source-authorization', `${tile.id} terrain authorization kind drifted`);
    assert.equal(authorization.status, 'source-declared-navd88-unrealized-elevation-sampling-authorized', `${tile.id} terrain authorization is not provisional-only`);
    assert.equal(authorization.sourceRaster.sha256, terrain.sha256, `${tile.id} terrain raster receipt does not match its authorization`);
  }
  reports.push({ id: tile.id, terrainLocks: [...new Set(receipt.source.geoTiffs.map(({ elevationSourceLockId }) => elevationSourceLockId))].sort() });
}

console.log(JSON.stringify({
  result: 'SF metric tile provenance passed',
  manifest: relative(MANIFEST_PATH),
  coveragePlan: relative(PLAN_PATH),
  status: PROVISIONAL_STATUS,
  tiles: reports.length,
  terrainAuthorizations: [...new Set(reports.flatMap(({ terrainLocks }) => terrainLocks))].sort(),
}, null, 2));
