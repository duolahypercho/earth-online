/**
 * Reproducibly lock the one USGS 3DEP source audited for the Ferry production
 * terrain migration. This does not build terrain, alter a tile manifest, or
 * promote the current sf-atlas-linear-v1 preview frame.
 *
 * The downloaded raster is intentionally placed under ignored Data/raw/; only
 * its immutable byte identity and official metadata are committed.
 *
 * Usage:
 *   node scripts/world-tiles/lock-usgs-3dep-terrain.mjs \
 *     --bounds=-122.3977602545,37.7917464503,-122.3886679245,37.7989814242
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRODUCT_ID = '66ce871ad34e98e8a92453cb';
const TITLE = 'USGS 1 Meter 10 x55y419 CA_SanFrancisco_B23';
const TIFF_URL = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/CA_SanFrancisco_B23/TIFF/USGS_1M_10_x55y419_CA_SanFrancisco_B23.tif';
const SCIENCEBASE_URL = `https://www.sciencebase.gov/catalog/item/${PRODUCT_ID}?format=json`;
const PRODUCT_METADATA_URL = 'https://thor-f5.er.usgs.gov/ngtoc/metadata/waf/elevation/1_meter/geotiff/CA_SanFrancisco_B23/USGS_1M_10_x55y419_CA_SanFrancisco_B23.xml';
const PRODUCT_BOUNDS_WGS84 = [-122.43230834799999, 37.76535823000006, -122.31794821799997, 37.856087298000034];
const DEFAULT_FERRY_BOUNDS_WGS84 = [-122.3977602545, 37.7917464503, -122.3886679245, 37.7989814242];
const RAW_DIR = path.join(ROOT, 'Data/raw/usgs-3dep', PRODUCT_ID);
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');

function parseBounds(argument) {
  const values = (argument || DEFAULT_FERRY_BOUNDS_WGS84.join(',')).split(',').map(Number);
  assert.equal(values.length, 4, '--bounds requires minLon,minLat,maxLon,maxLat');
  assert(values.every(Number.isFinite), '--bounds must contain only finite numbers');
  assert(values[0] < values[2] && values[1] < values[3], '--bounds must have positive area');
  return values;
}

function contains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function responseBytes(url) {
  const response = await fetch(url);
  assert(response.ok, `Unable to fetch ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function streamRaster(url, targetPath) {
  const hash = createHash('sha256');
  let bytes = 0;
  const targetPartial = `${targetPath}.partial`;
  if (existsSync(targetPartial)) {
    await new Promise((resolve, reject) => {
      createReadStream(targetPartial).on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; }).on('end', resolve).on('error', reject);
    });
  }

  const head = await fetch(url, { method: 'HEAD' });
  assert(head.ok, `Unable to inspect raster: HTTP ${head.status}`);
  const expectedBytes = Number(head.headers.get('content-length'));
  assert(Number.isSafeInteger(expectedBytes) && expectedBytes > 0, 'Raster response must declare a safe positive total length');
  assert(bytes <= expectedBytes, `Partial raster already exceeds expected byte count (${bytes} > ${expectedBytes})`);
  let etag = null;
  let lastModified = null;
  for (let attempt = 1; attempt <= 4 && bytes !== expectedBytes; attempt += 1) {
    const headers = bytes ? { Range: `bytes=${bytes}-` } : {};
    const response = await fetch(url, { headers });
    assert(response.ok, `Unable to download raster: HTTP ${response.status}`);
    assert(response.body, 'Raster response has no body');
    if (bytes) {
      assert.equal(response.status, 206, `Range resume must return HTTP 206, got ${response.status}`);
      assert.equal(response.headers.get('content-range'), `bytes ${bytes}-${expectedBytes - 1}/${expectedBytes}`, 'Raster range response drifted');
    }
    etag ||= response.headers.get('etag')?.replaceAll('"', '') || null;
    lastModified ||= response.headers.get('last-modified') || null;
    const writer = await open(targetPartial, 'a');
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        bytes += value.byteLength;
        await writer.write(value);
      }
    } catch (error) {
      if (attempt === 4) throw error;
    } finally {
      await writer.close();
    }
  }
  assert.equal(bytes, expectedBytes, `Raster byte count mismatch: expected ${expectedBytes}, got ${bytes}`);
  await rename(targetPartial, targetPath);
  assert.equal((await stat(targetPath)).size, expectedBytes, 'Final raster byte count does not match the download response');
  return { bytes, sha256: hash.digest('hex'), etag, lastModified };
}

const boundsArgument = process.argv.find((argument) => argument.startsWith('--bounds='));
const requestedBoundsWgs84 = parseBounds(boundsArgument?.slice('--bounds='.length));
assert(contains(PRODUCT_BOUNDS_WGS84, requestedBoundsWgs84), 'Requested Ferry bounds are not fully covered by the audited USGS product');

const [sciencebaseBytes, productMetadataBytes] = await Promise.all([
  responseBytes(SCIENCEBASE_URL),
  responseBytes(PRODUCT_METADATA_URL),
]);
const sciencebase = JSON.parse(sciencebaseBytes.toString('utf8'));
assert.equal(sciencebase.id, PRODUCT_ID, 'ScienceBase product id drifted');
assert.equal(sciencebase.title, TITLE, 'ScienceBase product title drifted');
assert.deepEqual([
  sciencebase.spatial?.boundingBox?.minX,
  sciencebase.spatial?.boundingBox?.minY,
  sciencebase.spatial?.boundingBox?.maxX,
  sciencebase.spatial?.boundingBox?.maxY,
], PRODUCT_BOUNDS_WGS84, 'ScienceBase WGS84 bounding box drifted');
assert(productMetadataBytes.includes(Buffer.from('NAD83 / UTM zone 10N')), 'Product XML no longer declares NAD83 / UTM zone 10N');
assert(productMetadataBytes.includes(Buffer.from('North American Vertical Datum of 1988 (NAVD88)')), 'Product XML no longer declares NAVD88');
assert(productMetadataBytes.includes(Buffer.from('All 3DEP products are public domain')), 'Product XML no longer declares public-domain status');

await mkdir(RAW_DIR, { recursive: true });
await mkdir(path.dirname(LOCK_PATH), { recursive: true });
const rasterPath = path.join(RAW_DIR, path.basename(new URL(TIFF_URL).pathname));
const raster = await streamRaster(TIFF_URL, rasterPath);
const lock = {
  schemaVersion: 1,
  kind: 'earth-terrain-source-lock',
  status: 'source-locked-not-built',
  id: 'sf-ferry-3dep-2023',
  title: 'Ferry Building 2023 USGS 3DEP terrain source lock',
  requestedCoverageWgs84: requestedBoundsWgs84,
  coverage: {
    scienceBaseMetadataEnvelope: {
      wgs84Bounds: PRODUCT_BOUNDS_WGS84,
      authority: 'ScienceBase product metadata coverage, not the embedded raster affine',
    },
    sourceBoundsWgs84: PRODUCT_BOUNDS_WGS84,
    sourceContainsRequestedCoverage: true,
    sourceResolutionMeters: 1,
    sourceDimensionsPixels: [10012, 10012],
    surface: 'bare-earth DEM',
  },
  source: {
    producer: 'U.S. Geological Survey',
    program: '3D Elevation Program (3DEP)',
    productId: PRODUCT_ID,
    productTitle: TITLE,
    sciencebaseJsonUrl: SCIENCEBASE_URL,
    sciencebaseJsonSha256: sha256(sciencebaseBytes),
    productMetadataUrl: PRODUCT_METADATA_URL,
    productMetadataSha256: sha256(productMetadataBytes),
    acquisitionDate: '2023-04-20',
    publicationDate: '2024-08-26',
    license: 'US public domain',
    attribution: 'U.S. Geological Survey, 3D Elevation Program (3DEP)',
  },
  raster: {
    format: 'GeoTIFF',
    url: TIFF_URL,
    bytes: raster.bytes,
    sha256: raster.sha256,
    etag: raster.etag,
    lastModified: raster.lastModified,
    gridEnvelope: {
      authority: 'Exact tags embedded in the byte-locked GeoTIFF; this is separate from the ScienceBase WGS84 metadata envelope.',
      tiffEncoding: 'classic little-endian TIFF',
      dimensionsPixels: [10012, 10012],
      sampleLayout: {
        samplesPerPixel: 1,
        bitsPerSample: 32,
        sampleFormat: 'IEEE floating point (3)',
        compression: 'LZW (5)',
        predictor: 'floating point (3)',
        nodata: -999999,
      },
      tileLayout: { tilePixels: [512, 512], tileCount: 400, overviewIfdCount: 5, overviewsPresent: true },
      horizontalEpsg: 26910,
      linearUnitEpsg: 9001,
      rasterType: 'PixelIsArea',
      pixelScaleModelSpace: [1, 1, 0],
      modelTiepoint: [0, 0, 0, 549993.9999840065, 4190005.9999845778, 0],
      modelTransformationTagPresent: false,
      pixelToModelAffine: {
        columnRowFormula: 'X = 549993.9999840065 + column; Y = 4190005.9999845778 - row',
        coefficients: [1, 0, 549993.9999840065, 0, -1, 4190005.9999845778],
      },
      modelBoundsAtPixelIsAreaEdges: [549993.9999840065, 4179993.9999845778, 560005.9999840065, 4190005.9999845778],
      verticalGeoKeysPresent: false,
    },
    localRawCache: 'Data/raw/usgs-3dep/66ce871ad34e98e8a92453cb/USGS_1M_10_x55y419_CA_SanFrancisco_B23.tif',
    localRawCacheGitIgnored: true,
  },
  coordinateReference: {
    horizontal: {
      declaredByProductMetadata: 'NAD83 / UTM zone 10N',
      expectedEpsg: 'EPSG:26910',
      units: 'metres',
      realizationStatus: 'The GeoTIFF WKT/GeoKeys and exact NAD83 realization must be validated before a production coordinate transform is selected.',
    },
    vertical: {
      declaredByProductMetadata: 'NAVD88',
      units: 'metres',
      embeddedTiffGeoKeys: 'absent; no vertical CRS or geoid may be inferred from this TIFF alone',
      geoidAndEpochStatus: 'NAVD88 is declared by the product XML, but a geoid model and epoch are not locked by this source-lock. A production terrain build must establish them and reconcile its water datum.',
    },
  },
  tooling: {
    lockScript: 'scripts/world-tiles/lock-usgs-3dep-terrain.mjs',
    verifier: 'scripts/world-tiles/verify-ferry-production-terrain.mjs',
    geoTiffMetadataVerifier: 'scripts/world-tiles/verify-ferry-3dep-geotiff-metadata.mjs',
    runtime: `node ${process.version}`,
    downloadMethod: 'WHATWG fetch with resumable HTTP Range reads and sequential FileHandle writes while hashing bytes',
  },
  integrationStatus: {
    currentFrame: 'sf-atlas-linear-v1',
    currentFrameStatus: 'preview-only',
    productionTerrain: 'not-built',
    tileManifestsChanged: false,
    nextRequiredGate: 'Validate GeoTIFF CRS realization/geoid and build an authoritative EPSG:26910 terrain artifact before any manifest promotion.',
  },
};
await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
const metadataCheck = spawnSync(process.execPath, [
  path.join(ROOT, 'scripts/world-tiles/verify-ferry-3dep-geotiff-metadata.mjs'),
  '--verify-raw',
], { cwd: ROOT, encoding: 'utf8' });
assert.equal(metadataCheck.status, 0, `Downloaded GeoTIFF failed metadata validation:\n${metadataCheck.stderr || metadataCheck.stdout}`);
console.log(JSON.stringify({
  result: 'USGS 3DEP source lock written',
  lock: path.relative(ROOT, LOCK_PATH),
  rawRaster: path.relative(ROOT, rasterPath),
  requestedCoverageWgs84: requestedBoundsWgs84,
  raster: { bytes: raster.bytes, sha256: raster.sha256 },
  geoTiffMetadata: JSON.parse(metadataCheck.stdout),
  metadata: { sciencebaseJsonSha256: lock.source.sciencebaseJsonSha256, productMetadataSha256: lock.source.productMetadataSha256 },
}, null, 2));
