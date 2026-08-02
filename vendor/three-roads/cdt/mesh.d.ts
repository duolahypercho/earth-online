import type { Point2 } from './types.js';
import type { Triangle } from './delaunay.js';
export interface EdgeAdjacency {
    readonly a: number;
    readonly b: number;
    readonly tris: number[];
}
export interface ConstraintRecoveryStats {
    readonly triangles: Triangle[];
    readonly constraintSet: Set<string>;
    readonly constraintFlips: number;
}
export interface LegalizeStats {
    readonly triangles: Triangle[];
    readonly flips: number;
}
export declare function buildEdgeMap(triangles: readonly Triangle[]): Map<string, EdgeAdjacency>;
export declare function hasEdge(triangles: readonly Triangle[], a: number, b: number): boolean;
export declare function recoverConstraints(initialTriangles: readonly Triangle[], points: readonly Point2[], constraints: readonly (readonly [number, number])[], maxConstraintFlips?: number): ConstraintRecoveryStats;
export declare function legalizeConstrainedDelaunay(initialTriangles: readonly Triangle[], points: readonly Point2[], constraintSet: ReadonlySet<string>, maxSteps?: number): LegalizeStats;
export declare function validateMesh(triangles: readonly Triangle[], points: readonly Point2[], constraints: readonly (readonly [number, number])[]): void;
//# sourceMappingURL=mesh.d.ts.map