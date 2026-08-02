import { orientSign } from './predicates.js';
export function edgeKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}
export function unpackEdgeKey(key) {
    const i = key.indexOf(':');
    return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}
export function samePoint(a, b) {
    return Object.is(a.x, b.x) && Object.is(a.y, b.y);
}
export function lexLess(a, b) {
    return a.x < b.x || (a.x === b.x && a.y < b.y);
}
export function bboxIntersects(a, b, c, d) {
    return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
        && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
}
export function pointOnSegment(p, a, b) {
    if (orientSign(a, b, p) !== 0)
        return false;
    return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
        && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}
export function segmentsProperlyIntersect(a, b, c, d) {
    if (!bboxIntersects(a, b, c, d))
        return false;
    const o1 = orientSign(a, b, c);
    const o2 = orientSign(a, b, d);
    const o3 = orientSign(c, d, a);
    const o4 = orientSign(c, d, b);
    return o1 * o2 < 0 && o3 * o4 < 0;
}
export function segmentsIntersect(a, b, c, d) {
    if (!bboxIntersects(a, b, c, d))
        return false;
    const o1 = orientSign(a, b, c);
    const o2 = orientSign(a, b, d);
    const o3 = orientSign(c, d, a);
    const o4 = orientSign(c, d, b);
    if (o1 * o2 < 0 && o3 * o4 < 0)
        return true;
    return (o1 === 0 && pointOnSegment(c, a, b))
        || (o2 === 0 && pointOnSegment(d, a, b))
        || (o3 === 0 && pointOnSegment(a, c, d))
        || (o4 === 0 && pointOnSegment(b, c, d));
}
export function lineLineIntersection(a, b, c, d) {
    const rx = b.x - a.x;
    const ry = b.y - a.y;
    const sx = d.x - c.x;
    const sy = d.y - c.y;
    const denom = rx * sy - ry * sx;
    if (denom === 0) {
        return { x: (a.x + b.x + c.x + d.x) * 0.25, y: (a.y + b.y + c.y + d.y) * 0.25 };
    }
    const qpx = c.x - a.x;
    const qpy = c.y - a.y;
    const t = (qpx * sy - qpy * sx) / denom;
    return { x: a.x + t * rx, y: a.y + t * ry };
}
function addUnique(points, p) {
    for (const q of points) {
        if (samePoint(p, q))
            return;
    }
    points.push(p);
}
/** Returns exact topological relation; intersection coordinates are double approximations. */
export function segmentIntersection(a, b, c, d) {
    if (!bboxIntersects(a, b, c, d))
        return { kind: 0 /* SegmentKind.Disjoint */, points: [] };
    const o1 = orientSign(a, b, c);
    const o2 = orientSign(a, b, d);
    const o3 = orientSign(c, d, a);
    const o4 = orientSign(c, d, b);
    if (o1 * o2 < 0 && o3 * o4 < 0) {
        return { kind: 2 /* SegmentKind.Proper */, points: [lineLineIntersection(a, b, c, d)] };
    }
    const points = [];
    if (o1 === 0 && pointOnSegment(c, a, b))
        addUnique(points, c);
    if (o2 === 0 && pointOnSegment(d, a, b))
        addUnique(points, d);
    if (o3 === 0 && pointOnSegment(a, c, d))
        addUnique(points, a);
    if (o4 === 0 && pointOnSegment(b, c, d))
        addUnique(points, b);
    if (points.length === 0)
        return { kind: 0 /* SegmentKind.Disjoint */, points: [] };
    if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
        points.sort((lhs, rhs) => (lexLess(lhs, rhs) ? -1 : lexLess(rhs, lhs) ? 1 : 0));
        return { kind: 3 /* SegmentKind.Collinear */, points };
    }
    return { kind: 1 /* SegmentKind.Touching */, points };
}
export function edgeParameter(a, b, p) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx === 0 ? 0 : (p.x - a.x) / dx;
    }
    return dy === 0 ? 0 : (p.y - a.y) / dy;
}
export function triangleCentroid(a, b, c) {
    return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
}
export function pointInRing(p, ring) {
    let inside = false;
    const n = ring.length;
    if (n < 3)
        return false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (pointOnSegment(p, a, b))
            return true;
        const yi = a.y;
        const yj = b.y;
        const crosses = (yi > p.y) !== (yj > p.y);
        if (crosses) {
            const x = (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
            if (p.x < x)
                inside = !inside;
        }
    }
    return inside;
}
//# sourceMappingURL=geometry.js.map