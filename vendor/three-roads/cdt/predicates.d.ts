import type { Point2 } from './types.js';
/**
 * Robust orientation determinant for a,b,c.
 * The sign is exact for finite IEEE-754 double coordinates. The magnitude is approximate.
 */
export declare function orient2d(a: Point2, b: Point2, c: Point2): number;
export declare function orientSign(a: Point2, b: Point2, c: Point2): number;
/**
 * Robust in-circle determinant.
 * Positive means d lies inside the circumcircle of CCW triangle a,b,c.
 * The sign is exact for finite IEEE-754 double coordinates. The magnitude is approximate.
 */
export declare function incircle(a: Point2, b: Point2, c: Point2, d: Point2): number;
export declare function incircleSign(a: Point2, b: Point2, c: Point2, d: Point2): number;
/** Coordinate-form orientation determinant. Positive means a,b,c are CCW. */
export declare function orient2dCoords(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number;
export declare function orientSignCoords(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number;
/** Coordinate-form robust in-circle determinant. Positive means d is inside CCW abc. */
export declare function incircleCoords(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number;
export declare function incircleSignCoords(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number;
//# sourceMappingURL=predicates.d.ts.map