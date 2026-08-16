/**
 * Build an isolated, offline-only adaptive terrain/water LOD proof.
 *
 * The proof starts with 4 m quads, refines failing quads to 2 m and then to
 * 1 m source triangles, and never changes OSM road/building/coastline payloads.
 * It is deliberately not a production builder: output is written only below
 * preview-artifacts and is never added to a manifest or package.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSfMetricTile,
  loadSfMetricSharedInputs,
  loadSfMetricVerifiedTerrainSourceDigests,
} from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-lod1-adaptive-proof-v1');
const METRIC_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const FERRY_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const CONTRACT_PATH = path.join(ROOT, 'public/data/world/contracts/sf-one-to-one-map.contract.json');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const TILE_SIZE = 384;
const EPS = 1e-8;
const SAMPLE = Object.freeze([
  [1440, 10892], [1440, 10893], [1441, 10893], [1440, 10894],
]);
const STEPS = Object.freeze([4, 2, 1]);
const idFor = ([easting, northing]) => `epsg26910-${easting}-${northing}`;
const productionStem = (id) => id === 'epsg26910-1441-10893' ? 'ferry-production-tile-v1' : id;
const productionDir = (id) => id === 'epsg26910-1441-10893' ? FERRY_ROOT : path.join(METRIC_ROOT, id);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes) => `sha256:${sha256(bytes)}`;
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const key2 = (x, z) => `${x},${z}`;
const key3 = (x, y, z) => `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length mismatch');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binOffset = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing');
  const binLength = bytes.readUInt32LE(binOffset);
  return { gltf, bin: bytes.subarray(binOffset + 8, binOffset + 8 + binLength) };
}

function readPrimitive(gltf, bin, primitive) {
  const positionAccessor = gltf.accessors[primitive.attributes.POSITION];
  const indexAccessor = gltf.accessors[primitive.indices];
  const positionView = gltf.bufferViews[positionAccessor.bufferView];
  const indexView = gltf.bufferViews[indexAccessor.bufferView];
  assert.equal(positionAccessor.componentType, 5126, 'positions must be float32');
  assert.equal(positionAccessor.type, 'VEC3', 'positions must be VEC3');
  assert.equal(indexAccessor.componentType, 5123, 'indices must be uint16');
  const positionOffset = positionView.byteOffset ?? 0;
  const indexOffset = indexView.byteOffset ?? 0;
  const positions = [];
  for (let index = 0; index < positionAccessor.count; index += 1) {
    const at = positionOffset + index * 12;
    positions.push([bin.readFloatLE(at), bin.readFloatLE(at + 4), bin.readFloatLE(at + 8)]);
  }
  const indices = [];
  for (let index = 0; index < indexAccessor.count; index += 1) indices.push(bin.readUInt16LE(indexOffset + index * 2));
  return { category: primitive.extras?.category, primitive, positions, indices };
}

function semanticPayload(bytes, category) {
  const { gltf, bin } = parseGlb(bytes);
  const positions = [];
  const indices = [];
  let vertexOffset = 0;
  let found = false;
  for (const primitive of gltf.meshes[0].primitives) {
    if (primitive.extras?.category !== category) continue;
    const parsed = readPrimitive(gltf, bin, primitive);
    const positionAccessor = gltf.accessors[primitive.attributes.POSITION];
    const indexAccessor = gltf.accessors[primitive.indices];
    const positionView = gltf.bufferViews[positionAccessor.bufferView];
    const indexView = gltf.bufferViews[indexAccessor.bufferView];
    const positionOffset = positionView.byteOffset ?? 0;
    const indexOffset = indexView.byteOffset ?? 0;
    positions.push(bin.subarray(positionOffset, positionOffset + positionAccessor.count * 12));
    const normalized = Buffer.alloc(indexAccessor.count * 4);
    for (let index = 0; index < indexAccessor.count; index += 1) {
      normalized.writeUInt32LE(bin.readUInt16LE(indexOffset + index * 2) + vertexOffset, index * 4);
    }
    indices.push(normalized);
    vertexOffset += parsed.positions.length;
    found = true;
  }
  return found ? Buffer.concat([...positions, ...indices]) : Buffer.alloc(0);
}

async function readProduction(id) {
  const dir = productionDir(id);
  const stem = productionStem(id);
  const [glb, receiptBytes, packageBytes] = await Promise.all([
    readFile(path.join(dir, `${stem}.lod0.glb`)),
    readFile(path.join(dir, `${stem}.receipt.json`)),
    readFile(path.join(dir, `${stem}.package.json`)),
  ]);
  const receipt = JSON.parse(receiptBytes);
  const mapPackage = JSON.parse(packageBytes);
  assert.equal(receipt.tile.identity, id, `wrong production receipt for ${id}`);
  assert.equal(receipt.lods[0].artifactHash, digest(glb), `production LOD0 hash drifted for ${id}`);
  assert.equal(mapPackage.lods[0].artifactHash, digest(glb), `production package LOD0 hash drifted for ${id}`);
  const sourceLocks = [];
  for (const lock of mapPackage.sourceLocks) {
    const lockBytes = await readFile(path.join(ROOT, lock.path));
    assert.equal(sha256(lockBytes), lock.sha256, `source lock drifted for ${id}: ${lock.id}`);
    sourceLocks.push(lock);
  }
  return { id, dir, stem, glb, receiptBytes, packageBytes, receipt, mapPackage, sourceLocks };
}

function sourceTile(glbBytes) {
  const { gltf, bin } = parseGlb(glbBytes);
  const primitives = gltf.meshes[0].primitives.map((primitive) => readPrimitive(gltf, bin, primitive));
  const triangles = [];
  const vertices = new Map();
  const values = new Map();
  for (const primitive of primitives) {
    if (!['terrain', 'water'].includes(primitive.category)) continue;
    for (let index = 0; index < primitive.indices.length; index += 3) {
      const triangle = primitive.indices.slice(index, index + 3).map((vertex) => primitive.positions[vertex]);
      triangles.push({ category: primitive.category, vertices: triangle });
      for (const [x, y, z] of triangle) {
        const surfaceKey = `${x.toFixed(6)},${z.toFixed(6)}`;
        const previous = vertices.get(surfaceKey);
        assert(previous === undefined || Math.abs(previous.y - y) <= 1e-6, `LOD0 surface disagreement at ${surfaceKey}`);
        const categories = previous?.categories ?? new Set();
        categories.add(primitive.category);
        vertices.set(surfaceKey, { x, y, z, category: primitive.category, categories });
        if (Math.abs(x - Math.round(x)) <= 1e-6 && Math.abs(z - Math.round(z)) <= 1e-6) {
          const sampleKey = key2(Math.round(x), Math.round(z));
          const existing = values.get(sampleKey);
          assert(existing === undefined || Math.abs(existing - y) <= 1e-6, `LOD0 source sample disagreement at ${sampleKey}`);
          values.set(sampleKey, y);
        }
      }
    }
  }
  assert.equal(values.size, (TILE_SIZE + 1) ** 2, 'LOD0 terrain/water is missing integer source samples');
  return { gltf, primitives, triangles, vertices, values };
}

function triangleArea2(triangle) {
  const points = triangle.vertices ?? triangle;
  return (points[1][0] - points[0][0]) * (points[2][2] - points[0][2]) -
    (points[2][0] - points[0][0]) * (points[1][2] - points[0][2]);
}

function triangleHeight(triangle, x, z) {
  const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = triangle;
  const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  assert(Math.abs(denominator) > EPS, 'degenerate terrain triangle');
  const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
  const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
  return u * ay + v * by + (1 - u - v) * cy;
}

function pointInTriangle(triangle, x, z) {
  const denominator = triangleArea2(triangle);
  if (Math.abs(denominator) <= EPS) return false;
  const [[ax, , az], [bx, , bz], [cx, , cz]] = triangle;
  const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
  const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
  const w = 1 - u - v;
  return u >= -1e-7 && v >= -1e-7 && w >= -1e-7;
}

function rectTriangles(x, z, size, values, category) {
  const a = [x, values.get(key2(x, z)), z];
  const b = [x + size, values.get(key2(x + size, z)), z];
  const c = [x + size, values.get(key2(x + size, z + size)), z + size];
  const d = [x, values.get(key2(x, z + size)), z + size];
  for (const vertex of [a, b, c, d]) assert(Number.isFinite(vertex[1]), `missing adaptive corner height ${vertex[0]},${vertex[2]}`);
  return [
    { category, vertices: [a, b, c] },
    { category, vertices: [a, c, d] },
  ];
}

function triangleCells(triangle) {
  const xs = triangle.vertices.map(([x]) => x);
  const zs = triangle.vertices.map(([, , z]) => z);
  const fromX = Math.max(0, Math.floor(Math.min(...xs) + EPS));
  const toX = Math.min(TILE_SIZE - 1, Math.ceil(Math.max(...xs) - EPS) - 1);
  const fromZ = Math.max(0, Math.floor(Math.min(...zs) + EPS));
  const toZ = Math.min(TILE_SIZE - 1, Math.ceil(Math.max(...zs) - EPS) - 1);
  const result = [];
  for (let z = fromZ; z <= toZ; z += 1) for (let x = fromX; x <= toX; x += 1) result.push(key2(x, z));
  return result;
}

function buildUnitCellIndex(source) {
  const cells = new Map();
  for (const triangle of source.triangles) {
    for (const cellKey of triangleCells(triangle)) {
      if (!cells.has(cellKey)) cells.set(cellKey, []);
      cells.get(cellKey).push(triangle);
    }
  }
  const unit = new Map();
  for (let z = 0; z < TILE_SIZE; z += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const key = key2(x, z);
      const candidates = cells.get(key) ?? [];
      const categories = [...new Set(candidates.map(({ category }) => category))];
      const corners = new Set();
      let area = 0;
      for (const triangle of candidates) {
        area += Math.abs(triangleArea2(triangle)) / 2;
        for (const [vx, , vz] of triangle.vertices) {
          if (Math.abs(vx - Math.round(vx)) > 1e-6 || Math.abs(vz - Math.round(vz)) > 1e-6) continue;
          if (vx < x - 1e-6 || vx > x + 1 + 1e-6 || vz < z - 1e-6 || vz > z + 1 + 1e-6) continue;
          corners.add(key2(Math.round(vx), Math.round(vz)));
        }
      }
      const full = categories.length === 1 && candidates.length === 2 && corners.size === 4 && Math.abs(area - 1) <= 1e-5;
      const rawByCategory = new Map();
      for (const triangle of candidates) {
        if (!rawByCategory.has(triangle.category)) rawByCategory.set(triangle.category, []);
        rawByCategory.get(triangle.category).push(triangle);
      }
      unit.set(key, { category: full ? categories[0] : null, rawByCategory });
    }
  }
  return unit;
}

function vertexCellIndex(source) {
  const index = new Map();
  for (const vertex of source.vertices.values()) {
    const fromX = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(Math.min(TILE_SIZE - 1e-7, Math.max(0, vertex.x)))));
    const fromZ = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(Math.min(TILE_SIZE - 1e-7, Math.max(0, vertex.z)))));
    const key = key2(fromX, fromZ);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(vertex);
  }
  return index;
}

function blockCategory(unit, x, z, size) {
  let category = null;
  for (let dz = 0; dz < size; dz += 1) for (let dx = 0; dx < size; dx += 1) {
    const cell = unit.get(key2(x + dx, z + dz));
    if (!cell?.category) return null;
    if (category && category !== cell.category) return null;
    category = cell.category;
  }
  // A coarse patch may not bridge a directed coastline/fractional cell just
  // outside its footprint.  The one-cell halo keeps the serialized land/water
  // partition conforming at the patch boundary instead of hiding a crack in
  // an otherwise full interior block.
  for (let offset = 0; offset < size; offset += 1) {
    for (const [nx, nz] of [[x + offset, z - 1], [x + offset, z + size], [x - 1, z + offset], [x + size, z + offset]]) {
      if (nx < 0 || nz < 0 || nx >= TILE_SIZE || nz >= TILE_SIZE) continue;
      const neighbor = unit.get(key2(nx, nz));
      if (!neighbor?.category || neighbor.category !== category) return null;
    }
  }
  return category;
}

function candidateError(source, vertexIndex, x, z, size, category) {
  const candidate = rectTriangles(x, z, size, source.values, category);
  let max = 0;
  for (let dz = 0; dz <= size; dz += 1) for (let dx = 0; dx <= size; dx += 1) {
    const sourceHeight = source.values.get(key2(x + dx, z + dz));
    const candidateHeight = pointInTriangle(candidate[0].vertices, x + dx, z + dz)
      ? triangleHeight(candidate[0].vertices, x + dx, z + dz)
      : triangleHeight(candidate[1].vertices, x + dx, z + dz);
    max = Math.max(max, Math.abs(candidateHeight - sourceHeight));
  }
  for (let dz = 0; dz < size; dz += 1) for (let dx = 0; dx < size; dx += 1) {
    for (const vertex of vertexIndex.get(key2(x + dx, z + dz)) ?? []) {
      if (vertex.x < x - 1e-6 || vertex.x > x + size + 1e-6 || vertex.z < z - 1e-6 || vertex.z > z + size + 1e-6) continue;
      const candidateHeight = pointInTriangle(candidate[0].vertices, vertex.x, vertex.z)
        ? triangleHeight(candidate[0].vertices, vertex.x, vertex.z)
        : triangleHeight(candidate[1].vertices, vertex.x, vertex.z);
      max = Math.max(max, Math.abs(candidateHeight - vertex.y));
    }
  }
  return max;
}

function rawPatches(unit, x, z) {
  const cell = unit.get(key2(x, z));
  const patches = [];
  for (const [category, triangles] of cell?.rawByCategory ?? []) {
    if (triangles.length) patches.push({ x, z, size: 1, category, triangles, mode: 'source-1m' });
  }
  assert(patches.length, `LOD0 surface gap at unit cell ${x},${z}`);
  return patches;
}

function makeAdaptivePatches(source, forcedKeys = new Set()) {
  const unit = buildUnitCellIndex(source);
  const vertexIndex = vertexCellIndex(source);
  const refine = (x, z, size) => {
    if (size === 1) return rawPatches(unit, x, z);
    const category = x === 0 || z === 0 || x + size === TILE_SIZE || z + size === TILE_SIZE
      ? null : blockCategory(unit, x, z, size);
    if (!category) {
      const half = size / 2;
      return [
        ...refine(x, z, half), ...refine(x + half, z, half),
        ...refine(x, z + half, half), ...refine(x + half, z + half, half),
      ];
    }
    if (forcedKeys.has(`${x},${z},${size}`)) {
      const half = size / 2;
      return [
        ...refine(x, z, half), ...refine(x + half, z, half),
        ...refine(x, z + half, half), ...refine(x + half, z + half, half),
      ];
    }
    const error = candidateError(source, vertexIndex, x, z, size, category);
    if (error <= 0.25 + 1e-9) return [{ x, z, size, category, triangles: rectTriangles(x, z, size, source.values, category), mode: `adaptive-${size}m`, measuredError: error }];
    const half = size / 2;
    return [
      ...refine(x, z, half), ...refine(x + half, z, half),
      ...refine(x, z + half, half), ...refine(x + half, z + half, half),
    ];
  };
  let patches = [];
  for (let z = 0; z < TILE_SIZE; z += 4) for (let x = 0; x < TILE_SIZE; x += 4) patches.push(...refine(x, z, 4));

  // Balance all touching quads, including unlike land/water categories, to a
  // bounded 2:1 ratio.  A remaining 2:1 edge is stitched explicitly below by
  // adding the midpoint to the coarse patch's transition fan.
  const split = (patch) => {
    assert(patch.size > 1, 'cannot split a 1m patch');
    const half = patch.size / 2;
    return [
      ...refine(patch.x, patch.z, half), ...refine(patch.x + half, patch.z, half),
      ...refine(patch.x, patch.z + half, half), ...refine(patch.x + half, patch.z + half, half),
    ];
  };
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const edges = new Map();
    const addEdge = (side, coordinate, patch, from, to) => {
      const key = `${side}:${coordinate}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ patch, from, to });
    };
    for (const patch of patches) {
      addEdge('vertical', patch.x, patch, patch.z, patch.z + patch.size);
      addEdge('vertical', patch.x + patch.size, patch, patch.z, patch.z + patch.size);
      addEdge('horizontal', patch.z, patch, patch.x, patch.x + patch.size);
      addEdge('horizontal', patch.z + patch.size, patch, patch.x, patch.x + patch.size);
    }
    const splitKeys = new Set();
    for (const entries of edges.values()) {
      for (let first = 0; first < entries.length; first += 1) for (let second = first + 1; second < entries.length; second += 1) {
        const a = entries[first]; const b = entries[second];
        if (a.patch === b.patch || a.patch.size === b.patch.size) continue;
        if (Math.min(a.to, b.to) - Math.max(a.from, b.from) <= EPS) continue;
        const larger = a.patch.size > b.patch.size ? a.patch : b.patch;
        const smaller = a.patch.size > b.patch.size ? b.patch : a.patch;
        if (larger.size > smaller.size * 2) splitKeys.add(`${larger.x},${larger.z},${larger.size}`);
      }
    }
    if (!splitKeys.size) break;
    patches = patches.flatMap((patch) => splitKeys.has(`${patch.x},${patch.z},${patch.size}`) ? split(patch) : [patch]);
    assert(iteration < 100, 'adaptive 2:1 edge balancing did not converge');
  }
  return { patches, unit };
}

function expandForcedHierarchy(keys) {
  const expanded = new Set(keys);
  for (const key of keys) {
    const [rawX, rawZ, rawSize] = key.split(',').map(Number);
    for (const size of [4, 2]) {
      if (size <= rawSize) continue;
      const x = Math.floor(rawX / size) * size;
      const z = Math.floor(rawZ / size) * size;
      expanded.add(`${x},${z},${size}`);
    }
  }
  return expanded;
}

function patchTransitionSides(patches) {
  const edges = new Map();
  const addEdge = (side, coordinate, patch, from, to) => {
    const key = `${side}:${coordinate}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push({ patch, from, to });
  };
  for (const patch of patches) {
    addEdge('vertical', patch.x, patch, patch.z, patch.z + patch.size);
    addEdge('vertical', patch.x + patch.size, patch, patch.z, patch.z + patch.size);
    addEdge('horizontal', patch.z, patch, patch.x, patch.x + patch.size);
    addEdge('horizontal', patch.z + patch.size, patch, patch.x, patch.x + patch.size);
  }
  const transition = new Map();
  const mark = (patch, side) => {
    if (!transition.has(patch)) transition.set(patch, new Set());
    transition.get(patch).add(side);
  };
  for (const [key, entries] of edges) {
    const [side] = key.split(':');
    for (let first = 0; first < entries.length; first += 1) for (let second = first + 1; second < entries.length; second += 1) {
      const a = entries[first]; const b = entries[second];
      if (a.patch === b.patch || a.patch.size === b.patch.size) continue;
      if (Math.min(a.to, b.to) - Math.max(a.from, b.from) <= EPS) continue;
      const larger = a.patch.size > b.patch.size ? a : b;
      const smaller = a.patch.size > b.patch.size ? b : a;
      assert.equal(larger.patch.size, smaller.patch.size * 2, `unbalanced adaptive edge ${key}`);
      const largerSide = side === 'vertical'
        ? (larger.patch.x === Number(key.split(':')[1]) ? 'west' : 'east')
        : (larger.patch.z === Number(key.split(':')[1]) ? 'south' : 'north');
      mark(larger.patch, largerSide);
    }
  }
  return transition;
}

function finalTrianglesFromPatches(patches, sourceValues = null) {
  const transitions = patchTransitionSides(patches);
  const output = [];
  for (const patch of patches) {
    if (patch.size === 1 || patch.mode === 'source-1m') {
      output.push(...patch.triangles.map((triangle) => ({ ...triangle, patch })));
      continue;
    }
    const sides = transitions.get(patch) ?? new Set();
    const x0 = patch.x; const x1 = patch.x + patch.size; const z0 = patch.z; const z1 = patch.z + patch.size;
    const heightAtPatch = (x, z) => pointInTriangle(patch.triangles[0].vertices, x, z)
      ? triangleHeight(patch.triangles[0].vertices, x, z)
      : triangleHeight(patch.triangles[1].vertices, x, z);
    const corner = (x, z) => [x, heightAtPatch(x, z), z];
    const sourceHeight = (x, z) => {
      const value = sourceValues?.get(key2(x, z));
      assert(Number.isFinite(value), `missing transition source height ${x},${z}`);
      return [x, value, z];
    };
    const ring = [corner(x0, z0)];
    if (sides.has('south')) ring.push(sourceHeight((x0 + x1) / 2, z0));
    ring.push(corner(x1, z0));
    if (sides.has('east')) ring.push(sourceHeight(x1, (z0 + z1) / 2));
    ring.push(corner(x1, z1));
    if (sides.has('north')) ring.push(sourceHeight((x0 + x1) / 2, z1));
    ring.push(corner(x0, z1));
    if (sides.has('west')) ring.push(sourceHeight(x0, (z0 + z1) / 2));
    const center = corner((x0 + x1) / 2, (z0 + z1) / 2);
    for (let index = 0; index < ring.length; index += 1) output.push({ category: patch.category, vertices: [center, ring[index], ring[(index + 1) % ring.length],], patch });
  }
  return output;
}

function validateAdaptiveTopology(patches, finalTriangles) {
  const transitions = patchTransitionSides(patches);
  const byPatch = new Map();
  for (const triangle of finalTriangles) {
    if (!byPatch.has(triangle.patch)) byPatch.set(triangle.patch, []);
    byPatch.get(triangle.patch).push(triangle);
  }
  const edgeVertices = (patch, side) => {
    const points = new Map();
    const coordinate = side === 'west' ? patch.x : side === 'east' ? patch.x + patch.size : side === 'south' ? patch.z : patch.z + patch.size;
    for (const triangle of byPatch.get(patch) ?? []) for (const [x, y, z] of triangle.vertices) {
      const onEdge = side === 'west' || side === 'east' ? Math.abs(x - coordinate) <= 1e-6 : Math.abs(z - coordinate) <= 1e-6;
      if (!onEdge) continue;
      points.set(side === 'west' || side === 'east' ? z : x, y);
    }
    return points;
  };
  const edges = new Map();
  const addEdge = (orientation, coordinate, patch, from, to, side) => {
    const key = `${orientation}:${coordinate}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push({ patch, from, to, side });
  };
  for (const patch of patches) {
    addEdge('vertical', patch.x, patch, patch.z, patch.z + patch.size, 'west');
    addEdge('vertical', patch.x + patch.size, patch, patch.z, patch.z + patch.size, 'east');
    addEdge('horizontal', patch.z, patch, patch.x, patch.x + patch.size, 'south');
    addEdge('horizontal', patch.z + patch.size, patch, patch.x, patch.x + patch.size, 'north');
  }
  let transitionEdges = 0;
  let pairChecks = 0;
  for (const entries of edges.values()) for (let first = 0; first < entries.length; first += 1) for (let second = first + 1; second < entries.length; second += 1) {
    const a = entries[first]; const b = entries[second];
    if (a.patch === b.patch || Math.min(a.to, b.to) - Math.max(a.from, b.from) <= EPS) continue;
    pairChecks += 1;
    if (a.patch.size === b.patch.size) continue;
    const larger = a.patch.size > b.patch.size ? a : b;
    const smaller = a.patch.size > b.patch.size ? b : a;
    assert.equal(larger.patch.size, smaller.patch.size * 2, `adaptive edge ratio exceeds 2:1 at ${a.patch.x},${a.patch.z}`);
    assert(transitions.get(larger.patch)?.has(larger.side), `missing transition mark at ${larger.patch.x},${larger.patch.z},${larger.side}`);
    transitionEdges += 1;
    const midpoint = (larger.from + larger.to) / 2;
    const coarse = edgeVertices(larger.patch, larger.side);
    const fine = edgeVertices(smaller.patch, smaller.side);
    assert(coarse.has(midpoint), `coarse transition midpoint missing at ${larger.patch.x},${larger.patch.z},${larger.side}`);
    assert(fine.has(midpoint), `fine transition endpoint missing at ${smaller.patch.x},${smaller.patch.z},${smaller.side}`);
    assert(Math.abs(coarse.get(midpoint) - fine.get(midpoint)) <= 1e-6, `transition height mismatch at ${midpoint}`);
  }
  return { balancedTwoToOne: true, transitionEdges, pairChecks, noTJunctions: true };
}

function spatialIndex(triangles) {
  const index = new Map();
  for (const [id, triangle] of triangles.entries()) for (const cell of triangleCells(triangle)) {
    if (!index.has(cell)) index.set(cell, []);
    index.get(cell).push(id);
  }
  return index;
}

function candidatesAt(index, triangles, x, z) {
  const cells = new Set();
  const ix = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(Math.min(TILE_SIZE - 1e-7, Math.max(0, x)))));
  const iz = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(Math.min(TILE_SIZE - 1e-7, Math.max(0, z)))));
  for (const dx of [0, -1]) for (const dz of [0, -1]) {
    const key = key2(ix + dx, iz + dz);
    for (const id of index.get(key) ?? []) cells.add(id);
  }
  return [...cells].map((id) => triangles[id]).filter((triangle) => pointInTriangle(triangle.vertices, x, z));
}

function sourceSampleValidation(source, finalTriangles, budget = 0.25) {
  const index = spatialIndex(finalTriangles);
  let max = 0;
  let maxUnambiguous = 0;
  let measured = 0;
  let surfaceAmbiguities = 0;
  const violatingPatchKeys = new Set();
  const violatingSamples = [];
  const record = (x, z, sourceHeight, candidates, heights, ambiguous) => {
    const localMax = Math.max(...heights.map((height) => Math.abs(height - sourceHeight)));
    max = Math.max(max, localMax);
    if (!ambiguous) maxUnambiguous = Math.max(maxUnambiguous, localMax);
    if (!ambiguous && localMax > budget + 1e-9) {
      const patches = new Set(candidates.map((candidate) => candidate.patch).filter((patch) => patch?.size > 1));
      for (const patch of patches) violatingPatchKeys.add(`${patch.x},${patch.z},${patch.size}`);
      violatingSamples.push({ x, z, error: localMax, patchCount: patches.size });
    }
    measured += 1;
  };
  const check = (x, z, sourceHeight) => {
    const candidates = candidatesAt(index, finalTriangles, x, z);
    if (!candidates.length) { surfaceAmbiguities += 1; return; }
    const heights = candidates.map((triangle) => triangleHeight(triangle.vertices, x, z));
    const ambiguous = Math.max(...heights) - Math.min(...heights) > 1e-5;
    if (ambiguous) surfaceAmbiguities += 1;
    record(x, z, sourceHeight, candidates, heights, ambiguous);
  };
  for (let z = 0; z <= TILE_SIZE; z += 1) for (let x = 0; x <= TILE_SIZE; x += 1) check(x, z, source.values.get(key2(x, z)));
  for (const vertex of source.vertices.values()) {
    const candidates = candidatesAt(index, finalTriangles, vertex.x, vertex.z).filter((triangle) => vertex.categories.has(triangle.category));
    if (!candidates.length) { surfaceAmbiguities += 1; continue; }
    const heights = candidates.map((triangle) => triangleHeight(triangle.vertices, vertex.x, vertex.z));
    const ambiguous = Math.max(...heights) - Math.min(...heights) > 1e-5;
    if (ambiguous) surfaceAmbiguities += 1;
    record(vertex.x, vertex.z, vertex.y, candidates, heights, ambiguous);
  }
  return { maxVerticalDeviationMetres: max, maxUnambiguousVerticalDeviationMetres: maxUnambiguous, measuredSourceSurfaceVertices: measured, surfaceAmbiguities, violatingPatchKeys: [...violatingPatchKeys].sort(), violatingSamples: violatingSamples.slice(0, 32) };
}

function signedArea(poly) {
  let area = 0;
  for (let index = 0; index < poly.length; index += 1) {
    const a = poly[index]; const b = poly[(index + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function clipPolygon(subject, clip) {
  let output = subject.slice();
  const orientation = signedArea(clip) >= 0 ? 1 : -1;
  const inside = (point, a, b) => orientation * ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])) >= -1e-9;
  const intersection = (p, q, a, b) => {
    const rx = q[0] - p[0]; const ry = q[1] - p[1];
    const sx = b[0] - a[0]; const sy = b[1] - a[1];
    const denominator = rx * sy - ry * sx;
    if (Math.abs(denominator) <= EPS) return q;
    const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / denominator;
    return [p[0] + t * rx, p[1] + t * ry];
  };
  for (let index = 0; index < clip.length && output.length; index += 1) {
    const a = clip[index]; const b = clip[(index + 1) % clip.length];
    const input = output; output = [];
    for (let point = 0; point < input.length; point += 1) {
      const current = input[point]; const previous = input[(point + input.length - 1) % input.length];
      const currentInside = inside(current, a, b); const previousInside = inside(previous, a, b);
      if (currentInside !== previousInside) output.push(intersection(previous, current, a, b));
      if (currentInside) output.push(current);
    }
  }
  return output;
}

function continuousOverlay(source, finalTriangles) {
  const index = spatialIndex(finalTriangles);
  let max = 0;
  let sourceArea = 0;
  let coveredArea = 0;
  let intersections = 0;
  for (const sourceTriangle of source.triangles) {
    const sourcePoly = sourceTriangle.vertices.map(([x, , z]) => [x, z]);
    const area = Math.abs(signedArea(sourcePoly));
    if (area <= EPS) continue;
    sourceArea += area;
    const ids = new Set();
    for (const cell of triangleCells(sourceTriangle)) for (const id of index.get(cell) ?? []) ids.add(id);
    let triangleCovered = 0;
    for (const id of ids) {
      const adaptive = finalTriangles[id];
      if (adaptive.category !== sourceTriangle.category) continue;
      const adaptivePoly = adaptive.vertices.map(([x, , z]) => [x, z]);
      const intersection = clipPolygon(sourcePoly, adaptivePoly);
      if (intersection.length < 3) continue;
      const intersectionArea = Math.abs(signedArea(intersection));
      if (intersectionArea <= 1e-10) continue;
      triangleCovered += intersectionArea;
      coveredArea += intersectionArea;
      intersections += 1;
      for (const [x, z] of intersection) {
        const sourceHeight = triangleHeight(sourceTriangle.vertices, x, z);
        const adaptiveHeight = triangleHeight(adaptive.vertices, x, z);
        max = Math.max(max, Math.abs(sourceHeight - adaptiveHeight));
      }
    }
    if (Math.abs(triangleCovered - area) > 1e-5) {
      return { proven: false, reason: `source triangle coverage gap ${area - triangleCovered}m²`, maxVerticalDeviationMetres: null, intersections, sourceArea, coveredArea };
    }
  }
  return { proven: true, reason: 'all source LOD0 triangle intersections and edge vertices evaluated', maxVerticalDeviationMetres: max, intersections, sourceArea, coveredArea };
}

function align4(length) { return (length + 3) & ~3; }

function makeAdaptiveGlb(sourceGlbBytes, tileId, patches, finalTriangles) {
  const { gltf: sourceGltf, bin: sourceBin } = parseGlb(sourceGlbBytes);
  const sourcePrimitives = sourceGltf.meshes[0].primitives.map((primitive) => readPrimitive(sourceGltf, sourceBin, primitive));
  const byCategory = new Map();
  for (const triangle of finalTriangles) {
    if (!byCategory.has(triangle.category)) byCategory.set(triangle.category, []);
    byCategory.get(triangle.category).push(triangle);
  }
  const outputGeometry = [];
  const categorySeen = new Set();
  for (const sourcePrimitive of sourcePrimitives) {
    const category = sourcePrimitive.category;
    if (!['terrain', 'water'].includes(category)) {
      outputGeometry.push({
        category,
        material: sourcePrimitive.primitive.material,
        extras: sourcePrimitive.primitive.extras,
        positions: sourcePrimitive.positions.flat(),
        indices: sourcePrimitive.indices,
        rawSource: sourcePrimitive,
      });
      continue;
    }
    if (categorySeen.has(category)) continue;
    categorySeen.add(category);
    const triangles = byCategory.get(category) ?? [];
    let positions = [];
    let indices = [];
    const chunks = [];
    const sourceMaterial = sourcePrimitive.primitive.material;
    const sourceExtras = sourcePrimitive.primitive.extras ?? { category, sourceOsmWayIds: [] };
    const flush = () => {
      if (!indices.length) return;
      chunks.push({ category, material: sourceMaterial, extras: sourceExtras, positions, indices });
      positions = []; indices = [];
    };
    const vertexMap = new Map();
    for (const triangle of triangles) {
      const local = [];
      for (const vertex of triangle.vertices) {
        const key = key3(...vertex);
        let index = vertexMap.get(key);
        if (index === undefined) {
          if (positions.length / 3 >= 65535) { flush(); vertexMap.clear(); }
          index = positions.length / 3;
          vertexMap.set(key, index);
          positions.push(...vertex);
        }
        local.push(index);
      }
      indices.push(...local);
    }
    flush();
    outputGeometry.push(...chunks);
  }
  const categoryOrder = ['terrain', 'water', 'coastline', 'roads', 'buildings'];
  outputGeometry.sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category));
  const outputGltf = structuredClone(sourceGltf);
  outputGltf.asset.generator = 'build-sf-lod1-adaptive-proof-v1';
  outputGltf.nodes[0].name = `${tileId}-lod1-adaptive`;
  outputGltf.meshes[0].name = `${tileId}-lod1-adaptive`;
  outputGltf.meshes[0].primitives = [];
  outputGltf.accessors = [];
  outputGltf.bufferViews = [];
  const binaryParts = [];
  let binaryLength = 0;
  const append = (bytes) => {
    const aligned = align4(binaryLength);
    if (aligned > binaryLength) { binaryParts.push(Buffer.alloc(aligned - binaryLength)); binaryLength = aligned; }
    const offset = binaryLength; binaryParts.push(bytes); binaryLength += bytes.length; return offset;
  };
  const appendGeometry = (geometry, chunkIndex, chunkCount) => {
    const positionBytes = Buffer.alloc(geometry.positions.length * 4);
    for (let index = 0; index < geometry.positions.length; index += 1) positionBytes.writeFloatLE(geometry.positions[index], index * 4);
    const indexBytes = Buffer.alloc(geometry.indices.length * 2);
    for (let index = 0; index < geometry.indices.length; index += 1) indexBytes.writeUInt16LE(geometry.indices[index], index * 2);
    const positionOffset = append(positionBytes); const indexOffset = append(indexBytes);
    const positionView = outputGltf.bufferViews.length; outputGltf.bufferViews.push({ buffer: 0, byteOffset: positionOffset, byteLength: positionBytes.length, target: 34962 });
    const indexView = outputGltf.bufferViews.length; outputGltf.bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: indexBytes.length, target: 34963 });
    const minimum = [Infinity, Infinity, Infinity]; const maximum = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < geometry.positions.length; index += 3) for (let axis = 0; axis < 3; axis += 1) { minimum[axis] = Math.min(minimum[axis], geometry.positions[index + axis]); maximum[axis] = Math.max(maximum[axis], geometry.positions[index + axis]); }
    let maximumIndex = 0; for (const index of geometry.indices) maximumIndex = Math.max(maximumIndex, index);
    const positionAccessor = outputGltf.accessors.length; outputGltf.accessors.push({ bufferView: positionView, componentType: 5126, count: geometry.positions.length / 3, type: 'VEC3', min: minimum, max: maximum });
    const indexAccessor = outputGltf.accessors.length; outputGltf.accessors.push({ bufferView: indexView, componentType: 5123, count: geometry.indices.length, type: 'SCALAR', min: [0], max: [maximumIndex] });
    const extras = structuredClone(geometry.extras ?? { category: geometry.category, sourceOsmWayIds: [] });
    extras.category = geometry.category; extras.chunkIndex = chunkIndex; extras.chunkCount = chunkCount;
    outputGltf.meshes[0].primitives.push({ attributes: { POSITION: positionAccessor }, indices: indexAccessor, material: geometry.material, mode: 4, extras });
  };
  for (const category of categoryOrder) {
    const geometries = outputGeometry.filter((geometry) => geometry.category === category);
    geometries.forEach((geometry, index) => appendGeometry(geometry, index, geometries.length));
  }
  outputGltf.buffers = [{ byteLength: align4(binaryLength) }];
  outputGltf.extras = {
    ...sourceGltf.extras,
    tileId,
    lod: 1,
    lodPolicy: 'adaptive-4m-2m-1m-proof-v1',
    adaptiveStepsMetres: [...STEPS],
    sourceLod0ArtifactHash: digest(sourceGlbBytes),
    unitsPerMetre: 1,
  };
  const json = Buffer.from(JSON.stringify(outputGltf));
  const jsonPadded = Buffer.concat([json, Buffer.alloc(align4(json.length) - json.length, 0x20)]);
  const binary = Buffer.concat(binaryParts);
  const totalLength = 12 + 8 + jsonPadded.length + 8 + align4(binary.length);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonPadded.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binPadded = Buffer.concat([binary, Buffer.alloc(align4(binary.length) - binary.length)]);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binPadded.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]);
}

function edgeSamples(finalTriangles, side) {
  const index = spatialIndex(finalTriangles);
  const points = new Map();
  for (let coordinate = 0; coordinate <= TILE_SIZE; coordinate += 1) {
    const x = side === 'east' ? TILE_SIZE : side === 'west' ? 0 : coordinate;
    const z = side === 'north' ? TILE_SIZE : side === 'south' ? 0 : coordinate;
    const candidates = candidatesAt(index, finalTriangles, x, z);
    assert(candidates.length, `adaptive ${side} edge has no triangle at ${coordinate}`);
    const height = triangleHeight(candidates[0].vertices, x, z);
    for (const candidate of candidates) assert(Math.abs(triangleHeight(candidate.vertices, x, z) - height) <= 1e-5, `edge surface disagreement ${side}:${coordinate}`);
    points.set(coordinate, height);
  }
  assert.equal(points.size, TILE_SIZE + 1, `adaptive ${side} edge misses integer source samples`);
  return points;
}

function seamEvidence(built) {
  const pairs = [
    [built[0], 'north', built[1], 'south'],
    [built[1], 'east', built[2], 'west'],
    [built[1], 'north', built[3], 'south'],
  ];
  return pairs.map(([a, aSide, b, bSide]) => {
    const aEdge = edgeSamples(a.finalTriangles, aSide); const bEdge = edgeSamples(b.finalTriangles, bSide);
    let max = 0;
    for (const [coordinate, height] of aEdge) { assert(bEdge.has(coordinate), `seam misses ${coordinate}`); max = Math.max(max, Math.abs(height - bEdge.get(coordinate))); }
    assert.equal(max, 0, `adaptive seam mismatch ${a.id}/${b.id}`);
    return { tiles: [a.id, b.id], sides: [aSide, bSide], samples: aEdge.size, maxVerticalDifferenceMetres: max };
  });
}

async function buildTile(source, sharedInputs, terrainDigests, budgets) {
  const options = { tile: { gridEasting: source.gridEasting, gridNorthing: source.gridNorthing }, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, terrainGridStepMetres: 1, lodLevel: 0 };
  const first = await buildSfMetricTile(options);
  const second = await buildSfMetricTile(options);
  assert.equal(digest(first.glbs[0].bytes), digest(second.glbs[0].bytes), `LOD0 rebuild drifted for ${source.id}`);
  assert.equal(digest(first.glbs[0].bytes), digest(source.glb), `source LOD0 bytes changed under proof rebuild for ${source.id}`);
  for (const category of ['coastline', 'roads', 'buildings']) assert.equal(digest(semanticPayload(first.glbs[0].bytes, category)), digest(semanticPayload(source.glb, category)), `${source.id} ${category} payload changed`);
  const sourceTileData = sourceTile(source.glb);
  let forcedKeys = new Set(); let refinementIterations = 0; let patches; let unit; let finalTriangles; let topology; let sampled; let refinementConverged = false; let refinementStopReason = 'iteration-limit';
  for (let iteration = 0; iteration < 8; iteration += 1) {
    ({ patches, unit } = makeAdaptivePatches(sourceTileData, forcedKeys));
    finalTriangles = finalTrianglesFromPatches(patches, sourceTileData.values);
    topology = validateAdaptiveTopology(patches, finalTriangles);
    sampled = sourceSampleValidation(sourceTileData, finalTriangles, budgets.maxVerticalDeviationMetres);
    if (sampled.maxUnambiguousVerticalDeviationMetres <= budgets.maxVerticalDeviationMetres + 1e-9) { refinementConverged = true; refinementStopReason = sampled.surfaceAmbiguities ? 'adaptive-budget-passed-source-surface-ambiguous' : 'sample-budget-passed'; break; }
    const nextForced = expandForcedHierarchy(sampled.violatingPatchKeys.filter((key) => !key.endsWith(',1')));
    const newKeys = [...nextForced].filter((key) => !forcedKeys.has(key));
    if (!newKeys.length) { refinementConverged = true; refinementStopReason = sampled.violatingSamples.length ? 'only-1m-or-source-boundary-violations-remain' : 'no-violating-patches'; break; }
    forcedKeys = new Set([...forcedKeys, ...nextForced]); refinementIterations += 1;
  }
  assert(refinementIterations <= 8, 'adaptive post-stitch refinement iteration count drifted');
  const sampledExceedsBudget = sampled.maxUnambiguousVerticalDeviationMetres > budgets.maxVerticalDeviationMetres;
  const continuous = sampled.surfaceAmbiguities ? { proven: false, reason: 'not-run; source terrain/water boundary has ambiguous overlapping source heights', maxVerticalDeviationMetres: null, intersections: 0, sourceArea: null, coveredArea: null } : sampledExceedsBudget ? { proven: false, reason: 'not-run; sampled adaptive lower bound already exceeds the vertical contract budget and is sufficient to reject', maxVerticalDeviationMetres: null, intersections: 0, sourceArea: null, coveredArea: null } : continuousOverlay(sourceTileData, finalTriangles);
  const output = makeAdaptiveGlb(source.glb, source.id, patches, finalTriangles);
  const outputAgain = makeAdaptiveGlb(source.glb, source.id, patches, finalTriangles);
  assert.equal(digest(output), digest(outputAgain), `${source.id} adaptive serialization drifted`);
  for (const category of ['coastline', 'roads', 'buildings']) assert.equal(digest(semanticPayload(output, category)), digest(semanticPayload(source.glb, category)), `${source.id} ${category} payload changed in adaptive artifact`);
  const levels = Object.fromEntries(STEPS.map((step) => [step, { patches: patches.filter((patch) => patch.size === step).length, triangles: finalTriangles.filter((triangle) => triangle.patch.size === step).length }]));
  return { ...source, id: source.id, geometry: sourceTileData, unit, patches, finalTriangles, output, sampled, continuous, levels, topology, refinementIterations, refinementConverged, refinementStopReason };
}

export async function buildAdaptiveProof() {
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'));
  const budgets = contract.lod;
  assert.equal(budgets.maxHorizontalDeviationMetres, 0.5);
  assert.equal(budgets.maxVerticalDeviationMetres, 0.25);
  const production = await Promise.all(SAMPLE.map((grid) => readProduction(idFor(grid))));
  const preflight = new Map(production.flatMap(({ id, glb, receiptBytes, packageBytes }) => [[`${id}:lod0`, digest(glb)], [`${id}:receipt`, digest(receiptBytes)], [`${id}:package`, digest(packageBytes)]]));
  const sharedInputs = await loadSfMetricSharedInputs();
  const terrainDigests = await loadSfMetricVerifiedTerrainSourceDigests();
  const built = [];
  for (const [gridEasting, gridNorthing] of SAMPLE) {
    const id = idFor([gridEasting, gridNorthing]);
    const source = production.find((entry) => entry.id === id);
    built.push(await buildTile({ ...source, gridEasting, gridNorthing }, sharedInputs, terrainDigests, budgets));
  }
  const seams = seamEvidence(built);
  for (const entry of production) {
    const after = await readProduction(entry.id);
    assert.equal(preflight.get(`${entry.id}:lod0`), digest(after.glb), `production LOD0 mutated during adaptive proof: ${entry.id}`);
    assert.equal(preflight.get(`${entry.id}:receipt`), digest(after.receiptBytes), `production receipt mutated during adaptive proof: ${entry.id}`);
    assert.equal(preflight.get(`${entry.id}:package`), digest(after.packageBytes), `production package mutated during adaptive proof: ${entry.id}`);
  }
  const maxVerticalDeviationMetres = Math.max(...built.map(({ sampled: { maxVerticalDeviationMetres: max } }) => max));
  const maxUnambiguousVerticalDeviationMetres = Math.max(...built.map(({ sampled: { maxUnambiguousVerticalDeviationMetres: max } }) => max));
  const continuousMaxVerticalDeviationMetres = built.every(({ continuous }) => continuous.proven)
    ? Math.max(...built.map(({ continuous }) => continuous.maxVerticalDeviationMetres)) : null;
  const sampledExceedsBudget = maxUnambiguousVerticalDeviationMetres > budgets.maxVerticalDeviationMetres;
  const sampledAmbiguities = built.reduce((sum, { sampled }) => sum + sampled.surfaceAmbiguities, 0);
  const continuousProven = built.every(({ continuous }) => continuous.proven);
  const contractEligible = !sampledExceedsBudget && continuousProven && continuousMaxVerticalDeviationMetres <= budgets.maxVerticalDeviationMetres;
  const refinementConverged = built.every(({ refinementConverged: converged }) => converged);
  const status = contractEligible ? 'proof-passed-not-promoted' : !refinementConverged ? 'proof-rejected-refinement-not-converged' : sampledAmbiguities ? 'proof-rejected-source-surface-ambiguity' : sampledExceedsBudget ? 'proof-rejected-contract-error-budget' : !continuousProven ? 'proof-rejected-continuous-overlay-unproven' : 'proof-rejected-contract-error-budget';
  const totals = built.reduce((sum, entry) => ({ bytes: sum.bytes + entry.output.length, triangles: sum.triangles + entry.finalTriangles.length }), { bytes: 0, triangles: 0 });
  const proof = {
    schemaVersion: 1,
    kind: 'sf-lod1-adaptive-terrain-proof',
    id: 'sf-lod1-adaptive-proof-v1',
    status,
    nonPromotion: 'preview/proof only; not a production package, runtime asset, manifest entry, or streaming input',
    adaptivePolicy: 'deterministic 4m -> 2m -> 1m quads; tile perimeters and failed/coastline cells retain 1m source triangles; touching quads are balanced to 2:1 and coarse transition edges receive explicit source-height midpoint fans; post-stitch violations split their owning patches and repeat',
    coordinateFrame: { horizontalCrs: 'EPSG:26910', runtimeFrame: 'provisional-utm-source-declared-navd88-unrealized', unitsPerMetre: 1, scale: [1, 1, 1], translationMetres: [0, 0, 0], verticalStatus: 'provisional-source-declared-navd88-unrealized' },
    sample: { tiles: built.map(({ id }) => id), topology: 'connected Ferry three-tile L plus west/south neighbor; same four source-ready tiles as committed 4m/2m proofs' },
    sourceBinding: built.map(({ id, dir, stem, glb, receiptBytes, packageBytes, sourceLocks }) => ({ id, lod0: { path: relative(path.join(dir, `${stem}.lod0.glb`)), sha256: digest(glb) }, receipt: { path: relative(path.join(dir, `${stem}.receipt.json`)), sha256: digest(receiptBytes) }, mapPackage: { path: relative(path.join(dir, `${stem}.package.json`)), sha256: digest(packageBytes) }, sourceLocks })),
    validation: {
      method: 'all 385x385 integer LOD0 terrain/water source samples plus every unique fractional LOD0 terrain/water vertex compared with the final adaptive triangles; when sampled error is within budget, every positive-area LOD0/adaptive triangle intersection is clipped and its polygon vertices evaluated',
      postStitchRefinement: 'after transition fans are built, every measured source vertex above 0.25m maps to its owning >1m patch; those patches are deterministically split and rebalanced until the sampled budget passes or only 1m source triangles remain',
      postStitchRefinementConverged: built.every(({ refinementConverged }) => refinementConverged),
      maxHorizontalDeviationMetres: 0,
      maxVerticalDeviationMetres,
      maxAdaptiveVerticalDeviationMetresExcludingSourceAmbiguities: maxUnambiguousVerticalDeviationMetres,
      inheritedSourceSurfaceAmbiguityQualification: 'maxVerticalDeviationMetres includes overlapping LOD0 terrain/water candidates; adaptive contract comparison excludes those inherited ambiguities but any ambiguity still rejects promotion',
      continuousTriangleOverlayCheck: sampledAmbiguities ? 'not-run; source terrain/water boundary has ambiguous overlapping source heights' : sampledExceedsBudget ? 'not-run; sampled adaptive lower bound already exceeds the vertical contract budget and is sufficient to reject' : continuousProven ? 'all LOD0/adaptive triangle-edge intersections evaluated; piecewise-linear supremum is the maximum at clipped intersection polygon vertices' : 'not-proven; at least one LOD0 triangle did not obtain complete adaptive coverage',
      continuousMaxVerticalDeviationMetres,
      contractBudgets: { maxHorizontalDeviationMetres: budgets.maxHorizontalDeviationMetres, maxVerticalDeviationMetres: budgets.maxVerticalDeviationMetres },
      sampledExceedsBudget,
      sampledAmbiguities,
      refinementConverged,
      continuousProven,
      contractEligible,
      deterministicRebuild: true,
      noTJunctions: built.every(({ topology }) => topology.noTJunctions),
      adaptiveTopology: built.map(({ id, topology }) => ({ id, ...topology })),
      directedSurfacePartition: 'terrain/water category follows the serialized directed OSM coastline partition; coastline boundary cells retain source LOD0 triangles',
      phaseStableTileBoundaryHeights: true,
      seams,
      seamEvidenceQualification: 'all 385 integer edge samples on the three connected seams; tile perimeters retain 1m source triangles, so phase-stable source heights are checked exactly',
      nonTerrainGeometry: 'serialized position/index payload hashes for coastline, roads, and buildings match source LOD0; adaptive terrain/water payloads are the only replaced geometry',
    },
    tiles: built.map(({ id, output, sampled, continuous, levels, patches, finalTriangles, refinementIterations, refinementConverged, refinementStopReason }) => ({ id, artifact: { path: relative(path.join(OUTPUT_DIR, `${id}.lod1-adaptive.glb`)), sha256: digest(output), bytes: output.length }, cellsByStepMetres: levels, totalPatches: patches.length, triangles: finalTriangles.length, measuredSourceSurfaceVertices: sampled.measuredSourceSurfaceVertices, surfaceAmbiguities: sampled.surfaceAmbiguities, refinementIterations, refinementConverged, refinementStopReason, violatingSamples: sampled.violatingSamples, maxHorizontalDeviationMetres: 0, maxVerticalDeviationMetres: sampled.maxVerticalDeviationMetres, maxAdaptiveVerticalDeviationMetresExcludingSourceAmbiguities: sampled.maxUnambiguousVerticalDeviationMetres, continuousMaxVerticalDeviationMetres: continuous.maxVerticalDeviationMetres })),
    budgets: { measuredSample: totals, sampleAveragePerTile: { bytes: totals.bytes / built.length, triangles: totals.triangles / built.length }, projected598AtSampleAverage: { bytes: totals.bytes / built.length * 598, triangles: totals.triangles / built.length * 598 }, qualification: 'arithmetic projection from this four-tile proof sample only; not a citywide forecast or promotion claim' },
    runtimeManifestPath: relative(MANIFEST_PATH),
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([...built.map(({ id, output }) => writeFile(path.join(OUTPUT_DIR, `${id}.lod1-adaptive.glb`), output)), writeFile(path.join(OUTPUT_DIR, 'sf-lod1-adaptive-proof-v1.receipt.json'), jsonBytes(proof))]);
  return proof;
}

export { candidatesAt, continuousOverlay, finalTrianglesFromPatches, makeAdaptiveGlb, makeAdaptivePatches, patchTransitionSides, pointInTriangle, semanticPayload, sourceSampleValidation, sourceTile, spatialIndex, triangleHeight, validateAdaptiveTopology };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const proof = await buildAdaptiveProof();
  console.log(JSON.stringify({ result: proof.status, proof: relative(path.join(OUTPUT_DIR, 'sf-lod1-adaptive-proof-v1.receipt.json')), maxVerticalDeviationMetres: proof.validation.maxVerticalDeviationMetres, continuousMaxVerticalDeviationMetres: proof.validation.continuousMaxVerticalDeviationMetres, contractEligible: proof.validation.contractEligible, projected598AtSampleAverage: proof.budgets.projected598AtSampleAverage }, null, 2));
}
