import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const GRID_NEAR_METRES = 0.0011;
export const ORTHOGONAL_NEAR_METRES = 0.00001;
export const VERTICAL_TOLERANCE_METRES = 0.000001;

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

function positionReader(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex]; assert(accessor, `Missing accessor ${accessorIndex}`);
  assert.equal(accessor.type, 'VEC3', `Accessor ${accessorIndex} must be VEC3`); assert.equal(accessor.componentType, 5126, `Accessor ${accessorIndex} must be float32`);
  const view = gltf.bufferViews[accessor.bufferView]; assert(view, `Missing buffer view ${accessor.bufferView}`);
  const stride = view.byteStride ?? 12; const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, index) => {
    const at = base + index * stride;
    return { x: bin.readFloatLE(at), y: bin.readFloatLE(at + 4), z: bin.readFloatLE(at + 8) };
  });
}

function indexReader(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex]; assert(accessor, `Missing accessor ${accessorIndex}`);
  assert.equal(accessor.type, 'SCALAR', `Accessor ${accessorIndex} must be SCALAR`);
  assert([5123, 5125].includes(accessor.componentType), `Accessor ${accessorIndex} must use uint16 or uint32 indices`);
  const view = gltf.bufferViews[accessor.bufferView]; assert(view, `Missing buffer view ${accessor.bufferView}`);
  const elementBytes = accessor.componentType === 5123 ? 2 : 4; const stride = view.byteStride ?? elementBytes; const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, index) => accessor.componentType === 5123 ? bin.readUInt16LE(base + index * stride) : bin.readUInt32LE(base + index * stride));
}

const round = (value, digits = 12) => Number(value.toFixed(digits));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const pointKey = (point) => `${point.x},${point.z}`;

/** Read only terrain/water vertices and prove the local surface has no exact
 * or sub-grid alias discontinuities. This intentionally mirrors the relevant
 * fail-closed rules of the committed production continuity audit. */
export function auditSurfaceContinuity(bytes, expectedTileId) {
  const { gltf, bin } = parseGlb(bytes);
  assert.equal(gltf.extras?.tileId, expectedTileId, 'Preview GLB tile id drifted');
  assert.equal(gltf.extras?.lod, 0, 'Preview must remain LOD0');
  assert.equal(gltf.extras?.unitsPerMetre, 1, 'Preview must retain 1 unit per metre');
  const points = new Map(); const vertices = []; const topologyHash = createHash('sha256');
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    const category = primitive.extras?.category;
    if (category !== 'terrain' && category !== 'water') continue;
    topologyHash.update(`${category}\0`);
    for (const point of positionReader(gltf, bin, primitive.attributes.POSITION)) {
      assert(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z), 'Non-finite surface vertex');
      const horizontalBytes = Buffer.allocUnsafe(8); horizontalBytes.writeFloatLE(point.x, 0); horizontalBytes.writeFloatLE(point.z, 4); topologyHash.update(horizontalBytes);
      const key = pointKey(point); const entry = points.get(key) ?? { x: point.x, z: point.z, samples: [], categories: new Set() };
      entry.samples.push({ y: point.y, category }); entry.categories.add(category); points.set(key, entry);
      vertices.push({ ...point, category });
    }
    topologyHash.update('\0indices\0');
    for (const index of indexReader(gltf, bin, primitive.indices)) { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32LE(index); topologyHash.update(bytes); }
  }
  assert(points.size > 0, 'Preview has no terrain or water vertices');
  const findings = [];
  const add = (finding) => { if (findings.length < 64) findings.push(finding); };
  let exactSharedVertices = 0;
  for (const point of points.values()) {
    const terrain = point.samples.filter(({ category }) => category === 'terrain').map(({ y }) => y);
    const water = point.samples.filter(({ category }) => category === 'water').map(({ y }) => y);
    if (!terrain.length || !water.length) continue;
    exactSharedVertices += 1;
    const delta = Math.max(...terrain) - Math.min(...water);
    if (Math.abs(delta) > VERTICAL_TOLERANCE_METRES) add({ kind: 'exactSharedVertexVerticalDiscontinuity', local: [round(point.x), round((terrain[0] + water[0]) / 2), round(point.z)], verticalDeltaMetres: round(Math.abs(delta)) });
  }
  const near = new Map();
  for (const point of points.values()) for (const axis of ['x', 'z']) {
    const coordinate = point[axis]; const perpendicular = point[axis === 'x' ? 'z' : 'x']; const boundary = Math.round(coordinate);
    if (Math.abs(coordinate - boundary) > GRID_NEAR_METRES) continue;
    const side = coordinate < boundary - 1e-9 ? 'minus' : coordinate > boundary + 1e-9 ? 'plus' : 'on';
    const key = `${axis}|${boundary}|${Math.round(perpendicular / ORTHOGONAL_NEAR_METRES)}`;
    if (!near.has(key)) near.set(key, []); near.get(key).push({ point, side });
  }
  let nearGridCrossingsExamined = 0;
  const nearDedupe = new Set();
  for (const [key, candidates] of near) {
    nearGridCrossingsExamined += candidates.length;
    for (let left = 0; left < candidates.length; left += 1) for (let right = left + 1; right < candidates.length; right += 1) {
      const a = candidates[left]; const b = candidates[right];
      if (a.point === b.point || a.side === b.side || (a.side === 'on' && b.side === 'on')) continue;
      const horizontalSeparationMetres = distance(a.point, b.point);
      if (horizontalSeparationMetres <= 1e-12 || horizontalSeparationMetres > GRID_NEAR_METRES) continue;
      for (const leftSample of a.point.samples) for (const rightSample of b.point.samples) {
        const verticalDeltaMetres = Math.abs(leftSample.y - rightSample.y);
        if (verticalDeltaMetres <= VERTICAL_TOLERANCE_METRES) continue;
        const sampleKey = [pointKey(a.point), pointKey(b.point)].sort().join('|');
        const dedupe = `${sampleKey}|${leftSample.y}|${rightSample.y}`;
        if (nearDedupe.has(dedupe)) continue;
        nearDedupe.add(dedupe);
        add({ kind: 'nearGridCrossingVerticalDiscontinuity', gridLine: key.split('|').slice(0, 2).join('='), horizontalSeparationMetres: round(horizontalSeparationMetres), verticalDeltaMetres: round(verticalDeltaMetres), left: [round(a.point.x), round(leftSample.y), round(a.point.z)], right: [round(b.point.x), round(rightSample.y), round(b.point.z)] });
      }
    }
  }
  const maxVerticalDeltaMetres = findings.reduce((maximum, finding) => Math.max(maximum, finding.verticalDeltaMetres ?? 0), 0);
  return { findings, violations: findings.length, maxVerticalDeltaMetres, exactSharedVertices, nearGridCrossingsExamined, vertices, horizontalSurfaceTopologySha256: `sha256:${topologyHash.digest('hex')}` };
}

/** Every changed preview vertex must be explainable as a bounded snap to a
 * source surface vertex of the same category. No projection or resampling is
 * allowed by this proof. */
export function measureHorizontalMovement(sourceVertices, repairedVertices) {
  assert.equal(repairedVertices.length, sourceVertices.length, 'Preview changed the surface vertex count');
  let maxHorizontalDisplacementMetres = 0; let movedVertices = 0;
  for (let index = 0; index < repairedVertices.length; index += 1) {
    const source = sourceVertices[index]; const repaired = repairedVertices[index];
    assert.equal(repaired.category, source.category, `Preview changed surface category at vertex ${index}`);
    const displacement = distance(source, repaired);
    maxHorizontalDisplacementMetres = Math.max(maxHorizontalDisplacementMetres, displacement);
    if (displacement > 1e-12) movedVertices += 1;
  }
  return { maxHorizontalDisplacementMetres, movedVertices, repairedSurfaceVertices: repairedVertices.length };
}
