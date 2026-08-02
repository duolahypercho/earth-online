import type { Point2 } from './types.js';
export declare const enum SegmentKind {
    Disjoint = 0,
    Touching = 1,
    Proper = 2,
    Collinear = 3
}
export interface SegmentIntersection {
    readonly kind: SegmentKind;
    readonly points: readonly Point2[];
}
export declare function edgeKey(a: number, b: number): string;
export declare function unpackEdgeKey(key: string): [number, number];
export declare function samePoint(a: Point2, b: Point2): boolean;
export declare function lexLess(a: Point2, b: Point2): boolean;
export declare function bboxIntersects(a: Point2, b: Point2, c: Point2, d: Point2): boolean;
export declare function pointOnSegment(p: Point2, a: Point2, b: Point2): boolean;
export declare function segmentsProperlyIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean;
export declare function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean;
export declare function lineLineIntersection(a: Point2, b: Point2, c: Point2, d: Point2): Point2;
/** Returns exact topological relation; intersection coordinates are double approximations. */
export declare function segmentIntersection(a: Point2, b: Point2, c: Point2, d: Point2): SegmentIntersection;
export declare function edgeParameter(a: Point2, b: Point2, p: Point2): number;
export declare function triangleCentroid(a: Point2, b: Point2, c: Point2): Point2;
export declare function pointInRing(p: Point2, ring: readonly Point2[]): boolean;
//# sourceMappingURL=geometry.d.ts.map