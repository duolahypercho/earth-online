/**
 * Validates only the committed USGS 3DEP source lock. It deliberately does
 * not validate or imply a production terrain artifact, coordinate migration,
 * or changed tile manifest.
 *
 * Add --verify-raw to also SHA-256 the locally cached, gitignored TIFF.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const PRODUCT_ID = '66ce871ad34e98e8a92453cb';
const TITLE = 'USGS 1 Meter 10 x55y419 CA_SanFrancisco_B23';
const SOURCE_BOUNDS = [-122.43230834799999, 37.76535823000006, -122.31794821799997, 37.856087298000034];
const EXPECTED_FERRY_BOUNDS = [-122.3977602545, 37.7917464503, -122.3886679245, 37.7989814242];
const TIFF_URL = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/CA_SanFrancisco_B23/TIFF/USGS_1M_10_x55y419_CA_SanFrancisco_B23.tif';

function contains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
assert.equal(lock.schemaVersion, 1, 'Unsupported source-lock schema');
assert.equal(lock.kind, 'earth-terrain-source-lock', 'Unexpected source-lock kind');
assert.equal(lock.status, 'source-locked-not-built', 'Source lock must not claim built terrain');
assert.equal(lock.id, 'sf-ferry-3dep-2023', 'Source-lock id drifted');
assert.deepEqual(lock.requestedCoverageWgs84, EXPECTED_FERRY_BOUNDS, 'Ferry coverage bounds drifted');
assert.deepEqual(lock.coverage?.sourceBoundsWgs84, SOURCE_BOUNDS, 'Audited source bounds drifted');
assert(contains(lock.coverage.sourceBoundsWgs84, lock.requestedCoverageWgs84), 'USGS source must fully cover Ferry bounds');
assert.equal(lock.coverage.sourceContainsRequestedCoverage, true, 'Coverage assertion must be explicit');
assert.equal(lock.coverage.sourceResolutionMeters, 1, 'Source must remain a 1 m DEM');
assert.deepEqual(lock.coverage.sourceDimensionsPixels, [10012, 10012], 'Raster dimensions drifted');
assert.equal(lock.coverage.surface, 'bare-earth DEM', 'Source surface type drifted');
assert.equal(lock.source?.productId, PRODUCT_ID, 'USGS product id drifted');
assert.equal(lock.source?.productTitle, TITLE, 'USGS product title drifted');
assert.equal(lock.source?.acquisitionDate, '2023-04-20', 'Acquisition date drifted');
assert.equal(lock.source?.publicationDate, '2024-08-26', 'Publication date drifted');
assert.equal(lock.source?.license, 'US public domain', 'License must remain explicit');
assert.match(lock.source?.sciencebaseJsonSha256 || '', /^[a-f0-9]{64}$/, 'ScienceBase JSON hash missing');
assert.match(lock.source?.productMetadataSha256 || '', /^[a-f0-9]{64}$/, 'Product XML hash missing');
assert.equal(lock.raster?.url, TIFF_URL, 'Direct GeoTIFF URL drifted');
assert(Number.isSafeInteger(lock.raster?.bytes) && lock.raster.bytes > 0, 'Raster byte count missing');
assert.match(lock.raster?.sha256 || '', /^[a-f0-9]{64}$/, 'Raster SHA-256 missing');
assert.equal(lock.raster?.localRawCacheGitIgnored, true, 'Raw raster must remain ignored');
assert.equal(lock.coordinateReference?.horizontal?.declaredByProductMetadata, 'NAD83 / UTM zone 10N', 'Horizontal CRS declaration drifted');
assert.equal(lock.coordinateReference?.horizontal?.expectedEpsg, 'EPSG:26910', 'Expected EPSG drifted');
assert.equal(lock.coordinateReference?.vertical?.declaredByProductMetadata, 'NAVD88', 'Vertical datum declaration drifted');
assert.equal(lock.integrationStatus?.currentFrame, 'sf-atlas-linear-v1', 'Current preview frame declaration drifted');
assert.equal(lock.integrationStatus?.currentFrameStatus, 'preview-only', 'Preview frame must not be promoted');
assert.equal(lock.integrationStatus?.productionTerrain, 'not-built', 'Source lock must not claim production terrain');
assert.equal(lock.integrationStatus?.tileManifestsChanged, false, 'Source lock must not claim manifest changes');
assert.match(lock.tooling?.downloadMethod || '', /HTTP Range reads/, 'Lock must document resumable byte-verified retrieval');

let rawRaster = null;
if (process.argv.includes('--verify-raw')) {
  const rawPath = path.join(ROOT, lock.raster.localRawCache);
  assert(existsSync(rawPath), `Expected local raw raster is missing: ${lock.raster.localRawCache}`);
  assert.equal((await stat(rawPath)).size, lock.raster.bytes, 'Local raw TIFF byte count does not match committed lock');
  const sha256 = await fileSha256(rawPath);
  assert.equal(sha256, lock.raster.sha256, 'Local raw TIFF SHA-256 does not match committed lock');
  rawRaster = { verified: true, path: lock.raster.localRawCache, sha256 };
}

console.log(JSON.stringify({
  result: 'Ferry USGS 3DEP source lock passed',
  source: { productId: lock.source.productId, productTitle: lock.source.productTitle },
  coverage: { requestedWgs84: lock.requestedCoverageWgs84, sourceWgs84: lock.coverage.sourceBoundsWgs84, sourceContainsRequestedCoverage: true },
  raster: { bytes: lock.raster.bytes, sha256: lock.raster.sha256, rawRaster },
  productionTerrain: lock.integrationStatus.productionTerrain,
}, null, 2));
