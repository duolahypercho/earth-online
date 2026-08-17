/**
 * Read-only feasibility proof for source-neutral Ferry OSM map contracts.
 *
 * This deliberately consumes the byte-validated shared OSM inputs used by the
 * metric-tile builder. It does not inspect a GLB, render mesh, terrain sample,
 * receipt, or runtime state, and it never writes an artifact.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadSfMetricSharedInputs } from '../world-tiles/build-ferry-production-tile-v1.mjs';

const TILE = Object.freeze({
  id: 'epsg26910-1441-10893',
  crs: 'EPSG:26910',
  bounds: Object.freeze([553344, 4182912, 553728, 4183296]),
});
const PEDESTRIAN_HIGHWAYS = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'corridor', 'platform']);
const ROUNDABOUT_JUNCTIONS = new Set(['roundabout', 'circular']);
const TRUE_VALUES = new Set(['yes', 'true', '1']);
const FALSE_VALUES = new Set(['no', 'false', '0']);
const EXPECTED = Object.freeze({
  osmPbf: Object.freeze({
    bytes: 32742133,
    sha256: 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae',
  }),
  horizontalTransformLockSha256: 'd5a86d211be380eec4bc03ff5e97dbef4dfaf2866578ab5330c90c7b586fcc21',
  horizontalGeometryAuthorizationSha256: '3277201281b83f794287ac8edd7e4b258b409aee09c914bbb47d6249f0302e2b',
  counts: Object.freeze({
    selectedHighwayWays: 221,
    vehicleWays: 46,
    pedestrianWays: 175,
    explicitCrossingWays: 35,
    pedestrianVehicleSourceNodeIntersections: 41,
    tileBoundaryPortals: 63,
    vehicleGraph: Object.freeze({
      nodes: 182,
      directedEdges: 260,
      connectedComponentsIgnoringDirection: Object.freeze({ count: 1, sizes: Object.freeze([182]) }),
    }),
    pedestrianGraph: Object.freeze({
      nodes: 442,
      sourceConnectivityEdges: 481,
      connectedComponents: Object.freeze({ count: 6, sizes: Object.freeze([3, 4, 6, 7, 11, 411]) }),
    }),
  }),
  unknownVehicleSemantics: Object.freeze({
    lanes: 13,
    maxspeed: 16,
    surface: 5,
    sidewalk: 6,
    directionSemantics: 0,
  }),
});

const q = (value) => Math.round(value * 1e6) / 1e6;
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const numeric = (a, b) => a - b;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sortedUnique = (values, compare = lexical) => [...new Set(values)].sort(compare);

function assertCoordinate([easting, northing], label) {
  assert(Number.isFinite(easting) && Number.isFinite(northing), `${label} has a non-finite coordinate`);
}

function inside([easting, northing]) {
  const [minE, minN, maxE, maxN] = TILE.bounds;
  return easting >= minE && easting <= maxE && northing >= minN && northing <= maxN;
}

function boundarySides([easting, northing]) {
  const [minE, minN, maxE, maxN] = TILE.bounds;
  const sides = [];
  if (easting === minE) sides.push('west');
  if (easting === maxE) sides.push('east');
  if (northing === minN) sides.push('south');
  if (northing === maxN) sides.push('north');
  return sides;
}

// Liang-Barsky clipping retains the exact source segment parameter interval.
function clipSegment(a, b) {
  assertCoordinate(a, 'Segment start');
  assertCoordinate(b, 'Segment end');
  const [minE, minN, maxE, maxN] = TILE.bounds;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const distances = [a[0] - minE, maxE - a[0], a[1] - minN, maxN - a[1]];
  let startT = 0;
  let endT = 1;
  for (let index = 0; index < p.length; index += 1) {
    if (p[index] === 0) {
      if (distances[index] < 0) return null;
      continue;
    }
    const t = distances[index] / p[index];
    if (p[index] < 0) startT = Math.max(startT, t);
    else endT = Math.min(endT, t);
    if (startT > endT) return null;
  }
  const point = (t) => [q(a[0] + dx * t), q(a[1] + dy * t)];
  const start = point(startT);
  const end = point(endT);
  assert(inside(start) && inside(end), 'Clipped segment endpoint escaped the exact tile bounds');
  return { startT: q(startT), endT: q(endT), start, end };
}

function verifyCardinalClipping() {
  assert.deepEqual(clipSegment([553300, 4183000], [553400, 4183000]), {
    startT: 0.44, endT: 1, start: [553344, 4183000], end: [553400, 4183000],
  }, 'West-entering segment clipping drifted');
  assert.deepEqual(clipSegment([553400, 4182800], [553400, 4183000]), {
    startT: 0.56, endT: 1, start: [553400, 4182912], end: [553400, 4183000],
  }, 'South-entering segment clipping drifted');
  assert.deepEqual(clipSegment([553700, 4183000], [553800, 4183000]), {
    startT: 0, endT: 0.28, start: [553700, 4183000], end: [553728, 4183000],
  }, 'East-exiting segment clipping drifted');
  assert.deepEqual(clipSegment([553400, 4183200], [553400, 4183400]), {
    startT: 0, endT: 0.48, start: [553400, 4183200], end: [553400, 4183296],
  }, 'North-exiting segment clipping drifted');
}

function endpointIdentity(way, segmentIndex, endpoint, t) {
  if (t === 0 && inside(way.en[segmentIndex])) return `node/${way.refs[segmentIndex]}`;
  if (t === 1 && inside(way.en[segmentIndex + 1])) return `node/${way.refs[segmentIndex + 1]}`;
  const sides = boundarySides(endpoint);
  assert(sides.length > 0, `Clipped way/${way.id} endpoint is neither a source node nor a tile-boundary portal`);
  return `portal/${endpoint[0]},${endpoint[1]}`;
}

function clippedSegments(way) {
  const result = [];
  for (let index = 0; index < way.en.length - 1; index += 1) {
    const clipped = clipSegment(way.en[index], way.en[index + 1]);
    if (!clipped || (clipped.start[0] === clipped.end[0] && clipped.start[1] === clipped.end[1])) continue;
    result.push({
      sourceSegmentIndex: index,
      sourceNodeRefs: [way.refs[index], way.refs[index + 1]],
      startT: clipped.startT,
      endT: clipped.endT,
      start: clipped.start,
      end: clipped.end,
      startId: endpointIdentity(way, index, clipped.start, clipped.startT),
      endId: endpointIdentity(way, index, clipped.end, clipped.endT),
    });
  }
  return result;
}

function directionSemantics(tags) {
  const raw = tags.oneway;
  if (raw !== undefined) {
    const value = String(raw).toLowerCase();
    if (TRUE_VALUES.has(value)) return { directions: ['forward'], basis: `explicit oneway=${raw}` };
    if (value === '-1' || value === 'reverse') return { directions: ['reverse'], basis: `explicit oneway=${raw}` };
    if (FALSE_VALUES.has(value)) return { directions: ['forward', 'reverse'], basis: `explicit oneway=${raw}` };
    return { directions: [], basis: `unsupported explicit oneway=${raw}`, unsupported: raw };
  }
  if (ROUNDABOUT_JUNCTIONS.has(tags.junction)) {
    return { directions: ['forward'], basis: `OSM-schema junction=${tags.junction} implies oneway=yes` };
  }
  if (tags.highway === 'motorway') {
    return { directions: ['forward'], basis: 'OSM-schema highway=motorway implies oneway=yes' };
  }
  return { directions: ['forward', 'reverse'], basis: 'OSM-schema absence of a one-way rule means bidirectional travel' };
}

function hasTagFamily(tags, family) {
  return Object.keys(tags).some((key) => key === family || key.startsWith(`${family}:`)
    || (family === 'lanes' && (key.endsWith(':lanes') || key.includes(':lanes:'))));
}

function addGraphNode(nodes, id, coordinate) {
  const normalized = coordinate.map(q);
  const existing = nodes.get(id);
  if (existing) assert.deepEqual(existing, normalized, `Graph node ${id} has conflicting source coordinates`);
  else nodes.set(id, normalized);
}

function addPortal(portals, graphNodeId, coordinate, wayId, mode) {
  const sides = boundarySides(coordinate);
  if (!sides.length) return;
  const id = `portal/${coordinate[0]},${coordinate[1]}`;
  const existing = portals.get(id) ?? { id, coordinate: coordinate.map(q), sides, graphNodeIds: [], sourceWayIds: [], modes: [] };
  existing.graphNodeIds.push(graphNodeId);
  existing.sourceWayIds.push(wayId);
  existing.modes.push(mode);
  portals.set(id, existing);
}

function graphComponents(nodes, edges) {
  const adjacency = new Map([...nodes].map(([id]) => [id, new Set()]));
  for (const edge of edges) {
    assert(adjacency.has(edge.from), `Edge ${edge.id} has a missing from endpoint`);
    assert(adjacency.has(edge.to), `Edge ${edge.id} has a missing to endpoint`);
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }
  let count = 0;
  const sizes = [];
  const visited = new Set();
  for (const nodeId of [...nodes.keys()].sort(lexical)) {
    if (visited.has(nodeId)) continue;
    count += 1;
    let size = 0;
    const queue = [nodeId];
    visited.add(nodeId);
    while (queue.length) {
      const current = queue.shift();
      size += 1;
      for (const neighbor of [...adjacency.get(current)].sort(lexical)) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    sizes.push(size);
  }
  return { count, sizes: sizes.sort(numeric) };
}

function serializableNodes(nodes) {
  return [...nodes].sort(([a], [b]) => lexical(a, b)).map(([id, coordinate]) => ({ id, coordinate }));
}

async function main() {
  verifyCardinalClipping();
  const shared = await loadSfMetricSharedInputs();
  const selected = shared.osmFeatureCache
    .filter((way) => Boolean(way.tags.highway))
    .map((way) => {
      assert(Number.isSafeInteger(way.id), 'OSM way id is not a safe integer');
      assert.equal(way.refs.length, way.en.length, `OSM way/${way.id} ref/coordinate count drifted`);
      assert(way.refs.length >= 2, `OSM way/${way.id} has fewer than two refs`);
      assert.equal(new Set(way.refs.map((ref, index) => {
        assert(Number.isSafeInteger(ref), `OSM way/${way.id} has an unsafe node ref`);
        assertCoordinate(way.en[index], `OSM way/${way.id} node/${ref}`);
        return `${index}:${ref}`;
      })).size, way.refs.length, `OSM way/${way.id} has duplicate ordered ref positions`);
      return { ...way, clipped: clippedSegments(way) };
    })
    .filter((way) => way.clipped.length > 0)
    .sort((a, b) => a.id - b.id);

  assert.equal(new Set(selected.map(({ id }) => id)).size, selected.length, 'Selected OSM way ids are not unique');
  const vehicleWays = selected.filter(({ tags }) => !PEDESTRIAN_HIGHWAYS.has(tags.highway));
  const pedestrianWays = selected.filter(({ tags }) => PEDESTRIAN_HIGHWAYS.has(tags.highway));
  const vehicleNodes = new Map();
  const pedestrianNodes = new Map();
  const portals = new Map();
  const vehicleEdges = [];
  const pedestrianEdges = [];
  const unsupportedDirectionWays = [];

  for (const way of vehicleWays) {
    const semantics = directionSemantics(way.tags);
    if (semantics.unsupported !== undefined) unsupportedDirectionWays.push(way.id);
    for (const segment of way.clipped) {
      addGraphNode(vehicleNodes, segment.startId, segment.start);
      addGraphNode(vehicleNodes, segment.endId, segment.end);
      addPortal(portals, segment.startId, segment.start, way.id, 'vehicle');
      addPortal(portals, segment.endId, segment.end, way.id, 'vehicle');
      for (const direction of semantics.directions) {
        const forward = direction === 'forward';
        vehicleEdges.push({
          id: `vehicle/way/${way.id}/segment/${segment.sourceSegmentIndex}/${direction}`,
          sourceWayId: way.id,
          sourceSegmentIndex: segment.sourceSegmentIndex,
          sourceNodeRefs: segment.sourceNodeRefs,
          from: forward ? segment.startId : segment.endId,
          to: forward ? segment.endId : segment.startId,
          direction,
          directionBasis: semantics.basis,
        });
      }
    }
  }

  for (const way of pedestrianWays) {
    for (const segment of way.clipped) {
      addGraphNode(pedestrianNodes, segment.startId, segment.start);
      addGraphNode(pedestrianNodes, segment.endId, segment.end);
      addPortal(portals, segment.startId, segment.start, way.id, 'pedestrian');
      addPortal(portals, segment.endId, segment.end, way.id, 'pedestrian');
      pedestrianEdges.push({
        id: `pedestrian/way/${way.id}/segment/${segment.sourceSegmentIndex}`,
        sourceWayId: way.id,
        sourceSegmentIndex: segment.sourceSegmentIndex,
        sourceNodeRefs: segment.sourceNodeRefs,
        from: segment.startId,
        to: segment.endId,
        movement: 'undirected source connectivity only',
      });
    }
  }

  assert.equal(new Set(vehicleEdges.map(({ id }) => id)).size, vehicleEdges.length, 'Vehicle edge ids are not unique');
  assert.equal(new Set(pedestrianEdges.map(({ id }) => id)).size, pedestrianEdges.length, 'Pedestrian edge ids are not unique');
  const vehicleNodeRefs = new Set([...vehicleNodes.keys()].filter((id) => id.startsWith('node/')));
  const pedestrianVehicleIntersections = [...pedestrianNodes.keys()]
    .filter((id) => id.startsWith('node/') && vehicleNodeRefs.has(id))
    .sort(lexical)
    .map((id) => ({ id, coordinate: pedestrianNodes.get(id) }));
  const explicitCrossingWays = pedestrianWays
    .filter(({ tags }) => tags.highway === 'crossing' || tags.footway === 'crossing' || tags.path === 'crossing' || tags.cycleway === 'crossing')
    .map(({ id }) => id);
  const unknown = {};
  for (const family of ['lanes', 'maxspeed', 'surface', 'sidewalk']) {
    const wayIds = vehicleWays.filter(({ tags }) => !hasTagFamily(tags, family)).map(({ id }) => id);
    unknown[family] = { count: wayIds.length, sourceWayIds: wayIds };
  }
  unknown.directionSemantics = { count: unsupportedDirectionWays.length, sourceWayIds: unsupportedDirectionWays };

  const portalRecords = [...portals.values()]
    .map((portal) => ({
      ...portal,
      graphNodeIds: sortedUnique(portal.graphNodeIds),
      sourceWayIds: sortedUnique(portal.sourceWayIds, numeric),
      modes: sortedUnique(portal.modes),
    }))
    .sort((a, b) => lexical(a.id, b.id));
  const pedestrianComponents = graphComponents(pedestrianNodes, pedestrianEdges);
  const vehicleComponents = graphComponents(vehicleNodes, vehicleEdges);
  const serializedWays = selected.map(({ id, tags, refs, en, clipped }) => ({
    id,
    classification: PEDESTRIAN_HIGHWAYS.has(tags.highway) ? 'pedestrian' : 'vehicle',
    tags: Object.fromEntries(Object.entries(tags).sort(([a], [b]) => lexical(a, b))),
    orderedNodeRefs: refs,
    sourceCoordinatesEpsg26910Metres: en.map(([easting, northing]) => [q(easting), q(northing)]),
    clippedSegments: clipped,
  }));

  const output = {
    schemaVersion: 1,
    kind: 'ferry-osm-contract-feasibility-proof',
    proofOnly: true,
    writesArtifacts: false,
    runtimePromotionReady: false,
    source: {
      loader: 'loadSfMetricSharedInputs',
      osmPbf: { bytes: shared.pbfHash.bytes, sha256: shared.pbfHash.sha256, byteIdentityValidated: true },
      horizontalTransformLockSha256: sha256(shared.horizontalLockBytes),
      horizontalGeometryAuthorizationSha256: sha256(shared.geometryAuthBytes),
      coordinateSource: 'ordered OSM node refs projected to EPSG:26910 by the shared byte-validated loader',
      renderMeshesRead: false,
    },
    tile: {
      id: TILE.id,
      crs: TILE.crs,
      boundsEpsg26910Metres: TILE.bounds,
      boundaryPolicy: 'inclusive; exact clipped boundary intersections are portals',
      selectionPolicy: 'select a highway way only when at least one ordered source segment has non-zero length inside the exact tile rectangle',
    },
    classification: {
      vehicleRule: 'highway=* excluding the pedestrianHighwayValues list',
      pedestrianHighwayValues: [...PEDESTRIAN_HIGHWAYS].sort(lexical),
      unknownValuesInvented: false,
    },
    counts: {
      selectedHighwayWays: selected.length,
      vehicleWays: vehicleWays.length,
      pedestrianWays: pedestrianWays.length,
      explicitCrossingWays: explicitCrossingWays.length,
      pedestrianVehicleSourceNodeIntersections: pedestrianVehicleIntersections.length,
      tileBoundaryPortals: portalRecords.length,
      vehicleGraph: { nodes: vehicleNodes.size, directedEdges: vehicleEdges.length, connectedComponentsIgnoringDirection: vehicleComponents },
      pedestrianGraph: { nodes: pedestrianNodes.size, sourceConnectivityEdges: pedestrianEdges.length, connectedComponents: pedestrianComponents },
    },
    unknownVehicleSemantics: unknown,
    explicitCrossingWayIds: explicitCrossingWays,
    pedestrianVehicleSourceNodeIntersections: pedestrianVehicleIntersections,
    tileBoundaryPortals: portalRecords,
    graphs: {
      vehicle: { nodes: serializableNodes(vehicleNodes), directedEdges: vehicleEdges },
      pedestrian: { nodes: serializableNodes(pedestrianNodes), edges: pedestrianEdges },
    },
    sourceWays: serializedWays,
    unsupportedSourceCoverage: {
      standaloneSignalNodes: 'not present in loadSfMetricSharedInputs(); no signal-node contract is claimed',
      restrictionRelations: 'not present in loadSfMetricSharedInputs(); no turn-restriction contract is claimed',
    },
    authorizationBlockers: [
      'The horizontal geometry source lock does not authorize traffic, pedestrian, lane, speed, surface, sidewalk, crossing, or signal runtime contracts.',
      'Standalone signal-node objects are absent from the required shared input loader.',
      'Turn-restriction relation objects are absent from the required shared input loader.',
      'Missing or unsupported source semantics are reported and never defaulted or inferred.',
      'This horizontal-only proof contains no terrain samples, elevations, vertical datum realization, or vertical authorization.',
      'A separate deterministic build, receipt, source-lock authorization, runtime integration, and contract QA remain required before promotion.',
    ],
    verticalSupport: { present: false, claimed: false, statement: 'No vertical data was read or derived.' },
  };

  assert.equal(output.proofOnly, true);
  assert.equal(output.writesArtifacts, false);
  assert.equal(output.runtimePromotionReady, false);
  assert.deepEqual(output.source.osmPbf, { ...EXPECTED.osmPbf, byteIdentityValidated: true }, 'Locked OSM PBF identity drifted');
  assert.equal(output.source.horizontalTransformLockSha256, EXPECTED.horizontalTransformLockSha256, 'Horizontal transform lock drifted');
  assert.equal(output.source.horizontalGeometryAuthorizationSha256, EXPECTED.horizontalGeometryAuthorizationSha256, 'Horizontal geometry authorization drifted');
  assert.deepEqual(output.counts, EXPECTED.counts, 'Exact-tile source graph feasibility counts drifted');
  assert.deepEqual(
    Object.fromEntries(Object.entries(output.unknownVehicleSemantics).map(([family, record]) => [family, record.count])),
    EXPECTED.unknownVehicleSemantics,
    'Exact-tile unknown vehicle semantic counts drifted',
  );
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

await main();
