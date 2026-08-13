/** Fail-closed verifier for a grid-addressed native EPSG:26910 LOD0 package. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSfMetricTile } from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const valueAfter = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const gridEasting = Number(valueAfter('--grid-easting'));
const gridNorthing = Number(valueAfter('--grid-northing'));
assert(Number.isInteger(gridEasting) && Number.isInteger(gridNorthing), 'Pass integer --grid-easting and --grid-northing');
const id = `epsg26910-${gridEasting}-${gridNorthing}`;
const dirArgument = valueAfter('--output-dir');
const dir = dirArgument ? path.resolve(ROOT, dirArgument) : path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1', id);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const parseGlb = (bytes) => { assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch'); assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch'); assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB declared length mismatch'); const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing'); return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()); };
const stem = id;
const [receipt, mapPackage, glb] = await Promise.all([readFile(path.join(dir, `${stem}.receipt.json`), 'utf8').then(JSON.parse), readFile(path.join(dir, `${stem}.package.json`), 'utf8').then(JSON.parse), readFile(path.join(dir, `${stem}.lod0.glb`))]);
assert.equal(receipt.kind, 'sf-metric-tile-build-receipt'); assert.equal(receipt.tile.identity, id); assert.deepEqual(receipt.tile.gridIndex, [gridEasting, gridNorthing]); assert.deepEqual(receipt.tile.boundsEpsg26910Metres, [gridEasting * 384, gridNorthing * 384, (gridEasting + 1) * 384, (gridNorthing + 1) * 384]);
assert.equal(receipt.status, 'provisional-vertical-unrealized'); assert.equal(mapPackage.status, receipt.status); assert.equal(receipt.deterministicInputs.terrainGridStepMetres, 1); assert.deepEqual(receipt.deterministicInputs.availableLods, [0]); assert.equal(receipt.relationCoverage.implemented, false);
assert.equal(receipt.source.osmPbf.sha256, 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae'); assert(mapPackage.sourceFeatures.length > 0, 'Expected OSM way coverage');
const terrainDescriptor = mapPackage.sourceLocks.find(({ purpose }) => purpose === 'terrain-elevation');
assert(terrainDescriptor, 'Package must bind one terrain elevation authorization');
const elevationLockBytes = await readFile(path.resolve(ROOT, terrainDescriptor.path));
assert.equal(sha256(elevationLockBytes), terrainDescriptor.sha256, 'Terrain authorization lock hash drifted');
const elevationLock = JSON.parse(elevationLockBytes);
assert.equal(elevationLock.id, terrainDescriptor.id, 'Terrain authorization lock id drifted');
assert.equal(elevationLock.status, 'source-declared-navd88-unrealized-elevation-sampling-authorized');
assert.equal(receipt.source.geoTiff.sha256, elevationLock.sourceRaster.sha256, 'Receipt raster differs from its terrain authorization');
for (const feature of mapPackage.sourceFeatures) { assert.match(feature.sourceFeatureId, /^way\/\d+$/); assert.equal(feature.nativeHorizontalCrs, 'EPSG:4326'); assert.equal(feature.verticalMode, 'terrain-sampled-source-declared-navd88-unrealized'); assert.equal(feature.elevationSourceLockId, elevationLock.id); assert.equal(feature.elevationSampleEvidence.rasterSha256, elevationLock.sourceRaster.sha256); }
assert.equal(receipt.lods.length, 1); const lod = receipt.lods[0]; assert.equal(lod.level, 0); assert.equal(`sha256:${sha256(glb)}`, lod.artifactHash); const gltf = parseGlb(glb); assert.equal(gltf.extras.tileId, id); assert.equal(gltf.extras.horizontalCrs, 'EPSG:26910'); assert.equal(gltf.extras.unitsPerMetre, 1); assert.deepEqual(gltf.meshes[0].primitives.map(({ extras }) => extras.category), Object.keys(lod.meshStats).filter((category) => lod.meshStats[category].vertices > 0));
assert.equal(receipt.surfaceClassification.terrainWaterOverlapAreaSquareMetres, 0); assert(Math.abs(receipt.surfaceClassification.partitionAreaSquareMetres - 384 ** 2) <= 0.001, 'Land/water partition must cover exact tile');
const rebuilt = await buildSfMetricTile({ tile: { gridEasting, gridNorthing }, write: false, outputDir: dir });
assert.equal(`sha256:${sha256(rebuilt.glbs[0].bytes)}`, lod.artifactHash, 'Deterministic rebuild hash mismatch'); assert.deepEqual(rebuilt.receipt.lods, receipt.lods, 'Deterministic receipt mismatch'); assert.deepEqual(rebuilt.packageDescriptor, mapPackage, 'Deterministic package mismatch');
console.log(JSON.stringify({ result: 'SF metric tile passed', tile: id, artifact: lod.path, sha256: lod.artifactHash, deterministicRebuild: true }, null, 2));
