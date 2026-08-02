import type { CDTInput, CDTOptions, Edge2, Point2, Polygon2 } from './types.js';
interface MutablePlanarGraph {
    readonly points: Point2[];
    readonly pointSources: number[][];
    readonly constraints: Edge2[];
    readonly constraintSources: number[][];
    readonly polygons: Polygon2[];
    readonly inputPointCount: number;
    readonly inputConstraintCount: number;
    readonly intersectionPointCount: number;
}
export type PlanarGraph = MutablePlanarGraph;
/**
 * Builds a planar straight-line graph: duplicate points are merged, all constraint intersections,
 * T-junctions and collinear overlaps are split into atomic non-crossing constraint edges.
 */
export declare function buildPlanarGraph(input: CDTInput, options?: CDTOptions): PlanarGraph;
export {};
//# sourceMappingURL=noding.d.ts.map