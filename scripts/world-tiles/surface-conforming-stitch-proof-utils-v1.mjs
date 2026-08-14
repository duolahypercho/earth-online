import assert from 'node:assert/strict';

const TOLERANCE = 1e-5;
const key = (x, z) => `${x},${z}`;
const signedArea = ([a, b, c]) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const bounds = (points) => points.reduce((out, point) => ({ minX: Math.min(out.minX, point.x), maxX: Math.max(out.maxX, point.x), minZ: Math.min(out.minZ, point.z), maxZ: Math.max(out.maxZ, point.z) }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch'); assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch'); assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB declared length mismatch');
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()); const binOffset = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing'); assert.equal(binOffset + 8 + bytes.readUInt32LE(binOffset), bytes.length, 'GLB BIN length mismatch');
  return { gltf, bin: bytes.subarray(binOffset + 8) };
}

function readPositions(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex]; assert(accessor?.type === 'VEC3' && accessor.componentType === 5126, 'Surface positions must be float32 VEC3');
  const view = gltf.bufferViews[accessor.bufferView]; const stride = view.byteStride ?? 12; const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const values = [];
  for (let index = 0; index < accessor.count; index += 1) { const offset = base + index * stride; values.push(bin.readFloatLE(offset), bin.readFloatLE(offset + 4), bin.readFloatLE(offset + 8)); }
  return values;
}

function readIndices(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex]; assert(accessor?.type === 'SCALAR' && [5123, 5125].includes(accessor.componentType), 'Surface indices must be uint16/uint32 SCALAR');
  const view = gltf.bufferViews[accessor.bufferView]; const width = accessor.componentType === 5123 ? 2 : 4; const stride = view.byteStride ?? width; const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const values = [];
  for (let index = 0; index < accessor.count; index += 1) values.push(accessor.componentType === 5123 ? bin.readUInt16LE(base + index * stride) : bin.readUInt32LE(base + index * stride));
  return values;
}

export function surfaceCategoriesFromGlb(bytes, expectedTileId) {
  const { gltf, bin } = parseGlb(bytes); assert.equal(gltf.extras?.tileId, expectedTileId, 'GLB tile id drifted'); assert.equal(gltf.extras?.lod, 0, 'GLB must remain LOD0'); assert.equal(gltf.extras?.unitsPerMetre, 1, 'GLB must retain one unit per metre');
  const categories = { terrain: { positions: [], indices: [] }, water: { positions: [], indices: [] } };
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    const category = primitive.extras?.category; if (!categories[category]) continue;
    const target = categories[category]; const vertexOffset = target.positions.length / 3; const primitivePositions = readPositions(gltf, bin, primitive.attributes.POSITION); const primitiveIndices = readIndices(gltf, bin, primitive.indices);
    for (const value of primitivePositions) target.positions.push(value);
    for (const index of primitiveIndices) target.indices.push(index + vertexOffset);
  }
  assert(categories.terrain.positions.length + categories.water.positions.length > 0, 'GLB has no terrain/water positions');
  return categories;
}

/** Decode the builder's in-memory positions through Float32, exactly as GLB
 * serialization does, so every result below is a post-float32 check. */
export function decodeSurfaceCategories(categories) {
  const decoded = { vertices: { terrain: new Map(), water: new Map() }, edges: new Map(), triangles: { terrain: [], water: [] } };
  for (const category of ['terrain', 'water']) {
    const source = categories[category]; const points = [];
    for (let index = 0; index < source.positions.length; index += 3) points.push({ x: Math.fround(source.positions[index]), y: Math.fround(source.positions[index + 1]), z: Math.fround(source.positions[index + 2]) });
    for (const point of points) {
      const id = key(point.x, point.z); const record = decoded.vertices[category].get(id) ?? { ...point, ys: new Set() };
      record.ys.add(point.y); decoded.vertices[category].set(id, record);
    }
    for (let index = 0; index < source.indices.length; index += 3) {
      const triangle = [points[source.indices[index]], points[source.indices[index + 1]], points[source.indices[index + 2]]];
      if (Math.abs(signedArea(triangle)) <= 1e-14) continue;
      decoded.triangles[category].push(triangle);
      for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
        const a = triangle[edgeIndex]; const b = triangle[(edgeIndex + 1) % 3]; const ordered = key(a.x, a.z) < key(b.x, b.z) ? [a, b] : [b, a];
        if (key(ordered[0].x, ordered[0].z) !== key(ordered[1].x, ordered[1].z)) decoded.edges.set(`${key(ordered[0].x, ordered[0].z)}|${key(ordered[1].x, ordered[1].z)}`, { a: ordered[0], b: ordered[1] });
      }
    }
  }
  return decoded;
}

function pointOnOpenEdge(point, edge) {
  const dx = edge.b.x - edge.a.x; const dz = edge.b.z - edge.a.z; const length2 = dx * dx + dz * dz;
  if (length2 <= 1e-14) return false;
  if (Math.abs(dx * (point.z - edge.a.z) - dz * (point.x - edge.a.x)) > 2e-5 * Math.sqrt(length2)) return false;
  const t = ((point.x - edge.a.x) * dx + (point.z - edge.a.z) * dz) / length2;
  return t > 1e-8 && t < 1 - 1e-8;
}

function edgeHeight(edge, point) {
  const dx = edge.b.x - edge.a.x; const dz = edge.b.z - edge.a.z;
  const t = ((point.x - edge.a.x) * dx + (point.z - edge.a.z) * dz) / (dx * dx + dz * dz);
  return edge.a.y + (edge.b.y - edge.a.y) * t;
}

function clip(subject, a, b) {
  const out = []; const cross = (p) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
  const intersect = (p, q) => { const dx = q.x - p.x; const dz = q.z - p.z; const ex = b.x - a.x; const ez = b.z - a.z; const d = dx * ez - dz * ex; if (Math.abs(d) < 1e-15) return p; const t = ((a.x - p.x) * ez - (a.z - p.z) * ex) / d; return { x: p.x + t * dx, z: p.z + t * dz }; };
  for (let index = 0; index < subject.length; index += 1) { const p = subject[(index + subject.length - 1) % subject.length]; const q = subject[index]; const pin = cross(p) >= -1e-12; const qin = cross(q) >= -1e-12; if (pin && !qin) out.push(intersect(p, q)); if (qin) out.push(q); if (!pin && qin) out.push(intersect(p, q)); }
  return out;
}

function overlapArea(left, right) {
  const clipTriangle = signedArea(right) >= 0 ? right : [right[0], right[2], right[1]]; let polygon = left.map(({ x, z }) => ({ x, z }));
  for (let index = 0; index < 3 && polygon.length; index += 1) polygon = clip(polygon, clipTriangle[index], clipTriangle[(index + 1) % 3]);
  return Math.abs(polygon.reduce((sum, point, index) => { const next = polygon[(index + 1) % polygon.length] ?? point; return sum + point.x * next.z - next.x * point.z; }, 0)) / 2;
}

/** Strict C0/topology audit. The 1 m bucket index makes cross-category
 * overlap checks tractable while retaining exact projected triangle clipping. */
export function auditConformingSurface(categories) {
  const decoded = decodeSurfaceCategories(categories); let worstC0 = 0; let c0Findings = 0; let tJunctions = 0; let positiveTerrainWaterOverlaps = 0;
  for (const [id, terrain] of decoded.vertices.terrain) {
    const water = decoded.vertices.water.get(id); if (!water) continue;
    for (const terrainY of terrain.ys) for (const waterY of water.ys) { const delta = Math.abs(terrainY - waterY); worstC0 = Math.max(worstC0, delta); if (delta > TOLERANCE) c0Findings += 1; }
  }
  const edgeBuckets = new Map();
  for (const edge of decoded.edges.values()) { const box = bounds([edge.a, edge.b]); for (let x = Math.floor(box.minX); x <= Math.floor(box.maxX); x += 1) for (let z = Math.floor(box.minZ); z <= Math.floor(box.maxZ); z += 1) { const bucket = `${x},${z}`; if (!edgeBuckets.has(bucket)) edgeBuckets.set(bucket, []); edgeBuckets.get(bucket).push(edge); } }
  const seenJunctions = new Set();
  for (const category of ['terrain', 'water']) for (const [id, vertex] of decoded.vertices[category]) for (const edge of edgeBuckets.get(`${Math.floor(vertex.x)},${Math.floor(vertex.z)}`) ?? []) {
    if (!pointOnOpenEdge(vertex, edge)) continue; const junctionId = `${id}|${key(edge.a.x, edge.a.z)}|${key(edge.b.x, edge.b.z)}`;
    if (!seenJunctions.has(junctionId)) {
      seenJunctions.add(junctionId); tJunctions += 1;
      for (const y of vertex.ys) { const delta = Math.abs(y - edgeHeight(edge, vertex)); worstC0 = Math.max(worstC0, delta); if (delta > TOLERANCE) c0Findings += 1; }
    }
  }
  const waterBuckets = new Map();
  for (const [index, triangle] of decoded.triangles.water.entries()) { const box = bounds(triangle); for (let x = Math.floor(box.minX); x <= Math.floor(box.maxX); x += 1) for (let z = Math.floor(box.minZ); z <= Math.floor(box.maxZ); z += 1) { const bucket = `${x},${z}`; if (!waterBuckets.has(bucket)) waterBuckets.set(bucket, []); waterBuckets.get(bucket).push(index); } }
  const seenPairs = new Set();
  for (const [terrainIndex, terrain] of decoded.triangles.terrain.entries()) { const box = bounds(terrain); for (let x = Math.floor(box.minX); x <= Math.floor(box.maxX); x += 1) for (let z = Math.floor(box.minZ); z <= Math.floor(box.maxZ); z += 1) for (const waterIndex of waterBuckets.get(`${x},${z}`) ?? []) { const pair = `${terrainIndex}|${waterIndex}`; if (seenPairs.has(pair)) continue; seenPairs.add(pair); if (overlapArea(terrain, decoded.triangles.water[waterIndex]) > 1e-10) positiveTerrainWaterOverlaps += 1; } }
  let fixedDiagonalCrossingTriangles = 0;
  for (const category of ['terrain', 'water']) for (const triangle of decoded.triangles[category]) {
    const centroidX = triangle.reduce((sum, point) => sum + point.x, 0) / 3; const centroidZ = triangle.reduce((sum, point) => sum + point.z, 0) / 3;
    const baseX = Math.floor(centroidX); const baseZ = Math.floor(centroidZ);
    const sides = triangle.map((point) => (point.x - baseX) - (point.z - baseZ));
    if (Math.min(...sides) < -1e-7 && Math.max(...sides) > 1e-7) fixedDiagonalCrossingTriangles += 1;
  }
  return { worstC0Metres: worstC0, c0Findings, tJunctionIncidences: tJunctions, positiveTerrainWaterOverlaps, fixedDiagonalCrossingTriangles, passed: worstC0 <= TOLERANCE && c0Findings === 0 && tJunctions === 0 && positiveTerrainWaterOverlaps === 0 };
}

export function assertAudit(result, label) { assert(result.passed, `${label} failed C0/topology audit: ${JSON.stringify(result)}`); }
