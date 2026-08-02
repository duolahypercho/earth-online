import { ConstraintRecoveryError } from './types.js';
import { makeTriangle } from './delaunay.js';
import { edgeKey, segmentsProperlyIntersect, unpackEdgeKey } from './geometry.js';
import { incircleSign, orientSign } from './predicates.js';
export function buildEdgeMap(triangles) {
    const map = new Map();
    for (let i = 0; i < triangles.length; i++) {
        const tri = triangles[i];
        const edges = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]];
        for (const [a, b] of edges) {
            const key = edgeKey(a, b);
            let entry = map.get(key);
            if (!entry) {
                const [u, v] = a < b ? [a, b] : [b, a];
                entry = { a: u, b: v, tris: [] };
                map.set(key, entry);
            }
            entry.tris.push(i);
        }
    }
    return map;
}
export function hasEdge(triangles, a, b) {
    const key = edgeKey(a, b);
    return buildEdgeMap(triangles).has(key);
}
function oppositeVertex(tri, a, b) {
    if (tri[0] !== a && tri[0] !== b)
        return tri[0];
    if (tri[1] !== a && tri[1] !== b)
        return tri[1];
    return tri[2];
}
function flipPreview(triangles, entry, points) {
    if (entry.tris.length !== 2)
        return null;
    const tri0 = triangles[entry.tris[0]];
    const tri1 = triangles[entry.tris[1]];
    const u = entry.a;
    const v = entry.b;
    const x = oppositeVertex(tri0, u, v);
    const y = oppositeVertex(tri1, u, v);
    if (x === y || x === u || x === v || y === u || y === v)
        return null;
    // A valid diagonal flip in a triangulation requires the old and new diagonals to cross.
    if (!segmentsProperlyIntersect(points[u], points[v], points[x], points[y]))
        return null;
    const nt0 = makeTriangle(x, y, u, points);
    const nt1 = makeTriangle(y, x, v, points);
    if (!nt0 || !nt1)
        return null;
    return [nt0, nt1];
}
function flippedDiagonal(triangles, entry) {
    if (entry.tris.length !== 2)
        return null;
    const tri0 = triangles[entry.tris[0]];
    const tri1 = triangles[entry.tris[1]];
    const x = oppositeVertex(tri0, entry.a, entry.b);
    const y = oppositeVertex(tri1, entry.a, entry.b);
    return x === y ? null : [x, y];
}
function flipEdge(triangles, entry, points) {
    const preview = flipPreview(triangles, entry, points);
    if (!preview)
        return false;
    triangles[entry.tris[0]] = preview[0];
    triangles[entry.tris[1]] = preview[1];
    return true;
}
function findCrossingEdge(triangles, points, constraintSet, a, b) {
    const map = buildEdgeMap(triangles);
    const pa = points[a];
    const pb = points[b];
    for (const [key, entry] of map) {
        if (entry.tris.length !== 2)
            continue;
        if (constraintSet.has(key))
            continue;
        const u = entry.a;
        const v = entry.b;
        if (u === a || u === b || v === a || v === b)
            continue;
        if (!segmentsProperlyIntersect(pa, pb, points[u], points[v]))
            continue;
        if (!flipPreview(triangles, entry, points))
            continue;
        const replacement = flippedDiagonal(triangles, entry);
        if (replacement && segmentsProperlyIntersect(pa, pb, points[replacement[0]], points[replacement[1]]))
            continue;
        return entry;
    }
    return null;
}
export function recoverConstraints(initialTriangles, points, constraints, maxConstraintFlips = 1_000_000) {
    const triangles = initialTriangles.map((t) => [t[0], t[1], t[2]]);
    const constraintSet = new Set();
    let flips = 0;
    for (const [a, b] of constraints) {
        if (a === b)
            continue;
        const targetKey = edgeKey(a, b);
        let map = buildEdgeMap(triangles);
        let guard = 0;
        while (!map.has(targetKey)) {
            if (guard++ > maxConstraintFlips) {
                throw new ConstraintRecoveryError(`constraint ${targetKey} exceeded flip budget ${maxConstraintFlips}`);
            }
            const crossing = findCrossingEdge(triangles, points, constraintSet, a, b);
            if (!crossing) {
                throw new ConstraintRecoveryError(`could not recover constraint ${targetKey}; no flippable crossing edge found`);
            }
            if (!flipEdge(triangles, crossing, points)) {
                throw new ConstraintRecoveryError(`could not flip crossing edge ${crossing.a}:${crossing.b} while recovering ${targetKey}`);
            }
            flips++;
            map = buildEdgeMap(triangles);
        }
        constraintSet.add(targetKey);
    }
    return { triangles, constraintSet, constraintFlips: flips };
}
function shouldFlipForDelaunay(entry, triangles, points) {
    if (entry.tris.length !== 2)
        return false;
    const u = entry.a;
    const v = entry.b;
    const t0 = triangles[entry.tris[0]];
    const t1 = triangles[entry.tris[1]];
    const x = oppositeVertex(t0, u, v);
    const y = oppositeVertex(t1, u, v);
    if (!segmentsProperlyIntersect(points[u], points[v], points[x], points[y]))
        return false;
    let a = u;
    let b = v;
    const c = x;
    const d = y;
    if (orientSign(points[a], points[b], points[c]) < 0) {
        const tmp = a;
        a = b;
        b = tmp;
    }
    return incircleSign(points[a], points[b], points[c], points[d]) > 0;
}
export function legalizeConstrainedDelaunay(initialTriangles, points, constraintSet, maxSteps = 1_000_000) {
    const triangles = initialTriangles.map((t) => [t[0], t[1], t[2]]);
    let flips = 0;
    let steps = 0;
    let changed = true;
    while (changed) {
        changed = false;
        const map = buildEdgeMap(triangles);
        for (const [key, entry] of map) {
            if (constraintSet.has(key))
                continue;
            if (++steps > maxSteps)
                return { triangles, flips };
            if (!shouldFlipForDelaunay(entry, triangles, points))
                continue;
            if (flipEdge(triangles, entry, points)) {
                flips++;
                changed = true;
                break;
            }
        }
    }
    return { triangles, flips };
}
export function validateMesh(triangles, points, constraints) {
    for (let i = 0; i < triangles.length; i++) {
        const tri = triangles[i];
        if (tri[0] === tri[1] || tri[1] === tri[2] || tri[2] === tri[0]) {
            throw new ConstraintRecoveryError(`triangle ${i} has duplicate vertices`);
        }
        if (orientSign(points[tri[0]], points[tri[1]], points[tri[2]]) <= 0) {
            throw new ConstraintRecoveryError(`triangle ${i} is not CCW or has zero area`);
        }
    }
    const map = buildEdgeMap(triangles);
    for (const [a, b] of constraints) {
        if (!map.has(edgeKey(a, b))) {
            throw new ConstraintRecoveryError(`constraint ${edgeKey(a, b)} missing from triangulation`);
        }
    }
    for (const [key, entry] of map) {
        if (entry.tris.length > 2)
            throw new ConstraintRecoveryError(`non-manifold edge ${key}`);
        const [a, b] = unpackEdgeKey(key);
        if (!Number.isInteger(a) || !Number.isInteger(b))
            throw new ConstraintRecoveryError(`bad edge key ${key}`);
    }
}
//# sourceMappingURL=mesh.js.map