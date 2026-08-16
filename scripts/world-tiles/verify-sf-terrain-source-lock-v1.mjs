import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGeoTiffWindowReader } from './geotiff-window-reader-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lockArgument = process.argv[2];
assert(lockArgument, 'Usage: node verify-sf-terrain-source-lock-v1.mjs <source-lock.json>');
const lockPath = path.resolve(ROOT, lockArgument);
const lockBytes = await readFile(lockPath);
const lock = JSON.parse(lockBytes);
assert.equal(lock.kind, 'earth-terrain-source-lock');
assert.equal(lock.status, 'source-locked-not-built');
assert.equal(lock.raster.format, 'GeoTIFF');
assert.match(lock.raster.sha256, /^[a-f0-9]{64}$/);
assert.equal(lock.raster.gridEnvelope.horizontalEpsg, 26910);
assert.equal(lock.raster.gridEnvelope.linearUnitEpsg, 9001);
assert.equal(lock.raster.gridEnvelope.rasterType, 'PixelIsArea');
assert.equal(lock.raster.gridEnvelope.verticalGeoKeysPresent, false);
assert.match(lock.coordinateReference.vertical.geoidAndEpochStatus, /not locked/);

const rawPath = path.resolve(ROOT, lock.raster.localRawCache);
const rawBytes = await readFile(rawPath);
assert.equal(rawBytes.length, lock.raster.bytes, 'Raw GeoTIFF byte count drifted');
assert.equal(createHash('sha256').update(rawBytes).digest('hex'), lock.raster.sha256, 'Raw GeoTIFF hash drifted');
const reader = await openGeoTiffWindowReader(rawPath);
try {
  const metadata = reader.metadata;
  assert.deepEqual([metadata.width, metadata.height], lock.raster.gridEnvelope.dimensionsPixels);
  assert.deepEqual([metadata.tileWidth, metadata.tileHeight], lock.raster.gridEnvelope.tileLayout.tilePixels);
  assert.equal(metadata.nodata, lock.raster.gridEnvelope.sampleLayout.nodata);
  assert.equal(metadata.rasterType, lock.raster.gridEnvelope.rasterType);
  assert.deepEqual([metadata.affine.scaleX, metadata.affine.scaleY, 0], lock.raster.gridEnvelope.pixelScaleModelSpace);
  assert.deepEqual([metadata.affine.tiepointColumn, metadata.affine.tiepointRow, 0, metadata.affine.tiepointX, metadata.affine.tiepointY, 0], lock.raster.gridEnvelope.modelTiepoint);
  const bottomRight = reader.pixelToModel(metadata.width, metadata.height);
  assert.deepEqual([metadata.affine.tiepointX, bottomRight.y, bottomRight.x, metadata.affine.tiepointY], lock.raster.gridEnvelope.modelBoundsAtPixelIsAreaEdges);
  const probes = [[0, 0], [Math.floor(metadata.width / 2), Math.floor(metadata.height / 2)], [metadata.width - 1, metadata.height - 1]];
  const samples = [];
  for (const [column, row] of probes) {
    const window = await reader.readWindow({ column, row, width: 1, height: 1 });
    samples.push({ column, row, value: window.values[0], nodata: window.values[0] === metadata.nodata });
  }
  console.log(JSON.stringify({ pass: true, lock: path.relative(ROOT, lockPath), lockSha256: createHash('sha256').update(lockBytes).digest('hex'), raster: { path: lock.raster.localRawCache, bytes: rawBytes.length, sha256: lock.raster.sha256, boundsEpsg26910Metres: lock.raster.gridEnvelope.modelBoundsAtPixelIsAreaEdges }, probes: samples }, null, 2));
} finally {
  await reader.close();
}
