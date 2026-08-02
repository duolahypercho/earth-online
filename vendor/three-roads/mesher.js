// build-road-surface-model.ts
import { laneBoundaryOffsetAt as laneBoundaryOffsetAt5, tessellateJunctionPhysicalTopology } from "./core.js";

// marking-ribbons.ts
import { laneBoundaryOffsetAt as laneBoundaryOffsetAt2 } from "./core.js";

// surface-points.ts
import {
  laneBoundaryOffsetAt,
  laneHasVerticalEdge,
  laneHeightAt,
  laneOffsetsAt,
  laneSurfacePointAt,
  lanesHaveVerticalSeparation
} from "./core.js";
function boundaryPointAt(road, section, ordinal, s) {
  const separated = separatedBoundaryPoint(road, section, ordinal, s);
  if (separated)
    return separated;
  const lane = boundaryOwnerLane(section, ordinal);
  if (!lane) {
    const fallback = section.lanes.find((candidate) => candidate.id !== 0) ?? section.lanes[0];
    return laneSurfacePointAt(road, section, fallback, s, 0);
  }
  const sectionS = s - section.s;
  const height = laneHeightAt(lane, sectionS);
  const t = laneBoundaryOffsetAt(section, ordinal, sectionS);
  return laneSurfacePointAt(road, section, lane, s, t, ordinal === 0 ? height.inner : height.outer);
}
function separatedBoundaryPoint(road, section, ordinal, s) {
  if (ordinal === 0) {
    const left = section.lanes.find((lane) => lane.id === 1);
    const right = section.lanes.find((lane) => lane.id === -1);
    if (!left || !right)
      return;
    if (!laneHasVerticalEdge(left, "inner") && !laneHasVerticalEdge(right, "inner"))
      return;
    return lowerPoint(laneBoundaryPoint(road, section, left, "inner", s), laneBoundaryPoint(road, section, right, "inner", s));
  }
  const inner = section.lanes.find((lane) => lane.id === ordinal);
  const outer = section.lanes.find((lane) => lane.id === ordinal + Math.sign(ordinal));
  if (!inner || !outer || !lanesHaveVerticalSeparation(inner, outer))
    return;
  return lowerPoint(laneBoundaryPoint(road, section, inner, "outer", s), laneBoundaryPoint(road, section, outer, "inner", s));
}
function laneBoundaryPoint(road, section, lane, boundary, s) {
  const sectionS = s - section.s;
  const offsets = laneOffsetsAt(section, lane.id, sectionS);
  const heights = laneHeightAt(lane, sectionS);
  return laneSurfacePointAt(road, section, lane, s, boundary === "inner" ? offsets.inner : offsets.outer, boundary === "inner" ? heights.inner : heights.outer);
}
function lowerPoint(left, right) {
  return left.z <= right.z ? left : right;
}
function surfacePointAt(road, section, s, t, extraHeight = 0) {
  const lane = laneAtOffset(section, s - section.s, t);
  return laneSurfacePointAt(road, section, lane, s, t, interpolatedLaneHeight(lane, section, s, t) + extraHeight);
}
function boundaryOwnerLane(section, ordinal) {
  if (ordinal !== 0)
    return section.lanes.find((lane) => lane.id === ordinal);
  return section.lanes.filter((lane) => Math.abs(lane.id) === 1).sort((a, b) => a.id - b.id)[0];
}
function laneAtOffset(section, sectionS, t) {
  const candidates = section.lanes.filter((lane) => lane.id !== 0);
  const containing = candidates.find((lane) => {
    const offsets = laneOffsetsAt(section, lane.id, sectionS);
    return t >= Math.min(offsets.inner, offsets.outer) - 0.0000001 && t <= Math.max(offsets.inner, offsets.outer) + 0.0000001;
  });
  if (containing)
    return containing;
  return candidates.reduce((nearest, lane) => {
    const offsets = laneOffsetsAt(section, lane.id, sectionS);
    const minimum = Math.min(offsets.inner, offsets.outer);
    const maximum = Math.max(offsets.inner, offsets.outer);
    const distance = t < minimum ? minimum - t : t > maximum ? t - maximum : 0;
    return !nearest || distance < nearest.distance ? { lane, distance } : nearest;
  }, undefined)?.lane ?? section.lanes[0];
}
function interpolatedLaneHeight(lane, section, s, t) {
  const offsets = laneOffsetsAt(section, lane.id, s - section.s);
  const heights = laneHeightAt(lane, s - section.s);
  const width = offsets.outer - offsets.inner;
  const ratio = Math.abs(width) > 0.000000001 ? (t - offsets.inner) / width : 0;
  return heights.inner + (heights.outer - heights.inner) * ratio;
}

// marking-ribbons.ts
function buildBoundaryMarkings(road, topology, boundaries, options, interpolateOffsets = false) {
  const section = road.laneSections.find((candidate) => candidate.id === topology.sectionId);
  if (!section)
    return [];
  const offsetNeighbors = interpolateOffsets ? boundaryOffsetNeighbors(boundaries) : undefined;
  const offsetFrames = interpolateOffsets ? new Map : undefined;
  return topology.boundaries.flatMap((source) => source.markings.flatMap((marking) => {
    const boundary = boundaries.get(source.id);
    if (!boundary || marking.kind === "none" || marking.kind === "curb" || marking.color === "none")
      return [];
    const start = Math.max(topology.sStart, marking.sStart ?? topology.sStart);
    const end = Math.min(topology.sEnd, marking.sEnd ?? topology.sEnd);
    if (end - start <= 0.0000001)
      return [];
    const width = marking.width ?? 0.12;
    return stripeLayout(marking.kind, width).flatMap((stripe) => {
      const segments = stripe.broken ? dashIntervals(start, end, options.dashLength, options.dashGap) : [[start, end]];
      return segments.map(([segmentStart, segmentEnd], index) => {
        const stations = dedupeStations([
          segmentStart,
          ...boundary.samples.map((sample) => sample.s).filter((s) => s > segmentStart && s < segmentEnd),
          segmentEnd
        ]);
        const edge = (side) => stations.map((s) => {
          const center = laneBoundaryOffsetAt2(section, boundary.ordinal, s - section.s) + stripe.offset;
          const lateralOffset = center + side * width * 0.5;
          const interpolated = interpolateOffsets ? boundaryOffsetPoint(boundary, offsetNeighbors?.get(boundary.id), s, lateralOffset, offsetFrames) : undefined;
          return {
            s,
            lateralOffset,
            position: interpolated ? { ...interpolated, z: interpolated.z + options.markingHeight } : surfacePointAt(road, section, s, lateralOffset, options.markingHeight)
          };
        });
        return {
          id: `${source.id}|marking:${marking.id}|${stripe.id}|${index}`,
          sourceId: marking.id,
          ownerId: road.id,
          boundaryId: source.id,
          kind: marking.kind,
          color: marking.color ?? "white",
          width,
          left: edge(1),
          right: edge(-1)
        };
      });
    });
  }));
}
function boundaryOffsetPoint(boundary, neighbor, station, lateralOffset, frames) {
  if (!neighbor)
    return;
  const key = `${boundary.id}\x00${station}`;
  let frame = frames?.get(key);
  if (!frame) {
    const source = interpolatedBoundarySample(boundary, station);
    const target = interpolatedBoundarySample(neighbor, station);
    if (!source || !target)
      return;
    const lateralSpan = target.lateralOffset - source.lateralOffset;
    if (Math.abs(lateralSpan) <= 0.000000001)
      return;
    frame = { source, target, lateralSpan };
    frames?.set(key, frame);
  }
  const ratio = (lateralOffset - frame.source.lateralOffset) / frame.lateralSpan;
  return {
    x: frame.source.position.x + (frame.target.position.x - frame.source.position.x) * ratio,
    y: frame.source.position.y + (frame.target.position.y - frame.source.position.y) * ratio,
    z: frame.source.position.z + (frame.target.position.z - frame.source.position.z) * ratio
  };
}
function boundaryOffsetNeighbors(boundaries) {
  const values = [...boundaries.values()];
  return new Map(values.flatMap((boundary) => {
    const neighbor = values.filter((candidate) => candidate.id !== boundary.id).sort((left, right) => Math.abs(left.ordinal - boundary.ordinal) - Math.abs(right.ordinal - boundary.ordinal))[0];
    return neighbor ? [[boundary.id, neighbor]] : [];
  }));
}
function interpolatedBoundarySample(boundary, station) {
  const samples = boundary.samples;
  if (samples.length === 0)
    return;
  const exact = samples.find((sample) => Math.abs(sample.s - station) <= 0.0000001);
  if (exact)
    return exact;
  const afterIndex = samples.findIndex((sample) => sample.s > station);
  if (afterIndex <= 0)
    return afterIndex === 0 ? samples[0] : samples.at(-1);
  const before = samples[afterIndex - 1];
  const after = samples[afterIndex];
  const ratio = (station - before.s) / (after.s - before.s);
  return {
    s: station,
    lateralOffset: before.lateralOffset + (after.lateralOffset - before.lateralOffset) * ratio,
    position: {
      x: before.position.x + (after.position.x - before.position.x) * ratio,
      y: before.position.y + (after.position.y - before.position.y) * ratio,
      z: before.position.z + (after.position.z - before.position.z) * ratio
    }
  };
}
function dedupeStations(stations) {
  return stations.sort((left, right) => left - right).filter((station, index, sorted) => index === 0 || station - sorted[index - 1] > 0.0000001);
}
function stripeLayout(kind, width) {
  const separation = width;
  if (kind === "solid-solid")
    return [
      { id: "left-solid", offset: separation, broken: false },
      { id: "right-solid", offset: -separation, broken: false }
    ];
  if (kind === "solid-broken")
    return [
      { id: "left-solid", offset: separation, broken: false },
      { id: "right-broken", offset: -separation, broken: true }
    ];
  if (kind === "broken-solid")
    return [
      { id: "left-broken", offset: separation, broken: true },
      { id: "right-solid", offset: -separation, broken: false }
    ];
  return [{ id: kind, offset: 0, broken: kind === "broken" || kind === "guide" }];
}
function dashIntervals(start, end, dashLength, dashGap) {
  const result = [];
  for (let s = start;s < end - 0.0000001; s += dashLength + dashGap)
    result.push([s, Math.min(end, s + dashLength)]);
  return result;
}

// arrow-decals.ts
import { laneSectionEndS } from "./core.js";
var SHAPES = {
  straight: { lines: [[[0, 0], [3, 0]]], triangles: [[[3, 0.4], [3, -0.4], [4.2, 0]]] },
  left: { lines: [[[0, 0], [2.2, 0]], [[2.2, 0], [2.2, 1]]], triangles: [[[1.8, 1], [2.6, 1], [2.2, 2]]] },
  right: { lines: [[[0, 0], [2.2, 0]], [[2.2, 0], [2.2, -1]]], triangles: [[[1.8, -1], [2.6, -1], [2.2, -2]]] },
  "straight-left": {
    lines: [[[0, 0], [3, 0]], [[1.6, 0], [1.6, 0.9]]],
    triangles: [[[3, 0.4], [3, -0.4], [4.2, 0]], [[1.25, 0.9], [1.95, 0.9], [1.6, 1.8]]]
  },
  "straight-right": {
    lines: [[[0, 0], [3, 0]], [[1.6, 0], [1.6, -0.9]]],
    triangles: [[[3, 0.4], [3, -0.4], [4.2, 0]], [[1.25, -0.9], [1.95, -0.9], [1.6, -1.8]]]
  },
  "left-right": {
    lines: [[[0, 0], [2.2, 0]], [[2.2, 0], [2.2, 0.9]], [[2.2, 0], [2.2, -0.9]]],
    triangles: [[[1.85, 0.9], [2.55, 0.9], [2.2, 1.8]], [[1.85, -0.9], [2.55, -0.9], [2.2, -1.8]]]
  },
  "straight-left-right": {
    lines: [[[0, 0], [3, 0]], [[1.6, 0], [1.6, 0.9]], [[1.6, 0], [1.6, -0.9]]],
    triangles: [[[3, 0.4], [3, -0.4], [4.2, 0]], [[1.25, 0.9], [1.95, 0.9], [1.6, 1.8]], [[1.25, -0.9], [1.95, -0.9], [1.6, -1.8]]]
  },
  "merge-left": { lines: [[[0, 0], [2.8, 0.9]]], triangles: [[[2.45, 1.15], [2.75, 0.4], [3.8, 1.25]]] },
  "merge-right": { lines: [[[0, 0], [2.8, -0.9]]], triangles: [[[2.45, -1.15], [2.75, -0.4], [3.8, -1.25]]] }
};
function buildArrowDecals(road, height, surfaceOffsetAt = () => 0) {
  return (road.markings ?? []).flatMap((marking) => marking.kind === "arrow" ? arrowDecals(road, marking, height, surfaceOffsetAt) : []);
}
function arrowDecals(road, marking, height, surfaceOffsetAt) {
  const shape = SHAPES[marking.arrow ?? "straight"] ?? SHAPES.straight;
  const sign = marking.direction === "backward" ? -1 : 1;
  const local = ([du, dn]) => ({ s: marking.sStart + du * sign, t: marking.tOffset + dn * sign });
  const polygons = shape.lines.map(([fromRaw, toRaw]) => {
    const from = local(fromRaw);
    const to = local(toRaw);
    const ds = to.s - from.s;
    const dt = to.t - from.t;
    const length = Math.hypot(ds, dt);
    const half = 0.125;
    const ns = -dt / length * half;
    const nt = ds / length * half;
    return [
      { s: from.s + ns, t: from.t + nt },
      { s: to.s + ns, t: to.t + nt },
      { s: to.s - ns, t: to.t - nt },
      { s: from.s - ns, t: from.t - nt }
    ];
  });
  polygons.push(...shape.triangles.map((triangle) => triangle.map(local)));
  return polygons.map((polygon, index) => ({
    id: `${marking.id}|arrow:${index}`,
    sourceId: marking.id,
    ownerId: road.id,
    color: marking.color ?? "white",
    points: polygon.map(({ s, t }) => {
      const section = road.laneSections.find((candidate) => s >= candidate.s - 0.0000001 && s <= laneSectionEndS(road, candidate) + 0.0000001);
      if (!section)
        throw new Error(`Arrow ${marking.id} leaves road ${road.id}`);
      return surfacePointAt(road, section, s, t, height + surfaceOffsetAt(s));
    })
  }));
}

// clip-road-surface-patch.ts
import { pointInPolygon, subtractPolygonComponents } from "./core.js";

// strip-surface-height.ts
var PLANAR_EPSILON = 0.0000001;
function pointOnBoundaryStrip(point, left, right) {
  if (left.samples.length !== right.samples.length) {
    throw new Error(`Boundaries ${left.id} and ${right.id} do not share a station grid`);
  }
  let nearest;
  for (let index = 0;index < left.samples.length - 1; index++) {
    const rightStart = right.samples[index];
    const rightEnd = right.samples[index + 1];
    const leftEnd = left.samples[index + 1];
    const leftStart = left.samples[index];
    const first = triangleHeight(point, rightStart, rightEnd, leftEnd);
    if (first !== undefined)
      return { ...point, z: first };
    const second = triangleHeight(point, rightStart, leftEnd, leftStart);
    if (second !== undefined)
      return { ...point, z: second };
    nearest = nearerProjection(nearest, projectToEdge(point, rightStart, rightEnd));
    nearest = nearerProjection(nearest, projectToEdge(point, rightEnd, leftEnd));
    nearest = nearerProjection(nearest, projectToEdge(point, leftEnd, leftStart));
    nearest = nearerProjection(nearest, projectToEdge(point, leftStart, rightStart));
  }
  return { ...point, z: nearest?.z ?? 0 };
}
function triangleHeight(point, first, second, third) {
  const ax = first.position.x;
  const ay = first.position.y;
  const bx = second.position.x;
  const by = second.position.y;
  const cx = third.position.x;
  const cy = third.position.y;
  const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(denominator) <= 0.000000000001)
    return;
  const firstWeight = ((by - cy) * (point.x - cx) + (cx - bx) * (point.y - cy)) / denominator;
  const secondWeight = ((cy - ay) * (point.x - cx) + (ax - cx) * (point.y - cy)) / denominator;
  const thirdWeight = 1 - firstWeight - secondWeight;
  if (firstWeight < -PLANAR_EPSILON || secondWeight < -PLANAR_EPSILON || thirdWeight < -PLANAR_EPSILON) {
    return;
  }
  return firstWeight * first.position.z + secondWeight * second.position.z + thirdWeight * third.position.z;
}
function projectToEdge(point, start, end) {
  const dx = end.position.x - start.position.x;
  const dy = end.position.y - start.position.y;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared <= 0.0000000000000001 ? 0 : Math.max(0, Math.min(1, ((point.x - start.position.x) * dx + (point.y - start.position.y) * dy) / lengthSquared));
  const x = start.position.x + dx * ratio;
  const y = start.position.y + dy * ratio;
  return {
    distanceSquared: (point.x - x) ** 2 + (point.y - y) ** 2,
    z: start.position.z + (end.position.z - start.position.z) * ratio
  };
}
function nearerProjection(current, candidate) {
  return !current || candidate.distanceSquared < current.distanceSquared ? candidate : current;
}

// clip-road-surface-patch.ts
function clipRoadSurfacePatch(patch, boundaries, junctionPatches) {
  const owners = new Set(patch.surfaceCutoutOwnerIds ?? []);
  if (owners.size === 0)
    return patch;
  const clips = junctionPatches.filter((junctionPatch) => owners.has(junctionPatch.ownerId)).flatMap((junctionPatch) => junctionPatch.components);
  if (clips.length === 0)
    return patch;
  const left = boundaries.find((boundary) => boundary.id === patch.leftBoundaryId);
  const right = boundaries.find((boundary) => boundary.id === patch.rightBoundaryId);
  if (!left || !right)
    throw new Error(`Surface patch ${patch.id} has unresolved boundaries`);
  const subject = [
    ...left.samples.map((sample) => sample.position),
    ...[...right.samples].reverse().map((sample) => sample.position)
  ];
  const components = subtractRibbon(subject, left, right, clips);
  const subjectArea = ringArea(subject);
  const unchangedAreaTolerance = Math.max(0.0000001, subjectArea * 0.00000001);
  const unchanged = components.length > 0 && components.every(({ holes }) => holes.length === 0) && Math.abs(components.reduce((sum, component) => sum + componentArea(component), 0) - subjectArea) <= unchangedAreaTolerance;
  if (unchanged)
    return patch;
  return {
    ...patch,
    components: components.map((component) => ({
      outer: component.outer.map((point) => pointOnBoundaryStrip(point, left, right)),
      holes: component.holes.map((hole) => hole.map((point) => pointOnBoundaryStrip(point, left, right)))
    }))
  };
}
function subtractRibbon(subject, left, right, clips) {
  try {
    return subtractPolygonComponents(subject, clips);
  } catch (error) {
    if (!isRecoverablePolygonTopologyError(error))
      throw error;
  }
  if (left.samples.length !== right.samples.length) {
    throw new Error(`Surface boundaries ${left.id} and ${right.id} do not share a station grid`);
  }
  return left.samples.slice(0, -1).flatMap((_, index) => {
    const quad = [
      right.samples[index].position,
      right.samples[index + 1].position,
      left.samples[index + 1].position,
      left.samples[index].position
    ];
    try {
      return subtractPolygonComponents(quad, clips);
    } catch (error) {
      if (!isRecoverablePolygonTopologyError(error))
        throw error;
      return [
        [quad[0], quad[1], quad[2]],
        [quad[0], quad[2], quad[3]]
      ].flatMap((triangle) => subtractTriangle(triangle, clips));
    }
  });
}
function subtractTriangle(triangle, clips) {
  try {
    return subtractPolygonComponents(triangle, clips);
  } catch (error) {
    if (!isRecoverablePolygonTopologyError(error))
      throw error;
    const centroid = {
      x: triangle.reduce((sum, point) => sum + point.x, 0) / triangle.length,
      y: triangle.reduce((sum, point) => sum + point.y, 0) / triangle.length
    };
    const covered = clips.some((clip) => pointInPolygon(centroid, clip.outer, true) && !clip.holes.some((hole) => pointInPolygon(centroid, hole, false)));
    return covered ? [] : [{ outer: triangle, holes: [] }];
  }
}
function isRecoverablePolygonTopologyError(error) {
  if (!(error instanceof Error))
    return false;
  return /^(?:Invalid polygon ring:|Unable to complete output ring|Tried to (?:link already linked events|create degenerate segment)|Unable to (?:find segment #|pop\(\))|Infinite loop when)/.test(error.message);
}
function componentArea(component) {
  return ringArea(component.outer) - component.holes.reduce((sum, hole) => sum + ringArea(hole), 0);
}
function ringArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) * 0.5);
}

// station-sampling.ts
import { gradeAt, laneBoundaryOffsetAt as laneBoundaryOffsetAt3, roadSuperelevationAt } from "./core.js";

// vector.ts
function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function length(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}
function distanceToSegment(point, start, end) {
  const segment = subtract(end, start);
  const denominator = dot(segment, segment);
  if (denominator <= 0.00000000000000000001)
    return length(subtract(point, start));
  const ratio = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / denominator));
  return length(subtract(point, {
    x: start.x + segment.x * ratio,
    y: start.y + segment.y * ratio,
    z: start.z + segment.z * ratio
  }));
}

// station-sampling.ts
function sampleCorridorStations(road, section, sStart, sEnd, forcedStations, evaluateBoundaries, options) {
  const seeds = uniqueSortedStations([sStart, sEnd, ...forcedStations.filter((s) => s > sStart && s < sEnd)]);
  const output = [seeds[0]];
  const boundaryCache = new Map;
  const boundariesAt = (s) => {
    const cached = boundaryCache.get(s);
    if (cached)
      return cached;
    const evaluated = evaluateBoundaries(s);
    boundaryCache.set(s, evaluated);
    return evaluated;
  };
  for (let index = 0;index < seeds.length - 1; index++) {
    subdivide(seeds[index], seeds[index + 1], 0, output);
  }
  return output;
  function subdivide(startS, endS, depth, stations) {
    const midS = (startS + endS) * 0.5;
    const startPoints = boundariesAt(startS);
    const midPoints = boundariesAt(midS);
    const endPoints = boundariesAt(endS);
    const chordError = Math.max(...midPoints.map((point, index) => distanceToSegment(point, startPoints[index], endPoints[index])));
    const profileError = Math.max(scalarMidpointError(gradeAt(road.elevation, startS), gradeAt(road.elevation, midS), gradeAt(road.elevation, endS)), scalarMidpointError(roadSuperelevationAt(road, startS), roadSuperelevationAt(road, midS), roadSuperelevationAt(road, endS)), ...section.lanes.map((lane) => scalarMidpointError(laneBoundaryOffsetAt3(section, lane.id, startS - section.s), laneBoundaryOffsetAt3(section, lane.id, midS - section.s), laneBoundaryOffsetAt3(section, lane.id, endS - section.s))));
    const midpointWithinTolerance = chordError <= options.maxChordError && profileError <= options.maxProfileError;
    const hiddenError = endS - startS > options.maxSegmentLength && midpointWithinTolerance ? quarterPointError(startS, midS, endS, startPoints, endPoints) : { chord: 0, profile: 0 };
    if (depth < options.maxDepth && endS - startS > 0.0000001 && (chordError > options.maxChordError || profileError > options.maxProfileError || hiddenError.chord > options.maxChordError || hiddenError.profile > options.maxProfileError)) {
      subdivide(startS, midS, depth + 1, stations);
      subdivide(midS, endS, depth + 1, stations);
      return;
    }
    stations.push(endS);
  }
  function quarterPointError(startS, midS, endS, startPoints, endPoints) {
    const stations = [(startS + midS) * 0.5, (midS + endS) * 0.5];
    let chord = 0;
    let profile = 0;
    for (const station of stations) {
      const ratio = (station - startS) / (endS - startS);
      const points = boundariesAt(station);
      chord = Math.max(chord, ...points.map((point, index) => distanceToSegment(point, startPoints[index], endPoints[index])));
      profile = Math.max(profile, scalarLinearError(gradeAt(road.elevation, station), gradeAt(road.elevation, startS), gradeAt(road.elevation, endS), ratio), scalarLinearError(roadSuperelevationAt(road, station), roadSuperelevationAt(road, startS), roadSuperelevationAt(road, endS), ratio), ...section.lanes.map((lane) => scalarLinearError(laneBoundaryOffsetAt3(section, lane.id, station - section.s), laneBoundaryOffsetAt3(section, lane.id, startS - section.s), laneBoundaryOffsetAt3(section, lane.id, endS - section.s), ratio)));
    }
    return { chord, profile };
  }
}
function scalarMidpointError(start, mid, end) {
  return Math.abs(mid - (start + end) * 0.5);
}
function scalarLinearError(value, start, end, ratio) {
  return Math.abs(value - (start + (end - start) * ratio));
}
function uniqueSortedStations(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    const previous = result.at(-1);
    if (previous === undefined || value - previous > 0.000000001)
      result.push(value);
  }
  return result;
}

// road-render-owner.ts
function roadRenderOwnerId(road) {
  return road.kind === "connector" && road.junctionId ? road.junctionId : road.id;
}

// junction-area-decals.ts
import {
  intersectPolygons
} from "./core.js";

// junction-surface-elevation.ts
var SMOOTHING_LENGTH = 2;
function junctionSurfaceElevationSampler(boundaries) {
  const samples = uniqueHeightSamples(boundaries);
  const segments = boundaryHeightSegments(boundaries);
  const minimum = Math.min(...samples.map(({ z }) => z));
  const maximum = Math.max(...samples.map(({ z }) => z));
  if (samples.length === 0 || maximum - minimum <= 0.0000001) {
    const z = Number.isFinite(minimum) ? minimum : 0;
    return (point) => ({ ...point, z });
  }
  return (point) => ({
    ...point,
    z: exactBoundaryHeight(point, segments) ?? localPlaneHeight(point, samples)
  });
}
function smoothSurfaceHeight(point, samples) {
  if (samples.length === 0)
    return 0;
  return localPlaneHeight(point, samples);
}
function uniqueHeightSamples(boundaries) {
  const groups = new Map;
  for (const boundary of boundaries) {
    for (const sample of boundary.samples) {
      const { x, y, z } = sample.position;
      const key = `${Math.round(x * 1e5)}|${Math.round(y * 1e5)}`;
      const group = groups.get(key);
      if (group) {
        group.height += z;
        group.count += 1;
      } else {
        groups.set(key, { x, y, height: z, count: 1 });
      }
    }
  }
  return [...groups.values()].map(({ x, y, height, count }) => ({
    x,
    y,
    z: height / count
  }));
}
function boundaryHeightSegments(boundaries) {
  return boundaries.flatMap((boundary) => boundary.samples.slice(0, -1).map((sample, index) => ({
    start: sample.position,
    end: boundary.samples[index + 1].position
  })));
}
function exactBoundaryHeight(point, segments) {
  let height = 0;
  let count = 0;
  for (const segment of segments) {
    const dx = segment.end.x - segment.start.x;
    const dy = segment.end.y - segment.start.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared <= 0.00000000000001 ? 0 : Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSquared));
    const projectedX = segment.start.x + dx * ratio;
    const projectedY = segment.start.y + dy * ratio;
    if ((point.x - projectedX) ** 2 + (point.y - projectedY) ** 2 > 0.0000000001)
      continue;
    height += segment.start.z + (segment.end.z - segment.start.z) * ratio;
    count += 1;
  }
  return count > 0 ? height / count : undefined;
}
function localPlaneHeight(point, samples) {
  const smoothingSquared = SMOOTHING_LENGTH ** 2;
  let weightSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedXX = 0;
  let weightedXY = 0;
  let weightedYY = 0;
  let weightedZ = 0;
  let weightedXZ = 0;
  let weightedYZ = 0;
  for (const sample of samples) {
    const x = sample.x - point.x;
    const y = sample.y - point.y;
    const distanceSquared = x * x + y * y;
    const weight = 1 / (distanceSquared + smoothingSquared) ** 2;
    weightSum += weight;
    weightedX += weight * x;
    weightedY += weight * y;
    weightedXX += weight * x * x;
    weightedXY += weight * x * y;
    weightedYY += weight * y * y;
    weightedZ += weight * sample.z;
    weightedXZ += weight * x * sample.z;
    weightedYZ += weight * y * sample.z;
  }
  if (weightSum <= 0.000000000000001)
    return samples[0]?.z ?? 0;
  const regularization = weightSum * 0.0000001;
  const solution = solveThreeByThree([
    [weightSum, weightedX, weightedY],
    [weightedX, weightedXX + regularization, weightedXY],
    [weightedY, weightedXY, weightedYY + regularization]
  ], [weightedZ, weightedXZ, weightedYZ]);
  return solution?.[0] ?? weightedZ / weightSum;
}
function solveThreeByThree(matrix, values) {
  const rows = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0;column < 3; column++) {
    let pivot = column;
    for (let row = column + 1;row < 3; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column]))
        pivot = row;
    }
    if (Math.abs(rows[pivot][column]) <= 0.00000000000001)
      return;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let entry = column;entry < 4; entry++)
      rows[column][entry] /= divisor;
    for (let row = 0;row < 3; row++) {
      if (row === column)
        continue;
      const factor = rows[row][column];
      for (let entry = column;entry < 4; entry++) {
        rows[row][entry] -= factor * rows[column][entry];
      }
    }
  }
  return [rows[0][3], rows[1][3], rows[2][3]];
}

// junction-area-decals.ts
var MAX_HATCH_SECTION_LENGTH = 3;
function buildJunctionAreaDecals(junction, surfacePoints, markingHeight) {
  return (junction.areaMarkings ?? []).flatMap((marking) => {
    if (marking.color === "none")
      return [];
    const polygons = areaMarkingPolygons(marking);
    return polygons.map((polygon, index) => ({
      id: `${marking.id}|area:${index}`,
      sourceId: marking.id,
      ownerId: junction.id,
      color: marking.color,
      points: polygon.map((point) => ({
        ...point,
        z: smoothSurfaceHeight(point, surfacePoints) + markingHeight
      }))
    }));
  });
}
function areaMarkingPolygons(marking) {
  const heading = marking.stripeHeading ?? Math.PI / 4;
  const width = marking.stripeWidth;
  const gap = marking.stripeGap;
  if (marking.kind === "solid")
    return [marking.polygon];
  if (marking.kind === "zebra") {
    return stripePolygons(marking.polygon, heading, width ?? 0.5, gap ?? 0.5);
  }
  if (marking.kind === "zigzag") {
    return zigzagPolygons(marking.polygon, heading, width ?? 0.12, gap ?? 2);
  }
  if (marking.kind === "shark-teeth") {
    return sharkTeethPolygons(marking.polygon, heading, width ?? 0.5, gap ?? 0.5);
  }
  if (marking.kind === "chevron") {
    return chevronPolygons(marking.polygon, heading, width ?? 0.4, gap ?? 1.6);
  }
  if (marking.kind === "box-junction") {
    return [
      ...borderPolygons(marking.polygon, width ?? 0.15),
      ...stripePolygons(marking.polygon, heading, width ?? 0.15, gap ?? 1.4),
      ...stripePolygons(marking.polygon, heading + Math.PI / 2, width ?? 0.15, gap ?? 1.4)
    ];
  }
  if (marking.kind === "cycle-box") {
    return [marking.polygon, ...borderPolygons(marking.polygon, width ?? 0.3)];
  }
  return hatchPolygons(marking.polygon, heading, width ?? 0.5, gap ?? 1.5);
}
function stripePolygons(polygon, heading, stripeWidth, stripeGap) {
  return hatchPolygons(polygon, heading, stripeWidth, stripeGap);
}
function sharkTeethPolygons(polygon, heading, toothWidth, toothGap) {
  const direction = { x: Math.cos(heading), y: Math.sin(heading) };
  const normal = { x: -direction.y, y: direction.x };
  const along = polygon.map((point) => dot2(point, direction));
  const across = polygon.map((point) => dot2(point, normal));
  const alongMin = Math.min(...along);
  const alongMax = Math.max(...along);
  const acrossMin = Math.min(...across);
  const acrossMax = Math.max(...across);
  const depth = Math.min(alongMax - alongMin, toothWidth * 2);
  const result = [];
  for (let c = acrossMin;c <= acrossMax; c += toothWidth + toothGap) {
    const triangle = [
      fromFrame(alongMin, c, direction, normal),
      fromFrame(alongMin, c + toothWidth, direction, normal),
      fromFrame(alongMin + depth, c + toothWidth * 0.5, direction, normal)
    ];
    result.push(...intersectPolygons(triangle, [polygon]).map(({ outer }) => outer));
  }
  return result;
}
function chevronPolygons(polygon, heading, stripeWidth, stripeGap) {
  return [
    ...hatchPolygons(polygon, heading + Math.PI / 4, stripeWidth, stripeGap * 2),
    ...hatchPolygons(polygon, heading - Math.PI / 4, stripeWidth, stripeGap * 2)
  ];
}
function zigzagPolygons(polygon, heading, lineWidth, period) {
  const direction = { x: Math.cos(heading), y: Math.sin(heading) };
  const normal = { x: -direction.y, y: direction.x };
  const along = polygon.map((point) => dot2(point, direction));
  const across = polygon.map((point) => dot2(point, normal));
  const alongMin = Math.min(...along);
  const alongMax = Math.max(...along);
  const acrossMin = Math.min(...across);
  const acrossMax = Math.max(...across);
  const amplitude = (acrossMax - acrossMin) * 0.5;
  const mid = (acrossMin + acrossMax) * 0.5;
  const result = [];
  for (let a = alongMin;a < alongMax; a += period * 0.5) {
    const end = Math.min(a + period * 0.5, alongMax);
    const rising = Math.round((a - alongMin) / (period * 0.5)) % 2 === 0;
    const c0 = mid + (rising ? -amplitude : amplitude);
    const c1 = mid + (rising ? amplitude : -amplitude);
    const quad = [
      fromFrame(a, c0 - lineWidth, direction, normal),
      fromFrame(end, c1 - lineWidth, direction, normal),
      fromFrame(end, c1 + lineWidth, direction, normal),
      fromFrame(a, c0 + lineWidth, direction, normal)
    ];
    result.push(...intersectPolygons(quad, [polygon]).map(({ outer }) => outer));
  }
  return result;
}
function borderPolygons(polygon, lineWidth) {
  const result = [];
  for (let index = 0;index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = Math.hypot(dx, dy);
    if (length2 < 0.000001)
      continue;
    const nx = -dy / length2;
    const ny = dx / length2;
    result.push([
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
      { x: b.x + nx * lineWidth, y: b.y + ny * lineWidth },
      { x: a.x + nx * lineWidth, y: a.y + ny * lineWidth }
    ]);
  }
  return result;
}
function hatchPolygons(polygon, heading, stripeWidth, stripeGap) {
  const direction = { x: Math.cos(heading), y: Math.sin(heading) };
  const normal = { x: -direction.y, y: direction.x };
  const along = polygon.map((point) => dot2(point, direction));
  const across = polygon.map((point) => dot2(point, normal));
  const alongMin = Math.min(...along);
  const alongMax = Math.max(...along);
  const acrossMin = Math.min(...across);
  const acrossMax = Math.max(...across);
  const padding = stripeWidth + stripeGap;
  const result = [];
  for (let center = acrossMin - padding;center <= acrossMax + padding; center += stripeWidth + stripeGap) {
    for (let sectionStart = alongMin - padding;sectionStart < alongMax + padding; sectionStart += MAX_HATCH_SECTION_LENGTH) {
      const sectionEnd = Math.min(sectionStart + MAX_HATCH_SECTION_LENGTH, alongMax + padding);
      const rectangle = [
        fromFrame(sectionStart, center - stripeWidth * 0.5, direction, normal),
        fromFrame(sectionEnd, center - stripeWidth * 0.5, direction, normal),
        fromFrame(sectionEnd, center + stripeWidth * 0.5, direction, normal),
        fromFrame(sectionStart, center + stripeWidth * 0.5, direction, normal)
      ];
      result.push(...intersectPolygons(rectangle, [polygon]).map(({ outer }) => outer));
    }
  }
  return result;
}
function fromFrame(along, across, direction, normal) {
  return { x: direction.x * along + normal.x * across, y: direction.y * along + normal.y * across };
}
function dot2(left, right) {
  return left.x * right.x + left.y * right.y;
}

// road-pattern-decals.ts
import { findLaneSection, roadObjectFootprintsST } from "./core.js";
var ZEBRA_STRIPE_WIDTH = 0.5;
var ZEBRA_STRIPE_GAP = 0.5;
var PARKING_LINE_WIDTH = 0.12;
var MAX_EDGE_SAMPLE_LENGTH = 0.75;
function buildRoadPatternDecals(network, markingHeight, selectedOwnerIds) {
  return network.roads.flatMap((road) => {
    if (selectedOwnerIds && !selectedOwnerIds.has(road.id))
      return [];
    return [
      ...(road.markings ?? []).flatMap((marking) => marking.kind === "zebra" ? zebraDecals(road, marking, markingHeight) : []),
      ...(road.objects ?? []).flatMap((object) => object.kind === "parking-space" ? parkingSpaceDecals(road, object, markingHeight) : [])
    ];
  });
}
function zebraDecals(road, marking, markingHeight) {
  if (marking.color === "none")
    return [];
  const startTMin = Math.min(marking.tStart ?? marking.tOffset, marking.tEnd ?? marking.tOffset);
  const startTMax = Math.max(marking.tStart ?? marking.tOffset, marking.tEnd ?? marking.tOffset);
  const endTMin = Math.min(marking.tStartAtEnd ?? startTMin, marking.tEndAtEnd ?? startTMax);
  const endTMax = Math.max(marking.tStartAtEnd ?? startTMin, marking.tEndAtEnd ?? startTMax);
  const lateralSpan = Math.max(startTMax - startTMin, endTMax - endTMin);
  if (lateralSpan <= 0.0000001)
    return [];
  const stripePeriod = ZEBRA_STRIPE_WIDTH + ZEBRA_STRIPE_GAP;
  const stripeCount = Math.max(1, Math.ceil((lateralSpan + ZEBRA_STRIPE_GAP) / stripePeriod));
  return Array.from({ length: stripeCount }, (_, index) => {
    const fractionStart = index * stripePeriod / lateralSpan;
    const fractionEnd = Math.min(1, (index * stripePeriod + ZEBRA_STRIPE_WIDTH) / lateralSpan);
    if (fractionStart >= 1 || fractionEnd - fractionStart <= 0.0000001)
      return;
    const stations = stationsBetween(marking.sStart, marking.sEnd);
    const left = stations.map((s) => {
      const longitudinalRatio = ratioBetween(s, marking.sStart, marking.sEnd);
      const low = mix(startTMin, endTMin, longitudinalRatio);
      const high = mix(startTMax, endTMax, longitudinalRatio);
      return pointAt(road, s, mix(low, high, fractionStart), markingHeight);
    });
    const right = stations.map((s) => {
      const longitudinalRatio = ratioBetween(s, marking.sStart, marking.sEnd);
      const low = mix(startTMin, endTMin, longitudinalRatio);
      const high = mix(startTMax, endTMax, longitudinalRatio);
      return pointAt(road, s, mix(low, high, fractionEnd), markingHeight);
    });
    return {
      id: `${marking.id}|zebra:${index}`,
      sourceId: marking.id,
      ownerId: road.id,
      color: marking.color ?? "white",
      points: [...left, ...right.reverse()]
    };
  }).filter((decal) => decal !== undefined);
}
function parkingSpaceDecals(road, object, markingHeight) {
  return roadObjectFootprintsST(object).flatMap((footprint, stallIndex) => footprint.flatMap((start, edgeIndex) => {
    const end = footprint[(edgeIndex + 1) % footprint.length];
    const ds = end.s - start.s;
    const dt = end.t - start.t;
    const length2 = Math.hypot(ds, dt);
    if (length2 <= 0.0000001)
      return [];
    const segmentCount = Math.max(1, Math.ceil(length2 / MAX_EDGE_SAMPLE_LENGTH));
    const normalS = -dt / length2 * PARKING_LINE_WIDTH * 0.5;
    const normalT = ds / length2 * PARKING_LINE_WIDTH * 0.5;
    return Array.from({ length: segmentCount }, (_, segmentIndex) => {
      const a = segmentIndex / segmentCount;
      const b = (segmentIndex + 1) / segmentCount;
      const aS = mix(start.s, end.s, a);
      const aT = mix(start.t, end.t, a);
      const bS = mix(start.s, end.s, b);
      const bT = mix(start.t, end.t, b);
      return {
        id: `${object.id}|stall:${stallIndex}|edge:${edgeIndex}|segment:${segmentIndex}`,
        sourceId: object.id,
        ownerId: road.id,
        color: "white",
        points: [
          pointAt(road, aS + normalS, aT + normalT, markingHeight),
          pointAt(road, bS + normalS, bT + normalT, markingHeight),
          pointAt(road, bS - normalS, bT - normalT, markingHeight),
          pointAt(road, aS - normalS, aT - normalT, markingHeight)
        ]
      };
    });
  }));
}
function stationsBetween(start, end) {
  const length2 = Math.abs(end - start);
  const count = Math.max(1, Math.ceil(length2 / MAX_EDGE_SAMPLE_LENGTH));
  return Array.from({ length: count + 1 }, (_, index) => mix(start, end, index / count));
}
function pointAt(road, station, lateralOffset, height) {
  const s = Math.max(0, Math.min(road.length, station));
  return surfacePointAt(road, findLaneSection(road, s), s, lateralOffset, height);
}
function ratioBetween(value, start, end) {
  return Math.abs(end - start) <= 0.0000001 ? 0 : (value - start) / (end - start);
}
function mix(start, end, ratio) {
  return start + (end - start) * ratio;
}

// loose-road-end-caps.ts
import {
  evaluateRoadReference,
  gradeAt as gradeAt2,
  laneBoundaryOffsetAt as laneBoundaryOffsetAt4,
  laneWidthAt
} from "./core.js";
var ENDPOINT_TOLERANCE = 0.000001;
var STRUCTURE_REACH_TOLERANCE = 0.5;
var MINIMUM_CAP_WIDTH = 0.00001;
var MAXIMUM_CAP_ANGLE_STEP = Math.PI / 18;
var CAP_CARRIER_TYPES = new Set([
  "driving",
  "biking",
  "parking",
  "restricted",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "shared",
  "bus",
  "stop",
  "sidewalk"
]);
var ORDINARY_TRANSPORT_TYPES = new Set([
  "driving",
  "biking",
  "parking",
  "restricted",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "shared",
  "bus"
]);
function buildLooseRoadEndCaps(network, physicalTopology, patches, boundaries) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const sections = new Map(network.roads.flatMap((road) => road.laneSections.map((section) => [
    `${road.id}|${section.id}`,
    section
  ])));
  const patchesById = new Map(patches.map((patch) => [patch.id, patch]));
  const boundariesById = new Map(boundaries.map((boundary) => [boundary.id, boundary]));
  const topologySections = new Map(physicalTopology.corridors.flatMap((corridor) => corridor.sections.map((section) => [
    `${corridor.roadId}|${section.sectionId}`,
    section
  ])));
  return resolveLooseRoadEndCaps(network, physicalTopology).flatMap((cap) => {
    const road = roads.get(cap.roadId);
    const sourceSection = sections.get(`${cap.roadId}|${cap.sectionId}`);
    const topologySection = topologySections.get(`${cap.roadId}|${cap.sectionId}`);
    if (!road || !sourceSection || !topologySection)
      return [];
    return buildEndpointCaps(road, topologySection, cap, patchesById, boundariesById);
  });
}
function resolveLooseRoadEndCaps(network, physicalTopology) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  return physicalTopology.corridors.flatMap((corridor) => {
    const road = roads.get(corridor.roadId);
    if (!road || road.kind === "connector" || corridor.roadKind === "connector" || corridor.junctionId)
      return [];
    const orderedSections = [...corridor.sections].sort((left, right) => left.sStart - right.sStart);
    const candidates = [
      { section: orderedSections[0], endpoint: "start" },
      { section: orderedSections.at(-1), endpoint: "end" }
    ];
    return candidates.flatMap(({ section, endpoint }) => {
      if (!section)
        return [];
      const sourceSection = road.laneSections.find((candidate) => candidate.id === section.sectionId);
      if (!sourceSection || !endpointIsEligible(network, physicalTopology, road, sourceSection, section, endpoint))
        return [];
      const sectionS = endpoint === "start" ? 0 : road.length - sourceSection.s;
      const offsets = section.boundaries.map((boundary) => laneBoundaryOffsetAt4(sourceSection, boundary.ordinal, sectionS));
      if (offsets.length < 2)
        return [];
      const minimumT = Math.min(...offsets);
      const maximumT = Math.max(...offsets);
      const radius = (maximumT - minimumT) * 0.5;
      if (radius <= MINIMUM_CAP_WIDTH)
        return [];
      const station = endpoint === "start" ? 0 : road.length;
      const pose = evaluateRoadReference(road, station);
      const outwardSign = endpoint === "start" ? -1 : 1;
      return [{
        roadId: road.id,
        sectionId: section.sectionId,
        endpoint,
        station,
        centerT: (minimumT + maximumT) * 0.5,
        radius,
        outwardHeading: pose.heading + (endpoint === "start" ? Math.PI : 0),
        outwardGrade: gradeAt2(road.elevation, station) * outwardSign
      }];
    });
  });
}
function sampleLooseRoadEndCap(cap, startT, endT) {
  const startAngle = capAngle(startT, cap.centerT, cap.radius);
  const endAngle = capAngle(endT, cap.centerT, cap.radius);
  const crossesFront = startAngle * endAngle < 0;
  const stops = crossesFront ? [startAngle, 0, endAngle] : [startAngle, endAngle];
  const angles = stops.slice(0, -1).flatMap((from, stopIndex) => {
    const to = stops[stopIndex + 1];
    const segmentCount = Math.max(2, Math.ceil(Math.abs(to - from) / MAXIMUM_CAP_ANGLE_STEP));
    return Array.from({ length: segmentCount + 1 }, (_, index) => from + (to - from) * index / segmentCount).slice(stopIndex === 0 ? 0 : 1);
  });
  return angles.map((angle) => {
    return {
      t: cap.centerT + Math.sin(angle) * cap.radius,
      depth: Math.max(0, Math.cos(angle) * cap.radius)
    };
  });
}
function buildEndpointCaps(road, topologySection, cap, patchesById, boundariesById) {
  const endpoint = cap.endpoint;
  const bands = topologySection.bands.filter((band) => band.surfaceOwner.kind === "road");
  const outward = {
    x: Math.cos(cap.outwardHeading),
    y: Math.sin(cap.outwardHeading),
    z: cap.outwardGrade
  };
  return bands.flatMap((band) => {
    const sourcePatch = patchesById.get(band.id);
    if (!sourcePatch)
      return [];
    const left = endpointSample(boundariesById.get(band.leftBoundaryId), endpoint);
    const right = endpointSample(boundariesById.get(band.rightBoundaryId), endpoint);
    if (!left || !right || Math.abs(left.lateralOffset - right.lateralOffset) <= MINIMUM_CAP_WIDTH)
      return [];
    const component = capComponent(left, right, cap, outward);
    if (component.outer.length < 3)
      return [];
    return [{
      ...sourcePatch,
      id: `${sourcePatch.id}|loose-cap:${endpoint}`,
      surfaceCutoutOwnerIds: undefined,
      components: [component]
    }];
  });
}
function endpointIsEligible(network, physicalTopology, road, sourceSection, topologySection, endpoint) {
  if (endpointHasLocalLink(road, sourceSection, endpoint))
    return false;
  if (endpointHasJunctionContact(network, physicalTopology, road, endpoint))
    return false;
  if (structureReachesEndpoint(physicalTopology, road, endpoint))
    return false;
  const sectionS = endpoint === "start" ? 0 : road.length - sourceSection.s;
  const positiveBands = topologySection.bands.filter((band) => {
    if (band.surfaceOwner.kind !== "road")
      return false;
    const lane = sourceSection.lanes.find((candidate) => candidate.id === band.laneId);
    return lane && laneWidthAt(lane, sectionS) > MINIMUM_CAP_WIDTH;
  });
  if (!positiveBands.some((band) => CAP_CARRIER_TYPES.has(band.laneType)))
    return false;
  const hasModalTrack = positiveBands.some((band) => band.laneType === "rail" || band.laneType === "tram");
  const hasOrdinaryTransport = positiveBands.some((band) => ORDINARY_TRANSPORT_TYPES.has(band.laneType));
  return !hasModalTrack || hasOrdinaryTransport;
}
function endpointHasLocalLink(road, section, endpoint) {
  const roadLinks = endpoint === "start" ? road.links?.predecessors : road.links?.successors;
  if (roadLinks && roadLinks.length > 0)
    return true;
  return section.lanes.some((lane) => lane.id !== 0 && Boolean(endpoint === "start" ? lane.links?.predecessor : lane.links?.successor));
}
function endpointHasJunctionContact(network, physicalTopology, road, endpoint) {
  const station = endpoint === "start" ? 0 : road.length;
  for (const junction of network.junctions) {
    if ((junction.ports ?? []).some((port) => port.roadId === road.id && contactReachesEndpoint(port.s, port.contactPoint, station, road.length))) {
      return true;
    }
    for (const connection of junction.connections) {
      if (connection.incomingRoadId === road.id && contactReachesEndpoint(connection.incomingS, connection.incomingContactPoint ?? "end", station, road.length))
        return true;
      if (connection.connectingRoadId === road.id && contactReachesEndpoint(connection.connectingS, connection.contactPoint, station, road.length))
        return true;
    }
  }
  return physicalTopology.junctions.some((junction) => [
    ...junction.movements,
    ...junction.laneContinuations,
    ...junction.directLaneLinks
  ].some((movement) => [movement.from, movement.to].some((contact) => contact.roadId === road.id && Math.abs(contact.s - station) <= ENDPOINT_TOLERANCE)));
}
function contactReachesEndpoint(explicitS, contactPoint, endpointStation, roadLength) {
  const station = explicitS ?? (contactPoint === "start" ? 0 : roadLength);
  return Math.abs(station - endpointStation) <= ENDPOINT_TOLERANCE;
}
function structureReachesEndpoint(physicalTopology, road, endpoint) {
  return physicalTopology.roadStructures.some((structure) => {
    if (structure.roadId !== road.id)
      return false;
    return endpoint === "start" ? structure.sStart <= STRUCTURE_REACH_TOLERANCE : structure.sEnd >= road.length - STRUCTURE_REACH_TOLERANCE;
  });
}
function endpointSample(boundary, endpoint) {
  return endpoint === "start" ? boundary?.samples[0] : boundary?.samples.at(-1);
}
function capComponent(left, right, cap, outward) {
  const lowerT = Math.min(left.lateralOffset, right.lateralOffset);
  const upperT = Math.max(left.lateralOffset, right.lateralOffset);
  const lower = left.lateralOffset <= right.lateralOffset ? left : right;
  const upper = left.lateralOffset <= right.lateralOffset ? right : left;
  const startT = cap.endpoint === "end" ? lowerT : upperT;
  const endT = cap.endpoint === "end" ? upperT : lowerT;
  const startBase = cap.endpoint === "end" ? lower.position : upper.position;
  const endBase = cap.endpoint === "end" ? upper.position : lower.position;
  const arc = sampleLooseRoadEndCap(cap, startT, endT).map(({ t, depth }) => {
    const base = interpolateEndpoint(left, right, t);
    return {
      x: base.x + outward.x * depth,
      y: base.y + outward.y * depth,
      z: base.z + outward.z * depth
    };
  });
  return { outer: removeAdjacentDuplicates([startBase, ...arc, endBase]), holes: [] };
}
function capAngle(t, centerT, radius) {
  return Math.asin(Math.max(-1, Math.min(1, (t - centerT) / radius)));
}
function interpolateEndpoint(left, right, t) {
  const span = left.lateralOffset - right.lateralOffset;
  const ratio = Math.abs(span) <= MINIMUM_CAP_WIDTH ? 0.5 : (t - right.lateralOffset) / span;
  return {
    x: right.position.x + (left.position.x - right.position.x) * ratio,
    y: right.position.y + (left.position.y - right.position.y) * ratio,
    z: right.position.z + (left.position.z - right.position.z) * ratio
  };
}
function removeAdjacentDuplicates(points) {
  const result = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) > 0.00000001) {
      result.push(point);
    }
  }
  if (result.length > 1) {
    const first = result[0];
    const last = result.at(-1);
    if (Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) <= 0.00000001)
      result.pop();
  }
  return result;
}

// surface-polygon-classification.ts
function isStrictlyConvexCounterClockwise(points) {
  if (points.length < 3)
    return false;
  const scale = polygonScale(points);
  const epsilon = scale * scale * 0.0000000001;
  for (let index = 0;index < points.length; index++) {
    const previous = points[(index + points.length - 1) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross2 = planCross(previous, current, next);
    if (!Number.isFinite(cross2) || cross2 <= epsilon)
      return false;
  }
  return true;
}
function isEffectivelyPlanar(points) {
  if (points.length <= 3)
    return true;
  const plane = surfacePlane(points);
  if (!plane)
    return false;
  const scale = polygonScale(points);
  const tolerance = Math.max(0.0005, scale * 0.0000001);
  return points.every((point) => Math.abs(point.z - plane.heightAt(point)) <= tolerance);
}
function polygonScale(points) {
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minimumX = Math.min(minimumX, point.x);
    maximumX = Math.max(maximumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumY = Math.max(maximumY, point.y);
  }
  return Math.max(maximumX - minimumX, maximumY - minimumY, 1);
}
function surfacePlane(points) {
  const origin = points[0];
  if (!origin)
    return;
  const first = points.reduce((farthest, point) => planDistanceSquared(origin, point) > planDistanceSquared(origin, farthest) ? point : farthest);
  const second = points.reduce((widest, point) => Math.abs(planCross(origin, first, point)) > Math.abs(planCross(origin, first, widest)) ? point : widest);
  const determinant = planCross(origin, first, second);
  const scale = polygonScale(points);
  if (Math.abs(determinant) <= scale * scale * 0.000000000001)
    return;
  const firstHeight = first.z - origin.z;
  const secondHeight = second.z - origin.z;
  const firstX = first.x - origin.x;
  const firstY = first.y - origin.y;
  const secondX = second.x - origin.x;
  const secondY = second.y - origin.y;
  const gradeX = (firstHeight * secondY - firstY * secondHeight) / determinant;
  const gradeY = (firstX * secondHeight - firstHeight * secondX) / determinant;
  return {
    heightAt: (point) => origin.z + gradeX * (point.x - origin.x) + gradeY * (point.y - origin.y)
  };
}
function planDistanceSquared(left, right) {
  return (right.x - left.x) ** 2 + (right.y - left.y) ** 2;
}
function planCross(origin, left, right) {
  return (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
}

// junction-surface-ring-sampling.ts
var DEFAULT_MAX_SEGMENT_LENGTH = 5;
var MAX_EDGE_SEGMENTS = 256;
var MAX_COMPONENT_VERTICES = 512;
function sampleJunctionSurfaceComponent(component, elevationAt, maxSegmentLength) {
  const rings = [component.outer, ...component.holes];
  const originalRings = rings.map((ring) => ring.map(elevationAt));
  const planarityProbes = rings.flatMap((ring, ringIndex) => ring.flatMap((start, pointIndex) => {
    const end = ring[(pointIndex + 1) % ring.length];
    const original = originalRings[ringIndex]?.[pointIndex];
    if (!end || !original)
      return [];
    return [
      original,
      elevationAt({ x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5 })
    ];
  }));
  if (isEffectivelyPlanar(planarityProbes)) {
    return {
      outer: originalRings[0] ?? [],
      holes: originalRings.slice(1)
    };
  }
  const edgeRings = allocateSamplingBudget(rings, maxSegmentLength, MAX_COMPONENT_VERTICES);
  const sampledRings = edgeRings.map((edges, index) => sampleRing(edges, originalRings[index] ?? [], elevationAt));
  if (isEffectivelyPlanar(sampledRings.flatMap(({ samples }) => samples))) {
    return {
      outer: sampledRings[0]?.originals ?? [],
      holes: sampledRings.slice(1).map(({ originals }) => originals)
    };
  }
  return {
    outer: sampledRings[0]?.samples ?? [],
    holes: sampledRings.slice(1).map(({ samples }) => samples)
  };
}
function sampleRing(edges, originals, elevationAt) {
  const samples = edges.flatMap((edge, edgeIndex) => Array.from({ length: edge.segments }, (_, segmentIndex) => {
    if (segmentIndex === 0)
      return originals[edgeIndex] ?? elevationAt(edge.start);
    const ratio = segmentIndex / edge.segments;
    return elevationAt({
      x: edge.start.x + (edge.end.x - edge.start.x) * ratio,
      y: edge.start.y + (edge.end.y - edge.start.y) * ratio
    });
  }));
  return { samples, originals };
}
function allocateSamplingBudget(rings, requestedMaxSegmentLength, vertexBudget) {
  const maxSegmentLength = Number.isFinite(requestedMaxSegmentLength) && requestedMaxSegmentLength > 0.000001 ? requestedMaxSegmentLength : DEFAULT_MAX_SEGMENT_LENGTH;
  const edgeRings = rings.map((ring) => ring.map((start, index) => {
    const end = ring[(index + 1) % ring.length];
    const length2 = Math.hypot(end.x - start.x, end.y - start.y);
    const requestedSegments = Math.min(MAX_EDGE_SEGMENTS, Math.max(1, Math.ceil(length2 / maxSegmentLength)));
    return { start, end, requestedSegments, segments: 1 };
  }));
  const edges = edgeRings.flat();
  const availableExtras = Math.max(0, vertexBudget - edges.length);
  const desiredExtras = edges.reduce((sum, edge) => sum + edge.requestedSegments - 1, 0);
  if (desiredExtras <= availableExtras) {
    for (const edge of edges)
      edge.segments = edge.requestedSegments;
    return edgeRings;
  }
  if (desiredExtras === 0 || availableExtras === 0)
    return edgeRings;
  const allocations = edges.map((edge, index) => {
    const desired = edge.requestedSegments - 1;
    const exact = desired * availableExtras / desiredExtras;
    const extras = Math.min(desired, Math.floor(exact));
    edge.segments += extras;
    return { edge, index, desired, remainder: exact - extras };
  });
  let remaining = availableExtras - allocations.reduce((sum, item) => sum + item.edge.segments - 1, 0);
  allocations.sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  while (remaining > 0) {
    let progressed = false;
    for (const allocation of allocations) {
      if (remaining === 0)
        break;
      if (allocation.edge.segments - 1 >= allocation.desired)
        continue;
      allocation.edge.segments += 1;
      remaining -= 1;
      progressed = true;
    }
    if (!progressed)
      break;
  }
  return edgeRings;
}

// build-road-surface-model.ts
var DEFAULT_OPTIONS = {
  maxSegmentLength: 5,
  maxChordError: 0.01,
  maxProfileError: 0.002,
  maxDepth: 20,
  markingHeight: 0.003,
  dashLength: 3,
  dashGap: 3,
  junctionTessellationStep: 1
};
function buildRoadSurfaceModel(network, physicalTopology, options = {}) {
  const profileStart = performance.now();
  let profilePrevious = profileStart;
  const profile = (stage) => {
    if (network.id !== "connected-edit-grid" || !options.renderOwnerIds)
      return;
    const now = performance.now();
    console.info(`[road-surface-stage] ${stage} ${Math.round(now - profilePrevious)}`);
    profilePrevious = now;
  };
  const { renderOwnerIds, ...surfaceOptions } = options;
  const resolved = { ...DEFAULT_OPTIONS, ...surfaceOptions };
  const selectedOwners = renderOwnerIds ? new Set(renderOwnerIds) : undefined;
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const connectorIntervalCounts = junctionConnectorIntervalCounts(network, physicalTopology, resolved.junctionTessellationStep);
  const boundaries = [];
  const markings = [];
  let stationTime = 0;
  let boundaryTime = 0;
  let boundaryMarkingTime = 0;
  let roadMarkingTime = 0;
  const pendingPatches = physicalTopology.corridors.flatMap((corridor) => {
    const road = roads.get(corridor.roadId);
    if (!road)
      throw new Error(`Physical corridor ${corridor.roadId} has no road`);
    if (selectedOwners && !selectedOwners.has(roadRenderOwnerId(road)))
      return [];
    const raisedOffsetAt = roadRaisedOffsetEvaluator(network, road);
    return corridor.sections.flatMap((topologySection) => {
      const ordinaryBands = topologySection.bands.filter((band) => band.surfaceOwner.kind === "road");
      const section = road.laneSections.find((candidate) => candidate.id === topologySection.sectionId);
      if (!section)
        throw new Error(`Physical section ${topologySection.sectionId} has no lane section`);
      const ordinals = topologySection.boundaries.map((boundary) => boundary.ordinal);
      const forced = forcedStations(network, road, section);
      let stageStart = performance.now();
      const stations = road.kind === "connector" ? sampleConnectorStations(topologySection.sStart, topologySection.sEnd, resolved.junctionTessellationStep, forced, road.junctionId ? connectorIntervalCounts.get(road.junctionId) : undefined) : sampleCorridorStations(road, section, topologySection.sStart, topologySection.sEnd, forced, (s) => ordinals.map((ordinal) => raisedBoundaryPointAt(road, section, ordinal, s, raisedOffsetAt)), resolved);
      stationTime += performance.now() - stageStart;
      stageStart = performance.now();
      const sectionBoundaries = topologySection.boundaries.map((boundary) => makeBoundary(road, section, boundary, stations, corridor.contacts, raisedOffsetAt));
      boundaryTime += performance.now() - stageStart;
      boundaries.push(...sectionBoundaries);
      const renderOwnerId = roadRenderOwnerId(road);
      stageStart = performance.now();
      const boundaryMarkings = buildBoundaryMarkings(road, topologySection, new Map(sectionBoundaries.map((item) => [item.id, item])), resolved, road.kind === "connector" && !road.shapes?.length && !road.crossfall?.length && section.lanes.every((lane) => lane.level !== true)).map((marking) => ({ ...marking, ownerId: renderOwnerId }));
      boundaryMarkingTime += performance.now() - stageStart;
      markings.push(...boundaryMarkings);
      stageStart = performance.now();
      const roadMarkings = (road.markings ?? []).flatMap((marking) => makeRoadMarking(road, section, topologySection.sStart, topologySection.sEnd, marking, stations, resolved, raisedOffsetAt)).map((marking) => ({ ...marking, ownerId: renderOwnerId }));
      roadMarkingTime += performance.now() - stageStart;
      markings.push(...roadMarkings);
      return ordinaryBands.map((band) => ({
        id: band.id,
        ownerId: band.surfaceOwner.id,
        roadId: band.roadId,
        sectionId: band.sectionId,
        laneId: band.laneId,
        laneType: band.laneType,
        leftBoundaryId: band.leftBoundaryId,
        rightBoundaryId: band.rightBoundaryId,
        materialClass: materialClassForLane(band.laneType, band.surface),
        surfaceCutoutOwnerIds: structuredClone(band.surfaceCutoutOwnerIds)
      }));
    });
  });
  if (network.id === "connected-edit-grid" && options.renderOwnerIds) {
    console.info(`[road-surface-corridor-detail] stations ${Math.round(stationTime)} boundaries ${Math.round(boundaryTime)} boundary-markings ${Math.round(boundaryMarkingTime)} road-markings ${Math.round(roadMarkingTime)}`);
  }
  profile("corridors");
  const junctionPatches = buildJunctionPatches(network, physicalTopology, boundaries, resolved.maxSegmentLength, resolved.junctionTessellationStep, selectedOwners, junctionBandSamples(physicalTopology, boundaries));
  profile("junctions");
  const boundariesById = new Map(boundaries.map((boundary) => [boundary.id, boundary]));
  const junctionPatchesByOwner = groupJunctionPatchesByOwner(junctionPatches);
  const corridorPatches = pendingPatches.map((patch) => {
    const clipPatches = (patch.surfaceCutoutOwnerIds ?? []).flatMap((ownerId) => junctionPatchesByOwner.get(ownerId) ?? []);
    const patchBoundaries = [patch.leftBoundaryId, patch.rightBoundaryId].flatMap((boundaryId) => {
      const boundary = boundariesById.get(boundaryId);
      return boundary ? [boundary] : [];
    });
    return clipRoadSurfacePatch(patch, patchBoundaries, clipPatches);
  });
  const patches = [
    ...corridorPatches,
    ...buildLooseRoadEndCaps(network, physicalTopology, corridorPatches, boundaries)
  ];
  profile("clips");
  const decals = [
    ...buildRoadPatternDecals(network, resolved.markingHeight, selectedOwners),
    ...network.roads.filter((road) => (!selectedOwners || selectedOwners.has(roadRenderOwnerId(road))) && road.markings?.some(({ kind }) => kind === "arrow")).flatMap((road) => buildArrowDecals(road, resolved.markingHeight, roadRaisedOffsetEvaluator(network, road)).map((decal) => ({ ...decal, ownerId: roadRenderOwnerId(road) }))),
    ...network.junctions.filter((junction) => (!selectedOwners || selectedOwners.has(junction.id)) && junction.areaMarkings?.length).flatMap((junction) => buildJunctionAreaDecals(junction, junctionSurfacePoints(junctionPatchesByOwner.get(junction.id) ?? []), resolved.markingHeight))
  ];
  profile("decals");
  return {
    networkId: network.id,
    patches,
    junctionPatches,
    boundaries,
    markings,
    decals,
    sharedContacts: physicalTopology.corridors.filter((corridor) => {
      const road = roads.get(corridor.roadId);
      return road && (!selectedOwners || selectedOwners.has(roadRenderOwnerId(road)));
    }).flatMap((corridor) => corridor.contacts.flatMap((contact) => contact.nodes.map((node) => ({
      id: node.id,
      upstreamBoundaryIds: node.upstreamBoundaryIds,
      downstreamBoundaryIds: node.downstreamBoundaryIds
    }))))
  };
}
function sampleConnectorStations(start, end, step, forced, sharedIntervalCount) {
  const intervalCount = Math.max(1, sharedIntervalCount ?? 0, Math.ceil((end - start) / step));
  return uniqueSortedStations([
    ...Array.from({ length: intervalCount + 1 }, (_, index) => start + (end - start) * index / intervalCount),
    ...forced.filter((station) => station >= start && station <= end)
  ]);
}
function junctionConnectorIntervalCounts(network, physicalTopology, step) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const counts = new Map;
  for (const corridor of physicalTopology.corridors) {
    const road = roads.get(corridor.roadId);
    if (road?.kind !== "connector" || !road.junctionId)
      continue;
    for (const section of corridor.sections) {
      const count = Math.max(1, Math.ceil((section.sEnd - section.sStart) / step));
      counts.set(road.junctionId, Math.max(counts.get(road.junctionId) ?? 0, count));
    }
  }
  return counts;
}
function junctionElevationBoundaries(roadIds, networkRoads, boundariesByRoadId, allBoundaries) {
  if (!roadIds)
    return allBoundaries;
  const connectors = [];
  const approaches = [];
  for (const roadId of roadIds) {
    const road = networkRoads.get(roadId);
    if (!road)
      continue;
    const target = road.kind === "connector" || road.junctionId ? connectors : approaches;
    target.push(...boundariesByRoadId.get(roadId) ?? []);
  }
  const resolved = [...connectors, ...approaches];
  return resolved.length > 0 ? resolved : allBoundaries;
}
function buildJunctionPatches(network, physicalTopology, boundaries, maxSegmentLength, junctionTessellationStep, selectedOwners, bandSamples) {
  const selectedJunctions = network.junctions.filter((junction) => !selectedOwners || selectedOwners.has(junction.id));
  const tessellation = tessellateJunctionPhysicalTopology(network, physicalTopology, {
    step: junctionTessellationStep,
    junctionIds: selectedOwners ? selectedJunctions.map((junction) => junction.id) : undefined,
    bandSamples
  });
  const junctionRoadIds = new Map(physicalTopology.junctions.map((junction) => [
    junction.junctionId,
    new Set(junction.roadIds)
  ]));
  const networkRoads = new Map(network.roads.map((road) => [road.id, road]));
  const boundariesByRoadId = new Map;
  for (const boundary of boundaries) {
    const values = boundariesByRoadId.get(boundary.roadId);
    if (values)
      values.push(boundary);
    else
      boundariesByRoadId.set(boundary.roadId, [boundary]);
  }
  return tessellation.assemblySurfaces.flatMap((assembly) => {
    const roadIds = junctionRoadIds.get(assembly.junctionId);
    const elevationAt = junctionSurfaceElevationSampler(junctionElevationBoundaries(roadIds, networkRoads, boundariesByRoadId, boundaries));
    const typed = assembly.laneTypeSurfaces.length > 0 ? assembly.laneTypeSurfaces : [{ laneType: "driving", components: assembly.components }];
    return typed.flatMap((surface, index) => {
      if (surface.components.length === 0)
        return [];
      return [{
        id: `junction-surface|${assembly.junctionId}|${surface.laneType}|${index}`,
        ownerId: assembly.junctionId,
        laneType: surface.laneType,
        materialClass: materialClassForLane(surface.laneType, surface.surface),
        components: surface.components.map((component) => sampleJunctionSurfaceComponent(component, elevationAt, maxSegmentLength))
      }];
    });
  });
}
function junctionBandSamples(physicalTopology, boundaries) {
  const boundariesById = new Map(boundaries.map((boundary) => [boundary.id, boundary]));
  const result = new Map;
  for (const corridor of physicalTopology.corridors) {
    for (const section of corridor.sections) {
      for (const band of section.bands) {
        if (band.surfaceOwner.kind !== "junction")
          continue;
        const left = boundariesById.get(band.leftBoundaryId)?.samples;
        const right = boundariesById.get(band.rightBoundaryId)?.samples;
        if (!left || !right || left.length !== right.length)
          continue;
        result.set(band.id, {
          polygon: [
            ...left.map(({ position }) => ({ x: position.x, y: position.y })),
            ...[...right].reverse().map(({ position }) => ({
              x: position.x,
              y: position.y
            }))
          ],
          centerline: left.map(({ position }, index) => {
            const opposite = right[index].position;
            return {
              x: (position.x + opposite.x) * 0.5,
              y: (position.y + opposite.y) * 0.5
            };
          })
        });
      }
    }
  }
  return result;
}
function groupJunctionPatchesByOwner(patches) {
  const result = new Map;
  for (const patch of patches) {
    const values = result.get(patch.ownerId);
    if (values)
      values.push(patch);
    else
      result.set(patch.ownerId, [patch]);
  }
  return result;
}
function junctionSurfacePoints(patches) {
  return patches.flatMap(({ components }) => components.flatMap(({ outer, holes }) => [outer, ...holes].flat()));
}
function makeBoundary(road, section, boundary, stations, contacts, raisedOffsetAt) {
  return {
    id: boundary.id,
    roadId: road.id,
    sectionId: section.id,
    ordinal: boundary.ordinal,
    samples: stations.map((s) => {
      const position = raisedBoundaryPointAt(road, section, boundary.ordinal, s, raisedOffsetAt);
      return { s, lateralOffset: laneBoundaryOffsetAt5(section, boundary.ordinal, s - section.s), position };
    }),
    startContactId: contactIdForBoundary(contacts, boundary.id, "downstream"),
    endContactId: contactIdForBoundary(contacts, boundary.id, "upstream")
  };
}
function contactIdForBoundary(contacts, boundaryId, side) {
  for (const contact of contacts) {
    const node = contact.nodes.find((candidate) => (side === "upstream" ? candidate.upstreamBoundaryIds : candidate.downstreamBoundaryIds).includes(boundaryId));
    if (node)
      return node.id;
  }
  return;
}
function makeRoadMarking(road, section, sectionStart, sectionEnd, marking, sharedStations, options, raisedOffsetAt) {
  if (marking.kind === "none" || marking.kind === "arrow" || marking.kind === "zebra" || marking.color === "none")
    return [];
  const sourceStart = Math.min(marking.sStart, marking.sEnd);
  const sourceEnd = Math.max(marking.sStart, marking.sEnd);
  const transverse = sourceEnd - sourceStart <= 0.0000001;
  const width = marking.width ?? 0.12;
  const start = Math.max(sectionStart, transverse ? sourceStart - width * 0.5 : sourceStart);
  const end = Math.min(sectionEnd, transverse ? sourceEnd + width * 0.5 : sourceEnd);
  if (end - start <= 0.0000001)
    return [];
  const stations = transverse ? [start, end] : clippedStations(sharedStations, start, end);
  const lateralStart = marking.tStart ?? marking.tOffset - width * 0.5;
  const lateralEnd = marking.tEnd ?? marking.tOffset + width * 0.5;
  const samples = (edge) => stations.map((s) => {
    const ratio = sourceEnd - sourceStart > 0.0000001 ? (s - sourceStart) / (sourceEnd - sourceStart) : 0;
    const initial = edge === "left" ? lateralStart : lateralEnd;
    const final = edge === "left" ? marking.tStartAtEnd ?? initial : marking.tEndAtEnd ?? initial;
    const lateralOffset = initial + (final - initial) * Math.max(0, Math.min(1, ratio));
    return {
      s,
      lateralOffset,
      position: surfacePointAt(road, section, s, lateralOffset, options.markingHeight + raisedOffsetAt(s))
    };
  });
  return [{
    id: `${marking.id}|${section.id}`,
    sourceId: marking.id,
    ownerId: road.id,
    kind: marking.kind,
    color: marking.color ?? "white",
    width,
    left: samples("left"),
    right: samples("right")
  }];
}
function forcedStations(network, road, section) {
  return [
    ...road.referenceLine.geometry.map((record) => record.s),
    ...(road.elevation ?? []).map((record) => record.s),
    ...(road.superelevation ?? []).map((record) => record.s),
    ...(road.laneOffsets ?? []).map((record) => record.s),
    ...section.lanes.flatMap((lane) => lane.widths.map((width) => section.s + width.sOffset)),
    ...section.lanes.flatMap((lane) => (lane.heights ?? []).map((height) => section.s + height.sOffset)),
    ...section.lanes.flatMap((lane) => (lane.markings ?? []).flatMap((marking) => [marking.sStart, marking.sEnd])),
    ...(road.markings ?? []).flatMap((marking) => [marking.sStart, marking.sEnd]),
    ...raisedTableStations(network, road)
  ].filter((station) => station !== undefined);
}
function raisedTableStations(network, road) {
  return [
    ...network.junctions.flatMap((junction) => {
      const elevation = junction.surfaceElevation;
      if (!elevation)
        return [];
      return (junction.ports ?? []).flatMap((port) => {
        if (port.roadId !== road.id)
          return [];
        const contact = port.s ?? (port.contactPoint === "start" ? 0 : road.length);
        return [
          contact,
          Math.max(0, contact - elevation.rampLength),
          Math.max(0, contact - elevation.rampLength * 0.5),
          Math.min(road.length, contact + elevation.rampLength * 0.5),
          Math.min(road.length, contact + elevation.rampLength)
        ];
      });
    }),
    ...roadSurfaceElevations(network).flatMap((elevation) => {
      if (elevation.roadId !== road.id || elevation.kind !== "raised-table")
        return [];
      return [
        elevation.sStart - elevation.rampLength,
        elevation.sStart,
        elevation.sEnd,
        elevation.sEnd + elevation.rampLength
      ].map((station) => Math.max(0, Math.min(road.length, station)));
    })
  ];
}
function raisedBoundaryPointAt(road, section, ordinal, s, raisedOffsetAt) {
  const position = boundaryPointAt(road, section, ordinal, s);
  position.z += raisedOffsetAt(s);
  return position;
}
function roadRaisedOffsetEvaluator(network, road) {
  const junctionElevations = network.junctions.flatMap((junction) => {
    if (!junction.surfaceElevation)
      return [];
    return (junction.ports ?? []).filter((port) => port.roadId === road.id).map((port) => ({
      ...junction.surfaceElevation,
      contact: port.s ?? (port.contactPoint === "start" ? 0 : road.length)
    }));
  });
  const roadElevations = roadSurfaceElevations(network).filter((elevation) => elevation.roadId === road.id && elevation.kind === "raised-table");
  if (junctionElevations.length === 0 && roadElevations.length === 0)
    return () => 0;
  return (s) => {
    let offset = 0;
    for (const elevation of junctionElevations) {
      const ratio = Math.max(0, 1 - Math.abs(s - elevation.contact) / elevation.rampLength);
      const smooth = ratio * ratio * (3 - 2 * ratio);
      offset = Math.max(offset, elevation.height * smooth);
    }
    for (const elevation of roadElevations)
      offset = Math.max(offset, roadRaisedTableOffset(elevation, s));
    return offset;
  };
}
function roadSurfaceElevations(network) {
  return network.roadSurfaceElevations ?? [];
}
function roadRaisedTableOffset(elevation, s) {
  if (s < elevation.sStart) {
    return elevation.height * smoothstepRatio(s, elevation.sStart - elevation.rampLength, elevation.sStart);
  }
  if (s <= elevation.sEnd)
    return elevation.height;
  return elevation.height * (1 - smoothstepRatio(s, elevation.sEnd, elevation.sEnd + elevation.rampLength));
}
function smoothstepRatio(value, start, end) {
  if (end - start <= 0.000000001)
    return value >= end ? 1 : 0;
  const ratio = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return ratio * ratio * (3 - 2 * ratio);
}
function clippedStations(stations, start, end) {
  return [...new Set([start, ...stations.filter((station) => station > start && station < end), end])].sort((a, b) => a - b);
}
function materialClassForLane(laneType, surface) {
  if (surface)
    return surfaceMaterialClass(surface);
  if (laneType === "sidewalk")
    return "sidewalk";
  if (laneType === "biking")
    return "cycleway";
  if (laneType === "median")
    return "median";
  if (laneType === "shoulder" || laneType === "border")
    return "shoulder";
  if (laneType === "rail")
    return "rail-bed";
  return "road";
}
function surfaceMaterialClass(surface) {
  if (surface === "asphalt")
    return "road";
  if (surface === "platform")
    return "platform";
  return surface;
}
// mesh-builder.ts
class MeshBuilder {
  positions = [];
  uvs = [];
  indices = [];
  normals = [];
  ranges = [];
  vertices = new Map;
  addVertex(point, u, v, key) {
    const existing = key === undefined ? undefined : this.vertices.get(key);
    if (existing !== undefined)
      return existing;
    const index = this.positions.length / 3;
    this.positions.push(point.x, point.y, point.z);
    this.uvs.push(u, v);
    this.normals.push(0, 0, 0);
    if (key)
      this.vertices.set(key, index);
    return index;
  }
  addQuad(a, b, c, d) {
    this.addTriangle(a, b, c);
    this.addTriangle(a, c, d);
  }
  startRange() {
    return this.indices.length;
  }
  finishRange(id, ownerId, kind, materialClass, start) {
    if (this.indices.length > start)
      this.ranges.push({ id, ownerId, kind, materialClass, indexStart: start, indexCount: this.indices.length - start });
  }
  build() {
    const normals = Float32Array.from(this.normals);
    for (let i = 0;i < normals.length; i += 3) {
      const m = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
      if (m > 0.000000000000001) {
        normals[i] /= m;
        normals[i + 1] /= m;
        normals[i + 2] /= m;
      }
    }
    const materialClasses = [...new Set(this.ranges.map((range) => range.materialClass))].sort();
    return {
      positions: Float32Array.from(this.positions),
      normals,
      uvs: Float32Array.from(this.uvs),
      indices: this.positions.length / 3 <= 65535 ? Uint16Array.from(this.indices) : Uint32Array.from(this.indices),
      semanticRanges: this.ranges,
      materialGroups: materialClasses.map((materialClass) => ({
        materialClass,
        rangeIndices: this.ranges.flatMap((range, index) => range.materialClass === materialClass ? [index] : [])
      }))
    };
  }
  addTriangle(a, b, c) {
    this.indices.push(a, b, c);
    const p = this.positions;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const abx = p[b * 3] - ax, aby = p[b * 3 + 1] - ay, abz = p[b * 3 + 2] - az;
    const acx = p[c * 3] - ax, acy = p[c * 3 + 1] - ay, acz = p[c * 3 + 2] - az;
    const n = [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
    for (const i of [a, b, c])
      for (let k = 0;k < 3; k++)
        this.normals[i * 3 + k] = this.normals[i * 3 + k] + n[k];
  }
}

// mesh-road-surface-model.ts
import { triangulateCDT } from "./cdt/index.js";

// simple-polygon-triangulation.ts
function triangulateSimplePolygon(points) {
  if (points.length < 3)
    return [];
  const orientation = signedAreaTwice(points) < 0 ? -1 : 1;
  const scale = polygonScale2(points);
  const epsilon = scale * scale * 0.000000000001;
  const remaining = simplifiedRingIndices(points, epsilon);
  if (remaining.length < 3)
    return;
  const triangles = [];
  let guard = 0;
  while (remaining.length > 3 && guard++ < points.length * points.length) {
    let clipped = false;
    for (let cursor = 0;cursor < remaining.length; cursor++) {
      const previous = remaining[(cursor - 1 + remaining.length) % remaining.length];
      const current = remaining[cursor];
      const next = remaining[(cursor + 1) % remaining.length];
      const area = triangleAreaTwice(points[previous], points[current], points[next]);
      if (orientation * area <= epsilon)
        continue;
      if (remaining.some((index) => index !== previous && index !== current && index !== next && strictlyInsideTriangle(points[index], points[previous], points[current], points[next], orientation, epsilon)))
        continue;
      triangles.push(orientation > 0 ? [previous, current, next] : [previous, next, current]);
      remaining.splice(cursor, 1);
      clipped = true;
      break;
    }
    if (!clipped)
      return;
  }
  if (remaining.length === 3) {
    const area = triangleAreaTwice(points[remaining[0]], points[remaining[1]], points[remaining[2]]);
    if (Math.abs(area) > epsilon) {
      triangles.push(orientation > 0 ? [remaining[0], remaining[1], remaining[2]] : [remaining[0], remaining[2], remaining[1]]);
    }
  }
  return triangles.length > 0 ? triangles : undefined;
}
function simplifiedRingIndices(points, epsilon) {
  const distanceToleranceSquared = epsilon * 0.01;
  let indices = points.map((_, index) => index).filter((index, cursor) => {
    if (cursor === 0)
      return true;
    return distanceSquared(points[index], points[index - 1]) > distanceToleranceSquared;
  });
  if (indices.length > 1 && distanceSquared(points[indices[0]], points[indices.at(-1)]) <= distanceToleranceSquared)
    indices.pop();
  let changed = true;
  while (indices.length > 3 && changed) {
    changed = false;
    indices = indices.filter((current, cursor) => {
      const previous = indices[(cursor - 1 + indices.length) % indices.length];
      const next = indices[(cursor + 1) % indices.length];
      const area = Math.abs(triangleAreaTwice(points[previous], points[current], points[next]));
      if (area > epsilon || !between(points[current], points[previous], points[next])) {
        return true;
      }
      changed = true;
      return false;
    });
  }
  return indices;
}
function between(point, start, end) {
  return (point.x - start.x) * (point.x - end.x) + (point.y - start.y) * (point.y - end.y) <= 0;
}
function distanceSquared(left, right) {
  return (right.x - left.x) ** 2 + (right.y - left.y) ** 2;
}
function strictlyInsideTriangle(point, first, second, third, orientation, epsilon) {
  return orientation * triangleAreaTwice(first, second, point) > epsilon && orientation * triangleAreaTwice(second, third, point) > epsilon && orientation * triangleAreaTwice(third, first, point) > epsilon;
}
function signedAreaTwice(points) {
  let area = 0;
  for (let index = 0;index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area;
}
function triangleAreaTwice(first, second, third) {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}
function polygonScale2(points) {
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minimumX = Math.min(minimumX, point.x);
    maximumX = Math.max(maximumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumY = Math.max(maximumY, point.y);
  }
  return Math.max(maximumX - minimumX, maximumY - minimumY, 1);
}

// mesh-road-surface-model.ts
function meshRoadSurfaceModel(model) {
  const boundaries = new Map(model.boundaries.map((boundary) => [boundary.id, boundary]));
  const surface = new MeshBuilder;
  for (const patch of model.patches) {
    if (patch.components) {
      const start2 = surface.startRange();
      for (const component of patch.components)
        addPolygonComponent(surface, component);
      surface.finishRange(patch.id, patch.ownerId, "surface", patch.materialClass, start2);
      continue;
    }
    const left = required(boundaries, patch.leftBoundaryId, patch.id), right = required(boundaries, patch.rightBoundaryId, patch.id);
    if (left.samples.length !== right.samples.length)
      throw new Error(`Patch ${patch.id} does not share a station grid`);
    const start = surface.startRange();
    for (let i = 0;i < left.samples.length - 1; i++) {
      addStripInterval(surface, right, left, i);
    }
    surface.finishRange(patch.id, patch.ownerId, "surface", patch.materialClass, start);
  }
  for (const patch of model.junctionPatches) {
    const start = surface.startRange();
    for (const component of patch.components)
      addPolygonComponent(surface, component);
    surface.finishRange(patch.id, patch.ownerId, "surface", patch.materialClass, start);
  }
  const markingMesh = new MeshBuilder;
  for (const marking of model.markings) {
    const start = markingMesh.startRange();
    for (let i = 0;i < marking.left.length - 1; i++)
      markingMesh.addQuad(markingVertex(markingMesh, marking.right[i]), markingVertex(markingMesh, marking.right[i + 1]), markingVertex(markingMesh, marking.left[i + 1]), markingVertex(markingMesh, marking.left[i]));
    markingMesh.finishRange(marking.id, marking.ownerId, "marking", `marking-${marking.color}`, start);
  }
  for (const decal of model.decals) {
    const start = markingMesh.startRange();
    addPolygonComponent(markingMesh, { outer: decal.points, holes: [] });
    markingMesh.finishRange(decal.id, decal.ownerId, "marking", `marking-${decal.color}`, start);
  }
  return { surface: surface.build(), markings: markingMesh.build() };
}
function addStripInterval(builder, right, left, index) {
  const startCollapsed = coincident(right.samples[index].position, left.samples[index].position);
  const endCollapsed = coincident(right.samples[index + 1].position, left.samples[index + 1].position);
  if (startCollapsed && endCollapsed)
    return;
  const a = vertex(builder, right, index);
  const b = vertex(builder, right, index + 1);
  const c = vertex(builder, left, index + 1);
  const d = vertex(builder, left, index);
  if (startCollapsed) {
    builder.addTriangle(a, b, c);
  } else if (endCollapsed) {
    builder.addTriangle(a, c, d);
  } else {
    builder.addQuad(a, b, c, d);
  }
}
function coincident(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z) <= 0.00000001;
}
function addPolygonComponent(builder, component) {
  const rings = [component.outer, ...component.holes];
  if (component.holes.length === 0 && isStrictlyConvexCounterClockwise(component.outer) && isEffectivelyPlanar(component.outer)) {
    const vertices2 = component.outer.map((point) => builder.addVertex(point, point.x, point.y));
    for (let index = 1;index < vertices2.length - 1; index++) {
      builder.addTriangle(vertices2[0], vertices2[index], vertices2[index + 1]);
    }
    return;
  }
  if (component.holes.length === 0 && isEffectivelyPlanar(component.outer)) {
    const triangles = triangulateSimplePolygon(component.outer);
    if (triangles) {
      const vertices2 = component.outer.map((point) => builder.addVertex(point, point.x, point.y));
      for (const triangle of triangles) {
        addUpwardTriangle(builder, vertices2, component.outer, triangle[0], triangle[1], triangle[2]);
      }
      return;
    }
  }
  const points = rings.flat();
  const offsets = [];
  let offset = 0;
  for (const ring of rings) {
    offsets.push(offset);
    offset += ring.length;
  }
  const ringIndices = rings.map((ring, index) => ring.map((_, vertex) => offsets[index] + vertex));
  const triangulation = triangulateCDT({
    points: points.map((point) => ({ x: point.x, y: point.y })),
    polygons: [{ outer: ringIndices[0], holes: ringIndices.slice(1) }]
  });
  const vertices = triangulation.points.map((point, index) => {
    const source = triangulation.pointSources[index]?.[0];
    const z = source === undefined ? smoothSurfaceHeight(point, points) : points[source].z;
    return builder.addVertex({ x: point.x, y: point.y, z }, point.x, point.y);
  });
  const scale = polygonScale(triangulation.points);
  const minimumPlanAreaTwice = scale * scale * 0.000000000001;
  for (let index = 0;index < triangulation.triangles.length; index += 3) {
    const a = triangulation.triangles[index];
    const b = triangulation.triangles[index + 1];
    const c = triangulation.triangles[index + 2];
    const planAreaTwice = trianglePlanAreaTwice(triangulation.points[a], triangulation.points[b], triangulation.points[c]);
    if (Math.abs(planAreaTwice) <= minimumPlanAreaTwice)
      continue;
    if (planAreaTwice > 0)
      builder.addTriangle(vertices[a], vertices[b], vertices[c]);
    else
      builder.addTriangle(vertices[a], vertices[c], vertices[b]);
  }
}
function trianglePlanAreaTwice(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function addUpwardTriangle(builder, vertices, points, a, b, c) {
  if (trianglePlanAreaTwice(points[a], points[b], points[c]) > 0) {
    builder.addTriangle(vertices[a], vertices[b], vertices[c]);
  } else {
    builder.addTriangle(vertices[a], vertices[c], vertices[b]);
  }
}
function vertex(builder, boundary, index) {
  const sample = boundary.samples[index];
  const contact = index === 0 ? boundary.startContactId : index === boundary.samples.length - 1 ? boundary.endContactId : undefined;
  const key = contact ? `contact:${contact}|z:${sample.position.z.toFixed(9)}` : `${boundary.id}:${index}`;
  return builder.addVertex(sample.position, sample.s, sample.lateralOffset, key);
}
function markingVertex(builder, sample) {
  return builder.addVertex(sample.position, sample.s, sample.lateralOffset);
}
function required(boundaries, id, patch) {
  const value = boundaries.get(id);
  if (!value)
    throw new Error(`Patch ${patch} references missing boundary ${id}`);
  return value;
}
// mesh-road-chunks.ts
function meshRoadSurfaceChunks(model) {
  const roadOwners = [...new Set(model.patches.map((patch) => patch.ownerId))].sort();
  const roadOwnerSet = new Set(roadOwners);
  const junctionOwners = [...new Set([
    ...model.junctionPatches.map((patch) => patch.ownerId),
    ...model.markings.map((marking) => marking.ownerId).filter((ownerId) => !roadOwnerSet.has(ownerId)),
    ...model.decals.map((decal) => decal.ownerId).filter((ownerId) => !roadOwnerSet.has(ownerId))
  ])].sort();
  const index = indexSurfaceModel(model);
  return [
    ...roadOwners.map((ownerId) => chunk(model, index, ownerId, "road")),
    ...junctionOwners.map((ownerId) => chunk(model, index, ownerId, "junction"))
  ];
}
function indexSurfaceModel(model) {
  return {
    boundariesById: new Map(model.boundaries.map((boundary) => [boundary.id, boundary])),
    decalsByOwner: groupByOwner(model.decals),
    junctionPatchesByOwner: groupByOwner(model.junctionPatches),
    markingsByOwner: groupByOwner(model.markings),
    patchesByOwner: groupByOwner(model.patches)
  };
}
function groupByOwner(values) {
  const result = new Map;
  for (const value of values) {
    const owned = result.get(value.ownerId);
    if (owned)
      owned.push(value);
    else
      result.set(value.ownerId, [value]);
  }
  return result;
}
function chunk(model, index, ownerId, kind) {
  const patches = kind === "road" ? index.patchesByOwner.get(ownerId) ?? [] : [];
  const junctionPatches = kind === "junction" ? index.junctionPatchesByOwner.get(ownerId) ?? [] : [];
  const boundaryIds = new Set(patches.flatMap((patch) => [patch.leftBoundaryId, patch.rightBoundaryId]));
  const submodel = {
    networkId: model.networkId,
    patches,
    junctionPatches,
    boundaries: [...boundaryIds].flatMap((boundaryId) => {
      const boundary = index.boundariesById.get(boundaryId);
      return boundary ? [boundary] : [];
    }),
    markings: index.markingsByOwner.get(ownerId) ?? [],
    decals: index.decalsByOwner.get(ownerId) ?? [],
    sharedContacts: model.sharedContacts.filter((contact) => [...contact.upstreamBoundaryIds, ...contact.downstreamBoundaryIds].some((id) => boundaryIds.has(id)))
  };
  const mesh = meshRoadSurfaceModel(submodel);
  return { id: `${kind}:${ownerId}`, ownerId, kind, bounds: bounds(mesh.surface.positions), mesh };
}
function bounds(positions) {
  const min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
  const max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
  for (let index = 0;index < positions.length; index += 3) {
    min.x = Math.min(min.x, positions[index]);
    min.y = Math.min(min.y, positions[index + 1]);
    min.z = Math.min(min.z, positions[index + 2]);
    max.x = Math.max(max.x, positions[index]);
    max.y = Math.max(max.y, positions[index + 1]);
    max.z = Math.max(max.z, positions[index + 2]);
  }
  if (positions.length === 0)
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return { min, max };
}
// validation.ts
function validateRoadSurfaceModel(model, tolerance = 0.0000001) {
  const diagnostics = [];
  for (const boundary of model.boundaries) {
    if (boundary.samples.length < 2)
      diagnostics.push({ code: "degenerate-boundary", entityId: boundary.id, message: "Boundary has fewer than two samples" });
    if (!boundary.samples.every((sample) => finite(sample.position) && Number.isFinite(sample.s)))
      diagnostics.push({ code: "non-finite", entityId: boundary.id, message: "Boundary contains non-finite values" });
  }
  for (const patch of model.junctionPatches)
    for (const component of patch.components) {
      if ([...component.outer, ...component.holes.flat()].some((point) => !finite(point))) {
        diagnostics.push({ code: "non-finite", entityId: patch.id, message: `Junction patch ${patch.id} contains non-finite positions` });
      }
    }
  for (const decal of model.decals)
    if (decal.points.some((point) => !finite(point))) {
      diagnostics.push({ code: "non-finite", entityId: decal.id, message: `Decal ${decal.id} contains non-finite positions` });
    }
  const boundaries = new Map(model.boundaries.map((boundary) => [boundary.id, boundary]));
  for (const patch of model.patches) {
    const left = boundaries.get(patch.leftBoundaryId);
    const right = boundaries.get(patch.rightBoundaryId);
    if (!left || !right || left.samples.length !== right.samples.length) {
      diagnostics.push({ code: "degenerate-patch", entityId: patch.id, message: "Patch boundaries are missing or incompatible" });
      continue;
    }
    const collapsed = left.samples.map((sample, index) => length(subtract(sample.position, right.samples[index].position)) <= 0.00000001);
    if (collapsed.every(Boolean) || collapsed.slice(1, -1).some(Boolean)) {
      diagnostics.push({ code: "degenerate-patch", entityId: patch.id, message: "Patch collapses away from a legal taper endpoint" });
    }
  }
  for (const contact of model.sharedContacts) {
    const points = [...contact.upstreamBoundaryIds.map((id) => boundaries.get(id)?.samples.at(-1)?.position), ...contact.downstreamBoundaryIds.map((id) => boundaries.get(id)?.samples[0]?.position)].filter((point) => point !== undefined);
    if (points.slice(1).some((point) => Math.hypot(point.x - points[0].x, point.y - points[0].y) > tolerance)) {
      diagnostics.push({ code: "shared-contact-mismatch", entityId: contact.id, message: "Shared contact positions differ in plan" });
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
function validateRoadMeshBundle(bundle) {
  const diagnostics = [...validateMesh(bundle.surface, "surface"), ...validateMesh(bundle.markings, "markings")];
  return { valid: diagnostics.length === 0, diagnostics };
}
function validateMesh(mesh, entityId) {
  const diagnostics = [];
  const count = mesh.positions.length / 3;
  if (![...mesh.positions, ...mesh.normals, ...mesh.uvs].every(Number.isFinite))
    diagnostics.push({ code: "non-finite", entityId, message: "Mesh contains non-finite values" });
  for (let i = 0;i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
    if (a === undefined || b === undefined || c === undefined || a >= count || b >= count || c >= count) {
      diagnostics.push({ code: "invalid-index", entityId, message: `Invalid triangle at ${i}` });
      continue;
    }
    const face = cross(subtract(point(mesh, b), point(mesh, a)), subtract(point(mesh, c), point(mesh, a)));
    if (length(face) <= 0.0000000001) {
      diagnostics.push({ code: "degenerate-triangle", entityId, message: `Degenerate triangle at ${i}` });
      continue;
    }
    const normal = { x: mesh.normals[a * 3] + mesh.normals[b * 3] + mesh.normals[c * 3], y: mesh.normals[a * 3 + 1] + mesh.normals[b * 3 + 1] + mesh.normals[c * 3 + 1], z: mesh.normals[a * 3 + 2] + mesh.normals[b * 3 + 2] + mesh.normals[c * 3 + 2] };
    if (dot(face, normal) <= 0)
      diagnostics.push({ code: "inconsistent-winding", entityId, message: `Invalid winding at ${i}` });
  }
  return diagnostics;
}
function point(mesh, index) {
  return { x: mesh.positions[index * 3], y: mesh.positions[index * 3 + 1], z: mesh.positions[index * 3 + 2] };
}
function finite(point2) {
  return [point2.x, point2.y, point2.z].every(Number.isFinite);
}
// road-infrastructure/build-road-infrastructure-model.ts
import {
  evaluateReferenceLine,
  roadLateralExtentAt as roadLateralExtentAt13
} from "./core.js";

// road-infrastructure/bridge-meshes.ts
import {
  findLaneSection as findLaneSection3,
  laneOffsetsAt as laneOffsetsAt2,
  roadLateralExtentAt as roadLateralExtentAt2
} from "./core.js";

// road-infrastructure/road-sampling.ts
import { evaluateRoadReference as evaluateRoadReference2, findLaneSection as findLaneSection2, laneSurfacePointAt as laneSurfacePointAt2, roadLateralExtentAt } from "./core.js";
function roadSample(road, s) {
  const station = Math.max(0, Math.min(road.length, s));
  const pose = evaluateRoadReference2(road, station);
  const extent = roadLateralExtentAt(road, station);
  return { road, s: station, heading: pose.heading, ...extent };
}
function roadPoint(road, s, t, height = 0) {
  const section = findLaneSection2(road, Math.max(0, Math.min(road.length, s)));
  const lane = section.lanes.find((candidate) => candidate.id !== 0) ?? section.lanes[0];
  return laneSurfacePointAt2(road, section, lane, s, t, height);
}
function roadTransform(road, s, t, scale = { x: 1, y: 1, z: 1 }, height = 0, headingOffset = 0) {
  const sample = roadSample(road, s);
  return {
    position: roadPoint(road, sample.s, t, height),
    rotation: yawQuaternion(sample.heading + headingOffset),
    scale
  };
}
function stations(start, end, spacing, includeEnd = false) {
  if (end < start || spacing <= 0)
    return [];
  const result = [];
  for (let s = start;s < end - 0.0000001; s += spacing)
    result.push(s);
  if (includeEnd && (result.length === 0 || Math.abs(result.at(-1) - end) > 0.0000001))
    result.push(end);
  return result;
}
function yawQuaternion(heading) {
  const half = heading / 2;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

// road-infrastructure/alignment-sweep.ts
function appendAlignmentPrism(builder, options) {
  const { road, stationValues, lateralAt, width, bottomHeight, topHeight } = options;
  const project = options.pointAt ?? ((station, t, height) => roadPoint(road, station, t, height));
  const rings = stationValues.map((station) => {
    const center = lateralAt(station);
    const minimumT = center - width / 2;
    const maximumT = center + width / 2;
    return [
      builder.addVertex(project(station, minimumT, topHeight), station, 0),
      builder.addVertex(project(station, maximumT, topHeight), station, 1),
      builder.addVertex(project(station, maximumT, bottomHeight), station, 1),
      builder.addVertex(project(station, minimumT, bottomHeight), station, 0)
    ];
  });
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    builder.addQuad(current[0], next[0], next[1], current[1]);
    builder.addQuad(current[3], current[2], next[2], next[3]);
    builder.addQuad(current[0], current[3], next[3], next[0]);
    builder.addQuad(current[1], next[1], next[2], current[2]);
  }
  if (rings.length > 1) {
    const first = rings[0];
    const last = rings.at(-1);
    builder.addQuad(first[0], first[1], first[2], first[3]);
    builder.addQuad(last[3], last[2], last[1], last[0]);
  }
}

// road-infrastructure/structural-mesh-builder.ts
class InfrastructureStructuralMeshBuilder {
  positions = [];
  normals = [];
  uvs = [];
  indices = [];
  addVertex(point2, u = 0, v = 0) {
    const index = this.positions.length / 3;
    this.positions.push(point2.x, point2.y, point2.z);
    this.normals.push(0, 0, 0);
    this.uvs.push(u, v);
    return index;
  }
  addTriangle(a, b, c) {
    this.indices.push(a, b, c);
    const p = this.positions;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const abx = p[b * 3] - ax, aby = p[b * 3 + 1] - ay, abz = p[b * 3 + 2] - az;
    const acx = p[c * 3] - ax, acy = p[c * 3 + 1] - ay, acz = p[c * 3 + 2] - az;
    const normal = [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
    for (const vertex2 of [a, b, c])
      for (let axis = 0;axis < 3; axis++) {
        this.normals[vertex2 * 3 + axis] = this.normals[vertex2 * 3 + axis] + normal[axis];
      }
  }
  addQuad(a, b, c, d) {
    this.addTriangle(a, b, c);
    this.addTriangle(a, c, d);
  }
  build(id, kind, materialClass, provenance) {
    if (this.indices.length === 0)
      return;
    const normals = Float32Array.from(this.normals);
    for (let offset = 0;offset < normals.length; offset += 3) {
      const magnitude = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
      if (magnitude > 0.000000000001) {
        normals[offset] /= magnitude;
        normals[offset + 1] /= magnitude;
        normals[offset + 2] /= magnitude;
      }
    }
    const vertexCount = this.positions.length / 3;
    return {
      id,
      kind,
      materialClass,
      positions: Float32Array.from(this.positions),
      normals,
      uvs: Float32Array.from(this.uvs),
      indices: vertexCount <= 65535 ? Uint16Array.from(this.indices) : Uint32Array.from(this.indices),
      provenance
    };
  }
}

// road-infrastructure/swept-profile.ts
function appendSweptProfile(builder, options) {
  const {
    road,
    stationValues,
    profileAt,
    inwardFaces,
    capEnds,
    pointAt: pointAt2
  } = options;
  const project = pointAt2 ?? ((station, t, h) => roadPoint(road, station, t, h));
  const rings = stationValues.map((station) => {
    const profile = profileAt(station);
    return profile.map(({ t, h }, index) => builder.addVertex(project(station, t, h), station, index / (profile.length - 1)));
  });
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    for (let point2 = 0;point2 < current.length; point2++) {
      const following = (point2 + 1) % current.length;
      if (inwardFaces) {
        builder.addQuad(current[following], next[following], next[point2], current[point2]);
      } else {
        builder.addQuad(current[point2], next[point2], next[following], current[following]);
      }
    }
  }
  if (capEnds && rings.length > 1) {
    const first = rings[0];
    const last = rings.at(-1);
    for (let point2 = 1;point2 < first.length - 1; point2++) {
      builder.addTriangle(first[0], first[point2 + 1], first[point2]);
      builder.addTriangle(last[0], last[point2], last[point2 + 1]);
    }
  }
}

// road-infrastructure/bridge-meshes.ts
var DECK_TOP_DROP = 0.04;
var SOFFIT_HALF_RATIO = 0.34;
var CANTILEVER_HALF_RATIO = 0.62;
var PIER_SPACING = 32;
var PIER_END_CLEARANCE = 10;
var MINIMUM_PIER_HEIGHT = 2.2;
var PIER_ROAD_CLEARANCE = 2.25;
var PIER_PROTECTED_LANE_TYPES = new Set([
  "driving",
  "shoulder",
  "biking",
  "parking",
  "tram",
  "rail",
  "restricted",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "shared",
  "bus",
  "stop"
]);
function buildBridgeInfrastructure(network, physicalTopology, collector, options, continuingEnds = new Set) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  return physicalTopology.roadStructures.flatMap((structure) => {
    if (structure.kind !== "bridge")
      return [];
    const road = roads.get(structure.roadId);
    if (!road)
      throw new Error(`Bridge structure ${structure.id} has no road`);
    addBridgeInstances(structure, road, collector);
    return buildBridgeMeshes(structure, road, roads, options, continuingEnds);
  });
}
function buildBridgeMeshes(structure, road, roads, options, continuingEnds) {
  const result = [];
  const stationValues = stations(structure.sStart, structure.sEnd, Math.min(5, options.structuralSampleLength), true);
  const deck = buildDeck(structure, road, stationValues);
  if (deck)
    result.push(deck);
  for (const side of ["left", "right"]) {
    result.push(...buildParapet(structure, road, side, stationValues, options));
  }
  result.push(...buildPiers(structure, road, roads, options));
  for (const end of ["start", "end"]) {
    if (continuingEnds.has(`${structure.id}|${end}`))
      continue;
    result.push(buildAbutment(structure, road, end, options));
  }
  return result;
}
function buildDeck(structure, road, stationValues) {
  const builder = new InfrastructureStructuralMeshBuilder;
  appendSweptProfile(builder, {
    road,
    stationValues,
    capEnds: true,
    profileAt: (s) => deckProfile(structure, road, s)
  });
  return builder.build(`${structure.id}|deck`, "bridge-deck", "bridge-concrete", {
    sourceId: structure.id,
    ownerId: structure.id,
    roadId: road.id,
    structureId: structure.id,
    rule: "authored-bridge-deck"
  });
}
function deckProfile(structure, road, s) {
  const bounds2 = structureBoundsAt(structure, road, s);
  const center = (bounds2.tA + bounds2.tB) / 2;
  const halfWidth = Math.max(0.5, (bounds2.tB - bounds2.tA) / 2);
  const depth = deckDepth(structure);
  const dripDepth = Math.min(0.34, depth * 0.42);
  const cantileverDepth = Math.min(0.58, depth * 0.72);
  const top = -DECK_TOP_DROP;
  return [
    { t: center - halfWidth * SOFFIT_HALF_RATIO, h: top - depth },
    { t: center - halfWidth * CANTILEVER_HALF_RATIO, h: top - cantileverDepth },
    { t: center - halfWidth, h: top - dripDepth },
    { t: center - halfWidth, h: top },
    { t: center + halfWidth, h: top },
    { t: center + halfWidth, h: top - dripDepth },
    { t: center + halfWidth * CANTILEVER_HALF_RATIO, h: top - cantileverDepth },
    { t: center + halfWidth * SOFFIT_HALF_RATIO, h: top - depth }
  ];
}
function deckDepth(structure) {
  return Math.max(0.7, structure.structuralThickness);
}
function buildParapet(structure, road, side, stationValues, options) {
  const inward = side === "left" ? -1 : 1;
  const edgeAt = (s) => {
    const bounds2 = structureBoundsAt(structure, road, s);
    return side === "left" ? bounds2.tB : bounds2.tA;
  };
  const concrete = new InfrastructureStructuralMeshBuilder;
  appendAlignmentPrism(concrete, {
    road,
    stationValues,
    width: 0.5,
    lateralAt: (s) => edgeAt(s) + inward * 0.19,
    bottomHeight: -DECK_TOP_DROP - Math.min(0.34, deckDepth(structure) * 0.42),
    topHeight: 0.1
  });
  appendAlignmentPrism(concrete, {
    road,
    stationValues,
    width: 0.22,
    lateralAt: (s) => edgeAt(s) + inward * 0.15,
    bottomHeight: 0.06,
    topHeight: 0.58
  });
  const steel = new InfrastructureStructuralMeshBuilder;
  for (const [bottom, top] of [[1.04, 1.12], [0.78, 0.84]]) {
    appendAlignmentPrism(steel, {
      road,
      stationValues,
      width: 0.07,
      lateralAt: (s) => edgeAt(s) + inward * 0.15,
      bottomHeight: bottom,
      topHeight: top
    });
  }
  for (const s of stations(structure.sStart + 1.25, structure.sEnd - 1.25, 2.5, true)) {
    appendAlignmentPrism(steel, {
      road,
      stationValues: [s - 0.035, s + 0.035],
      width: 0.07,
      lateralAt: (station) => edgeAt(station) + inward * 0.15,
      bottomHeight: 0.55,
      topHeight: 1.06
    });
  }
  const provenance = {
    sourceId: structure.id,
    ownerId: structure.id,
    roadId: road.id,
    structureId: structure.id,
    rule: "bridge-edge-parapet"
  };
  return [
    concrete.build(`${structure.id}|parapet|${side}`, "bridge-parapet", "parapet-concrete", provenance),
    steel.build(`${structure.id}|parapet-railing|${side}`, "bridge-parapet", "railing-steel", provenance)
  ];
}
function buildPiers(structure, road, roads, options) {
  const plans = pierPlans(structure, road, roads, options);
  return plans.flatMap((plan) => {
    const mesh = buildPier(structure, road, plan);
    return mesh ? [mesh] : [];
  });
}
function pierPlans(structure, road, roads, options) {
  const length2 = structure.sEnd - structure.sStart;
  const spanCount = length2 >= PIER_END_CLEARANCE * 2 + 10 ? Math.max(2, Math.ceil(length2 / PIER_SPACING)) : 1;
  const spaced = [];
  for (let index = 1;index < spanCount; index++) {
    const idealS = structure.sStart + length2 * index / spanCount;
    if (idealS < structure.sStart + PIER_END_CLEARANCE || idealS > structure.sEnd - PIER_END_CLEARANCE)
      continue;
    const s = nearestClearPierStation(structure, road, idealS, roads);
    if (s === undefined || spaced.some((candidate) => Math.abs(candidate.s - s) < 6))
      continue;
    spaced.push({
      s,
      groundZ: options.terrainElevation,
      sourceId: structure.id,
      ownerId: structure.id,
      rule: "viaduct-span-pier"
    });
  }
  return spaced.sort((left, right) => left.s - right.s);
}
function nearestClearPierStation(structure, road, idealS, roads) {
  const candidates = stations(structure.sStart + PIER_END_CLEARANCE, structure.sEnd - PIER_END_CLEARANCE, 1, true).sort((left, right) => Math.abs(left - idealS) - Math.abs(right - idealS));
  for (const station of candidates) {
    if (pierFootprintIsClear(structure, road, station, roads))
      return station;
  }
  return;
}
function pierFootprintIsClear(structure, road, station, roads) {
  const bounds2 = structureBoundsAt(structure, road, station);
  const centerT = (bounds2.tA + bounds2.tB) / 2;
  const center = roadPoint(road, station, centerT);
  const soffitZ = center.z - DECK_TOP_DROP - deckDepth(structure);
  for (const otherRoad of roads.values()) {
    if (otherRoad.id === road.id)
      continue;
    const values = stations(0, otherRoad.length, 4, true);
    for (let index = 0;index < values.length - 1; index++) {
      const s0 = values[index];
      const s1 = values[index + 1];
      const p0 = roadPoint(otherRoad, s0, 0);
      const p1 = roadPoint(otherRoad, s1, 0);
      if (Math.max(p0.z, p1.z) >= soffitZ - 0.2)
        continue;
      const nearest = nearestSegmentParameter(center.x, center.y, p0.x, p0.y, p1.x, p1.y);
      const lowerS = s0 + (s1 - s0) * nearest;
      const lowerCenter = roadPoint(otherRoad, lowerS, 0);
      const maximumExtent = roadLateralExtentAt2(otherRoad, lowerS);
      const centerlineDistance = Math.hypot(center.x - lowerCenter.x, center.y - lowerCenter.y);
      if (centerlineDistance > Math.max(Math.abs(maximumExtent.minimumT), Math.abs(maximumExtent.maximumT)) + PIER_ROAD_CLEARANCE)
        continue;
      const section = findLaneSection3(otherRoad, lowerS);
      for (const lane of section.lanes) {
        if (!PIER_PROTECTED_LANE_TYPES.has(lane.type))
          continue;
        const offsets = laneOffsetsAt2(section, lane.id, lowerS - section.s);
        const inner = roadPoint(otherRoad, lowerS, offsets.inner);
        const outer = roadPoint(otherRoad, lowerS, offsets.outer);
        if (pointSegmentDistanceSquared(center.x, center.y, inner.x, inner.y, outer.x, outer.y) <= PIER_ROAD_CLEARANCE ** 2)
          return false;
      }
    }
  }
  return true;
}
function nearestSegmentParameter(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  return lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
}
function pointSegmentDistanceSquared(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = nearestSegmentParameter(px, py, ax, ay, bx, by);
  const x = ax + dx * t;
  const y = ay + dy * t;
  return (px - x) ** 2 + (py - y) ** 2;
}
function buildPier(structure, road, plan) {
  const bounds2 = structureBoundsAt(structure, road, plan.s);
  const center = (bounds2.tA + bounds2.tB) / 2;
  const halfWidth = Math.max(0.5, (bounds2.tB - bounds2.tA) / 2);
  const surface = roadPoint(road, plan.s, center);
  const soffitZ = surface.z - DECK_TOP_DROP - deckDepth(structure);
  const height = soffitZ - plan.groundZ;
  if (height < MINIMUM_PIER_HEIGHT)
    return;
  const sample = roadSample(road, plan.s);
  const forward = { x: Math.cos(sample.heading), y: Math.sin(sample.heading) };
  const left = { x: -forward.y, y: forward.x };
  const at = (along, lateral, z) => ({
    x: surface.x + forward.x * along + left.x * lateral,
    y: surface.y + forward.y * along + left.y * lateral,
    z
  });
  const builder = new InfrastructureStructuralMeshBuilder;
  const capHeight = Math.min(1.1, Math.max(0.6, height * 0.22));
  const shaftTopZ = soffitZ - capHeight;
  const lateralSemi = Math.min(1.3, Math.max(0.8, halfWidth * 0.4));
  const alongSemi = Math.min(1, Math.max(0.6, deckDepth(structure) * 0.7));
  const taper = Math.min(1.25, 1 + height * 0.018);
  appendEllipticShaft(builder, at, {
    baseZ: plan.groundZ - 0.4,
    topZ: shaftTopZ,
    topLateralSemi: lateralSemi,
    topAlongSemi: alongSemi,
    baseScale: taper
  });
  appendLoftedBox(builder, at, {
    bottom: { alongHalf: alongSemi + 0.2, lateralHalf: lateralSemi + 0.3, z: shaftTopZ },
    top: {
      alongHalf: alongSemi + 0.2,
      lateralHalf: Math.max(lateralSemi + 0.3, halfWidth * SOFFIT_HALF_RATIO * 0.95),
      z: soffitZ - 0.02
    }
  });
  appendLoftedBox(builder, at, {
    bottom: { alongHalf: alongSemi + 0.45, lateralHalf: lateralSemi * taper + 0.3, z: plan.groundZ - 0.45 },
    top: { alongHalf: alongSemi + 0.45, lateralHalf: lateralSemi * taper + 0.3, z: plan.groundZ + 0.12 }
  });
  const mesh = builder.build(`${structure.id}|pier|${plan.s.toFixed(1)}`, "bridge-pier", "bridge-concrete", {
    sourceId: plan.sourceId,
    ownerId: plan.ownerId,
    roadId: road.id,
    structureId: structure.id,
    station: plan.s,
    rule: plan.rule
  });
  return mesh;
}
function appendEllipticShaft(builder, at, spec) {
  const segments = 12;
  const ring = (z, scale) => Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return builder.addVertex(at(Math.cos(angle) * spec.topAlongSemi * scale, Math.sin(angle) * spec.topLateralSemi * scale, z), z, index / segments);
  });
  const bottom = ring(spec.baseZ, spec.baseScale);
  const top = ring(spec.topZ, 1);
  for (let index = 0;index < segments; index++) {
    const next = (index + 1) % segments;
    builder.addQuad(bottom[index], bottom[next], top[next], top[index]);
  }
}
function appendLoftedBox(builder, at, spec) {
  const corners = (rect) => [
    builder.addVertex(at(-rect.alongHalf, -rect.lateralHalf, rect.z)),
    builder.addVertex(at(rect.alongHalf, -rect.lateralHalf, rect.z)),
    builder.addVertex(at(rect.alongHalf, rect.lateralHalf, rect.z)),
    builder.addVertex(at(-rect.alongHalf, rect.lateralHalf, rect.z))
  ];
  const bottom = corners(spec.bottom);
  const top = corners(spec.top);
  builder.addQuad(bottom[0], bottom[3], bottom[2], bottom[1]);
  builder.addQuad(top[0], top[1], top[2], top[3]);
  for (let index = 0;index < 4; index++) {
    const next = (index + 1) % 4;
    builder.addQuad(bottom[index], bottom[next], top[next], top[index]);
  }
}
function buildAbutment(structure, road, end, options) {
  const s = end === "start" ? structure.sStart : structure.sEnd;
  const bounds2 = structureBoundsAt(structure, road, s);
  const center = (bounds2.tA + bounds2.tB) / 2;
  const width = bounds2.tB - bounds2.tA;
  const surface = roadPoint(road, s, center);
  const soffitZ = surface.z - DECK_TOP_DROP - deckDepth(structure);
  const groundZ = options.terrainElevation;
  const wallTopZ = Math.max(groundZ + 0.1, soffitZ - 0.05);
  const sample = roadSample(road, s);
  const forward = { x: Math.cos(sample.heading), y: Math.sin(sample.heading) };
  const left = { x: -forward.y, y: forward.x };
  const backward = end === "start" ? { x: -forward.x, y: -forward.y } : forward;
  const at = (along, lateral, z) => ({
    x: surface.x + backward.x * along + left.x * lateral,
    y: surface.y + backward.y * along + left.y * lateral,
    z
  });
  const builder = new InfrastructureStructuralMeshBuilder;
  appendLoftedBox(builder, at, {
    bottom: { alongHalf: 0.6, lateralHalf: width / 2 + 0.4, z: groundZ - 0.4 },
    top: { alongHalf: 0.6, lateralHalf: width / 2 + 0.4, z: wallTopZ }
  });
  return builder.build(`${structure.id}|abutment|${end}`, "bridge-abutment", "bridge-concrete", {
    sourceId: structure.id,
    ownerId: structure.id,
    roadId: road.id,
    structureId: structure.id,
    station: s,
    rule: "terrain-to-deck-bridge-abutment"
  });
}
function addBridgeInstances(structure, road, collector) {
  for (const s of [structure.sStart, structure.sEnd]) {
    const bounds2 = structureBoundsAt(structure, road, s);
    collector.add("expansion-joint", "expansion-joint-steel", {
      id: `${structure.id}|expansion-joint|${s.toFixed(3)}`,
      transform: roadTransform(road, s, (bounds2.tA + bounds2.tB) / 2, {
        x: 0.5,
        y: bounds2.tB - bounds2.tA,
        z: 0.025
      }, 0.0125),
      provenance: { sourceId: structure.id, ownerId: structure.id, roadId: road.id, structureId: structure.id, station: s, rule: "bridge-deck-end" }
    });
  }
}
function structureBoundsAt(structure, road, s) {
  if (structure.lateralExtentMode !== "road-surface") {
    return { tA: structure.deckTMin, tB: structure.deckTMax };
  }
  const extent = roadLateralExtentAt2(road, s);
  return {
    tA: extent.minimumT - structure.minimumLateralClearance,
    tB: extent.maximumT + structure.minimumLateralClearance
  };
}

// road-infrastructure/corridor-assets.ts
import { roadLateralExtentAt as roadLateralExtentAt4 } from "./core.js";

// road-infrastructure/direct-junction-clearance.ts
import { roadLateralExtentAt as roadLateralExtentAt3 } from "./core.js";
var SAMPLE_STEP = 2;
var MINIMUM_RAIL_GAP = 2.5;
var CLEARANCE_MARGIN = 3;
var pavementSampleCache = new WeakMap;
var clearanceCache = new WeakMap;
function guardrailClearances(road, side, physicalTopology, semantics) {
  let roadCache = clearanceCache.get(semantics);
  if (!roadCache) {
    roadCache = new WeakMap;
    clearanceCache.set(semantics, roadCache);
  }
  const cached = roadCache.get(road)?.[side];
  if (cached)
    return cached;
  const ranges = [];
  for (const junction of physicalTopology.junctions) {
    if (junction.junctionKind !== "direct" || !junction.roadIds.includes(road.id))
      continue;
    const members = junction.roadIds.flatMap((id) => semantics.get(id) ? [semantics.get(id)] : []);
    if (!members.some((item) => item.motorwayLike) || !members.some((item) => item.rampLike))
      continue;
    const current = semantics.get(road.id);
    if (!current)
      continue;
    const opposingRoads = members.filter((item) => current.rampLike ? item.motorwayLike : item.rampLike).map((item) => item.road);
    for (const contact of contactStations(junction, road.id)) {
      const direction = contact <= road.length / 2 ? 1 : -1;
      const maximumProbe = Math.min(180, road.length);
      let blockedDistance = 0;
      for (let distance = 0;distance <= maximumProbe; distance += SAMPLE_STEP) {
        const station = contact + direction * distance;
        if (station < 0 || station > road.length)
          break;
        const extent = roadLateralExtentAt3(road, station);
        const lateral = side === "left" ? extent.maximumT : extent.minimumT;
        const point2 = roadPoint(road, station, lateral);
        if (opposingRoads.some((candidate) => distanceToPavement(point2, candidate) < MINIMUM_RAIL_GAP)) {
          blockedDistance = distance;
        }
      }
      const clearDistance = Math.min(maximumProbe, blockedDistance + CLEARANCE_MARGIN);
      const end = contact + direction * clearDistance;
      ranges.push({ start: Math.max(0, Math.min(contact, end)), end: Math.min(road.length, Math.max(contact, end)) });
    }
  }
  const result = mergeRanges(ranges);
  const sides = roadCache.get(road) ?? {};
  sides[side] = result;
  roadCache.set(road, sides);
  return result;
}
function outsideClearances(station, clearances) {
  return clearances.every((range) => station < range.start || station > range.end);
}
function stationRuns(roadLength, clearances, spacing) {
  const boundaries = new Set([0, roadLength]);
  for (const range of clearances) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const runs = [];
  for (let index = 0;index < ordered.length - 1; index += 1) {
    const start = ordered[index];
    const end = ordered[index + 1];
    if (end - start < 0.000001 || !outsideClearances((start + end) / 2, clearances))
      continue;
    const values = [start];
    for (let station = start + spacing;station < end - 0.0000001; station += spacing)
      values.push(station);
    values.push(end);
    runs.push(values);
  }
  return runs;
}
function contactStations(junction, roadId) {
  return [...new Set(junction.directLaneLinks.flatMap((link) => [
    ...link.from.roadId === roadId ? [link.from.s] : [],
    ...link.to.roadId === roadId ? [link.to.s] : []
  ]))];
}
function distanceToPavement(point2, road) {
  let minimum = Number.POSITIVE_INFINITY;
  let previous;
  for (const current of pavementCrossSections(road)) {
    minimum = Math.min(minimum, pointSegmentDistance(point2, current.left, current.right));
    if (previous) {
      minimum = Math.min(minimum, pointSegmentDistance(point2, previous.left, current.left), pointSegmentDistance(point2, previous.right, current.right));
    }
    previous = current;
  }
  return minimum;
}
function pavementCrossSections(road) {
  const cached = pavementSampleCache.get(road);
  if (cached)
    return cached;
  const values = [];
  for (let station = 0;station <= road.length + 0.0000001; station += SAMPLE_STEP) {
    const s = Math.min(station, road.length);
    const extent = roadLateralExtentAt3(road, s);
    values.push({
      left: roadPoint(road, s, extent.maximumT),
      right: roadPoint(road, s, extent.minimumT)
    });
    if (s === road.length)
      break;
  }
  pavementSampleCache.set(road, values);
  return values;
}
function pointSegmentDistance(point2, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point2.x - start.x) * dx + (point2.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point2.x - (start.x + dx * amount), point2.y - (start.y + dy * amount));
}
function mergeRanges(ranges) {
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  const result = [];
  for (const range of ordered) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end + 0.0000001)
      previous.end = Math.max(previous.end, range.end);
    else
      result.push({ ...range });
  }
  return result;
}

// road-infrastructure/corridor-assets.ts
function addCorridorInfrastructure(semantics, physicalTopology, collector, options) {
  const authoredBarrierRoadIds = new Set(options.authoredMotorwayBarrierRoadIds);
  const authoredDelineatorRoadIds = new Set(options.authoredMotorwayDelineatorRoadIds);
  for (const corridor of physicalTopology.corridors) {
    const semantic = semantics.get(corridor.roadId);
    if (!semantic || semantic.road.junctionId || !semantic.motorwayLike && !semantic.rampLike)
      continue;
    if (!authoredDelineatorRoadIds.has(semantic.road.id)) {
      addDelineators(semantic, collector, options);
    }
    addCatchBasins(semantic, collector, options);
    if (semantic.motorwayLike) {
      addMedianReflectors(semantic, collector, options);
    }
    if (!authoredBarrierRoadIds.has(semantic.road.id)) {
      addGuardrailInstances(semantic, semantics, physicalTopology, collector);
    }
  }
}
function addMedianReflectors(semantic, collector, options) {
  const road = semantic.road;
  for (const s of stations(0, road.length, options.reflectorSpacing, true)) {
    const extent = roadLateralExtentAt4(road, s);
    const medianOffset = semantic.oneWay ? innerOffset(extent.minimumT, extent.maximumT) : 0;
    collector.add("reflector", "reflector-white", {
      id: `${road.id}|median-reflector|${stationKey(s)}`,
      transform: roadTransform(road, s, medianOffset, { x: 0.12, y: 0.04, z: 0.08 }, 0.65),
      provenance: provenance(road.id, road.id, s, "median-barrier-reflector")
    });
  }
}
function addGuardrailInstances(semantic, semantics, physicalTopology, collector) {
  const road = semantic.road;
  for (const side of guardrailSides(semantic)) {
    const clearances = guardrailClearances(road, side, physicalTopology, semantics);
    for (const s of stations(0, road.length, 2, true).filter((station) => outsideClearances(station, clearances))) {
      const extent = roadLateralExtentAt4(road, s);
      collector.add("guardrail-post", "guardrail-galvanized", {
        id: `${road.id}|guardrail-post|${side}|${stationKey(s)}`,
        transform: roadTransform(road, s, outerOffset(extent.minimumT, extent.maximumT, side), { x: 0.1, y: 0.1, z: 0.75 }),
        provenance: provenance(road.id, road.id, s, "high-speed-outer-guardrail-post")
      });
    }
    if (!semantic.rampLike)
      continue;
    for (const s of [0, road.length].filter((station) => outsideClearances(station, clearances))) {
      const extent = roadLateralExtentAt4(road, s);
      collector.add("guardrail-terminal", "guardrail-galvanized", {
        id: `${road.id}|guardrail-terminal|${side}|${stationKey(s)}`,
        transform: roadTransform(road, s, outerOffset(extent.minimumT, extent.maximumT, side), { x: 2, y: 0.5, z: 0.8 }, 0.05),
        provenance: provenance(road.id, road.id, s, "ramp-guardrail-terminal")
      });
    }
  }
}
function guardrailSides(semantic) {
  if (semantic.rampLike || semantic.motorwayLike && !semantic.oneWay)
    return ["left", "right"];
  const extent = roadLateralExtentAt4(semantic.road, semantic.road.length / 2);
  return [Math.abs(extent.maximumT) > Math.abs(extent.minimumT) ? "left" : "right"];
}
function addDelineators(semantic, collector, options) {
  const road = semantic.road;
  const spacing = semantic.motorwayLike ? options.motorwayDelineatorSpacing : options.rampDelineatorSpacing;
  for (const s of stations(spacing / 2, road.length, spacing, true)) {
    const extent = roadLateralExtentAt4(road, s);
    for (const side of ["left", "right"]) {
      const t = outerOffset(extent.minimumT, extent.maximumT, side) + (side === "left" ? 0.6 : -0.6);
      collector.add("delineator-post", "delineator-white", {
        id: `${road.id}|delineator|${side}|${stationKey(s)}`,
        transform: roadTransform(road, s, t, { x: 0.12, y: 0.08, z: 1 }),
        provenance: provenance(road.id, road.id, s, "high-speed-roadside-delineator")
      });
      collector.add("reflector", side === "left" ? "reflector-white" : "reflector-amber", {
        id: `${road.id}|delineator-reflector|${side}|${stationKey(s)}`,
        transform: roadTransform(road, s, t, { x: 0.11, y: 0.03, z: 0.08 }, 0.78),
        provenance: provenance(road.id, road.id, s, "delineator-reflector")
      });
    }
  }
}
function addCatchBasins(semantic, collector, options) {
  const road = semantic.road;
  for (const side of ["left", "right"]) {
    for (const s of stations(options.drainageSpacing / 2, road.length, options.drainageSpacing)) {
      const extent = roadLateralExtentAt4(road, s);
      collector.add("catch-basin", "drainage-cast-iron", {
        id: `${road.id}|catch-basin|${side}|${stationKey(s)}`,
        transform: roadTransform(road, s, outerOffset(extent.minimumT, extent.maximumT, side), { x: 0.6, y: 0.4, z: 0.08 }),
        provenance: provenance(road.id, road.id, s, "pavement-edge-catch-basin")
      });
    }
  }
}
function innerOffset(minimumT, maximumT) {
  return Math.abs(minimumT) < Math.abs(maximumT) ? minimumT : maximumT;
}
function outerOffset(minimumT, maximumT, side) {
  return side === "left" ? maximumT : minimumT;
}
function stationKey(s) {
  return s.toFixed(3);
}
function provenance(sourceId, roadId, station, rule) {
  return { sourceId, ownerId: roadId, roadId, station, rule };
}

// road-infrastructure/continuous-corridor-meshes.ts
import { roadLateralExtentAt as roadLateralExtentAt5 } from "./core.js";
function buildContinuousCorridorMeshes(semantics, physicalTopology, options) {
  const meshes = [];
  const authoredBarrierRoadIds = new Set(options.authoredMotorwayBarrierRoadIds);
  for (const corridor of physicalTopology.corridors) {
    const semantic = semantics.get(corridor.roadId);
    if (!semantic || semantic.road.junctionId || !semantic.motorwayLike && !semantic.rampLike)
      continue;
    for (const side of ["left", "right"]) {
      meshes.push(buildDrainageGutter(semantic, side, options));
      if (!authoredBarrierRoadIds.has(semantic.road.id) && guardrailSides2(semantic).includes(side)) {
        const guardrail = buildGuardrailRail(semantic, side, physicalTopology, semantics, options);
        if (guardrail)
          meshes.push(guardrail);
      }
    }
    if (semantic.motorwayLike)
      meshes.push(buildMedianBarrier(semantic, options));
  }
  return meshes;
}
function buildMedianBarrier(semantic, options) {
  const road = semantic.road;
  const builder = new InfrastructureStructuralMeshBuilder;
  const profile = [
    { lateral: -0.35, height: 0 },
    { lateral: -0.28, height: 0.25 },
    { lateral: -0.16, height: 0.9 },
    { lateral: 0.16, height: 0.9 },
    { lateral: 0.28, height: 0.25 },
    { lateral: 0.35, height: 0 }
  ];
  const rings = continuousStations(road.length, options).map((station) => {
    const extent = roadLateralExtentAt5(road, station);
    const center = semantic.oneWay ? innerOffset2(extent.minimumT, extent.maximumT) : 0;
    return profile.map(({ lateral, height }, profileIndex) => builder.addVertex(roadPoint(road, station, center + lateral, height), station, profileIndex / (profile.length - 1)));
  });
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    for (let profileIndex = 0;profileIndex < profile.length; profileIndex++) {
      const following = (profileIndex + 1) % profile.length;
      builder.addQuad(current[profileIndex], next[profileIndex], next[following], current[following]);
    }
  }
  if (rings.length > 1) {
    const first = rings[0];
    const last = rings.at(-1);
    for (let index = 1;index < profile.length - 1; index++) {
      builder.addTriangle(first[0], first[index + 1], first[index]);
      builder.addTriangle(last[0], last[index], last[index + 1]);
    }
  }
  return builder.build(`${road.id}|median-barrier`, "concrete-median-barrier", "barrier-concrete", {
    sourceId: road.id,
    ownerId: road.id,
    roadId: road.id,
    rule: "motorway-inner-continuous-barrier"
  });
}
function buildGuardrailRail(semantic, side, physicalTopology, semantics, options) {
  const road = semantic.road;
  const builder = new InfrastructureStructuralMeshBuilder;
  const clearances = guardrailClearances(road, side, physicalTopology, semantics);
  for (const stationValues of stationRuns(road.length, clearances, Math.min(2, options.structuralSampleLength))) {
    appendAlignmentPrism(builder, {
      road,
      stationValues,
      lateralAt: (station) => outerOffset2(road, station, side),
      width: 0.12,
      bottomHeight: 0.48,
      topHeight: 0.68
    });
  }
  return builder.build(`${road.id}|guardrail-rail|${side}`, "guardrail-rail", "guardrail-galvanized", {
    sourceId: road.id,
    ownerId: road.id,
    roadId: road.id,
    rule: "high-speed-outer-guardrail-rail"
  });
}
function buildDrainageGutter(semantic, side, options) {
  const road = semantic.road;
  const sign = side === "left" ? 1 : -1;
  const builder = new InfrastructureStructuralMeshBuilder;
  const rings = continuousStations(road.length, options).map((station) => {
    const edge = outerOffset2(road, station, side);
    const profile = [
      { t: edge - sign * 0.1, height: 0.025 },
      { t: edge + sign * 0.12, height: -0.07 },
      { t: edge + sign * 0.35, height: 0.075 }
    ];
    return profile.map(({ t, height }, profileIndex) => builder.addVertex(roadPoint(road, station, t, height), station, profileIndex / 2));
  });
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    builder.addQuad(current[0], next[0], next[1], current[1]);
    builder.addQuad(current[1], next[1], next[2], current[2]);
  }
  return builder.build(`${road.id}|drainage-gutter|${side}`, "drainage-gutter", "drainage-concrete", {
    sourceId: road.id,
    ownerId: road.id,
    roadId: road.id,
    rule: "pavement-edge-continuous-drainage"
  });
}
function continuousStations(length2, options) {
  const spacing = Math.min(2, options.structuralSampleLength);
  return stations(0, length2, spacing, true);
}
function outerOffset2(road, station, side) {
  const extent = roadLateralExtentAt5(road, station);
  return side === "left" ? extent.maximumT : extent.minimumT;
}
function innerOffset2(minimumT, maximumT) {
  return Math.abs(minimumT) < Math.abs(maximumT) ? minimumT : maximumT;
}
function guardrailSides2(semantic) {
  if (semantic.rampLike || semantic.motorwayLike && !semantic.oneWay)
    return ["left", "right"];
  const extent = roadLateralExtentAt5(semantic.road, semantic.road.length / 2);
  return [Math.abs(extent.maximumT) > Math.abs(extent.minimumT) ? "left" : "right"];
}

// road-infrastructure/earthwork-meshes.ts
import { roadLateralExtentAt as roadLateralExtentAt6 } from "./core.js";
function buildEarthworkMeshes(network, physicalTopology, semantics, options) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const sourceRoads = network.roads.filter((road) => !road.junctionId);
  const sourceRoadIds = new Set(sourceRoads.map((road) => road.id));
  const structureRanges = structureRangesByRoad(physicalTopology);
  const explicitDitches = (physicalTopology.roadsideFeatures ?? []).filter((feature) => feature.kind === "ditch" && sourceRoadIds.has(feature.roadId));
  const result = explicitDitches.flatMap((ditch) => {
    const road = roads.get(ditch.roadId);
    if (!road)
      throw new Error(`Roadside ditch ${ditch.id} has no road`);
    const mesh = buildDitch(road, ditch.sStart, ditch.sEnd, ditch.side, ditch.gap, ditch.depth, ditch.bottomWidth, ditch.sideSlope, ditch.id, structureRanges.get(road.id) ?? [], options);
    return mesh ? [mesh] : [];
  });
  for (const road of sourceRoads) {
    if (road.earthworkPolicy === "none")
      continue;
    result.push(...buildEmbankmentSolids(road, structureRanges.get(road.id) ?? [], options));
  }
  return result;
}
function buildDitch(road, sStart, sEnd, side, gap, depth, bottomWidth, sideSlope, sourceId, excluded, options) {
  const builder = new InfrastructureStructuralMeshBuilder;
  const sign = side === "left" ? 1 : -1;
  const stationValues = stations(sStart, sEnd, options.structuralSampleLength, true);
  const rings = stationValues.map((s, index) => {
    if (excluded.some((range) => s >= range.start - 0.0000001 && s <= range.end + 0.0000001))
      return;
    const extent = roadLateralExtentAt6(road, s);
    const edge = side === "left" ? extent.maximumT : extent.minimumT;
    const near = edge + sign * gap;
    const bottomNear = near + sign * depth * sideSlope;
    const bottomFar = bottomNear + sign * bottomWidth;
    const far = bottomFar + sign * depth * sideSlope;
    const base = options.terrainElevation;
    return [
      builder.addVertex({ ...roadPoint(road, s, near), z: base }, index, 0),
      builder.addVertex({ ...roadPoint(road, s, bottomNear), z: base - depth }, index, 0.4),
      builder.addVertex({ ...roadPoint(road, s, bottomFar), z: base - depth }, index, 0.6),
      builder.addVertex({ ...roadPoint(road, s, far), z: base }, index, 1)
    ];
  });
  for (let index = 0;index < rings.length - 1; index++) {
    const a = rings[index], b = rings[index + 1];
    if (!a || !b)
      continue;
    for (let strip = 0;strip < 3; strip++) {
      if (side === "left")
        builder.addQuad(a[strip], b[strip], b[strip + 1], a[strip + 1]);
      else
        builder.addQuad(a[strip + 1], b[strip + 1], b[strip], a[strip]);
    }
  }
  return builder.build(`${sourceId}|ditch|${side}`, "roadside-ditch", "ditch-earth", {
    sourceId,
    ownerId: road.id,
    roadId: road.id,
    rule: "roadside-drainage-profile"
  });
}
function structureRangesByRoad(physicalTopology) {
  const result = new Map;
  for (const structure of physicalTopology.roadStructures) {
    const ranges = result.get(structure.roadId) ?? [];
    ranges.push({ start: structure.sStart, end: structure.sEnd });
    result.set(structure.roadId, ranges);
  }
  return result;
}
function buildEmbankmentSolids(road, excluded, options) {
  const stationValues = sampledStations(road.length, excluded, options.structuralSampleLength);
  const runs = [];
  let activeRun = [];
  for (const station of stationValues) {
    const section = insideStructure(station, excluded) ? undefined : fillCrossSection(road, station, options.terrainElevation);
    if (section) {
      activeRun.push(section);
    } else if (activeRun.length > 0) {
      if (activeRun.length > 1)
        runs.push(activeRun);
      activeRun = [];
    }
  }
  if (activeRun.length > 1)
    runs.push(activeRun);
  return runs.map((run, index) => buildFillRun(road, run, index));
}
var EMBANKMENT_EDGE_WALL_OFFSET = 0;
function fillCrossSection(road, station, terrainElevation) {
  const extent = roadLateralExtentAt6(road, station);
  const leftEdge = roadPoint(road, station, extent.maximumT);
  const rightEdge = roadPoint(road, station, extent.minimumT);
  if (Math.min(leftEdge.z, rightEdge.z) - terrainElevation < 0.5)
    return;
  leftEdge.z -= 0.04;
  rightEdge.z -= 0.04;
  const leftBottom = {
    ...roadPoint(road, station, extent.maximumT + EMBANKMENT_EDGE_WALL_OFFSET),
    z: terrainElevation
  };
  const rightBottom = {
    ...roadPoint(road, station, extent.minimumT - EMBANKMENT_EDGE_WALL_OFFSET),
    z: terrainElevation
  };
  return { station, points: [leftBottom, leftEdge, rightEdge, rightBottom] };
}
function buildFillRun(road, run, runIndex) {
  const builder = new InfrastructureStructuralMeshBuilder;
  const rings = run.map(({ station, points }) => points.map((point2, profileIndex) => builder.addVertex(point2, station, profileIndex / (points.length - 1))));
  for (let ringIndex = 0;ringIndex < rings.length - 1; ringIndex++) {
    const current = rings[ringIndex];
    const next = rings[ringIndex + 1];
    for (let profileIndex = 0;profileIndex < current.length; profileIndex++) {
      const following = (profileIndex + 1) % current.length;
      builder.addQuad(current[following], next[following], next[profileIndex], current[profileIndex]);
    }
  }
  const first = rings[0];
  const last = rings.at(-1);
  for (let profileIndex = 1;profileIndex < first.length - 1; profileIndex++) {
    builder.addTriangle(first[0], first[profileIndex + 1], first[profileIndex]);
    builder.addTriangle(last[0], last[profileIndex], last[profileIndex + 1]);
  }
  return builder.build(`${road.id}|embankment|${runIndex}`, "embankment", "embankment-earth", {
    sourceId: road.id,
    ownerId: road.id,
    roadId: road.id,
    rule: "closed-engineered-road-fill"
  });
}
function sampledStations(roadLength, excluded, spacing) {
  const values = new Set(stations(0, roadLength, spacing, true));
  for (const range of excluded) {
    values.add(range.start);
    values.add(range.end);
  }
  return [...values].filter((station) => station >= 0 && station <= roadLength).sort((left, right) => left - right);
}
function insideStructure(station, excluded) {
  return excluded.some((range) => station > range.start + 0.0000001 && station < range.end - 0.0000001);
}

// road-infrastructure/instance-batches.ts
class InfrastructureInstanceCollector {
  batches = new Map;
  add(prototypeKind, materialClass, instance) {
    const id = `infrastructure-batch|${prototypeKind}|${materialClass}`;
    const batch = this.batches.get(id) ?? { id, prototypeKind, materialClass, instances: [] };
    batch.instances.push(instance);
    this.batches.set(id, batch);
  }
  build() {
    return [...this.batches.values()].map((batch) => ({ ...batch, instances: [...batch.instances].sort((left, right) => left.id.localeCompare(right.id)) })).sort((left, right) => left.id.localeCompare(right.id));
  }
}

// road-infrastructure/junction-fill-meshes.ts
import { roadLateralExtentAt as roadLateralExtentAt7 } from "./core.js";
import { triangulateCDT as triangulateCDT2 } from "./cdt/index.js";
function buildJunctionFillMeshes(network, physicalTopology, assemblies, options) {
  return assemblies.flatMap((assembly) => {
    const junction = network.junctions.find(({ id }) => id === assembly.junctionId);
    const topology = physicalTopology.junctions.find((junction2) => junction2.junctionId === assembly.junctionId);
    const roadIds = new Set(topology?.roadIds ?? []);
    const connectorRoads = network.roads.filter((road) => road.junctionId === assembly.junctionId || roadIds.has(road.id));
    const sourceRoads = connectorRoads.filter((road) => !road.junctionId);
    if (!junction || connectorRoads.length === 0 || !shouldBuildJunctionFill(junction, sourceRoads))
      return [];
    const heightSamples = connectorRoads.flatMap(pavementHeightSamples);
    const elevationAt = (point2) => smoothSurfaceHeight(point2, heightSamples);
    return assembly.components.flatMap((component, componentIndex) => {
      const rings = [normalizeRing(component.outer, false), ...component.holes.map((hole) => normalizeRing(hole, true))];
      const minimumHeight = Math.min(...rings.flat().map(elevationAt));
      if (minimumHeight - options.terrainElevation < 0.5)
        return [];
      return [buildJunctionFill(assembly.junctionId, componentIndex, rings, elevationAt, options.terrainElevation)];
    });
  });
}
function shouldBuildJunctionFill(junction, sourceRoads) {
  if (junction.connectorGeometryPolicy === "surface-fallback")
    return false;
  if (sourceRoads.length > 0 && sourceRoads.every((road) => road.earthworkPolicy === "none"))
    return false;
  return true;
}
function buildJunctionFill(junctionId, componentIndex, rings, elevationAt, terrainElevation) {
  const points = rings.flat();
  const offsets = [];
  let offset = 0;
  for (const ring of rings) {
    offsets.push(offset);
    offset += ring.length;
  }
  const ringIndices = rings.map((ring, index) => ring.map((_, pointIndex) => offsets[index] + pointIndex));
  const triangulation = triangulateCDT2({
    points,
    polygons: [{ outer: ringIndices[0], holes: ringIndices.slice(1) }]
  });
  const builder = new InfrastructureStructuralMeshBuilder;
  const topVertices = triangulation.points.map((point2, index) => {
    const sourceIndex = triangulation.pointSources[index]?.[0];
    const source = sourceIndex === undefined ? point2 : points[sourceIndex];
    return builder.addVertex({ x: point2.x, y: point2.y, z: elevationAt(source) - 0.04 }, point2.x, point2.y);
  });
  const bottomVertices = triangulation.points.map((point2) => builder.addVertex({ x: point2.x, y: point2.y, z: terrainElevation }, point2.x, point2.y));
  const capEdges = new Map;
  for (let index = 0;index < triangulation.triangles.length; index += 3) {
    const a = triangulation.triangles[index];
    const b = triangulation.triangles[index + 1];
    const c = triangulation.triangles[index + 2];
    if (triangleArea(triangulation.points[a], triangulation.points[b], triangulation.points[c]) > 0) {
      builder.addTriangle(topVertices[a], topVertices[b], topVertices[c]);
      builder.addTriangle(bottomVertices[a], bottomVertices[c], bottomVertices[b]);
      addCapEdges(capEdges, a, b, c);
    } else {
      builder.addTriangle(topVertices[a], topVertices[c], topVertices[b]);
      builder.addTriangle(bottomVertices[a], bottomVertices[b], bottomVertices[c]);
      addCapEdges(capEdges, a, c, b);
    }
  }
  for (const edge of capEdges.values()) {
    if (edge.count !== 1)
      continue;
    builder.addQuad(topVertices[edge.start], bottomVertices[edge.start], bottomVertices[edge.end], topVertices[edge.end]);
  }
  return builder.build(`junction-fill|${junctionId}|${componentIndex}`, "junction-fill", "retaining-concrete", {
    sourceId: junctionId,
    ownerId: junctionId,
    junctionId,
    rule: "elevated-junction-union-fill"
  });
}
function addCapEdges(edges, a, b, c) {
  for (const [start, end] of [[a, b], [b, c], [c, a]]) {
    const key = start < end ? `${start}|${end}` : `${end}|${start}`;
    const existing = edges.get(key);
    if (existing)
      existing.count++;
    else
      edges.set(key, { start, end, count: 1 });
  }
}
function pavementHeightSamples(road) {
  const sampledStations2 = stations(0, road.length, 1, true);
  return [-1, 0, 1].flatMap((side) => sampledStations2.map((station) => {
    const extent = roadLateralExtentAt7(road, station);
    const lateralOffset = side < 0 ? extent.minimumT : side > 0 ? extent.maximumT : 0;
    return roadPoint(road, station, lateralOffset);
  }));
}
function normalizeRing(points, hole) {
  const area = signedArea(points);
  const shouldReverse = hole ? area > 0 : area < 0;
  return shouldReverse ? [...points].reverse() : [...points];
}
function signedArea(points) {
  let area = 0;
  for (let index = 0;index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}
function triangleArea(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// road-infrastructure/junction-object-meshes.ts
import { roadLateralExtentAt as roadLateralExtentAt8 } from "./core.js";
import { triangulateCDT as triangulateCDT3 } from "./cdt/index.js";
function buildJunctionObjectMeshes(network) {
  return (network.objects ?? []).flatMap((object) => {
    if (object.kind !== "island" && object.kind !== "platform" || !object.junctionId || !object.polygon || object.polygon.length < 3)
      return [];
    const roads = network.roads.filter(({ junctionId }) => junctionId === object.junctionId);
    const samples = roads.flatMap(pavementHeightSamples2);
    const defaultHeight = object.kind === "platform" ? 0.25 : 0.15;
    return [extrudeIsland(object.id, object.junctionId, object.kind, object.polygon, object.height ?? defaultHeight, samples)];
  }).sort((left, right) => left.id.localeCompare(right.id));
}
function extrudeIsland(objectId, junctionId, kind, polygon, height, samples) {
  const ring = signedArea2(polygon) < 0 ? [...polygon].reverse() : polygon;
  const triangulation = triangulateCDT3({
    points: ring,
    polygons: [{ outer: ring.map((_, index) => index), holes: [] }]
  });
  const builder = new InfrastructureStructuralMeshBuilder;
  const bottoms = triangulation.points.map((point2) => builder.addVertex({ x: point2.x, y: point2.y, z: nearestHeight(point2, samples) }, point2.x, point2.y));
  const tops = triangulation.points.map((point2) => builder.addVertex({ x: point2.x, y: point2.y, z: nearestHeight(point2, samples) + height }, point2.x, point2.y));
  const ringVertices = ring.map((_, sourceIndex) => {
    const triangulatedIndex = triangulation.pointSources.findIndex((sources) => sources?.includes(sourceIndex));
    if (triangulatedIndex < 0)
      throw new Error(`Junction island ${objectId} lost boundary vertex ${sourceIndex}`);
    return triangulatedIndex;
  });
  for (let index = 0;index < triangulation.triangles.length; index += 3) {
    const a = triangulation.triangles[index];
    const b = triangulation.triangles[index + 1];
    const c = triangulation.triangles[index + 2];
    if (triangleArea2(triangulation.points[a], triangulation.points[b], triangulation.points[c]) > 0) {
      builder.addTriangle(tops[a], tops[b], tops[c]);
      builder.addTriangle(bottoms[a], bottoms[c], bottoms[b]);
    } else {
      builder.addTriangle(tops[a], tops[c], tops[b]);
      builder.addTriangle(bottoms[a], bottoms[b], bottoms[c]);
    }
  }
  for (let index = 0;index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    const currentVertex = ringVertices[index];
    const nextVertex = ringVertices[next];
    const current = triangulation.points[currentVertex];
    const nextPoint = triangulation.points[nextVertex];
    const currentBottom = builder.addVertex({ x: current.x, y: current.y, z: nearestHeight(current, samples) });
    const currentTop = builder.addVertex({ x: current.x, y: current.y, z: nearestHeight(current, samples) + height });
    const nextBottom = builder.addVertex({ x: nextPoint.x, y: nextPoint.y, z: nearestHeight(nextPoint, samples) });
    const nextTop = builder.addVertex({ x: nextPoint.x, y: nextPoint.y, z: nearestHeight(nextPoint, samples) + height });
    builder.addQuad(currentTop, currentBottom, nextBottom, nextTop);
  }
  return builder.build(`junction-${kind}|${objectId}`, kind === "platform" ? "platform" : "junction-island", kind === "platform" ? "platform-concrete" : "island-concrete", {
    sourceId: objectId,
    ownerId: junctionId,
    junctionId,
    rule: kind === "platform" ? "authored-junction-platform" : "authored-junction-island"
  });
}
function pavementHeightSamples2(road) {
  return stations(0, road.length, 1, true).flatMap((station) => {
    const extent = roadLateralExtentAt8(road, station);
    return [roadPoint(road, station, extent.minimumT), roadPoint(road, station, 0), roadPoint(road, station, extent.maximumT)];
  });
}
function nearestHeight(point2, samples) {
  let height = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const candidate = (sample.x - point2.x) ** 2 + (sample.y - point2.y) ** 2;
    if (candidate < distance) {
      distance = candidate;
      height = sample.z;
    }
  }
  return height;
}
function signedArea2(points) {
  return points.reduce((area, point2, index) => {
    const next = points[(index + 1) % points.length];
    return area + point2.x * next.y - next.x * point2.y;
  }, 0) / 2;
}
function triangleArea2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// road-infrastructure/loose-road-end-skirts.ts
import {
  laneHasVerticalEdge as laneHasVerticalEdge2,
  laneHeightAt as laneHeightAt2,
  laneOffsetsAt as laneOffsetsAt3,
  laneSurfacePointAt as laneSurfacePointAt3
} from "./core.js";
var MINIMUM_SKIRT_HEIGHT = 0.005;
function buildLooseRoadEndRaisedMeshes(network, physicalTopology) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  return resolveLooseRoadEndCaps(network, physicalTopology).flatMap((cap) => {
    const road = roads.get(cap.roadId);
    const section = road?.laneSections.find((candidate) => candidate.id === cap.sectionId);
    if (!road || !section)
      return [];
    return section.lanes.flatMap((lane) => {
      if (lane.id === 0)
        return [];
      const mesh = buildRaisedLaneEnd(road, section, lane, cap);
      return mesh ? [mesh] : [];
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
}
function buildRaisedLaneEnd(road, section, lane, cap) {
  const sectionLocalS = cap.station - section.s;
  const heights = laneHeightAt2(lane, sectionLocalS);
  if (Math.max(heights.inner, heights.outer) <= MINIMUM_SKIRT_HEIGHT)
    return;
  const raisedTopCover = needsRaisedTopCover(section, lane, sectionLocalS);
  const offsets = laneOffsetsAt3(section, lane.id, sectionLocalS);
  const startT = cap.endpoint === "end" ? Math.min(offsets.inner, offsets.outer) : Math.max(offsets.inner, offsets.outer);
  const endT = cap.endpoint === "end" ? Math.max(offsets.inner, offsets.outer) : Math.min(offsets.inner, offsets.outer);
  const builder = new InfrastructureStructuralMeshBuilder;
  const samples = sampleLooseRoadEndCap(cap, startT, endT).map(({ t, depth }) => skirtSample(road, section, lane, cap, offsets, heights, t, depth));
  appendArcSkirt(builder, samples);
  appendBoundaryFaces(builder, road, section, lane, cap, offsets, heights);
  if (raisedTopCover) {
    appendRaisedCapTop(builder, road, section, lane, cap, offsets, heights, startT, endT);
  }
  return builder.build(`${road.id}|loose-raised-cap:${cap.endpoint}|${section.id}|${lane.id}`, "raised-band", laneMaterialClass(lane), {
    sourceId: lane.sourceRole ?? `${section.id}|${lane.id}`,
    ownerId: road.id,
    roadId: road.id,
    junctionId: road.junctionId,
    rule: "loose-road-end-raised-cap"
  });
}
function appendArcSkirt(builder, samples) {
  for (let index = 0;index < samples.length - 1; index++) {
    const current = samples[index];
    const next = samples[index + 1];
    if (current.height <= MINIMUM_SKIRT_HEIGHT && next.height <= MINIMUM_SKIRT_HEIGHT)
      continue;
    const currentBottom = builder.addVertex(current.bottom, index, 0);
    const nextBottom = builder.addVertex(next.bottom, index + 1, 0);
    if (current.height <= MINIMUM_SKIRT_HEIGHT) {
      builder.addTriangle(currentBottom, nextBottom, builder.addVertex(next.top, index + 1, 1));
    } else if (next.height <= MINIMUM_SKIRT_HEIGHT) {
      builder.addTriangle(currentBottom, nextBottom, builder.addVertex(current.top, index, 1));
    } else {
      const nextTop = builder.addVertex(next.top, index + 1, 1);
      const currentTop = builder.addVertex(current.top, index, 1);
      builder.addQuad(currentBottom, nextBottom, nextTop, currentTop);
    }
  }
}
function appendRaisedCapTop(builder, road, section, lane, cap, offsets, heights, startT, endT) {
  const points = removeAdjacentPoints([
    skirtSample(road, section, lane, cap, offsets, heights, startT, 0).top,
    ...sampleLooseRoadEndCap(cap, startT, endT).map(({ t, depth }) => skirtSample(road, section, lane, cap, offsets, heights, t, depth).top),
    skirtSample(road, section, lane, cap, offsets, heights, endT, 0).top
  ]);
  if (points.length < 3)
    return;
  const vertices = points.map((point2, index) => builder.addVertex(point2, index / (points.length - 1), 0));
  for (let index = 1;index < vertices.length - 1; index++) {
    builder.addTriangle(vertices[0], vertices[index], vertices[index + 1]);
  }
}
function appendBoundaryFaces(builder, road, section, lane, cap, offsets, heights) {
  for (const boundary of ["inner", "outer"]) {
    if (!laneHasVerticalEdge2(lane, boundary))
      continue;
    const t = offsets[boundary];
    const depth = sampleLooseRoadEndCap(cap, t, t)[0]?.depth ?? 0;
    if (depth <= 0.0000001)
      continue;
    const ownerHeight = boundary === "inner" ? heights.inner : heights.outer;
    const owner = laneSurfacePointAt3(road, section, lane, cap.station, t, ownerHeight);
    const adjacent = adjacentBoundaryPoint(road, section, lane, boundary, cap.station);
    if (Math.abs(owner.z - adjacent.z) <= MINIMUM_SKIRT_HEIGHT)
      continue;
    const lower = owner.z <= adjacent.z ? owner : adjacent;
    const upper = owner.z <= adjacent.z ? adjacent : owner;
    const lowerBody = builder.addVertex(offsetOutward(lower, cap, 0), 0, 0);
    const lowerArc = builder.addVertex(offsetOutward(lower, cap, depth), depth, 0);
    const upperArc = builder.addVertex(offsetOutward(upper, cap, depth), depth, 1);
    const upperBody = builder.addVertex(offsetOutward(upper, cap, 0), 0, 1);
    const targetLeftSign = Math.sign(lane.id) * (boundary === "outer" ? 1 : -1);
    const defaultLeftSign = cap.endpoint === "end" ? -1 : 1;
    if (targetLeftSign === defaultLeftSign) {
      builder.addQuad(lowerBody, lowerArc, upperArc, upperBody);
    } else {
      builder.addQuad(upperBody, upperArc, lowerArc, lowerBody);
    }
  }
}
function needsRaisedTopCover(section, lane, sectionLocalS) {
  if (lane.verticalEdges)
    return true;
  const heights = laneHeightAt2(lane, sectionLocalS);
  return ["inner", "outer"].some((boundary) => {
    const neighbor = boundaryNeighbor(section, lane, boundary);
    if (!neighbor || !laneHasVerticalEdge2(neighbor.lane, neighbor.boundary))
      return false;
    const neighborHeights = laneHeightAt2(neighbor.lane, sectionLocalS);
    return heights[boundary] - neighborHeights[neighbor.boundary] > MINIMUM_SKIRT_HEIGHT;
  });
}
function adjacentBoundaryPoint(road, section, lane, boundary, station) {
  const neighbor = boundaryNeighbor(section, lane, boundary);
  if (neighbor) {
    const neighborOffsets = laneOffsetsAt3(section, neighbor.lane.id, station - section.s);
    const neighborHeights = laneHeightAt2(neighbor.lane, station - section.s);
    return laneSurfacePointAt3(road, section, neighbor.lane, station, neighborOffsets[neighbor.boundary], neighborHeights[neighbor.boundary]);
  }
  const ownerOffsets = laneOffsetsAt3(section, lane.id, station - section.s);
  return laneSurfacePointAt3(road, section, lane, station, ownerOffsets[boundary]);
}
function boundaryNeighbor(section, lane, boundary) {
  const direction = Math.sign(lane.id);
  const candidateId = boundary === "outer" ? lane.id + direction : lane.id - direction;
  if (candidateId === 0) {
    const opposite = section.lanes.find((candidate) => candidate.id === -lane.id);
    return opposite ? { lane: opposite, boundary: "inner" } : undefined;
  }
  const neighbor = section.lanes.find((candidate) => candidate.id === candidateId);
  return neighbor ? {
    lane: neighbor,
    boundary: boundary === "outer" ? "inner" : "outer"
  } : undefined;
}
function removeAdjacentPoints(points) {
  const result = [];
  for (const point2 of points) {
    const previous = result.at(-1);
    if (!previous || Math.hypot(point2.x - previous.x, point2.y - previous.y, point2.z - previous.z) > 0.00000001) {
      result.push(point2);
    }
  }
  return result;
}
function skirtSample(road, section, lane, cap, offsets, heights, t, depth) {
  const width = offsets.outer - offsets.inner;
  const ratio = Math.abs(width) <= 0.000000001 ? 0.5 : (t - offsets.inner) / width;
  const height = heights.inner + (heights.outer - heights.inner) * ratio;
  return {
    bottom: offsetOutward(laneSurfacePointAt3(road, section, lane, cap.station, t), cap, depth),
    top: offsetOutward(laneSurfacePointAt3(road, section, lane, cap.station, t, height), cap, depth),
    height
  };
}
function offsetOutward(point2, cap, depth) {
  return {
    x: point2.x + Math.cos(cap.outwardHeading) * depth,
    y: point2.y + Math.sin(cap.outwardHeading) * depth,
    z: point2.z + cap.outwardGrade * depth
  };
}
function laneMaterialClass(lane) {
  if (lane.surface === "asphalt")
    return "road";
  if (lane.surface === "platform")
    return "platform";
  if (lane.surface)
    return lane.surface;
  if (lane.type === "sidewalk")
    return "sidewalk";
  if (lane.type === "biking")
    return "cycleway";
  if (lane.type === "median")
    return "median";
  if (lane.type === "shoulder" || lane.type === "border")
    return "shoulder";
  if (lane.type === "rail")
    return "rail-bed";
  return "road";
}

// road-infrastructure/platform-band-meshes.ts
import { laneHeightAt as laneHeightAt3, laneOffsetsAt as laneOffsetsAt4, laneSurfacePointAt as laneSurfacePointAt4, laneWidthAt as laneWidthAt2 } from "./core.js";
var TACTILE_INSET = 0.22;
var TACTILE_WIDTH = 0.4;
var TACTILE_LIFT = 0.006;
var MINIMUM_HEIGHT_DIFFERENCE = 0.015;
var MAXIMUM_BOARDING_TRANSITION_WIDTH = 0.6;
function buildPlatformBandMeshes(network, options) {
  return network.roads.flatMap((road) => platformMeshesForRoad(road, options)).sort((left, right) => left.id.localeCompare(right.id));
}
function platformMeshesForRoad(road, options) {
  const sections = [...road.laneSections].sort((left, right) => left.s - right.s);
  return sections.flatMap((section, index) => {
    const sectionEnd = sections[index + 1]?.s ?? road.length;
    if (sectionEnd - section.s < 1)
      return [];
    return section.lanes.filter((lane) => lane.surface === "platform").flatMap((lane) => buildLanePlatform(road, section, lane, sectionEnd, options));
  });
}
function buildLanePlatform(road, section, lane, sectionEnd, options) {
  const stationValues = stations(section.s, sectionEnd, Math.min(1.5, options.structuralSampleLength), true);
  const provenance2 = {
    sourceId: lane.sourceRole ?? `${section.id}|${lane.id}`,
    ownerId: road.id,
    roadId: road.id,
    rule: "authored-platform-band"
  };
  const result = [];
  const skirt = platformSkirt(road, section, lane, stationValues);
  const skirtMesh = skirt.build(`${road.id}|platform-band|${section.id}|${lane.id}`, "platform", "platform-concrete", provenance2);
  if (skirtMesh)
    result.push(skirtMesh);
  const tactile = platformTactileBand(road, section, lane, stationValues);
  const tactileMesh = tactile.build(`${road.id}|platform-band-edge|${section.id}|${lane.id}`, "platform-edge", "tactile-paving", { ...provenance2, rule: "authored-platform-tactile-edge" });
  if (tactileMesh)
    result.push(tactileMesh);
  return result;
}
function platformSkirt(road, section, lane, stationValues) {
  const builder = new InfrastructureStructuralMeshBuilder;
  for (const boundary of ["inner", "outer"]) {
    const ratio = boundary === "inner" ? 0 : 1;
    const neighbor = adjacentLane(section, lane, boundary);
    const rings = stationValues.map((s) => {
      const topPoint = lanePoint(road, section, lane, s, ratio, 0);
      const bottomPoint = lowerBoundaryPoint(road, section, lane, neighbor, boundary, s);
      if (topPoint.z - bottomPoint.z < MINIMUM_HEIGHT_DIFFERENCE)
        return;
      const top = builder.addVertex(topPoint, s, 1);
      const bottom = builder.addVertex(bottomPoint, s, 0);
      return [bottom, top];
    });
    for (let index = 0;index < rings.length - 1; index++) {
      const current = rings[index];
      const next = rings[index + 1];
      if (!current || !next)
        continue;
      if (lane.id < 0 === (boundary === "outer")) {
        builder.addQuad(current[0], next[0], next[1], current[1]);
      } else {
        builder.addQuad(current[1], next[1], next[0], current[0]);
      }
    }
  }
  return builder;
}
function platformTactileBand(road, section, lane, stationValues) {
  const builder = new InfrastructureStructuralMeshBuilder;
  const boardingBoundaries = ["inner", "outer"].filter((boundary) => hasAdjacentTrack(section, lane, boundary, stationValues));
  for (const boundary of boardingBoundaries) {
    const rings = stationValues.map((s) => {
      const offsets = laneOffsetsAt4(section, lane.id, s - section.s);
      const laneWidth = Math.abs(offsets.outer - offsets.inner);
      if (laneWidth < TACTILE_INSET + TACTILE_WIDTH)
        return;
      const nearInset = TACTILE_INSET / laneWidth;
      const farInset = (TACTILE_INSET + TACTILE_WIDTH) / laneWidth;
      const startRatio = boundary === "inner" ? nearInset : 1 - nearInset;
      const endRatio = boundary === "inner" ? farInset : 1 - farInset;
      return [
        builder.addVertex(lanePoint(road, section, lane, s, startRatio, TACTILE_LIFT), s, 0),
        builder.addVertex(lanePoint(road, section, lane, s, endRatio, TACTILE_LIFT), s, 1)
      ];
    });
    const ratioDirection = boundary === "inner" ? 1 : -1;
    const regularWinding = Math.sign(lane.id) * ratioDirection > 0;
    for (let index = 0;index < rings.length - 1; index++) {
      const current = rings[index];
      const next = rings[index + 1];
      if (!current || !next)
        continue;
      if (regularWinding)
        builder.addQuad(current[0], next[0], next[1], current[1]);
      else
        builder.addQuad(current[1], next[1], next[0], current[0]);
    }
  }
  return builder;
}
function hasAdjacentTrack(section, platform, boundary, stationValues) {
  const laneStep = boundary === "inner" ? -Math.sign(platform.id) : Math.sign(platform.id);
  let candidateId = platform.id + laneStep;
  let transitionWidth = 0;
  while (candidateId !== 0) {
    const candidate = section.lanes.find((lane) => lane.id === candidateId);
    if (!candidate)
      return false;
    if (carriesTrack(candidate))
      return true;
    if (candidate.type !== "border")
      return false;
    transitionWidth += Math.max(...stationValues.map((s) => laneWidthAt2(candidate, s - section.s)));
    if (transitionWidth > MAXIMUM_BOARDING_TRANSITION_WIDTH)
      return false;
    candidateId += laneStep;
  }
  return false;
}
function carriesTrack(lane) {
  return lane.type === "rail" || lane.type === "tram" || lane.type === "driving" && lane.access?.includes("tram") === true;
}
function lanePoint(road, section, lane, s, ratio, extraHeight) {
  const offsets = laneOffsetsAt4(section, lane.id, s - section.s);
  const t = offsets.inner + (offsets.outer - offsets.inner) * ratio;
  return laneSurfacePointAt4(road, section, lane, s, t, laneHeight(lane, section, s, ratio) + extraHeight);
}
function laneHeight(lane, section, s, ratio) {
  const height = laneHeightAt3(lane, s - section.s);
  return height.inner + (height.outer - height.inner) * ratio;
}
function adjacentLane(section, lane, boundary) {
  const direction = Math.sign(lane.id);
  const id = boundary === "inner" ? lane.id - direction : lane.id + direction;
  return id === 0 ? undefined : section.lanes.find((candidate) => candidate.id === id);
}
function lowerBoundaryPoint(road, section, lane, neighbor, platformBoundary, s) {
  if (neighbor) {
    const neighborRatio = platformBoundary === "inner" ? 1 : 0;
    return lanePoint(road, section, neighbor, s, neighborRatio, 0);
  }
  const platformRatio = platformBoundary === "inner" ? 0 : 1;
  return lanePoint(road, section, lane, s, platformRatio, -laneHeight(lane, section, s, platformRatio));
}

// road-infrastructure/profile-transition-infrastructure.ts
import {
  profileTransitionCorridors,
  roadLateralExtentAt as roadLateralExtentAt9
} from "./core.js";
function buildProfileTransitionInfrastructure(network, semantics, collector, options) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const authoredBarrierRoadIds = new Set(options.authoredMotorwayBarrierRoadIds);
  const meshes = [];
  const medianJunctions = new Set;
  for (const corridor of profileTransitionCorridors(network)) {
    const road = roads.get(corridor.connectorRoadId);
    const sourceSemantics = corridor.sourceRoadIds.map((roadId) => semantics.get(roadId));
    if (!road || sourceSemantics.some((semantic) => !semantic?.motorwayLike))
      continue;
    if (corridor.position === "outer" && corridor.sourceLaneTypes.every((laneType) => laneType === "shoulder")) {
      if (!authoredBarrierRoadIds.has(road.id)) {
        const rail = buildTransitionGuardrail(road, corridor.junctionId, options);
        if (rail)
          meshes.push(rail);
        addTransitionGuardrailPosts(road, corridor.junctionId, collector);
      }
      continue;
    }
    if (corridor.position === "inner" && corridor.sourceLaneTypes.every((laneType) => laneType === "shoulder") && !medianJunctions.has(corridor.junctionId)) {
      medianJunctions.add(corridor.junctionId);
      const barrier = buildTransitionMedianBarrier(road, corridor.junctionId, options);
      if (barrier)
        meshes.push(barrier);
    }
  }
  return meshes;
}
function buildTransitionGuardrail(road, junctionId, options) {
  const builder = new InfrastructureStructuralMeshBuilder;
  appendAlignmentPrism(builder, {
    road,
    stationValues: transitionStations(road, options),
    lateralAt: (station) => roadLateralExtentAt9(road, station).minimumT,
    width: 0.12,
    bottomHeight: 0.48,
    topHeight: 0.68
  });
  return builder.build(`${road.id}|profile-transition-guardrail`, "guardrail-rail", "guardrail-galvanized", {
    sourceId: junctionId,
    ownerId: junctionId,
    roadId: road.id,
    junctionId,
    rule: "profile-transition-outer-guardrail"
  });
}
function addTransitionGuardrailPosts(road, junctionId, collector) {
  for (const station of stations(0, road.length, 2, true)) {
    const lateral = roadLateralExtentAt9(road, station).minimumT;
    collector.add("guardrail-post", "guardrail-galvanized", {
      id: `${road.id}|profile-transition-guardrail-post|${station.toFixed(3)}`,
      transform: roadTransform(road, station, lateral, { x: 0.1, y: 0.1, z: 0.75 }),
      provenance: {
        sourceId: junctionId,
        ownerId: junctionId,
        roadId: road.id,
        junctionId,
        station,
        rule: "profile-transition-outer-guardrail-post"
      }
    });
  }
}
function buildTransitionMedianBarrier(road, junctionId, options) {
  const builder = new InfrastructureStructuralMeshBuilder;
  const profile = [
    { lateral: -0.35, height: 0 },
    { lateral: -0.28, height: 0.25 },
    { lateral: -0.16, height: 0.9 },
    { lateral: 0.16, height: 0.9 },
    { lateral: 0.28, height: 0.25 },
    { lateral: 0.35, height: 0 }
  ];
  const rings = transitionStations(road, options).map((station) => profile.map(({ lateral, height }, profileIndex) => builder.addVertex(roadPoint(road, station, lateral, height), station, profileIndex / (profile.length - 1))));
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    for (let profileIndex = 0;profileIndex < profile.length; profileIndex++) {
      const following = (profileIndex + 1) % profile.length;
      builder.addQuad(current[profileIndex], next[profileIndex], next[following], current[following]);
    }
  }
  if (rings.length > 1) {
    const first = rings[0];
    const last = rings.at(-1);
    for (let index = 1;index < profile.length - 1; index++) {
      builder.addTriangle(first[0], first[index + 1], first[index]);
      builder.addTriangle(last[0], last[index], last[index + 1]);
    }
  }
  return builder.build(`${road.id}|profile-transition-median-barrier`, "concrete-median-barrier", "barrier-concrete", {
    sourceId: junctionId,
    ownerId: junctionId,
    roadId: road.id,
    junctionId,
    rule: "profile-transition-median-barrier"
  });
}
function transitionStations(road, options) {
  return stations(0, road.length, Math.min(2, options.structuralSampleLength), true);
}

// road-infrastructure/junction-assets.ts
import { roadLateralExtentAt as roadLateralExtentAt10 } from "./core.js";

// road-infrastructure/road-semantics.ts
var TRAFFIC_LANE_TYPES = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "bus",
  "shared"
]);
function classifyInfrastructureRoads(network, physicalTopology) {
  const initial = new Map(network.roads.map((road) => [road.id, baseSemantics(road)]));
  const motorwayIds = new Set([...initial.values()].filter((item) => item.motorwayLike).map((item) => item.road.id));
  const adjacency = roadAdjacency(network);
  for (const item of initial.values()) {
    const explicitRampLane = item.road.laneSections.some((section) => section.lanes.some((lane) => lane.type === "entry" || lane.type === "exit" || lane.type === "on-ramp" || lane.type === "off-ramp"));
    const connectedToMotorway = [...adjacency.get(item.road.id) ?? []].some((id) => motorwayIds.has(id));
    const designSpeed = maximumDesignSpeed(item.road);
    item.rampLike = item.oneWay && item.trafficLaneCount <= 2 && !item.motorwayLike && (explicitRampLane || connectedToMotorway && designSpeed >= 40 && designSpeed <= 100);
  }
  for (const corridor of physicalTopology.corridors) {
    if (!initial.has(corridor.roadId))
      throw new Error(`Infrastructure corridor ${corridor.roadId} has no road`);
  }
  return initial;
}
function trafficLanes(road) {
  return road.laneSections.flatMap((section) => section.lanes.filter((lane) => TRAFFIC_LANE_TYPES.has(lane.type)));
}
function junctionRoadIds(junction) {
  return new Set([
    ...(junction.ports ?? []).map((port) => port.roadId),
    ...junction.connections.flatMap((connection) => [connection.incomingRoadId, connection.connectingRoadId])
  ]);
}
function baseSemantics(road) {
  const sectionCounts = road.laneSections.map((section) => section.lanes.filter((lane) => TRAFFIC_LANE_TYPES.has(lane.type)).length);
  const lanes = trafficLanes(road);
  const directions = new Set(lanes.map(travelDirection));
  directions.delete(0);
  const oneWay = lanes.length > 0 && directions.size === 1 && !lanes.some((lane) => lane.direction === "both");
  const trafficLaneCount = Math.max(0, ...sectionCounts);
  const designSpeed = maximumDesignSpeed(road);
  const motorwayLike = oneWay ? trafficLaneCount >= 2 && designSpeed >= 100 : trafficLaneCount >= 4 && designSpeed > 100;
  return {
    road,
    trafficLaneCount,
    oneWay,
    motorwayLike,
    rampLike: false
  };
}
function travelDirection(lane) {
  if (lane.direction === "both")
    return 0;
  const standard = lane.id < 0 ? 1 : -1;
  return lane.direction === "reversed" ? -standard : standard;
}
function maximumDesignSpeed(road) {
  return Math.max(0, ...(road.designRanges ?? []).map((range) => range.limits.designSpeedKph ?? 0));
}
function roadAdjacency(network) {
  const adjacency = new Map(network.roads.map((road) => [road.id, new Set]));
  const connectGroup = (ids) => {
    const values = [...new Set(ids)];
    for (const source of values)
      for (const target of values)
        if (source !== target)
          adjacency.get(source)?.add(target);
  };
  for (const junction of network.junctions)
    connectGroup(junctionRoadIds(junction));
  for (const road of network.roads) {
    for (const link of [...road.links?.predecessors ?? [], ...road.links?.successors ?? []]) {
      if (link.roadId)
        connectGroup([road.id, link.roadId]);
    }
  }
  return adjacency;
}

// road-infrastructure/junction-assets.ts
function addJunctionInfrastructure(network, semantics, collector) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  for (const junction of network.junctions) {
    addTerminalProtections(junction, roads, collector);
    const roadIds = junctionRoadIds(junction);
    const motorwayRoads = [...roadIds].flatMap((id) => semantics.get(id)?.motorwayLike ? [roads.get(id)] : []);
    const rampRoads = [...roadIds].flatMap((id) => semantics.get(id)?.rampLike ? [roads.get(id)] : []);
    if (junction.kind === "direct" && motorwayRoads.length > 0 && rampRoads.length > 0) {
      addMotorwayExitAssets(junction, motorwayRoads, rampRoads, collector);
    }
    if (junction.kind === "common" && rampRoads.length > 0) {
      addRampJunctionAssets(junction, rampRoads, roads, collector);
    }
  }
}
function addMotorwayExitAssets(junction, motorwayRoads, rampRoads, collector) {
  const rampRoadIds = new Set(rampRoads.map((road) => road.id));
  const exitApproaches = motorwayRoads.filter((road) => junction.connections.some((connection) => connection.incomingRoadId === road.id && rampRoadIds.has(connection.connectingRoadId)));
  for (const road of exitApproaches) {
    const contact = contactStation(junction, road);
    const inwardDirection = contact <= road.length / 2 ? 1 : -1;
    const extent = roadLateralExtentAt10(road, contact);
    const signT = Math.abs(extent.minimumT) > Math.abs(extent.maximumT) ? -1 : 1;
    const outerT = signT < 0 ? extent.minimumT : extent.maximumT;
    for (const distance of [300, 200, 100]) {
      const s2 = contact + inwardDirection * Math.min(distance, Math.max(15, road.length * distance / 400));
      if (s2 <= 5 || s2 >= road.length - 5)
        continue;
      collector.add("exit-countdown-board", "sign-blue", {
        id: `${junction.id}|exit-countdown|${road.id}|${distance}`,
        transform: roadTransform(road, s2, outerT + signT * 2, { x: 0.3, y: 1.4, z: 2.2 }, 1.1),
        provenance: { sourceId: junction.id, ownerId: junction.id, roadId: road.id, junctionId: junction.id, station: s2, rule: "motorway-exit-countdown" }
      });
    }
    const advanceDistance = Math.min(150, road.length * 0.5);
    const s = Math.max(5, Math.min(road.length - 5, contact + inwardDirection * advanceDistance));
    collector.add("direction-board", "sign-blue", {
      id: `${junction.id}|direction-board|${road.id}`,
      transform: roadTransform(road, s, outerT + signT * 2.5, { x: 0.35, y: 3.5, z: 2.5 }, 1.25),
      provenance: { sourceId: junction.id, ownerId: junction.id, roadId: road.id, junctionId: junction.id, station: s, rule: "motorway-exit-direction-board" }
    });
  }
}
function addTerminalProtections(junction, roads, collector) {
  for (const protection of junction.terminalProtections ?? []) {
    const road = roads.get(protection.roadId);
    if (!road)
      continue;
    const station = contactStation(junction, road);
    const marking = junction.areaMarkings?.find(({ id }) => id === protection.areaMarkingId);
    const transform = marking && marking.polygon.length === 4 ? goreProtectionTransform(marking.polygon, roadPoint(road, station, 0).z) : roadTransform(road, station, 0, { x: 3, y: 0.8, z: 0.8 }, 0.1);
    collector.add(protection.kind, protection.kind === "crash-cushion" ? "crash-cushion-yellow" : "guardrail", {
      id: protection.id,
      transform,
      provenance: {
        sourceId: protection.id,
        ownerId: junction.id,
        roadId: road.id,
        junctionId: junction.id,
        station,
        rule: "authored-terminal-protection"
      }
    });
  }
}
function goreProtectionTransform(polygon, elevation) {
  const edges = polygon.map((point2, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return {
      index,
      length: Math.hypot(next.x - point2.x, next.y - point2.y),
      midpoint: { x: (point2.x + next.x) * 0.5, y: (point2.y + next.y) * 0.5 }
    };
  });
  const nose = [...edges].sort((left, right) => left.length - right.length)[0];
  const far = edges[(nose.index + 2) % edges.length];
  return {
    position: { x: nose.midpoint.x, y: nose.midpoint.y, z: elevation + 0.1 },
    rotation: yawQuaternion(Math.atan2(far.midpoint.y - nose.midpoint.y, far.midpoint.x - nose.midpoint.x)),
    scale: { x: 3, y: 0.8, z: 0.8 }
  };
}
function addRampJunctionAssets(junction, rampRoads, roads, collector) {
  const priorityPorts = new Set(junction.control?.kind === "priority" ? junction.control.priorityPortIds : []);
  for (const road of rampRoads) {
    const port = junction.ports?.find((candidate) => candidate.roadId === road.id);
    const contact = port?.s ?? (port?.contactPoint === "start" ? 0 : road.length);
    const inside = contact <= road.length / 2 ? Math.min(8, road.length * 0.15) : Math.max(0, road.length - Math.min(8, road.length * 0.15));
    const extent2 = roadLateralExtentAt10(road, inside);
    const outerT = Math.abs(extent2.minimumT) > Math.abs(extent2.maximumT) ? extent2.minimumT - 1 : extent2.maximumT + 1;
    if (!port || !priorityPorts.has(port.id)) {
      collector.add("yield-sign", "sign-regulatory", {
        id: `${junction.id}|yield|${road.id}`,
        transform: roadTransform(road, inside, outerT, { x: 0.12, y: 0.9, z: 2.2 }, 1.1),
        provenance: { sourceId: junction.id, ownerId: junction.id, roadId: road.id, junctionId: junction.id, station: inside, rule: "minor-ramp-priority-control" }
      });
    }
    collector.add("no-entry-sign", "sign-regulatory", {
      id: `${junction.id}|no-entry|${road.id}`,
      transform: roadTransform(road, inside, -outerT * 0.5, { x: 0.12, y: 0.7, z: 2.1 }, 1.05, Math.PI),
      provenance: { sourceId: junction.id, ownerId: junction.id, roadId: road.id, junctionId: junction.id, station: inside, rule: "one-way-ramp-wrong-way-control" }
    });
  }
  const ports = junction.ports ?? [];
  for (const [index, port] of ports.entries()) {
    const road = roads.get(port.roadId);
    if (!road)
      continue;
    const s2 = port.s ?? (port.contactPoint === "start" ? 0 : road.length);
    const extent2 = roadLateralExtentAt10(road, s2);
    const t = index % 2 === 0 ? extent2.maximumT + 2 : extent2.minimumT - 2;
    collector.add("lighting-pole", "lighting-galvanized", {
      id: `${junction.id}|lighting-pole|${port.id}`,
      transform: roadTransform(road, s2, t, { x: 0.18, y: 0.18, z: 9 }),
      provenance: { sourceId: junction.id, ownerId: junction.id, roadId: road.id, junctionId: junction.id, station: s2, rule: "ramp-junction-lighting" }
    });
  }
  const anchor = rampRoads[0];
  if (!anchor)
    return;
  const s = contactStation(junction, anchor);
  const extent = roadLateralExtentAt10(anchor, s);
  collector.add("sensor-pole", "sensor-galvanized", {
    id: `${junction.id}|sensor-pole`,
    transform: roadTransform(anchor, s, extent.maximumT + 3, { x: 0.12, y: 0.12, z: 6 }),
    provenance: { sourceId: junction.id, ownerId: junction.id, roadId: anchor.id, junctionId: junction.id, station: s, rule: "ramp-junction-traffic-sensor" }
  });
  collector.add("utility-cabinet", "utility-cabinet-grey", {
    id: `${junction.id}|utility-cabinet`,
    transform: roadTransform(anchor, s, extent.maximumT + 4, { x: 0.8, y: 0.5, z: 1.4 }),
    provenance: { sourceId: junction.id, ownerId: junction.id, roadId: anchor.id, junctionId: junction.id, station: s, rule: "ramp-junction-utility-cabinet" }
  });
}
function contactStation(junction, road) {
  const port = junction.ports?.find((candidate) => candidate.roadId === road.id);
  if (port?.s !== undefined)
    return port.s;
  if (port)
    return port.contactPoint === "start" ? 0 : road.length;
  const connection = junction.connections.find((candidate) => candidate.incomingRoadId === road.id || candidate.connectingRoadId === road.id);
  if (!connection)
    return road.length / 2;
  if (connection.incomingRoadId === road.id)
    return connection.incomingS ?? (connection.incomingContactPoint === "start" ? 0 : road.length);
  return connection.connectingS ?? (connection.contactPoint === "start" ? 0 : road.length);
}

// road-infrastructure/junction-structure-meshes.ts
import { roadLateralExtentAt as roadLateralExtentAt11, tessellateJunctionPhysicalTopology as tessellateJunctionPhysicalTopology2 } from "./core.js";
import { triangulateCDT as triangulateCDT4 } from "./cdt/index.js";
var PORT_EDGE_CLEARANCE = 1.2;
var CONTACT_REACH_TOLERANCE = 0.5;
function junctionAssemblySurfaces(network, physicalTopology, terrainElevation) {
  if (!hasElevatedJunctionRoad(network, terrainElevation))
    return [];
  return tessellateJunctionPhysicalTopology2(network, physicalTopology, { step: 1 }).assemblySurfaces.map((assembly) => ({ junctionId: assembly.junctionId, components: assembly.components }));
}
function hasElevatedJunctionRoad(network, terrainElevation) {
  return network.roads.some((road) => road.junctionId && roadElevationRange(road).maximum > terrainElevation + 0.5);
}
function roadElevationRange(road) {
  const values = [0, road.length].flatMap((station) => {
    const record = [...road.elevation ?? []].filter((candidate) => candidate.s <= station + 0.0000001).sort((left, right) => left.s - right.s).at(-1);
    if (!record)
      return [0];
    const offset = station - record.s;
    return [record.a + record.b * offset + record.c * offset ** 2 + record.d * offset ** 3];
  });
  return { minimum: Math.min(...values), maximum: Math.max(...values) };
}
function structuralJunctionIds(network, physicalTopology) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const result = new Set;
  for (const junction of network.junctions) {
    const contacts = junctionPortContacts(network, junction);
    if (contacts.length < 2)
      continue;
    const allBridged = contacts.every((contact) => structureReaching(physicalTopology.roadStructures, roads, contact) !== undefined);
    if (allBridged)
      result.add(junction.id);
  }
  return result;
}
function junctionPortContacts(network, junction) {
  const contacts = new Map;
  const add = (roadId, contactPoint) => contacts.set(`${roadId}|${contactPoint}`, { roadId, contactPoint });
  for (const port of junction.ports ?? []) {
    const road = network.roads.find(({ id }) => id === port.roadId);
    if (!road)
      continue;
    const s = port.s ?? (port.contactPoint === "start" ? 0 : road.length);
    const atEndpoint = s <= CONTACT_REACH_TOLERANCE || s >= road.length - CONTACT_REACH_TOLERANCE;
    if (atEndpoint)
      add(port.roadId, s <= CONTACT_REACH_TOLERANCE ? "start" : "end");
  }
  for (const road of network.roads) {
    if (road.junctionId)
      continue;
    if ((road.links?.predecessors ?? []).some((link) => link.junctionId === junction.id))
      add(road.id, "start");
    if ((road.links?.successors ?? []).some((link) => link.junctionId === junction.id))
      add(road.id, "end");
  }
  return [...contacts.values()];
}
function structureReaching(structures, roads, contact) {
  const road = roads.get(contact.roadId);
  if (!road)
    return;
  return structures.find((structure) => {
    if (structure.kind !== "bridge" || structure.roadId !== contact.roadId)
      return false;
    return contact.contactPoint === "start" ? structure.sStart <= CONTACT_REACH_TOLERANCE : structure.sEnd >= road.length - CONTACT_REACH_TOLERANCE;
  });
}
function continuingStructureEnds(network, physicalTopology, junctionIds) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const structuralJunctions = network.junctions.filter(({ id }) => junctionIds.has(id));
  const result = new Set;
  for (const structure of physicalTopology.roadStructures) {
    if (structure.kind !== "bridge")
      continue;
    const road = roads.get(structure.roadId);
    if (!road)
      continue;
    for (const end of ["start", "end"]) {
      const contactS = end === "start" ? structure.sStart : structure.sEnd;
      const endpoint = contactS <= CONTACT_REACH_TOLERANCE ? "start" : contactS >= road.length - CONTACT_REACH_TOLERANCE ? "end" : undefined;
      if (!endpoint)
        continue;
      if (continuesAtEndpoint(network, physicalTopology, roads, structuralJunctions, road, endpoint)) {
        result.add(`${structure.id}|${end}`);
      }
    }
  }
  return result;
}
function continuesAtEndpoint(network, physicalTopology, roads, structuralJunctions, road, endpoint) {
  const junctionBacked = structuralJunctions.some((junction) => junctionPortContacts(network, junction).some((contact) => contact.roadId === road.id && contact.contactPoint === endpoint));
  if (junctionBacked)
    return true;
  const links = endpoint === "start" ? road.links?.predecessors : road.links?.successors;
  return (links ?? []).some((link) => link.roadId !== undefined && structureReaching(physicalTopology.roadStructures, roads, {
    roadId: link.roadId,
    contactPoint: link.contactPoint
  }) !== undefined);
}
function buildJunctionStructureMeshes(network, physicalTopology, assemblies, options) {
  const junctionIds = structuralJunctionIds(network, physicalTopology);
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const meshes = [];
  const assembledJunctionIds = new Set(assemblies.map(({ junctionId }) => junctionId));
  for (const junctionId of junctionIds) {
    if (assembledJunctionIds.has(junctionId))
      continue;
    meshes.push(...buildConnectorCorridorStructures(network, physicalTopology, roads, junctionId, options));
  }
  for (const assembly of assemblies) {
    if (!junctionIds.has(assembly.junctionId))
      continue;
    const junction = network.junctions.find(({ id }) => id === assembly.junctionId);
    const topology = physicalTopology.junctions.find((candidate) => candidate.junctionId === assembly.junctionId);
    if (!junction)
      continue;
    const contacts = junctionPortContacts(network, junction);
    const depth = Math.max(0.7, ...contacts.flatMap((contact) => {
      const structure = structureReaching(physicalTopology.roadStructures, roads, contact);
      return structure ? [deckDepth(structure)] : [];
    }));
    const memberRoadIds = new Set(topology?.roadIds ?? []);
    const heightRoads = network.roads.filter((road) => road.junctionId === assembly.junctionId || memberRoadIds.has(road.id));
    const heightSamples = heightRoads.flatMap(pavementHeightSamples3);
    const elevationAt = (point2) => smoothSurfaceHeight(point2, heightSamples);
    const portSegments = contacts.flatMap((contact) => {
      const road = roads.get(contact.roadId);
      if (!road)
        return [];
      const s = contact.contactPoint === "start" ? 0 : road.length;
      const extent = roadLateralExtentAt11(road, s);
      return [{
        a: roadPoint(road, s, extent.minimumT),
        b: roadPoint(road, s, extent.maximumT)
      }];
    });
    assembly.components.forEach((component, componentIndex) => {
      const deck = buildJunctionDeck(assembly.junctionId, componentIndex, component, elevationAt, depth);
      if (deck)
        meshes.push(deck);
      meshes.push(...buildJunctionParapets(assembly.junctionId, componentIndex, component.outer, elevationAt, portSegments));
    });
  }
  return { meshes, structuralJunctionIds: junctionIds };
}
function buildConnectorCorridorStructures(network, physicalTopology, roads, junctionId, options) {
  const junction = network.junctions.find(({ id }) => id === junctionId);
  if (!junction)
    return [];
  const contacts = junctionPortContacts(network, junction);
  const depth = Math.max(0.7, ...contacts.flatMap((contact) => {
    const structure = structureReaching(physicalTopology.roadStructures, roads, contact);
    return structure ? [deckDepth(structure)] : [];
  }));
  const corridorRoads = network.roads.filter((road) => road.junctionId === junctionId && road.length > 0.05);
  const meshes = [];
  for (const road of corridorRoads) {
    const pseudo = {
      id: `${junctionId}|corridor|${road.id}`,
      roadId: road.id,
      kind: "bridge",
      sStart: 0,
      sEnd: road.length,
      deckTMin: 0,
      deckTMax: 0,
      structuralThickness: depth,
      minimumLateralClearance: 0.02,
      lateralExtentMode: "road-surface",
      actualMinimumT: 0,
      actualMaximumT: 0,
      actualMinimumLateralClearance: 0
    };
    const stationValues = stations(0, road.length, Math.min(2.5, options.structuralSampleLength), true);
    const deck = buildDeck(pseudo, road, stationValues);
    if (deck) {
      deck.provenance.rule = "junction-continuity-deck";
      meshes.push(deck);
    }
    const siblings = corridorRoads.filter((candidate) => candidate.id !== road.id);
    const siblingSamples = siblings.flatMap(pavementHeightSamples3);
    for (const side of ["left", "right"]) {
      if (!corridorSideIsFree(road, side, siblingSamples))
        continue;
      const parapets = buildParapet(pseudo, road, side, stationValues, options);
      for (const parapet of parapets)
        parapet.provenance.rule = "junction-continuity-parapet";
      meshes.push(...parapets);
    }
  }
  return meshes;
}
function corridorSideIsFree(road, side, siblingSamples) {
  if (siblingSamples.length === 0)
    return true;
  const probes = stations(0, road.length, Math.max(1, road.length / 4), true).map((s) => {
    const extent = roadLateralExtentAt11(road, s);
    const edge = side === "left" ? extent.maximumT + 0.6 : extent.minimumT - 0.6;
    return roadPoint(road, s, edge);
  });
  return probes.every((probe) => siblingSamples.every((sample) => Math.hypot(sample.x - probe.x, sample.y - probe.y) > 0.9));
}
function buildJunctionDeck(junctionId, componentIndex, component, elevationAt, depth) {
  const rings = [normalizeRing2(component.outer, false), ...component.holes.map((hole) => normalizeRing2(hole, true))];
  const points = rings.flat();
  const offsets = [];
  let offset = 0;
  for (const ring of rings) {
    offsets.push(offset);
    offset += ring.length;
  }
  const ringIndices = rings.map((ring, index) => ring.map((_, pointIndex) => offsets[index] + pointIndex));
  const triangulation = triangulateCDT4({
    points,
    polygons: [{ outer: ringIndices[0], holes: ringIndices.slice(1) }]
  });
  const builder = new InfrastructureStructuralMeshBuilder;
  const topZ = (point2) => elevationAt(point2) - 0.04;
  const topVertices = triangulation.points.map((point2) => builder.addVertex({ x: point2.x, y: point2.y, z: topZ(point2) }, point2.x, point2.y));
  const bottomVertices = triangulation.points.map((point2) => builder.addVertex({ x: point2.x, y: point2.y, z: topZ(point2) - depth }, point2.x, point2.y));
  const capEdges = new Map;
  for (let index = 0;index < triangulation.triangles.length; index += 3) {
    const a = triangulation.triangles[index];
    const b = triangulation.triangles[index + 1];
    const c = triangulation.triangles[index + 2];
    if (triangleArea3(triangulation.points[a], triangulation.points[b], triangulation.points[c]) > 0) {
      builder.addTriangle(topVertices[a], topVertices[b], topVertices[c]);
      builder.addTriangle(bottomVertices[a], bottomVertices[c], bottomVertices[b]);
      addCapEdges2(capEdges, a, b, c);
    } else {
      builder.addTriangle(topVertices[a], topVertices[c], topVertices[b]);
      builder.addTriangle(bottomVertices[a], bottomVertices[b], bottomVertices[c]);
      addCapEdges2(capEdges, a, c, b);
    }
  }
  for (const edge of capEdges.values()) {
    if (edge.count !== 1)
      continue;
    builder.addQuad(topVertices[edge.start], bottomVertices[edge.start], bottomVertices[edge.end], topVertices[edge.end]);
  }
  return builder.build(`junction-structure|${junctionId}|${componentIndex}|deck`, "bridge-deck", "bridge-concrete", { sourceId: junctionId, ownerId: junctionId, junctionId, rule: "junction-continuity-deck" });
}
function buildJunctionParapets(junctionId, componentIndex, outer, elevationAt, portSegments) {
  const ring = normalizeRing2(outer, false);
  const kept = ring.map((point2, index) => {
    const next = ring[(index + 1) % ring.length];
    const midpoint = { x: (point2.x + next.x) / 2, y: (point2.y + next.y) / 2 };
    return portSegments.every((segment) => pointSegmentDistance2(midpoint, segment.a, segment.b) > PORT_EDGE_CLEARANCE);
  });
  const chains = keptEdgeChains(ring, kept);
  const concrete = new InfrastructureStructuralMeshBuilder;
  const steel = new InfrastructureStructuralMeshBuilder;
  for (const chain of chains) {
    if (chainLength(chain) < 1)
      continue;
    appendPolylinePrism(concrete, chain, elevationAt, 0.03, 0.27, -0.06, 0.55);
    appendPolylinePrism(steel, chain, elevationAt, 0.1, 0.17, 1.02, 1.1);
  }
  const provenance2 = { sourceId: junctionId, ownerId: junctionId, junctionId, rule: "junction-continuity-parapet" };
  const meshes = [
    concrete.build(`junction-structure|${junctionId}|${componentIndex}|parapet`, "bridge-parapet", "parapet-concrete", provenance2),
    steel.build(`junction-structure|${junctionId}|${componentIndex}|parapet-railing`, "bridge-parapet", "railing-steel", provenance2)
  ];
  return meshes.filter((mesh) => mesh !== undefined);
}
function keptEdgeChains(ring, kept) {
  if (kept.every(Boolean))
    return [[...ring, ring[0]]];
  const chains = [];
  const count = ring.length;
  const firstSkipped = kept.findIndex((value) => !value);
  let chain;
  for (let step = 0;step < count; step++) {
    const index = (firstSkipped + step) % count;
    if (kept[index]) {
      if (!chain)
        chain = [ring[index]];
      chain.push(ring[(index + 1) % count]);
    } else if (chain) {
      chains.push(chain);
      chain = undefined;
    }
  }
  if (chain)
    chains.push(chain);
  return chains;
}
function chainLength(chain) {
  let length2 = 0;
  for (let index = 0;index < chain.length - 1; index++) {
    length2 += Math.hypot(chain[index + 1].x - chain[index].x, chain[index + 1].y - chain[index].y);
  }
  return length2;
}
function appendPolylinePrism(builder, chain, elevationAt, nearOffset, farOffset, bottomHeight, topHeight) {
  const rings = chain.map((point2, index) => {
    const previous = chain[Math.max(0, index - 1)];
    const next = chain[Math.min(chain.length - 1, index + 1)];
    const direction = normalize2({ x: next.x - previous.x, y: next.y - previous.y });
    const left = { x: -direction.y, y: direction.x };
    const surfaceZ = elevationAt(point2);
    const at = (offset, height) => ({
      x: point2.x + left.x * offset,
      y: point2.y + left.y * offset,
      z: surfaceZ + height
    });
    return [
      builder.addVertex(at(nearOffset, topHeight), index, 0),
      builder.addVertex(at(farOffset, topHeight), index, 1),
      builder.addVertex(at(farOffset, bottomHeight), index, 1),
      builder.addVertex(at(nearOffset, bottomHeight), index, 0)
    ];
  });
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    builder.addQuad(current[0], next[0], next[1], current[1]);
    builder.addQuad(current[3], current[2], next[2], next[3]);
    builder.addQuad(current[0], current[3], next[3], next[0]);
    builder.addQuad(current[1], next[1], next[2], current[2]);
  }
  if (rings.length > 1) {
    const first = rings[0];
    const last = rings.at(-1);
    builder.addQuad(first[0], first[1], first[2], first[3]);
    builder.addQuad(last[3], last[2], last[1], last[0]);
  }
}
function addCapEdges2(edges, a, b, c) {
  for (const [start, end] of [[a, b], [b, c], [c, a]]) {
    const key = start < end ? `${start}|${end}` : `${end}|${start}`;
    const existing = edges.get(key);
    if (existing)
      existing.count++;
    else
      edges.set(key, { start, end, count: 1 });
  }
}
function normalize2(vector) {
  const magnitude = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / magnitude, y: vector.y / magnitude };
}
function pointSegmentDistance2(point2, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  const t = lengthSquared < 0.000000000001 ? 0 : Math.max(0, Math.min(1, ((point2.x - a.x) * abx + (point2.y - a.y) * aby) / lengthSquared));
  return Math.hypot(point2.x - (a.x + abx * t), point2.y - (a.y + aby * t));
}
function pavementHeightSamples3(road) {
  const sampledStations2 = stations(0, road.length, 1, true);
  return [-1, 0, 1].flatMap((side) => sampledStations2.map((station) => {
    const extent = roadLateralExtentAt11(road, station);
    const lateralOffset = side < 0 ? extent.minimumT : side > 0 ? extent.maximumT : 0;
    return roadPoint(road, station, lateralOffset);
  }));
}
function normalizeRing2(points, hole) {
  const area = signedArea3(points);
  const shouldReverse = hole ? area > 0 : area < 0;
  return shouldReverse ? [...points].reverse() : [...points];
}
function signedArea3(points) {
  let area = 0;
  for (let index = 0;index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}
function triangleArea3(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// road-infrastructure/railway-track-meshes.ts
import { laneCenterOffsetAt, laneOffsetsAt as laneOffsetsAt5, laneWidthAt as laneWidthAt3 } from "./core.js";
var RAIL_CENTER_OFFSET = 1.435 / 2;
var BALLAST_HEIGHT = 0.35;
var BALLAST_SHOULDER_RUN = 0.55;
var SLEEPER_LENGTH = 2.6;
var SLEEPER_WIDTH = 0.26;
var SLEEPER_SPACING = 0.65;
var SLEEPER_BOTTOM = BALLAST_HEIGHT - 0.03;
var SLEEPER_TOP = BALLAST_HEIGHT + 0.17;
var RAIL_BASE = SLEEPER_TOP;
var RAIL_PROFILE = [
  { t: -0.075, h: 0 },
  { t: -0.06, h: 0.028 },
  { t: -0.012, h: 0.05 },
  { t: -0.012, h: 0.12 },
  { t: -0.036, h: 0.134 },
  { t: -0.036, h: 0.172 },
  { t: 0.036, h: 0.172 },
  { t: 0.036, h: 0.134 },
  { t: 0.012, h: 0.12 },
  { t: 0.012, h: 0.05 },
  { t: 0.06, h: 0.028 },
  { t: 0.075, h: 0 }
];
var MINIMUM_RAIL_LANE_WIDTH = 2.8;
function buildRailwayTrackMeshes(network, options) {
  const result = [];
  for (const road of network.roads) {
    const sections = [...road.laneSections].sort((left, right) => left.s - right.s);
    sections.forEach((section, index) => {
      const sectionEnd = sections[index + 1]?.s ?? road.length;
      if (sectionEnd - section.s < 1)
        return;
      for (const lane of section.lanes) {
        if (lane.type !== "rail")
          continue;
        result.push(...buildLaneTrack(road, section, lane, sectionEnd, options));
      }
    });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}
function buildLaneTrack(road, section, lane, sectionEnd, options) {
  const midWidth = laneWidthAt3(lane, (section.s + sectionEnd) / 2 - section.s);
  if (midWidth < MINIMUM_RAIL_LANE_WIDTH)
    return [];
  const spacing = road.junctionId ? 1 : Math.min(2.5, options.structuralSampleLength);
  const stationValues = stations(section.s, sectionEnd, spacing, true);
  if (stationValues.length < 2)
    return [];
  const pointAt2 = (s, t, h) => surfacePointAt(road, section, s, t, h);
  const provenance2 = (rule) => ({
    sourceId: `${section.id}|${lane.id}`,
    ownerId: road.id,
    roadId: road.id,
    junctionId: road.junctionId,
    rule
  });
  const ballast = new InfrastructureStructuralMeshBuilder;
  appendSweptProfile(ballast, {
    road,
    stationValues,
    capEnds: true,
    pointAt: pointAt2,
    profileAt: (s) => ballastProfile(section, lane, s)
  });
  const sleepers = new InfrastructureStructuralMeshBuilder;
  const centerAt = (s) => laneCenterOffsetAt(section, lane.id, s - section.s);
  for (const s of stations(section.s + SLEEPER_SPACING / 2, sectionEnd - SLEEPER_SPACING / 2, SLEEPER_SPACING)) {
    appendAlignmentPrism(sleepers, {
      road,
      stationValues: [s - SLEEPER_WIDTH / 2, s + SLEEPER_WIDTH / 2],
      lateralAt: centerAt,
      width: SLEEPER_LENGTH,
      bottomHeight: SLEEPER_BOTTOM,
      topHeight: SLEEPER_TOP,
      pointAt: pointAt2
    });
  }
  const rails = new InfrastructureStructuralMeshBuilder;
  for (const railSide of [-1, 1]) {
    appendSweptProfile(rails, {
      road,
      stationValues,
      pointAt: pointAt2,
      profileAt: (s) => {
        const railCenter = centerAt(s) + railSide * RAIL_CENTER_OFFSET;
        return RAIL_PROFILE.map(({ t, h }) => ({ t: railCenter + t, h: RAIL_BASE + h }));
      }
    });
  }
  const prefix = `${road.id}|railway|${section.id}|${lane.id}`;
  const meshes = [
    ballast.build(`${prefix}|ballast`, "rail-ballast", "ballast-gravel", provenance2("railway-ballast-bed")),
    sleepers.build(`${prefix}|sleepers`, "rail-sleepers", "sleeper-concrete", provenance2("railway-sleepers")),
    rails.build(`${prefix}|rails`, "railway-rail", "rail-steel", provenance2("railway-vignol-rails"))
  ];
  return meshes.filter((mesh) => mesh !== undefined);
}
function ballastProfile(section, lane, s) {
  const offsets = laneOffsetsAt5(section, lane.id, s - section.s);
  const minimumT = Math.min(offsets.inner, offsets.outer);
  const maximumT = Math.max(offsets.inner, offsets.outer);
  const shoulder = Math.min(BALLAST_SHOULDER_RUN, (maximumT - minimumT) / 4);
  return [
    { t: minimumT, h: 0 },
    { t: minimumT + shoulder, h: BALLAST_HEIGHT },
    { t: maximumT - shoulder, h: BALLAST_HEIGHT },
    { t: maximumT, h: 0 }
  ];
}

// road-infrastructure/raised-band-meshes.ts
import {
  laneBoundarySurfacePointAt,
  laneHasVerticalEdge as laneHasVerticalEdge3,
  laneHeightAt as laneHeightAt5,
  laneOffsetsAt as laneOffsetsAt7,
  laneSurfacePointAt as laneSurfacePointAt6
} from "./core.js";

// road-infrastructure/planted-median-meshes.ts
import { laneHeightAt as laneHeightAt4, laneOffsetsAt as laneOffsetsAt6, laneSurfacePointAt as laneSurfacePointAt5 } from "./core.js";
var CURB_BEVEL_WIDTH = 0.055;
var CURB_CAP_WIDTH = 0.18;
var SOIL_EDGE_WIDTH = 0.32;
var SOIL_LIFT = 0.006;
function buildPlantedMedianMeshes(road, section, lane, stationValues) {
  const curb = new InfrastructureStructuralMeshBuilder;
  const soil = new InfrastructureStructuralMeshBuilder;
  const bed = new InfrastructureStructuralMeshBuilder;
  for (const boundary of ["inner", "outer"]) {
    const curbRings = stationValues.map((s) => curbProfile(curb, road, section, lane, boundary, s));
    appendProfileStrips(curb, curbRings, lane.id, boundary);
    const soilRings = stationValues.map((s) => soilProfile(soil, road, section, lane, boundary, s));
    appendTopStrip(soil, soilRings, lane.id);
  }
  const bedRings = stationValues.map((s) => plantedBedProfile(bed, road, section, lane, s));
  appendTopStrip(bed, bedRings, lane.id);
  const provenance2 = {
    sourceId: lane.sourceRole ?? `${section.id}|${lane.id}`,
    ownerId: road.id,
    roadId: road.id,
    junctionId: road.junctionId
  };
  return [
    curb.build(`${road.id}|planted-median-curb|${section.id}|${lane.id}`, "raised-band", "median-curb-weathered-concrete", { ...provenance2, rule: "planted-median-curb-profile" }),
    soil.build(`${road.id}|planted-median-soil|${section.id}|${lane.id}`, "raised-band", "median-soil-edge", { ...provenance2, rule: "planted-median-soil-shoulder" }),
    bed.build(`${road.id}|planted-median-bed|${section.id}|${lane.id}`, "raised-band", "grass", { ...provenance2, rule: "planted-median-surface-bed" })
  ].filter((mesh) => mesh !== undefined);
}
function plantedBedProfile(builder, road, section, lane, s) {
  const width = laneWidth(section, lane, s);
  const inset = Math.min(SOIL_EDGE_WIDTH, width * 0.35);
  const inner = insetRatio("inner", inset, width);
  const outer = insetRatio("outer", inset, width);
  return [
    builder.addVertex(lanePoint2(road, section, lane, s, inner, SOIL_LIFT * 0.5), s, 0),
    builder.addVertex(lanePoint2(road, section, lane, s, outer, SOIL_LIFT * 0.5), s, 1)
  ];
}
function curbProfile(builder, road, section, lane, boundary, s) {
  const width = laneWidth(section, lane, s);
  const bevelRatio = insetRatio(boundary, Math.min(CURB_BEVEL_WIDTH, width * 0.08), width);
  const capRatio = insetRatio(boundary, Math.min(CURB_CAP_WIDTH, width * 0.18), width);
  const edgeRatio = boundary === "inner" ? 0 : 1;
  return [
    builder.addVertex(adjacentBoundaryPoint2(road, section, lane, boundary, s), s, 0),
    builder.addVertex(lanePoint2(road, section, lane, s, edgeRatio, -0.025), s, 0.3),
    builder.addVertex(lanePoint2(road, section, lane, s, bevelRatio, 0), s, 0.72),
    builder.addVertex(lanePoint2(road, section, lane, s, capRatio, 0.004), s, 1)
  ];
}
function soilProfile(builder, road, section, lane, boundary, s) {
  const width = laneWidth(section, lane, s);
  const capRatio = insetRatio(boundary, Math.min(CURB_CAP_WIDTH, width * 0.18), width);
  const soilRatio = insetRatio(boundary, Math.min(SOIL_EDGE_WIDTH, width * 0.35), width);
  const low = Math.min(capRatio, soilRatio);
  const high = Math.max(capRatio, soilRatio);
  return [
    builder.addVertex(lanePoint2(road, section, lane, s, low, SOIL_LIFT), s, 0),
    builder.addVertex(lanePoint2(road, section, lane, s, high, SOIL_LIFT), s, 1)
  ];
}
function appendProfileStrips(builder, rings, laneId, boundary) {
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    for (let profile = 0;profile < current.length - 1; profile++) {
      if (laneId < 0 === (boundary === "outer")) {
        builder.addQuad(current[profile], next[profile], next[profile + 1], current[profile + 1]);
      } else {
        builder.addQuad(current[profile + 1], next[profile + 1], next[profile], current[profile]);
      }
    }
  }
}
function appendTopStrip(builder, rings, laneId) {
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    if (laneId > 0)
      builder.addQuad(current[0], next[0], next[1], current[1]);
    else
      builder.addQuad(current[1], next[1], next[0], current[0]);
  }
}
function laneWidth(section, lane, s) {
  const offsets = laneOffsetsAt6(section, lane.id, s - section.s);
  return Math.max(0.01, Math.abs(offsets.outer - offsets.inner));
}
function insetRatio(boundary, inset, width) {
  const fraction = Math.min(0.48, inset / width);
  return boundary === "inner" ? fraction : 1 - fraction;
}
function adjacentBoundaryPoint2(road, section, lane, boundary, s) {
  const neighbor = boundaryNeighbor2(section, lane, boundary);
  if (neighbor)
    return lanePoint2(road, section, neighbor.lane, s, neighbor.ratio, 0);
  const ratio = boundary === "inner" ? 0 : 1;
  return lanePoint2(road, section, lane, s, ratio, -laneHeight2(lane, section, s, ratio));
}
function boundaryNeighbor2(section, lane, boundary) {
  const direction = Math.sign(lane.id);
  const candidateId = boundary === "outer" ? lane.id + direction : lane.id - direction;
  if (candidateId !== 0) {
    const candidate = section.lanes.find((item) => item.id === candidateId);
    return candidate ? { lane: candidate, ratio: boundary === "outer" ? 0 : 1 } : undefined;
  }
  const opposite = section.lanes.find((item) => item.id === -lane.id);
  return opposite ? { lane: opposite, ratio: 0 } : undefined;
}
function lanePoint2(road, section, lane, s, ratio, extraHeight) {
  const offsets = laneOffsetsAt6(section, lane.id, s - section.s);
  const t = offsets.inner + (offsets.outer - offsets.inner) * ratio;
  return laneSurfacePointAt5(road, section, lane, s, t, laneHeight2(lane, section, s, ratio) + extraHeight);
}
function laneHeight2(lane, section, s, ratio) {
  const height = laneHeightAt4(lane, s - section.s);
  return height.inner + (height.outer - height.inner) * ratio;
}

// road-infrastructure/raised-band-meshes.ts
var MINIMUM_EDGE_HEIGHT = 0.01;
var MINIMUM_BAND_WIDTH = 0.01;
var SHARED_BOUNDARY_TOLERANCE = 0.000001;
function buildRaisedBandMeshes(network, options) {
  const connectorEdges = connectorCrossSectionEdges(network);
  return network.roads.flatMap((road) => {
    const sections = [...road.laneSections].sort((left, right) => left.s - right.s);
    return sections.flatMap((section, index) => {
      const sectionEnd = sections[index + 1]?.s ?? road.length;
      if (sectionEnd - section.s < 0.5)
        return [];
      const stationValues = raisedBandStations(section, sectionEnd, options);
      const edgeMeshes = section.lanes.flatMap((lane) => {
        if (lane.id === 0)
          return [];
        const closing = closingEdgeFace(road, section, lane, stationValues, connectorEdges);
        const closingEdge = closing ? buildCrossSectionEdge(road, section, lane, stationValues, closing) : undefined;
        if (!lane.verticalEdges)
          return closingEdge ? [closingEdge] : [];
        if (lane.type === "median" && lane.surface === "grass") {
          return [
            ...buildPlantedMedianMeshes(road, section, lane, stationValues),
            ...closingEdge ? [closingEdge] : []
          ];
        }
        const mesh = buildRaisedBand(road, section, lane, stationValues);
        return [...mesh ? [mesh] : [], ...closingEdge ? [closingEdge] : []];
      });
      return [
        ...edgeMeshes,
        ...buildHigherNeighborCovers(road, section, stationValues)
      ];
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
}
function raisedBandStations(section, sectionEnd, options) {
  return [...new Set([
    ...stations(section.s, sectionEnd, Math.min(1.5, options.structuralSampleLength), true),
    ...section.lanes.flatMap((lane) => (lane.heights ?? []).map((height) => section.s + height.sOffset).filter((s) => s > section.s && s < sectionEnd))
  ])].sort((left, right) => left - right);
}
function closingEdgeFace(road, section, lane, stationValues, connectorEdges) {
  if (road.kind === "connector" || road.junctionId)
    return connectorEdges.get(road.id);
  if (laneHasVerticalEdge3(lane, "outer"))
    return;
  if (boundaryNeighbor3(section, lane, "outer"))
    return;
  if (!stationValues.some((s) => laneHeight3(lane, section, s, 1) > MINIMUM_EDGE_HEIGHT)) {
    return;
  }
  return { ratio: 1, dropAt: (s) => laneHeight3(lane, section, s, 1) };
}
function connectorCrossSectionEdges(network) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const result = new Map;
  for (const junction of network.junctions) {
    const connectors = network.roads.filter((road) => road.junctionId === junction.id && road.kind === "connector");
    for (const road of connectors) {
      const section = road.laneSections[0];
      const lane = section?.lanes.find((candidate) => candidate.id !== 0);
      if (!section || !lane || road.laneSections.length !== 1)
        continue;
      const drop = continuedApproachLaneHeight(junction, roads, road);
      if (drop <= MINIMUM_EDGE_HEIGHT)
        continue;
      const siblings = connectors.filter((candidate) => candidate !== road);
      const free = [0, 1].filter((ratio) => !siblings.some((sibling) => boundariesCoincide(road, ratioOrdinal(lane, ratio), sibling)));
      if (free.length !== 1)
        continue;
      result.set(road.id, { ratio: free[0], dropAt: () => drop });
    }
  }
  return result;
}
function ratioOrdinal(lane, ratio) {
  const direction = Math.sign(lane.id);
  return ratio === 1 ? lane.id : lane.id - direction;
}
function boundariesCoincide(road, ordinal, other) {
  const section = road.laneSections[0];
  const otherSection = other.laneSections[0];
  const own = boundaryProbe(road, section, ordinal);
  return other.laneSections.length === 1 && otherSection.lanes.some((candidate) => candidate.id !== 0 && [0, 1].some((ratio) => {
    const probe = boundaryProbe(other, otherSection, ratioOrdinal(candidate, ratio));
    return own.every((point2) => probe.some((sample) => Math.hypot(point2.x - sample.x, point2.y - sample.y) <= SHARED_BOUNDARY_TOLERANCE));
  }));
}
function boundaryProbe(road, section, ordinal) {
  return [0, 0.5, 1].map((fraction) => laneBoundarySurfacePointAt(road, section, ordinal, road.length * fraction));
}
function continuedApproachLaneHeight(junction, roads, connector) {
  let height = 0;
  for (const connection of junction.connections) {
    if (connection.connectingRoadId !== connector.id)
      continue;
    const incoming = roads.get(connection.incomingRoadId);
    if (!incoming)
      continue;
    const station = connection.incomingS ?? (connection.incomingContactPoint === "start" ? 0 : incoming.length);
    const section = [...incoming.laneSections].sort((left, right) => left.s - right.s).filter((candidate) => candidate.s <= station + 0.000001).at(-1) ?? incoming.laneSections[0];
    for (const link of connection.laneLinks) {
      const lane = section?.lanes.find((candidate) => candidate.id === link.from);
      if (!section || !lane)
        continue;
      height = Math.max(height, laneHeight3(lane, section, station, 1));
    }
  }
  return height;
}
function buildRaisedBand(road, section, lane, stationValues) {
  const builder = new InfrastructureStructuralMeshBuilder;
  let faceCount = 0;
  for (const boundary of ["inner", "outer"]) {
    if (!laneHasVerticalEdge3(lane, boundary))
      continue;
    const ratio = boundary === "inner" ? 0 : 1;
    const rings = stationValues.map((s) => {
      const ownerPoint = lanePoint3(road, section, lane, s, ratio, 0);
      const adjacentPoint = adjacentBoundaryPoint3(road, section, lane, boundary, s);
      if (Math.abs(ownerPoint.z - adjacentPoint.z) < MINIMUM_EDGE_HEIGHT)
        return;
      const lower = ownerPoint.z <= adjacentPoint.z ? ownerPoint : adjacentPoint;
      const upper = ownerPoint.z <= adjacentPoint.z ? adjacentPoint : ownerPoint;
      return [
        builder.addVertex(lower, s, 0),
        builder.addVertex(upper, s, 1)
      ];
    });
    for (let index = 0;index < rings.length - 1; index++) {
      const current = rings[index];
      const next = rings[index + 1];
      if (!current || !next)
        continue;
      if (lane.id < 0 === (boundary === "outer")) {
        builder.addQuad(current[0], next[0], next[1], current[1]);
      } else {
        builder.addQuad(current[1], next[1], next[0], current[0]);
      }
      faceCount++;
    }
  }
  if (faceCount === 0)
    return;
  appendTop(builder, road, section, lane, stationValues);
  return builder.build(`${road.id}|raised-band|${section.id}|${lane.id}`, "raised-band", lane.surface ?? "concrete", {
    sourceId: lane.sourceRole ?? `${section.id}|${lane.id}`,
    ownerId: road.id,
    roadId: road.id,
    junctionId: road.junctionId,
    rule: "authored-vertical-lane-edges"
  });
}
function buildCrossSectionEdge(road, section, lane, stationValues, face) {
  const builder = new InfrastructureStructuralMeshBuilder;
  let faceCount = 0;
  const rings = stationValues.map((s) => {
    const top = lanePoint3(road, section, lane, s, face.ratio, 0);
    const base = lanePoint3(road, section, lane, s, face.ratio, -face.dropAt(s));
    if (Math.abs(top.z - base.z) < MINIMUM_EDGE_HEIGHT)
      return;
    return [builder.addVertex(base, s, 0), builder.addVertex(top, s, 1)];
  });
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    if (!current || !next)
      continue;
    if (lane.id < 0 === (face.ratio === 1)) {
      builder.addQuad(current[0], next[0], next[1], current[1]);
    } else {
      builder.addQuad(current[1], next[1], next[0], current[0]);
    }
    faceCount++;
  }
  if (faceCount === 0)
    return;
  return builder.build(`${road.id}|cross-section-edge|${section.id}|${lane.id}`, "raised-band", laneMaterialClass2(lane), {
    sourceId: lane.sourceRole ?? `${section.id}|${lane.id}`,
    ownerId: road.id,
    roadId: road.id,
    junctionId: road.junctionId,
    rule: "raised-cross-section-outer-edge"
  });
}
function buildHigherNeighborCovers(road, section, stationValues) {
  const relations = new Map;
  for (const edgeOwner of section.lanes) {
    if (!edgeOwner.verticalEdges || edgeOwner.id === 0)
      continue;
    for (const ownerBoundary of ["inner", "outer"]) {
      if (!laneHasVerticalEdge3(edgeOwner, ownerBoundary))
        continue;
      const adjacent = boundaryNeighbor3(section, edgeOwner, ownerBoundary);
      if (!adjacent || laneHasVerticalEdge3(adjacent.lane, adjacent.boundary))
        continue;
      const relation = relations.get(adjacent.lane.id) ?? { lane: adjacent.lane, owners: [] };
      relation.owners.push({
        edgeOwner,
        ownerBoundary,
        neighborBoundary: adjacent.boundary
      });
      relations.set(adjacent.lane.id, relation);
    }
  }
  return [...relations.values()].flatMap(({ lane, owners }) => {
    const builder = new InfrastructureStructuralMeshBuilder;
    let coveredIntervals = 0;
    for (let index = 0;index < stationValues.length - 1; index++) {
      const start = stationValues[index];
      const end = stationValues[index + 1];
      const midpoint = (start + end) * 0.5;
      const probes = [start, midpoint, end];
      if (!probes.some((s) => owners.some((owner) => neighborIsHigher(road, section, lane, owner, s))))
        continue;
      appendTop(builder, road, section, lane, [start, end]);
      coveredIntervals++;
    }
    if (coveredIntervals === 0)
      return [];
    const mesh = builder.build(`${road.id}|vertical-edge-cover|${section.id}|${lane.id}`, "raised-band", laneMaterialClass2(lane), {
      sourceId: lane.sourceRole ?? `${section.id}|${lane.id}`,
      ownerId: road.id,
      roadId: road.id,
      junctionId: road.junctionId,
      rule: "vertical-edge-adjacent-surface-cover"
    });
    return mesh ? [mesh] : [];
  });
}
function neighborIsHigher(road, section, neighbor, relation, s) {
  const neighborRatio = relation.neighborBoundary === "inner" ? 0 : 1;
  const ownerRatio = relation.ownerBoundary === "inner" ? 0 : 1;
  const neighborPoint = lanePoint3(road, section, neighbor, s, neighborRatio, 0);
  const ownerPoint = lanePoint3(road, section, relation.edgeOwner, s, ownerRatio, 0);
  return neighborPoint.z - ownerPoint.z >= MINIMUM_EDGE_HEIGHT;
}
function laneMaterialClass2(lane) {
  if (lane.surface === "asphalt")
    return "road";
  if (lane.surface === "platform")
    return "platform";
  if (lane.surface)
    return lane.surface;
  if (lane.type === "sidewalk")
    return "sidewalk";
  if (lane.type === "biking")
    return "cycleway";
  if (lane.type === "median")
    return "median";
  if (lane.type === "shoulder" || lane.type === "border")
    return "shoulder";
  if (lane.type === "rail")
    return "rail-bed";
  return "road";
}
function appendTop(builder, road, section, lane, stationValues) {
  const rings = stationValues.map((s) => {
    const offsets = laneOffsetsAt7(section, lane.id, s - section.s);
    if (Math.abs(offsets.outer - offsets.inner) < MINIMUM_BAND_WIDTH)
      return;
    return [
      builder.addVertex(lanePoint3(road, section, lane, s, 0, 0), s, 0),
      builder.addVertex(lanePoint3(road, section, lane, s, 1, 0), s, 1)
    ];
  });
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    if (!current || !next)
      continue;
    if (lane.id > 0)
      builder.addQuad(current[0], next[0], next[1], current[1]);
    else
      builder.addQuad(current[1], next[1], next[0], current[0]);
  }
}
function adjacentBoundaryPoint3(road, section, lane, boundary, s) {
  const neighbor = boundaryNeighbor3(section, lane, boundary);
  if (neighbor)
    return lanePoint3(road, section, neighbor.lane, s, neighbor.ratio, 0);
  const ratio = boundary === "inner" ? 0 : 1;
  return lanePoint3(road, section, lane, s, ratio, -laneHeight3(lane, section, s, ratio));
}
function boundaryNeighbor3(section, lane, boundary) {
  const direction = Math.sign(lane.id);
  const candidateId = boundary === "outer" ? lane.id + direction : lane.id - direction;
  if (candidateId !== 0) {
    const candidate = section.lanes.find((item) => item.id === candidateId);
    return candidate ? {
      lane: candidate,
      boundary: boundary === "outer" ? "inner" : "outer",
      ratio: boundary === "outer" ? 0 : 1
    } : undefined;
  }
  const opposite = section.lanes.find((item) => item.id === -lane.id);
  return opposite ? { lane: opposite, boundary: "inner", ratio: 0 } : undefined;
}
function lanePoint3(road, section, lane, s, ratio, extraHeight) {
  const offsets = laneOffsetsAt7(section, lane.id, s - section.s);
  const t = offsets.inner + (offsets.outer - offsets.inner) * ratio;
  return laneSurfacePointAt6(road, section, lane, s, t, laneHeight3(lane, section, s, ratio) + extraHeight);
}
function laneHeight3(lane, section, s, ratio) {
  const height = laneHeightAt5(lane, s - section.s);
  return height.inner + (height.outer - height.inner) * ratio;
}

// road-infrastructure/road-object-meshes.ts
import { findLaneSection as findLaneSection4 } from "./core.js";
var ISLAND_DEFAULT_HEIGHT = 0.12;
var PLATFORM_DEFAULT_HEIGHT = 0.25;
var CURB_BATTER = 0.04;
var BODY_EMBED_DEPTH = -0.12;
var NOSE_MINIMUM_SCALE = 0.14;
var TACTILE_BAND_INSET = 0.25;
var TACTILE_BAND_WIDTH = 0.4;
function buildRoadObjectMeshes(network) {
  const result = [];
  for (const road of network.roads) {
    for (const object of road.objects ?? []) {
      if (object.junctionId)
        continue;
      if (object.kind !== "island" && object.kind !== "platform")
        continue;
      if (!object.length || !object.width)
        continue;
      for (const [instance, s, t] of objectInstances(object)) {
        const meshes = object.kind === "island" ? buildRefugeIsland(road, object, instance, s, t) : buildPlatform(road, object, instance, s, t);
        result.push(...meshes);
      }
    }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}
function objectInstances(object) {
  if (!object.repeat)
    return [[object.id, object.s, object.t]];
  return Array.from({ length: object.repeat.count }, (_, index) => [
    `${object.id}|${index}`,
    object.s + index * object.repeat.spacing,
    object.repeat.lateralOffsets?.[index] ?? object.t
  ]);
}
function buildRefugeIsland(road, object, instanceId, centerS, centerT) {
  const length2 = object.length;
  const halfWidth = object.width / 2;
  const height = object.height ?? ISLAND_DEFAULT_HEIGHT;
  const sStart = Math.max(0, centerS - length2 / 2);
  const sEnd = Math.min(road.length, centerS + length2 / 2);
  if (sEnd - sStart < 0.5)
    return [];
  const nose = Math.min(length2 * 0.25, halfWidth * 2.4, 3);
  const builder = new InfrastructureStructuralMeshBuilder;
  appendSweptProfile(builder, {
    road,
    stationValues: stations(sStart, sEnd, Math.min(1, Math.max(0.35, nose / 3)), true),
    capEnds: true,
    pointAt: (s, t, h) => surfacePointAt(road, findLaneSection4(road, s), s, t, h),
    profileAt: (s) => {
      const local = Math.min(s - sStart, sEnd - s);
      const scale = local >= nose ? 1 : Math.max(NOSE_MINIMUM_SCALE, Math.sqrt(Math.max(0, 1 - ((nose - local) / nose) ** 2)));
      const half = halfWidth * scale;
      const batter = Math.min(CURB_BATTER, half * 0.6);
      return [
        { t: centerT - half, h: BODY_EMBED_DEPTH },
        { t: centerT - half + batter, h: height },
        { t: centerT + half - batter, h: height },
        { t: centerT + half, h: BODY_EMBED_DEPTH }
      ];
    }
  });
  const mesh = builder.build(`${road.id}|island|${instanceId}`, "junction-island", "island-concrete", {
    sourceId: object.id,
    ownerId: road.id,
    roadId: road.id,
    station: centerS,
    rule: "road-refuge-island"
  });
  return mesh ? [mesh] : [];
}
function buildPlatform(road, object, instanceId, centerS, centerT) {
  const length2 = object.length;
  const halfWidth = object.width / 2;
  const height = object.height ?? PLATFORM_DEFAULT_HEIGHT;
  const sStart = Math.max(0, centerS - length2 / 2);
  const sEnd = Math.min(road.length, centerS + length2 / 2);
  if (sEnd - sStart < 1)
    return [];
  const stationValues = stations(sStart, sEnd, 1.5, true);
  const pointAt2 = (s, t, h) => surfacePointAt(road, findLaneSection4(road, s), s, t, h);
  const referenceZ = pointAt2(centerS, centerT + Math.sign(centerT || 1) * (halfWidth + 0.5), 0).z;
  const surfaceZ = pointAt2(centerS, centerT, 0).z;
  const surfaceAlreadyRaised = surfaceZ - referenceZ >= height * 0.7;
  const topHeight = surfaceAlreadyRaised ? 0.02 : height;
  const body = new InfrastructureStructuralMeshBuilder;
  appendSweptProfile(body, {
    road,
    stationValues,
    capEnds: true,
    pointAt: pointAt2,
    profileAt: () => [
      { t: centerT - halfWidth, h: BODY_EMBED_DEPTH },
      { t: centerT - halfWidth + CURB_BATTER, h: topHeight },
      { t: centerT + halfWidth - CURB_BATTER, h: topHeight },
      { t: centerT + halfWidth, h: BODY_EMBED_DEPTH }
    ]
  });
  const provenance2 = {
    sourceId: object.id,
    ownerId: road.id,
    roadId: road.id,
    station: centerS,
    rule: "road-stop-platform"
  };
  const meshes = [];
  const bodyMesh = body.build(`${road.id}|platform|${instanceId}`, "platform", "platform-concrete", provenance2);
  if (bodyMesh)
    meshes.push(bodyMesh);
  const boardingSigns = Math.abs(centerT) < 0.75 ? [-1, 1] : [centerT > 0 ? -1 : 1];
  const band = new InfrastructureStructuralMeshBuilder;
  for (const boardingSign of boardingSigns) {
    const edgeT = centerT + boardingSign * (halfWidth - CURB_BATTER);
    const rings = stationValues.map((s) => [
      band.addVertex(pointAt2(s, edgeT - boardingSign * TACTILE_BAND_INSET, topHeight + 0.004), s, 0),
      band.addVertex(pointAt2(s, edgeT - boardingSign * (TACTILE_BAND_INSET + TACTILE_BAND_WIDTH), topHeight + 0.004), s, 1)
    ]);
    for (let index = 0;index < rings.length - 1; index++) {
      const current = rings[index];
      const next = rings[index + 1];
      if (boardingSign < 0)
        band.addQuad(current[0], next[0], next[1], current[1]);
      else
        band.addQuad(current[1], next[1], next[0], current[0]);
    }
  }
  const bandMesh = band.build(`${road.id}|platform-edge|${instanceId}`, "platform-edge", "tactile-paving", {
    ...provenance2,
    rule: "platform-boarding-tactile-band"
  });
  if (bandMesh)
    meshes.push(bandMesh);
  return meshes;
}

// road-infrastructure/tram-track-meshes.ts
import { laneCenterOffsetAt as laneCenterOffsetAt2 } from "./core.js";

// road-infrastructure/lane-width-runs.ts
import { laneWidthAt as laneWidthAt4 } from "./core.js";
var EPSILON = 0.00000001;
function laneWidthRuns(lane, sectionStart, sectionEnd, minimumWidth) {
  const localEnd = Math.max(0, sectionEnd - sectionStart);
  if (localEnd <= EPSILON || lane.widths.length === 0)
    return [];
  const critical = widthCriticalStations(lane, localEnd);
  const boundaries = [...critical];
  for (let index = 0;index < critical.length - 1; index++) {
    const start = critical[index];
    const end = critical[index + 1];
    const startDelta = laneWidthAt4(lane, start) - minimumWidth;
    const endDelta = laneWidthAt4(lane, end) - minimumWidth;
    if (startDelta * endDelta < -EPSILON * EPSILON) {
      boundaries.push(widthThresholdRoot(lane, start, end, minimumWidth));
    }
  }
  const sorted = [...new Set(boundaries)].sort((left, right) => left - right);
  const localRuns = [];
  for (let index = 0;index < sorted.length - 1; index++) {
    const start = sorted[index];
    const end = sorted[index + 1];
    if (end - start <= EPSILON)
      continue;
    if (laneWidthAt4(lane, (start + end) / 2) + EPSILON < minimumWidth)
      continue;
    const previous = localRuns.at(-1);
    if (previous && start <= previous.end + EPSILON)
      previous.end = end;
    else
      localRuns.push({ start, end });
  }
  return localRuns.map((run) => ({
    start: sectionStart + run.start,
    end: sectionStart + run.end
  }));
}
function widthCriticalStations(lane, localEnd) {
  const widths = [...lane.widths].sort((left, right) => left.sOffset - right.sOffset);
  const stations2 = new Set([0, localEnd]);
  widths.forEach((width, index) => {
    const segmentStart = Math.max(0, width.sOffset);
    const segmentEnd = Math.min(localEnd, widths[index + 1]?.sOffset ?? localEnd);
    if (segmentStart > 0 && segmentStart < localEnd)
      stations2.add(segmentStart);
    if (segmentEnd - segmentStart <= EPSILON)
      return;
    for (const root of derivativeRoots(width.b, width.c, width.d)) {
      const station = width.sOffset + root;
      if (station > segmentStart + EPSILON && station < segmentEnd - EPSILON)
        stations2.add(station);
    }
  });
  return [...stations2].sort((left, right) => left - right);
}
function derivativeRoots(b, c, d) {
  if (Math.abs(d) <= EPSILON) {
    return Math.abs(c) <= EPSILON ? [] : [-b / (2 * c)];
  }
  const discriminant = 4 * c * c - 12 * d * b;
  if (discriminant < -EPSILON)
    return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-2 * c - root) / (6 * d), (-2 * c + root) / (6 * d)];
}
function widthThresholdRoot(lane, start, end, minimumWidth) {
  let lower = start;
  let upper = end;
  let lowerDelta = laneWidthAt4(lane, lower) - minimumWidth;
  for (let iteration = 0;iteration < 48; iteration++) {
    const middle = (lower + upper) / 2;
    const middleDelta = laneWidthAt4(lane, middle) - minimumWidth;
    if (Math.abs(middleDelta) <= 0.0000000001)
      return middle;
    if (lowerDelta * middleDelta <= 0)
      upper = middle;
    else {
      lower = middle;
      lowerDelta = middleDelta;
    }
  }
  return (lower + upper) / 2;
}

// road-infrastructure/tram-track-meshes.ts
var TRAM_GAUGE = 1.435;
var RAIL_CENTER_OFFSET2 = TRAM_GAUGE / 2;
var HEAD_INNER = -0.002;
var HEAD_OUTER = -0.058;
var HEAD_TOP = 0.024;
var GUARD_INNER = 0.034;
var GUARD_OUTER = 0.056;
var GUARD_TOP = 0.02;
var GROOVE_FLOOR = -0.012;
var RAIL_EMBED_DEPTH = -0.04;
var MINIMUM_TRACK_LANE_WIDTH = 1.6;
function buildTramTrackMeshes(network, options) {
  const result = [];
  for (const road of network.roads) {
    const sections = [...road.laneSections].sort((left, right) => left.s - right.s);
    sections.forEach((section, index) => {
      const sectionEnd = sections[index + 1]?.s ?? road.length;
      if (sectionEnd - section.s < 0.5)
        return;
      for (const lane of section.lanes) {
        if (!carriesEmbeddedTramTrack(lane))
          continue;
        result.push(...buildLaneTracks(road, section, lane, sectionEnd, options));
      }
    });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}
function buildLaneTracks(road, section, lane, sectionEnd, options) {
  const spacing = road.junctionId ? 1 : Math.min(2, options.structuralSampleLength);
  const runs = laneWidthRuns(lane, section.s, sectionEnd, MINIMUM_TRACK_LANE_WIDTH);
  return runs.flatMap((run, index) => {
    const mesh = buildLaneTrackRun(road, section, lane, sectionEnd, run, spacing, runs.length, index);
    return mesh ? [mesh] : [];
  });
}
function buildLaneTrackRun(road, section, lane, sectionEnd, run, spacing, runCount, runIndex) {
  const stationValues = stations(run.start, run.end, spacing, true);
  if (stationValues.length < 2)
    return;
  const builder = new InfrastructureStructuralMeshBuilder;
  const laneCenterAt = (s) => laneCenterOffsetAt2(section, lane.id, s - section.s);
  const pointAt2 = (s, t, h) => surfacePointAt(road, section, s, t, h);
  for (const railSide of [-1, 1]) {
    const inside = -railSide;
    const railCenterAt = (s) => laneCenterAt(s) + railSide * RAIL_CENTER_OFFSET2;
    appendRailStrip(builder, road, stationValues, railCenterAt, inside, HEAD_OUTER, HEAD_INNER, HEAD_TOP, pointAt2);
    appendRailStrip(builder, road, stationValues, railCenterAt, inside, GUARD_INNER, GUARD_OUTER, GUARD_TOP, pointAt2);
    appendGrooveFloor(builder, stationValues, inside, (s, offset) => pointAt2(s, railCenterAt(s) + inside * offset, GROOVE_FLOOR));
  }
  const completeSection = runCount === 1 && Math.abs(run.start - section.s) <= 0.0000001 && Math.abs(run.end - sectionEnd) <= 0.0000001;
  const runSuffix = completeSection ? "" : `|run:${runIndex}`;
  return builder.build(`${road.id}|tram-rails|${section.id}|${lane.id}${runSuffix}`, "tram-rail", "rail-steel", {
    sourceId: `${section.id}|${lane.id}`,
    ownerId: road.id,
    roadId: road.id,
    junctionId: road.junctionId,
    rule: lane.type === "tram" ? "tram-lane-grooved-track" : "shared-driving-tram-grooved-track"
  });
}
function carriesEmbeddedTramTrack(lane) {
  return lane.type === "tram" || lane.type === "driving" && lane.access?.includes("tram") === true;
}
function appendRailStrip(builder, road, stationValues, railCenterAt, inside, fromOffset, toOffset, top, pointAt2) {
  const center = (fromOffset + toOffset) / 2;
  const width = Math.abs(toOffset - fromOffset);
  appendAlignmentPrism(builder, {
    road,
    stationValues,
    lateralAt: (s) => railCenterAt(s) + inside * center,
    width,
    bottomHeight: RAIL_EMBED_DEPTH,
    topHeight: top,
    pointAt: pointAt2
  });
}
function appendGrooveFloor(builder, stationValues, inside, pointAt2) {
  const rings = stationValues.map((s) => [
    builder.addVertex(pointAt2(s, HEAD_INNER), s, 0),
    builder.addVertex(pointAt2(s, GUARD_INNER), s, 1)
  ]);
  for (let index = 0;index < rings.length - 1; index++) {
    const current = rings[index];
    const next = rings[index + 1];
    if (inside > 0)
      builder.addQuad(current[0], next[0], next[1], current[1]);
    else
      builder.addQuad(current[1], next[1], next[0], current[0]);
  }
}

// road-infrastructure/tunnel-profile.ts
import {
  roadLateralExtentAt as roadLateralExtentAt12
} from "./core.js";
var TUNNEL_WALL_HEIGHT = 4.45;
var TUNNEL_CEILING_HEIGHT = 5.35;
var TUNNEL_ROOF_CHAMFER_WIDTH = 0.95;
var TUNNEL_FLOOR_DROP = 0.4;
var TUNNEL_PROFILE_PADDING = 0.2;
var TUNNEL_PORTAL_FRAME_WIDTH = 3;
function tunnelLateralBoundsAt(structure, road, station) {
  const dynamic = roadLateralExtentAt12(road, station);
  const minimumT = structure.lateralExtentMode === "road-surface" ? dynamic.minimumT - structure.minimumLateralClearance : structure.deckTMin;
  const maximumT = structure.lateralExtentMode === "road-surface" ? dynamic.maximumT + structure.minimumLateralClearance : structure.deckTMax;
  return {
    minimumT,
    maximumT,
    centerT: (minimumT + maximumT) * 0.5,
    halfWidth: Math.max(0.5, (maximumT - minimumT) * 0.5)
  };
}
function tunnelLiningProfile(bounds2) {
  return modernTunnelProfile(bounds2.centerT, bounds2.halfWidth, TUNNEL_WALL_HEIGHT, TUNNEL_CEILING_HEIGHT, -TUNNEL_FLOOR_DROP);
}
function tunnelPortalOuterProfile(bounds2) {
  return modernTunnelProfile(bounds2.centerT, bounds2.halfWidth + TUNNEL_PORTAL_FRAME_WIDTH, TUNNEL_WALL_HEIGHT + TUNNEL_PORTAL_FRAME_WIDTH * 0.6, TUNNEL_CEILING_HEIGHT + TUNNEL_PORTAL_FRAME_WIDTH * 0.7, -TUNNEL_FLOOR_DROP - TUNNEL_PORTAL_FRAME_WIDTH * 0.3);
}
function tunnelOuterRoofHeightAt(lateralDistance, innerHalfWidth, shellThickness) {
  const shell = shellThickness + TUNNEL_PROFILE_PADDING;
  const outerHalfWidth = innerHalfWidth + shell;
  const distance = Math.abs(lateralDistance);
  if (distance > outerHalfWidth)
    return Number.NEGATIVE_INFINITY;
  const ceilingHeight = TUNNEL_CEILING_HEIGHT + shell;
  const wallHeight = TUNNEL_WALL_HEIGHT + shell;
  const flatHalfWidth = Math.max(0, outerHalfWidth - TUNNEL_ROOF_CHAMFER_WIDTH);
  if (distance <= flatHalfWidth)
    return ceilingHeight;
  const chamferProgress = (distance - flatHalfWidth) / Math.max(TUNNEL_ROOF_CHAMFER_WIDTH, Number.EPSILON);
  return ceilingHeight + (wallHeight - ceilingHeight) * chamferProgress;
}
function modernTunnelProfile(centerT, halfWidth, wallHeight, ceilingHeight, bottomHeight) {
  const chamferWidth = Math.min(TUNNEL_ROOF_CHAMFER_WIDTH, Math.max(0.2, halfWidth * 0.3));
  return [
    { t: centerT - halfWidth, h: bottomHeight },
    { t: centerT - halfWidth, h: wallHeight },
    { t: centerT - halfWidth + chamferWidth, h: ceilingHeight },
    { t: centerT + halfWidth - chamferWidth, h: ceilingHeight },
    { t: centerT + halfWidth, h: wallHeight },
    { t: centerT + halfWidth, h: bottomHeight }
  ];
}

// road-infrastructure/tunnel-provenance.ts
function tunnelProvenance(structure, rule) {
  return {
    sourceId: structure.id,
    ownerId: structure.id,
    roadId: structure.roadId,
    structureId: structure.id,
    rule
  };
}

// road-infrastructure/tunnel-finish.ts
var PANEL_DEPTH = 0.055;
var PANEL_THICKNESS = 0.045;
var LOWER_BAND_TOP = 1.35;
var PANEL_JOINT_SPACING = 3;
var PANEL_JOINT_WIDTH = 0.045;
function buildTunnelFinishMeshes(structure, road, stationValues) {
  return [
    buildWallFinish(structure, road, stationValues, "tunnel-lower-band", "tunnel-lower-band", 0.06, LOWER_BAND_TOP),
    buildWallFinish(structure, road, stationValues, "tunnel-wall-panel", "tunnel-wall-panel", LOWER_BAND_TOP + 0.04, TUNNEL_WALL_HEIGHT - 0.12),
    buildCeilingPanels(structure, road, stationValues),
    buildServiceRails(structure, road, stationValues),
    buildPanelJoints(structure, road)
  ].filter((mesh) => mesh !== undefined);
}
function buildWallFinish(structure, road, stationValues, kind, materialClass, bottomHeight, topHeight) {
  const builder = new InfrastructureStructuralMeshBuilder;
  for (const side of [-1, 1]) {
    appendSweptProfile(builder, {
      road,
      stationValues,
      profileAt: (station) => wallBoxProfile(structure, road, station, side, PANEL_DEPTH, PANEL_DEPTH + PANEL_THICKNESS, bottomHeight, topHeight)
    });
  }
  return builder.build(`${structure.id}|${kind}`, kind, materialClass, tunnelProvenance(structure, `authored-${kind}`));
}
function buildCeilingPanels(structure, road, stationValues) {
  const builder = new InfrastructureStructuralMeshBuilder;
  appendSweptProfile(builder, {
    road,
    stationValues,
    profileAt: (station) => {
      const bounds2 = tunnelLateralBoundsAt(structure, road, station);
      return boxProfile(bounds2.minimumT + TUNNEL_ROOF_CHAMFER_WIDTH + 0.08, bounds2.maximumT - TUNNEL_ROOF_CHAMFER_WIDTH - 0.08, TUNNEL_CEILING_HEIGHT - 0.09, TUNNEL_CEILING_HEIGHT - 0.035);
    }
  });
  return builder.build(`${structure.id}|ceiling-panels`, "tunnel-ceiling-panel", "tunnel-ceiling-panel", tunnelProvenance(structure, "authored-tunnel-ceiling-panels"));
}
function buildServiceRails(structure, road, stationValues) {
  const builder = new InfrastructureStructuralMeshBuilder;
  for (const side of [-1, 1]) {
    appendSweptProfile(builder, {
      road,
      stationValues,
      profileAt: (station) => wallBoxProfile(structure, road, station, side, 0.1, 0.24, 0.7, 0.88)
    });
  }
  return builder.build(`${structure.id}|service-rails`, "tunnel-service-rail", "tunnel-service-rail-steel", tunnelProvenance(structure, "authored-tunnel-service-rails"));
}
function buildPanelJoints(structure, road) {
  const builder = new InfrastructureStructuralMeshBuilder;
  for (let station = structure.sStart + PANEL_JOINT_SPACING;station < structure.sEnd - 0.2; station += PANEL_JOINT_SPACING) {
    const stationValues = [
      Math.max(structure.sStart, station - PANEL_JOINT_WIDTH * 0.5),
      Math.min(structure.sEnd, station + PANEL_JOINT_WIDTH * 0.5)
    ];
    for (const side of [-1, 1]) {
      appendSweptProfile(builder, {
        road,
        stationValues,
        profileAt: (sampleStation) => wallBoxProfile(structure, road, sampleStation, side, PANEL_DEPTH + PANEL_THICKNESS + 0.002, PANEL_DEPTH + PANEL_THICKNESS + 0.012, LOWER_BAND_TOP + 0.04, TUNNEL_WALL_HEIGHT - 0.12)
      });
    }
  }
  return builder.build(`${structure.id}|wall-joints`, "tunnel-wall-joint", "tunnel-wall-joint", tunnelProvenance(structure, "authored-tunnel-wall-joints"));
}
function wallBoxProfile(structure, road, station, side, minimumDepth, maximumDepth, bottomHeight, topHeight) {
  const bounds2 = tunnelLateralBoundsAt(structure, road, station);
  const wallT = side < 0 ? bounds2.minimumT : bounds2.maximumT;
  return boxProfile(wallT - side * maximumDepth, wallT - side * minimumDepth, bottomHeight, topHeight);
}
function boxProfile(firstT, secondT, bottomHeight, topHeight) {
  const minimumT = Math.min(firstT, secondT);
  const maximumT = Math.max(firstT, secondT);
  return [
    { t: minimumT, h: bottomHeight },
    { t: minimumT, h: topHeight },
    { t: maximumT, h: topHeight },
    { t: maximumT, h: bottomHeight }
  ];
}

// road-infrastructure/tunnel-lighting.ts
var FIXTURE_SPACING = 6;
var FIXTURE_LENGTH = 1.8;
var EMERGENCY_MARKER_SPACING = 72;
function buildTunnelLightingMeshes(structure, road) {
  return [
    buildFixtures(structure, road, "housing"),
    buildFixtures(structure, road, "lamp"),
    buildEmergencyMarkers(structure, road)
  ].filter((mesh) => mesh !== undefined);
}
function buildFixtures(structure, road, part) {
  const builder = new InfrastructureStructuralMeshBuilder;
  const heightRange = part === "housing" ? { bottom: 4.06, top: 4.46 } : { bottom: 4.13, top: 4.39 };
  const depthRange = part === "housing" ? { minimum: 0.11, maximum: 0.2 } : { minimum: 0.205, maximum: 0.218 };
  for (const center of fixtureStations(structure)) {
    const stationValues = [
      Math.max(structure.sStart, center - FIXTURE_LENGTH * 0.5),
      Math.min(structure.sEnd, center + FIXTURE_LENGTH * 0.5)
    ];
    for (const side of [-1, 1]) {
      appendSweptProfile(builder, {
        road,
        stationValues,
        profileAt: (station) => wallBoxProfile2(structure, road, station, side, depthRange.minimum, depthRange.maximum, heightRange.bottom, heightRange.top)
      });
    }
  }
  const isLamp = part === "lamp";
  return builder.build(`${structure.id}|light-${part}`, isLamp ? "tunnel-light" : "tunnel-light-housing", isLamp ? "tunnel-light-emissive" : "tunnel-fixture-housing", tunnelProvenance(structure, isLamp ? "authored-tunnel-lighting" : "authored-tunnel-light-housings"));
}
function buildEmergencyMarkers(structure, road) {
  const builder = new InfrastructureStructuralMeshBuilder;
  for (let center = structure.sStart + EMERGENCY_MARKER_SPACING;center < structure.sEnd - 1; center += EMERGENCY_MARKER_SPACING) {
    const stationValues = [center - 0.22, center + 0.22];
    for (const side of [-1, 1]) {
      appendSweptProfile(builder, {
        road,
        stationValues,
        profileAt: (station) => wallBoxProfile2(structure, road, station, side, 0.105, 0.122, 1.48, 1.82)
      });
    }
  }
  return builder.build(`${structure.id}|emergency-markers`, "tunnel-emergency-marker", "tunnel-emergency-green", tunnelProvenance(structure, "authored-tunnel-emergency-markers"));
}
function fixtureStations(structure) {
  const tunnelLength = structure.sEnd - structure.sStart;
  if (tunnelLength <= FIXTURE_LENGTH) {
    return [(structure.sStart + structure.sEnd) * 0.5];
  }
  const stations2 = [];
  for (let station = structure.sStart + FIXTURE_SPACING * 0.5;station < structure.sEnd - FIXTURE_LENGTH * 0.5; station += FIXTURE_SPACING) {
    stations2.push(station);
  }
  return stations2;
}
function wallBoxProfile2(structure, road, station, side, minimumDepth, maximumDepth, bottomHeight, topHeight) {
  const bounds2 = tunnelLateralBoundsAt(structure, road, station);
  const wallT = side < 0 ? bounds2.minimumT : bounds2.maximumT;
  const firstT = wallT - side * maximumDepth;
  const secondT = wallT - side * minimumDepth;
  const minimumT = Math.min(firstT, secondT);
  const maximumT = Math.max(firstT, secondT);
  return [
    { t: minimumT, h: bottomHeight },
    { t: minimumT, h: topHeight },
    { t: maximumT, h: topHeight },
    { t: maximumT, h: bottomHeight }
  ];
}

// road-infrastructure/tunnel-infrastructure.ts
function buildTunnelInfrastructure(network, physicalTopology, options) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  return physicalTopology.roadStructures.flatMap((structure) => {
    if (structure.kind !== "tunnel")
      return [];
    const road = roads.get(structure.roadId);
    if (!road)
      throw new Error(`Tunnel structure ${structure.id} has no road`);
    return buildTunnelMeshes(structure, road, options);
  });
}
function buildTunnelMeshes(structure, road, options) {
  const stationValues = stations(structure.sStart, structure.sEnd, Math.min(3, options.structuralSampleLength), true);
  const meshes = [
    buildTunnelLining(structure, road, stationValues),
    buildTunnelPortal(structure, road, structure.sStart, "start"),
    buildTunnelPortal(structure, road, structure.sEnd, "end"),
    ...buildTunnelFinishMeshes(structure, road, stationValues),
    ...buildTunnelLightingMeshes(structure, road)
  ];
  return meshes.filter((mesh) => mesh !== undefined);
}
function buildTunnelLining(structure, road, stationValues) {
  const builder = new InfrastructureStructuralMeshBuilder;
  appendSweptProfile(builder, {
    road,
    stationValues,
    profileAt: (station) => tunnelLiningProfile(tunnelLateralBoundsAt(structure, road, station)),
    inwardFaces: true
  });
  return builder.build(`${structure.id}|lining`, "tunnel-lining", "tunnel-concrete", tunnelProvenance(structure, "authored-tunnel-lining"));
}
function buildTunnelPortal(structure, road, station, end) {
  const builder = new InfrastructureStructuralMeshBuilder;
  const bounds2 = tunnelLateralBoundsAt(structure, road, station);
  const inner = tunnelLiningProfile(bounds2);
  const outer = tunnelPortalOuterProfile(bounds2);
  const innerIndices = inner.map(({ t, h }, index) => builder.addVertex(roadPoint(road, station, t, h), index, 0));
  const outerIndices = outer.map(({ t, h }, index) => builder.addVertex(roadPoint(road, station, t, h), index, 1));
  for (let index = 0;index < innerIndices.length; index++) {
    if (index === innerIndices.length - 1)
      continue;
    const next = (index + 1) % innerIndices.length;
    if (end === "start") {
      builder.addQuad(innerIndices[index], outerIndices[index], outerIndices[next], innerIndices[next]);
    } else {
      builder.addQuad(innerIndices[next], outerIndices[next], outerIndices[index], innerIndices[index]);
    }
  }
  return builder.build(`${structure.id}|portal|${end}`, "tunnel-portal", "tunnel-portal-concrete", {
    ...tunnelProvenance(structure, "authored-tunnel-portal"),
    station
  });
}

// road-infrastructure/incremental-infrastructure.ts
function infrastructureBuildRegion(network, topology, ownerIds) {
  const owners = new Set(ownerIds);
  const junctions = network.junctions.filter(({ id }) => owners.has(id));
  const junctionIds = new Set(junctions.map(({ id }) => id));
  const roadIds = new Set(network.roads.filter((road) => owners.has(road.id) || Boolean(road.junctionId && junctionIds.has(road.junctionId))).map(({ id }) => id));
  for (const junction of junctions) {
    for (const { roadId } of junction.ports ?? [])
      roadIds.add(roadId);
  }
  const roads = network.roads.filter(({ id }) => roadIds.has(id));
  return {
    network: {
      ...network,
      roads,
      junctions,
      junctionGroups: network.junctionGroups?.filter(({ junctionIds: ids }) => ids.some((id) => junctionIds.has(id))),
      gradeSeparations: network.gradeSeparations?.filter(({ upperRoad, lowerRoad }) => roadIds.has(upperRoad.roadId) || roadIds.has(lowerRoad.roadId)),
      roadStructures: network.roadStructures?.filter(({ roadId }) => roadIds.has(roadId)),
      roadsideFeatures: network.roadsideFeatures?.filter(({ roadId }) => roadIds.has(roadId)),
      roadSurfaceElevations: network.roadSurfaceElevations?.filter(({ roadId }) => roadIds.has(roadId)),
      weavingSections: network.weavingSections?.filter(({ roadId }) => roadIds.has(roadId)),
      objects: network.objects?.filter(({ junctionId }) => Boolean(junctionId && junctionIds.has(junctionId)))
    },
    topology: {
      ...topology,
      corridors: topology.corridors.filter(({ roadId }) => roadIds.has(roadId)),
      junctions: topology.junctions.filter(({ junctionId }) => junctionIds.has(junctionId)),
      gradeSeparations: topology.gradeSeparations.filter(({ upperRoad, lowerRoad }) => roadIds.has(upperRoad.roadId) || roadIds.has(lowerRoad.roadId)),
      roadStructures: topology.roadStructures.filter(({ roadId }) => roadIds.has(roadId)),
      roadsideFeatures: topology.roadsideFeatures?.filter(({ roadId }) => roadIds.has(roadId)),
      weavingSections: topology.weavingSections.filter(({ roadId }) => roadIds.has(roadId))
    }
  };
}
function mergeInfrastructureRegion(previous, rebuilt, network, ownerIds) {
  const owners = new Set(ownerIds);
  const roadIds = new Set(network.roads.map(({ id }) => id));
  const junctionIds = new Set(network.junctions.map(({ id }) => id));
  const keep = (provenance2) => !touchesOwner(provenance2, owners) && (!provenance2.roadId || roadIds.has(provenance2.roadId)) && (!provenance2.junctionId || junctionIds.has(provenance2.junctionId));
  const meshes = [
    ...previous.structuralMeshes.filter((mesh) => keep(mesh.provenance)),
    ...rebuilt.structuralMeshes
  ].sort((left, right) => left.id.localeCompare(right.id));
  const batches = mergeInstanceBatches(previous.instanceBatches, rebuilt.instanceBatches, keep);
  return { networkId: network.id, structuralMeshes: meshes, instanceBatches: batches };
}
function mergeInstanceBatches(previous, rebuilt, keep) {
  const batches = new Map;
  for (const batch of previous) {
    const instances = batch.instances.filter((instance) => keep(instance.provenance));
    if (instances.length > 0)
      batches.set(batch.id, { ...batch, instances });
  }
  for (const batch of rebuilt) {
    const existing = batches.get(batch.id);
    batches.set(batch.id, existing ? { ...batch, instances: [...existing.instances, ...batch.instances] } : batch);
  }
  return [...batches.values()].sort((left, right) => left.id.localeCompare(right.id));
}
function touchesOwner(provenance2, owners) {
  return [
    provenance2.sourceId,
    provenance2.ownerId,
    provenance2.roadId,
    provenance2.junctionId,
    provenance2.structureId
  ].some((id) => id !== undefined && owners.has(id));
}

// road-infrastructure/build-road-infrastructure-model.ts
var DEFAULT_OPTIONS2 = {
  authoredMotorwayBarrierRoadIds: [],
  authoredMotorwayDelineatorRoadIds: [],
  terrainElevation: 0,
  motorwayDelineatorSpacing: 50,
  rampDelineatorSpacing: 25,
  reflectorSpacing: 12.5,
  fencePanelLength: 5,
  guardrailSegmentLength: 4,
  drainageSpacing: 25,
  structuralSampleLength: 5
};
function buildRoadInfrastructureModel(network, physicalTopology, options = {}, incremental) {
  if (!network || !physicalTopology)
    throw new TypeError("Road infrastructure requires a network and physical topology");
  const resolved = { ...DEFAULT_OPTIONS2, ...options };
  validateOptions(resolved);
  physicalTopology = materializeGradeSeparationBridges(network, physicalTopology);
  const completeNetwork = network;
  if (incremental) {
    const region = infrastructureBuildRegion(network, physicalTopology, incremental.ownerIds);
    network = region.network;
    physicalTopology = region.topology;
  }
  const semantics = classifyInfrastructureRoads(network, physicalTopology);
  const collector = new InfrastructureInstanceCollector;
  addCorridorInfrastructure(semantics, physicalTopology, collector, resolved);
  addJunctionInfrastructure(network, semantics, collector);
  const assemblies = junctionAssemblySurfaces(network, physicalTopology, resolved.terrainElevation);
  const junctionStructures = buildJunctionStructureMeshes(network, physicalTopology, assemblies, resolved);
  const continuingEnds = continuingStructureEnds(network, physicalTopology, junctionStructures.structuralJunctionIds);
  const profileTransitionInfrastructure = buildProfileTransitionInfrastructure(network, semantics, collector, resolved);
  const structuralMeshes = [
    ...buildBridgeInfrastructure(network, physicalTopology, collector, resolved, continuingEnds),
    ...buildTunnelInfrastructure(network, physicalTopology, resolved),
    ...junctionStructures.meshes,
    ...profileTransitionInfrastructure,
    ...buildContinuousCorridorMeshes(semantics, physicalTopology, resolved),
    ...buildEarthworkMeshes(network, physicalTopology, semantics, resolved),
    ...buildJunctionFillMeshes(network, physicalTopology, assemblies.filter(({ junctionId }) => !junctionStructures.structuralJunctionIds.has(junctionId)), resolved),
    ...buildJunctionObjectMeshes(network),
    ...buildRoadObjectMeshes(network),
    ...buildRaisedBandMeshes(network, resolved),
    ...buildLooseRoadEndRaisedMeshes(network, physicalTopology),
    ...buildPlatformBandMeshes(network, resolved),
    ...buildTramTrackMeshes(network, resolved),
    ...buildRailwayTrackMeshes(network, resolved)
  ].sort((left, right) => left.id.localeCompare(right.id));
  const model = {
    networkId: network.id,
    instanceBatches: collector.build(),
    structuralMeshes
  };
  return incremental ? mergeInfrastructureRegion(incremental.previousModel, model, completeNetwork, incremental.ownerIds) : model;
}
function materializeGradeSeparationBridges(network, topology) {
  const structures = [...topology.roadStructures];
  const structureIds = new Set(structures.map(({ id }) => id));
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const inferredStructureIdByGrade = new Map;
  const unstructuredByUpperRoad = new Map;
  for (const grade of topology.gradeSeparations) {
    if (grade.kind !== "bridge" || grade.structureId)
      continue;
    const values = unstructuredByUpperRoad.get(grade.upperRoad.roadId) ?? [];
    values.push(grade);
    unstructuredByUpperRoad.set(grade.upperRoad.roadId, values);
  }
  for (const [upperRoadId, grades] of unstructuredByUpperRoad) {
    const road = roads.get(upperRoadId);
    if (!road)
      continue;
    const ranges = grades.map((grade) => ({
      grade,
      ...gradeSeparationBridgeRange(grade, road, roads)
    })).sort((left, right) => left.sStart - right.sStart);
    const groups = [];
    for (const range of ranges) {
      const group = groups.at(-1);
      if (group && range.sStart <= Math.max(...group.map(({ sEnd }) => sEnd)) + 2)
        group.push(range);
      else
        groups.push([range]);
    }
    for (const group of groups) {
      const groupGrades = group.map(({ grade }) => grade);
      const structureId = `grade-separation-bridge|${groupGrades.map(({ id }) => id).join("+")}`;
      const sStart = Math.min(...group.map((range) => range.sStart));
      const sEnd = Math.max(...group.map((range) => range.sEnd));
      for (const grade of groupGrades)
        inferredStructureIdByGrade.set(grade.id, structureId);
      if (structureIds.has(structureId))
        continue;
      const samples = [sStart, (sStart + sEnd) * 0.5, sEnd].map((station) => roadLateralExtentAt13(road, station));
      const minimumT = Math.min(...samples.map(({ minimumT: minimumT2 }) => minimumT2));
      const maximumT = Math.max(...samples.map(({ maximumT: maximumT2 }) => maximumT2));
      const lateralClearance = 0.5;
      structures.push({
        id: structureId,
        name: `Bridge for ${groupGrades.map(({ id }) => id).join(", ")}`,
        roadId: road.id,
        kind: "bridge",
        sStart,
        sEnd,
        deckTMin: minimumT - lateralClearance,
        deckTMax: maximumT + lateralClearance,
        structuralThickness: Math.max(...groupGrades.map(({ deckThickness }) => deckThickness)),
        minimumLateralClearance: lateralClearance,
        lateralExtentMode: "road-surface",
        actualMinimumT: minimumT,
        actualMaximumT: maximumT,
        actualMinimumLateralClearance: lateralClearance
      });
      structureIds.add(structureId);
    }
  }
  let gradeSeparations = topology.gradeSeparations.map((gradeSeparation) => {
    const structureId = inferredStructureIdByGrade.get(gradeSeparation.id);
    return structureId ? { ...gradeSeparation, structureId } : gradeSeparation;
  });
  const structureIndexById = new Map(structures.map((structure, index) => [structure.id, index]));
  for (const grade of gradeSeparations) {
    if (grade.kind !== "bridge" || !grade.structureId)
      continue;
    const structureIndex = structureIndexById.get(grade.structureId);
    if (structureIndex === undefined)
      continue;
    const structure = structures[structureIndex];
    const upperRoad = roads.get(grade.upperRoad.roadId);
    if (!upperRoad || structure.roadId !== upperRoad.id || structure.kind !== "bridge")
      continue;
    const range = gradeSeparationBridgeRange(grade, upperRoad, roads);
    structures[structureIndex] = {
      ...structure,
      sStart: Math.min(structure.sStart, range.sStart),
      sEnd: Math.max(structure.sEnd, range.sEnd)
    };
  }
  const finalStructures = new Map(structures.map((structure) => [structure.id, structure]));
  gradeSeparations = gradeSeparations.map((grade) => {
    if (grade.kind !== "bridge" || !grade.structureId)
      return grade;
    const structure = finalStructures.get(grade.structureId);
    return structure ? { ...grade, deckExtent: { sStart: structure.sStart, sEnd: structure.sEnd } } : grade;
  });
  return { ...topology, gradeSeparations, roadStructures: structures };
}
function gradeSeparationBridgeRange(grade, upperRoad, roads) {
  const lowerRoad = roads.get(grade.lowerRoad.roadId);
  if (!lowerRoad) {
    return {
      sStart: Math.max(0, grade.deckExtent.sStart),
      sEnd: Math.min(upperRoad.length, grade.deckExtent.sEnd)
    };
  }
  const upperPose = evaluateReferenceLine(upperRoad.referenceLine, grade.upperRoad.s);
  const lowerPose = evaluateReferenceLine(lowerRoad.referenceLine, grade.lowerRoad.s);
  const angle = upperPose.heading - lowerPose.heading;
  const sine = Math.max(0.05, Math.abs(Math.sin(angle)));
  const cosine = Math.abs(Math.cos(angle));
  const lowerExtent = roadLateralExtentAt13(lowerRoad, grade.lowerRoad.s);
  const upperExtent = roadLateralExtentAt13(upperRoad, grade.upperRoad.s);
  const upperHalfWidth = Math.max(Math.abs(upperExtent.minimumT), Math.abs(upperExtent.maximumT)) + 0.35;
  const lowerHalfWidth = Math.max(Math.abs(lowerExtent.minimumT), Math.abs(lowerExtent.maximumT));
  const sweptHalfLength = (lowerHalfWidth + upperHalfWidth * cosine) / sine + 4;
  return {
    sStart: Math.max(0, Math.min(grade.deckExtent.sStart, grade.upperRoad.s - sweptHalfLength)),
    sEnd: Math.min(upperRoad.length, Math.max(grade.deckExtent.sEnd, grade.upperRoad.s + sweptHalfLength))
  };
}
function validateOptions(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== "number") {
      if (!Array.isArray(value) || value.some((roadId) => typeof roadId !== "string" || roadId.length === 0)) {
        throw new RangeError(`Infrastructure option ${name} must contain road ids`);
      }
      continue;
    }
    if (!Number.isFinite(value))
      throw new RangeError(`Infrastructure option ${name} must be finite`);
    if (name !== "terrainElevation" && value <= 0)
      throw new RangeError(`Infrastructure option ${name} must be positive`);
  }
}
// road-infrastructure/tunnel-terrain.ts
var TERRAIN_SAMPLE_SPACING = 2;
var TERRAIN_INDEX_CELL_SIZE = 16;
var SURFACE_EPSILON = 0.05;
function buildRoadTunnelTerrainFootprints(network) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  return (network.roadStructures ?? []).flatMap((structure) => {
    if (structure.kind !== "tunnel")
      return [];
    const road = roads.get(structure.roadId);
    if (!road)
      return [];
    return [buildTunnelFootprint(structure, road)];
  });
}
function buildTunnelFootprint(structure, road) {
  const samples = stations(structure.sStart, structure.sEnd, TERRAIN_SAMPLE_SPACING, true).map((station) => {
    const bounds3 = tunnelLateralBoundsAt(structure, road, station);
    const center = roadPoint(road, station, bounds3.centerT);
    return {
      x: center.x,
      y: center.y,
      floor: center.z,
      halfWidth: bounds3.halfWidth,
      shellThickness: structure.structuralThickness
    };
  });
  const segments = buildTerrainSegments(samples);
  const segmentIndex = buildSegmentIndex(segments);
  const bounds2 = mergeSegmentBounds(segments);
  return Object.assign((worldX, worldY, terrainElevation) => {
    if (outsidePortalPlanes(samples, worldX, worldY))
      return false;
    const candidates = segmentsAt(segmentIndex, worldX, worldY);
    for (const segment of candidates) {
      const { start, end, segmentX, segmentY, lengthSquared } = segment;
      const rawProgress = ((worldX - start.x) * segmentX + (worldY - start.y) * segmentY) / lengthSquared;
      if (segment.isFirst && rawProgress < 0)
        continue;
      if (segment.isLast && rawProgress > 1)
        continue;
      const progress = Math.max(0, Math.min(1, rawProgress));
      const centerX = start.x + segmentX * progress;
      const centerY = start.y + segmentY * progress;
      const lateralDistance = Math.hypot(worldX - centerX, worldY - centerY);
      const halfWidth = mix2(start.halfWidth, end.halfWidth, progress);
      const shell = mix2(start.shellThickness, end.shellThickness, progress);
      const outerHalfWidth = halfWidth + shell + TUNNEL_PROFILE_PADDING;
      if (lateralDistance > outerHalfWidth)
        continue;
      const floor = mix2(start.floor, end.floor, progress);
      const outerRoof = floor + tunnelOuterRoofHeightAt(lateralDistance, halfWidth, shell);
      const outerBottom = floor - TUNNEL_FLOOR_DROP - shell - TUNNEL_PROFILE_PADDING;
      if (terrainElevation >= outerBottom - SURFACE_EPSILON && terrainElevation <= outerRoof + SURFACE_EPSILON) {
        return true;
      }
    }
    return false;
  }, { bounds: bounds2 });
}
function outsidePortalPlanes(samples, worldX, worldY) {
  const first = samples[0];
  const second = samples[1];
  const last = samples.at(-1);
  const previous = samples.at(-2);
  if (!first || !second || !last || !previous)
    return true;
  const startDirectionX = second.x - first.x;
  const startDirectionY = second.y - first.y;
  const startProjection = (worldX - first.x) * startDirectionX + (worldY - first.y) * startDirectionY;
  if (startProjection < 0)
    return true;
  const endDirectionX = last.x - previous.x;
  const endDirectionY = last.y - previous.y;
  const endProjection = (worldX - last.x) * endDirectionX + (worldY - last.y) * endDirectionY;
  return endProjection > 0;
}
function buildTerrainSegments(samples) {
  const lastSegment = samples.length - 2;
  return samples.slice(0, -1).map((start, index) => {
    const end = samples[index + 1];
    const segmentX = end.x - start.x;
    const segmentY = end.y - start.y;
    const lengthSquared = segmentX * segmentX + segmentY * segmentY || 1;
    const isFirst = index === 0;
    const isLast = index === lastSegment;
    const maximumRadius = Math.max(start.halfWidth + start.shellThickness, end.halfWidth + end.shellThickness) + TUNNEL_PROFILE_PADDING;
    return {
      start,
      end,
      segmentX,
      segmentY,
      lengthSquared,
      isFirst,
      isLast,
      bounds: {
        minX: Math.min(start.x, end.x) - maximumRadius,
        minY: Math.min(start.y, end.y) - maximumRadius,
        maxX: Math.max(start.x, end.x) + maximumRadius,
        maxY: Math.max(start.y, end.y) + maximumRadius
      }
    };
  });
}
function buildSegmentIndex(segments) {
  const mutableIndex = new Map;
  for (const segment of segments) {
    const minCellX = indexCell(segment.bounds.minX);
    const minCellY = indexCell(segment.bounds.minY);
    const maxCellX = indexCell(segment.bounds.maxX);
    const maxCellY = indexCell(segment.bounds.maxY);
    for (let cellX = minCellX;cellX <= maxCellX; cellX++) {
      let column = mutableIndex.get(cellX);
      if (!column) {
        column = new Map;
        mutableIndex.set(cellX, column);
      }
      for (let cellY = minCellY;cellY <= maxCellY; cellY++) {
        const bucket = column.get(cellY);
        if (bucket)
          bucket.push(segment);
        else
          column.set(cellY, [segment]);
      }
    }
  }
  return mutableIndex;
}
function segmentsAt(index, worldX, worldY) {
  return index.get(indexCell(worldX))?.get(indexCell(worldY)) ?? [];
}
function indexCell(value) {
  return Math.floor(value / TERRAIN_INDEX_CELL_SIZE);
}
function mergeSegmentBounds(segments) {
  const first = segments[0]?.bounds;
  if (!first)
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const bounds2 = { ...first };
  for (const segment of segments.slice(1)) {
    bounds2.minX = Math.min(bounds2.minX, segment.bounds.minX);
    bounds2.minY = Math.min(bounds2.minY, segment.bounds.minY);
    bounds2.maxX = Math.max(bounds2.maxX, segment.bounds.maxX);
    bounds2.maxY = Math.max(bounds2.maxY, segment.bounds.maxY);
  }
  return bounds2;
}
function mix2(start, end, progress) {
  return start + (end - start) * progress;
}
export {
  validateRoadSurfaceModel,
  validateRoadMeshBundle,
  sampleCorridorStations,
  meshRoadSurfaceModel,
  meshRoadSurfaceChunks,
  buildRoadTunnelTerrainFootprints,
  buildRoadSurfaceModel,
  buildRoadInfrastructureModel,
  buildJunctionAreaDecals
};
