import { CDTError } from './types.js';
import { edgeKey, edgeParameter, pointOnSegment, segmentIntersection, samePoint } from './geometry.js';
class PointIndex {
    snapTolerance;
    points = [];
    pointSources = [];
    exact = new Map();
    snapped = new Map();
    constructor(snapTolerance) {
        this.snapTolerance = snapTolerance;
    }
    add(p, source = -1) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            throw new CDTError(`point coordinates must be finite, got (${p.x}, ${p.y})`);
        }
        const key = this.key(p);
        const table = this.snapTolerance > 0 ? this.snapped : this.exact;
        const found = table.get(key);
        if (found !== undefined) {
            if (source >= 0 && !this.pointSources[found].includes(source))
                this.pointSources[found].push(source);
            return found;
        }
        const id = this.points.length;
        const stored = this.snapTolerance > 0
            ? { x: Math.round(p.x / this.snapTolerance) * this.snapTolerance, y: Math.round(p.y / this.snapTolerance) * this.snapTolerance }
            : { x: p.x, y: p.y };
        this.points.push(stored);
        this.pointSources.push(source >= 0 ? [source] : []);
        table.set(key, id);
        return id;
    }
    key(p) {
        if (this.snapTolerance > 0) {
            return `${Math.round(p.x / this.snapTolerance)}:${Math.round(p.y / this.snapTolerance)}`;
        }
        return `${Object.is(p.x, -0) ? 0 : p.x}:${Object.is(p.y, -0) ? 0 : p.y}`;
    }
}
function normalizePoints(points) {
    if (points instanceof Float64Array || (Array.isArray(points) && typeof points[0] === 'number')) {
        const arr = points;
        if (arr.length % 2 !== 0)
            throw new CDTError('flat point array length must be even');
        const out = [];
        for (let i = 0; i < arr.length; i += 2)
            out.push({ x: Number(arr[i]), y: Number(arr[i + 1]) });
        return out;
    }
    return points.map((p) => ({ x: p.x, y: p.y }));
}
function normalizeEdges(edges) {
    if (!edges)
        return [];
    if (edges instanceof Uint32Array || (Array.isArray(edges) && typeof edges[0] === 'number')) {
        const arr = edges;
        if (arr.length % 2 !== 0)
            throw new CDTError('flat edge array length must be even');
        const out = [];
        for (let i = 0; i < arr.length; i += 2)
            out.push([Number(arr[i]), Number(arr[i + 1])]);
        return out;
    }
    return edges.map((e) => [e[0], e[1]]);
}
function normalizeRing(ring) {
    if (ring.length === 0)
        return [];
    const out = Array.from(ring);
    if (out.length > 1 && out[0] === out[out.length - 1])
        out.pop();
    return out;
}
function addRingSegments(segments, ring, sourceStart) {
    const r = normalizeRing(ring);
    if (r.length < 2)
        return sourceStart;
    let source = sourceStart;
    for (let i = 0; i < r.length; i++) {
        segments.push({ a: r[i], b: r[(i + 1) % r.length], source: source++ });
    }
    return source;
}
function validateIndex(index, count, label) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
        throw new CDTError(`${label} index ${index} is outside [0, ${count})`);
    }
}
function addSplit(split, segmentId, pointId) {
    let set = split.get(segmentId);
    if (!set) {
        set = new Set();
        split.set(segmentId, set);
    }
    set.add(pointId);
}
/**
 * Builds a planar straight-line graph: duplicate points are merged, all constraint intersections,
 * T-junctions and collinear overlaps are split into atomic non-crossing constraint edges.
 */
export function buildPlanarGraph(input, options = {}) {
    const rawPoints = normalizePoints(input.points);
    const pointIndex = new PointIndex(options.snapTolerance ?? 0);
    const pointRemap = [];
    for (let i = 0; i < rawPoints.length; i++) {
        pointRemap[i] = pointIndex.add(rawPoints[i], i);
    }
    let source = 0;
    const rawSegments = [];
    for (const edge of normalizeEdges(input.edges)) {
        validateIndex(edge[0], rawPoints.length, 'edge');
        validateIndex(edge[1], rawPoints.length, 'edge');
        rawSegments.push({ a: pointRemap[edge[0]], b: pointRemap[edge[1]], source: source++ });
    }
    const polygons = [];
    for (const polygon of input.polygons ?? []) {
        const outer = normalizeRing(polygon.outer).map((id) => {
            validateIndex(id, rawPoints.length, 'polygon outer');
            return pointRemap[id];
        });
        const holes = polygon.holes?.map((ring) => normalizeRing(ring).map((id) => {
            validateIndex(id, rawPoints.length, 'polygon hole');
            return pointRemap[id];
        }));
        const normalized = {
            outer,
            ...(holes === undefined ? {} : { holes }),
            ...(polygon.region === undefined ? {} : { region: polygon.region }),
        };
        polygons.push(normalized);
        source = addRingSegments(rawSegments, outer, source);
        for (const hole of holes ?? [])
            source = addRingSegments(rawSegments, hole, source);
    }
    const segments = rawSegments.filter((s) => s.a !== s.b);
    const split = new Map();
    for (let i = 0; i < segments.length; i++) {
        addSplit(split, i, segments[i].a);
        addSplit(split, i, segments[i].b);
    }
    let intersectionPointCount = 0;
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const a = pointIndex.points[s.a];
        const b = pointIndex.points[s.b];
        // Split constraints at unconstrained vertices lying exactly on them.
        for (let p = 0; p < pointIndex.points.length; p++) {
            if (p === s.a || p === s.b)
                continue;
            if (pointOnSegment(pointIndex.points[p], a, b))
                addSplit(split, i, p);
        }
    }
    for (let i = 0; i < segments.length; i++) {
        const s0 = segments[i];
        const a = pointIndex.points[s0.a];
        const b = pointIndex.points[s0.b];
        for (let j = i + 1; j < segments.length; j++) {
            const s1 = segments[j];
            const c = pointIndex.points[s1.a];
            const d = pointIndex.points[s1.b];
            const relation = segmentIntersection(a, b, c, d);
            if (relation.points.length === 0)
                continue;
            for (const p of relation.points) {
                const before = pointIndex.points.length;
                const id = pointIndex.add(p, -1);
                if (pointIndex.points.length > before)
                    intersectionPointCount++;
                if (pointOnSegment(pointIndex.points[id], a, b))
                    addSplit(split, i, id);
                if (pointOnSegment(pointIndex.points[id], c, d))
                    addSplit(split, j, id);
            }
        }
    }
    const edgeSources = new Map();
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const a = pointIndex.points[s.a];
        const b = pointIndex.points[s.b];
        const ids = Array.from(split.get(i) ?? []);
        ids.sort((lhs, rhs) => edgeParameter(a, b, pointIndex.points[lhs]) - edgeParameter(a, b, pointIndex.points[rhs]));
        let prev = -1;
        for (const id of ids) {
            if (prev >= 0 && id !== prev && !samePoint(pointIndex.points[prev], pointIndex.points[id])) {
                const key = edgeKey(prev, id);
                let sources = edgeSources.get(key);
                if (!sources) {
                    sources = [];
                    edgeSources.set(key, sources);
                }
                if (!sources.includes(s.source))
                    sources.push(s.source);
            }
            prev = id;
        }
    }
    const constraints = [];
    const constraintSources = [];
    for (const [key, sources] of edgeSources) {
        const [aText, bText] = key.split(':');
        constraints.push([Number(aText), Number(bText)]);
        constraintSources.push(sources);
    }
    return {
        points: pointIndex.points,
        pointSources: pointIndex.pointSources,
        constraints,
        constraintSources,
        polygons,
        inputPointCount: rawPoints.length,
        inputConstraintCount: segments.length,
        intersectionPointCount,
    };
}
//# sourceMappingURL=noding.js.map