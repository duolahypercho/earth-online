const EPSILON = 1.1102230246251565e-16;
const CCW_ERR_BOUND_A = (3 + 16 * EPSILON) * EPSILON;
const INCIRCLE_ERR_BOUND_A = (10 + 96 * EPSILON) * EPSILON;
const buffer = new ArrayBuffer(8);
const view = new DataView(buffer);
function finite(x, label) {
    if (!Number.isFinite(x)) {
        throw new Error(`${label} must be a finite number, got ${x}`);
    }
}
function doubleToDyadic(x) {
    finite(x, 'coordinate');
    if (x === 0)
        return { i: 0n, e: 0 };
    view.setFloat64(0, x, false);
    const hi = view.getUint32(0, false);
    const lo = view.getUint32(4, false);
    const sign = (hi >>> 31) === 0 ? 1n : -1n;
    const expBits = (hi >>> 20) & 0x7ff;
    const fracHigh = hi & 0xfffff;
    const fraction = (BigInt(fracHigh) << 32n) | BigInt(lo);
    if (expBits === 0) {
        if (fraction === 0n)
            return { i: 0n, e: 0 };
        return { i: sign * fraction, e: -1074 };
    }
    const mantissa = (1n << 52n) | fraction;
    return { i: sign * mantissa, e: expBits - 1023 - 52 };
}
function shiftLeftExact(value, amount) {
    if (amount < 0)
        throw new Error(`negative shift ${amount}`);
    return amount === 0 ? value : value << BigInt(amount);
}
function dyadicAdd(a, b) {
    if (a.i === 0n)
        return b;
    if (b.i === 0n)
        return a;
    const e = Math.min(a.e, b.e);
    return {
        i: shiftLeftExact(a.i, a.e - e) + shiftLeftExact(b.i, b.e - e),
        e,
    };
}
function dyadicSub(a, b) {
    if (b.i === 0n)
        return a;
    if (a.i === 0n)
        return { i: -b.i, e: b.e };
    const e = Math.min(a.e, b.e);
    return {
        i: shiftLeftExact(a.i, a.e - e) - shiftLeftExact(b.i, b.e - e),
        e,
    };
}
function dyadicMul(a, b) {
    if (a.i === 0n || b.i === 0n)
        return { i: 0n, e: 0 };
    return { i: a.i * b.i, e: a.e + b.e };
}
function dyadicSquare(a) {
    if (a.i === 0n)
        return { i: 0n, e: 0 };
    return { i: a.i * a.i, e: a.e + a.e };
}
function dyadicSign(a) {
    return a.i > 0n ? 1 : a.i < 0n ? -1 : 0;
}
function exactDiff(a, b) {
    return dyadicSub(doubleToDyadic(a), doubleToDyadic(b));
}
function exactOrientSign(a, b, c) {
    const bax = exactDiff(b.x, a.x);
    const bay = exactDiff(b.y, a.y);
    const cax = exactDiff(c.x, a.x);
    const cay = exactDiff(c.y, a.y);
    return dyadicSign(dyadicSub(dyadicMul(bax, cay), dyadicMul(bay, cax)));
}
function exactIncircleSign(a, b, c, d) {
    const adx = exactDiff(a.x, d.x);
    const ady = exactDiff(a.y, d.y);
    const bdx = exactDiff(b.x, d.x);
    const bdy = exactDiff(b.y, d.y);
    const cdx = exactDiff(c.x, d.x);
    const cdy = exactDiff(c.y, d.y);
    const abdet = dyadicSub(dyadicMul(adx, bdy), dyadicMul(bdx, ady));
    const bcdet = dyadicSub(dyadicMul(bdx, cdy), dyadicMul(cdx, bdy));
    const cadet = dyadicSub(dyadicMul(cdx, ady), dyadicMul(adx, cdy));
    const alift = dyadicAdd(dyadicSquare(adx), dyadicSquare(ady));
    const blift = dyadicAdd(dyadicSquare(bdx), dyadicSquare(bdy));
    const clift = dyadicAdd(dyadicSquare(cdx), dyadicSquare(cdy));
    const det = dyadicAdd(dyadicAdd(dyadicMul(alift, bcdet), dyadicMul(blift, cadet)), dyadicMul(clift, abdet));
    return dyadicSign(det);
}
/**
 * Robust orientation determinant for a,b,c.
 * The sign is exact for finite IEEE-754 double coordinates. The magnitude is approximate.
 */
export function orient2d(a, b, c) {
    const detleft = (a.x - c.x) * (b.y - c.y);
    const detright = (a.y - c.y) * (b.x - c.x);
    const det = detleft - detright;
    if (det === 0)
        return exactOrientSign(a, b, c);
    let detsum;
    if (detleft > 0) {
        if (detright <= 0)
            return det;
        detsum = detleft + detright;
    }
    else if (detleft < 0) {
        if (detright >= 0)
            return det;
        detsum = -detleft - detright;
    }
    else {
        return det;
    }
    const errbound = CCW_ERR_BOUND_A * detsum;
    if (det >= errbound || -det >= errbound)
        return det;
    return exactOrientSign(a, b, c);
}
export function orientSign(a, b, c) {
    const det = orient2d(a, b, c);
    return det > 0 ? 1 : det < 0 ? -1 : 0;
}
/**
 * Robust in-circle determinant.
 * Positive means d lies inside the circumcircle of CCW triangle a,b,c.
 * The sign is exact for finite IEEE-754 double coordinates. The magnitude is approximate.
 */
export function incircle(a, b, c, d) {
    const adx = a.x - d.x;
    const ady = a.y - d.y;
    const bdx = b.x - d.x;
    const bdy = b.y - d.y;
    const cdx = c.x - d.x;
    const cdy = c.y - d.y;
    const bdxcdy = bdx * cdy;
    const cdxbdy = cdx * bdy;
    const cdxady = cdx * ady;
    const adxcdy = adx * cdy;
    const adxbdy = adx * bdy;
    const bdxady = bdx * ady;
    const alift = adx * adx + ady * ady;
    const blift = bdx * bdx + bdy * bdy;
    const clift = cdx * cdx + cdy * cdy;
    const det = alift * (bdxcdy - cdxbdy)
        + blift * (cdxady - adxcdy)
        + clift * (adxbdy - bdxady);
    const permanent = (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * alift
        + (Math.abs(cdxady) + Math.abs(adxcdy)) * blift
        + (Math.abs(adxbdy) + Math.abs(bdxady)) * clift;
    const errbound = INCIRCLE_ERR_BOUND_A * permanent;
    if (det > errbound || -det > errbound)
        return det;
    return exactIncircleSign(a, b, c, d);
}
export function incircleSign(a, b, c, d) {
    const det = incircle(a, b, c, d);
    return det > 0 ? 1 : det < 0 ? -1 : 0;
}
/** Coordinate-form orientation determinant. Positive means a,b,c are CCW. */
export function orient2dCoords(ax, ay, bx, by, cx, cy) {
    const detleft = (ax - cx) * (by - cy);
    const detright = (ay - cy) * (bx - cx);
    const det = detleft - detright;
    if (det === 0)
        return exactOrientSign({ x: ax, y: ay }, { x: bx, y: by }, { x: cx, y: cy });
    let detsum;
    if (detleft > 0) {
        if (detright <= 0)
            return det;
        detsum = detleft + detright;
    }
    else if (detleft < 0) {
        if (detright >= 0)
            return det;
        detsum = -detleft - detright;
    }
    else {
        return det;
    }
    const errbound = CCW_ERR_BOUND_A * detsum;
    if (det >= errbound || -det >= errbound)
        return det;
    return exactOrientSign({ x: ax, y: ay }, { x: bx, y: by }, { x: cx, y: cy });
}
export function orientSignCoords(ax, ay, bx, by, cx, cy) {
    const det = orient2dCoords(ax, ay, bx, by, cx, cy);
    return det > 0 ? 1 : det < 0 ? -1 : 0;
}
/** Coordinate-form robust in-circle determinant. Positive means d is inside CCW abc. */
export function incircleCoords(ax, ay, bx, by, cx, cy, dx, dy) {
    const adx = ax - dx;
    const ady = ay - dy;
    const bdx = bx - dx;
    const bdy = by - dy;
    const cdx = cx - dx;
    const cdy = cy - dy;
    const bdxcdy = bdx * cdy;
    const cdxbdy = cdx * bdy;
    const cdxady = cdx * ady;
    const adxcdy = adx * cdy;
    const adxbdy = adx * bdy;
    const bdxady = bdx * ady;
    const alift = adx * adx + ady * ady;
    const blift = bdx * bdx + bdy * bdy;
    const clift = cdx * cdx + cdy * cdy;
    const det = alift * (bdxcdy - cdxbdy)
        + blift * (cdxady - adxcdy)
        + clift * (adxbdy - bdxady);
    const permanent = (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * alift
        + (Math.abs(cdxady) + Math.abs(adxcdy)) * blift
        + (Math.abs(adxbdy) + Math.abs(bdxady)) * clift;
    const errbound = INCIRCLE_ERR_BOUND_A * permanent;
    if (det > errbound || -det > errbound)
        return det;
    return exactIncircleSign({ x: ax, y: ay }, { x: bx, y: by }, { x: cx, y: cy }, { x: dx, y: dy });
}
export function incircleSignCoords(ax, ay, bx, by, cx, cy, dx, dy) {
    const det = incircleCoords(ax, ay, bx, by, cx, cy, dx, dy);
    return det > 0 ? 1 : det < 0 ? -1 : 0;
}
//# sourceMappingURL=predicates.js.map