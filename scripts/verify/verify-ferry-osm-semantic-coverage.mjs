/**
 * Read-only audit of source-present OSM semantics in the production-authorized
 * Ferry horizontal-geometry window. Missing values are reported, never derived.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parse from 'osm-pbf-parser';
import through from 'through2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_RELATIVE_PATH = 'public/data/world/source-locks/sf-ferry-osm-horizontal-geometry-v1.lock.json';
const LOCK_PATH = path.join(ROOT, LOCK_RELATIVE_PATH);
const REQUIRED_LOCK_STATUS = 'production-horizontal-geometry-authorized';
const PEDESTRIAN_HIGHWAY_VALUES = ['footway', 'path', 'pedestrian', 'steps'];
const TAG_FAMILIES = ['oneway', 'lanes', 'maxspeed', 'access', 'surface', 'sidewalk', 'cycleway'];

const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sortedRecord = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => lexical(a, b)));
const ratio = (count, total) => total === 0 ? 0 : Number((count / total).toFixed(6));
const isFiniteCoordinate = (value) => Number.isFinite(value);

function tagFamilyMatches(key, family) {
  if (key === family || key.startsWith(`${family}:`)) return true;
  if (family === 'lanes') return key.endsWith(':lanes') || key.includes(':lanes:');
  return false;
}

function matchingTagKeys(tags, family) {
  return Object.keys(tags ?? {}).filter((key) => tagFamilyMatches(key, family)).sort(lexical);
}

function insideCoverage(lon, lat, [west, south, east, north]) {
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function pointInRing([x, y], coordinates) {
  let inside = false;
  for (let index = 0, previous = coordinates.length - 1; index < coordinates.length; previous = index, index += 1) {
    const [xi, yi] = coordinates[index];
    const [xj, yj] = coordinates[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orientation([ax, ay], [bx, by], [cx, cy]) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment([ax, ay], [bx, by], [px, py]) {
  const epsilon = 1e-12;
  return Math.abs(orientation([ax, ay], [bx, by], [px, py])) <= epsilon
    && px >= Math.min(ax, bx) - epsilon && px <= Math.max(ax, bx) + epsilon
    && py >= Math.min(ay, by) - epsilon && py <= Math.max(ay, by) + epsilon;
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d))
    || (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b));
}

function wayIntersectsCoverage(way, nodeCoordinates, bounds) {
  const coordinates = way.refs.map((nodeId) => {
    const coordinate = nodeCoordinates.get(nodeId);
    assert(coordinate, `OSM way/${way.id} references unavailable node/${nodeId}`);
    return coordinate;
  });
  if (coordinates.some(([lon, lat]) => insideCoverage(lon, lat, bounds))) return true;
  const [west, south, east, north] = bounds;
  const edges = [
    [[west, south], [east, south]],
    [[east, south], [east, north]],
    [[east, north], [west, north]],
    [[west, north], [west, south]],
  ];
  for (let index = 1; index < coordinates.length; index += 1) {
    if (edges.some(([a, b]) => segmentsIntersect(coordinates[index - 1], coordinates[index], a, b))) return true;
  }
  return coordinates.length > 3 && coordinates[0][0] === coordinates.at(-1)[0]
    && coordinates[0][1] === coordinates.at(-1)[1]
    && pointInRing([(west + east) / 2, (south + north) / 2], coordinates);
}

function isCrossingNode(tags) {
  return tags.highway === 'crossing' || Object.keys(tags).some((key) => key === 'crossing' || key.startsWith('crossing:'));
}

function isTrafficSignalNode(tags) {
  return tags.highway === 'traffic_signals' || tags.crossing === 'traffic_signals';
}

function isKerbNode(tags) {
  return tags.barrier === 'kerb' || Object.keys(tags).some((key) => key === 'kerb' || key.startsWith('kerb:'));
}

function isPublicTransportNode(tags) {
  return tags.highway === 'bus_stop' || Object.keys(tags).some((key) => key === 'public_transport' || key.startsWith('public_transport:'));
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

function scanPbf(pbfPath, onItems) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(pbfPath)
      .pipe(parse())
      .pipe(through.obj((items, _encoding, callback) => {
        try {
          onItems(items);
          callback();
        } catch (error) {
          callback(error);
        }
      }))
      .on('finish', resolve)
      .on('error', reject);
  });
}

function sourceFamily(count, productionAuthorized, authorizationBasis) {
  return {
    required: true,
    sourceSupport: count > 0 ? 'present' : 'absent',
    sourceEvidenceCount: count,
    productionAuthorized,
    authorizationBasis,
  };
}

async function main() {
  const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  assert.equal(lock.status, REQUIRED_LOCK_STATUS, 'Ferry OSM source lock is not production horizontal-geometry authorized');
  assert.equal(lock.scope, REQUIRED_LOCK_STATUS, 'Ferry OSM source-lock scope drifted');
  assert.equal(lock.nativeHorizontalCrs, 'EPSG:4326', 'Ferry OSM source lock must use EPSG:4326 coordinates');
  const bounds = lock.approvedScope?.coverageWgs84;
  assert(Array.isArray(bounds) && bounds.length === 4 && bounds.every(isFiniteCoordinate), 'Source lock has no valid approvedScope.coverageWgs84');
  assert(bounds[0] < bounds[2] && bounds[1] < bounds[3], 'Source-lock coverage bounds are empty or reversed');

  const snapshot = lock.source?.snapshot;
  assert(snapshot?.localPath, 'Source lock has no snapshot.localPath');
  const pbfPath = path.resolve(ROOT, snapshot.localPath);
  assert.equal(await realpath(pbfPath), await realpath(path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf')), 'Source lock points at an unexpected OSM PBF');
  const pbfStat = await stat(pbfPath);
  const pbfSha256 = await sha256File(pbfPath);
  assert.equal(pbfStat.size, snapshot.bytes, 'Locked OSM PBF byte count drifted');
  assert.equal(pbfSha256, snapshot.sha256, 'Locked OSM PBF SHA-256 drifted');

  const routeRelations = new Map();
  const restrictionRelations = new Map();
  const relationMemberWayIds = new Set();
  const relationMemberNodeIds = new Set();
  await scanPbf(pbfPath, (items) => {
    for (const item of items) {
      if (item.type !== 'relation') continue;
      const isRoute = item.tags?.type === 'route' && Boolean(item.tags.route);
      const isRestriction = item.tags?.type === 'restriction' && Boolean(item.tags.restriction);
      if (!isRoute && !isRestriction) continue;
      const members = (item.members ?? []).map(({ type, id, role = '' }) => ({ type, id, role }));
      if (isRoute) routeRelations.set(item.id, { id: item.id, route: item.tags.route, members });
      else restrictionRelations.set(item.id, { id: item.id, restriction: item.tags.restriction, members });
      for (const member of members) {
        if (member.type === 'way') relationMemberWayIds.add(member.id);
        if (member.type === 'node') relationMemberNodeIds.add(member.id);
      }
    }
  });

  const ways = new Map();
  const nodeIdsInsideCoverage = new Set();
  const routeMemberNodesInsideCoverage = new Set();
  const specialNodes = { crossings: new Set(), trafficSignals: new Set(), kerbs: new Set(), publicTransportOrBusStops: new Set() };
  await scanPbf(pbfPath, (items) => {
    for (const item of items) {
      if (item.type === 'node') {
        if (!insideCoverage(item.lon, item.lat, bounds)) continue;
        nodeIdsInsideCoverage.add(item.id);
        if (relationMemberNodeIds.has(item.id)) routeMemberNodesInsideCoverage.add(item.id);
        const tags = item.tags ?? {};
        if (isCrossingNode(tags)) specialNodes.crossings.add(item.id);
        if (isTrafficSignalNode(tags)) specialNodes.trafficSignals.add(item.id);
        if (isKerbNode(tags)) specialNodes.kerbs.add(item.id);
        if (isPublicTransportNode(tags)) specialNodes.publicTransportOrBusStops.add(item.id);
      } else if (item.type === 'way' && (item.tags?.highway || relationMemberWayIds.has(item.id))) {
        ways.set(item.id, { id: item.id, refs: [...(item.refs ?? [])], tags: { ...(item.tags ?? {}) } });
      }
    }
  });

  const requiredNodeIds = new Set();
  for (const way of ways.values()) for (const nodeId of way.refs) requiredNodeIds.add(nodeId);
  const nodeCoordinates = new Map();
  await scanPbf(pbfPath, (items) => {
    for (const item of items) {
      if (item.type === 'node' && requiredNodeIds.has(item.id)) nodeCoordinates.set(item.id, [item.lon, item.lat]);
    }
  });
  assert.equal(nodeCoordinates.size, requiredNodeIds.size, 'One or more selected OSM ways or route relations have unresolved node references');

  const intersectingWays = new Map([...ways].filter(([, way]) => wayIntersectsCoverage(way, nodeCoordinates, bounds)));
  const highwayWays = [...intersectingWays.values()].filter((way) => Boolean(way.tags.highway));
  const tagCoverage = {};
  for (const family of TAG_FAMILIES) {
    const observedKeys = {};
    let waysWithTagFamily = 0;
    for (const way of highwayWays) {
      const keys = matchingTagKeys(way.tags, family);
      if (keys.length) waysWithTagFamily += 1;
      for (const key of keys) observedKeys[key] = (observedKeys[key] ?? 0) + 1;
    }
    tagCoverage[family] = {
      waysWithTagFamily,
      highwayWaysWithoutTagFamily: highwayWays.length - waysWithTagFamily,
      fractionOfHighwayWays: ratio(waysWithTagFamily, highwayWays.length),
      observedKeys: sortedRecord(observedKeys),
    };
  }

  const pedestrianWayTypes = Object.fromEntries(PEDESTRIAN_HIGHWAY_VALUES.map((value) => [value, highwayWays.filter((way) => way.tags.highway === value).length]));
  const pedestrianWays = Object.values(pedestrianWayTypes).reduce((sum, count) => sum + count, 0);
  const relevantRelations = [...routeRelations.values()].filter((relation) => relation.members.some((member) =>
    (member.type === 'way' && intersectingWays.has(member.id))
    || (member.type === 'node' && routeMemberNodesInsideCoverage.has(member.id))));
  const relevantRestrictions = [...restrictionRelations.values()].filter((relation) => relation.members.some((member) =>
    (member.type === 'way' && intersectingWays.has(member.id))
    || (member.type === 'node' && routeMemberNodesInsideCoverage.has(member.id))));
  const routeTypes = {};
  for (const relation of relevantRelations) routeTypes[relation.route] = (routeTypes[relation.route] ?? 0) + 1;
  const restrictionTypes = {};
  for (const relation of relevantRestrictions) {
    restrictionTypes[relation.restriction] = (restrictionTypes[relation.restriction] ?? 0) + 1;
  }

  const geometryAuthorizationBasis = `${lock.id}:${lock.status}`;
  const semanticsAuthorizationBasis = `${lock.id} authorizes horizontal geometry only; it does not authorize playable or simulation contracts`;
  const contractFamilies = {
    horizontalRoadGeometry: sourceFamily(highwayWays.length, true, geometryAuthorizationBasis),
    directionality: sourceFamily(tagCoverage.oneway.waysWithTagFamily, false, semanticsAuthorizationBasis),
    laneCounts: sourceFamily(tagCoverage.lanes.waysWithTagFamily, false, semanticsAuthorizationBasis),
    speedLimits: sourceFamily(tagCoverage.maxspeed.waysWithTagFamily, false, semanticsAuthorizationBasis),
    accessRules: sourceFamily(tagCoverage.access.waysWithTagFamily, false, semanticsAuthorizationBasis),
    surfaceClassification: sourceFamily(tagCoverage.surface.waysWithTagFamily, false, semanticsAuthorizationBasis),
    sidewalkDesignation: sourceFamily(tagCoverage.sidewalk.waysWithTagFamily, false, semanticsAuthorizationBasis),
    cyclewayDesignation: sourceFamily(tagCoverage.cycleway.waysWithTagFamily, false, semanticsAuthorizationBasis),
    pedestrianPaths: sourceFamily(pedestrianWays, false, semanticsAuthorizationBasis),
    crossings: sourceFamily(specialNodes.crossings.size, false, semanticsAuthorizationBasis),
    trafficSignals: sourceFamily(specialNodes.trafficSignals.size, false, semanticsAuthorizationBasis),
    kerbs: sourceFamily(specialNodes.kerbs.size, false, semanticsAuthorizationBasis),
    transitStops: sourceFamily(specialNodes.publicTransportOrBusStops.size, false, semanticsAuthorizationBasis),
    routeMembership: sourceFamily(relevantRelations.length, false, semanticsAuthorizationBasis),
    turnRestrictions: sourceFamily(relevantRestrictions.length, false, semanticsAuthorizationBasis),
  };
  const missingSourceSemantics = Object.entries(contractFamilies).filter(([, family]) => family.sourceSupport === 'absent').map(([name]) => name);
  const partialExplicitHighwayTagCoverage = Object.fromEntries(TAG_FAMILIES
    .filter((family) => tagCoverage[family].highwayWaysWithoutTagFamily > 0)
    .map((family) => [family, {
      highwayWaysWithoutTagFamily: tagCoverage[family].highwayWaysWithoutTagFamily,
      fractionOfHighwayWaysWithTagFamily: tagCoverage[family].fractionOfHighwayWays,
    }]));
  const notProductionAuthorized = Object.entries(contractFamilies).filter(([, family]) => !family.productionAuthorized).map(([name]) => name);
  const playableContractReady = Object.values(contractFamilies).every((family) => family.sourceSupport === 'present' && family.productionAuthorized);

  const output = {
    schemaVersion: 1,
    result: 'Ferry OSM semantic coverage audited',
    source: {
      lockPath: LOCK_RELATIVE_PATH,
      lockId: lock.id,
      lockStatus: lock.status,
      pbfPath: snapshot.localPath,
      pbfBytes: pbfStat.size,
      pbfSha256,
      byteIdentityValidated: true,
    },
    coverage: {
      crs: lock.nativeHorizontalCrs,
      boundsWgs84: bounds,
      boundaryPolicy: 'inclusive',
      waySelectionPolicy: 'way is selected when a source segment intersects the approved rectangle, a source node is inside it, or a closed way contains its center',
      nodesInsideCoverage: nodeIdsInsideCoverage.size,
    },
    counts: {
      highwayWays: highwayWays.length,
      explicitHighwayTagCoverage: tagCoverage,
      explicitPedestrianHighwayWays: { total: pedestrianWays, byHighwayValue: pedestrianWayTypes },
      nodes: {
        crossings: specialNodes.crossings.size,
        trafficSignals: specialNodes.trafficSignals.size,
        kerbs: specialNodes.kerbs.size,
        publicTransportOrBusStops: specialNodes.publicTransportOrBusStops.size,
      },
      relevantRouteRelations: { total: relevantRelations.length, byRouteType: sortedRecord(routeTypes) },
      relevantTurnRestrictionRelations: { total: relevantRestrictions.length, byRestrictionType: sortedRecord(restrictionTypes) },
    },
    semanticContractAssessment: {
      sourcePresenceRule: 'present only when at least one explicit source object or tag is observed inside the approved coverage',
      productionAuthorizationRule: 'source presence is not production authorization; only the stated source-lock scope is honored',
      missingValuePolicy: 'report absent; do not derive, default, synthesize, or infer',
      derivedValuesGenerated: false,
      inferredValuesGenerated: false,
      requiredFamilies: contractFamilies,
      missingSourceSemantics,
      partialExplicitHighwayTagCoverage,
      notProductionAuthorized,
      playableContractReady,
    },
  };
  assert.equal(playableContractReady, false, 'Horizontal-geometry authorization must not silently become a playable contract authorization');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

await main();
