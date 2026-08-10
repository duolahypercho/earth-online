/**
 * Prints the deterministic, no-network build plan for a tile manifest.
 * Build executors consume this plan only after their source locks are present.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const manifestPath = process.argv[2]
  ? path.resolve(ROOT, process.argv[2])
  : path.join(ROOT, 'public/data/world/tiles/sf-local-6-5.manifest.json');
const tile = JSON.parse(readFileSync(manifestPath, 'utf8'));

const plan = {
  tile: tile.id,
  status: tile.status,
  deterministicSeed: tile.determinism.seed,
  sourceWindow: tile.grid.localBuildBoundsMeters,
  outputOrigin: tile.grid.localOriginMeters,
  stages: [
    'validate locked source metadata and legal approval',
    'clip every authoritative source to the shared buffered window',
    'reproject production geometry to EPSG:26910 and reconcile vertical datum',
    'build terrain, shoreline, water, roads, sidewalks, and structures',
    'derive collision, pedestrian, traffic, and portal artifacts from stable source ids',
    'emit LOD 0-2 artifacts and edge signatures without changing deterministic ids',
    'run QA contract and publish only immutable content-hashed artifacts',
  ],
  runtimeLayers: Object.keys(tile.runtimeLayers),
  qaContract: tile.qaContract.requiredChecks,
};

console.log(JSON.stringify(plan, null, 2));
