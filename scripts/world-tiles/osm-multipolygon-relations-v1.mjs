/**
 * Deterministic, fail-closed OSM multipolygon relation assembly.
 *
 * The PBF reader deliberately uses three passes (relations, member ways, then
 * referenced nodes) so callers can select a bounded set of relation IDs without
 * retaining the whole extract. The result is canonical polygon rings for a tile
 * baker; clipping and triangulation remain the baker's responsibility.
 */
import fs from 'node:fs';
import parse from 'osm-pbf-parser';
import through from 'through2';

const ROLE_OUTER = 'outer';
const ROLE_INNER = 'inner';
const VALID_ROLES = new Set([ROLE_OUTER, ROLE_INNER]);

function relationMember(member) {
  return { type: member.type, id: member.id, role: member.role ?? '' };
}

function wayRecord(way) {
  return { type: 'way', id: way.id, tags: { ...(way.tags ?? {}) }, refs: [...(way.refs ?? [])] };
}

function nodeCoordinate(node) {
  if (Array.isArray(node)) return [...node];
  if (node && Number.isFinite(node.lon) && Number.isFinite(node.lat)) return [node.lon, node.lat];
  return null;
}

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function normalizedRole(member) {
  // Empty roles are permitted by OSM's multipolygon model and mean outer.
  return member.role === '' || member.role == null ? ROLE_OUTER : member.role;
}

function signedArea(ring) {
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    twiceArea += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return twiceArea / 2;
}

function reverseRing(ring) {
  return {
    ...ring,
    nodeIds: [...ring.nodeIds].reverse(),
    coordinates: [...ring.coordinates].reverse(),
    wayTraversals: [...ring.wayTraversals].reverse().map((entry) => ({ ...entry, reversed: !entry.reversed })),
    canonicalWindingReversed: !ring.canonicalWindingReversed,
  };
}

function endpointKey(value) {
  return `${typeof value}:${String(value)}`;
}

function stitchRoleMembers(role, members, ways) {
  const errors = [];
  const segments = [];
  for (const member of members) {
    const way = ways.get(member.id);
    if (!way) {
      errors.push(issue('missing-member-way', `relation member way/${member.id} is unavailable`, { role, wayId: member.id, memberIndex: member.memberIndex }));
      continue;
    }
    const refs = [...(way.refs ?? [])];
    if (refs.length < 2) {
      errors.push(issue('member-way-too-short', `way/${member.id} has fewer than two node references`, { role, wayId: member.id, memberIndex: member.memberIndex }));
      continue;
    }
    segments.push({ id: member.id, refs, memberIndex: member.memberIndex });
  }
  if (errors.length) return { rings: [], errors };

  const rings = [];
  const closed = segments.filter(({ refs }) => refs[0] === refs.at(-1));
  for (const segment of closed) {
    rings.push({ role, nodeIds: segment.refs, wayTraversals: [{ wayId: segment.id, memberIndex: segment.memberIndex, reversed: false }] });
  }

  const open = segments.filter(({ refs }) => refs[0] !== refs.at(-1));
  const endpointIncidence = new Map();
  const addEndpoint = (nodeId, segmentIndex) => {
    const key = endpointKey(nodeId);
    const entries = endpointIncidence.get(key) ?? [];
    entries.push(segmentIndex);
    endpointIncidence.set(key, entries);
  };
  open.forEach((segment, index) => {
    addEndpoint(segment.refs[0], index);
    addEndpoint(segment.refs.at(-1), index);
  });
  for (const [nodeKey, entries] of endpointIncidence) {
    if (entries.length !== 2) {
      errors.push(issue(entries.length < 2 ? 'open-ring' : 'ambiguous-ring-junction', `role ${role} endpoint ${nodeKey} has degree ${entries.length}; exactly two are required`, { role, endpoint: nodeKey, degree: entries.length, wayIds: entries.map((index) => open[index].id) }));
    }
  }
  if (errors.length) return { rings: [], errors };

  const unused = new Set(open.map((_, index) => index));
  while (unused.size) {
    const startIndex = [...unused].sort((a, b) => open[a].memberIndex - open[b].memberIndex || a - b)[0];
    const start = open[startIndex];
    unused.delete(startIndex);
    const nodeIds = [...start.refs];
    const wayTraversals = [{ wayId: start.id, memberIndex: start.memberIndex, reversed: false }];
    let tail = nodeIds.at(-1);
    let guard = open.length + 1;
    while (tail !== nodeIds[0] && guard > 0) {
      guard -= 1;
      const candidates = (endpointIncidence.get(endpointKey(tail)) ?? []).filter((index) => unused.has(index));
      if (candidates.length !== 1) {
        errors.push(issue(candidates.length ? 'ambiguous-ring-traversal' : 'open-ring', `role ${role} traversal at node ${tail} has ${candidates.length} unused continuations`, { role, endpoint: tail, wayIds: candidates.map((index) => open[index].id) }));
        break;
      }
      const nextIndex = candidates[0];
      const next = open[nextIndex];
      unused.delete(nextIndex);
      const reversed = next.refs.at(-1) === tail;
      const refs = reversed ? [...next.refs].reverse() : [...next.refs];
      if (refs[0] !== tail) {
        errors.push(issue('disconnected-ring', `way/${next.id} does not continue role ${role} at node ${tail}`, { role, wayId: next.id, endpoint: tail }));
        break;
      }
      nodeIds.push(...refs.slice(1));
      wayTraversals.push({ wayId: next.id, memberIndex: next.memberIndex, reversed });
      tail = nodeIds.at(-1);
    }
    if (tail === nodeIds[0]) rings.push({ role, nodeIds, wayTraversals });
  }
  return errors.length ? { rings: [], errors } : { rings, errors };
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point, a, b) {
  const tolerance = 1e-10;
  return Math.abs(orientation(a, b, point)) <= tolerance
    && point[0] >= Math.min(a[0], b[0]) - tolerance && point[0] <= Math.max(a[0], b[0]) + tolerance
    && point[1] >= Math.min(a[1], b[1]) - tolerance && point[1] <= Math.max(a[1], b[1]) + tolerance;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const a = ring[index]; const b = ring[index + 1];
    if (pointOnSegment(point, a, b)) return 'boundary';
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function segmentIntersectionKind(a, b, c, d) {
  const abC = orientation(a, b, c); const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a); const cdB = orientation(c, d, b);
  const epsilon = 1e-10;
  const zero = (value) => Math.abs(value) <= epsilon;
  if (zero(abC) && pointOnSegment(c, a, b)) return 'touch';
  if (zero(abD) && pointOnSegment(d, a, b)) return 'touch';
  if (zero(cdA) && pointOnSegment(a, c, d)) return 'touch';
  if (zero(cdB) && pointOnSegment(b, c, d)) return 'touch';
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0) ? 'cross' : null;
}

function ringsIntersect(a, b) {
  for (let aIndex = 0; aIndex < a.length - 1; aIndex += 1) {
    for (let bIndex = 0; bIndex < b.length - 1; bIndex += 1) {
      const kind = segmentIntersectionKind(a[aIndex], a[aIndex + 1], b[bIndex], b[bIndex + 1]);
      if (kind) return kind;
    }
  }
  return null;
}

function ringSelfIntersects(ring) {
  const edgeCount = ring.length - 1;
  for (let first = 0; first < edgeCount; first += 1) {
    for (let second = first + 1; second < edgeCount; second += 1) {
      if (second === first + 1 || (first === 0 && second === edgeCount - 1)) continue;
      if (segmentIntersectionKind(ring[first], ring[first + 1], ring[second], ring[second + 1])) return true;
    }
  }
  return false;
}

function transformRing(rawRing, nodes, relation, transformCoordinate, errors) {
  if (rawRing.nodeIds.length < 4 || rawRing.nodeIds[0] !== rawRing.nodeIds.at(-1)) {
    errors.push(issue('invalid-closed-ring', `relation/${relation.id} ${rawRing.role} ring is not a closed ring with at least four node references`, { role: rawRing.role, wayIds: rawRing.wayTraversals.map(({ wayId }) => wayId) }));
    return null;
  }
  const coordinates = [];
  for (const nodeId of rawRing.nodeIds) {
    const sourceCoordinate = nodeCoordinate(nodes.get(nodeId));
    if (!sourceCoordinate) {
      errors.push(issue('missing-member-node', `node/${nodeId} required by relation/${relation.id} is unavailable`, { role: rawRing.role, nodeId, wayIds: rawRing.wayTraversals.map(({ wayId }) => wayId) }));
      return null;
    }
    const transformed = transformCoordinate(sourceCoordinate, { relationId: relation.id, nodeId, role: rawRing.role });
    if (!Array.isArray(transformed) || transformed.length < 2 || !Number.isFinite(transformed[0]) || !Number.isFinite(transformed[1])) {
      errors.push(issue('invalid-transformed-coordinate', `transform returned an invalid coordinate for node/${nodeId}`, { role: rawRing.role, nodeId }));
      return null;
    }
    coordinates.push([transformed[0], transformed[1]]);
  }
  const area = signedArea(coordinates);
  if (!Number.isFinite(area) || area === 0) {
    errors.push(issue('degenerate-ring', `relation/${relation.id} ${rawRing.role} ring has zero transformed area`, { role: rawRing.role, wayIds: rawRing.wayTraversals.map(({ wayId }) => wayId) }));
    return null;
  }
  if (ringSelfIntersects(coordinates)) {
    errors.push(issue('self-intersecting-ring', `relation/${relation.id} ${rawRing.role} ring self-intersects after transformation`, { role: rawRing.role, wayIds: rawRing.wayTraversals.map(({ wayId }) => wayId) }));
    return null;
  }
  let ring = { ...rawRing, sourceWayIds: rawRing.wayTraversals.map(({ wayId }) => wayId), coordinates, canonicalWindingReversed: false };
  const wantsPositiveArea = rawRing.role === ROLE_OUTER;
  if ((area > 0) !== wantsPositiveArea) ring = reverseRing(ring);
  return { ...ring, signedArea: signedArea(ring.coordinates) };
}

/** Assemble one raw relation using preloaded member ways and nodes. */
export function assembleMultipolygonRelation({ relation, ways, nodes, transformCoordinate = (coordinate) => coordinate }) {
  const sourceMembers = (relation.members ?? []).map(relationMember);
  const result = {
    source: { type: 'relation', id: relation.id, tags: { ...(relation.tags ?? {}) }, members: sourceMembers },
    complete: false,
    coverage: { relationComplete: false, claim: 'incomplete; must not be treated as relation coverage' },
    polygons: [], outerRings: [], innerRings: [], errors: [],
  };
  if (relation.tags?.type !== 'multipolygon') {
    result.errors.push(issue('not-multipolygon', `relation/${relation.id} does not have type=multipolygon`));
    return result;
  }
  const roleMembers = { outer: [], inner: [] };
  sourceMembers.forEach((member, memberIndex) => {
    if (member.type !== 'way') {
      result.errors.push(issue('unsupported-member-type', `relation/${relation.id} member ${memberIndex} is ${member.type}, not a way`, { memberIndex, member }));
      return;
    }
    const role = normalizedRole(member);
    if (!VALID_ROLES.has(role)) {
      result.errors.push(issue('unsupported-member-role', `relation/${relation.id} way/${member.id} has unsupported role ${JSON.stringify(member.role)}`, { memberIndex, member }));
      return;
    }
    roleMembers[role].push({ ...member, role, memberIndex });
  });
  if (!roleMembers.outer.length) result.errors.push(issue('missing-outer-members', `relation/${relation.id} has no outer way members`));
  if (result.errors.length) return result;

  const stitchedOuter = stitchRoleMembers(ROLE_OUTER, roleMembers.outer, ways);
  const stitchedInner = stitchRoleMembers(ROLE_INNER, roleMembers.inner, ways);
  result.errors.push(...stitchedOuter.errors, ...stitchedInner.errors);
  if (result.errors.length) return result;
  result.outerRings = stitchedOuter.rings.map((ring) => transformRing(ring, nodes, relation, transformCoordinate, result.errors)).filter(Boolean);
  result.innerRings = stitchedInner.rings.map((ring) => transformRing(ring, nodes, relation, transformCoordinate, result.errors)).filter(Boolean);
  if (result.errors.length) {
    result.outerRings = []; result.innerRings = [];
    return result;
  }

  const polygons = result.outerRings.map((outer) => ({ outer, holes: [] }));
  for (let first = 0; first < result.outerRings.length; first += 1) {
    for (let second = first + 1; second < result.outerRings.length; second += 1) {
      const intersection = ringsIntersect(result.outerRings[first].coordinates, result.outerRings[second].coordinates);
      const nested = pointInRing(result.outerRings[first].coordinates[0], result.outerRings[second].coordinates) === 'inside'
        || pointInRing(result.outerRings[second].coordinates[0], result.outerRings[first].coordinates) === 'inside';
      if (intersection || nested) result.errors.push(issue('overlapping-outer-rings', `relation/${relation.id} outer rings overlap, touch, or contain one another`, { firstWayIds: result.outerRings[first].sourceWayIds, secondWayIds: result.outerRings[second].sourceWayIds, intersection }));
    }
  }
  for (const hole of result.innerRings) {
    const containers = polygons.filter(({ outer }) => pointInRing(hole.coordinates[0], outer.coordinates) === 'inside');
    const boundaryIntersection = polygons.map(({ outer }) => ringsIntersect(hole.coordinates, outer.coordinates)).find(Boolean) ?? null;
    if (boundaryIntersection || containers.length !== 1) {
      result.errors.push(issue('unassigned-inner-ring', `relation/${relation.id} inner ring must be strictly inside exactly one outer ring`, { wayIds: hole.sourceWayIds, containingOuterCount: containers.length, boundaryIntersection }));
      continue;
    }
    containers[0].holes.push(hole);
  }
  for (const polygon of polygons) {
    for (let first = 0; first < polygon.holes.length; first += 1) {
      for (let second = first + 1; second < polygon.holes.length; second += 1) {
        const a = polygon.holes[first]; const b = polygon.holes[second];
        const intersection = ringsIntersect(a.coordinates, b.coordinates);
        const nested = pointInRing(a.coordinates[0], b.coordinates) === 'inside' || pointInRing(b.coordinates[0], a.coordinates) === 'inside';
        if (intersection || nested) result.errors.push(issue('overlapping-inner-rings', `relation/${relation.id} inner rings overlap, touch, or contain one another`, { firstWayIds: a.sourceWayIds, secondWayIds: b.sourceWayIds, intersection }));
      }
    }
  }
  if (result.errors.length) {
    result.outerRings = []; result.innerRings = []; result.polygons = [];
    return result;
  }
  result.polygons = polygons;
  result.complete = true;
  result.coverage = { relationComplete: true, claim: 'all declared relation members resolved into closed canonical rings' };
  return result;
}

async function scanPbf(pbfPath, onItems) {
  await new Promise((resolve, reject) => {
    fs.createReadStream(pbfPath).pipe(parse()).pipe(through.obj((items, _encoding, callback) => {
      try { onItems(items); callback(); } catch (error) { callback(error); }
    })).on('finish', resolve).on('error', reject);
  });
}

/**
 * Read selected multipolygon relations from a raw OSM PBF in bounded memory.
 * Missing requested IDs are explicitly reported and make coverageComplete false.
 */
export async function readMultipolygonRelationsFromPbf({ pbfPath, relationIds, transformCoordinate = (coordinate) => coordinate }) {
  if (!pbfPath) throw new TypeError('pbfPath is required');
  if (!relationIds || ![...relationIds].length) throw new TypeError('relationIds must contain at least one relation ID');
  const requestedIds = [...new Set([...relationIds])];
  const requested = new Set(requestedIds);
  const relations = new Map();
  await scanPbf(pbfPath, (items) => {
    for (const item of items) if (item.type === 'relation' && requested.has(item.id)) relations.set(item.id, { type: 'relation', id: item.id, tags: { ...(item.tags ?? {}) }, members: (item.members ?? []).map(relationMember) });
  });
  const wayIds = new Set([...relations.values()].flatMap(({ members }) => members.filter(({ type }) => type === 'way').map(({ id }) => id)));
  const ways = new Map();
  await scanPbf(pbfPath, (items) => {
    for (const item of items) if (item.type === 'way' && wayIds.has(item.id)) ways.set(item.id, wayRecord(item));
  });
  const nodeIds = new Set([...ways.values()].flatMap(({ refs }) => refs));
  const nodes = new Map();
  await scanPbf(pbfPath, (items) => {
    for (const item of items) if (item.type === 'node' && nodeIds.has(item.id)) nodes.set(item.id, { lon: item.lon, lat: item.lat });
  });
  const assembled = requestedIds.filter((id) => relations.has(id)).map((id) => assembleMultipolygonRelation({ relation: relations.get(id), ways, nodes, transformCoordinate }));
  const missingRelationIds = requestedIds.filter((id) => !relations.has(id));
  return {
    relationIds: requestedIds,
    relations: assembled,
    missingRelationIds,
    coverageComplete: missingRelationIds.length === 0 && assembled.every(({ complete }) => complete),
    counts: { requestedRelations: requestedIds.length, foundRelations: relations.size, memberWaysRequested: wayIds.size, memberWaysFound: ways.size, memberNodesRequested: nodeIds.size, memberNodesFound: nodes.size },
  };
}
