import { buildPlanarGraph } from './noding.js';
import { delaunayTriangulate } from './delaunay.js';
import { recoverConstraints, legalizeConstrainedDelaunay, validateMesh } from './mesh.js';
import { pointInRing, triangleCentroid } from './geometry.js';
function ringPoints(points, ring) {
    return ring.map((id) => points[id]);
}
function triangleRegion(points, tri, polygons) {
    if (polygons.length === 0)
        return -1;
    const p = triangleCentroid(points[tri[0]], points[tri[1]], points[tri[2]]);
    for (let i = polygons.length - 1; i >= 0; i--) {
        const polygon = polygons[i];
        if (!pointInRing(p, ringPoints(points, polygon.outer)))
            continue;
        let inHole = false;
        for (const hole of polygon.holes ?? []) {
            if (pointInRing(p, ringPoints(points, hole))) {
                inHole = true;
                break;
            }
        }
        if (!inHole)
            return polygon.region ?? i;
    }
    return -1;
}
function filterByPolygons(points, triangles, polygons, keepExterior) {
    const kept = [];
    const regions = [];
    if (polygons.length === 0) {
        for (const tri of triangles) {
            kept.push(tri);
            regions.push(-1);
        }
        return { triangles: kept, regions };
    }
    for (const tri of triangles) {
        const region = triangleRegion(points, tri, polygons);
        if (region >= 0 || keepExterior) {
            kept.push(tri);
            regions.push(region);
        }
    }
    return { triangles: kept, regions };
}
function flattenTriangles(triangles) {
    const out = [];
    for (const tri of triangles)
        out.push(tri[0], tri[1], tri[2]);
    return out;
}
function flattenEdges(edges) {
    const out = [];
    for (const edge of edges)
        out.push(edge[0], edge[1]);
    return out;
}
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
export function triangulateCDT(input, options = {}) {
    const graph = buildPlanarGraph(input, options);
    const delaunay = delaunayTriangulate(graph.points);
    const hasConstraints = graph.constraints.length > 0;
    const recovered = hasConstraints
        ? recoverConstraints(delaunay, graph.points, graph.constraints, options.maxConstraintFlips ?? 1_000_000)
        : { triangles: delaunay, constraintSet: new Set(), constraintFlips: 0 };
    const legalized = hasConstraints
        ? legalizeConstrainedDelaunay(recovered.triangles, graph.points, recovered.constraintSet, options.maxLegalizeSteps ?? 1_000_000)
        : { triangles: recovered.triangles, flips: 0 };
    if (options.validate)
        validateMesh(legalized.triangles, graph.points, graph.constraints);
    const filtered = filterByPolygons(graph.points, legalized.triangles, graph.polygons, options.keepExterior ?? false);
    return {
        points: graph.points,
        triangles: flattenTriangles(filtered.triangles),
        constraints: flattenEdges(graph.constraints),
        triangleRegions: filtered.regions,
        pointSources: graph.pointSources,
        constraintSources: graph.constraintSources,
        stats: {
            inputPointCount: graph.inputPointCount,
            outputPointCount: graph.points.length,
            inputConstraintCount: graph.inputConstraintCount,
            outputConstraintCount: graph.constraints.length,
            rawTriangleCount: legalized.triangles.length,
            outputTriangleCount: filtered.triangles.length,
            constraintFlips: recovered.constraintFlips,
            legalizeFlips: legalized.flips,
            intersectionPointCount: graph.intersectionPointCount,
        },
    };
}
//# sourceMappingURL=cdt.js.map