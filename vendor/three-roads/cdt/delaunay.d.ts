import type { Point2 } from './types.js';
export type Triangle = [number, number, number];
export declare function makeTriangle(a: number, b: number, c: number, points: readonly Point2[]): Triangle | null;
/**
 * Fast advancing-hull Delaunay triangulation with adaptive exact predicate signs.
 *
 * The implementation keeps the public output convention used by the rest of the package:
 * every returned triangle is mathematical CCW in x/y coordinates.
 */
export declare function delaunayTriangulate(inputPoints: readonly Point2[]): Triangle[];
//# sourceMappingURL=delaunay.d.ts.map