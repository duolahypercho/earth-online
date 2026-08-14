/**
 * Read-only, fail-closed projected-surface continuity audit.
 *
 * This is deliberately narrower and more geometric than the earlier
 * near-grid diagnostic: it compares heights only when two terrain/water
 * triangles describe the *same projected X/Z point*. A 1 mm horizontal offset
 * on a legitimate slope is therefore not a vertical crack. The committed
 * eight-tile Ferry ownership sample is read hash-locked from its receipt; no
 * builder, manifest, preview, or runtime asset is changed.
 *
 * Usage:
 *   node scripts/world-tiles/verify-sf-same-xz-surface-continuity-v1.mjs --audit
 *   node scripts/world-tiles/verify-sf-same-xz-surface-continuity-v1.mjs --report /tmp/sf-same-xz.json --audit
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RECEIPT_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-surface-grid-ownership-proof-v1/sf-surface-grid-ownership-proof-v1.receipt.json');
const DEFAULT_REPORT_PATH = '/tmp/sf-same-xz-surface-continuity-v1.json';
const VERTICAL_TOLERANCE_METRES = 1e-5;
const OVERLAP_AREA_TOLERANCE_SQUARE_METRES = 1e-10;
// Spatial buckets need the worst two-ULP allowance over the local 0..384 m
// float32 tile frame. Exact point-on-edge tests use the smaller dynamic value.
const MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES = 2 ** -14;
const MAX_FINDINGS_PER_TILE = 24;

const args = process.argv.slice(2);
const valuesAfter = (flag) => args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]] : []);
const reportPath = valuesAfter('--report')[0] ?? DEFAULT_REPORT_PATH;
const auditOnly = args.includes('--audit') || args.includes('--report-only');
assert(!args.includes('--help'), 'Usage: [--audit|--report-only] [--report /tmp/report.json]');
assert(path.isAbsolute(reportPath) && (reportPath === '/tmp' || reportPath.startsWith('/tmp/')), '--report must be an absolute path under /tmp');

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const round = (value, digits = 12) => Number(value.toFixed(digits));
const pointKey = ({ x, z }) => `${x},${z}`;
const orderedPair = (left, right) => left < right ? `${left}|${right}` : `${right}|${left}`;

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

function positions(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors?.[accessorIndex];
  assert(accessor && accessor.type === 'VEC3' && accessor.componentType === 5126, 'Surface position accessor must be float32 VEC3');
  const view = gltf.bufferViews?.[accessor.bufferView]; assert(view, 'Surface position buffer view missing');
  const stride = view.byteStride ?? 12; const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, index) => {
    const at = base + index * stride;
    return { x: bin.readFloatLE(at), y: bin.readFloatLE(at + 4), z: bin.readFloatLE(at + 8) };
  });
}

function indices(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors?.[accessorIndex];
  assert(accessor && accessor.type === 'SCALAR' && [5123, 5125].includes(accessor.componentType), 'Surface index accessor must be uint16/uint32 scalar');
  const view = gltf.bufferViews?.[accessor.bufferView]; assert(view, 'Surface index buffer view missing');
  const bytes = accessor.componentType === 5123 ? 2 : 4; const stride = view.byteStride ?? bytes; const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, index) => accessor.componentType === 5123 ? bin.readUInt16LE(base + index * stride) : bin.readUInt32LE(base + index * stride));
}

function signedArea(triangle) {
  return (triangle[1].x - triangle[0].x) * (triangle[2].z - triangle[0].z) - (triangle[1].z - triangle[0].z) * (triangle[2].x - triangle[0].x);
}

function heightAt(triangle, x, z) {
  const [a, b, c] = triangle;
  const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  assert(Math.abs(denominator) > 1e-14, 'Degenerate projected surface triangle');
  const alpha = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
  const beta = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
  return alpha * a.y + beta * b.y + (1 - alpha - beta) * c.y;
}

function clipPolygon(subject, edgeStart, edgeEnd) {
  const output = [];
  const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const inside = (point) => cross(edgeStart, edgeEnd, point) >= -1e-12;
  const intersection = (a, b) => {
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
    if (currentInside && !previousInside) output.push(intersection(previous, current));
    if (currentInside) output.push(current);
    if (!currentInside && previousInside) output.push(intersection(previous, current));
  }
  return output;
}

function polygonArea(vertices) {
  return Math.abs(vertices.reduce((sum, point, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return sum + point.x * next.z - next.x * point.z;
  }, 0)) / 2;
}

function projectedOverlap(left, right) {
  const clip = signedArea(right) >= 0 ? right : [right[0], right[2], right[1]];
  let polygon = left.map(({ x, z }) => ({ x, z }));
  for (let index = 0; index < 3 && polygon.length; index += 1) polygon = clipPolygon(polygon, clip[index], clip[(index + 1) % 3]);
  return { polygon, area: polygon.length >= 3 ? polygonArea(polygon) : 0 };
}

function bounds(points) {
  return points.reduce((value, point) => ({ minX: Math.min(value.minX, point.x), maxX: Math.max(value.maxX, point.x), minZ: Math.min(value.minZ, point.z), maxZ: Math.max(value.maxZ, point.z) }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

function forEachBucket(bound, callback) {
  const minX = Math.floor(bound.minX - MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES); const maxX = Math.floor(bound.maxX + MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES);
  const minZ = Math.floor(bound.minZ - MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES); const maxZ = Math.floor(bound.maxZ + MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES);
  for (let x = minX; x <= maxX; x += 1) for (let z = minZ; z <= maxZ; z += 1) callback(`${x},${z}`);
}

function float32Ulp(value) {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(magnitude)) - 23);
}

function pointOnOpenEdge(point, edge) {
  const dx = edge.b.x - edge.a.x; const dz = edge.b.z - edge.a.z;
  const length = Math.hypot(dx, dz);
  if (length <= 1e-14) return false;
  const crossDistance = Math.abs(dx * (point.z - edge.a.z) - dz * (point.x - edge.a.x)) / length;
  const tolerance = 2 * Math.max(float32Ulp(point.x), float32Ulp(point.z), float32Ulp(edge.a.x), float32Ulp(edge.a.z), float32Ulp(edge.b.x), float32Ulp(edge.b.z));
  if (crossDistance > tolerance) return false;
  const t = ((point.x - edge.a.x) * dx + (point.z - edge.a.z) * dz) / (length * length);
  return t > 1e-9 && t < 1 - 1e-9;
}

function edgeHeight(edge, point) {
  const dx = edge.b.x - edge.a.x; const dz = edge.b.z - edge.a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = ((point.x - edge.a.x) * dx + (point.z - edge.a.z) * dz) / lengthSquared;
  return edge.a.y + (edge.b.y - edge.a.y) * t;
}

function addFinding(audit, finding) {
  audit.counts.findings += 1;
  audit.counts[finding.kind] = (audit.counts[finding.kind] ?? 0) + 1;
  audit.worstSameXZDeltaMetres = Math.max(audit.worstSameXZDeltaMetres, finding.verticalDeltaMetres ?? 0);
  audit.worstPositiveAreaOverlapSquareMetres = Math.max(audit.worstPositiveAreaOverlapSquareMetres, finding.overlapAreaSquareMetres ?? 0);
  if (audit.findings.length < MAX_FINDINGS_PER_TILE) audit.findings.push(finding);
}

function hashHorizontalTopology(gltf, bin) {
  const hash = createHash('sha256');
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    const category = primitive.extras?.category;
    if (category !== 'terrain' && category !== 'water') continue;
    hash.update(`${category}\0`);
    for (const point of positions(gltf, bin, primitive.attributes.POSITION)) {
      const coordinateBytes = Buffer.allocUnsafe(8); coordinateBytes.writeFloatLE(point.x, 0); coordinateBytes.writeFloatLE(point.z, 4); hash.update(coordinateBytes);
    }
    hash.update('\0indices\0');
    for (const index of indices(gltf, bin, primitive.indices)) { const indexBytes = Buffer.allocUnsafe(4); indexBytes.writeUInt32LE(index); hash.update(indexBytes); }
  }
  return `sha256:${hash.digest('hex')}`;
}

function decodeSurface(bytes, expectedTileId) {
  const { gltf, bin } = parseGlb(bytes);
  assert.equal(gltf.extras?.tileId, expectedTileId, 'GLB tile id drifted');
  assert.equal(gltf.extras?.lod, 0, 'GLB must remain LOD0');
  assert.equal(gltf.extras?.unitsPerMetre, 1, 'GLB must retain one unit per metre');
  const vertices = { terrain: new Map(), water: new Map() };
  const edges = { terrain: new Map(), water: new Map() };
  const triangles = { terrain: [], water: [] };
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    const category = primitive.extras?.category;
    if (category !== 'terrain' && category !== 'water') continue;
    const primitivePositions = positions(gltf, bin, primitive.attributes.POSITION);
    const primitiveIndices = indices(gltf, bin, primitive.indices);
    assert.equal(primitiveIndices.length % 3, 0, `${category} indices are not triangles`);
    for (const point of primitivePositions) {
      assert(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z), 'Non-finite surface vertex');
      const key = pointKey(point); const entry = vertices[category].get(key) ?? { x: point.x, z: point.z, ys: new Set() };
      entry.ys.add(point.y); vertices[category].set(key, entry);
    }
    for (let offset = 0; offset < primitiveIndices.length; offset += 3) {
      const triangle = [primitiveIndices[offset], primitiveIndices[offset + 1], primitiveIndices[offset + 2]].map((index) => {
        assert(index < primitivePositions.length, `${category} surface index out of range`); return primitivePositions[index];
      });
      if (Math.abs(signedArea(triangle)) <= 1e-14) continue;
      triangles[category].push(triangle);
      for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
        const left = triangle[edgeIndex]; const right = triangle[(edgeIndex + 1) % 3];
        const leftKey = pointKey(left); const rightKey = pointKey(right);
        if (leftKey === rightKey) continue;
        const key = orderedPair(leftKey, rightKey);
        if (!edges[category].has(key)) {
          const ordered = leftKey < rightKey ? [left, right] : [right, left];
          edges[category].set(key, { key, a: ordered[0], b: ordered[1], bounds: bounds(ordered) });
        }
      }
    }
  }
  assert(vertices.terrain.size + vertices.water.size > 0, 'No terrain/water surface vertices');
  return { gltf, bin, vertices, edges, triangles, horizontalTopologySha256: hashHorizontalTopology(gltf, bin) };
}

function addExactVertexChecks(audit, decoded) {
  for (const category of ['terrain', 'water']) for (const point of decoded.vertices[category].values()) {
    const heights = [...point.ys];
    if (heights.length < 2) continue;
    audit.counts.exactSameCategoryVertexPairs += heights.length * (heights.length - 1) / 2;
    const delta = Math.max(...heights) - Math.min(...heights);
    audit.worstSameXZDeltaMetres = Math.max(audit.worstSameXZDeltaMetres, delta);
    if (delta > VERTICAL_TOLERANCE_METRES) addFinding(audit, { kind: 'exactSameCategoryVertexVerticalCrack', category, verticalDeltaMetres: round(delta), localXZ: [round(point.x), round(point.z)], heights: heights.map((height) => round(height)) });
  }
  for (const [key, terrain] of decoded.vertices.terrain) {
    const water = decoded.vertices.water.get(key); if (!water) continue;
    audit.counts.exactSameXZVertexPairs += 1;
    for (const terrainY of terrain.ys) for (const waterY of water.ys) {
      const delta = Math.abs(terrainY - waterY);
      audit.worstSameXZDeltaMetres = Math.max(audit.worstSameXZDeltaMetres, delta);
      if (delta > VERTICAL_TOLERANCE_METRES) addFinding(audit, { kind: 'exactSameXZVertexVerticalCrack', verticalDeltaMetres: round(delta), localXZ: [round(terrain.x), round(terrain.z)], terrainY: round(terrainY), waterY: round(waterY) });
    }
  }
}

function addSharedEdgeChecks(audit, decoded) {
  for (const [key, terrain] of decoded.edges.terrain) {
    const water = decoded.edges.water.get(key); if (!water) continue;
    audit.counts.exactSharedProjectedEdges += 1;
    for (const point of [terrain.a, terrain.b]) {
      const delta = Math.abs(edgeHeight(terrain, point) - edgeHeight(water, point));
      audit.worstSameXZDeltaMetres = Math.max(audit.worstSameXZDeltaMetres, delta);
      if (delta > VERTICAL_TOLERANCE_METRES) addFinding(audit, { kind: 'exactSharedProjectedEdgeVerticalCrack', verticalDeltaMetres: round(delta), localXZ: [round(point.x), round(point.z)] });
    }
  }
}

function addTJunctionChecks(audit, decoded) {
  const edgeIndex = { terrain: new Map(), water: new Map() };
  for (const category of ['terrain', 'water']) for (const edge of decoded.edges[category].values()) {
    forEachBucket(edge.bounds, (key) => { if (!edgeIndex[category].has(key)) edgeIndex[category].set(key, []); edgeIndex[category].get(key).push(edge); });
  }
  const seen = new Set();
  for (const [vertexCategory, edgeCategory] of [['terrain', 'terrain'], ['terrain', 'water'], ['water', 'terrain'], ['water', 'water']]) {
    for (const [key, vertex] of decoded.vertices[vertexCategory]) {
      const candidates = edgeIndex[edgeCategory].get(`${Math.floor(vertex.x)},${Math.floor(vertex.z)}`) ?? [];
      for (const edge of candidates) {
        if (!pointOnOpenEdge(vertex, edge)) continue;
        const dedupe = `${vertexCategory}:${key}|${edgeCategory}:${edge.key}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        audit.counts.tJunctions += 1;
        const referenceY = edgeHeight(edge, vertex);
        for (const y of vertex.ys) {
          const delta = Math.abs(y - referenceY);
          audit.worstSameXZDeltaMetres = Math.max(audit.worstSameXZDeltaMetres, delta);
          if (delta > VERTICAL_TOLERANCE_METRES) addFinding(audit, { kind: 'tJunctionVerticalCrack', verticalDeltaMetres: round(delta), localXZ: [round(vertex.x), round(vertex.z)], vertexCategory, edgeCategory, vertexY: round(y), edgeY: round(referenceY) });
        }
      }
    }
  }
}

function addPositiveOverlapChecks(audit, decoded) {
  const waterBuckets = new Map(); const largeWater = [];
  for (let index = 0; index < decoded.triangles.water.length; index += 1) {
    const triangle = decoded.triangles.water[index]; const triangleBounds = bounds(triangle);
    const cells = (Math.floor(triangleBounds.maxX + MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES) - Math.floor(triangleBounds.minX - MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES) + 1)
      * (Math.floor(triangleBounds.maxZ + MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES) - Math.floor(triangleBounds.minZ - MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES) + 1);
    if (cells > 4096) { largeWater.push(index); continue; }
    forEachBucket(triangleBounds, (key) => { if (!waterBuckets.has(key)) waterBuckets.set(key, []); waterBuckets.get(key).push(index); });
  }
  const seen = new Set();
  for (let terrainIndex = 0; terrainIndex < decoded.triangles.terrain.length; terrainIndex += 1) {
    const terrain = decoded.triangles.terrain[terrainIndex]; const candidates = new Set(largeWater);
    forEachBucket(bounds(terrain), (key) => (waterBuckets.get(key) ?? []).forEach((index) => candidates.add(index)));
    for (const waterIndex of candidates) {
      const dedupe = `${terrainIndex}|${waterIndex}`; if (seen.has(dedupe)) continue; seen.add(dedupe);
      const water = decoded.triangles.water[waterIndex]; const result = projectedOverlap(terrain, water);
      if (result.area <= OVERLAP_AREA_TOLERANCE_SQUARE_METRES) continue;
      audit.counts.positiveAreaTerrainWaterOverlaps += 1;
      const verticalDeltas = result.polygon.map(({ x, z }) => Math.abs(heightAt(terrain, x, z) - heightAt(water, x, z)));
      const verticalDeltaMetres = Math.max(...verticalDeltas);
      audit.worstSameXZDeltaMetres = Math.max(audit.worstSameXZDeltaMetres, verticalDeltaMetres);
      addFinding(audit, { kind: 'positiveAreaTerrainWaterOverlap', overlapAreaSquareMetres: round(result.area), verticalDeltaMetres: round(verticalDeltaMetres), sampleLocalXZ: [round(result.polygon[0].x), round(result.polygon[0].z)] });
    }
  }
}

function auditDecoded(decoded) {
  const audit = {
    counts: { exactSameCategoryVertexPairs: 0, exactSameXZVertexPairs: 0, exactSharedProjectedEdges: 0, tJunctions: 0, positiveAreaTerrainWaterOverlaps: 0, findings: 0 },
    worstSameXZDeltaMetres: 0, worstPositiveAreaOverlapSquareMetres: 0, findings: [],
  };
  addExactVertexChecks(audit, decoded);
  addSharedEdgeChecks(audit, decoded);
  addTJunctionChecks(audit, decoded);
  addPositiveOverlapChecks(audit, decoded);
  audit.heightContinuous = audit.counts.findings === 0 && audit.counts.positiveAreaTerrainWaterOverlaps === 0;
  audit.conformingTopology = audit.heightContinuous && audit.counts.tJunctions === 0;
  return audit;
}

const receipt = JSON.parse(await readFile(RECEIPT_PATH, 'utf8'));
assert.equal(receipt.kind, 'sf-surface-grid-ownership-proof', 'Unexpected ownership receipt');
assert.equal(receipt.status, 'proof-rejected-residual-topology-or-near-grid-continuity', 'Expected the fail-closed near-grid proof receipt');
assert.equal(receipt.scope?.committedTileCount, 8, 'Audit must use the exact committed eight-tile Ferry sample');
assert.equal(receipt.tiles?.length, 8, 'Audit receipt must contain exactly eight tiles');
assert.equal(receipt.validation?.horizontalSurfaceTopologyIdentical, true, 'Ownership proof did not preserve horizontal topology');
assert.equal(receipt.validation?.maxHorizontalDisplacementMetres, 0, 'Ownership proof moved a horizontal surface vertex');
const tiles = [];
for (const entry of receipt.tiles) {
  const sourcePath = path.resolve(ROOT, entry.sourceLod0.path); const previewPath = path.resolve(ROOT, entry.previewLod0.path);
  assert(sourcePath.startsWith(`${ROOT}${path.sep}`) && previewPath.startsWith(`${ROOT}${path.sep}`), `${entry.id} artifact path escapes workspace`);
  const [sourceBytes, previewBytes] = await Promise.all([readFile(sourcePath), readFile(previewPath)]);
  assert.equal(sha256(sourceBytes), entry.sourceLod0.sha256, `${entry.id} source hash drifted`);
  assert.equal(sha256(previewBytes), entry.previewLod0.sha256, `${entry.id} canonical-height preview hash drifted`);
  const source = decodeSurface(sourceBytes, entry.id); const preview = decodeSurface(previewBytes, entry.id);
  assert.equal(source.horizontalTopologySha256, entry.horizontalSurfaceTopologySha256, `${entry.id} source horizontal topology evidence drifted`);
  assert.equal(preview.horizontalTopologySha256, entry.horizontalSurfaceTopologySha256, `${entry.id} preview horizontal topology evidence drifted`);
  const sourceAudit = auditDecoded(source); const previewAudit = auditDecoded(preview);
  tiles.push({
    id: entry.id,
    source: { sha256: entry.sourceLod0.sha256, horizontalTopologySha256: source.horizontalTopologySha256, ...sourceAudit },
    canonicalHeightPreview: { sha256: entry.previewLod0.sha256, horizontalTopologySha256: preview.horizontalTopologySha256, ...previewAudit },
    horizontalTopologyIdentical: source.horizontalTopologySha256 === preview.horizontalTopologySha256,
  });
}

const total = (selector) => tiles.reduce((sum, tile) => sum + selector(tile), 0);
const sourceHeightContinuous = tiles.every(({ source }) => source.heightContinuous);
const previewHeightContinuous = tiles.every(({ canonicalHeightPreview }) => canonicalHeightPreview.heightContinuous);
const sourceConformingTopology = tiles.every(({ source }) => source.conformingTopology);
const previewConformingTopology = tiles.every(({ canonicalHeightPreview }) => canonicalHeightPreview.conformingTopology);
const topologyIdentical = tiles.every(({ horizontalTopologyIdentical }) => horizontalTopologyIdentical);
const sourceWorst = Math.max(0, ...tiles.map(({ source }) => source.worstSameXZDeltaMetres));
const previewWorst = Math.max(0, ...tiles.map(({ canonicalHeightPreview }) => canonicalHeightPreview.worstSameXZDeltaMetres));
const sourceTJunctions = total(({ source }) => source.counts.tJunctions);
const previewTJunctions = total(({ canonicalHeightPreview }) => canonicalHeightPreview.counts.tJunctions);
const sourceOverlaps = total(({ source }) => source.counts.positiveAreaTerrainWaterOverlaps);
const previewOverlaps = total(({ canonicalHeightPreview }) => canonicalHeightPreview.counts.positiveAreaTerrainWaterOverlaps);
const proofAccepted = !sourceHeightContinuous && previewHeightContinuous && topologyIdentical && sourceOverlaps === 0 && previewOverlaps === 0;
const report = {
  schemaVersion: 1,
  kind: 'sf-same-xz-terrain-water-surface-continuity-audit',
  status: proofAccepted
    ? previewConformingTopology ? 'proof-passed-bounded-c0-and-conforming-not-promoted' : 'proof-passed-bounded-c0-not-promoted-nonconforming-topology'
    : 'proof-rejected-same-xz-continuity',
  scope: { committedTileCount: tiles.length, receipt: path.relative(ROOT, RECEIPT_PATH).split(path.sep).join('/'), lod: 0, readOnly: true, artifactWrites: false, reportOnly: auditOnly },
  tolerances: { sameXZVerticalMetres: VERTICAL_TOLERANCE_METRES, positiveProjectedOverlapSquareMetres: OVERLAP_AREA_TOLERANCE_SQUARE_METRES, projectedPointOnEdgeNumerical: 'dynamic two float32 ULPs per decoded local coordinate', maximumProjectedPointOnEdgeNumericalMetres: MAX_PROJECTED_ON_EDGE_TOLERANCE_METRES },
  method: {
    exactVertices: 'Compare decoded post-float32 same-category and cross-category vertex heights only when x and z match exactly.',
    sharedEdges: 'Compare both endpoints of exactly identical projected terrain/water edges; equality at endpoints proves equality on the linear shared edge.',
    tJunctions: 'Use a deterministic 1 m spatial index to test every terrain/water vertex against same-category and cross-category open projected edges, then compare heights at that identical X/Z.',
    overlap: 'Use a deterministic 1 m projected triangle spatial index; for every terrain/water overlap above tolerance compare affine triangle heights at every overlap-polygon vertex.',
    qualification: 'A pair of vertices separated in X/Z, including the prior approximately 1 mm near-grid observations, is intentionally not a same-XZ crack.',
  },
  baselineReproduction: {
    sourceArtifactsHashLocked: true,
    sourceHeightContinuous,
    committedLegacyNearGridFindings: receipt.validation?.baselineFindings ?? null,
    note: 'The committed ownership proof rejected six near-grid findings. This audit reproduces the hash-locked source geometry under the stricter same-XZ predicate, rather than reclassifying horizontally distinct slope samples as vertical cracks.',
  },
  summary: {
    canonicalHeightPreviewHeightContinuous: previewHeightContinuous,
    canonicalHeightPreviewConformingTopology: previewConformingTopology,
    horizontalTopologyIdentical: topologyIdentical,
    source: { heightContinuous: sourceHeightContinuous, conformingTopology: sourceConformingTopology, worstSameXZDeltaMetres: sourceWorst, tJunctions: sourceTJunctions, positiveAreaTerrainWaterOverlaps: sourceOverlaps },
    canonicalHeightPreview: { heightContinuous: previewHeightContinuous, conformingTopology: previewConformingTopology, worstSameXZDeltaMetres: previewWorst, tJunctions: previewTJunctions, positiveAreaTerrainWaterOverlaps: previewOverlaps },
  },
  tiles,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ result: report.status, reportPath, sourceHeightContinuous, canonicalHeightPreviewHeightContinuous: previewHeightContinuous, canonicalHeightPreviewConformingTopology: previewConformingTopology, sourceWorstSameXZDeltaMetres: sourceWorst, previewWorstSameXZDeltaMetres: previewWorst, sourceTJunctions, previewTJunctions, sourceOverlaps, previewOverlaps }, null, 2));
if (!proofAccepted && !auditOnly) process.exitCode = 1;
