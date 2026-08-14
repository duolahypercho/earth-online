/**
 * Read-only, fail-closed LOD0 terrain/water continuity audit.
 *
 * It intentionally reads only the admitted GLBs named by the production
 * manifest.  It never calls a builder and writes its bounded evidence only to
 * /tmp.  The audit concentrates on the sub-millimetre-to-millimetre grid-line
 * aliases that a coastline partition can introduce: an exact shared vertex is
 * expected, but two source vertices on opposite sides of the same 1 m grid
 * line must not diverge vertically or leave a near-line surface crack.
 *
 * Usage:
 *   node scripts/world-tiles/verify-sf-production-surface-continuity-v1.mjs --tile epsg26910-1440-10894 --report-only
 *   node scripts/world-tiles/verify-sf-production-surface-continuity-v1.mjs --report-only
 *
 * By default a finding exits non-zero. --report-only (or --audit) records the
 * same evidence and exits zero so an existing defect can be inspected without
 * masking it. This is diagnostic-only; it does not certify vertical accuracy.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const DEFAULT_REPORT_PATH = '/tmp/sf-production-surface-continuity-v1.json';
const GRID_NEAR_METRES = 0.0011; // admits the known 1.007 mm coastline alias, rejects ordinary 1 m neighbours.
const ORTHOGONAL_NEAR_METRES = 0.00001;
const VERTICAL_TOLERANCE_METRES = 0.00001;
const OVERLAP_AREA_TOLERANCE_SQUARE_METRES = 1e-10;
const MAX_TILE_FINDINGS = 24;
const MAX_REPORT_FINDINGS = 240;
const KNOWN_PROBE = Object.freeze({
  tileId: 'epsg26910-1440-10894',
  localXZ: [231.99899291992188, 267],
  reportedVerticalDeltaMetres: 0.32454186753966496,
});

const args = process.argv.slice(2);
const valuesAfter = (flag) => args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]] : []);
const requestedTiles = new Set(valuesAfter('--tile'));
const limitText = valuesAfter('--limit')[0];
const limit = limitText === undefined ? Infinity : Number(limitText);
const reportPath = valuesAfter('--report')[0] ?? DEFAULT_REPORT_PATH;
const reportOnly = args.includes('--report-only') || args.includes('--audit');
assert(Number.isInteger(limit) && limit > 0 || limit === Infinity, '--limit must be a positive integer');
assert(!args.includes('--help'), 'Usage: [--tile id] [--limit count] [--report /tmp/report.json] [--report-only|--audit]');
assert(path.isAbsolute(reportPath) && (reportPath === '/tmp' || reportPath.startsWith('/tmp/')), '--report must be an absolute path under /tmp');

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const round = (value, digits = 9) => Number(value.toFixed(digits));
const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const pointKey = (x, z) => `${x},${z}`;
const pairKey = (left, right) => left < right ? `${left}|${right}` : `${right}|${left}`;

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB declared length mismatch');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binOffset = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing');
  const binLength = bytes.readUInt32LE(binOffset);
  assert.equal(binOffset + 8 + binLength, bytes.length, 'GLB BIN length mismatch');
  return { gltf, bin: bytes.subarray(binOffset + 8) };
}

function accessorReader(gltf, bin, accessorIndex, expectedType) {
  const accessor = gltf.accessors[accessorIndex];
  assert(accessor, `Missing accessor ${accessorIndex}`);
  assert.equal(accessor.type, expectedType, `Accessor ${accessorIndex} type drifted`);
  assert.equal(accessor.bufferView !== undefined, true, `Accessor ${accessorIndex} must use a buffer view`);
  const view = gltf.bufferViews[accessor.bufferView];
  assert(view, `Missing buffer view ${accessor.bufferView}`);
  const components = expectedType === 'VEC3' ? 3 : 1;
  const elementBytes = accessor.componentType === 5126 || accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 ? 2 : 0;
  assert(elementBytes > 0, `Unsupported component type ${accessor.componentType}`);
  const stride = view.byteStride ?? components * elementBytes;
  assert(stride >= components * elementBytes, `Invalid accessor ${accessorIndex} byte stride`);
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const read = expectedType === 'VEC3'
    ? (index) => {
      const at = base + index * stride;
      assert.equal(accessor.componentType, 5126, 'Surface positions must be float32');
      return { x: bin.readFloatLE(at), y: bin.readFloatLE(at + 4), z: bin.readFloatLE(at + 8) };
    }
    : (index) => {
      const at = base + index * stride;
      if (accessor.componentType === 5123) return bin.readUInt16LE(at);
      if (accessor.componentType === 5125) return bin.readUInt32LE(at);
      throw new Error(`Surface indices must be uint16 or uint32, got ${accessor.componentType}`);
    };
  return { count: accessor.count, read };
}

function clipPolygon(subject, edgeStart, edgeEnd) {
  const output = [];
  const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const inside = (point) => cross(edgeStart, edgeEnd, point) >= -1e-12;
  const intersect = (a, b) => {
    const abx = b.x - a.x; const abz = b.z - a.z;
    const cdx = edgeEnd.x - edgeStart.x; const cdz = edgeEnd.z - edgeStart.z;
    const denominator = abx * cdz - abz * cdx;
    if (Math.abs(denominator) <= 1e-15) return { x: a.x, z: a.z };
    const t = ((edgeStart.x - a.x) * cdz - (edgeStart.z - a.z) * cdx) / denominator;
    return { x: a.x + abx * t, z: a.z + abz * t };
  };
  for (let index = 0; index < subject.length; index += 1) {
    const current = subject[index]; const previous = subject[(index + subject.length - 1) % subject.length];
    const currentInside = inside(current); const previousInside = inside(previous);
    if (currentInside && !previousInside) output.push(intersect(previous, current));
    if (currentInside) output.push(current);
    if (!currentInside && previousInside) output.push(intersect(previous, current));
  }
  return output;
}

function polygonArea(vertices) {
  return Math.abs(vertices.reduce((sum, point, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return sum + point.x * next.z - next.x * point.z;
  }, 0)) / 2;
}

function signedArea(triangle) {
  return (triangle[1].x - triangle[0].x) * (triangle[2].z - triangle[0].z) - (triangle[1].z - triangle[0].z) * (triangle[2].x - triangle[0].x);
}

function overlap(triangleA, triangleB) {
  const clip = signedArea(triangleB) >= 0 ? triangleB : [triangleB[0], triangleB[2], triangleB[1]];
  let polygon = triangleA.map(({ x, z }) => ({ x, z }));
  for (let index = 0; index < 3 && polygon.length; index += 1) polygon = clipPolygon(polygon, clip[index], clip[(index + 1) % 3]);
  const area = polygon.length >= 3 ? polygonArea(polygon) : 0;
  return { area, polygon };
}

function heightAt(triangle, x, z) {
  const [a, b, c] = triangle;
  const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  assert(Math.abs(denominator) > 1e-14, 'Degenerate projected source triangle');
  const alpha = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
  const beta = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
  return alpha * a.y + beta * b.y + (1 - alpha - beta) * c.y;
}

function uniqueSorted(values) { return [...new Set(values)].sort(); }

function addFinding(tile, finding) {
  tile.counts.violations += 1;
  tile.counts[finding.kind] = (tile.counts[finding.kind] ?? 0) + 1;
  tile.worstVerticalDeltaMetres = Math.max(tile.worstVerticalDeltaMetres, finding.verticalDeltaMetres ?? 0);
  tile.worstOverlapAreaSquareMetres = Math.max(tile.worstOverlapAreaSquareMetres, finding.overlapAreaSquareMetres ?? 0);
  if (tile.findings.length < MAX_TILE_FINDINGS) tile.findings.push(finding);
}

function makePoint(x, z) {
  return { x, z, samples: [], categories: new Set(), sourceOsmWayIds: new Set(), incidents: { terrain: new Set(), water: new Set() } };
}

function sourceSummary(point) {
  return {
    categories: uniqueSorted([...point.categories]),
    sourceOsmWayIds: [...point.sourceOsmWayIds].sort((a, b) => a - b),
    incidentCategories: Object.fromEntries(Object.entries(point.incidents).filter(([, triangles]) => triangles.size).map(([category, triangles]) => [category, triangles.size])),
  };
}

function addNearCandidate(map, axis, point, points) {
  const perpendicular = axis === 'x' ? point.z : point.x;
  const coordinate = axis === 'x' ? point.x : point.z;
  const boundary = Math.round(coordinate);
  if (Math.abs(coordinate - boundary) > GRID_NEAR_METRES) return;
  const side = coordinate < boundary - 1e-9 ? 'minus' : coordinate > boundary + 1e-9 ? 'plus' : 'on';
  const key = `${axis}|${boundary}|${Math.round(perpendicular / ORTHOGONAL_NEAR_METRES)}`;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push({ point, side, coordinate, points });
}

function matchNearGridCrossings(tile, nearCandidates) {
  for (const [key, candidates] of nearCandidates) {
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const left = candidates[leftIndex]; const right = candidates[rightIndex];
        if (left.point === right.point || left.side === right.side || (left.side === 'on' && right.side === 'on')) continue;
        const distance = horizontalDistance(left.point, right.point);
        if (distance <= 1e-12 || distance > GRID_NEAR_METRES || Math.abs((key.startsWith('x|') ? left.point.z - right.point.z : left.point.x - right.point.x)) > ORTHOGONAL_NEAR_METRES) continue;
        for (const leftSample of left.point.samples) for (const rightSample of right.point.samples) {
          const verticalDeltaMetres = Math.abs(leftSample.y - rightSample.y);
          if (verticalDeltaMetres <= VERTICAL_TOLERANCE_METRES) continue;
          const dedupe = `${pairKey(pointKey(left.point.x, left.point.z), pointKey(right.point.x, right.point.z))}|${leftSample.y}|${rightSample.y}`;
          if (tile.dedupe.has(`near:${dedupe}`)) continue;
          tile.dedupe.add(`near:${dedupe}`);
          tile.boundaryPoints.add(left.point);
          tile.boundaryPoints.add(right.point);
          addFinding(tile, {
            kind: 'nearGridCrossingVerticalDiscontinuity',
            gridLine: key.split('|').slice(0, 2).join('='),
            horizontalSeparationMetres: round(distance, 12),
            verticalDeltaMetres: round(verticalDeltaMetres, 12),
            left: { local: [round(left.point.x), round(leftSample.y), round(left.point.z)], ...sourceSummary(left.point) },
            right: { local: [round(right.point.x), round(rightSample.y), round(right.point.z)], ...sourceSummary(right.point) },
          });
        }
      }
    }
  }
}

function addPositiveAreaOverlapFinding(tile, terrain, water, result) {
  const centroid = result.polygon.reduce((sum, vertex) => ({ x: sum.x + vertex.x / result.polygon.length, z: sum.z + vertex.z / result.polygon.length }), { x: 0, z: 0 });
  const terrainHeight = heightAt(terrain.vertices, centroid.x, centroid.z);
  const waterHeight = heightAt(water.vertices, centroid.x, centroid.z);
  const verticalDeltaMetres = Math.abs(terrainHeight - waterHeight);
  addFinding(tile, {
    kind: 'positiveAreaTerrainWaterOverlap',
    overlapAreaSquareMetres: round(result.area, 12),
    verticalDeltaMetres: round(verticalDeltaMetres, 12),
    sampleLocal: [round(centroid.x), round((terrainHeight + waterHeight) / 2), round(centroid.z)],
    sourceCategories: { terrain: terrain.source, water: water.source },
  });
}

function overlapAtNearCandidates(tile, triangles) {
  const visitedPairs = new Set();
  for (const point of tile.boundaryPoints) {
    if (!point.incidents.terrain.size || !point.incidents.water.size) continue;
    for (const terrainId of point.incidents.terrain) for (const waterId of point.incidents.water) {
      const key = pairKey(terrainId, waterId);
      if (visitedPairs.has(key)) continue;
      visitedPairs.add(key);
      const terrain = triangles[terrainId]; const water = triangles[waterId];
      const result = overlap(terrain.vertices, water.vertices);
      if (result.area <= OVERLAP_AREA_TOLERANCE_SQUARE_METRES) continue;
      addPositiveAreaOverlapFinding(tile, terrain, water, result);
    }
  }
}

function triangleBounds(triangle) {
  return triangle.vertices.reduce((bounds, { x, z }) => ({ minX: Math.min(bounds.minX, x), maxX: Math.max(bounds.maxX, x), minZ: Math.min(bounds.minZ, z), maxZ: Math.max(bounds.maxZ, z) }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

function overlapAllTerrainWater(tile, triangles) {
  const buckets = new Map();
  const largeTerrain = [];
  const terrainIds = [];
  const waterIds = [];
  for (let triangleId = 0; triangleId < triangles.length; triangleId += 1) {
    const triangle = triangles[triangleId];
    if (triangle.source.category === 'terrain') terrainIds.push(triangleId);
    if (triangle.source.category === 'water') waterIds.push(triangleId);
  }
  for (const terrainId of terrainIds) {
    const bounds = triangleBounds(triangles[terrainId]);
    const minX = Math.max(0, Math.floor(bounds.minX - 1e-9)); const maxX = Math.min(383, Math.floor(bounds.maxX + 1e-9));
    const minZ = Math.max(0, Math.floor(bounds.minZ - 1e-9)); const maxZ = Math.min(383, Math.floor(bounds.maxZ + 1e-9));
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > 4096) { largeTerrain.push(terrainId); continue; }
    for (let x = minX; x <= maxX; x += 1) for (let z = minZ; z <= maxZ; z += 1) {
      const key = `${x},${z}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(terrainId);
    }
  }
  const visitedPairs = new Set();
  for (const waterId of waterIds) {
    const water = triangles[waterId]; const bounds = triangleBounds(water);
    const minX = Math.max(0, Math.floor(bounds.minX - 1e-9)); const maxX = Math.min(383, Math.floor(bounds.maxX + 1e-9));
    const minZ = Math.max(0, Math.floor(bounds.minZ - 1e-9)); const maxZ = Math.min(383, Math.floor(bounds.maxZ + 1e-9));
    const candidates = [...largeTerrain];
    for (let x = minX; x <= maxX; x += 1) for (let z = minZ; z <= maxZ; z += 1) candidates.push(...(buckets.get(`${x},${z}`) ?? []));
    for (const terrainId of candidates) {
      const key = pairKey(terrainId, waterId);
      if (visitedPairs.has(key)) continue;
      visitedPairs.add(key);
      const terrain = triangles[terrainId];
      const result = overlap(terrain.vertices, water.vertices);
      if (result.area > OVERLAP_AREA_TOLERANCE_SQUARE_METRES) addPositiveAreaOverlapFinding(tile, terrain, water, result);
    }
  }
}

async function auditTile(entry) {
  const artifactPath = path.resolve(ROOT, entry.lod0.path);
  assert(artifactPath.startsWith(`${ROOT}${path.sep}`), `${entry.id} artifact path escapes repository`);
  const bytes = await readFile(artifactPath);
  assert.equal(sha256(bytes), entry.lod0.sha256, `${entry.id} GLB hash does not match committed manifest`);
  const { gltf, bin } = parseGlb(bytes);
  assert.equal(gltf.extras?.tileId, entry.id, `${entry.id} GLB tile id drifted`);
  assert.equal(gltf.extras?.lod, 0, `${entry.id} is not LOD0`);
  assert.equal(gltf.extras?.unitsPerMetre, 1, `${entry.id} no longer has one unit per metre`);
  const tile = { id: entry.id, gridIndex: entry.gridIndex, counts: { exactSharedVertices: 0, nearGridCrossingsExamined: 0, violations: 0 }, worstVerticalDeltaMetres: 0, worstOverlapAreaSquareMetres: 0, findings: [], dedupe: new Set(), points: new Map(), boundaryPoints: new Set() };
  const triangles = [];
  const nearCandidates = new Map();
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    const category = primitive.extras?.category;
    if (category !== 'terrain' && category !== 'water') continue;
    const source = { category, sourceOsmWayIds: [...(primitive.extras?.sourceOsmWayIds ?? [])].sort((a, b) => a - b) };
    const positions = accessorReader(gltf, bin, primitive.attributes.POSITION, 'VEC3');
    const indices = accessorReader(gltf, bin, primitive.indices, 'SCALAR');
    assert.equal(indices.count % 3, 0, `${entry.id} ${category} indices are not triangles`);
    const pointByVertex = new Array(positions.count);
    for (let index = 0; index < positions.count; index += 1) {
      const value = positions.read(index);
      assert(Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z), `${entry.id} ${category} has a non-finite position`);
      const key = pointKey(value.x, value.z);
      const existing = tile.points.get(key);
      const point = existing ?? makePoint(value.x, value.z);
      tile.points.set(key, point);
      point.categories.add(category);
      source.sourceOsmWayIds.forEach((wayId) => point.sourceOsmWayIds.add(wayId));
      const sample = { id: `${category}:${triangles.length}:${index}`, y: value.y, category };
      point.samples.push(sample);
      pointByVertex[index] = point;
      if (!existing) {
        addNearCandidate(nearCandidates, 'x', point, tile.points);
        addNearCandidate(nearCandidates, 'z', point, tile.points);
      }
    }
    for (let offset = 0; offset < indices.count; offset += 3) {
      const vertexIndexes = [indices.read(offset), indices.read(offset + 1), indices.read(offset + 2)];
      vertexIndexes.forEach((index) => assert(index < positions.count, `${entry.id} ${category} index out of range`));
      const vertices = vertexIndexes.map((index) => positions.read(index));
      if (Math.abs(signedArea(vertices)) <= 1e-14) continue;
      const triangleId = triangles.length;
      triangles.push({ vertices, source });
      vertexIndexes.forEach((index) => pointByVertex[index].incidents[category].add(triangleId));
    }
  }
  assert(tile.points.size > 0, `${entry.id} has no terrain or water points`);
  for (const point of tile.points.values()) {
    const terrainHeights = point.samples.filter(({ category }) => category === 'terrain').map(({ y }) => y);
    const waterHeights = point.samples.filter(({ category }) => category === 'water').map(({ y }) => y);
    if (terrainHeights.length && waterHeights.length) {
      tile.counts.exactSharedVertices += 1;
      const verticalDeltaMetres = Math.max(...terrainHeights) - Math.min(...waterHeights);
      if (Math.abs(verticalDeltaMetres) > VERTICAL_TOLERANCE_METRES) addFinding(tile, {
        kind: 'exactSharedVertexVerticalDiscontinuity', verticalDeltaMetres: round(Math.abs(verticalDeltaMetres), 12),
        local: [round(point.x), round((terrainHeights[0] + waterHeights[0]) / 2), round(point.z)], source: sourceSummary(point),
      });
    }
  }
  tile.counts.nearGridCrossingsExamined = [...nearCandidates.values()].reduce((sum, candidates) => sum + candidates.length, 0);
  matchNearGridCrossings(tile, nearCandidates);
  overlapAllTerrainWater(tile, triangles);
  const probe = entry.id === KNOWN_PROBE.tileId
    ? (() => {
      const [x, z] = KNOWN_PROBE.localXZ;
      const point = tile.points.get(pointKey(x, z));
      const companion = [...tile.points.values()].find((candidate) => candidate !== point && Math.abs(candidate.z - z) <= ORTHOGONAL_NEAR_METRES && candidate.x >= x && candidate.x - x <= GRID_NEAR_METRES);
      const observedVerticalDeltaMetres = point && companion ? Math.max(...point.samples.map(({ y }) => y)) - Math.min(...companion.samples.map(({ y }) => y)) : null;
      return {
        ...KNOWN_PROBE,
        found: Boolean(point && companion),
        observedVerticalDeltaMetres: observedVerticalDeltaMetres === null ? null : round(Math.abs(observedVerticalDeltaMetres), 15),
        reportedVsArtifactDeltaMetres: observedVerticalDeltaMetres === null ? null : round(Math.abs(observedVerticalDeltaMetres) - KNOWN_PROBE.reportedVerticalDeltaMetres, 15),
        qualification: 'The reported reference is preserved verbatim. observedVerticalDeltaMetres is decoded from the hash-locked float32 LOD0 GLB and may differ from a higher-precision source-sampling observation.',
      };
    })()
    : undefined;
  delete tile.dedupe; delete tile.points; delete tile.boundaryPoints;
  if (probe) tile.knownProbe = probe;
  return tile;
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
assert.equal(manifest.kind, 'sf-metric-tile-set', 'Unexpected production manifest kind');
assert(Array.isArray(manifest.tiles) && manifest.tiles.length > 0, 'Production manifest has no tiles');
assert.equal(new Set(manifest.tiles.map(({ id }) => id)).size, manifest.tiles.length, 'Production manifest has duplicate tile ids');
const manifestTileCount = manifest.tiles.length;
let entries = manifest.tiles;
if (requestedTiles.size) {
  const available = new Set(entries.map(({ id }) => id));
  for (const id of requestedTiles) assert(available.has(id), `Tile not present in committed production manifest: ${id}`);
  entries = entries.filter(({ id }) => requestedTiles.has(id));
}
entries = entries.slice(0, limit);
const tiles = [];
for (const entry of entries) tiles.push(await auditTile(entry));
const counts = tiles.reduce((total, tile) => {
  total.exactSharedVertices += tile.counts.exactSharedVertices;
  total.nearGridCrossingsExamined += tile.counts.nearGridCrossingsExamined;
  total.violations += tile.counts.violations;
  for (const [key, value] of Object.entries(tile.counts)) if (!['exactSharedVertices', 'nearGridCrossingsExamined', 'violations'].includes(key)) total[key] = (total[key] ?? 0) + value;
  return total;
}, { exactSharedVertices: 0, nearGridCrossingsExamined: 0, violations: 0 });
const report = {
  schemaVersion: 1,
  kind: 'sf-production-lod0-surface-continuity-audit',
  status: counts.violations ? 'rejected-surface-continuity-violations' : 'passed-no-detected-surface-continuity-violations',
  scope: { manifest: path.relative(ROOT, MANIFEST_PATH).split(path.sep).join('/'), manifestTileCount, requestedTiles: requestedTiles.size ? [...requestedTiles].sort() : `all-${manifestTileCount}`, auditedTiles: tiles.length, lod: 0, readOnly: true, artifactWrites: false, reportOnly },
  tolerances: { gridNearMetres: GRID_NEAR_METRES, orthogonalNearMetres: ORTHOGONAL_NEAR_METRES, verticalMetres: VERTICAL_TOLERANCE_METRES, positiveOverlapAreaSquareMetres: OVERLAP_AREA_TOLERANCE_SQUARE_METRES },
  method: {
    exactSharedVertices: 'same float32 local x/z coordinate present in terrain and water; reject if source height values disagree',
    nearGridCrossings: 'distinct surface vertices within 1.1 mm across the same integer-metre x or z grid line; reject vertical disagreement',
    overlap: 'positive projected terrain/water triangle overlap evaluated exhaustively through a deterministic 1 m projected triangle spatial index',
    qualification: 'This is a fail-closed source-surface continuity diagnostic, not a realized vertical datum certification or a terrain/water repair.',
  },
  counts,
  worst: {
    verticalDeltaMetres: Math.max(0, ...tiles.map(({ worstVerticalDeltaMetres }) => worstVerticalDeltaMetres)),
    overlapAreaSquareMetres: Math.max(0, ...tiles.map(({ worstOverlapAreaSquareMetres }) => worstOverlapAreaSquareMetres)),
  },
  tiles: tiles.map(({ id, gridIndex, counts: tileCounts, worstVerticalDeltaMetres, worstOverlapAreaSquareMetres, findings, knownProbe }) => ({ id, gridIndex, counts: tileCounts, worstVerticalDeltaMetres, worstOverlapAreaSquareMetres, findings, ...(knownProbe ? { knownProbe } : {}) })),
  boundedEvidence: { maxFindingsPerTile: MAX_TILE_FINDINGS, maxFindingsInReport: MAX_REPORT_FINDINGS, storedFindings: Math.min(MAX_REPORT_FINDINGS, tiles.reduce((sum, tile) => sum + tile.findings.length, 0)) },
};
let remaining = MAX_REPORT_FINDINGS;
for (const tile of report.tiles) { if (tile.findings.length > remaining) tile.findings.splice(remaining); remaining -= tile.findings.length; }
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ result: report.status, reportPath, auditedTiles: tiles.length, violations: counts.violations, worst: report.worst }, null, 2));
if (counts.violations && !reportOnly) process.exitCode = 1;
