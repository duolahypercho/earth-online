import type { CDTInput, CDTOptions, CDTResult } from './types.js';
/**
 * Pure TypeScript constrained Delaunay triangulation for planar straight-line graphs.
 *
 * Contract:
 * - finite double coordinates only;
 * - exact predicate signs for orientation/incircle;
 * - constraints are noded before triangulation, so intersections/T-junctions/overlaps become vertices;
 * - all returned triangles are CCW;
 * - polygon domains, when supplied, are used only for output filtering/region labels.
 */
export declare function triangulateCDT(input: CDTInput, options?: CDTOptions): CDTResult;
//# sourceMappingURL=cdt.d.ts.map