/** Fail-closed verifier for the complete locked DataSF metric tile plan. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSfMetricTileCoveragePlan } from './plan-sf-metric-tile-coverage-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLAN_PATH = path.join(ROOT, 'public/data/world/plans/sf-metric-tile-coverage-v1.json');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const checked = JSON.parse(await readFile(PLAN_PATH, 'utf8'));
const rebuilt = await buildSfMetricTileCoveragePlan();
assert.deepEqual(checked, rebuilt, 'Checked-in citywide tile plan is not the deterministic output of its locked sources');
assert.equal(checked.kind, 'sf-metric-tile-coverage-plan');
assert.equal(checked.status, 'horizontal-complete-terrain-sources-incomplete', 'Plan must honestly report missing citywide terrain sources');
assert.equal(checked.sources.shoreline.artifactSha256, 'sha256:a3023288edff7a91f84f20ca54fc55693b2f6a4fa4fb396807378f31be80f01d');
assert.equal(checked.sources.horizontalTransform.absoluteHorizontalAccuracyFloorMetres, 4);
assert.equal(checked.sources.availableTerrain.length, 4, 'All four byte-locked mainland 3DEP cells must be planned');
assert.equal(checked.counts.shorelinePolygons, 38, 'All locked DataSF shoreline/island polygons must be represented');
assert(checked.counts.buildReadyTiles > 3, 'Current terrain source should admit a meaningful eastern-SF batch');
assert(checked.counts.missingTerrainTiles > 0, 'Plan must expose the missing western/remote terrain source gap');
assert.equal(checked.counts.totalPlannedTiles, checked.tiles.length);
assert.equal(new Set(checked.tiles.map(({ id }) => id)).size, checked.tiles.length, 'Tile IDs must be unique');
for (const tile of checked.tiles) {
  const [gridE, gridN] = tile.gridIndex;
  assert.equal(tile.id, `epsg26910-${gridE}-${gridN}`);
  assert.deepEqual(tile.boundsEpsg26910Metres, [gridE * 384, gridN * 384, (gridE + 1) * 384, (gridN + 1) * 384]);
  assert(['land-intersection', 'coastal-context-halo'].includes(tile.inclusion));
  assert.equal(tile.inclusion === 'land-intersection', tile.landPolygonIndices.length > 0);
  assert.equal(tile.sourceReadiness.buildReady, tile.sourceReadiness.terrainElevation.startsWith('available-from-byte-locked-3dep-'));
}
const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const plannedIds = new Set(checked.tiles.map(({ id }) => id));
for (const tile of manifest.tiles) assert(plannedIds.has(tile.id), `Resident runtime tile is absent from the complete plan: ${tile.id}`);
const mainland = checked.tiles.filter(({ landPolygonIndices }) => landPolygonIndices.includes(0));
assert(mainland.length > 100, 'Mainland SF coverage is implausibly small');
assert(checked.tiles.some(({ landPolygonIndices }) => landPolygonIndices.includes(9)), 'Remote San Francisco island polygon coverage is missing');
assert.match(checked.tiles.find(({ id }) => id === 'epsg26910-1441-10895')?.sourceReadiness.terrainElevation || '', /^byte-locked-3dep-.*-contains-nodata$/, 'Known bay no-data tile must fail closed');
console.log(JSON.stringify({ result: 'SF metric tile coverage plan passed', path: path.relative(ROOT, PLAN_PATH), status: checked.status, counts: checked.counts, residentTiles: manifest.tiles.map(({ id }) => id) }, null, 2));
