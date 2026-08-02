/*
 * Fast advancing-hull Delaunay backend.
 *
 * This TypeScript backend is derived from the public Delaunator algorithm by Vladimir Agafonkin
 * (ISC license), with local changes for this package:
 * - no runtime dependency on npm packages;
 * - coordinate-form adaptive predicates from this package;
 * - dynamically sized legalization stack instead of a fixed 512-edge cap;
 * - TypeScript declarations and a narrow internal API.
 */
import { incircleSignCoords, orient2dCoords } from './predicates.js';
const EPSILON = Math.pow(2, -52);
export class FastDelaunator {
    coords;
    hull;
    triangles;
    halfedges;
    trianglesStorage;
    halfedgesStorage;
    hullPrev;
    hullNext;
    hullTri;
    hullHash;
    ids;
    dists;
    edgeStack;
    trianglesLen = 0;
    cx = 0;
    cy = 0;
    hullStart = 0;
    hashSize;
    constructor(coords) {
        const n = coords.length >> 1;
        this.coords = coords;
        const maxTriangles = Math.max(2 * n - 5, 0);
        this.trianglesStorage = new Uint32Array(maxTriangles * 3);
        this.halfedgesStorage = new Int32Array(maxTriangles * 3);
        this.hashSize = Math.max(1, Math.ceil(Math.sqrt(n)));
        this.hullPrev = new Uint32Array(n);
        this.hullNext = new Uint32Array(n);
        this.hullTri = new Uint32Array(n);
        this.hullHash = new Int32Array(this.hashSize);
        this.ids = new Uint32Array(n);
        this.dists = new Float64Array(n);
        this.edgeStack = new Uint32Array(Math.max(512, maxTriangles * 3));
        this.hull = this.trianglesStorage;
        this.triangles = this.trianglesStorage;
        this.halfedges = this.halfedgesStorage;
        this.update();
    }
    update() {
        const coords = this.coords;
        const n = coords.length >> 1;
        const hullPrev = this.hullPrev;
        const hullNext = this.hullNext;
        const hullTri = this.hullTri;
        const hullHash = this.hullHash;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < n; i++) {
            const x = coords[2 * i];
            const y = coords[2 * i + 1];
            if (x < minX)
                minX = x;
            if (y < minY)
                minY = y;
            if (x > maxX)
                maxX = x;
            if (y > maxY)
                maxY = y;
            this.ids[i] = i;
        }
        const bboxCx = (minX + maxX) / 2;
        const bboxCy = (minY + maxY) / 2;
        let i0 = 0;
        let i1 = 0;
        let i2 = 0;
        for (let i = 0, minDist = Infinity; i < n; i++) {
            const d = dist(bboxCx, bboxCy, coords[2 * i], coords[2 * i + 1]);
            if (d < minDist) {
                i0 = i;
                minDist = d;
            }
        }
        const i0x = coords[2 * i0];
        const i0y = coords[2 * i0 + 1];
        for (let i = 0, minDist = Infinity; i < n; i++) {
            if (i === i0)
                continue;
            const d = dist(i0x, i0y, coords[2 * i], coords[2 * i + 1]);
            if (d < minDist && d > 0) {
                i1 = i;
                minDist = d;
            }
        }
        let i1x = coords[2 * i1];
        let i1y = coords[2 * i1 + 1];
        let minRadius = Infinity;
        for (let i = 0; i < n; i++) {
            if (i === i0 || i === i1)
                continue;
            const r = circumradius(i0x, i0y, i1x, i1y, coords[2 * i], coords[2 * i + 1]);
            if (r < minRadius) {
                i2 = i;
                minRadius = r;
            }
        }
        let i2x = coords[2 * i2];
        let i2y = coords[2 * i2 + 1];
        if (minRadius === Infinity) {
            for (let i = 0; i < n; i++) {
                this.dists[i] = (coords[2 * i] - coords[0]) || (coords[2 * i + 1] - coords[1]);
            }
            quicksort(this.ids, this.dists, 0, n - 1);
            const hull = new Uint32Array(n);
            let j = 0;
            for (let i = 0, d0 = -Infinity; i < n; i++) {
                const id = this.ids[i];
                const d = this.dists[id];
                if (d > d0) {
                    hull[j++] = id;
                    d0 = d;
                }
            }
            this.hull = hull.subarray(0, j);
            this.triangles = new Uint32Array(0);
            this.halfedges = new Int32Array(0);
            return;
        }
        // Delaunator's orientation convention is negative for mathematical CCW.
        if (orientForDelaunator(i0x, i0y, i1x, i1y, i2x, i2y) < 0) {
            const i = i1;
            const x = i1x;
            const y = i1y;
            i1 = i2;
            i1x = i2x;
            i1y = i2y;
            i2 = i;
            i2x = x;
            i2y = y;
        }
        const center = circumcenter(i0x, i0y, i1x, i1y, i2x, i2y);
        this.cx = center.x;
        this.cy = center.y;
        for (let i = 0; i < n; i++) {
            this.dists[i] = dist(coords[2 * i], coords[2 * i + 1], center.x, center.y);
        }
        quicksort(this.ids, this.dists, 0, n - 1);
        this.hullStart = i0;
        let hullSize = 3;
        hullNext[i0] = i1;
        hullPrev[i2] = i1;
        hullNext[i1] = i2;
        hullPrev[i0] = i2;
        hullNext[i2] = i0;
        hullPrev[i1] = i0;
        hullTri[i0] = 0;
        hullTri[i1] = 1;
        hullTri[i2] = 2;
        hullHash.fill(-1);
        hullHash[this.hashKey(i0x, i0y)] = i0;
        hullHash[this.hashKey(i1x, i1y)] = i1;
        hullHash[this.hashKey(i2x, i2y)] = i2;
        this.trianglesLen = 0;
        this.addTriangle(i0, i1, i2, -1, -1, -1);
        for (let k = 0, xp = 0, yp = 0; k < this.ids.length; k++) {
            const i = this.ids[k];
            const x = coords[2 * i];
            const y = coords[2 * i + 1];
            if (k > 0 && Math.abs(x - xp) <= EPSILON && Math.abs(y - yp) <= EPSILON)
                continue;
            xp = x;
            yp = y;
            if (i === i0 || i === i1 || i === i2)
                continue;
            let start = 0;
            const key = this.hashKey(x, y);
            for (let j = 0; j < this.hashSize; j++) {
                start = hullHash[(key + j) % this.hashSize];
                if (start !== -1 && start !== hullNext[start])
                    break;
            }
            start = hullPrev[start];
            let e = start;
            let q;
            while (q = hullNext[e], orientForDelaunator(x, y, coords[2 * e], coords[2 * e + 1], coords[2 * q], coords[2 * q + 1]) >= 0) {
                e = q;
                if (e === start) {
                    e = -1;
                    break;
                }
            }
            if (e === -1)
                continue;
            let t = this.addTriangle(e, i, hullNext[e], -1, -1, hullTri[e]);
            hullTri[i] = this.legalize(t + 2);
            hullTri[e] = t;
            hullSize++;
            let n2 = hullNext[e];
            while (q = hullNext[n2], orientForDelaunator(x, y, coords[2 * n2], coords[2 * n2 + 1], coords[2 * q], coords[2 * q + 1]) < 0) {
                t = this.addTriangle(n2, i, q, hullTri[i], -1, hullTri[n2]);
                hullTri[i] = this.legalize(t + 2);
                hullNext[n2] = n2;
                hullSize--;
                n2 = q;
            }
            if (e === start) {
                while (q = hullPrev[e], orientForDelaunator(x, y, coords[2 * q], coords[2 * q + 1], coords[2 * e], coords[2 * e + 1]) < 0) {
                    t = this.addTriangle(q, i, e, -1, hullTri[e], hullTri[q]);
                    this.legalize(t + 2);
                    hullTri[q] = t;
                    hullNext[e] = e;
                    hullSize--;
                    e = q;
                }
            }
            this.hullStart = e;
            hullPrev[i] = e;
            hullNext[e] = i;
            hullPrev[n2] = i;
            hullNext[i] = n2;
            hullHash[this.hashKey(x, y)] = i;
            hullHash[this.hashKey(coords[2 * e], coords[2 * e + 1])] = e;
        }
        this.hull = new Uint32Array(hullSize);
        for (let i = 0, e = this.hullStart; i < hullSize; i++) {
            this.hull[i] = e;
            e = hullNext[e];
        }
        this.triangles = this.trianglesStorage.subarray(0, this.trianglesLen);
        this.halfedges = this.halfedgesStorage.subarray(0, this.trianglesLen);
    }
    hashKey(x, y) {
        return Math.floor(pseudoAngle(x - this.cx, y - this.cy) * this.hashSize) % this.hashSize;
    }
    legalize(aIn) {
        const triangles = this.trianglesStorage;
        const halfedges = this.halfedgesStorage;
        const coords = this.coords;
        const edgeStack = this.edgeStack;
        let a = aIn;
        let i = 0;
        let ar = 0;
        while (true) {
            const b = halfedges[a];
            const a0 = a - a % 3;
            ar = a0 + (a + 2) % 3;
            if (b === -1) {
                if (i === 0)
                    break;
                a = edgeStack[--i];
                continue;
            }
            const b0 = b - b % 3;
            const al = a0 + (a + 1) % 3;
            const bl = b0 + (b + 2) % 3;
            const p0 = triangles[ar];
            const pr = triangles[a];
            const pl = triangles[al];
            const p1 = triangles[bl];
            const illegal = inCircleForDelaunator(coords[2 * p0], coords[2 * p0 + 1], coords[2 * pr], coords[2 * pr + 1], coords[2 * pl], coords[2 * pl + 1], coords[2 * p1], coords[2 * p1 + 1]);
            if (illegal) {
                triangles[a] = p1;
                triangles[b] = p0;
                const hbl = halfedges[bl];
                if (hbl === -1) {
                    let e = this.hullStart;
                    do {
                        if (this.hullTri[e] === bl) {
                            this.hullTri[e] = a;
                            break;
                        }
                        e = this.hullPrev[e];
                    } while (e !== this.hullStart);
                }
                this.link(a, hbl);
                this.link(b, halfedges[ar]);
                this.link(ar, bl);
                const br = b0 + (b + 1) % 3;
                edgeStack[i++] = br;
            }
            else {
                if (i === 0)
                    break;
                a = edgeStack[--i];
            }
        }
        return ar;
    }
    link(a, b) {
        this.halfedgesStorage[a] = b;
        if (b !== -1)
            this.halfedgesStorage[b] = a;
    }
    addTriangle(i0, i1, i2, a, b, c) {
        const t = this.trianglesLen;
        this.trianglesStorage[t] = i0;
        this.trianglesStorage[t + 1] = i1;
        this.trianglesStorage[t + 2] = i2;
        this.link(t, a);
        this.link(t + 1, b);
        this.link(t + 2, c);
        this.trianglesLen += 3;
        return t;
    }
}
function orientForDelaunator(ax, ay, bx, by, cx, cy) {
    return -orient2dCoords(ax, ay, bx, by, cx, cy);
}
function pseudoAngle(dx, dy) {
    const p = dx / (Math.abs(dx) + Math.abs(dy));
    return (dy > 0 ? 3 - p : 1 + p) / 4;
}
function dist(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}
function inCircleForDelaunator(ax, ay, bx, by, cx, cy, px, py) {
    // The backend stores triangles in Delaunator orientation, which is opposite our mathematical
    // CCW convention, so an inside point has a negative determinant here.
    return incircleSignCoords(ax, ay, bx, by, cx, cy, px, py) < 0;
}
function circumradius(ax, ay, bx, by, cx, cy) {
    const dx = bx - ax;
    const dy = by - ay;
    const ex = cx - ax;
    const ey = cy - ay;
    const bl = dx * dx + dy * dy;
    const cl = ex * ex + ey * ey;
    const d = 0.5 / (dx * ey - dy * ex);
    const x = (ey * bl - dy * cl) * d;
    const y = (dx * cl - ex * bl) * d;
    return x * x + y * y;
}
function circumcenter(ax, ay, bx, by, cx, cy) {
    const dx = bx - ax;
    const dy = by - ay;
    const ex = cx - ax;
    const ey = cy - ay;
    const bl = dx * dx + dy * dy;
    const cl = ex * ex + ey * ey;
    const d = 0.5 / (dx * ey - dy * ex);
    return {
        x: ax + (ey * bl - dy * cl) * d,
        y: ay + (dx * cl - ex * bl) * d,
    };
}
function quicksort(ids, dists, left, right) {
    if (right <= left)
        return;
    if (right - left <= 20) {
        for (let i = left + 1; i <= right; i++) {
            const temp = ids[i];
            const tempDist = dists[temp];
            let j = i - 1;
            while (j >= left && dists[ids[j]] > tempDist) {
                ids[j + 1] = ids[j];
                j--;
            }
            ids[j + 1] = temp;
        }
    }
    else {
        const median = (left + right) >> 1;
        let i = left + 1;
        let j = right;
        swap(ids, median, i);
        if (dists[ids[left]] > dists[ids[right]])
            swap(ids, left, right);
        if (dists[ids[i]] > dists[ids[right]])
            swap(ids, i, right);
        if (dists[ids[left]] > dists[ids[i]])
            swap(ids, left, i);
        const temp = ids[i];
        const tempDist = dists[temp];
        while (true) {
            do
                i++;
            while (dists[ids[i]] < tempDist);
            do
                j--;
            while (dists[ids[j]] > tempDist);
            if (j < i)
                break;
            swap(ids, i, j);
        }
        ids[left + 1] = ids[j];
        ids[j] = temp;
        if (right - i + 1 >= j - left) {
            quicksort(ids, dists, i, right);
            quicksort(ids, dists, left, j - 1);
        }
        else {
            quicksort(ids, dists, left, j - 1);
            quicksort(ids, dists, i, right);
        }
    }
}
function swap(arr, i, j) {
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
}
//# sourceMappingURL=delaunator_backend.js.map