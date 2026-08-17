import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const mainSource = readFileSync(resolve(root, 'src/citygen/main.js'), 'utf8');
const loaderSource = readFileSync(resolve(root, 'src/citygen/metric-tile-stream.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(
  root,
  'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json',
), 'utf8'));
const authorization = JSON.parse(readFileSync(resolve(
  root,
  'public/data/world/source-locks/sf-ferry-source-tone-production-authorization-v1.lock.json',
), 'utf8'));

const FERRY_TILE_ID = 'epsg26910-1441-10893';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  /authoritativeMetricMapPlugin\.load\(\{\s*[\s\S]*?count:\s*1,/.test(mainSource),
  'Canonical Metric SF must request exactly one authorized resident tile.',
);
assert(
  loaderSource.includes("const FERRY_TILE_ID = 'epsg26910-1441-10893';"),
  'The canonical metric loader must retain the source-authorized Ferry focus tile.',
);
assert(
  loaderSource.includes('const DEFAULT_TILE_COUNT = 1;'),
  'The metric loader default must fail closed to one authorized tile.',
);
assert(
  authorization.productionWriteEnabled === true
    && authorization.productionPromotionAuthorized === true,
  'The Ferry presentation authorization must remain production-enabled.',
);
assert(
  authorization.tile?.id === FERRY_TILE_ID,
  'The bounded presentation authorization no longer names the canonical Ferry tile.',
);
assert(
  authorization.scope?.authorizedTileCount === 1
    && authorization.scope?.citywideSourceToneClaim === false,
  'The source authorization must remain explicitly bounded to one non-citywide tile.',
);

const ferryDescriptor = manifest.tiles?.find((tile) => tile.id === FERRY_TILE_ID);
assert(ferryDescriptor, 'The authorized Ferry tile is missing from the production manifest.');
assert(
  ferryDescriptor.presentation?.mode === 'source-tone-v1',
  'The authorized Ferry tile must retain its source-tone presentation descriptor.',
);
assert(
  ferryDescriptor.presentation?.authorization?.path
    === 'public/data/world/source-locks/sf-ferry-source-tone-production-authorization-v1.lock.json',
  'The Ferry descriptor must bind the exact bounded production authorization.',
);

console.log(JSON.stringify({
  result: 'canonical Ferry source scope verified',
  tileId: FERRY_TILE_ID,
  residentTileLimit: 1,
  manifestTileCount: manifest.tiles.length,
  verticalCertification: authorization.tile.verticalCertification,
  citywideClaim: authorization.scope.citywideSourceToneClaim,
}, null, 2));
