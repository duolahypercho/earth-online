/**
 * Prints a deterministic, no-network production plan. It does not build or
 * publish geometry; planned metadata remains planned until source locks and
 * the QA contract are satisfied by a production worker.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TILES_DIR = path.join(ROOT, 'public/data/world/tiles');
const REGION_PATH = path.join(ROOT, 'public/data/world/regions/sf-ferry-building-hero.region.json');
const requestedPath = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : null;
const loadJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

function planTile(tile) {
  return {
    tile: tile.id,
    status: tile.status,
    artifactState: 'not-published',
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
}

if (requestedPath) {
  console.log(JSON.stringify(planTile(loadJson(requestedPath)), null, 2));
} else {
  const region = loadJson(REGION_PATH);
  const plans = region.tileCoverage.tileIds.map((id) => planTile(loadJson(path.join(TILES_DIR, `${id}.manifest.json`))));
  console.log(JSON.stringify({
    region: region.id,
    status: region.status,
    liveRuntimeBounds: region.liveRuntime.localBoundsMeters,
    liveRuntimeBufferedBounds: region.liveRuntime.localBufferedBoundsMeters,
    productionState: region.productionState,
    note: 'This is a metadata-only build plan. No tile artifact or neighbor handoff is published.',
    tiles: plans,
  }, null, 2));
}
