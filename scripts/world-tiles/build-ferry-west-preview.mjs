/**
 * Builds a local-only runtime preview for the Ferry hero's west neighbor.
 *
 * This is intentionally not a production tile builder: it consumes the
 * existing compact OSM/elevation preview sources and records the source-lock
 * and vertical-datum gaps that prevent publication as an earth tile.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = path.join(root, 'public/data/sf/sf-city.json');
const elevationPath = path.join(root, 'public/data/sf/sf-elevation.json');
const outputDir = path.join(root, 'public/data/world/preview');
const outputPath = path.join(outputDir, 'sf-ferry-building-west-preview-v1.json');
const coreBounds = [1760, 1728, 2144, 2112];
const bufferBounds = [1744, 1712, 2160, 2128];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value);
const pairs = (feature) => {
  const points = feature?.points || [];
  return Array.isArray(points[0]) ? points : Array.from({ length: Math.floor(points.length / 2) }, (_, index) => [points[index * 2], points[index * 2 + 1]]);
};
const intersects = (feature, [minX, minZ, maxX, maxZ]) => pairs(feature)
  .some(([x, z]) => x >= minX && x <= maxX && z >= minZ && z <= maxZ);

function elevationSampler(data, x, z) {
  const { originX, originZ, cellSize, width, height, grid } = data;
  const gx = (x - originX) / cellSize;
  const gz = (z - originZ) / cellSize;
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const tx = gx - x0;
  const tz = gz - z0;
  const sample = (cx, cz) => (cx < 0 || cx >= width || cz < 0 || cz >= height ? 0 : grid[cz * width + cx] || 0);
  const a = sample(x0, z0);
  const b = sample(x0 + 1, z0);
  const c = sample(x0, z0 + 1);
  const d = sample(x0 + 1, z0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

const [cityRaw, elevationRaw] = await Promise.all([readFile(sourcePath), readFile(elevationPath)]);
const city = JSON.parse(cityRaw);
const elevation = JSON.parse(elevationRaw);
const roads = (city.detailRoads || []).filter((road) => intersects(road, bufferBounds));
const buildings = (city.detailBuildings || []).filter((building) => intersects(building, bufferBounds));
const gridSize = 17;
const sampleGrid = [];
for (let row = 0; row < gridSize; row += 1) {
  for (let column = 0; column < gridSize; column += 1) {
    const x = bufferBounds[0] + (bufferBounds[2] - bufferBounds[0]) * column / (gridSize - 1);
    const z = bufferBounds[1] + (bufferBounds[3] - bufferBounds[1]) * row / (gridSize - 1);
    sampleGrid.push(Number(elevationSampler(elevation, x, z).toFixed(3)));
  }
}
const sharedEdgeSamples = Array.from({ length: 33 }, (_, index) => {
  const z = coreBounds[1] + (coreBounds[3] - coreBounds[1]) * index / 32;
  return [2144, Number(z.toFixed(3)), Number(elevationSampler(elevation, 2144, z).toFixed(2))];
});
const artifact = {
  schemaVersion: 1,
  kind: 'earth-walkable-preview-neighbor',
  status: 'preview',
  previewOnly: true,
  id: 'sf-ferry-building-west-preview-v1',
  title: 'Ferry Building west neighbor — local preview only',
  localFrame: {
    name: 'sf-atlas-linear-v1', units: 'metres', axisOrder: ['east', 'north', 'up'],
    anchorWgs84: [-122.4194, 37.778, 0],
    precisionNote: 'Preview frame inherited from local sf-city.json. It is not EPSG:26910 production geometry.',
  },
  bounds: { coreMeters: coreBounds, bufferedMeters: bufferBounds },
  relationship: {
    originTileId: 'sf-ferry-building-v1', direction: 'west',
    sharedEdge: { axis: 'x', coordinateMeters: 2144, ownerTileId: 'sf-ferry-building-v1', quantizationMeters: 0.01, samples: sharedEdgeSamples, signatureSha256: sha256(canonical(sharedEdgeSamples)) },
  },
  source: {
    localOnly: true,
    cityArtifact: '/data/sf/sf-city.json', citySha256: sha256(cityRaw),
    elevationArtifact: '/data/sf/sf-elevation.json', elevationSha256: sha256(elevationRaw),
    osmSnapshotSha256: city.meta?.sources?.find((source) => /OpenStreetMap/.test(source.name))?.sha256 || null,
    layers: { roads: roads.length, buildingFootprints: buildings.length, elevationSamples: sampleGrid.length },
    filteredStableOsmIds: { roads: roads.map((road) => road.id).sort((a, b) => a - b), buildings: buildings.map((building) => building.id).sort((a, b) => a - b) },
  },
  runtime: {
    terrain: { gridSize, sampleBoundsMeters: bufferBounds, heightsMeters: sampleGrid },
    roads: roads.map(({ id, name, highway, lanes, surface, sidewalk, points }) => ({ id, name, highway, lanes, surface, sidewalk, points })),
    buildings: buildings.map(({ id, name, building, levels, height, centroid, points }) => ({ id, name, building, levels, height, centroid, points })),
    collision: { shape: 'footprint-prism', source: 'runtime.buildings', heightFallbackMeters: 12, playerRadiusMeters: 0.5 },
  },
  productionBlockers: [
    'Source-lock: this preview is derived from the mutable local compact OSM snapshot, not immutable production source windows.',
    'Vertical datum: local elevation preview has not been reconciled to NAVD88.',
    'No canonical adjacent tile artifact, LOD package, shoreline/water reconciliation, or production QA publication exists.',
  ],
};
artifact.contentSha256 = sha256(canonical(artifact));
await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ result: 'preview artifact built', output: path.relative(root, outputPath), id: artifact.id, roads: roads.length, buildings: buildings.length, contentSha256: artifact.contentSha256 }, null, 2));
