import { DegenerateInputError } from './types.js';
import { orientSign } from './predicates.js';
import { FastDelaunator } from './delaunator_backend.js';
export function makeTriangle(a, b, c, points) {
    const sign = orientSign(points[a], points[b], points[c]);
    if (sign > 0)
        return [a, b, c];
    if (sign < 0)
        return [b, a, c];
    return null;
}
function hasNonCollinearTriple(points) {
    if (points.length < 3)
        return false;
    let a = 0;
    let b = 1;
    while (b < points.length && points[a].x === points[b].x && points[a].y === points[b].y)
        b++;
    if (b >= points.length)
        return false;
    for (let c = b + 1; c < points.length; c++) {
        if (orientSign(points[a], points[b], points[c]) !== 0)
            return true;
    }
    return false;
}
/**
 * Fast advancing-hull Delaunay triangulation with adaptive exact predicate signs.
 *
 * The implementation keeps the public output convention used by the rest of the package:
 * every returned triangle is mathematical CCW in x/y coordinates.
 */
export function delaunayTriangulate(inputPoints) {
    if (inputPoints.length < 3)
        return [];
    const coords = new Float64Array(inputPoints.length * 2);
    for (let i = 0; i < inputPoints.length; i++) {
        const p = inputPoints[i];
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            throw new DegenerateInputError(`point ${i} has non-finite coordinates (${p.x}, ${p.y})`);
        }
        coords[2 * i] = p.x;
        coords[2 * i + 1] = p.y;
    }
    const fast = new FastDelaunator(coords);
    if (fast.triangles.length === 0) {
        if (!hasNonCollinearTriple(inputPoints)) {
            throw new DegenerateInputError('all points are collinear; no 2D triangulation exists');
        }
        throw new DegenerateInputError('no finite triangles were produced');
    }
    const out = [];
    for (let i = 0; i < fast.triangles.length; i += 3) {
        const tri = makeTriangle(fast.triangles[i], fast.triangles[i + 1], fast.triangles[i + 2], inputPoints);
        if (tri)
            out.push(tri);
    }
    return out;
}
//# sourceMappingURL=delaunay.js.map