/**
 * Build a compact, non-runtime Ferry 3DEP parent sample buffer. This is an
 * engineering preview only: it preserves native float32 source samples and
 * makes no vertical datum or production-placement claim.
 *
 * Usage: node scripts/world-tiles/build-ferry-3dep-2x2-parent-preview.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GEO_TIFF_WINDOW_READER_VERSION, openGeoTiffWindowReader } from './geotiff-window-reader-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const HORIZONTAL_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json');
const REGION_PATH = path.join(ROOT, 'public/data/world/regions/sf-ferry-building-hero.region.json');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-parent-v1');
const ARTIFACT_NAME = 'sf-ferry-3dep-2x2-parent-preview-v1.f32le';
const RECEIPT_NAME = 'sf-ferry-3dep-2x2-parent-preview-v1.receipt.json';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }

async function sha256File(filePath) {
  const hash = createHash('sha256');
  let bytesRead = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytesRead += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytesRead };
}

/** Serialize without depending on the host representation of Float32Array. */
export function encodeFloat32LittleEndian(values) {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) bytes.writeFloatLE(values[index], index * 4);
  return bytes;
}

function genericForward(lock, lonDegrees, latDegrees) {
  const projection = lock.claims.operation.authorityPath[1];
  const parameters = projection.parameters;
  const { semiMajorAxisMetres: a, inverseFlattening } = projection.ellipsoidFromEpsg4269;
  const f = 1 / inverseFlattening;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const radians = Math.PI / 180;
  const k0 = parameters.scaleFactor;
  const lon0 = parameters.longitudeOfNaturalOriginDegrees * radians;
  const phi = latDegrees * radians;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * sinPhi ** 2);
  const t = tanPhi ** 2;
  const c = ep2 * cosPhi ** 2;
  const aa = cosPhi * (lonDegrees * radians - lon0);
  const m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  return [
    parameters.falseEastingMetres + k0 * n * (aa + (1 - t + c) * aa ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120),
    parameters.falseNorthingMetres + k0 * (m + n * tanPhi * (aa ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720)),
  ];
}

function projectedCorners(bounds, horizontalLock) {
  const [west, south, east, north] = bounds;
  return [
    { id: 'southwest', lonLatDegrees: [west, south], enMetres: genericForward(horizontalLock, west, south) },
    { id: 'southeast', lonLatDegrees: [east, south], enMetres: genericForward(horizontalLock, east, south) },
    { id: 'northwest', lonLatDegrees: [west, north], enMetres: genericForward(horizontalLock, west, north) },
    { id: 'northeast', lonLatDegrees: [east, north], enMetres: genericForward(horizontalLock, east, north) },
  ];
}

function childWindows(width, height) {
  const x = Math.floor((width - 1) / 2);
  const y = Math.floor((height - 1) / 2);
  return [
    { id: 'northwest', gridIndex: [0, 0], column: 0, row: 0, width: x + 1, height: y + 1 },
    { id: 'northeast', gridIndex: [1, 0], column: x, row: 0, width: width - x, height: y + 1 },
    { id: 'southwest', gridIndex: [0, 1], column: 0, row: y, width: x + 1, height: height - y },
    { id: 'southeast', gridIndex: [1, 1], column: x, row: y, width: width - x, height: height - y },
  ];
}

function readSegment(parentBytes, parentWidth, column, row, length, horizontal) {
  const chunks = [];
  for (let index = 0; index < length; index += 1) {
    const sample = horizontal ? (row + index) * parentWidth + column : row * parentWidth + column + index;
    chunks.push(parentBytes.subarray(sample * 4, sample * 4 + 4));
  }
  return Buffer.concat(chunks);
}

function sharedBoundaries(parentBytes, width, height, children) {
  const byId = new Map(children.map((child) => [child.id, child]));
  const nw = byId.get('northwest'); const ne = byId.get('northeast');
  const sw = byId.get('southwest'); const se = byId.get('southeast');
  const pairs = [
    { id: 'north-west-east-seam', first: nw, second: ne, column: ne.column, row: 0, length: nw.height, horizontal: true },
    { id: 'south-west-east-seam', first: sw, second: se, column: se.column, row: sw.row, length: sw.height, horizontal: true },
    { id: 'west-north-south-seam', first: nw, second: sw, column: 0, row: sw.row, length: nw.width, horizontal: false },
    { id: 'east-north-south-seam', first: ne, second: se, column: ne.column, row: se.row, length: ne.width, horizontal: false },
  ];
  return pairs.map(({ id, first, second, column, row, length, horizontal }) => {
    const firstColumn = first.column + (horizontal ? first.width - 1 : 0);
    const firstRow = first.row + (horizontal ? 0 : first.height - 1);
    const secondColumn = second.column;
    const secondRow = second.row;
    const a = readSegment(parentBytes, width, firstColumn, firstRow, length, horizontal);
    const b = readSegment(parentBytes, width, secondColumn, secondRow, length, horizontal);
    assert(a.equals(b), `${id} source bytes differ between child views`);
    return { id, childViews: [first.id, second.id], sampleCount: length, byteCount: a.length, sha256: sha256(a), byteIdentical: true, parentStartSample: [column, row], axis: horizontal ? 'northing' : 'easting' };
  });
}

export async function buildFerry3dep2x2ParentPreview({ outputDir = DEFAULT_OUTPUT_DIR, write = true } = {}) {
  const [sourceBytes, horizontalBytes, regionBytes] = await Promise.all([readFile(SOURCE_LOCK_PATH), readFile(HORIZONTAL_LOCK_PATH), readFile(REGION_PATH)]);
  const sourceLock = JSON.parse(sourceBytes); const horizontalLock = JSON.parse(horizontalBytes); const region = JSON.parse(regionBytes);
  assert.equal(region.id, 'sf-ferry-building-hero', 'The committed Ferry region contract is required');
  assert.equal(sourceLock.id, 'sf-ferry-3dep-2023', 'Unexpected source lock');
  assert.equal(horizontalLock.id, 'sf-ferry-3dep-2023-horizontal-crs-v1', 'Unexpected horizontal operation lock');
  assert.equal(horizontalLock.claims.operation.combinedAccuracyMetres, 4, 'The preview must retain the locked 4 m operation accuracy');
  const rawPath = path.join(ROOT, sourceLock.raster.localRawCache);
  assert.equal((await stat(rawPath)).size, sourceLock.raster.bytes, 'Raw TIFF size does not match the source lock');
  const rawHash = await sha256File(rawPath);
  assert.equal(rawHash.bytesRead, sourceLock.raster.bytes, 'Raw TIFF hash pass did not read the locked byte count');
  assert.equal(rawHash.sha256, sourceLock.raster.sha256, 'Raw TIFF SHA-256 does not match the source lock');

  const corners = projectedCorners(sourceLock.requestedCoverageWgs84, horizontalLock);
  const reader = await openGeoTiffWindowReader(rawPath);
  try {
    assert.equal(reader.version, GEO_TIFF_WINDOW_READER_VERSION, 'Unexpected GeoTIFF reader version');
    const xs = corners.map(({ enMetres }) => enMetres[0]); const ys = corners.map(({ enMetres }) => enMetres[1]);
    const requestedModelEnvelope = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const topLeft = reader.modelToPixel(requestedModelEnvelope[0], requestedModelEnvelope[3]);
    const bottomRight = reader.modelToPixel(requestedModelEnvelope[2], requestedModelEnvelope[1]);
    // One full native pixel outside the outward-rounded requested envelope is
    // a deterministic geometric guard; it does not turn the 4 m horizontal
    // operation into a sub-metre claim.
    const column = Math.floor(topLeft.column) - 1;
    const row = Math.floor(topLeft.row) - 1;
    const right = Math.ceil(bottomRight.column) + 1;
    const bottom = Math.ceil(bottomRight.row) + 1;
    const window = await reader.readWindow({ column, row, width: right - column, height: bottom - row });
    const parentBytes = encodeFloat32LittleEndian(window.values);
    let nodataCount = 0; let min = Infinity; let max = -Infinity;
    for (const value of window.values) {
      if (value === window.nodata) nodataCount += 1;
      else { min = Math.min(min, value); max = Math.max(max, value); }
    }
    assert(Number.isFinite(min) && Number.isFinite(max), 'The preview window contains no valid elevations');
    const children = childWindows(window.width, window.height).map((child) => ({
      ...child,
      parentBuffer: { sampleOffset: [child.column, child.row], rowStrideSamples: window.width, sampleEncoding: 'float32-le' },
      sourcePixelWindow: { column: window.column + child.column, row: window.row + child.row, width: child.width, height: child.height },
    }));
    const seams = sharedBoundaries(parentBytes, window.width, window.height, children);
    const topLeftModel = reader.pixelToModel(window.column, window.row);
    const bottomRightModel = reader.pixelToModel(window.column + window.width, window.row + window.height);
    const receipt = {
      schemaVersion: 1,
      kind: 'earth-terrain-parent-raster-engineering-preview',
      status: 'preview-artifact-not-for-runtime-or-manifest-promotion',
      id: 'sf-ferry-3dep-2x2-parent-preview-v1',
      previewOnly: true,
      relationship: { regionId: region.id, requestedCoverageSource: 'sf-ferry-3dep-2023.requestedCoverageWgs84', plannedCoverage: '2x2', runtimePlacement: 'none', manifestPromotion: 'prohibited' },
      source: {
        rawGeoTiff: sourceLock.raster.localRawCache,
        lockedRawSha256: sourceLock.raster.sha256,
        actualRawSha256: rawHash.sha256,
        sourceLockSha256: sha256(sourceBytes),
        sourceBytes: sourceLock.raster.bytes,
        rawFileSizeChecked: true,
        rawHashVerifiedBeforeWindowRead: true,
        rawHashBytesRead: rawHash.bytesRead,
        reader: {
          version: reader.version, boundedRead: true, metadataBytesRead: reader.readStats.metadataBytesRead,
          exactCompressedTileBytesRead: window.bytesRead, totalBytesRead: reader.readStats.totalBytesRead,
          tileIndices: window.tileIndices,
          tileCoordinates: window.tileIndices.map((index) => ({ index, column: index % reader.metadata.columns, row: Math.floor(index / reader.metadata.columns) })),
        },
      },
      horizontalReference: {
        lock: 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json', lockSha256: sha256(horizontalBytes),
        operation: horizontalLock.claims.operation.combinedName, accuracyMetres: horizontalLock.claims.operation.combinedAccuracyMetres,
        targetCrs: 'EPSG:26910', realization: 'not claimed', coordinateEpoch: 'not claimed', subMetreClaim: false,
      },
      verticalDatumUnresolved: true,
      verticalReference: { sourceMetadataDeclaration: sourceLock.coordinateReference.vertical.declaredByProductMetadata, embeddedTiffGeoKeys: 'absent', geoidOrVerticalCrs: 'not resolved' },
      requestedCoverage: { wgs84Bounds: sourceLock.requestedCoverageWgs84, projectedCorners: corners, projectedEnvelopeMetres: requestedModelEnvelope, nativePixelGuard: 1 },
      raster: {
        sampleEncoding: 'float32-le', serialization: 'explicit Buffer.writeFloatLE per sample; host-endian independent', samplesPerPixel: 1, interpolation: 'none; direct native samples', nodata: window.nodata,
        dimensionsPixels: [window.width, window.height], sampleCount: window.values.length, byteLength: parentBytes.length, sha256: sha256(parentBytes),
        nativePixelWindow: { column: window.column, row: window.row, width: window.width, height: window.height },
        affine: { coefficients: [reader.metadata.affine.scaleX, 0, reader.metadata.affine.tiepointX, 0, -reader.metadata.affine.scaleY, reader.metadata.affine.tiepointY], rasterType: reader.metadata.rasterType, modelBoundsAtPixelIsAreaEdges: [topLeftModel.x, bottomRightModel.y, bottomRightModel.x, topLeftModel.y] },
        statistics: { nodataCount, validSampleCount: window.values.length - nodataCount, minMetres: min, maxMetres: max },
      },
      childViews: children,
      sharedBoundaryProof: seams,
      limitations: [
        'Engineering preview only; it is not a production terrain artifact and is not referenced by runtime code or tile manifests.',
        'Horizontal conversion is the locked generic WGS 84-to-EPSG:26910 operation with 4 m accuracy; no sub-metre, realization, or epoch claim is made.',
        'Vertical datum remains unresolved: no vertical CRS, geoid, epoch, or NAVD88 reconciliation is inferred from the GeoTIFF samples.',
      ],
    };
    if (write) {
      await mkdir(outputDir, { recursive: true });
      await Promise.all([writeFile(path.join(outputDir, ARTIFACT_NAME), parentBytes), writeFile(path.join(outputDir, RECEIPT_NAME), jsonBytes(receipt))]);
    }
    return { artifactBytes: parentBytes, receipt, outputDir, artifactPath: path.join(outputDir, ARTIFACT_NAME), receiptPath: path.join(outputDir, RECEIPT_NAME) };
  } finally { await reader.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildFerry3dep2x2ParentPreview();
  process.stdout.write(`${JSON.stringify({ result: 'Ferry 3DEP 2x2 engineering preview built', artifact: path.relative(ROOT, result.artifactPath), receipt: path.relative(ROOT, result.receiptPath), sha256: result.receipt.raster.sha256, sourceTileIndices: result.receipt.source.reader.tileIndices, sourceTileBytesRead: result.receipt.source.reader.exactCompressedTileBytesRead }, null, 2)}\n`);
}
