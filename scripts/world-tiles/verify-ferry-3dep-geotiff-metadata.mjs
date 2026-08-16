/**
 * Verify the metadata envelope of the locked Ferry USGS 3DEP GeoTIFF.
 *
 * This is intentionally a small classic-TIFF IFD/GeoKey parser. It never
 * decodes, decompresses, or samples DEM tiles. --verify-raw sequentially
 * hashes bytes, then reads only metadata ranges. The raw GeoTIFF stays
 * ignored; the committed lock records the exact grid values expected here.
 *
 * Usage:
 *   node scripts/world-tiles/verify-ferry-3dep-geotiff-metadata.mjs
 *   node scripts/world-tiles/verify-ferry-3dep-geotiff-metadata.mjs --verify-raw
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, openSync, readFileSync, readSync, closeSync, createReadStream, fstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const TYPE_BYTES = new Map([[1, 1], [2, 1], [3, 2], [4, 4], [5, 8], [6, 1], [7, 1], [8, 2], [9, 4], [10, 8], [11, 4], [12, 8]]);
const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  samplesPerPixel: 277,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  predictor: 317,
  sampleFormat: 339,
  gdalNoData: 42113,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
  modelTransformation: 34264,
  geoKeyDirectory: 34735,
};
const GEO_KEY = {
  modelType: 1024,
  rasterType: 1025,
  projectedCrs: 3072,
  linearUnits: 3076,
  verticalCrs: 4096,
  verticalCitation: 4097,
  verticalDatum: 4098,
  verticalUnits: 4099,
};

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

function decodeNumbers(buffer, type, count, littleEndian) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const read = {
    1: (offset) => view.getUint8(offset),
    3: (offset) => view.getUint16(offset, littleEndian),
    4: (offset) => view.getUint32(offset, littleEndian),
    5: (offset) => [view.getUint32(offset, littleEndian), view.getUint32(offset + 4, littleEndian)],
    6: (offset) => view.getInt8(offset),
    7: (offset) => view.getUint8(offset),
    8: (offset) => view.getInt16(offset, littleEndian),
    9: (offset) => view.getInt32(offset, littleEndian),
    10: (offset) => [view.getInt32(offset, littleEndian), view.getInt32(offset + 4, littleEndian)],
    11: (offset) => view.getFloat32(offset, littleEndian),
    12: (offset) => view.getFloat64(offset, littleEndian),
  }[type];
  assert(read, `Unsupported TIFF field type ${type}`);
  const step = TYPE_BYTES.get(type);
  return Array.from({ length: count }, (_, index) => read(index * step));
}

function parseTiff(readAt, fileBytes) {
  const header = readAt(0, 8);
  assert.equal(header.subarray(0, 2).toString('ascii'), 'II', 'GeoTIFF must be classic little-endian TIFF (II)');
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  assert.equal(headerView.getUint16(2, true), 42, 'GeoTIFF must use classic TIFF magic 42, not BigTIFF');
  let nextOffset = headerView.getUint32(4, true);
  assert(nextOffset > 0 && nextOffset < fileBytes, 'First TIFF IFD offset is invalid');
  const ifds = [];
  const seen = new Set();
  while (nextOffset) {
    const ifdOffset = nextOffset;
    assert(!seen.has(ifdOffset), `TIFF IFD cycle at offset ${ifdOffset}`);
    seen.add(ifdOffset);
    assert(ifdOffset + 6 <= fileBytes, `TIFF IFD at ${ifdOffset} exceeds file`);
    const countBuffer = readAt(ifdOffset, 2);
    const entryCount = new DataView(countBuffer.buffer, countBuffer.byteOffset, 2).getUint16(0, true);
    const bytes = 2 + entryCount * 12 + 4;
    assert(ifdOffset + bytes <= fileBytes, `TIFF IFD at ${ifdOffset} has invalid entry count`);
    const ifdBuffer = readAt(ifdOffset, bytes);
    const view = new DataView(ifdBuffer.buffer, ifdBuffer.byteOffset, ifdBuffer.byteLength);
    const fields = new Map();
    for (let index = 0; index < entryCount; index += 1) {
      const offset = 2 + index * 12;
      const tag = view.getUint16(offset, true);
      const type = view.getUint16(offset + 2, true);
      const valueCount = view.getUint32(offset + 4, true);
      const size = TYPE_BYTES.get(type);
      assert(size, `TIFF tag ${tag} has unsupported field type ${type}`);
      const valueBytes = valueCount * size;
      assert(Number.isSafeInteger(valueBytes), `TIFF tag ${tag} byte count is unsafe`);
      let valueBuffer;
      if (valueBytes <= 4) {
        valueBuffer = ifdBuffer.subarray(offset + 8, offset + 8 + valueBytes);
      } else {
        const valueOffset = view.getUint32(offset + 8, true);
        assert(valueOffset + valueBytes <= fileBytes, `TIFF tag ${tag} payload exceeds file`);
        valueBuffer = readAt(valueOffset, valueBytes);
      }
      const value = type === 2
        ? valueBuffer.toString('ascii').replace(/\0+$/, '')
        : decodeNumbers(valueBuffer, type, valueCount, true);
      fields.set(tag, { type, count: valueCount, value });
    }
    nextOffset = view.getUint32(2 + entryCount * 12, true);
    ifds.push({ offset: ifdOffset, fields, nextOffset });
  }
  assert(ifds.length > 0, 'GeoTIFF has no IFDs');
  return ifds;
}

function field(ifd, tag, label) {
  const entry = ifd.fields.get(tag);
  assert(entry, `Required TIFF tag ${label} (${tag}) is absent`);
  return entry;
}

function scalar(ifd, tag, label) {
  const entry = field(ifd, tag, label);
  assert.equal(entry.count, 1, `TIFF tag ${label} must have one value`);
  assert(Array.isArray(entry.value), `TIFF tag ${label} must be numeric`);
  return entry.value[0];
}

function parseGeoKeys(ifd) {
  const entry = field(ifd, TAG.geoKeyDirectory, 'GeoKeyDirectoryTag');
  assert.equal(entry.type, 3, 'GeoKeyDirectoryTag must use SHORT values');
  const values = entry.value;
  assert(values.length >= 4, 'GeoKeyDirectoryTag header is truncated');
  assert.deepEqual(values.slice(0, 3), [1, 1, 0], 'Unexpected GeoKeyDirectory header');
  const keyCount = values[3];
  assert.equal(values.length, 4 + keyCount * 4, 'GeoKeyDirectoryTag count does not match key directory');
  const keys = new Map();
  for (let index = 0; index < keyCount; index += 1) {
    const offset = 4 + index * 4;
    const [keyId, tiffTagLocation, count, valueOffset] = values.slice(offset, offset + 4);
    keys.set(keyId, { tiffTagLocation, count, valueOffset });
  }
  return keys;
}

function inlineGeoKey(keys, keyId, label) {
  const key = keys.get(keyId);
  assert(key, `Required GeoKey ${label} (${keyId}) is absent`);
  assert.equal(key.tiffTagLocation, 0, `GeoKey ${label} must be inline`);
  assert.equal(key.count, 1, `GeoKey ${label} must have one value`);
  return key.valueOffset;
}

function assertRasterMetadata(ifds, expected) {
  const main = ifds[0];
  assert.equal(scalar(main, TAG.imageWidth, 'ImageWidth'), expected.width, 'ImageWidth drifted');
  assert.equal(scalar(main, TAG.imageLength, 'ImageLength'), expected.height, 'ImageLength drifted');
  assert.equal(scalar(main, TAG.samplesPerPixel, 'SamplesPerPixel'), 1, 'DEM must have one sample per pixel');
  assert.equal(scalar(main, TAG.bitsPerSample, 'BitsPerSample'), 32, 'DEM samples must be 32-bit');
  assert.equal(scalar(main, TAG.sampleFormat, 'SampleFormat'), 3, 'DEM SampleFormat must be IEEE float (3)');
  assert.equal(scalar(main, TAG.compression, 'Compression'), 5, 'DEM Compression must be LZW (5)');
  assert.equal(scalar(main, TAG.predictor, 'Predictor'), 3, 'DEM Predictor must be floating-point (3)');
  assert.equal(scalar(main, TAG.tileWidth, 'TileWidth'), 512, 'DEM TileWidth must be 512');
  assert.equal(scalar(main, TAG.tileLength, 'TileLength'), 512, 'DEM TileLength must be 512');
  assert.equal(field(main, TAG.tileOffsets, 'TileOffsets').count, expected.tileCount, 'DEM tile offset count drifted');
  assert.equal(field(main, TAG.tileByteCounts, 'TileByteCounts').count, expected.tileCount, 'DEM tile byte-count count drifted');
  assert.equal(field(main, TAG.gdalNoData, 'GDAL_NODATA').value, '-999999', 'DEM nodata value drifted');
  const scaleField = field(main, TAG.modelPixelScale, 'ModelPixelScaleTag');
  const tiepointField = field(main, TAG.modelTiepoint, 'ModelTiepointTag');
  assert.equal(scaleField.type, 12, 'ModelPixelScaleTag must use DOUBLE values');
  assert.equal(tiepointField.type, 12, 'ModelTiepointTag must use DOUBLE values');
  const scale = scaleField.value;
  const tiepoint = tiepointField.value;
  assert.deepEqual(scale, expected.pixelScale, 'ModelPixelScaleTag drifted');
  assert.deepEqual(tiepoint, expected.tiepoint, 'ModelTiepointTag drifted');
  assert(!main.fields.has(TAG.modelTransformation), 'ModelTransformationTag must be absent; affine derives from scale/tiepoint');
  assert.equal(ifds.length - 1, expected.overviewIfdCount, 'GeoTIFF overview IFD count drifted');
  const keys = parseGeoKeys(main);
  assert.equal(inlineGeoKey(keys, GEO_KEY.modelType, 'GTModelTypeGeoKey'), 1, 'Raster must be projected (1)');
  assert.equal(inlineGeoKey(keys, GEO_KEY.rasterType, 'GTRasterTypeGeoKey'), 1, 'Raster must be PixelIsArea (1)');
  assert.equal(inlineGeoKey(keys, GEO_KEY.projectedCrs, 'ProjectedCSTypeGeoKey'), 26910, 'Projected CRS must be EPSG:26910');
  assert.equal(inlineGeoKey(keys, GEO_KEY.linearUnits, 'ProjLinearUnitsGeoKey'), 9001, 'Projected units must be metre (EPSG:9001)');
  assert(![
    GEO_KEY.verticalCrs, GEO_KEY.verticalCitation, GEO_KEY.verticalDatum, GEO_KEY.verticalUnits,
  ].some((keyId) => keys.has(keyId)), 'TIFF must not be represented as having vertical GeoKeys');
  return { overviewIfdCount: ifds.length - 1, geoKeyCount: keys.size };
}

function makeFixture(width = 2) {
  // Minimal IFD-only TIFF: enough to exercise the parser and a controlled
  // one-byte-width drift below. It intentionally has no pixel data.
  const entries = [
    [TAG.imageWidth, 4, 1, width], [TAG.imageLength, 4, 1, 3],
    [TAG.bitsPerSample, 3, 1, 32], [TAG.compression, 3, 1, 5],
    [TAG.samplesPerPixel, 3, 1, 1], [TAG.predictor, 3, 1, 3],
    [TAG.sampleFormat, 3, 1, 3], [TAG.tileWidth, 4, 1, 512], [TAG.tileLength, 4, 1, 512],
  ];
  const ifdOffset = 8;
  const buffer = Buffer.alloc(ifdOffset + 2 + entries.length * 12 + 4);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2); buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(entries.length, ifdOffset);
  entries.forEach(([tag, type, count, value], index) => {
    const offset = ifdOffset + 2 + index * 12;
    buffer.writeUInt16LE(tag, offset); buffer.writeUInt16LE(type, offset + 2); buffer.writeUInt32LE(count, offset + 4);
    if (type === 3) buffer.writeUInt16LE(value, offset + 8); else buffer.writeUInt32LE(value, offset + 8);
  });
  return buffer;
}

function runFixture() {
  const fixture = makeFixture();
  const ifds = parseTiff((offset, length) => fixture.subarray(offset, offset + length), fixture.length);
  assert.equal(scalar(ifds[0], TAG.imageWidth, 'ImageWidth'), 2, 'Fixture width must parse');
  const drift = makeFixture(3);
  assert.throws(() => {
    const driftIfds = parseTiff((offset, length) => drift.subarray(offset, offset + length), drift.length);
    assert.equal(scalar(driftIfds[0], TAG.imageWidth, 'ImageWidth'), 2, 'Fixture width drifted');
  }, /Fixture width drifted/, 'Fixture drift must fail deterministically');
}

runFixture();
const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const grid = lock.raster?.gridEnvelope;
assert.equal(lock.raster?.format, 'GeoTIFF', 'Source lock must identify GeoTIFF');
assert.deepEqual(lock.coverage?.scienceBaseMetadataEnvelope?.wgs84Bounds, lock.coverage?.sourceBoundsWgs84, 'ScienceBase coverage envelope drifted');
assert.deepEqual(grid?.dimensionsPixels, [10012, 10012], 'Lock grid dimensions drifted');
assert.equal(grid?.tiffEncoding, 'classic little-endian TIFF', 'Lock TIFF encoding drifted');
assert.deepEqual(grid?.sampleLayout, {
  samplesPerPixel: 1,
  bitsPerSample: 32,
  sampleFormat: 'IEEE floating point (3)',
  compression: 'LZW (5)',
  predictor: 'floating point (3)',
  nodata: -999999,
}, 'Lock sample layout drifted');
assert.deepEqual(grid?.tileLayout, {
  tilePixels: [512, 512], tileCount: 400, overviewIfdCount: 5, overviewsPresent: true,
}, 'Lock tile layout drifted');
assert.deepEqual(grid?.pixelScaleModelSpace, [1, 1, 0], 'Lock pixel scale drifted');
assert.deepEqual(grid?.modelTiepoint, [0, 0, 0, 549993.9999840065, 4190005.9999845778, 0], 'Lock tiepoint drifted');
assert.equal(grid?.modelTransformationTagPresent, false, 'Lock must state ModelTransformationTag is absent');
assert.deepEqual(grid?.pixelToModelAffine?.coefficients, [1, 0, 549993.9999840065, 0, -1, 4190005.9999845778], 'Lock affine drifted');
assert.deepEqual(grid?.modelBoundsAtPixelIsAreaEdges, [549993.9999840065, 4179993.9999845778, 560005.9999840065, 4190005.9999845778], 'Lock model envelope drifted');
assert.equal(grid?.rasterType, 'PixelIsArea', 'Lock raster type must remain PixelIsArea');
assert.equal(grid?.horizontalEpsg, 26910, 'Lock horizontal EPSG drifted');
assert.equal(grid?.linearUnitEpsg, 9001, 'Lock projected unit must be metre');
assert.equal(grid?.verticalGeoKeysPresent, false, 'Lock must state TIFF has no vertical GeoKeys');
assert.equal(lock.coordinateReference?.vertical?.declaredByProductMetadata, 'NAVD88', 'Lock must retain product XML NAVD88 declaration');
assert.match(lock.coordinateReference?.vertical?.embeddedTiffGeoKeys || '', /absent/, 'Lock must state TIFF vertical GeoKeys are absent');

let raw = { verified: false, reason: 'not requested' };
if (process.argv.includes('--verify-raw')) {
  const rawPath = path.join(ROOT, lock.raster.localRawCache);
  assert(existsSync(rawPath), `Expected raw GeoTIFF is missing: ${lock.raster.localRawCache}`);
  assert.equal(await sha256(rawPath), lock.raster.sha256, 'Raw GeoTIFF SHA-256 does not match source lock');
  const descriptor = openSync(rawPath, 'r');
  try {
    const { size } = fstatSync(descriptor);
    assert.equal(size, lock.raster.bytes, 'Raw GeoTIFF byte count does not match source lock');
    const ifds = parseTiff((offset, length) => {
      const buffer = Buffer.alloc(length);
      const bytes = readSync(descriptor, buffer, 0, length, offset);
      assert.equal(bytes, length, `Short GeoTIFF metadata read at ${offset}`);
      return buffer;
    }, size);
    const metadata = assertRasterMetadata(ifds, {
      width: grid.dimensionsPixels[0], height: grid.dimensionsPixels[1],
      pixelScale: grid.pixelScaleModelSpace,
      tiepoint: grid.modelTiepoint,
      tileCount: grid.tileLayout.tileCount,
      overviewIfdCount: grid.tileLayout.overviewIfdCount,
    });
    raw = { verified: true, path: lock.raster.localRawCache, ...metadata };
  } finally {
    closeSync(descriptor);
  }
}

console.log(JSON.stringify({ result: 'Ferry 3DEP GeoTIFF metadata passed', raw }, null, 2));
