export interface Point2 {
    readonly x: number;
    readonly y: number;
}
export type Edge2 = readonly [number, number];
export interface Polygon2 {
    /** Ring vertex indices into input.points. The ring may be open or closed. */
    readonly outer: readonly number[];
    /** Hole ring vertex indices into input.points. Rings may be open or closed. */
    readonly holes?: readonly (readonly number[])[];
    /** Optional application-level region id copied to output triangles inside this polygon. */
    readonly region?: number;
}
export type PointInput = readonly Point2[] | readonly number[] | Float64Array;
export type EdgeInput = readonly Edge2[] | readonly number[] | Uint32Array;
export interface CDTInput {
    readonly points: PointInput;
    /** Constraint edges as pairs of input point indices. */
    readonly edges?: EdgeInput;
    /** Optional polygon domains. Polygon boundaries are automatically added as constraints. */
    readonly polygons?: readonly Polygon2[];
}
export interface CDTOptions {
    /**
     * Optional editor snap tolerance. 0 means exact duplicate merge only.
     * Non-zero values intentionally quantize vertices before topology processing.
     */
    readonly snapTolerance?: number;
    /**
     * If polygons are provided, false keeps only triangle domains inside polygons and outside holes.
     * true keeps the convex-hull exterior too and labels it with region -1.
     */
    readonly keepExterior?: boolean;
    /** Expensive consistency checks intended for development and CI. */
    readonly validate?: boolean;
    /** Max flips per recovered constraint. Defaults to 1_000_000. */
    readonly maxConstraintFlips?: number;
    /** Max global legalization passes. Defaults to 1_000_000 edge visits. */
    readonly maxLegalizeSteps?: number;
}
export interface CDTStats {
    readonly inputPointCount: number;
    readonly outputPointCount: number;
    readonly inputConstraintCount: number;
    readonly outputConstraintCount: number;
    readonly rawTriangleCount: number;
    readonly outputTriangleCount: number;
    readonly constraintFlips: number;
    readonly legalizeFlips: number;
    readonly intersectionPointCount: number;
}
export interface CDTResult {
    /** Final noded points. New intersection/T-junction points are appended. */
    readonly points: readonly Point2[];
    /** Flat triangle index array: [a,b,c, a,b,c, ...]. Triangles are CCW. */
    readonly triangles: readonly number[];
    /** Flat constrained edge index array: [a,b, a,b, ...]. */
    readonly constraints: readonly number[];
    /** Per-triangle region id. -1 means exterior/unclassified. */
    readonly triangleRegions: readonly number[];
    /** For every output point, original input point indices that collapsed into it. New split points have []. */
    readonly pointSources: readonly (readonly number[])[];
    /** For every output constraint edge, original edge ids / polygon boundary ids that produced it. */
    readonly constraintSources: readonly (readonly number[])[];
    readonly stats: CDTStats;
}
export declare class CDTError extends Error {
    constructor(message: string);
}
export declare class ConstraintRecoveryError extends CDTError {
    constructor(message: string);
}
export declare class DegenerateInputError extends CDTError {
    constructor(message: string);
}
//# sourceMappingURL=types.d.ts.map