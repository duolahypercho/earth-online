/**
 * Versioned, dependency-free reader for the locked classic little-endian DEM
 * GeoTIFF. It reads TIFF metadata and only the compressed tile ranges that a
 * requested pixel window intersects. It deliberately has no CRS conversion.
 */
import { open } from 'node:fs/promises';

export const GEO_TIFF_WINDOW_READER_VERSION = '1.0.0';

const TYPE_BYTES = new Map([[1, 1], [2, 1], [3, 2], [4, 4], [11, 4], [12, 8]]);
const TAG = {
  imageWidth: 256, imageLength: 257, bitsPerSample: 258, compression: 259,
  fillOrder: 266, orientation: 274, samplesPerPixel: 277, planarConfiguration: 284, predictor: 317,
  tileWidth: 322, tileLength: 323, tileOffsets: 324, tileByteCounts: 325,
  sampleFormat: 339, modelPixelScale: 33550, modelTiepoint: 33922,
  modelTransformation: 34264, geoKeyDirectory: 34735, gdalNoData: 42113,
};
const PARSED_TAGS = new Set(Object.values(TAG));
const TILE_PIXELS = 512;
const FLOAT_BYTES = 4;
const TILE_UNCOMPRESSED_BYTES = TILE_PIXELS * TILE_PIXELS * FLOAT_BYTES;
const MAX_SAFE_RANGE_BYTES = 16 * 1024 * 1024;
const MAX_IFD_ENTRIES = 64;
const MAX_METADATA_PAYLOAD_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(`Unsupported GeoTIFF layout: ${message}`);
}

function assertLayout(condition, message) {
  if (!condition) fail(message);
}

function positiveInteger(value, label) {
  assertLayout(Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function scalar(fields, tag, name, type) {
  const field = fields.get(tag);
  assertLayout(field, `missing ${name} tag (${tag})`);
  assertLayout(field.count === 1, `${name} must contain one value`);
  const permittedTypes = Array.isArray(type) ? type : [type];
  assertLayout(type === undefined || permittedTypes.includes(field.type), `${name} must use TIFF type ${permittedTypes.join(' or ')}`);
  assertLayout(Array.isArray(field.value), `${name} must be numeric`);
  return field.value[0];
}

function numericArray(fields, tag, name, type, count) {
  const field = fields.get(tag);
  assertLayout(field, `missing ${name} tag (${tag})`);
  assertLayout(field.type === type && field.count === count && Array.isArray(field.value), `${name} must be ${count} TIFF type-${type} values`);
  return field.value;
}

function optionalScalar(fields, tag, name, type, defaultValue) {
  return fields.has(tag) ? scalar(fields, tag, name, type) : defaultValue;
}

function decodeNumeric(buffer, type, count) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const read = {
    1: (offset) => view.getUint8(offset),
    3: (offset) => view.getUint16(offset, true),
    4: (offset) => view.getUint32(offset, true),
    11: (offset) => view.getFloat32(offset, true),
    12: (offset) => view.getFloat64(offset, true),
  }[type];
  assertLayout(read, `TIFF field type ${type} is unsupported`);
  const step = TYPE_BYTES.get(type);
  return Array.from({ length: count }, (_, index) => read(index * step));
}

async function readExactly(handle, offset, length, readStats, kind) {
  assertLayout(Number.isSafeInteger(offset) && offset >= 0, `${kind} offset is invalid`);
  assertLayout(Number.isSafeInteger(length) && length >= 0 && length <= MAX_SAFE_RANGE_BYTES, `${kind} read length is invalid`);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  if (bytesRead !== length) throw new Error(`Short ${kind} range read at ${offset}: wanted ${length}, got ${bytesRead}`);
  readStats.totalBytesRead += bytesRead;
  readStats[kind] += bytesRead;
  return buffer;
}

async function parseMainIfd(handle, fileBytes, readStats) {
  const header = await readExactly(handle, 0, 8, readStats, 'metadataBytesRead');
  assertLayout(header.subarray(0, 2).toString('ascii') === 'II', 'only classic little-endian TIFF (II) is supported');
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  assertLayout(headerView.getUint16(2, true) === 42, 'only classic TIFF magic 42 is supported (not BigTIFF)');
  const ifdOffset = headerView.getUint32(4, true);
  assertLayout(ifdOffset > 0 && ifdOffset + 2 <= fileBytes, 'first IFD offset is invalid');

  const countBuffer = await readExactly(handle, ifdOffset, 2, readStats, 'metadataBytesRead');
  const entryCount = new DataView(countBuffer.buffer, countBuffer.byteOffset, 2).getUint16(0, true);
  assertLayout(entryCount <= MAX_IFD_ENTRIES, `main IFD has ${entryCount} entries; maximum is ${MAX_IFD_ENTRIES}`);
  const ifdBytes = 2 + entryCount * 12 + 4;
  assertLayout(ifdOffset + ifdBytes <= fileBytes, 'main IFD exceeds the file');
  const ifd = await readExactly(handle, ifdOffset, ifdBytes, readStats, 'metadataBytesRead');
  const view = new DataView(ifd.buffer, ifd.byteOffset, ifd.byteLength);
  const descriptors = [];
  const seenTags = new Set();
  let aggregatePayloadBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = 2 + index * 12;
    const tag = view.getUint16(entryOffset, true);
    assertLayout(!seenTags.has(tag), `tag ${tag} is duplicated`);
    seenTags.add(tag);
    // Unknown fields are intentionally ignored without inspecting or reading
    // their claimed payloads. Only fields used by this locked-layout reader
    // contribute to the bounded metadata budget below.
    if (!PARSED_TAGS.has(tag)) continue;
    const type = view.getUint16(entryOffset + 2, true);
    const count = view.getUint32(entryOffset + 4, true);
    const bytesPerValue = TYPE_BYTES.get(type);
    assertLayout(bytesPerValue, `tag ${tag} uses unsupported TIFF field type ${type}`);
    const valueBytes = count * bytesPerValue;
    assertLayout(Number.isSafeInteger(valueBytes), `tag ${tag} has unsafe value length`);
    let valueOffset = null;
    if (valueBytes > 4) {
      aggregatePayloadBytes += valueBytes;
      assertLayout(aggregatePayloadBytes <= MAX_METADATA_PAYLOAD_BYTES, `parsed metadata payloads exceed ${MAX_METADATA_PAYLOAD_BYTES} bytes`);
      valueOffset = view.getUint32(entryOffset + 8, true);
      assertLayout(valueOffset + valueBytes <= fileBytes, `tag ${tag} value range exceeds the file`);
    }
    descriptors.push({ tag, type, count, valueBytes, valueOffset, entryOffset });
  }

  const entries = new Map();
  for (const { tag, type, count, valueBytes, valueOffset, entryOffset } of descriptors) {
    let valueBuffer;
    if (valueBytes <= 4) valueBuffer = ifd.subarray(entryOffset + 8, entryOffset + 8 + valueBytes);
    else valueBuffer = await readExactly(handle, valueOffset, valueBytes, readStats, 'metadataBytesRead');
    const value = type === 2 ? valueBuffer.toString('ascii').replace(/\0+$/, '') : decodeNumeric(valueBuffer, type, count);
    entries.set(tag, { type, count, value });
  }
  return entries;
}

function validateLayout(fields, fileBytes) {
  const width = positiveInteger(scalar(fields, TAG.imageWidth, 'ImageWidth', [3, 4]), 'ImageWidth');
  const height = positiveInteger(scalar(fields, TAG.imageLength, 'ImageLength', [3, 4]), 'ImageLength');
  assertLayout(scalar(fields, TAG.bitsPerSample, 'BitsPerSample', 3) === 32, 'BitsPerSample must be 32');
  assertLayout(scalar(fields, TAG.compression, 'Compression', 3) === 5, 'Compression must be LZW (5)');
  assertLayout(optionalScalar(fields, TAG.fillOrder, 'FillOrder', 3, 1) === 1, 'FillOrder must be MSB-to-LSB (1)');
  assertLayout(optionalScalar(fields, TAG.orientation, 'Orientation', 3, 1) === 1, 'Orientation must be top-left (1)');
  assertLayout(scalar(fields, TAG.samplesPerPixel, 'SamplesPerPixel', 3) === 1, 'SamplesPerPixel must be 1');
  assertLayout(scalar(fields, TAG.planarConfiguration, 'PlanarConfiguration', 3) === 1, 'PlanarConfiguration must be chunky (1)');
  assertLayout(scalar(fields, TAG.sampleFormat, 'SampleFormat', 3) === 3, 'SampleFormat must be IEEE float (3)');
  assertLayout(scalar(fields, TAG.predictor, 'Predictor', 3) === 3, 'Predictor must be floating point (3)');
  assertLayout(scalar(fields, TAG.tileWidth, 'TileWidth', [3, 4]) === TILE_PIXELS, `TileWidth must be ${TILE_PIXELS}`);
  assertLayout(scalar(fields, TAG.tileLength, 'TileLength', [3, 4]) === TILE_PIXELS, `TileLength must be ${TILE_PIXELS}`);
  assertLayout(!fields.has(TAG.modelTransformation), 'ModelTransformationTag is not supported; require PixelScale plus Tiepoint');
  const scale = numericArray(fields, TAG.modelPixelScale, 'ModelPixelScaleTag', 12, 3);
  const tiepoint = numericArray(fields, TAG.modelTiepoint, 'ModelTiepointTag', 12, 6);
  assertLayout(scale.every(Number.isFinite) && tiepoint.every(Number.isFinite) && scale[0] !== 0 && scale[1] !== 0, 'affine values must be finite with non-zero pixel scale');
  const nodataField = fields.get(TAG.gdalNoData);
  assertLayout(nodataField?.type === 2 && nodataField.value === '-999999', 'GDAL_NODATA must be ASCII -999999');
  const geoKeys = numericArray(fields, TAG.geoKeyDirectory, 'GeoKeyDirectoryTag', 3, fields.get(TAG.geoKeyDirectory)?.count);
  assertLayout(geoKeys.length >= 4 && geoKeys[0] === 1 && geoKeys[1] === 1 && geoKeys[2] === 0, 'GeoKeyDirectoryTag header is unsupported');
  const geoKeyCount = geoKeys[3];
  assertLayout(geoKeys.length === 4 + geoKeyCount * 4, 'GeoKeyDirectoryTag count is inconsistent');
  let rasterType = null;
  const seenGeoKeys = new Set();
  for (let index = 0; index < geoKeyCount; index += 1) {
    const offset = 4 + index * 4;
    const keyId = geoKeys[offset];
    assertLayout(!seenGeoKeys.has(keyId), `GeoKey ${keyId} is duplicated`);
    seenGeoKeys.add(keyId);
    if (keyId === 1025) {
      assertLayout(geoKeys[offset + 1] === 0 && geoKeys[offset + 2] === 1, 'GTRasterTypeGeoKey must be one inline value');
      rasterType = geoKeys[offset + 3];
    }
  }
  assertLayout(rasterType === 1, 'GTRasterTypeGeoKey must be PixelIsArea (1), not PixelIsPoint');
  const columns = Math.ceil(width / TILE_PIXELS);
  const rows = Math.ceil(height / TILE_PIXELS);
  const expectedTileCount = columns * rows;
  const offsets = numericArray(fields, TAG.tileOffsets, 'TileOffsets', 4, expectedTileCount);
  const byteCounts = numericArray(fields, TAG.tileByteCounts, 'TileByteCounts', 4, expectedTileCount);
  for (let index = 0; index < expectedTileCount; index += 1) {
    assertLayout(offsets[index] > 0 && offsets[index] < fileBytes, `tile ${index} offset is invalid`);
    assertLayout(byteCounts[index] > 0 && byteCounts[index] <= MAX_SAFE_RANGE_BYTES && offsets[index] + byteCounts[index] <= fileBytes, `tile ${index} byte count is invalid`);
  }
  return {
    width, height, tileWidth: TILE_PIXELS, tileHeight: TILE_PIXELS, columns, rows,
    tileOffsets: offsets, tileByteCounts: byteCounts, nodata: -999999, rasterType: 'PixelIsArea',
    affine: { scaleX: scale[0], scaleY: scale[1], tiepointColumn: tiepoint[0], tiepointRow: tiepoint[1], tiepointX: tiepoint[3], tiepointY: tiepoint[4] },
  };
}

/** Decode TIFF LZW: MSB-first packed codes, clear=256, end=257, max 12-bit. */
export function decodeTiffLzw(compressed, expectedBytes) {
  if (!Buffer.isBuffer(compressed) && !(compressed instanceof Uint8Array)) throw new TypeError('compressed must be bytes');
  positiveInteger(expectedBytes, 'expectedBytes');
  const output = Buffer.allocUnsafe(expectedBytes);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let bitOffset = 0;
  let codeWidth = 9;
  let nextCode = 258;
  let previous = -1;
  let outputOffset = 0;
  let ended = false;

  const readCode = () => {
    if (bitOffset + codeWidth > compressed.length * 8) return null;
    let code = 0;
    for (let bit = 0; bit < codeWidth; bit += 1) {
      const absoluteBit = bitOffset + bit;
      code = (code << 1) | ((compressed[absoluteBit >> 3] >> (7 - (absoluteBit & 7))) & 1);
    }
    bitOffset += codeWidth;
    return code;
  };

  while (true) {
    const inputCode = readCode();
    if (inputCode === null) throw new Error('Invalid TIFF LZW stream: missing end code');
    if (inputCode === 256) {
      codeWidth = 9; nextCode = 258; previous = -1;
      continue;
    }
    if (inputCode === 257) { ended = true; break; }
    if (inputCode > nextCode || inputCode >= 4096) throw new Error(`Invalid TIFF LZW stream: code ${inputCode} is not in the dictionary`);
    if (previous === -1 && inputCode >= 256) throw new Error('Invalid TIFF LZW stream: first code after clear must be a byte');

    let code = inputCode;
    let stackLength = 0;
    let first;
    if (code === nextCode) {
      assertLayout(previous !== -1, 'invalid LZW KwKwK code after clear');
      code = previous;
      // first is resolved below; it is appended once the old string is expanded.
      stack[stackLength++] = 0;
    }
    while (code >= 256) {
      if (code >= nextCode || stackLength >= stack.length - 1) throw new Error('Invalid TIFF LZW stream: malformed dictionary chain');
      stack[stackLength++] = suffix[code];
      code = prefix[code];
    }
    first = code;
    stack[stackLength++] = first;
    if (inputCode === nextCode) stack[0] = first;
    if (outputOffset + stackLength > output.length) throw new Error('Invalid TIFF LZW stream: decoded bytes exceed tile size');
    while (stackLength) output[outputOffset++] = stack[--stackLength];

    if (previous !== -1 && nextCode < 4096) {
      prefix[nextCode] = previous;
      suffix[nextCode] = first;
      nextCode += 1;
      // TIFF's LZW dialect uses the historical early width change: the next
      // emitted code widens when dictionary index 2^width - 1 is assigned.
      if (nextCode === (1 << codeWidth) - 1 && codeWidth < 12) codeWidth += 1;
    }
    previous = inputCode;
  }
  if (!ended || outputOffset !== output.length) throw new Error(`Invalid TIFF LZW stream: decoded ${outputOffset} bytes, expected ${output.length}`);
  return output;
}

/** Undo TIFF Predictor=3 for one little-endian float32, chunky-sample tile. */
export function undoFloatingPointPredictor3(encoded) {
  assertLayout(encoded.length === TILE_UNCOMPRESSED_BYTES, 'Predictor=3 tile byte length is invalid');
  const restored = Buffer.from(encoded);
  const interleaved = Buffer.allocUnsafe(restored.length);
  for (let row = 0; row < TILE_PIXELS; row += 1) {
    const rowOffset = row * TILE_PIXELS * FLOAT_BYTES;
    // Predictor=3 differences the reshuffled byte stream horizontally for a
    // whole row (including plane boundaries), then restores the four planes.
    for (let offset = 1; offset < TILE_PIXELS * FLOAT_BYTES; offset += 1) restored[rowOffset + offset] = (restored[rowOffset + offset] + restored[rowOffset + offset - 1]) & 0xff;
    for (let sample = 0; sample < TILE_PIXELS; sample += 1) {
      for (let byte = 0; byte < FLOAT_BYTES; byte += 1) interleaved[rowOffset + sample * FLOAT_BYTES + byte] = restored[rowOffset + (FLOAT_BYTES - byte - 1) * TILE_PIXELS + sample];
    }
  }
  return interleaved;
}

export async function openGeoTiffWindowReader(filePath) {
  const handle = await open(filePath, 'r');
  const readStats = { totalBytesRead: 0, metadataBytesRead: 0, tileBytesRead: 0 };
  try {
    const fileBytes = (await handle.stat()).size;
    const fields = await parseMainIfd(handle, fileBytes, readStats);
    const metadata = validateLayout(fields, fileBytes);
    const { tileOffsets, tileByteCounts, ...publicMetadata } = metadata;
    let closed = false;
    const ensureOpen = () => { if (closed) throw new Error('GeoTIFF window reader is closed'); };
    return {
      version: GEO_TIFF_WINDOW_READER_VERSION,
      metadata: publicMetadata,
      readStats,
      pixelToModel(column, row) {
        ensureOpen();
        assertLayout(Number.isFinite(column) && Number.isFinite(row), 'pixel coordinates must be finite');
        const affine = metadata.affine;
        return {
          x: affine.tiepointX + (column - affine.tiepointColumn) * affine.scaleX,
          y: affine.tiepointY - (row - affine.tiepointRow) * affine.scaleY,
        };
      },
      modelToPixel(x, y) {
        ensureOpen();
        assertLayout(Number.isFinite(x) && Number.isFinite(y), 'model coordinates must be finite');
        const affine = metadata.affine;
        return {
          column: affine.tiepointColumn + (x - affine.tiepointX) / affine.scaleX,
          row: affine.tiepointRow + (affine.tiepointY - y) / affine.scaleY,
        };
      },
      async readWindow({ column, row, width, height }) {
        ensureOpen();
        [column, row, width, height].forEach((value, index) => assertLayout(Number.isInteger(value), `window value ${index} must be an integer`));
        assertLayout(width > 0 && height > 0 && column >= 0 && row >= 0 && column + width <= metadata.width && row + height <= metadata.height, 'window must be a non-empty native pixel rectangle inside the image');
        const output = new Float32Array(width * height);
        const firstTileColumn = Math.floor(column / TILE_PIXELS);
        const lastTileColumn = Math.floor((column + width - 1) / TILE_PIXELS);
        const firstTileRow = Math.floor(row / TILE_PIXELS);
        const lastTileRow = Math.floor((row + height - 1) / TILE_PIXELS);
        const tileIndices = [];
        for (let tileRow = firstTileRow; tileRow <= lastTileRow; tileRow += 1) for (let tileColumn = firstTileColumn; tileColumn <= lastTileColumn; tileColumn += 1) tileIndices.push(tileRow * metadata.columns + tileColumn);
        let windowBytesRead = 0;
        for (const tileIndex of tileIndices) {
          const compressed = await readExactly(handle, metadata.tileOffsets[tileIndex], metadata.tileByteCounts[tileIndex], readStats, 'tileBytesRead');
          windowBytesRead += compressed.length;
          const tile = undoFloatingPointPredictor3(decodeTiffLzw(compressed, TILE_UNCOMPRESSED_BYTES));
          const tileColumn = tileIndex % metadata.columns;
          const tileRow = Math.floor(tileIndex / metadata.columns);
          const imageLeft = tileColumn * TILE_PIXELS;
          const imageTop = tileRow * TILE_PIXELS;
          const left = Math.max(column, imageLeft);
          const right = Math.min(column + width, metadata.width, imageLeft + TILE_PIXELS);
          const top = Math.max(row, imageTop);
          const bottom = Math.min(row + height, metadata.height, imageTop + TILE_PIXELS);
          for (let y = top; y < bottom; y += 1) {
            const tileOffset = ((y - imageTop) * TILE_PIXELS + left - imageLeft) * FLOAT_BYTES;
            const destination = (y - row) * width + left - column;
            for (let x = left; x < right; x += 1) output[destination + x - left] = tile.readFloatLE(tileOffset + (x - left) * FLOAT_BYTES);
          }
        }
        return { column, row, width, height, values: output, nodata: metadata.nodata, tileIndices, bytesRead: windowBytesRead };
      },
      async close() { if (!closed) { closed = true; await handle.close(); } },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
