export declare class FastDelaunator {
    readonly coords: Float64Array;
    hull: Uint32Array;
    triangles: Uint32Array;
    halfedges: Int32Array;
    private readonly trianglesStorage;
    private readonly halfedgesStorage;
    private readonly hullPrev;
    private readonly hullNext;
    private readonly hullTri;
    private readonly hullHash;
    private readonly ids;
    private readonly dists;
    private readonly edgeStack;
    private trianglesLen;
    private cx;
    private cy;
    private hullStart;
    private readonly hashSize;
    constructor(coords: Float64Array);
    update(): void;
    private hashKey;
    private legalize;
    private link;
    private addTriangle;
}
//# sourceMappingURL=delaunator_backend.d.ts.map