/**
 * Deterministic fixtures and optional locked-raw verification for
 * geotiff-window-reader-v1.mjs.
 *
 * Usage:
 *   node scripts/world-tiles/verify-geotiff-window-reader-v1.mjs
 *   node scripts/world-tiles/verify-geotiff-window-reader-v1.mjs --verify-raw
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GEO_TIFF_WINDOW_READER_VERSION,
  decodeTiffLzw,
  openGeoTiffWindowReader,
  undoFloatingPointPredictor3,
} from './geotiff-window-reader-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW_PATH = path.join(ROOT, 'Data/raw/usgs-3dep/66ce871ad34e98e8a92453cb/USGS_1M_10_x55y419_CA_SanFrancisco_B23.tif');
const TILE = 512;
const TILE_BYTES = TILE * TILE * 4;
const LITERAL_TILE_BYTES = Math.ceil((TILE_BYTES + Math.ceil(TILE_BYTES / 200) + 1) * 9 / 8);

function packCodesMsb(codes) {
  const bytes = Buffer.alloc(Math.ceil(codes.reduce((bits, entry) => bits + entry.width, 0) / 8));
  let bitOffset = 0;
  for (const { code, width } of codes) {
    for (let bit = width - 1; bit >= 0; bit -= 1) {
      if ((code >> bit) & 1) bytes[bitOffset >> 3] |= 1 << (7 - (bitOffset & 7));
      bitOffset += 1;
    }
  }
  return bytes;
}

function literalLzw(bytes) {
  // Small deterministic fixture encoder: frequent Clear codes keep all output
  // codes at 9 bits, while the decoder's width growth is tested independently.
  const codes = [];
  for (let offset = 0; offset < bytes.length; offset += 200) {
    codes.push({ code: 256, width: 9 });
    for (const value of bytes.subarray(offset, offset + 200)) codes.push({ code: value, width: 9 });
  }
  codes.push({ code: 257, width: 9 });
  return packCodesMsb(codes);
}

function predictor3Encode(raw) {
  const encoded = Buffer.allocUnsafe(raw.length);
  for (let row = 0; row < TILE; row += 1) {
    const rowOffset = row * TILE * 4;
    for (let sample = 0; sample < TILE; sample += 1) {
      for (let byte = 0; byte < 4; byte += 1) encoded[rowOffset + (3 - byte) * TILE + sample] = raw[rowOffset + sample * 4 + byte];
    }
    for (let index = TILE * 4 - 1; index > 0; index -= 1) encoded[rowOffset + index] = (encoded[rowOffset + index] - encoded[rowOffset + index - 1]) & 0xff;
  }
  return encoded;
}

function makeTile(tileColumn, tileRow) {
  const tile = Buffer.allocUnsafe(TILE_BYTES);
  for (let y = 0; y < TILE; y += 1) for (let x = 0; x < TILE; x += 1) {
    const column = tileColumn * TILE + x;
    const row = tileRow * TILE + y;
    tile.writeFloatLE(column === 512 && row === 512 ? -999999 : row * 1000 + column, (y * TILE + x) * 4);
  }
  return literalLzw(predictor3Encode(tile));
}

function createFixture({ compression = 5, fillOrder = 1, orientation = 1, rasterType = 1, extraTags = [] } = {}) {
  const tags = [
    [256, 4, 1, 513], [257, 4, 1, 513], [258, 3, 1, 32], [259, 3, 1, compression],
    [266, 3, 1, fillOrder], [274, 3, 1, orientation], [277, 3, 1, 1], [284, 3, 1, 1],
    [317, 3, 1, 3], [322, 3, 1, TILE], [323, 3, 1, TILE], [324, 4, 4, null], [325, 4, 4, null],
    [339, 3, 1, 3], [33550, 12, 3, null], [33922, 12, 6, null], [34735, 3, 8, null], [42113, 2, 8, null],
    ...extraTags,
  ].sort((a, b) => a[0] - b[0]);
  const ifdOffset = 8;
  const ifdBytes = 2 + tags.length * 12 + 4;
  let payloadOffset = ifdOffset + ifdBytes;
  const scaleOffset = payloadOffset; payloadOffset += 24;
  const tiepointOffset = payloadOffset; payloadOffset += 48;
  const nodataOffset = payloadOffset; payloadOffset += 8;
  const geoKeysOffset = payloadOffset; payloadOffset += 16;
  const offsetsOffset = payloadOffset; payloadOffset += 16;
  const countsOffset = payloadOffset; payloadOffset += 16;
  const tiles = [makeTile(0, 0), makeTile(1, 0), makeTile(0, 1), makeTile(1, 1)];
  const offsets = [];
  for (const tile of tiles) { offsets.push(payloadOffset); payloadOffset += tile.length; }
  const file = Buffer.alloc(payloadOffset);
  file.write('II', 0, 'ascii'); file.writeUInt16LE(42, 2); file.writeUInt32LE(ifdOffset, 4);
  file.writeUInt16LE(tags.length, ifdOffset);
  tags.forEach(([tag, type, count, value], index) => {
    const entry = ifdOffset + 2 + index * 12;
    file.writeUInt16LE(tag, entry); file.writeUInt16LE(type, entry + 2); file.writeUInt32LE(count, entry + 4);
    const resolved = tag === 324 ? offsetsOffset : tag === 325 ? countsOffset : tag === 33550 ? scaleOffset : tag === 33922 ? tiepointOffset : tag === 34735 ? geoKeysOffset : tag === 42113 ? nodataOffset : value;
    if (type === 3 && count === 1) file.writeUInt16LE(resolved, entry + 8); else file.writeUInt32LE(resolved, entry + 8);
  });
  [1, 1, 0].forEach((value, index) => file.writeDoubleLE(value, scaleOffset + index * 8));
  [0, 0, 0, 100, 200, 0].forEach((value, index) => file.writeDoubleLE(value, tiepointOffset + index * 8));
  file.write('-999999\0', nodataOffset, 'ascii');
  [1, 1, 0, 1, 1025, 0, 1, rasterType].forEach((value, index) => file.writeUInt16LE(value, geoKeysOffset + index * 2));
  offsets.forEach((value, index) => file.writeUInt32LE(value, offsetsOffset + index * 4));
  tiles.forEach((tile, index) => file.writeUInt32LE(tile.length, countsOffset + index * 4));
  tiles.forEach((tile, index) => tile.copy(file, offsets[index]));
  return file;
}

function patchIfdCount(fixture, tag, count) {
  const patched = Buffer.from(fixture);
  const ifdOffset = patched.readUInt32LE(4);
  const entryCount = patched.readUInt16LE(ifdOffset);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (patched.readUInt16LE(entryOffset) !== tag) continue;
    patched.writeUInt32LE(count, entryOffset + 4);
    patched.writeUInt32LE(0, entryOffset + 8);
    return patched;
  }
  throw new Error(`Fixture tag ${tag} was not found`);
}

function testLzw() {
  assert.deepEqual(packCodesMsb([{ code: 256, width: 9 }, { code: 65, width: 9 }, { code: 257, width: 9 }]), Buffer.from([0x80, 0x10, 0x60, 0x20]), 'LZW codes must pack MSB-first');
  assert.equal(decodeTiffLzw(Buffer.from([0x80, 0x10, 0x60, 0x20]), 1).toString('ascii'), 'A', 'LZW Clear/End fixture must decode');
  const codes = [{ code: 256, width: 9 }];
  let width = 9; let nextCode = 258; let previous = -1;
  for (let index = 0; index < 600; index += 1) {
    codes.push({ code: index & 0xff, width });
    if (previous !== -1) { nextCode += 1; if (nextCode === (1 << width) - 1) width += 1; }
    previous = index & 0xff;
  }
  codes.push({ code: 257, width });
  assert.deepEqual([...decodeTiffLzw(packCodesMsb(codes), 600)], Array.from({ length: 600 }, (_, index) => index & 0xff), 'LZW width growth fixture must decode');
}

async function testFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'sf-geotiff-window-'));
  const fixturePath = path.join(directory, 'fixture.tif');
  const unsupportedPath = path.join(directory, 'unsupported.tif');
  const bigTiffPath = path.join(directory, 'bigtiff.tif');
  let baselineMetadataBytes;
  try {
    await writeFile(fixturePath, createFixture());
    const reader = await openGeoTiffWindowReader(fixturePath);
    try {
      assert.equal(reader.version, GEO_TIFF_WINDOW_READER_VERSION);
      assert.equal(reader.metadata.rasterType, 'PixelIsArea');
      baselineMetadataBytes = reader.readStats.metadataBytesRead;
      assert.deepEqual(reader.pixelToModel(2, 3), { x: 102, y: 197 }, 'pixel-to-model affine must preserve PixelIsArea coordinates');
      assert.deepEqual(reader.modelToPixel(102, 197), { column: 2, row: 3 }, 'model-to-pixel affine must invert native pixel mapping');
      const window = await reader.readWindow({ column: 511, row: 511, width: 2, height: 2 });
      assert.deepEqual(window.tileIndices, [0, 1, 2, 3], 'edge crop must read exactly its four intersecting tiles');
      assert.deepEqual([...window.values], [511511, 511512, 512511, -999999], 'edge crop must exclude padded tile pixels and retain nodata');
      assert.equal(window.nodata, -999999);
      assert.equal(window.bytesRead, reader.readStats.tileBytesRead, 'fixture window byte count must include only selected tile ranges');
    } finally { await reader.close(); }
    const boundedReader = await openGeoTiffWindowReader(fixturePath);
    try {
      const [first, second] = await Promise.all([
        boundedReader.readWindow({ column: 0, row: 0, width: 1, height: 1 }),
        boundedReader.readWindow({ column: 512, row: 512, width: 1, height: 1 }),
      ]);
      assert.deepEqual(first.tileIndices, [0]);
      assert.deepEqual(second.tileIndices, [3]);
      assert.equal(first.bytesRead, LITERAL_TILE_BYTES, 'first concurrent call must report exactly its one tile range');
      assert.equal(second.bytesRead, LITERAL_TILE_BYTES, 'second concurrent call must report exactly its one tile range');
      assert.equal(boundedReader.readStats.tileBytesRead, first.bytesRead + second.bytesRead, 'cumulative tile stats must include both concurrent calls');
      assert(boundedReader.readStats.totalBytesRead < (await readFile(fixturePath)).byteLength, 'one-tile window reader must not read the full TIFF');
    } finally { await boundedReader.close(); }
    await writeFile(unsupportedPath, createFixture({ compression: 1 }));
    await assert.rejects(openGeoTiffWindowReader(unsupportedPath), /Compression must be LZW/, 'non-LZW TIFF layouts must reject explicitly');
    await writeFile(unsupportedPath, createFixture({ rasterType: 2 }));
    await assert.rejects(openGeoTiffWindowReader(unsupportedPath), /PixelIsArea.*PixelIsPoint/, 'PixelIsPoint rasters must reject explicitly');
    await writeFile(unsupportedPath, createFixture({ orientation: 4 }));
    await assert.rejects(openGeoTiffWindowReader(unsupportedPath), /Orientation must be top-left/, 'non-default orientation must reject explicitly');
    await writeFile(unsupportedPath, createFixture({ fillOrder: 2 }));
    await assert.rejects(openGeoTiffWindowReader(unsupportedPath), /FillOrder must be MSB-to-LSB/, 'non-default fill order must reject explicitly');
    await writeFile(unsupportedPath, createFixture({ extraTags: [[259, 3, 1, 5]] }));
    await assert.rejects(openGeoTiffWindowReader(unsupportedPath), /tag 259 is duplicated/, 'duplicate known tags must reject before value parsing');
    await writeFile(unsupportedPath, createFixture({ extraTags: [[65000, 2, 16 * 1024 * 1024, 0], [65000, 2, 16 * 1024 * 1024, 0]] }));
    await assert.rejects(openGeoTiffWindowReader(unsupportedPath), /tag 65000 is duplicated/, 'duplicate unknown tags must reject before whitelist skipping');
    await writeFile(unsupportedPath, createFixture({
      extraTags: [[65000, 2, 16 * 1024 * 1024, 0], [65001, 2, 16 * 1024 * 1024, 0], [65002, 2, 16 * 1024 * 1024, 0]],
    }));
    const unknownReader = await openGeoTiffWindowReader(unsupportedPath);
    try {
      assert.equal(unknownReader.readStats.metadataBytesRead, baselineMetadataBytes + 36, 'unknown 16 MiB payload claims must add only their three IFD entries, with no payload I/O');
    } finally { await unknownReader.close(); }
    await writeFile(unsupportedPath, createFixture({
      extraTags: Array.from({ length: 47 }, (_, index) => [60000 + index, 2, 16 * 1024 * 1024, 0]),
    }));
    await assert.rejects(openGeoTiffWindowReader(unsupportedPath), /maximum is 64/, 'oversized IFD entry tables must reject before payload reads');
    await writeFile(unsupportedPath, patchIfdCount(createFixture(), 34735, 600000));
    await assert.rejects(openGeoTiffWindowReader(unsupportedPath), /parsed metadata payloads exceed/, 'aggregate parsed metadata must reject before payload reads');
    const bigTiffHeader = Buffer.alloc(8); bigTiffHeader.write('II', 0, 'ascii'); bigTiffHeader.writeUInt16LE(43, 2);
    await writeFile(bigTiffPath, bigTiffHeader);
    await assert.rejects(openGeoTiffWindowReader(bigTiffPath), /not BigTIFF/, 'BigTIFF layouts must reject explicitly');
  } finally {
    try { await unlink(fixturePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await unlink(unsupportedPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await unlink(bigTiffPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rmdir(directory);
  }
}

async function verifyRaw() {
  const reader = await openGeoTiffWindowReader(RAW_PATH);
  try {
    assert.deepEqual([reader.metadata.width, reader.metadata.height, reader.metadata.tileWidth, reader.metadata.tileHeight, reader.metadata.nodata], [10012, 10012, 512, 512, -999999]);
    assert.deepEqual(reader.pixelToModel(0, 0), { x: 549993.9999840065, y: 4190005.9999845778 });
    const window = await reader.readWindow({ column: 4800, row: 2800, width: 4, height: 3 });
    assert.deepEqual([...window.values], [
      1.3569660186767578, 1.6383298635482788, 1.9727075099945068, 2.2272086143493652,
      1.694993257522583, 2.050145149230957, 2.422823667526245, 2.706949472427368,
      2.134633779525757, 2.35750150680542, 2.745844602584839, 2.954916477203369,
    ], 'locked raw native-pixel window drifted');
    const bytes = Buffer.alloc(window.values.length * 4);
    window.values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), '32cf2be9e5a271be21fa4933cb5e57fbbb22264432f668b60045cf0163df9cd8', 'locked raw native-pixel hash drifted');
    assert.deepEqual(window.tileIndices, [109]);
    assert.equal(window.bytesRead, 493434, 'locked tile byte-range drifted');
    assert(reader.readStats.totalBytesRead < 86461076, 'raw verification must use bounded range reads, not the complete TIFF');
    return { tileBytesRead: window.bytesRead, metadataBytesRead: reader.readStats.metadataBytesRead };
  } finally { await reader.close(); }
}

testLzw();
const predictorProbe = Buffer.alloc(TILE_BYTES); predictorProbe.writeFloatLE(1.5, 0); predictorProbe.writeFloatLE(-2.25, 4);
const predictorDecoded = undoFloatingPointPredictor3(predictor3Encode(predictorProbe));
assert.equal(predictorDecoded.readFloatLE(0), 1.5, 'little-endian Predictor=3 first float must restore');
assert.equal(predictorDecoded.readFloatLE(4), -2.25, 'little-endian Predictor=3 horizontal float delta must restore');
await testFixture();
const raw = process.argv.includes('--verify-raw') ? await verifyRaw() : { verified: false, reason: 'pass --verify-raw to require the ignored locked raster' };
console.log(JSON.stringify({ result: 'GeoTIFF window reader v1 passed', raw }, null, 2));
