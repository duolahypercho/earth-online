/**
 * Stable grid-tile CLI entry point.  The implementation retains the original
 * Ferry module name because its first production receipt is already committed.
 *
 * Usage:
 *   node scripts/world-tiles/build-sf-metric-tile-v1.mjs --grid-easting 1440 --grid-northing 10893
 *   node scripts/world-tiles/build-sf-metric-tile-v1.mjs --grid-easting 1440 --grid-northing 10893 --output-dir public/data/world/production-artifacts/my-tile
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSfMetricTile } from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const valueAfter = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gridEasting = valueAfter('--grid-easting'); const gridNorthing = valueAfter('--grid-northing');
  assert.notEqual(gridEasting, null, 'Pass --grid-easting'); assert.notEqual(gridNorthing, null, 'Pass --grid-northing');
  const outputDirArgument = valueAfter('--output-dir'); assert(!args.includes('--output-dir') || outputDirArgument, '--output-dir requires a directory');
  const result = await buildSfMetricTile({ tile: { gridEasting: Number(gridEasting), gridNorthing: Number(gridNorthing) }, outputDir: outputDirArgument ? path.resolve(ROOT, outputDirArgument) : undefined });
  process.stdout.write(`${JSON.stringify({ result: 'SF metric tile baked', tile: result.receipt.tile, status: result.receipt.status, counts: result.receipt.counts, lods: result.receipt.lods.map(({ level, artifactHash, path: artifactPath }) => ({ level, artifactHash, path: artifactPath })) }, null, 2)}\n`);
}
