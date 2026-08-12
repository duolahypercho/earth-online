/**
 * Fail-closed seam gate for adjacent 384 m EPSG:26910 production tiles.
 *
 * This script only inspects landed production artifacts plus an in-memory
 * rebuild. It does not write artifacts or promote vertical certification.
 *
 * Usage: node scripts/world-tiles/verify-sf-production-tile-seams-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSfMetricTile } from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FERRY_DIR = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const METRIC_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const MANIFEST_PATH = path.join(METRIC_ROOT, 'sf-metric-tiles-v1.manifest.json');
const WEST_ID = 'epsg26910-1440-10893';
const FERRY_ID = 'epsg26910-1441-10893';
const REQUIRED_PAIR = Object.freeze([WEST_ID, FERRY_ID]);
const TILE_SIZE = 384;
const TERRAIN_EDGE = TILE_SIZE + 1;
const PROVISIONAL_FRAME = 'provisional-utm-source-declared-navd88-unrealized';
const PROVISIONAL_STATUS = 'provisional-vertical-unrealized';
const PROVISIONAL_VERTICAL = 'source-declared-navd88-unrealized';
const VERTEX_AXES = Object.freeze({
  x: 'eastMinusOriginEasting',
  y: 'verticalMinusOriginVertical',
  z: 'northMinusOriginNorthing',
});
const ORIGIN_ORDER = Object.freeze(['easting', 'northing', 'vertical']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes) => `sha256:${sha256(bytes)}`;
const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const almost = (value, expected, epsilon = 5e-6) => Math.abs(value - expected) <= epsilon;

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

function readPositions(gltf, bin, primitive) {
  const accessor = gltf.accessors[primitive.attributes.POSITION];
  const view = gltf.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType, 5126, `${primitive.extras?.category ?? 'mesh'} positions must be float32`);
  assert.equal(accessor.type, 'VEC3', `${primitive.extras?.category ?? 'mesh'} positions must be VEC3`);
  const offset = view.byteOffset ?? 0;
  const positions = new Float32Array(accessor.count * 3);
  const heightBits = new Uint32Array(accessor.count);
  for (let index = 0; index < accessor.count; index += 1) {
    const at = offset + index * 12;
    positions[index * 3] = bin.readFloatLE(at);
    positions[index * 3 + 1] = bin.readFloatLE(at + 4);
    positions[index * 3 + 2] = bin.readFloatLE(at + 8);
    heightBits[index] = bin.readUInt32LE(at + 4);
  }
  return { positions, heightBits, count: accessor.count, min: accessor.min, max: accessor.max };
}

function inspectPrimitive(gltf, bin, primitive) {
  assert(primitive.extras?.category, 'GLB primitive is missing a category');
  const { positions, heightBits, count, min, max } = readPositions(gltf, bin, primitive);
  const indexAccessor = gltf.accessors[primitive.indices];
  const indexView = gltf.bufferViews[indexAccessor.bufferView];
  assert.equal(indexAccessor.componentType, 5125, `${primitive.extras.category} indices must be uint32`);
  assert.equal(indexAccessor.type, 'SCALAR', `${primitive.extras.category} indices must be SCALAR`);
  assert.equal(indexAccessor.count % 3, 0, `${primitive.extras.category} index count is not triangular`);
  const actualMin = [Infinity, Infinity, Infinity];
  const actualMax = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < count; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index * 3 + axis];
      actualMin[axis] = Math.min(actualMin[axis], value);
      actualMax[axis] = Math.max(actualMax[axis], value);
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    assert(almost(actualMin[axis], min[axis], 2e-5), `${primitive.extras.category} accessor min mismatch`);
    assert(almost(actualMax[axis], max[axis], 2e-5), `${primitive.extras.category} accessor max mismatch`);
  }
  for (let index = 0; index < indexAccessor.count; index += 1) {
    assert(bin.readUInt32LE((indexView.byteOffset ?? 0) + index * 4) < count, `${primitive.extras.category} index out of range`);
  }
  return {
    category: primitive.extras.category,
    positions,
    heightBits,
    vertices: count,
    indices: indexAccessor.count,
    triangles: indexAccessor.count / 3,
    sourceOsmWayIds: [...(primitive.extras.sourceOsmWayIds ?? [])],
    min,
    max,
  };
}

function tileIdentityFromGrid(gridEasting, gridNorthing) {
  assert(Number.isInteger(gridEasting) && Number.isInteger(gridNorthing), 'Tile grid indexes must be integers');
  return {
    id: `epsg26910-${gridEasting}-${gridNorthing}`,
    gridEasting,
    gridNorthing,
    origin: [gridEasting * TILE_SIZE, gridNorthing * TILE_SIZE, 0],
    bounds: [gridEasting * TILE_SIZE, gridNorthing * TILE_SIZE, (gridEasting + 1) * TILE_SIZE, (gridNorthing + 1) * TILE_SIZE],
  };
}

function forbidCertifiedVertical(label, value) {
  const text = JSON.stringify(value);
  assert(!text.includes('production-vertical-certified'), `${label} claims production-vertical-certified`);
  assert(!text.includes('"realized-navd88"'), `${label} claims realized NAVD88`);
  assert(!text.includes('production-utm-navd88'), `${label} claims the certified production runtime frame`);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function expectedStem(identity) {
  return identity === 'epsg26910-1441-10893' ? 'ferry-production-tile-v1' : identity;
}

function expectedDir(identity) {
  return identity === 'epsg26910-1441-10893' ? FERRY_DIR : path.join(METRIC_ROOT, identity);
}

async function loadTile(identity, manifestEntry) {
  const expected = tileIdentityFromGrid(...identity.split('-').slice(1).map(Number));
  assert.equal(expected.id, identity, `Malformed tile identity ${identity}`);
  const directory = expectedDir(identity);
  const stem = expectedStem(identity);
  const receiptPath = path.join(directory, `${stem}.receipt.json`);
  const packagePath = path.join(directory, `${stem}.package.json`);
  assert(await pathExists(receiptPath), `Missing receipt for ${identity}: ${relative(receiptPath)}`);
  assert(await pathExists(packagePath), `Missing package descriptor for ${identity}: ${relative(packagePath)}`);
  const [receiptBytes, packageBytes] = await Promise.all([readFile(receiptPath), readFile(packagePath)]);
  const receipt = JSON.parse(receiptBytes);
  const mapPackage = JSON.parse(packageBytes);
  assert.equal(receipt.status, PROVISIONAL_STATUS, `${identity} receipt is not honestly provisional`);
  assert.equal(mapPackage.status, PROVISIONAL_STATUS, `${identity} package is not honestly provisional`);
  assert.equal(mapPackage.verticalCertification, PROVISIONAL_VERTICAL, `${identity} package vertical certification drifted`);
  assert.equal(receipt.tile.identity, identity, `${identity} receipt identity drifted`);
  assert.deepEqual(receipt.tile.gridIndex, [expected.gridEasting, expected.gridNorthing], `${identity} grid index drifted`);
  assert.deepEqual(receipt.tile.boundsEpsg26910Metres, expected.bounds, `${identity} 384 m bounds drifted`);
  assert.deepEqual(receipt.tile.originEpsg26910VerticalMetres, expected.origin, `${identity} origin drifted`);
  assert.deepEqual(receipt.tile.originTupleOrder, ORIGIN_ORDER, `${identity} origin tuple order drifted`);
  assert.deepEqual(receipt.tile.vertexAxes, VERTEX_AXES, `${identity} vertex axes drifted`);
  assert.equal(receipt.tile.runtimeFrame, PROVISIONAL_FRAME, `${identity} receipt runtime frame drifted`);
  assert.equal(receipt.tile.scale, 1, `${identity} receipt scale drifted`);
  assert.deepEqual(mapPackage.tileOriginEpsg26910VerticalMetres, expected.origin, `${identity} package origin drifted`);
  assert.equal(mapPackage.coordinateReference?.horizontal?.crs, 'EPSG:26910', `${identity} horizontal CRS drifted`);
  assert.equal(mapPackage.coordinateReference?.horizontal?.unit, 'metre', `${identity} horizontal unit drifted`);
  assert.equal(mapPackage.coordinateReference?.vertical?.datum, PROVISIONAL_VERTICAL, `${identity} vertical datum drifted`);
  assert.equal(mapPackage.coordinateReference?.runtimeFrame, PROVISIONAL_FRAME, `${identity} package runtime frame drifted`);
  assert.deepEqual(mapPackage.scale, { runtimeUnitsPerMetre: 1, horizontalScale: 1, verticalScale: 1, verticalExaggeration: 0 }, `${identity} package scale drifted`);
  assert.equal(mapPackage.tiling?.tileSizeMetres, TILE_SIZE, `${identity} tile size drifted`);
  assert.deepEqual(receipt.lods.map(({ level }) => level), [0], `${identity} may only emit truthful LOD0`);
  assert.deepEqual(mapPackage.lods.map(({ level }) => level), [0], `${identity} package LOD range drifted`);
  forbidCertifiedVertical(`${identity} receipt`, receipt);
  forbidCertifiedVertical(`${identity} package`, mapPackage);

  const lod = receipt.lods[0];
  assert.deepEqual(lod.scale, [1, 1, 1], `${identity} LOD scale drifted`);
  assert.deepEqual(lod.translationMetres, [0, 0, 0], `${identity} LOD translation drifted`);
  assert.equal(lod.runtimeFrame, PROVISIONAL_FRAME, `${identity} LOD runtime frame drifted`);
  assert.equal(mapPackage.lods[0].artifactHash, lod.artifactHash, `${identity} package/receipt LOD hash mismatch`);
  const artifactPath = path.resolve(ROOT, lod.path);
  assert.equal(relative(artifactPath), lod.path, `${identity} LOD path escaped the repo`);
  const glbBytes = await readFile(artifactPath);
  assert.equal(glbBytes.length, lod.bytes, `${identity} LOD byte count mismatch`);
  assert.equal(digest(glbBytes), lod.artifactHash, `${identity} LOD disk hash mismatch`);
  if (manifestEntry) {
    assert.equal(manifestEntry.id, identity, `${identity} manifest id drifted`);
    assert.deepEqual(manifestEntry.gridIndex, [expected.gridEasting, expected.gridNorthing], `${identity} manifest grid drifted`);
    assert.deepEqual(manifestEntry.originEpsg26910VerticalMetres, expected.origin, `${identity} manifest origin drifted`);
    assert.equal(manifestEntry.lod0.path, lod.path, `${identity} manifest LOD path drifted`);
    assert.equal(manifestEntry.lod0.sha256, lod.artifactHash, `${identity} manifest LOD hash drifted`);
    assert.equal(manifestEntry.receipt.path, relative(receiptPath), `${identity} manifest receipt path drifted`);
    assert.equal(manifestEntry.receipt.sha256, digest(receiptBytes), `${identity} manifest receipt hash drifted`);
  }

  const { gltf, bin } = parseGlb(glbBytes);
  assert.equal(gltf.extras.tileId, identity, `${identity} GLB tileId drifted`);
  assert.equal(gltf.extras.lod, 0, `${identity} GLB LOD drifted`);
  assert.equal(gltf.extras.horizontalCrs, 'EPSG:26910', `${identity} GLB CRS drifted`);
  assert.equal(gltf.extras.runtimeFrame, PROVISIONAL_FRAME, `${identity} GLB runtime frame drifted`);
  assert.equal(gltf.extras.verticalCertification, PROVISIONAL_VERTICAL, `${identity} GLB vertical certification drifted`);
  assert.deepEqual(gltf.extras.tileOriginEpsg26910VerticalMetres, expected.origin, `${identity} GLB origin drifted`);
  assert.deepEqual(gltf.extras.originTupleOrder, ORIGIN_ORDER, `${identity} GLB origin tuple drifted`);
  assert.deepEqual(gltf.extras.vertexAxes, VERTEX_AXES, `${identity} GLB vertex axes drifted`);
  assert.equal(gltf.extras.unitsPerMetre, 1, `${identity} GLB metre scale drifted`);
  assert.equal(gltf.nodes?.[0]?.translation, undefined, `${identity} GLB node translation is not allowed`);
  assert.equal(gltf.nodes?.[0]?.scale, undefined, `${identity} GLB node scale is not allowed`);
  forbidCertifiedVertical(`${identity} GLB extras`, gltf.extras);

  const primitives = Object.fromEntries(gltf.meshes[0].primitives.map((primitive) => {
    const inspected = inspectPrimitive(gltf, bin, primitive);
    return [inspected.category, inspected];
  }));
  assert(primitives.terrain, `${identity} is missing a terrain primitive`);
  for (const category of Object.keys(primitives)) {
    const mesh = primitives[category];
    assert(mesh.min[0] >= 0 && mesh.min[2] >= 0 && mesh.max[0] <= TILE_SIZE && mesh.max[2] <= TILE_SIZE, `${identity} ${category} escapes the closed 384 m tile`);
    if (category === 'terrain' || category === 'water') {
      assert(mesh.min[0] >= 0 && mesh.min[2] >= 0 && mesh.max[0] <= TILE_SIZE && mesh.max[2] <= TILE_SIZE, `${identity} ${category} escapes the closed 384 m tile`);
    }
    const expectedStats = lod.meshStats?.[category];
    if (expectedStats) {
      assert.equal(mesh.vertices, expectedStats.vertices, `${identity} ${category} vertex count drifted`);
      assert.equal(mesh.indices, expectedStats.indices, `${identity} ${category} index count drifted`);
      assert.equal(mesh.triangles, expectedStats.triangles, `${identity} ${category} triangle count drifted`);
      assert.equal(mesh.sourceOsmWayIds.length, expectedStats.sourceOsmWayCount, `${identity} ${category} source way count drifted`);
    }
  }

  const sourceById = new Map(mapPackage.sourceFeatures.map((feature) => [feature.sourceFeatureId, feature]));
  assert.equal(sourceById.size, mapPackage.sourceFeatures.length, `${identity} package has duplicate sourceFeatureId values`);
  const emittedIds = new Set([
    ...primitives.roads?.sourceOsmWayIds ?? [],
    ...primitives.buildings?.sourceOsmWayIds ?? [],
    ...primitives.water?.sourceOsmWayIds ?? [],
    ...primitives.coastline?.sourceOsmWayIds ?? [],
  ].map((id) => `way/${id}`));
  for (const feature of mapPackage.sourceFeatures) {
    const [easting, northing, height] = feature.transformedPositionEpsg26910VerticalMetres;
    const [runtimeEast, runtimeUp, runtimeNorth] = feature.runtimePositionMetres;
    assert(almost(runtimeEast + expected.origin[0], easting, 1e-6), `${identity} ${feature.sourceFeatureId} runtime easting does not invert through the tile origin`);
    assert(almost(runtimeNorth + expected.origin[1], northing, 1e-6), `${identity} ${feature.sourceFeatureId} runtime northing does not invert through the tile origin`);
    assert(almost(runtimeUp + expected.origin[2], height, 1.5e-6), `${identity} ${feature.sourceFeatureId} runtime height does not invert through the tile origin`);
    assert(easting >= expected.bounds[0] - 1e-6 && easting <= expected.bounds[2] + 1e-6 && northing >= expected.bounds[1] - 1e-6 && northing <= expected.bounds[3] + 1e-6, `${identity} ${feature.sourceFeatureId} representative escaped the closed tile`);
    assert.equal(feature.verticalMode, 'terrain-sampled-source-declared-navd88-unrealized', `${identity} ${feature.sourceFeatureId} vertical mode is not provisional`);
    if (receipt.surfaceClassification) {
      assert.equal(receipt.surfaceClassification.terrainWaterOverlapAreaSquareMetres, 0, `${identity} receipt claims terrain/water overlap`);
      assert(Math.abs((receipt.surfaceClassification.landAreaSquareMetres + receipt.surfaceClassification.waterAreaSquareMetres) - TILE_SIZE ** 2) <= 0.001, `${identity} land+water do not partition 384²`);
    }
    assert(emittedIds.has(feature.sourceFeatureId), `${identity} package feature ${feature.sourceFeatureId} is missing from GLB extras`);
  }
  for (const sourceId of emittedIds) assert(sourceById.has(sourceId), `${identity} GLB source ${sourceId} is missing from the package`);

  return {
    identity,
    expected,
    receipt,
    mapPackage,
    primitives,
    sourceById,
    receiptDigest: digest(receiptBytes),
    packageDigest: digest(packageBytes),
    lodDigest: lod.artifactHash,
    manifestListed: Boolean(manifestEntry),
  };
}

function adjacentPairs(tiles) {
  const pairs = [];
  for (let left = 0; left < tiles.length; left += 1) {
    for (let right = left + 1; right < tiles.length; right += 1) {
      const a = tiles[left];
      const b = tiles[right];
      const dE = b.expected.gridEasting - a.expected.gridEasting;
      const dN = b.expected.gridNorthing - a.expected.gridNorthing;
      if (Math.abs(dE) + Math.abs(dN) !== 1) continue;
      pairs.push(dE === 1 || dN === 1 ? [a, b] : [b, a]);
    }
  }
  return pairs;
}

function surfaceEdgeSamples(tile, side) {
  const samples = new Map();
  for (const category of ['terrain', 'water']) {
    const mesh = tile.primitives[category];
    if (!mesh) continue;
    for (let index = 0; index < mesh.vertices; index += 1) {
      const localX = mesh.positions[index * 3];
      const localY = mesh.positions[index * 3 + 1];
      const localZ = mesh.positions[index * 3 + 2];
      const onEdge = side === 'west' ? almost(localX, 0)
        : side === 'east' ? almost(localX, TILE_SIZE)
          : side === 'south' ? almost(localZ, 0)
            : almost(localZ, TILE_SIZE);
      if (!onEdge) continue;
      const along = side === 'west' || side === 'east' ? localZ : localX;
      const key = along.toFixed(6);
      const sample = {
        category,
        along,
        worldE: localX + tile.expected.origin[0],
        worldH: localY + tile.expected.origin[2],
        worldN: localZ + tile.expected.origin[1],
        heightBits: mesh.heightBits[index],
      };
      const existing = samples.get(key);
      if (existing) {
        assert.equal(existing.heightBits, sample.heightBits, `${tile.identity} ${side} terrain/water heights disagree at ${key}`);
        assert.equal(existing.worldE, sample.worldE, `${tile.identity} ${side} terrain/water easting disagrees at ${key}`);
        assert.equal(existing.worldN, sample.worldN, `${tile.identity} ${side} terrain/water northing disagrees at ${key}`);
      } else samples.set(key, sample);
    }
  }
  return [...samples.values()].sort((a, b) => a.along - b.along);
}

function featureEdgeKeys(tile, category, axis, worldValue) {
  const mesh = tile.primitives[category];
  if (!mesh) return new Set();
  const keys = new Set();
  for (let index = 0; index < mesh.vertices; index += 1) {
    const worldE = mesh.positions[index * 3] + tile.expected.origin[0];
    const worldH = mesh.positions[index * 3 + 1] + tile.expected.origin[2];
    const worldN = mesh.positions[index * 3 + 2] + tile.expected.origin[1];
    const axisValue = axis === 'easting' ? worldE : worldN;
    if (!almost(axisValue, worldValue, 1e-4)) continue;
    keys.add(`${worldE.toFixed(6)}|${worldH.toFixed(6)}|${worldN.toFixed(6)}`);
  }
  return keys;
}

function countExclusiveInterior(tile, neighborBounds, category) {
  const mesh = tile.primitives[category];
  if (!mesh) return 0;
  let count = 0;
  const [minE, minN, maxE, maxN] = neighborBounds;
  for (let index = 0; index < mesh.vertices; index += 1) {
    const worldE = mesh.positions[index * 3] + tile.expected.origin[0];
    const worldN = mesh.positions[index * 3 + 2] + tile.expected.origin[1];
    if (worldE > minE && worldE < maxE && worldN > minN && worldN < maxN) count += 1;
  }
  return count;
}

function verifyPair(westOrSouth, eastOrNorth) {
  const eastingSeam = westOrSouth.expected.gridEasting + 1 === eastOrNorth.expected.gridEasting;
  const label = `${westOrSouth.identity}|${eastOrNorth.identity}`;
  const owner = [westOrSouth.identity, eastOrNorth.identity].sort()[0];
  const leftEdge = eastingSeam ? surfaceEdgeSamples(westOrSouth, 'east') : surfaceEdgeSamples(westOrSouth, 'north');
  const rightEdge = eastingSeam ? surfaceEdgeSamples(eastOrNorth, 'west') : surfaceEdgeSamples(eastOrNorth, 'south');
  assert.equal(leftEdge.length, TERRAIN_EDGE, `${label} left closed surface edge is incomplete`);
  assert.equal(rightEdge.length, TERRAIN_EDGE, `${label} right closed surface edge is incomplete`);
  let heightMismatches = 0;
  let positionMismatches = 0;
  for (let index = 0; index < TERRAIN_EDGE; index += 1) {
    const left = leftEdge[index];
    const right = rightEdge[index];
    if (left.worldE !== right.worldE || left.worldN !== right.worldN) positionMismatches += 1;
    if (left.heightBits !== right.heightBits || left.worldH !== right.worldH) heightMismatches += 1;
  }
  assert.equal(positionMismatches, 0, `${label} shared surface-edge positions do not agree after origin translation`);
  assert.equal(heightMismatches, 0, `${label} shared surface-edge heights are not byte/float identical`);

  const seamValue = eastingSeam ? eastOrNorth.expected.origin[0] : eastOrNorth.expected.origin[1];
  const axis = eastingSeam ? 'easting' : 'northing';
  const categories = [...new Set([...Object.keys(westOrSouth.primitives), ...Object.keys(eastOrNorth.primitives)])];
  const leaks = {};
  const buildingKeys = { left: null, right: null };
  for (const category of categories) {
    const leftLeak = countExclusiveInterior(westOrSouth, eastOrNorth.expected.bounds, category);
    const rightLeak = countExclusiveInterior(eastOrNorth, westOrSouth.expected.bounds, category);
    leaks[category] = { left: leftLeak, right: rightLeak };
    assert.equal(leftLeak, 0, `${label} ${category} from ${westOrSouth.identity} enters ${eastOrNorth.identity} exclusive interior`);
    assert.equal(rightLeak, 0, `${label} ${category} from ${eastOrNorth.identity} enters ${westOrSouth.identity} exclusive interior`);
    if (category === 'buildings') {
      const leftKeys = featureEdgeKeys(westOrSouth, category, axis, seamValue);
      const rightKeys = featureEdgeKeys(eastOrNorth, category, axis, seamValue);
      if (category === 'buildings') {
        buildingKeys.left = leftKeys.size;
        buildingKeys.right = rightKeys.size;
      }
      assert.deepEqual([...leftKeys].sort(), [...rightKeys].sort(), `${label} clipped building seam vertices are not identical`);
    }
  }

  const sharedIds = [...westOrSouth.sourceById.keys()].filter((id) => eastOrNorth.sourceById.has(id)).sort();
  for (const sourceFeatureId of sharedIds) {
    const left = westOrSouth.sourceById.get(sourceFeatureId);
    const right = eastOrNorth.sourceById.get(sourceFeatureId);
    assert.equal(left.sourceGeometryHash, right.sourceGeometryHash, `${label} ${sourceFeatureId} sourceGeometryHash drifted across the seam`);
    assert.equal(left.verticalMode, right.verticalMode, `${label} ${sourceFeatureId} vertical mode drifted across the seam`);
  }
  const collectWays = (tile) => new Set([
    ...(tile.primitives.roads?.sourceOsmWayIds ?? []),
    ...(tile.primitives.buildings?.sourceOsmWayIds ?? []),
    ...(tile.primitives.water?.sourceOsmWayIds ?? []),
    ...(tile.primitives.coastline?.sourceOsmWayIds ?? []),
  ].map((id) => `way/${id}`));
  const leftWays = collectWays(westOrSouth);
  const rightWays = collectWays(eastOrNorth);
  for (const sourceFeatureId of sharedIds) {
    assert(leftWays.has(sourceFeatureId), `${label} ${sourceFeatureId} is packaged on ${westOrSouth.identity} but missing from its GLB`);
    assert(rightWays.has(sourceFeatureId), `${label} ${sourceFeatureId} is packaged on ${eastOrNorth.identity} but missing from its GLB`);
  }

  return {
    id: label,
    owner,
    axis,
    seamValue,
    sharedSurfaceSamples: TERRAIN_EDGE,
    sharedSourceFeatures: sharedIds.length,
    terrainByteAgreement: true,
    interiorLeaks: leaks,
    buildingSeamVertices: buildingKeys,
  };
}

assert(await pathExists(MANIFEST_PATH), `Missing 2-tile seam manifest: ${relative(MANIFEST_PATH)}`);
const manifest = await readJson(MANIFEST_PATH);
assert.equal(manifest.kind, 'sf-metric-tile-set', 'Metric tile-set manifest kind drifted');
assert.equal(manifest.status, PROVISIONAL_STATUS, 'Metric tile-set manifest is not honestly provisional');
assert.equal(manifest.coordinateReference?.horizontal?.crs, 'EPSG:26910', 'Manifest horizontal CRS drifted');
assert.equal(manifest.coordinateReference?.runtimeFrame, PROVISIONAL_FRAME, 'Manifest runtime frame drifted');
assert.equal(manifest.tiling?.tileSizeMetres, TILE_SIZE, 'Manifest tile size drifted');
forbidCertifiedVertical('metric tile-set manifest', manifest);
assert(Array.isArray(manifest.tiles), 'Metric tile-set manifest is missing tiles');
const manifestIds = manifest.tiles.map((tile) => tile.id);
assert.deepEqual(manifestIds, REQUIRED_PAIR, `Seam manifest must be exactly west↔Ferry ${REQUIRED_PAIR.join(', ')}; stale north tile ${manifestIds.includes('epsg26910-1441-10894') ? 'is still listed' : 'set drifted'}`);
const manifestById = new Map(manifest.tiles.map((tile) => [tile.id, tile]));

const tiles = [];
for (const identity of REQUIRED_PAIR) tiles.push(await loadTile(identity, manifestById.get(identity)));
const pairs = adjacentPairs(tiles);
assert.equal(pairs.length, 1, `West↔Ferry must form exactly one 4-adjacent pair, got ${pairs.length}`);
assert.equal(pairs[0][0].identity, WEST_ID, 'West tile is not the western member of the seam pair');
assert.equal(pairs[0][1].identity, FERRY_ID, 'Ferry tile is not the eastern member of the seam pair');

const seamReports = pairs.map(([left, right]) => verifyPair(left, right));

const rebuilds = [];
for (const tile of tiles) {
  const rebuilt = await buildSfMetricTile({
    tile: { gridEasting: tile.expected.gridEasting, gridNorthing: tile.expected.gridNorthing },
    write: false,
  });
  assert.equal(digest(rebuilt.glbs[0].bytes), tile.lodDigest, `${tile.identity} deterministic rebuild hash drifted`);
  assert.equal(rebuilt.receipt.lods[0].artifactHash, tile.lodDigest, `${tile.identity} rebuilt receipt hash drifted`);
  assert.deepEqual(rebuilt.receipt.tile.originEpsg26910VerticalMetres, tile.expected.origin, `${tile.identity} rebuilt origin drifted`);
  assert.equal(rebuilt.receipt.status, PROVISIONAL_STATUS, `${tile.identity} rebuild must remain provisional`);
  assert.equal(rebuilt.packageDescriptor.status, PROVISIONAL_STATUS, `${tile.identity} rebuilt package must remain provisional`);
  rebuilds.push({ id: tile.identity, artifactHash: tile.lodDigest, deterministicRebuild: true });
}

process.stdout.write(`${JSON.stringify({
  result: 'SF production tile seams passed',
  status: PROVISIONAL_STATUS,
  verticalCertification: PROVISIONAL_VERTICAL,
  runtimeFrame: PROVISIONAL_FRAME,
  tiles: tiles.map((tile) => ({
    id: tile.identity,
    origin: tile.expected.origin,
    lod0: tile.lodDigest,
    receipt: tile.receiptDigest,
    manifestListed: tile.manifestListed,
    categories: Object.keys(tile.primitives).sort(),
  })),
  seams: seamReports,
  rebuilds,
  pair: REQUIRED_PAIR,
  ignored: 'epsg26910-1441-10894 is stale after the water freeze and is rejected if listed in the seam manifest',
  water: 'OSM-classified water is accepted only as a hydrologic partition; shared-edge heights must still match the neighboring surface exactly',
}, null, 2)}\n`);
