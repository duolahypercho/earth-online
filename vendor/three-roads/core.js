var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// ../three-roads-inspect/node_modules/splaytree/dist/splaytree.umd.cjs
var require_splaytree_umd = __commonJS((exports, module) => {
  (function(h, c) {
    typeof exports == "object" && typeof module < "u" ? module.exports = c() : typeof define == "function" && define.amd ? define(c) : (h = typeof globalThis < "u" ? globalThis : h || self, h.SplayTree = c());
  })(exports, function() {

    class h {
      constructor(t, e) {
        this.next = null, this.key = t, this.data = e, this.left = null, this.right = null;
      }
    }
    function c(n, t) {
      return n > t ? 1 : n < t ? -1 : 0;
    }
    function u(n, t, e) {
      const r = new h(null, null);
      let i = r, l = r;
      for (;; ) {
        const o = e(n, t.key);
        if (o < 0) {
          if (t.left === null)
            break;
          if (e(n, t.left.key) < 0) {
            const s = t.left;
            if (t.left = s.right, s.right = t, t = s, t.left === null)
              break;
          }
          l.left = t, l = t, t = t.left;
        } else if (o > 0) {
          if (t.right === null)
            break;
          if (e(n, t.right.key) > 0) {
            const s = t.right;
            if (t.right = s.left, s.left = t, t = s, t.right === null)
              break;
          }
          i.right = t, i = t, t = t.right;
        } else
          break;
      }
      return i.right = t.left, l.left = t.right, t.left = r.right, t.right = r.left, t;
    }
    function _(n, t, e, r) {
      const i = new h(n, t);
      if (e === null)
        return i.left = i.right = null, i;
      e = u(n, e, r);
      const l = r(n, e.key);
      return l < 0 ? (i.left = e.left, i.right = e, e.left = null) : l >= 0 && (i.right = e.right, i.left = e, e.right = null), i;
    }
    function d(n, t, e) {
      let r = null, i = null;
      if (t) {
        t = u(n, t, e);
        const l = e(t.key, n);
        l === 0 ? (r = t.left, i = t.right) : l < 0 ? (i = t.right, t.right = null, r = t) : (r = t.left, t.left = null, i = t);
      }
      return { left: r, right: i };
    }
    function w(n, t, e) {
      return t === null ? n : (n === null || (t = u(n.key, t, e), t.left = n), t);
    }
    function a(n, t, e, r, i) {
      if (n) {
        r(`${t}${e ? "└── " : "├── "}${i(n)}
`);
        const l = t + (e ? "    " : "│   ");
        n.left && a(n.left, l, false, r, i), n.right && a(n.right, l, true, r, i);
      }
    }

    class x {
      constructor(t = c) {
        this._root = null, this._size = 0, this._comparator = t;
      }
      insert(t, e) {
        return this._size++, this._root = _(t, e, this._root, this._comparator);
      }
      add(t, e) {
        const r = new h(t, e);
        this._root === null && (r.left = r.right = null, this._size++, this._root = r);
        const i = this._comparator, l = u(t, this._root, i), o = i(t, l.key);
        return o === 0 ? this._root = l : (o < 0 ? (r.left = l.left, r.right = l, l.left = null) : o > 0 && (r.right = l.right, r.left = l, l.right = null), this._size++, this._root = r), this._root;
      }
      remove(t) {
        this._root = this._remove(t, this._root, this._comparator);
      }
      _remove(t, e, r) {
        let i;
        return e === null ? null : (e = u(t, e, r), r(t, e.key) === 0 ? (e.left === null ? i = e.right : (i = u(t, e.left, r), i.right = e.right), this._size--, i) : e);
      }
      pop() {
        let t = this._root;
        if (t) {
          for (;t.left; )
            t = t.left;
          return this._root = u(t.key, this._root, this._comparator), this._root = this._remove(t.key, this._root, this._comparator), { key: t.key, data: t.data };
        }
        return null;
      }
      findStatic(t) {
        let e = this._root;
        const r = this._comparator;
        for (;e; ) {
          const i = r(t, e.key);
          if (i === 0)
            return e;
          i < 0 ? e = e.left : e = e.right;
        }
        return null;
      }
      find(t) {
        return this._root && (this._root = u(t, this._root, this._comparator), this._comparator(t, this._root.key) !== 0) ? null : this._root;
      }
      contains(t) {
        let e = this._root;
        const r = this._comparator;
        for (;e; ) {
          const i = r(t, e.key);
          if (i === 0)
            return true;
          i < 0 ? e = e.left : e = e.right;
        }
        return false;
      }
      forEach(t, e) {
        let r = this._root;
        const i = [];
        let l = false;
        for (;!l; )
          r !== null ? (i.push(r), r = r.left) : i.length !== 0 ? (r = i.pop(), t.call(e, r), r = r.right) : l = true;
        return this;
      }
      range(t, e, r, i) {
        const l = [], o = this._comparator;
        let s = this._root, f;
        for (;l.length !== 0 || s; )
          if (s)
            l.push(s), s = s.left;
          else {
            if (s = l.pop(), f = o(s.key, e), f > 0)
              break;
            if (o(s.key, t) >= 0 && r.call(i, s))
              return this;
            s = s.right;
          }
        return this;
      }
      keys() {
        const t = [];
        return this.forEach(({ key: e }) => {
          t.push(e);
        }), t;
      }
      values() {
        const t = [];
        return this.forEach(({ data: e }) => {
          t.push(e);
        }), t;
      }
      min() {
        return this._root ? this.minNode(this._root).key : null;
      }
      max() {
        return this._root ? this.maxNode(this._root).key : null;
      }
      minNode(t = this._root) {
        if (t)
          for (;t.left; )
            t = t.left;
        return t;
      }
      maxNode(t = this._root) {
        if (t)
          for (;t.right; )
            t = t.right;
        return t;
      }
      at(t) {
        let e = this._root, r = false, i = 0;
        const l = [];
        for (;!r; )
          if (e)
            l.push(e), e = e.left;
          else if (l.length > 0) {
            if (e = l.pop(), i === t)
              return e;
            i++, e = e.right;
          } else
            r = true;
        return null;
      }
      next(t) {
        let e = this._root, r = null;
        if (t.right) {
          for (r = t.right;r.left; )
            r = r.left;
          return r;
        }
        const i = this._comparator;
        for (;e; ) {
          const l = i(t.key, e.key);
          if (l === 0)
            break;
          l < 0 ? (r = e, e = e.left) : e = e.right;
        }
        return r;
      }
      prev(t) {
        let e = this._root, r = null;
        if (t.left !== null) {
          for (r = t.left;r.right; )
            r = r.right;
          return r;
        }
        const i = this._comparator;
        for (;e; ) {
          const l = i(t.key, e.key);
          if (l === 0)
            break;
          l < 0 ? e = e.left : (r = e, e = e.right);
        }
        return r;
      }
      clear() {
        return this._root = null, this._size = 0, this;
      }
      toList() {
        return y(this._root);
      }
      load(t, e = [], r = false) {
        let i = t.length;
        const l = this._comparator;
        if (r && m(t, e, 0, i - 1, l), this._root === null)
          this._root = p(t, e, 0, i), this._size = i;
        else {
          const o = z(this.toList(), k(t, e), l);
          i = this._size + i, this._root = g({ head: o }, 0, i);
        }
        return this;
      }
      isEmpty() {
        return this._root === null;
      }
      get size() {
        return this._size;
      }
      get root() {
        return this._root;
      }
      toString(t = (e) => String(e.key)) {
        const e = [];
        return a(this._root, "", true, (r) => e.push(r), t), e.join("");
      }
      update(t, e, r) {
        const i = this._comparator;
        let { left: l, right: o } = d(t, this._root, i);
        i(t, e) < 0 ? o = _(e, r, o, i) : l = _(e, r, l, i), this._root = w(l, o, i);
      }
      split(t) {
        return d(t, this._root, this._comparator);
      }
      *[Symbol.iterator]() {
        let t = this._root;
        const e = [];
        let r = false;
        for (;!r; )
          t !== null ? (e.push(t), t = t.left) : e.length !== 0 ? (t = e.pop(), yield t, t = t.right) : r = true;
      }
    }
    function p(n, t, e, r) {
      const i = r - e;
      if (i > 0) {
        const l = e + Math.floor(i / 2), o = n[l], s = t[l], f = new h(o, s);
        return f.left = p(n, t, e, l), f.right = p(n, t, l + 1, r), f;
      }
      return null;
    }
    function k(n, t) {
      const e = new h(null, null);
      let r = e;
      for (let i = 0;i < n.length; i++)
        r = r.next = new h(n[i], t[i]);
      return r.next = null, e.next;
    }
    function y(n) {
      let t = n;
      const e = [];
      let r = false;
      const i = new h(null, null);
      let l = i;
      for (;!r; )
        t ? (e.push(t), t = t.left) : e.length > 0 ? (t = l = l.next = e.pop(), t = t.right) : r = true;
      return l.next = null, i.next;
    }
    function g(n, t, e) {
      const r = e - t;
      if (r > 0) {
        const i = t + Math.floor(r / 2), l = g(n, t, i), o = n.head;
        return o.left = l, n.head = n.head.next, o.right = g(n, i + 1, e), o;
      }
      return null;
    }
    function z(n, t, e) {
      const r = new h(null, null);
      let i = r, l = n, o = t;
      for (;l !== null && o !== null; )
        e(l.key, o.key) < 0 ? (i.next = l, l = l.next) : (i.next = o, o = o.next), i = i.next;
      return l !== null ? i.next = l : o !== null && (i.next = o), r.next;
    }
    function m(n, t, e, r, i) {
      if (e >= r)
        return;
      const l = n[e + r >> 1];
      let o = e - 1, s = r + 1;
      for (;; ) {
        do
          o++;
        while (i(n[o], l) < 0);
        do
          s--;
        while (i(n[s], l) > 0);
        if (o >= s)
          break;
        let f = n[o];
        n[o] = n[s], n[s] = f, f = t[o], t[o] = t[s], t[s] = f;
      }
      m(n, t, e, s, i), m(n, t, s + 1, r, i);
    }
    return x;
  });
});

// ../three-roads-inspect/node_modules/polygon-clipping/dist/polygon-clipping.cjs.js
var require_polygon_clipping_cjs = __commonJS((exports, module) => {
  var SplayTree = require_splaytree_umd();
  function _interopDefaultLegacy(e) {
    return e && typeof e === "object" && "default" in e ? e : { default: e };
  }
  var SplayTree__default = /* @__PURE__ */ _interopDefaultLegacy(SplayTree);
  var isInBbox = (bbox, point) => {
    return bbox.ll.x <= point.x && point.x <= bbox.ur.x && bbox.ll.y <= point.y && point.y <= bbox.ur.y;
  };
  var getBboxOverlap = (b1, b2) => {
    if (b2.ur.x < b1.ll.x || b1.ur.x < b2.ll.x || b2.ur.y < b1.ll.y || b1.ur.y < b2.ll.y)
      return null;
    const lowerX = b1.ll.x < b2.ll.x ? b2.ll.x : b1.ll.x;
    const upperX = b1.ur.x < b2.ur.x ? b1.ur.x : b2.ur.x;
    const lowerY = b1.ll.y < b2.ll.y ? b2.ll.y : b1.ll.y;
    const upperY = b1.ur.y < b2.ur.y ? b1.ur.y : b2.ur.y;
    return {
      ll: {
        x: lowerX,
        y: lowerY
      },
      ur: {
        x: upperX,
        y: upperY
      }
    };
  };
  var epsilon$1 = Number.EPSILON;
  if (epsilon$1 === undefined)
    epsilon$1 = Math.pow(2, -52);
  var EPSILON_SQ = epsilon$1 * epsilon$1;
  var cmp = (a, b) => {
    if (-epsilon$1 < a && a < epsilon$1) {
      if (-epsilon$1 < b && b < epsilon$1) {
        return 0;
      }
    }
    const ab = a - b;
    if (ab * ab < EPSILON_SQ * a * b) {
      return 0;
    }
    return a < b ? -1 : 1;
  };

  class PtRounder {
    constructor() {
      this.reset();
    }
    reset() {
      this.xRounder = new CoordRounder;
      this.yRounder = new CoordRounder;
    }
    round(x, y) {
      return {
        x: this.xRounder.round(x),
        y: this.yRounder.round(y)
      };
    }
  }

  class CoordRounder {
    constructor() {
      this.tree = new SplayTree__default["default"];
      this.round(0);
    }
    round(coord) {
      const node = this.tree.add(coord);
      const prevNode = this.tree.prev(node);
      if (prevNode !== null && cmp(node.key, prevNode.key) === 0) {
        this.tree.remove(coord);
        return prevNode.key;
      }
      const nextNode = this.tree.next(node);
      if (nextNode !== null && cmp(node.key, nextNode.key) === 0) {
        this.tree.remove(coord);
        return nextNode.key;
      }
      return coord;
    }
  }
  var rounder = new PtRounder;
  var epsilon = 0.00000000000000011102230246251565;
  var splitter = 134217729;
  var resulterrbound = (3 + 8 * epsilon) * epsilon;
  function sum(elen, e, flen, f, h) {
    let Q, Qnew, hh, bvirt;
    let enow = e[0];
    let fnow = f[0];
    let eindex = 0;
    let findex = 0;
    if (fnow > enow === fnow > -enow) {
      Q = enow;
      enow = e[++eindex];
    } else {
      Q = fnow;
      fnow = f[++findex];
    }
    let hindex = 0;
    if (eindex < elen && findex < flen) {
      if (fnow > enow === fnow > -enow) {
        Qnew = enow + Q;
        hh = Q - (Qnew - enow);
        enow = e[++eindex];
      } else {
        Qnew = fnow + Q;
        hh = Q - (Qnew - fnow);
        fnow = f[++findex];
      }
      Q = Qnew;
      if (hh !== 0) {
        h[hindex++] = hh;
      }
      while (eindex < elen && findex < flen) {
        if (fnow > enow === fnow > -enow) {
          Qnew = Q + enow;
          bvirt = Qnew - Q;
          hh = Q - (Qnew - bvirt) + (enow - bvirt);
          enow = e[++eindex];
        } else {
          Qnew = Q + fnow;
          bvirt = Qnew - Q;
          hh = Q - (Qnew - bvirt) + (fnow - bvirt);
          fnow = f[++findex];
        }
        Q = Qnew;
        if (hh !== 0) {
          h[hindex++] = hh;
        }
      }
    }
    while (eindex < elen) {
      Qnew = Q + enow;
      bvirt = Qnew - Q;
      hh = Q - (Qnew - bvirt) + (enow - bvirt);
      enow = e[++eindex];
      Q = Qnew;
      if (hh !== 0) {
        h[hindex++] = hh;
      }
    }
    while (findex < flen) {
      Qnew = Q + fnow;
      bvirt = Qnew - Q;
      hh = Q - (Qnew - bvirt) + (fnow - bvirt);
      fnow = f[++findex];
      Q = Qnew;
      if (hh !== 0) {
        h[hindex++] = hh;
      }
    }
    if (Q !== 0 || hindex === 0) {
      h[hindex++] = Q;
    }
    return hindex;
  }
  function estimate(elen, e) {
    let Q = e[0];
    for (let i = 1;i < elen; i++)
      Q += e[i];
    return Q;
  }
  function vec(n) {
    return new Float64Array(n);
  }
  var ccwerrboundA = (3 + 16 * epsilon) * epsilon;
  var ccwerrboundB = (2 + 12 * epsilon) * epsilon;
  var ccwerrboundC = (9 + 64 * epsilon) * epsilon * epsilon;
  var B = vec(4);
  var C1 = vec(8);
  var C2 = vec(12);
  var D = vec(16);
  var u = vec(4);
  function orient2dadapt(ax, ay, bx, by, cx, cy, detsum) {
    let acxtail, acytail, bcxtail, bcytail;
    let bvirt, c, ahi, alo, bhi, blo, _i, _j, _0, s1, s0, t1, t0, u3;
    const acx = ax - cx;
    const bcx = bx - cx;
    const acy = ay - cy;
    const bcy = by - cy;
    s1 = acx * bcy;
    c = splitter * acx;
    ahi = c - (c - acx);
    alo = acx - ahi;
    c = splitter * bcy;
    bhi = c - (c - bcy);
    blo = bcy - bhi;
    s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    t1 = acy * bcx;
    c = splitter * acy;
    ahi = c - (c - acy);
    alo = acy - ahi;
    c = splitter * bcx;
    bhi = c - (c - bcx);
    blo = bcx - bhi;
    t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    _i = s0 - t0;
    bvirt = s0 - _i;
    B[0] = s0 - (_i + bvirt) + (bvirt - t0);
    _j = s1 + _i;
    bvirt = _j - s1;
    _0 = s1 - (_j - bvirt) + (_i - bvirt);
    _i = _0 - t1;
    bvirt = _0 - _i;
    B[1] = _0 - (_i + bvirt) + (bvirt - t1);
    u3 = _j + _i;
    bvirt = u3 - _j;
    B[2] = _j - (u3 - bvirt) + (_i - bvirt);
    B[3] = u3;
    let det = estimate(4, B);
    let errbound = ccwerrboundB * detsum;
    if (det >= errbound || -det >= errbound) {
      return det;
    }
    bvirt = ax - acx;
    acxtail = ax - (acx + bvirt) + (bvirt - cx);
    bvirt = bx - bcx;
    bcxtail = bx - (bcx + bvirt) + (bvirt - cx);
    bvirt = ay - acy;
    acytail = ay - (acy + bvirt) + (bvirt - cy);
    bvirt = by - bcy;
    bcytail = by - (bcy + bvirt) + (bvirt - cy);
    if (acxtail === 0 && acytail === 0 && bcxtail === 0 && bcytail === 0) {
      return det;
    }
    errbound = ccwerrboundC * detsum + resulterrbound * Math.abs(det);
    det += acx * bcytail + bcy * acxtail - (acy * bcxtail + bcx * acytail);
    if (det >= errbound || -det >= errbound)
      return det;
    s1 = acxtail * bcy;
    c = splitter * acxtail;
    ahi = c - (c - acxtail);
    alo = acxtail - ahi;
    c = splitter * bcy;
    bhi = c - (c - bcy);
    blo = bcy - bhi;
    s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    t1 = acytail * bcx;
    c = splitter * acytail;
    ahi = c - (c - acytail);
    alo = acytail - ahi;
    c = splitter * bcx;
    bhi = c - (c - bcx);
    blo = bcx - bhi;
    t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    _i = s0 - t0;
    bvirt = s0 - _i;
    u[0] = s0 - (_i + bvirt) + (bvirt - t0);
    _j = s1 + _i;
    bvirt = _j - s1;
    _0 = s1 - (_j - bvirt) + (_i - bvirt);
    _i = _0 - t1;
    bvirt = _0 - _i;
    u[1] = _0 - (_i + bvirt) + (bvirt - t1);
    u3 = _j + _i;
    bvirt = u3 - _j;
    u[2] = _j - (u3 - bvirt) + (_i - bvirt);
    u[3] = u3;
    const C1len = sum(4, B, 4, u, C1);
    s1 = acx * bcytail;
    c = splitter * acx;
    ahi = c - (c - acx);
    alo = acx - ahi;
    c = splitter * bcytail;
    bhi = c - (c - bcytail);
    blo = bcytail - bhi;
    s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    t1 = acy * bcxtail;
    c = splitter * acy;
    ahi = c - (c - acy);
    alo = acy - ahi;
    c = splitter * bcxtail;
    bhi = c - (c - bcxtail);
    blo = bcxtail - bhi;
    t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    _i = s0 - t0;
    bvirt = s0 - _i;
    u[0] = s0 - (_i + bvirt) + (bvirt - t0);
    _j = s1 + _i;
    bvirt = _j - s1;
    _0 = s1 - (_j - bvirt) + (_i - bvirt);
    _i = _0 - t1;
    bvirt = _0 - _i;
    u[1] = _0 - (_i + bvirt) + (bvirt - t1);
    u3 = _j + _i;
    bvirt = u3 - _j;
    u[2] = _j - (u3 - bvirt) + (_i - bvirt);
    u[3] = u3;
    const C2len = sum(C1len, C1, 4, u, C2);
    s1 = acxtail * bcytail;
    c = splitter * acxtail;
    ahi = c - (c - acxtail);
    alo = acxtail - ahi;
    c = splitter * bcytail;
    bhi = c - (c - bcytail);
    blo = bcytail - bhi;
    s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    t1 = acytail * bcxtail;
    c = splitter * acytail;
    ahi = c - (c - acytail);
    alo = acytail - ahi;
    c = splitter * bcxtail;
    bhi = c - (c - bcxtail);
    blo = bcxtail - bhi;
    t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    _i = s0 - t0;
    bvirt = s0 - _i;
    u[0] = s0 - (_i + bvirt) + (bvirt - t0);
    _j = s1 + _i;
    bvirt = _j - s1;
    _0 = s1 - (_j - bvirt) + (_i - bvirt);
    _i = _0 - t1;
    bvirt = _0 - _i;
    u[1] = _0 - (_i + bvirt) + (bvirt - t1);
    u3 = _j + _i;
    bvirt = u3 - _j;
    u[2] = _j - (u3 - bvirt) + (_i - bvirt);
    u[3] = u3;
    const Dlen = sum(C2len, C2, 4, u, D);
    return D[Dlen - 1];
  }
  function orient2d(ax, ay, bx, by, cx, cy) {
    const detleft = (ay - cy) * (bx - cx);
    const detright = (ax - cx) * (by - cy);
    const det = detleft - detright;
    const detsum = Math.abs(detleft + detright);
    if (Math.abs(det) >= ccwerrboundA * detsum)
      return det;
    return -orient2dadapt(ax, ay, bx, by, cx, cy, detsum);
  }
  var crossProduct = (a, b) => a.x * b.y - a.y * b.x;
  var dotProduct = (a, b) => a.x * b.x + a.y * b.y;
  var compareVectorAngles = (basePt, endPt1, endPt2) => {
    const res = orient2d(basePt.x, basePt.y, endPt1.x, endPt1.y, endPt2.x, endPt2.y);
    if (res > 0)
      return -1;
    if (res < 0)
      return 1;
    return 0;
  };
  var length = (v) => Math.sqrt(dotProduct(v, v));
  var sineOfAngle = (pShared, pBase, pAngle) => {
    const vBase = {
      x: pBase.x - pShared.x,
      y: pBase.y - pShared.y
    };
    const vAngle = {
      x: pAngle.x - pShared.x,
      y: pAngle.y - pShared.y
    };
    return crossProduct(vAngle, vBase) / length(vAngle) / length(vBase);
  };
  var cosineOfAngle = (pShared, pBase, pAngle) => {
    const vBase = {
      x: pBase.x - pShared.x,
      y: pBase.y - pShared.y
    };
    const vAngle = {
      x: pAngle.x - pShared.x,
      y: pAngle.y - pShared.y
    };
    return dotProduct(vAngle, vBase) / length(vAngle) / length(vBase);
  };
  var horizontalIntersection = (pt, v, y) => {
    if (v.y === 0)
      return null;
    return {
      x: pt.x + v.x / v.y * (y - pt.y),
      y
    };
  };
  var verticalIntersection = (pt, v, x) => {
    if (v.x === 0)
      return null;
    return {
      x,
      y: pt.y + v.y / v.x * (x - pt.x)
    };
  };
  var intersection$1 = (pt1, v1, pt2, v2) => {
    if (v1.x === 0)
      return verticalIntersection(pt2, v2, pt1.x);
    if (v2.x === 0)
      return verticalIntersection(pt1, v1, pt2.x);
    if (v1.y === 0)
      return horizontalIntersection(pt2, v2, pt1.y);
    if (v2.y === 0)
      return horizontalIntersection(pt1, v1, pt2.y);
    const kross = crossProduct(v1, v2);
    if (kross == 0)
      return null;
    const ve = {
      x: pt2.x - pt1.x,
      y: pt2.y - pt1.y
    };
    const d1 = crossProduct(ve, v1) / kross;
    const d2 = crossProduct(ve, v2) / kross;
    const x1 = pt1.x + d2 * v1.x, x2 = pt2.x + d1 * v2.x;
    const y1 = pt1.y + d2 * v1.y, y2 = pt2.y + d1 * v2.y;
    const x = (x1 + x2) / 2;
    const y = (y1 + y2) / 2;
    return {
      x,
      y
    };
  };

  class SweepEvent {
    static compare(a, b) {
      const ptCmp = SweepEvent.comparePoints(a.point, b.point);
      if (ptCmp !== 0)
        return ptCmp;
      if (a.point !== b.point)
        a.link(b);
      if (a.isLeft !== b.isLeft)
        return a.isLeft ? 1 : -1;
      return Segment.compare(a.segment, b.segment);
    }
    static comparePoints(aPt, bPt) {
      if (aPt.x < bPt.x)
        return -1;
      if (aPt.x > bPt.x)
        return 1;
      if (aPt.y < bPt.y)
        return -1;
      if (aPt.y > bPt.y)
        return 1;
      return 0;
    }
    constructor(point, isLeft) {
      if (point.events === undefined)
        point.events = [this];
      else
        point.events.push(this);
      this.point = point;
      this.isLeft = isLeft;
    }
    link(other) {
      if (other.point === this.point) {
        throw new Error("Tried to link already linked events");
      }
      const otherEvents = other.point.events;
      for (let i = 0, iMax = otherEvents.length;i < iMax; i++) {
        const evt = otherEvents[i];
        this.point.events.push(evt);
        evt.point = this.point;
      }
      this.checkForConsuming();
    }
    checkForConsuming() {
      const numEvents = this.point.events.length;
      for (let i = 0;i < numEvents; i++) {
        const evt1 = this.point.events[i];
        if (evt1.segment.consumedBy !== undefined)
          continue;
        for (let j = i + 1;j < numEvents; j++) {
          const evt2 = this.point.events[j];
          if (evt2.consumedBy !== undefined)
            continue;
          if (evt1.otherSE.point.events !== evt2.otherSE.point.events)
            continue;
          evt1.segment.consume(evt2.segment);
        }
      }
    }
    getAvailableLinkedEvents() {
      const events = [];
      for (let i = 0, iMax = this.point.events.length;i < iMax; i++) {
        const evt = this.point.events[i];
        if (evt !== this && !evt.segment.ringOut && evt.segment.isInResult()) {
          events.push(evt);
        }
      }
      return events;
    }
    getLeftmostComparator(baseEvent) {
      const cache = new Map;
      const fillCache = (linkedEvent) => {
        const nextEvent = linkedEvent.otherSE;
        cache.set(linkedEvent, {
          sine: sineOfAngle(this.point, baseEvent.point, nextEvent.point),
          cosine: cosineOfAngle(this.point, baseEvent.point, nextEvent.point)
        });
      };
      return (a, b) => {
        if (!cache.has(a))
          fillCache(a);
        if (!cache.has(b))
          fillCache(b);
        const {
          sine: asine,
          cosine: acosine
        } = cache.get(a);
        const {
          sine: bsine,
          cosine: bcosine
        } = cache.get(b);
        if (asine >= 0 && bsine >= 0) {
          if (acosine < bcosine)
            return 1;
          if (acosine > bcosine)
            return -1;
          return 0;
        }
        if (asine < 0 && bsine < 0) {
          if (acosine < bcosine)
            return -1;
          if (acosine > bcosine)
            return 1;
          return 0;
        }
        if (bsine < asine)
          return -1;
        if (bsine > asine)
          return 1;
        return 0;
      };
    }
  }
  var segmentId = 0;

  class Segment {
    static compare(a, b) {
      const alx = a.leftSE.point.x;
      const blx = b.leftSE.point.x;
      const arx = a.rightSE.point.x;
      const brx = b.rightSE.point.x;
      if (brx < alx)
        return 1;
      if (arx < blx)
        return -1;
      const aly = a.leftSE.point.y;
      const bly = b.leftSE.point.y;
      const ary = a.rightSE.point.y;
      const bry = b.rightSE.point.y;
      if (alx < blx) {
        if (bly < aly && bly < ary)
          return 1;
        if (bly > aly && bly > ary)
          return -1;
        const aCmpBLeft = a.comparePoint(b.leftSE.point);
        if (aCmpBLeft < 0)
          return 1;
        if (aCmpBLeft > 0)
          return -1;
        const bCmpARight = b.comparePoint(a.rightSE.point);
        if (bCmpARight !== 0)
          return bCmpARight;
        return -1;
      }
      if (alx > blx) {
        if (aly < bly && aly < bry)
          return -1;
        if (aly > bly && aly > bry)
          return 1;
        const bCmpALeft = b.comparePoint(a.leftSE.point);
        if (bCmpALeft !== 0)
          return bCmpALeft;
        const aCmpBRight = a.comparePoint(b.rightSE.point);
        if (aCmpBRight < 0)
          return 1;
        if (aCmpBRight > 0)
          return -1;
        return 1;
      }
      if (aly < bly)
        return -1;
      if (aly > bly)
        return 1;
      if (arx < brx) {
        const bCmpARight = b.comparePoint(a.rightSE.point);
        if (bCmpARight !== 0)
          return bCmpARight;
      }
      if (arx > brx) {
        const aCmpBRight = a.comparePoint(b.rightSE.point);
        if (aCmpBRight < 0)
          return 1;
        if (aCmpBRight > 0)
          return -1;
      }
      if (arx !== brx) {
        const ay = ary - aly;
        const ax = arx - alx;
        const by = bry - bly;
        const bx = brx - blx;
        if (ay > ax && by < bx)
          return 1;
        if (ay < ax && by > bx)
          return -1;
      }
      if (arx > brx)
        return 1;
      if (arx < brx)
        return -1;
      if (ary < bry)
        return -1;
      if (ary > bry)
        return 1;
      if (a.id < b.id)
        return -1;
      if (a.id > b.id)
        return 1;
      return 0;
    }
    constructor(leftSE, rightSE, rings, windings) {
      this.id = ++segmentId;
      this.leftSE = leftSE;
      leftSE.segment = this;
      leftSE.otherSE = rightSE;
      this.rightSE = rightSE;
      rightSE.segment = this;
      rightSE.otherSE = leftSE;
      this.rings = rings;
      this.windings = windings;
    }
    static fromRing(pt1, pt2, ring) {
      let leftPt, rightPt, winding;
      const cmpPts = SweepEvent.comparePoints(pt1, pt2);
      if (cmpPts < 0) {
        leftPt = pt1;
        rightPt = pt2;
        winding = 1;
      } else if (cmpPts > 0) {
        leftPt = pt2;
        rightPt = pt1;
        winding = -1;
      } else
        throw new Error(`Tried to create degenerate segment at [${pt1.x}, ${pt1.y}]`);
      const leftSE = new SweepEvent(leftPt, true);
      const rightSE = new SweepEvent(rightPt, false);
      return new Segment(leftSE, rightSE, [ring], [winding]);
    }
    replaceRightSE(newRightSE) {
      this.rightSE = newRightSE;
      this.rightSE.segment = this;
      this.rightSE.otherSE = this.leftSE;
      this.leftSE.otherSE = this.rightSE;
    }
    bbox() {
      const y1 = this.leftSE.point.y;
      const y2 = this.rightSE.point.y;
      return {
        ll: {
          x: this.leftSE.point.x,
          y: y1 < y2 ? y1 : y2
        },
        ur: {
          x: this.rightSE.point.x,
          y: y1 > y2 ? y1 : y2
        }
      };
    }
    vector() {
      return {
        x: this.rightSE.point.x - this.leftSE.point.x,
        y: this.rightSE.point.y - this.leftSE.point.y
      };
    }
    isAnEndpoint(pt) {
      return pt.x === this.leftSE.point.x && pt.y === this.leftSE.point.y || pt.x === this.rightSE.point.x && pt.y === this.rightSE.point.y;
    }
    comparePoint(point) {
      if (this.isAnEndpoint(point))
        return 0;
      const lPt = this.leftSE.point;
      const rPt = this.rightSE.point;
      const v = this.vector();
      if (lPt.x === rPt.x) {
        if (point.x === lPt.x)
          return 0;
        return point.x < lPt.x ? 1 : -1;
      }
      const yDist = (point.y - lPt.y) / v.y;
      const xFromYDist = lPt.x + yDist * v.x;
      if (point.x === xFromYDist)
        return 0;
      const xDist = (point.x - lPt.x) / v.x;
      const yFromXDist = lPt.y + xDist * v.y;
      if (point.y === yFromXDist)
        return 0;
      return point.y < yFromXDist ? -1 : 1;
    }
    getIntersection(other) {
      const tBbox = this.bbox();
      const oBbox = other.bbox();
      const bboxOverlap = getBboxOverlap(tBbox, oBbox);
      if (bboxOverlap === null)
        return null;
      const tlp = this.leftSE.point;
      const trp = this.rightSE.point;
      const olp = other.leftSE.point;
      const orp = other.rightSE.point;
      const touchesOtherLSE = isInBbox(tBbox, olp) && this.comparePoint(olp) === 0;
      const touchesThisLSE = isInBbox(oBbox, tlp) && other.comparePoint(tlp) === 0;
      const touchesOtherRSE = isInBbox(tBbox, orp) && this.comparePoint(orp) === 0;
      const touchesThisRSE = isInBbox(oBbox, trp) && other.comparePoint(trp) === 0;
      if (touchesThisLSE && touchesOtherLSE) {
        if (touchesThisRSE && !touchesOtherRSE)
          return trp;
        if (!touchesThisRSE && touchesOtherRSE)
          return orp;
        return null;
      }
      if (touchesThisLSE) {
        if (touchesOtherRSE) {
          if (tlp.x === orp.x && tlp.y === orp.y)
            return null;
        }
        return tlp;
      }
      if (touchesOtherLSE) {
        if (touchesThisRSE) {
          if (trp.x === olp.x && trp.y === olp.y)
            return null;
        }
        return olp;
      }
      if (touchesThisRSE && touchesOtherRSE)
        return null;
      if (touchesThisRSE)
        return trp;
      if (touchesOtherRSE)
        return orp;
      const pt = intersection$1(tlp, this.vector(), olp, other.vector());
      if (pt === null)
        return null;
      if (!isInBbox(bboxOverlap, pt))
        return null;
      return rounder.round(pt.x, pt.y);
    }
    split(point) {
      const newEvents = [];
      const alreadyLinked = point.events !== undefined;
      const newLeftSE = new SweepEvent(point, true);
      const newRightSE = new SweepEvent(point, false);
      const oldRightSE = this.rightSE;
      this.replaceRightSE(newRightSE);
      newEvents.push(newRightSE);
      newEvents.push(newLeftSE);
      const newSeg = new Segment(newLeftSE, oldRightSE, this.rings.slice(), this.windings.slice());
      if (SweepEvent.comparePoints(newSeg.leftSE.point, newSeg.rightSE.point) > 0) {
        newSeg.swapEvents();
      }
      if (SweepEvent.comparePoints(this.leftSE.point, this.rightSE.point) > 0) {
        this.swapEvents();
      }
      if (alreadyLinked) {
        newLeftSE.checkForConsuming();
        newRightSE.checkForConsuming();
      }
      return newEvents;
    }
    swapEvents() {
      const tmpEvt = this.rightSE;
      this.rightSE = this.leftSE;
      this.leftSE = tmpEvt;
      this.leftSE.isLeft = true;
      this.rightSE.isLeft = false;
      for (let i = 0, iMax = this.windings.length;i < iMax; i++) {
        this.windings[i] *= -1;
      }
    }
    consume(other) {
      let consumer = this;
      let consumee = other;
      while (consumer.consumedBy)
        consumer = consumer.consumedBy;
      while (consumee.consumedBy)
        consumee = consumee.consumedBy;
      const cmp2 = Segment.compare(consumer, consumee);
      if (cmp2 === 0)
        return;
      if (cmp2 > 0) {
        const tmp = consumer;
        consumer = consumee;
        consumee = tmp;
      }
      if (consumer.prev === consumee) {
        const tmp = consumer;
        consumer = consumee;
        consumee = tmp;
      }
      for (let i = 0, iMax = consumee.rings.length;i < iMax; i++) {
        const ring = consumee.rings[i];
        const winding = consumee.windings[i];
        const index2 = consumer.rings.indexOf(ring);
        if (index2 === -1) {
          consumer.rings.push(ring);
          consumer.windings.push(winding);
        } else
          consumer.windings[index2] += winding;
      }
      consumee.rings = null;
      consumee.windings = null;
      consumee.consumedBy = consumer;
      consumee.leftSE.consumedBy = consumer.leftSE;
      consumee.rightSE.consumedBy = consumer.rightSE;
    }
    prevInResult() {
      if (this._prevInResult !== undefined)
        return this._prevInResult;
      if (!this.prev)
        this._prevInResult = null;
      else if (this.prev.isInResult())
        this._prevInResult = this.prev;
      else
        this._prevInResult = this.prev.prevInResult();
      return this._prevInResult;
    }
    beforeState() {
      if (this._beforeState !== undefined)
        return this._beforeState;
      if (!this.prev)
        this._beforeState = {
          rings: [],
          windings: [],
          multiPolys: []
        };
      else {
        const seg = this.prev.consumedBy || this.prev;
        this._beforeState = seg.afterState();
      }
      return this._beforeState;
    }
    afterState() {
      if (this._afterState !== undefined)
        return this._afterState;
      const beforeState = this.beforeState();
      this._afterState = {
        rings: beforeState.rings.slice(0),
        windings: beforeState.windings.slice(0),
        multiPolys: []
      };
      const ringsAfter = this._afterState.rings;
      const windingsAfter = this._afterState.windings;
      const mpsAfter = this._afterState.multiPolys;
      for (let i = 0, iMax = this.rings.length;i < iMax; i++) {
        const ring = this.rings[i];
        const winding = this.windings[i];
        const index2 = ringsAfter.indexOf(ring);
        if (index2 === -1) {
          ringsAfter.push(ring);
          windingsAfter.push(winding);
        } else
          windingsAfter[index2] += winding;
      }
      const polysAfter = [];
      const polysExclude = [];
      for (let i = 0, iMax = ringsAfter.length;i < iMax; i++) {
        if (windingsAfter[i] === 0)
          continue;
        const ring = ringsAfter[i];
        const poly = ring.poly;
        if (polysExclude.indexOf(poly) !== -1)
          continue;
        if (ring.isExterior)
          polysAfter.push(poly);
        else {
          if (polysExclude.indexOf(poly) === -1)
            polysExclude.push(poly);
          const index2 = polysAfter.indexOf(ring.poly);
          if (index2 !== -1)
            polysAfter.splice(index2, 1);
        }
      }
      for (let i = 0, iMax = polysAfter.length;i < iMax; i++) {
        const mp = polysAfter[i].multiPoly;
        if (mpsAfter.indexOf(mp) === -1)
          mpsAfter.push(mp);
      }
      return this._afterState;
    }
    isInResult() {
      if (this.consumedBy)
        return false;
      if (this._isInResult !== undefined)
        return this._isInResult;
      const mpsBefore = this.beforeState().multiPolys;
      const mpsAfter = this.afterState().multiPolys;
      switch (operation.type) {
        case "union": {
          const noBefores = mpsBefore.length === 0;
          const noAfters = mpsAfter.length === 0;
          this._isInResult = noBefores !== noAfters;
          break;
        }
        case "intersection": {
          let least;
          let most;
          if (mpsBefore.length < mpsAfter.length) {
            least = mpsBefore.length;
            most = mpsAfter.length;
          } else {
            least = mpsAfter.length;
            most = mpsBefore.length;
          }
          this._isInResult = most === operation.numMultiPolys && least < most;
          break;
        }
        case "xor": {
          const diff = Math.abs(mpsBefore.length - mpsAfter.length);
          this._isInResult = diff % 2 === 1;
          break;
        }
        case "difference": {
          const isJustSubject = (mps) => mps.length === 1 && mps[0].isSubject;
          this._isInResult = isJustSubject(mpsBefore) !== isJustSubject(mpsAfter);
          break;
        }
        default:
          throw new Error(`Unrecognized operation type found ${operation.type}`);
      }
      return this._isInResult;
    }
  }

  class RingIn {
    constructor(geomRing, poly, isExterior) {
      if (!Array.isArray(geomRing) || geomRing.length === 0) {
        throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
      }
      this.poly = poly;
      this.isExterior = isExterior;
      this.segments = [];
      if (typeof geomRing[0][0] !== "number" || typeof geomRing[0][1] !== "number") {
        throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
      }
      const firstPoint = rounder.round(geomRing[0][0], geomRing[0][1]);
      this.bbox = {
        ll: {
          x: firstPoint.x,
          y: firstPoint.y
        },
        ur: {
          x: firstPoint.x,
          y: firstPoint.y
        }
      };
      let prevPoint = firstPoint;
      for (let i = 1, iMax = geomRing.length;i < iMax; i++) {
        if (typeof geomRing[i][0] !== "number" || typeof geomRing[i][1] !== "number") {
          throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
        }
        let point = rounder.round(geomRing[i][0], geomRing[i][1]);
        if (point.x === prevPoint.x && point.y === prevPoint.y)
          continue;
        this.segments.push(Segment.fromRing(prevPoint, point, this));
        if (point.x < this.bbox.ll.x)
          this.bbox.ll.x = point.x;
        if (point.y < this.bbox.ll.y)
          this.bbox.ll.y = point.y;
        if (point.x > this.bbox.ur.x)
          this.bbox.ur.x = point.x;
        if (point.y > this.bbox.ur.y)
          this.bbox.ur.y = point.y;
        prevPoint = point;
      }
      if (firstPoint.x !== prevPoint.x || firstPoint.y !== prevPoint.y) {
        this.segments.push(Segment.fromRing(prevPoint, firstPoint, this));
      }
    }
    getSweepEvents() {
      const sweepEvents = [];
      for (let i = 0, iMax = this.segments.length;i < iMax; i++) {
        const segment = this.segments[i];
        sweepEvents.push(segment.leftSE);
        sweepEvents.push(segment.rightSE);
      }
      return sweepEvents;
    }
  }

  class PolyIn {
    constructor(geomPoly, multiPoly) {
      if (!Array.isArray(geomPoly)) {
        throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
      }
      this.exteriorRing = new RingIn(geomPoly[0], this, true);
      this.bbox = {
        ll: {
          x: this.exteriorRing.bbox.ll.x,
          y: this.exteriorRing.bbox.ll.y
        },
        ur: {
          x: this.exteriorRing.bbox.ur.x,
          y: this.exteriorRing.bbox.ur.y
        }
      };
      this.interiorRings = [];
      for (let i = 1, iMax = geomPoly.length;i < iMax; i++) {
        const ring = new RingIn(geomPoly[i], this, false);
        if (ring.bbox.ll.x < this.bbox.ll.x)
          this.bbox.ll.x = ring.bbox.ll.x;
        if (ring.bbox.ll.y < this.bbox.ll.y)
          this.bbox.ll.y = ring.bbox.ll.y;
        if (ring.bbox.ur.x > this.bbox.ur.x)
          this.bbox.ur.x = ring.bbox.ur.x;
        if (ring.bbox.ur.y > this.bbox.ur.y)
          this.bbox.ur.y = ring.bbox.ur.y;
        this.interiorRings.push(ring);
      }
      this.multiPoly = multiPoly;
    }
    getSweepEvents() {
      const sweepEvents = this.exteriorRing.getSweepEvents();
      for (let i = 0, iMax = this.interiorRings.length;i < iMax; i++) {
        const ringSweepEvents = this.interiorRings[i].getSweepEvents();
        for (let j = 0, jMax = ringSweepEvents.length;j < jMax; j++) {
          sweepEvents.push(ringSweepEvents[j]);
        }
      }
      return sweepEvents;
    }
  }

  class MultiPolyIn {
    constructor(geom, isSubject) {
      if (!Array.isArray(geom)) {
        throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
      }
      try {
        if (typeof geom[0][0][0] === "number")
          geom = [geom];
      } catch (ex) {}
      this.polys = [];
      this.bbox = {
        ll: {
          x: Number.POSITIVE_INFINITY,
          y: Number.POSITIVE_INFINITY
        },
        ur: {
          x: Number.NEGATIVE_INFINITY,
          y: Number.NEGATIVE_INFINITY
        }
      };
      for (let i = 0, iMax = geom.length;i < iMax; i++) {
        const poly = new PolyIn(geom[i], this);
        if (poly.bbox.ll.x < this.bbox.ll.x)
          this.bbox.ll.x = poly.bbox.ll.x;
        if (poly.bbox.ll.y < this.bbox.ll.y)
          this.bbox.ll.y = poly.bbox.ll.y;
        if (poly.bbox.ur.x > this.bbox.ur.x)
          this.bbox.ur.x = poly.bbox.ur.x;
        if (poly.bbox.ur.y > this.bbox.ur.y)
          this.bbox.ur.y = poly.bbox.ur.y;
        this.polys.push(poly);
      }
      this.isSubject = isSubject;
    }
    getSweepEvents() {
      const sweepEvents = [];
      for (let i = 0, iMax = this.polys.length;i < iMax; i++) {
        const polySweepEvents = this.polys[i].getSweepEvents();
        for (let j = 0, jMax = polySweepEvents.length;j < jMax; j++) {
          sweepEvents.push(polySweepEvents[j]);
        }
      }
      return sweepEvents;
    }
  }

  class RingOut {
    static factory(allSegments) {
      const ringsOut = [];
      for (let i = 0, iMax = allSegments.length;i < iMax; i++) {
        const segment = allSegments[i];
        if (!segment.isInResult() || segment.ringOut)
          continue;
        let prevEvent = null;
        let event = segment.leftSE;
        let nextEvent = segment.rightSE;
        const events = [event];
        const startingPoint = event.point;
        const intersectionLEs = [];
        while (true) {
          prevEvent = event;
          event = nextEvent;
          events.push(event);
          if (event.point === startingPoint)
            break;
          while (true) {
            const availableLEs = event.getAvailableLinkedEvents();
            if (availableLEs.length === 0) {
              const firstPt = events[0].point;
              const lastPt = events[events.length - 1].point;
              throw new Error(`Unable to complete output ring starting at [${firstPt.x},` + ` ${firstPt.y}]. Last matching segment found ends at` + ` [${lastPt.x}, ${lastPt.y}].`);
            }
            if (availableLEs.length === 1) {
              nextEvent = availableLEs[0].otherSE;
              break;
            }
            let indexLE = null;
            for (let j = 0, jMax = intersectionLEs.length;j < jMax; j++) {
              if (intersectionLEs[j].point === event.point) {
                indexLE = j;
                break;
              }
            }
            if (indexLE !== null) {
              const intersectionLE = intersectionLEs.splice(indexLE)[0];
              const ringEvents = events.splice(intersectionLE.index);
              ringEvents.unshift(ringEvents[0].otherSE);
              ringsOut.push(new RingOut(ringEvents.reverse()));
              continue;
            }
            intersectionLEs.push({
              index: events.length,
              point: event.point
            });
            const comparator = event.getLeftmostComparator(prevEvent);
            nextEvent = availableLEs.sort(comparator)[0].otherSE;
            break;
          }
        }
        ringsOut.push(new RingOut(events));
      }
      return ringsOut;
    }
    constructor(events) {
      this.events = events;
      for (let i = 0, iMax = events.length;i < iMax; i++) {
        events[i].segment.ringOut = this;
      }
      this.poly = null;
    }
    getGeom() {
      let prevPt = this.events[0].point;
      const points = [prevPt];
      for (let i = 1, iMax = this.events.length - 1;i < iMax; i++) {
        const pt2 = this.events[i].point;
        const nextPt2 = this.events[i + 1].point;
        if (compareVectorAngles(pt2, prevPt, nextPt2) === 0)
          continue;
        points.push(pt2);
        prevPt = pt2;
      }
      if (points.length === 1)
        return null;
      const pt = points[0];
      const nextPt = points[1];
      if (compareVectorAngles(pt, prevPt, nextPt) === 0)
        points.shift();
      points.push(points[0]);
      const step = this.isExteriorRing() ? 1 : -1;
      const iStart = this.isExteriorRing() ? 0 : points.length - 1;
      const iEnd = this.isExteriorRing() ? points.length : -1;
      const orderedPoints = [];
      for (let i = iStart;i != iEnd; i += step)
        orderedPoints.push([points[i].x, points[i].y]);
      return orderedPoints;
    }
    isExteriorRing() {
      if (this._isExteriorRing === undefined) {
        const enclosing = this.enclosingRing();
        this._isExteriorRing = enclosing ? !enclosing.isExteriorRing() : true;
      }
      return this._isExteriorRing;
    }
    enclosingRing() {
      if (this._enclosingRing === undefined) {
        this._enclosingRing = this._calcEnclosingRing();
      }
      return this._enclosingRing;
    }
    _calcEnclosingRing() {
      let leftMostEvt = this.events[0];
      for (let i = 1, iMax = this.events.length;i < iMax; i++) {
        const evt = this.events[i];
        if (SweepEvent.compare(leftMostEvt, evt) > 0)
          leftMostEvt = evt;
      }
      let prevSeg = leftMostEvt.segment.prevInResult();
      let prevPrevSeg = prevSeg ? prevSeg.prevInResult() : null;
      while (true) {
        if (!prevSeg)
          return null;
        if (!prevPrevSeg)
          return prevSeg.ringOut;
        if (prevPrevSeg.ringOut !== prevSeg.ringOut) {
          if (prevPrevSeg.ringOut.enclosingRing() !== prevSeg.ringOut) {
            return prevSeg.ringOut;
          } else
            return prevSeg.ringOut.enclosingRing();
        }
        prevSeg = prevPrevSeg.prevInResult();
        prevPrevSeg = prevSeg ? prevSeg.prevInResult() : null;
      }
    }
  }

  class PolyOut {
    constructor(exteriorRing) {
      this.exteriorRing = exteriorRing;
      exteriorRing.poly = this;
      this.interiorRings = [];
    }
    addInterior(ring) {
      this.interiorRings.push(ring);
      ring.poly = this;
    }
    getGeom() {
      const geom = [this.exteriorRing.getGeom()];
      if (geom[0] === null)
        return null;
      for (let i = 0, iMax = this.interiorRings.length;i < iMax; i++) {
        const ringGeom = this.interiorRings[i].getGeom();
        if (ringGeom === null)
          continue;
        geom.push(ringGeom);
      }
      return geom;
    }
  }

  class MultiPolyOut {
    constructor(rings) {
      this.rings = rings;
      this.polys = this._composePolys(rings);
    }
    getGeom() {
      const geom = [];
      for (let i = 0, iMax = this.polys.length;i < iMax; i++) {
        const polyGeom = this.polys[i].getGeom();
        if (polyGeom === null)
          continue;
        geom.push(polyGeom);
      }
      return geom;
    }
    _composePolys(rings) {
      const polys = [];
      for (let i = 0, iMax = rings.length;i < iMax; i++) {
        const ring = rings[i];
        if (ring.poly)
          continue;
        if (ring.isExteriorRing())
          polys.push(new PolyOut(ring));
        else {
          const enclosingRing = ring.enclosingRing();
          if (!enclosingRing.poly)
            polys.push(new PolyOut(enclosingRing));
          enclosingRing.poly.addInterior(ring);
        }
      }
      return polys;
    }
  }

  class SweepLine {
    constructor(queue) {
      let comparator = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : Segment.compare;
      this.queue = queue;
      this.tree = new SplayTree__default["default"](comparator);
      this.segments = [];
    }
    process(event) {
      const segment = event.segment;
      const newEvents = [];
      if (event.consumedBy) {
        if (event.isLeft)
          this.queue.remove(event.otherSE);
        else
          this.tree.remove(segment);
        return newEvents;
      }
      const node = event.isLeft ? this.tree.add(segment) : this.tree.find(segment);
      if (!node)
        throw new Error(`Unable to find segment #${segment.id} ` + `[${segment.leftSE.point.x}, ${segment.leftSE.point.y}] -> ` + `[${segment.rightSE.point.x}, ${segment.rightSE.point.y}] ` + "in SweepLine tree.");
      let prevNode = node;
      let nextNode = node;
      let prevSeg = undefined;
      let nextSeg = undefined;
      while (prevSeg === undefined) {
        prevNode = this.tree.prev(prevNode);
        if (prevNode === null)
          prevSeg = null;
        else if (prevNode.key.consumedBy === undefined)
          prevSeg = prevNode.key;
      }
      while (nextSeg === undefined) {
        nextNode = this.tree.next(nextNode);
        if (nextNode === null)
          nextSeg = null;
        else if (nextNode.key.consumedBy === undefined)
          nextSeg = nextNode.key;
      }
      if (event.isLeft) {
        let prevMySplitter = null;
        if (prevSeg) {
          const prevInter = prevSeg.getIntersection(segment);
          if (prevInter !== null) {
            if (!segment.isAnEndpoint(prevInter))
              prevMySplitter = prevInter;
            if (!prevSeg.isAnEndpoint(prevInter)) {
              const newEventsFromSplit = this._splitSafely(prevSeg, prevInter);
              for (let i = 0, iMax = newEventsFromSplit.length;i < iMax; i++) {
                newEvents.push(newEventsFromSplit[i]);
              }
            }
          }
        }
        let nextMySplitter = null;
        if (nextSeg) {
          const nextInter = nextSeg.getIntersection(segment);
          if (nextInter !== null) {
            if (!segment.isAnEndpoint(nextInter))
              nextMySplitter = nextInter;
            if (!nextSeg.isAnEndpoint(nextInter)) {
              const newEventsFromSplit = this._splitSafely(nextSeg, nextInter);
              for (let i = 0, iMax = newEventsFromSplit.length;i < iMax; i++) {
                newEvents.push(newEventsFromSplit[i]);
              }
            }
          }
        }
        if (prevMySplitter !== null || nextMySplitter !== null) {
          let mySplitter = null;
          if (prevMySplitter === null)
            mySplitter = nextMySplitter;
          else if (nextMySplitter === null)
            mySplitter = prevMySplitter;
          else {
            const cmpSplitters = SweepEvent.comparePoints(prevMySplitter, nextMySplitter);
            mySplitter = cmpSplitters <= 0 ? prevMySplitter : nextMySplitter;
          }
          this.queue.remove(segment.rightSE);
          newEvents.push(segment.rightSE);
          const newEventsFromSplit = segment.split(mySplitter);
          for (let i = 0, iMax = newEventsFromSplit.length;i < iMax; i++) {
            newEvents.push(newEventsFromSplit[i]);
          }
        }
        if (newEvents.length > 0) {
          this.tree.remove(segment);
          newEvents.push(event);
        } else {
          this.segments.push(segment);
          segment.prev = prevSeg;
        }
      } else {
        if (prevSeg && nextSeg) {
          const inter = prevSeg.getIntersection(nextSeg);
          if (inter !== null) {
            if (!prevSeg.isAnEndpoint(inter)) {
              const newEventsFromSplit = this._splitSafely(prevSeg, inter);
              for (let i = 0, iMax = newEventsFromSplit.length;i < iMax; i++) {
                newEvents.push(newEventsFromSplit[i]);
              }
            }
            if (!nextSeg.isAnEndpoint(inter)) {
              const newEventsFromSplit = this._splitSafely(nextSeg, inter);
              for (let i = 0, iMax = newEventsFromSplit.length;i < iMax; i++) {
                newEvents.push(newEventsFromSplit[i]);
              }
            }
          }
        }
        this.tree.remove(segment);
      }
      return newEvents;
    }
    _splitSafely(seg, pt) {
      this.tree.remove(seg);
      const rightSE = seg.rightSE;
      this.queue.remove(rightSE);
      const newEvents = seg.split(pt);
      newEvents.push(rightSE);
      if (seg.consumedBy === undefined)
        this.tree.add(seg);
      return newEvents;
    }
  }
  var POLYGON_CLIPPING_MAX_QUEUE_SIZE = typeof process !== "undefined" && process.env.POLYGON_CLIPPING_MAX_QUEUE_SIZE || 1e6;
  var POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS = typeof process !== "undefined" && process.env.POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS || 1e6;

  class Operation {
    run(type, geom, moreGeoms) {
      operation.type = type;
      rounder.reset();
      const multipolys = [new MultiPolyIn(geom, true)];
      for (let i = 0, iMax = moreGeoms.length;i < iMax; i++) {
        multipolys.push(new MultiPolyIn(moreGeoms[i], false));
      }
      operation.numMultiPolys = multipolys.length;
      if (operation.type === "difference") {
        const subject = multipolys[0];
        let i = 1;
        while (i < multipolys.length) {
          if (getBboxOverlap(multipolys[i].bbox, subject.bbox) !== null)
            i++;
          else
            multipolys.splice(i, 1);
        }
      }
      if (operation.type === "intersection") {
        for (let i = 0, iMax = multipolys.length;i < iMax; i++) {
          const mpA = multipolys[i];
          for (let j = i + 1, jMax = multipolys.length;j < jMax; j++) {
            if (getBboxOverlap(mpA.bbox, multipolys[j].bbox) === null)
              return [];
          }
        }
      }
      const queue = new SplayTree__default["default"](SweepEvent.compare);
      for (let i = 0, iMax = multipolys.length;i < iMax; i++) {
        const sweepEvents = multipolys[i].getSweepEvents();
        for (let j = 0, jMax = sweepEvents.length;j < jMax; j++) {
          queue.insert(sweepEvents[j]);
          if (queue.size > POLYGON_CLIPPING_MAX_QUEUE_SIZE) {
            throw new Error("Infinite loop when putting segment endpoints in a priority queue " + "(queue size too big).");
          }
        }
      }
      const sweepLine = new SweepLine(queue);
      let prevQueueSize = queue.size;
      let node = queue.pop();
      while (node) {
        const evt = node.key;
        if (queue.size === prevQueueSize) {
          const seg = evt.segment;
          throw new Error(`Unable to pop() ${evt.isLeft ? "left" : "right"} SweepEvent ` + `[${evt.point.x}, ${evt.point.y}] from segment #${seg.id} ` + `[${seg.leftSE.point.x}, ${seg.leftSE.point.y}] -> ` + `[${seg.rightSE.point.x}, ${seg.rightSE.point.y}] from queue.`);
        }
        if (queue.size > POLYGON_CLIPPING_MAX_QUEUE_SIZE) {
          throw new Error("Infinite loop when passing sweep line over endpoints " + "(queue size too big).");
        }
        if (sweepLine.segments.length > POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS) {
          throw new Error("Infinite loop when passing sweep line over endpoints " + "(too many sweep line segments).");
        }
        const newEvents = sweepLine.process(evt);
        for (let i = 0, iMax = newEvents.length;i < iMax; i++) {
          const evt2 = newEvents[i];
          if (evt2.consumedBy === undefined)
            queue.insert(evt2);
        }
        prevQueueSize = queue.size;
        node = queue.pop();
      }
      rounder.reset();
      const ringsOut = RingOut.factory(sweepLine.segments);
      const result = new MultiPolyOut(ringsOut);
      return result.getGeom();
    }
  }
  var operation = new Operation;
  var union = function(geom) {
    for (var _len = arguments.length, moreGeoms = new Array(_len > 1 ? _len - 1 : 0), _key = 1;_key < _len; _key++) {
      moreGeoms[_key - 1] = arguments[_key];
    }
    return operation.run("union", geom, moreGeoms);
  };
  var intersection = function(geom) {
    for (var _len2 = arguments.length, moreGeoms = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1;_key2 < _len2; _key2++) {
      moreGeoms[_key2 - 1] = arguments[_key2];
    }
    return operation.run("intersection", geom, moreGeoms);
  };
  var xor = function(geom) {
    for (var _len3 = arguments.length, moreGeoms = new Array(_len3 > 1 ? _len3 - 1 : 0), _key3 = 1;_key3 < _len3; _key3++) {
      moreGeoms[_key3 - 1] = arguments[_key3];
    }
    return operation.run("xor", geom, moreGeoms);
  };
  var difference = function(subjectGeom) {
    for (var _len4 = arguments.length, clippingGeoms = new Array(_len4 > 1 ? _len4 - 1 : 0), _key4 = 1;_key4 < _len4; _key4++) {
      clippingGeoms[_key4 - 1] = arguments[_key4];
    }
    return operation.run("difference", subjectGeom, clippingGeoms);
  };
  var index = {
    union,
    intersection,
    xor,
    difference
  };
  module.exports = index;
});
// ../three-roads-inspect/packages/core/src/lanes/lane-edge-semantics.ts
function laneHasVerticalEdge(lane, boundary) {
  return lane.verticalEdges === "both" || lane.verticalEdges === boundary;
}
function lanesHaveVerticalSeparation(inner, outer) {
  return laneHasVerticalEdge(inner, "outer") || laneHasVerticalEdge(outer, "inner");
}
// ../three-roads-inspect/packages/core/src/streetscape/streetscape-types.ts
var DEFAULT_ROAD_STREETSCAPE_AUTOMATIC_RULES = {
  trafficSignals: true,
  prioritySigns: true,
  noEntrySigns: true,
  speedSigns: true,
  semanticRoadObjects: true,
  transitFurniture: true,
  streetNameSigns: true,
  safetyFurniture: true,
  junctionBollards: false
};
function createRoadStreetscapeDocument(id = "streetscape") {
  return {
    id,
    version: 1,
    tracks: [],
    automaticRules: { ...DEFAULT_ROAD_STREETSCAPE_AUTOMATIC_RULES },
    ruleOverrides: [],
    instanceOverrides: []
  };
}

// ../three-roads-inspect/packages/core/src/authoring-document/document-builder.ts
function createRoadAuthoringDocument(options) {
  return {
    id: options.id,
    name: options.name,
    templates: [],
    strokes: [],
    junctions: [],
    junctionGroups: [],
    gradeSeparations: [],
    roadStructures: [],
    roadsideFeatures: [],
    roadSurfaceElevations: [],
    weavingSections: [],
    markings: [],
    objects: [],
    regulations: [],
    trafficManagementPlans: [],
    ordinaryNodeIntents: [],
    streetscape: createRoadStreetscapeDocument(`${options.id}-streetscape`)
  };
}
// ../three-roads-inspect/packages/core/src/authoring-document/ordinary-node-intent.ts
function ordinaryNodeContactKey(contact) {
  return `${contact.roadId}:${contact.contactPoint}`;
}
function ordinaryNodeContactsKey(contacts) {
  return contacts.map(ordinaryNodeContactKey).sort().join("|");
}
function ordinaryNodeMovementKey(selector) {
  return `${ordinaryNodeContactKey(selector.from)}:${selector.from.laneRole}->${ordinaryNodeContactKey(selector.to)}:${selector.to.laneRole}`;
}
function canonicalizeOrdinaryNodeIntent(intent) {
  const contacts = [...intent.contacts].map((contact) => structuredClone(contact)).sort((left, right) => ordinaryNodeContactKey(left).localeCompare(ordinaryNodeContactKey(right)));
  const prohibitedMovements = intent.prohibitedMovements ? [...intent.prohibitedMovements].map((selector) => structuredClone(selector)).sort((left, right) => ordinaryNodeMovementKey(left).localeCompare(ordinaryNodeMovementKey(right))) : undefined;
  const movementMappings = intent.movementMappings ? [...intent.movementMappings].map((selector) => structuredClone(selector)).sort((left, right) => ordinaryNodeMovementKey(left).localeCompare(ordinaryNodeMovementKey(right))) : undefined;
  const prohibitedParticipantClasses = intent.prohibitedParticipantClasses ? [...new Set(intent.prohibitedParticipantClasses)].sort() : undefined;
  return {
    ...structuredClone(intent),
    contacts,
    ...prohibitedMovements ? { prohibitedMovements } : {},
    ...movementMappings ? { movementMappings } : {},
    ...prohibitedParticipantClasses ? { prohibitedParticipantClasses } : {}
  };
}

// ../three-roads-inspect/packages/core/src/authoring-document/document-commands.ts
function addRoadTemplate(document, template) {
  ensureUnique(document.templates, template.id, "template");
  return { ...document, templates: [...document.templates, structuredClone(template)] };
}
function addRoadStroke(document, stroke) {
  ensureUnique(document.strokes, stroke.id, "stroke");
  return { ...document, strokes: [...document.strokes, structuredClone(stroke)] };
}
function addJunctionIntent(document, junction) {
  ensureUnique(document.junctions, junction.id, "junction");
  return { ...document, junctions: [...document.junctions, structuredClone(junction)] };
}
function ensureUnique(values, id, kind) {
  if (values.some((value) => value.id === id))
    throw new Error(`Document already has ${kind} ${id}`);
}
// ../three-roads-inspect/packages/core/src/authoring-document/road-template-compatibility.ts
function roadTemplatesHaveCompatibleLaneRoles(first, second) {
  const firstRoles = new Set(first.lanes.map(({ role }) => role));
  const secondRoles = new Set(second.lanes.map(({ role }) => role));
  return firstRoles.size === secondRoles.size && [...firstRoles].every((role) => secondRoles.has(role));
}
function roadTemplatesHaveIdenticalCrossSection(first, second) {
  if (first.id === second.id)
    return true;
  if (first.lanes.length !== second.lanes.length)
    return false;
  const secondByRole = new Map(second.lanes.map((lane) => [lane.role, lane]));
  return first.lanes.every((lane) => {
    const other = secondByRole.get(lane.role);
    return other !== undefined && other.side === lane.side && other.order === lane.order && other.type === lane.type && other.direction === lane.direction && other.level === lane.level && Math.abs(other.width - lane.width) <= 0.000001 && identicalLaneHeights(lane, other);
  });
}
function identicalLaneHeights(first, second) {
  const firstHeights = first.heights ?? [];
  const secondHeights = second.heights ?? [];
  return firstHeights.length === secondHeights.length && firstHeights.every((height, index) => {
    const other = secondHeights[index];
    return Math.abs(other.sOffset - height.sOffset) <= 0.000001 && Math.abs(other.inner - height.inner) <= 0.000001 && Math.abs(other.outer - height.outer) <= 0.000001;
  });
}
// ../three-roads-inspect/packages/core/src/geometry/math.ts
var EPSILON = 0.0000001;
function nearlyEqual(a, b, epsilon = EPSILON) {
  return Math.abs(a - b) <= epsilon;
}
function evaluateCubic(poly, p) {
  return poly.a + poly.b * p + poly.c * p * p + poly.d * p * p * p;
}
function evaluateCubicDerivative(poly, p) {
  return poly.b + 2 * poly.c * p + 3 * poly.d * p * p;
}
function evaluateCubicSecondDerivative(poly, p) {
  return 2 * poly.c + 6 * poly.d * p;
}
function shiftCubic(poly, delta) {
  return {
    a: evaluateCubic(poly, delta),
    b: poly.b + 2 * poly.c * delta + 3 * poly.d * delta * delta,
    c: poly.c + 3 * poly.d * delta,
    d: poly.d
  };
}
function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
function interpolate(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  };
}
function normalizeAngle(angle) {
  let out = angle;
  while (out <= -Math.PI)
    out += Math.PI * 2;
  while (out > Math.PI)
    out -= Math.PI * 2;
  return out;
}
function leftNormal(heading) {
  return { x: -Math.sin(heading), y: Math.cos(heading) };
}
function tangentFromHeading(heading) {
  return { x: Math.cos(heading), y: Math.sin(heading) };
}
function formatNumber(value) {
  if (Math.abs(value) < 0.000000001)
    return "0";
  return Number(value.toFixed(3)).toString();
}
function segmentsIntersect(a, b, c, d) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const adx = d.x - a.x;
  const ady = d.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const cax = a.x - c.x;
  const cay = a.y - c.y;
  const cbx = b.x - c.x;
  const cby = b.y - c.y;
  const o1 = cross(abx, aby, acx, acy);
  const o2 = cross(abx, aby, adx, ady);
  const o3 = cross(cdx, cdy, cax, cay);
  const o4 = cross(cdx, cdy, cbx, cby);
  if (Math.abs(o1) < EPSILON && onSegment(a, b, c))
    return true;
  if (Math.abs(o2) < EPSILON && onSegment(a, b, d))
    return true;
  if (Math.abs(o3) < EPSILON && onSegment(c, d, a))
    return true;
  if (Math.abs(o4) < EPSILON && onSegment(c, d, b))
    return true;
  return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0;
}
function segmentIntersectionParameters(a, b, c, d) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denominator = cross(abx, aby, cdx, cdy);
  if (Math.abs(denominator) < EPSILON)
    return;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const ab = cross(acx, acy, cdx, cdy) / denominator;
  const cd = cross(acx, acy, abx, aby) / denominator;
  if (ab < -EPSILON || ab > 1 + EPSILON || cd < -EPSILON || cd > 1 + EPSILON)
    return;
  return {
    point: interpolate(a, b, Math.max(0, Math.min(1, ab))),
    ab,
    cd
  };
}
function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}
function onSegment(a, b, p) {
  return p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}

// ../three-roads-inspect/packages/core/src/geometry/reference-line.ts
function referenceLineLength(referenceLine) {
  return referenceLine.geometry.reduce((length, segment) => Math.max(length, segment.s + segment.length), 0);
}
function evaluateReferenceLine(referenceLine, s) {
  const segment = findSegment(referenceLine, s);
  return evaluateGeometrySegment(segment, clampLocalS(segment, s - segment.s));
}
function evaluateRoadReference(road, s) {
  return evaluateReferenceLine(road.referenceLine, Math.max(0, Math.min(road.length, s)));
}
function stToWorld(referenceLine, s, t) {
  const pose = evaluateReferenceLine(referenceLine, s);
  const normal = leftNormal(pose.heading);
  return {
    x: pose.x + normal.x * t,
    y: pose.y + normal.y * t
  };
}
function sampleReferenceLine(referenceLine, options = {}) {
  const maxSegmentLength = options.step ?? 5;
  const maxChordError = options.maxChordError ?? 0.01;
  const maxHeadingDelta = options.maxHeadingDelta ?? Math.PI / 180;
  const maxDepth = options.maxDepth ?? 24;
  const points = [];
  for (const segment of referenceLine.geometry) {
    const segmentPoints = sampleGeometrySegment(segment, {
      maxSegmentLength,
      maxChordError,
      maxHeadingDelta,
      maxDepth
    });
    points.push(...points.length > 0 ? segmentPoints.slice(1) : segmentPoints);
  }
  if (options.includeEnds !== false || points.length <= 2)
    return points;
  return points.slice(1, -1);
}
function sampleRoadReference(road, options = {}) {
  return sampleReferenceLine(road.referenceLine, options);
}
function sampleGeometrySegment(segment, options) {
  const start = evaluateGeometrySegment(segment, 0);
  const end = evaluateGeometrySegment(segment, segment.length);
  const points = [start];
  subdivideGeometrySegment(segment, 0, start, segment.length, end, 0, options, points);
  return points;
}
function subdivideGeometrySegment(segment, startS, start, endS, end, depth, options, points) {
  const midS = (startS + endS) * 0.5;
  const mid = evaluateGeometrySegment(segment, midS);
  const interval = endS - startS;
  const chordError = pointToSegmentDistance(mid, start, end);
  const headingDelta = Math.max(Math.abs(normalizeAngle(mid.heading - start.heading)), Math.abs(normalizeAngle(end.heading - mid.heading)));
  const needsSubdivision = interval > options.maxSegmentLength || chordError > options.maxChordError || headingDelta > options.maxHeadingDelta;
  if (needsSubdivision && depth < options.maxDepth && interval > 0.000001) {
    subdivideGeometrySegment(segment, startS, start, midS, mid, depth + 1, options, points);
    subdivideGeometrySegment(segment, midS, mid, endS, end, depth + 1, options, points);
    return;
  }
  points.push(end);
}
function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000000000000000001)
    return distance(point, start);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
}
function makeLineSegment(s, x, y, heading, length) {
  return { kind: "line", s, x, y, heading, length };
}
function findSegment(referenceLine, s) {
  if (referenceLine.geometry.length === 0) {
    throw new Error("Reference line has no geometry segments");
  }
  const clampedS = Math.max(0, Math.min(referenceLineLength(referenceLine), s));
  for (const segment of referenceLine.geometry) {
    if (clampedS >= segment.s - 0.0000001 && clampedS <= segment.s + segment.length + 0.0000001)
      return segment;
  }
  return referenceLine.geometry[referenceLine.geometry.length - 1];
}
function clampLocalS(segment, localS) {
  return Math.max(0, Math.min(segment.length, localS));
}
function evaluateGeometrySegment(segment, localS) {
  if (segment.kind === "line")
    return evaluateLine(segment, localS);
  if (segment.kind === "arc")
    return evaluateArc(segment, localS);
  if (segment.kind === "spiral")
    return evaluateSpiral(segment, localS);
  return evaluateParamPoly3(segment, localS);
}
function evaluateLine(segment, localS) {
  const tangent = tangentFromHeading(segment.heading);
  return {
    x: segment.x + tangent.x * localS,
    y: segment.y + tangent.y * localS,
    heading: segment.heading,
    curvature: 0
  };
}
function evaluateArc(segment, localS) {
  if (nearlyEqual(segment.curvature, 0))
    return evaluateLine(segment, localS);
  const radius = 1 / segment.curvature;
  const angle = segment.heading + localS * segment.curvature;
  return {
    x: segment.x + radius * (Math.sin(angle) - Math.sin(segment.heading)),
    y: segment.y - radius * (Math.cos(angle) - Math.cos(segment.heading)),
    heading: angle,
    curvature: segment.curvature
  };
}
function evaluateSpiral(segment, localS) {
  const clampedS = Math.max(0, Math.min(segment.length, localS));
  const curvatureRate = segment.length <= 0 ? 0 : (segment.curvatureEnd - segment.curvatureStart) / segment.length;
  const headingAt = (s) => segment.heading + segment.curvatureStart * s + 0.5 * curvatureRate * s * s;
  const deltaHeading = Math.abs(headingAt(clampedS) - segment.heading);
  const partCount = Math.max(1, Math.ceil(Math.max(clampedS / 25, deltaHeading / 0.25)));
  let x = segment.x;
  let y = segment.y;
  for (let part = 0;part < partCount; part++) {
    const startS = clampedS * part / partCount;
    const endS = clampedS * (part + 1) / partCount;
    x += gaussLegendre8(startS, endS, (s) => Math.cos(headingAt(s)));
    y += gaussLegendre8(startS, endS, (s) => Math.sin(headingAt(s)));
  }
  return {
    x,
    y,
    heading: headingAt(clampedS),
    curvature: interpolateCurvature(segment, clampedS)
  };
}
function interpolateCurvature(segment, localS) {
  if (segment.length <= 0)
    return segment.curvatureStart;
  const t = localS / segment.length;
  return segment.curvatureStart + (segment.curvatureEnd - segment.curvatureStart) * t;
}
function evaluateParamPoly3(segment, localS) {
  const p = segment.pRange === "normalized" ? localS / segment.length : localS;
  const u = evaluateCubic(segment.u, p);
  const v = evaluateCubic(segment.v, p);
  const du = evaluateCubicDerivative(segment.u, p);
  const dv = evaluateCubicDerivative(segment.v, p);
  const ddu = evaluateCubicSecondDerivative(segment.u, p);
  const ddv = evaluateCubicSecondDerivative(segment.v, p);
  const cos = Math.cos(segment.heading);
  const sin = Math.sin(segment.heading);
  const speedSquared = du * du + dv * dv;
  return {
    x: segment.x + u * cos - v * sin,
    y: segment.y + u * sin + v * cos,
    heading: segment.heading + Math.atan2(dv, du),
    curvature: speedSquared <= 0.000000000000000001 ? 0 : (du * ddv - dv * ddu) / Math.pow(speedSquared, 1.5)
  };
}
var GAUSS_8_NODES = [
  -0.9602898564975363,
  -0.7966664774136267,
  -0.525532409916329,
  -0.1834346424956498,
  0.1834346424956498,
  0.525532409916329,
  0.7966664774136267,
  0.9602898564975363
];
var GAUSS_8_WEIGHTS = [
  0.1012285362903763,
  0.2223810344533745,
  0.3137066458778873,
  0.362683783378362,
  0.362683783378362,
  0.3137066458778873,
  0.2223810344533745,
  0.1012285362903763
];
function gaussLegendre8(start, end, evaluate) {
  const midpoint = (start + end) * 0.5;
  const halfLength = (end - start) * 0.5;
  let sum = 0;
  for (let index = 0;index < GAUSS_8_NODES.length; index++) {
    sum += GAUSS_8_WEIGHTS[index] * evaluate(midpoint + halfLength * GAUSS_8_NODES[index]);
  }
  return halfLength * sum;
}

// ../three-roads-inspect/packages/core/src/authoring-document/connector-geometry-validation.ts
var STATION_TOLERANCE = 0.000001;
var POSITION_TOLERANCE = 0.00001;
var HEADING_TOLERANCE = 0.000001;
function validateConnectorGeometry(geometry, label) {
  if (geometry.length === 0) {
    return [{
      code: "junction-connector-geometry-empty",
      message: `${label} connector geometry needs at least one segment`
    }];
  }
  const issues = [];
  if (Math.abs(geometry[0].s) > STATION_TOLERANCE) {
    issues.push({
      code: "junction-connector-geometry-start-station",
      message: `${label} connector geometry must start at s=0`
    });
  }
  for (let index = 0;index < geometry.length; index++) {
    const segment = geometry[index];
    if (!hasFiniteParameters(segment)) {
      issues.push({
        code: "junction-connector-geometry-non-finite",
        message: `${label} connector segment ${index} contains a non-finite parameter`
      });
    }
    if (!Number.isFinite(segment.length) || segment.length <= 0) {
      issues.push({
        code: "junction-connector-geometry-length",
        message: `${label} connector segment ${index} needs a positive length`
      });
    }
    if (index === 0)
      continue;
    validateSegmentJoin(geometry[index - 1], segment, index, label, issues);
  }
  return issues;
}
function validateSegmentJoin(previous, current, currentIndex, label, issues) {
  const expectedStation = previous.s + previous.length;
  if (Number.isFinite(expectedStation) && Number.isFinite(current.s) && Math.abs(current.s - expectedStation) > STATION_TOLERANCE) {
    issues.push({
      code: "junction-connector-geometry-station-discontinuity",
      message: `${label} connector segment ${currentIndex} must start at s=${expectedStation}`
    });
  }
  if (!hasFiniteParameters(previous) || !hasFiniteParameters(current) || previous.length <= 0 || current.length <= 0)
    return;
  const previousEnd = evaluateGeometrySegment(previous, previous.length);
  const positionGap = distance(previousEnd, current);
  if (positionGap > POSITION_TOLERANCE) {
    issues.push({
      code: "junction-connector-geometry-position-discontinuity",
      message: `${label} connector segment ${currentIndex} starts ${positionGap} m from the preceding segment`
    });
  }
  const headingGap = Math.abs(normalizeAngle(current.heading - previousEnd.heading));
  if (headingGap > HEADING_TOLERANCE) {
    issues.push({
      code: "junction-connector-geometry-heading-discontinuity",
      message: `${label} connector segment ${currentIndex} changes heading by ${headingGap} rad at its join`
    });
  }
}
function hasFiniteParameters(segment) {
  const values = [segment.s, segment.x, segment.y, segment.heading, segment.length];
  if (segment.kind === "arc")
    values.push(segment.curvature);
  if (segment.kind === "spiral")
    values.push(segment.curvatureStart, segment.curvatureEnd);
  if (segment.kind === "param-poly3") {
    values.push(segment.u.a, segment.u.b, segment.u.c, segment.u.d, segment.v.a, segment.v.b, segment.v.c, segment.v.d);
  }
  return values.every(Number.isFinite);
}

// ../three-roads-inspect/packages/core/src/authoring-document/junction-ports.ts
function junctionPortId(port) {
  return port.id ?? `${port.roadId}@${port.s ?? port.contactPoint}`;
}
function maneuverPortId(junction, roadId, explicitPortId) {
  if (explicitPortId) {
    return junction.ports.some((port) => port.roadId === roadId && junctionPortId(port) === explicitPortId) ? explicitPortId : undefined;
  }
  const ports = junction.ports.filter((port) => port.roadId === roadId);
  return ports.length === 1 ? junctionPortId(ports[0]) : undefined;
}

// ../three-roads-inspect/packages/core/src/authoring-document/grade-separation-validation.ts
var PLAN_CONTACT_TOLERANCE = 0.00001;
function validateGradeSeparationIntents(document, diagnostics) {
  const ids = new Set;
  const strokes = new Map(document.strokes.map((stroke) => [stroke.id, stroke]));
  for (const intent of document.gradeSeparations ?? []) {
    if (!intent.id || ids.has(intent.id)) {
      addError(diagnostics, "duplicate-grade-separation-id", `Duplicate grade separation id ${intent.id}`, intent.id);
    }
    ids.add(intent.id);
    const upper = strokes.get(intent.upperRoad.roadId);
    const lower = strokes.get(intent.lowerRoad.roadId);
    const structure = intent.structureId ? document.roadStructures?.find((candidate) => candidate.id === intent.structureId) : undefined;
    if (intent.structureId && !structure) {
      addError(diagnostics, "grade-separation-structure-missing", `Grade separation ${intent.id} references missing road structure ${intent.structureId}`, intent.id);
    }
    if (structure) {
      if (structure.roadId !== intent.upperRoad.roadId) {
        addError(diagnostics, "grade-separation-structure-road-mismatch", `Grade separation ${intent.id} upper road differs from structure ${structure.id}`, intent.id);
      }
      if (structure.kind !== intent.kind) {
        addError(diagnostics, "grade-separation-structure-kind-mismatch", `Grade separation ${intent.id} kind differs from structure ${structure.id}`, intent.id);
      }
      if (Math.abs(structure.structuralThickness - intent.deckThickness) > PLAN_CONTACT_TOLERANCE) {
        addError(diagnostics, "grade-separation-structure-thickness-mismatch", `Grade separation ${intent.id} thickness differs from structure ${structure.id}`, intent.id);
      }
      if (Math.abs(structure.sStart - intent.deckExtent.sStart) > PLAN_CONTACT_TOLERANCE || Math.abs(structure.sEnd - intent.deckExtent.sEnd) > PLAN_CONTACT_TOLERANCE) {
        addError(diagnostics, "grade-separation-structure-range-mismatch", `Grade separation ${intent.id} deck extent differs from structure ${structure.id}`, intent.id);
      }
    }
    if (!upper)
      addError(diagnostics, "grade-separation-upper-road-missing", `Grade separation ${intent.id} references missing upper road ${intent.upperRoad.roadId}`, intent.id);
    if (!lower)
      addError(diagnostics, "grade-separation-lower-road-missing", `Grade separation ${intent.id} references missing lower road ${intent.lowerRoad.roadId}`, intent.id);
    if (intent.upperRoad.roadId === intent.lowerRoad.roadId) {
      addError(diagnostics, "grade-separation-self-reference", `Grade separation ${intent.id} must reference two roads`, intent.id);
    }
    if (!upper || !lower)
      continue;
    const upperLength = referenceLineLength({ geometry: upper.geometry });
    const lowerLength = referenceLineLength({ geometry: lower.geometry });
    const upperStationValid = validStation(intent.upperRoad.s, upperLength);
    const lowerStationValid = validStation(intent.lowerRoad.s, lowerLength);
    if (!upperStationValid)
      addError(diagnostics, "grade-separation-upper-station-out-of-range", `Grade separation ${intent.id} upper station is outside road ${upper.id}`, intent.id);
    if (!lowerStationValid)
      addError(diagnostics, "grade-separation-lower-station-out-of-range", `Grade separation ${intent.id} lower station is outside road ${lower.id}`, intent.id);
    if (!Number.isFinite(intent.deckThickness) || intent.deckThickness <= 0) {
      addError(diagnostics, "grade-separation-deck-thickness", `Grade separation ${intent.id} needs a positive deck thickness`, intent.id);
    }
    if (!Number.isFinite(intent.minimumClearance) || intent.minimumClearance < 0) {
      addError(diagnostics, "grade-separation-minimum-clearance", `Grade separation ${intent.id} needs a non-negative minimum clearance`, intent.id);
    }
    if (!validStation(intent.deckExtent.sStart, upperLength) || !validStation(intent.deckExtent.sEnd, upperLength) || intent.deckExtent.sEnd <= intent.deckExtent.sStart) {
      addError(diagnostics, "grade-separation-deck-extent", `Grade separation ${intent.id} has an invalid upper-road deck extent`, intent.id);
    } else if (intent.upperRoad.s < intent.deckExtent.sStart - PLAN_CONTACT_TOLERANCE || intent.upperRoad.s > intent.deckExtent.sEnd + PLAN_CONTACT_TOLERANCE) {
      addError(diagnostics, "grade-separation-contact-outside-deck", `Grade separation ${intent.id} upper contact is outside its deck extent`, intent.id);
    }
    if (upperStationValid && lowerStationValid && upper.geometry.length > 0 && lower.geometry.length > 0) {
      const upperPoint = evaluateReferenceLine({ geometry: upper.geometry }, intent.upperRoad.s);
      const lowerPoint = evaluateReferenceLine({ geometry: lower.geometry }, intent.lowerRoad.s);
      if (distance(upperPoint, lowerPoint) > PLAN_CONTACT_TOLERANCE) {
        addError(diagnostics, "grade-separation-plan-contact-mismatch", `Grade separation ${intent.id} road stations are not coincident in plan`, intent.id);
      }
    }
  }
}
function validStation(s, length) {
  return Number.isFinite(s) && s >= 0 && s <= length;
}
function addError(diagnostics, code, message, sourceId) {
  diagnostics.push({ severity: "error", code, message, sourceId });
}

// ../three-roads-inspect/packages/core/src/authoring-document/weaving-section-validation.ts
var STATION_TOLERANCE2 = 0.000001;
var TRAFFIC_LANE_TYPES = new Set(["driving", "entry", "exit", "on-ramp", "off-ramp", "shared", "bus"]);
function validateWeavingSectionIntents(document, diagnostics) {
  const ids = new Set;
  const validated = [];
  const templates = new Map(document.templates.map((template) => [template.id, template]));
  for (const weaving of document.weavingSections ?? []) {
    if (!weaving.id || ids.has(weaving.id)) {
      addError2(diagnostics, "duplicate-weaving-section-id", `Duplicate weaving section id ${weaving.id}`, weaving.id);
    }
    ids.add(weaving.id);
    for (const previous of validated) {
      if (sameLanePair(previous, weaving) && weaving.sStart < previous.sEnd - STATION_TOLERANCE2 && weaving.sEnd > previous.sStart + STATION_TOLERANCE2) {
        addError2(diagnostics, "weaving-sections-overlap", `Weaving sections ${previous.id} and ${weaving.id} overlap`, weaving.id);
      }
    }
    validateWeavingSection(document, templates, weaving, diagnostics);
    validated.push(weaving);
  }
}
function sameLanePair(left, right) {
  return left.roadId === right.roadId && left.throughLaneRole === right.throughLaneRole && left.weavingLaneRole === right.weavingLaneRole;
}
function validateWeavingSection(document, templates, weaving, diagnostics) {
  const stroke = document.strokes.find((candidate) => candidate.id === weaving.roadId);
  const entry = document.junctions.find((candidate) => candidate.id === weaving.entryJunctionId);
  const exit = document.junctions.find((candidate) => candidate.id === weaving.exitJunctionId);
  if (!stroke)
    addError2(diagnostics, "weaving-road-missing", `Weaving section ${weaving.id} references missing road ${weaving.roadId}`, weaving.id);
  if (!entry)
    addError2(diagnostics, "weaving-entry-junction-missing", `Weaving section ${weaving.id} references missing entry junction ${weaving.entryJunctionId}`, weaving.id);
  if (!exit)
    addError2(diagnostics, "weaving-exit-junction-missing", `Weaving section ${weaving.id} references missing exit junction ${weaving.exitJunctionId}`, weaving.id);
  if (!stroke || !entry || !exit)
    return;
  const length = referenceLineLength({ geometry: stroke.geometry });
  if (!Number.isFinite(weaving.sStart) || !Number.isFinite(weaving.sEnd) || weaving.sStart < 0 || weaving.sEnd > length || weaving.sEnd <= weaving.sStart) {
    addError2(diagnostics, "weaving-range-invalid", `Weaving section ${weaving.id} has an invalid road range`, weaving.id);
    return;
  }
  if (weaving.minimumLength !== undefined && (!Number.isFinite(weaving.minimumLength) || weaving.minimumLength <= 0)) {
    addError2(diagnostics, "weaving-minimum-length-invalid", `Weaving section ${weaving.id} needs a positive minimum length`, weaving.id);
  } else if (weaving.minimumLength !== undefined && weaving.sEnd - weaving.sStart + STATION_TOLERANCE2 < weaving.minimumLength) {
    addError2(diagnostics, "weaving-section-too-short", `Weaving section ${weaving.id} is shorter than ${weaving.minimumLength} m`, weaving.id);
  }
  if (weaving.throughLaneRole === weaving.weavingLaneRole) {
    addError2(diagnostics, "weaving-lane-roles-identical", `Weaving section ${weaving.id} needs two distinct lane roles`, weaving.id);
  }
  if (entry.id === exit.id) {
    addError2(diagnostics, "weaving-junctions-identical", `Weaving section ${weaving.id} needs distinct entry and exit junctions`, weaving.id);
  }
  validateTerminal(weaving, entry, weaving.sStart, length, "entry", diagnostics);
  validateTerminal(weaving, exit, weaving.sEnd, length, "exit", diagnostics);
  for (const template of templatesCoveringRange(stroke.templateSpans, weaving.sStart, weaving.sEnd, length, templates)) {
    validateTemplatePair(weaving, template, diagnostics);
  }
}
function validateTerminal(weaving, junction, station, roadLength, terminal, diagnostics) {
  if (junction.kind !== "direct") {
    addError2(diagnostics, `weaving-${terminal}-junction-kind`, `Weaving section ${weaving.id} ${terminal} junction must be direct`, weaving.id);
  }
  const port = junction.ports.find((candidate) => candidate.roadId === weaving.roadId && Math.abs(portStation(candidate.contactPoint, candidate.s, roadLength) - station) <= STATION_TOLERANCE2);
  if (!port) {
    addError2(diagnostics, `weaving-${terminal}-port-missing`, `Weaving section ${weaving.id} ${terminal} junction has no matching road port`, weaving.id);
  }
  const maneuverId = terminal === "entry" ? weaving.entryManeuverId : weaving.exitManeuverId;
  const maneuver = junction.maneuvers.find((candidate) => candidate.id === maneuverId);
  const validManeuver = maneuver && (terminal === "entry" ? maneuver.toRoadId === weaving.roadId && maneuver.toLaneRole === weaving.weavingLaneRole : maneuver.fromRoadId === weaving.roadId && maneuver.fromLaneRole === weaving.weavingLaneRole);
  if (!validManeuver) {
    addError2(diagnostics, `weaving-${terminal}-movement-missing`, `Weaving section ${weaving.id} ${terminal} does not connect its weaving lane`, weaving.id);
  }
}
function templatesCoveringRange(spans, sStart, sEnd, roadLength, templates) {
  const sorted = [...spans].sort((left, right) => left.s - right.s);
  const ids = new Set;
  for (let index = 0;index < sorted.length; index++) {
    const span = sorted[index];
    const intervalEnd = sorted[index + 1]?.s ?? roadLength;
    if (span.s < sEnd - STATION_TOLERANCE2 && intervalEnd > sStart + STATION_TOLERANCE2)
      ids.add(span.templateId);
    if (span.transitionLength && index > 0 && span.s < sEnd - STATION_TOLERANCE2 && span.s + span.transitionLength > sStart + STATION_TOLERANCE2) {
      ids.add(sorted[index - 1].templateId);
    }
  }
  return [...ids].map((id) => templates.get(id)).filter((template) => Boolean(template));
}
function validateTemplatePair(weaving, template, diagnostics) {
  const through = template.lanes.find((lane) => lane.role === weaving.throughLaneRole);
  const auxiliary = template.lanes.find((lane) => lane.role === weaving.weavingLaneRole);
  if (!through || !auxiliary) {
    addError2(diagnostics, "weaving-lane-role-coverage", `Template ${template.id} does not cover both weaving roles for ${weaving.id}`, weaving.id);
    return;
  }
  if (through.side !== auxiliary.side || Math.abs(auxiliary.order - through.order) !== 1) {
    addError2(diagnostics, "weaving-lanes-not-adjacent", `Template ${template.id} weaving lanes are not adjacent`, weaving.id);
  }
  if (!TRAFFIC_LANE_TYPES.has(through.type) || !TRAFFIC_LANE_TYPES.has(auxiliary.type)) {
    addError2(diagnostics, "weaving-lane-type-invalid", `Template ${template.id} weaving roles must be traffic lanes`, weaving.id);
  }
  if ((through.direction ?? "standard") !== (auxiliary.direction ?? "standard")) {
    addError2(diagnostics, "weaving-lane-direction-mismatch", `Template ${template.id} weaving roles have different directions`, weaving.id);
  }
  if (accessKey(through.access) !== accessKey(auxiliary.access)) {
    addError2(diagnostics, "weaving-lane-access-mismatch", `Template ${template.id} weaving roles have different access`, weaving.id);
  }
  const auxiliaryIsOutside = auxiliary.order > through.order;
  const throughBoundary = auxiliaryIsOutside ? "outer" : "inner";
  const auxiliaryBoundary = auxiliaryIsOutside ? "inner" : "outer";
  const permitsBoth = through.boundaryMarkings?.some((marking) => marking.boundary === throughBoundary && marking.laneChange === "both") || auxiliary.boundaryMarkings?.some((marking) => marking.boundary === auxiliaryBoundary && marking.laneChange === "both");
  if (!permitsBoth) {
    addError2(diagnostics, "weaving-lane-change-policy", `Template ${template.id} does not permit both weaving lane changes`, weaving.id);
  }
}
function portStation(contactPoint, station, roadEnd) {
  return station ?? (contactPoint === "start" ? 0 : roadEnd);
}
function accessKey(access) {
  return [...access ?? []].sort().join("|");
}
function addError2(diagnostics, code, message, sourceId) {
  diagnostics.push({ severity: "error", code, message, sourceId });
}

// ../three-roads-inspect/packages/core/src/authoring-document/road-structure-validation.ts
function validateRoadStructureIntents(document, diagnostics) {
  const ids = new Set;
  for (const structure of document.roadStructures ?? []) {
    if (!structure.id || ids.has(structure.id)) {
      addError3(diagnostics, "duplicate-road-structure-id", `Duplicate road structure id ${structure.id}`, structure.id);
    }
    ids.add(structure.id);
    const road = document.strokes.find((candidate) => candidate.id === structure.roadId);
    if (!road) {
      addError3(diagnostics, "road-structure-road-missing", `Road structure ${structure.id} references missing road ${structure.roadId}`, structure.id);
      continue;
    }
    const length = referenceLineLength({ geometry: road.geometry });
    if (!Number.isFinite(structure.sStart) || !Number.isFinite(structure.sEnd) || structure.sStart < 0 || structure.sEnd > length || structure.sEnd <= structure.sStart) {
      addError3(diagnostics, "road-structure-range-invalid", `Road structure ${structure.id} has an invalid station range`, structure.id);
    }
    if (structure.kind !== "bridge" && structure.kind !== "tunnel") {
      addError3(diagnostics, "road-structure-kind-invalid", `Road structure ${structure.id} has invalid kind ${structure.kind}`, structure.id);
    }
    if (!Number.isFinite(structure.deckTMin) || !Number.isFinite(structure.deckTMax) || structure.deckTMax <= structure.deckTMin) {
      addError3(diagnostics, "road-structure-envelope-invalid", `Road structure ${structure.id} has an invalid lateral envelope`, structure.id);
    }
    if (!Number.isFinite(structure.structuralThickness) || structure.structuralThickness <= 0) {
      addError3(diagnostics, "road-structure-thickness-invalid", `Road structure ${structure.id} needs positive structural thickness`, structure.id);
    }
    if (!Number.isFinite(structure.minimumLateralClearance) || structure.minimumLateralClearance < 0) {
      addError3(diagnostics, "road-structure-clearance-invalid", `Road structure ${structure.id} needs non-negative lateral clearance`, structure.id);
    } else if (Number.isFinite(structure.deckTMin) && Number.isFinite(structure.deckTMax) && 2 * structure.minimumLateralClearance >= structure.deckTMax - structure.deckTMin) {
      addError3(diagnostics, "road-structure-clearance-envelope-empty", `Road structure ${structure.id} clearance consumes its lateral envelope`, structure.id);
    }
  }
}
function addError3(diagnostics, code, message, sourceId) {
  diagnostics.push({ severity: "error", code, message, sourceId });
}

// ../three-roads-inspect/packages/core/src/authoring-document/traffic-management-validation.ts
function validateTrafficManagementIntents(document, diagnostics) {
  const plans = new Map;
  const permanentRegulationIds = new Set;
  for (const regulation of document.regulations ?? []) {
    if (!regulation.id || permanentRegulationIds.has(regulation.id)) {
      addError4(diagnostics, "traffic-regulation-id-duplicate", `Document repeats permanent regulation ${regulation.id}`, regulation.id);
    }
    permanentRegulationIds.add(regulation.id);
    validateRegulation(document, regulation, diagnostics);
  }
  for (const plan of document.trafficManagementPlans ?? []) {
    if (!plan.id || plans.has(plan.id))
      addError4(diagnostics, "traffic-plan-id-duplicate", `Duplicate traffic-management plan ${plan.id}`, plan.id);
    const phaseIds = new Set;
    plans.set(plan.id, phaseIds);
    if (plan.phases.length === 0)
      addError4(diagnostics, "traffic-plan-phases-empty", `Traffic-management plan ${plan.id} needs a phase`, plan.id);
    for (const phase of plan.phases) {
      if (!phase.id || phaseIds.has(phase.id))
        addError4(diagnostics, "traffic-phase-id-duplicate", `Plan ${plan.id} repeats phase ${phase.id}`, plan.id);
      phaseIds.add(phase.id);
      validatePhase(document, plan.id, phase, diagnostics);
    }
  }
  for (const source of activatedSources(document)) {
    validateActivation(source.id, source.activation, plans, diagnostics);
  }
  for (const object of document.objects ?? []) {
    if (!object.regulationIds?.length)
      continue;
    const phase = object.activation ? document.trafficManagementPlans?.find((plan) => plan.id === object.activation.planId)?.phases.find((candidate) => candidate.id === object.activation.phaseId) : undefined;
    const regulationIds = object.activation ? new Set([...phase?.regulations?.map((regulation) => regulation.id) ?? [], ...permanentRegulationIds]) : permanentRegulationIds;
    for (const regulationId of object.regulationIds) {
      if (!regulationIds.has(regulationId))
        addError4(diagnostics, "regulation-object-reference-missing", `Object ${object.id} references missing regulation ${regulationId}`, object.id);
    }
  }
  for (const marking of document.markings ?? []) {
    if (marking.application === "replace-base" && marking.color === "yellow" && !marking.activation) {
      addError4(diagnostics, "replacement-marking-activation-missing", `Temporary yellow replacement marking ${marking.id} needs traffic-phase activation`, marking.id);
    }
  }
}
function validatePhase(document, planId, phase, diagnostics) {
  const operationIds = new Set;
  for (const operation of phase.laneOperations) {
    if (!operation.id || operationIds.has(operation.id))
      addError4(diagnostics, "lane-operation-id-duplicate", `Phase ${phase.id} repeats lane operation ${operation.id}`, operation.id);
    operationIds.add(operation.id);
    validateLaneOperation(document, operation, diagnostics);
  }
  for (let left = 0;left < phase.laneOperations.length; left++) {
    for (let right = left + 1;right < phase.laneOperations.length; right++) {
      const a = phase.laneOperations[left];
      const b = phase.laneOperations[right];
      if (a.roadId === b.roadId && a.laneRole === b.laneRole && rangesOverlap(a.sStart, a.sEnd, b.sStart, b.sEnd)) {
        addError4(diagnostics, "lane-operation-overlap", `Phase ${phase.id} overlaps operations ${a.id}/${b.id}`, planId);
      }
    }
  }
  const regulationIds = new Set;
  for (const regulation of phase.regulations ?? []) {
    if (!regulation.id || regulationIds.has(regulation.id))
      addError4(diagnostics, "traffic-regulation-id-duplicate", `Phase ${phase.id} repeats regulation ${regulation.id}`, regulation.id);
    regulationIds.add(regulation.id);
    validateRegulation(document, regulation, diagnostics);
  }
}
function validateRegulation(document, regulation, diagnostics) {
  const road = document.strokes.find((candidate) => candidate.id === regulation.roadId);
  const length = road ? referenceLineLength({ geometry: road.geometry }) : 0;
  if (!road)
    addError4(diagnostics, "traffic-regulation-road-missing", `Regulation ${regulation.id} references missing road ${regulation.roadId}`, regulation.id);
  if (regulation.sStart < 0 || regulation.sEnd > length || regulation.sEnd <= regulation.sStart) {
    addError4(diagnostics, "traffic-regulation-range-invalid", `Regulation ${regulation.id} has an invalid station range`, regulation.id);
  }
  if (!Number.isFinite(regulation.maximumKph) || regulation.maximumKph <= 0) {
    addError4(diagnostics, "maximum-speed-invalid", `Regulation ${regulation.id} needs a positive speed`, regulation.id);
  }
  if (!Array.isArray(regulation.laneRoles))
    return;
  if (regulation.laneRoles.length === 0)
    addError4(diagnostics, "traffic-regulation-lanes-empty", `Regulation ${regulation.id} needs lane roles`, regulation.id);
  for (const role of regulation.laneRoles) {
    if (road && !roleExistsOverRange(document, road, role, regulation.sStart, regulation.sEnd)) {
      addError4(diagnostics, "traffic-regulation-lane-role-missing", `Regulation ${regulation.id} references missing role ${role}`, regulation.id);
    }
  }
}
function validateLaneOperation(document, operation, diagnostics) {
  const road = document.strokes.find((candidate) => candidate.id === operation.roadId);
  if (!road) {
    addError4(diagnostics, "lane-operation-road-missing", `Lane operation ${operation.id} references missing road ${operation.roadId}`, operation.id);
    return;
  }
  const length = referenceLineLength({ geometry: road.geometry });
  if (operation.sStart < 0 || operation.sEnd > length || operation.sEnd <= operation.sStart) {
    addError4(diagnostics, "lane-operation-range-invalid", `Lane operation ${operation.id} has an invalid station range`, operation.id);
  }
  const boundaries = compiledSectionBoundaries(road, length);
  if (!boundaries.some((station) => nearlyEqual2(station, operation.sStart)) || !boundaries.some((station) => nearlyEqual2(station, operation.sEnd))) {
    addError4(diagnostics, "lane-operation-boundary-unaligned", `Lane operation ${operation.id} must align with lane-section boundaries`, operation.id);
  }
  if (!roleExistsOverRange(document, road, operation.laneRole, operation.sStart, operation.sEnd)) {
    addError4(diagnostics, "lane-operation-role-missing", `Lane operation ${operation.id} references missing role ${operation.laneRole}`, operation.id);
  }
  if (operation.status !== "open" && operation.status !== "closed") {
    addError4(diagnostics, "lane-operation-status-invalid", `Lane operation ${operation.id} has invalid status`, operation.id);
  }
  if (operation.direction && !["standard", "reversed", "both"].includes(operation.direction)) {
    addError4(diagnostics, "lane-operation-direction-invalid", `Lane operation ${operation.id} has invalid direction`, operation.id);
  }
}
function roleExistsOverRange(document, road, role, sStart, sEnd) {
  const templates = new Map(document.templates.map((template) => [template.id, template]));
  const spans = [...road.templateSpans].sort((left, right) => left.s - right.s);
  const stations = new Set([sStart, sEnd, (sStart + sEnd) * 0.5]);
  for (const span of spans) {
    if (span.s > sStart && span.s < sEnd)
      stations.add(span.s);
    const end = span.s + (span.transitionLength ?? 0);
    if (end > sStart && end < sEnd)
      stations.add(end);
  }
  return [...stations].every((station) => {
    const active = spans.map((span, index2) => ({ span, index: index2 })).filter(({ span }) => span.s <= station + 0.0000001).at(-1);
    if (!active)
      return false;
    const index = active.index;
    const current = templates.get(spans[index].templateId);
    const previous = index > 0 ? templates.get(spans[index - 1].templateId) : undefined;
    const inTransition = (spans[index].transitionLength ?? 0) > 0 && station < spans[index].s + (spans[index].transitionLength ?? 0) - 0.0000001;
    return current?.lanes.some((lane) => lane.role === role) || Boolean(inTransition && previous?.lanes.some((lane) => lane.role === role));
  });
}
function compiledSectionBoundaries(road, length) {
  return [...new Set([
    0,
    length,
    ...road.templateSpans.flatMap((span) => [span.s, span.s + (span.transitionLength ?? 0)])
  ].filter((station) => station >= 0 && station <= length))];
}
function activatedSources(document) {
  return [
    ...document.strokes,
    ...document.junctions,
    ...document.junctionGroups ?? [],
    ...document.markings ?? [],
    ...document.objects ?? []
  ];
}
function validateActivation(sourceId, activation, plans, diagnostics) {
  if (!activation)
    return;
  const phases = plans.get(activation.planId);
  if (!phases)
    addError4(diagnostics, "traffic-activation-plan-missing", `Source ${sourceId} references missing plan ${activation.planId}`, sourceId);
  else if (!phases.has(activation.phaseId))
    addError4(diagnostics, "traffic-activation-phase-missing", `Source ${sourceId} references missing phase ${activation.phaseId}`, sourceId);
}
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd - 0.0000001 && bStart < aEnd - 0.0000001;
}
function nearlyEqual2(left, right) {
  return Math.abs(left - right) <= 0.0000001;
}
function addError4(diagnostics, code, message, sourceId) {
  diagnostics.push({ severity: "error", code, message, sourceId });
}

// ../three-roads-inspect/packages/core/src/authoring-document/roadside-feature-validation.ts
function validateRoadsideFeatureIntents(document, diagnostics) {
  const ids = new Set;
  const templates = new Map(document.templates.map((template) => [template.id, template]));
  for (const feature of document.roadsideFeatures ?? []) {
    if (!feature.id || ids.has(feature.id))
      addError5(diagnostics, "duplicate-roadside-feature-id", `Duplicate roadside feature ${feature.id}`, feature.id);
    ids.add(feature.id);
    const stroke = document.strokes.find((candidate) => candidate.id === feature.roadId);
    if (!stroke) {
      addError5(diagnostics, "roadside-feature-road-missing", `Roadside feature ${feature.id} references missing road ${feature.roadId}`, feature.id);
      continue;
    }
    const length = referenceLineLength({ geometry: stroke.geometry });
    if (!Number.isFinite(feature.sStart) || !Number.isFinite(feature.sEnd) || feature.sStart < 0 || feature.sEnd > length || feature.sEnd <= feature.sStart) {
      addError5(diagnostics, "roadside-feature-range-invalid", `Roadside feature ${feature.id} has an invalid station range`, feature.id);
    }
    if (feature.kind === "ditch" && (![feature.gap, feature.depth, feature.bottomWidth, feature.sideSlope].every(Number.isFinite) || feature.gap < 0 || feature.depth <= 0 || feature.bottomWidth <= 0 || feature.sideSlope <= 0)) {
      addError5(diagnostics, "roadside-feature-section-invalid", `Roadside feature ${feature.id} has invalid ditch dimensions`, feature.id);
    }
    if (feature.kind === "retaining-wall" && (![feature.gap, feature.thickness, feature.heightStart, feature.heightEnd].every(Number.isFinite) || feature.gap < 0 || feature.thickness <= 0 || feature.heightStart <= 0 || feature.heightEnd <= 0)) {
      addError5(diagnostics, "roadside-feature-section-invalid", `Roadside feature ${feature.id} has invalid retaining-wall dimensions`, feature.id);
    }
    for (const template of templatesOverRange(stroke.templateSpans, feature.sStart, feature.sEnd, templates)) {
      const lane = template.lanes.find((candidate) => candidate.role === feature.laneRole);
      if (!lane) {
        addError5(diagnostics, "roadside-feature-lane-role-missing", `Roadside feature ${feature.id} is missing lane role ${feature.laneRole} in template ${template.id}`, feature.id);
        continue;
      }
      const outermost = template.lanes.filter((candidate) => candidate.side === lane.side).reduce((maximum, candidate) => Math.max(maximum, candidate.order), 0);
      if (lane.order !== outermost) {
        addError5(diagnostics, "roadside-feature-lane-not-outermost", `Roadside feature ${feature.id} lane role ${feature.laneRole} is not outermost in template ${template.id}`, feature.id);
      }
    }
  }
}
function templatesOverRange(spans, sStart, sEnd, templates) {
  const sorted = [...spans].sort((left, right) => left.s - right.s);
  const ids = new Set;
  for (let index = 0;index < sorted.length; index++) {
    const span = sorted[index];
    const nextS = sorted[index + 1]?.s ?? Number.POSITIVE_INFINITY;
    if (span.s <= sEnd + 0.0000001 && nextS >= sStart - 0.0000001)
      ids.add(span.templateId);
    if ((span.transitionLength ?? 0) > 0 && span.s <= sEnd + 0.0000001 && span.s + (span.transitionLength ?? 0) >= sStart - 0.0000001) {
      const previous = sorted[index - 1];
      if (previous)
        ids.add(previous.templateId);
    }
  }
  return [...ids].map((id) => templates.get(id)).filter((template) => Boolean(template));
}
function addError5(diagnostics, code, message, sourceId) {
  diagnostics.push({ severity: "error", code, message, sourceId });
}

// ../three-roads-inspect/packages/core/src/authoring-document/arrow-maneuver-validation.ts
function validateArrowManeuverIntents(document, diagnostics) {
  const templates = new Map(document.templates.map((template) => [template.id, template]));
  const strokes = new Map(document.strokes.map((stroke) => [stroke.id, stroke]));
  for (const marking of document.markings ?? []) {
    if (marking.kind !== "arrow" || marking.arrow.startsWith("merge-"))
      continue;
    const movements = document.junctions.filter((junction) => junction.kind === "common").flatMap((junction) => junction.maneuvers.filter((maneuver) => maneuver.fromRoadId === marking.roadId && maneuver.fromLaneRole === marking.laneRole).map((maneuver) => ({ junction, maneuver })));
    if (movements.length === 0)
      continue;
    const actual = new Set;
    for (const { junction, maneuver } of movements) {
      const sourcePort = junction.ports.find((port) => port.roadId === maneuver.fromRoadId && (!maneuver.fromPortId || junctionPortId(port) === maneuver.fromPortId));
      const targetPort = junction.ports.find((port) => port.roadId === maneuver.toRoadId && (!maneuver.toPortId || junctionPortId(port) === maneuver.toPortId));
      const sourceStroke = strokes.get(maneuver.fromRoadId);
      const targetStroke = strokes.get(maneuver.toRoadId);
      if (!sourcePort || !targetPort || !sourceStroke || !targetStroke)
        continue;
      const sourceHeading = laneTravelHeading(sourceStroke, portStation2(sourceStroke, sourcePort), maneuver.fromLaneRole, templates);
      const targetHeading = laneTravelHeading(targetStroke, portStation2(targetStroke, targetPort), maneuver.toLaneRole, templates);
      if (sourceHeading === undefined || targetHeading === undefined)
        continue;
      const delta = normalizeAngle(targetHeading - sourceHeading);
      actual.add(Math.abs(delta) < Math.PI / 4 ? "straight" : delta > 0 ? "left" : "right");
    }
    const expected = arrowMovements(marking.arrow);
    if (!setsEqual(actual, expected)) {
      diagnostics.push({
        severity: "error",
        code: "arrow-maneuver-mismatch",
        sourceId: marking.id,
        message: `Arrow ${marking.id} encodes ${[...expected].join("+")} but lane ${marking.laneRole} permits ${[...actual].join("+")}`
      });
    }
  }
}
function laneTravelHeading(stroke, s, role, templates) {
  const lane = laneAt(stroke, s, role, templates);
  if (!lane)
    return;
  const id = lane.side === "left" ? lane.order : -lane.order;
  const standardSign = id < 0 ? 1 : -1;
  const sign = lane.direction === "reversed" ? -standardSign : standardSign;
  const heading = evaluateReferenceLine({ geometry: stroke.geometry }, s).heading;
  return normalizeAngle(heading + (sign < 0 ? Math.PI : 0));
}
function laneAt(stroke, s, role, templates) {
  const span = [...stroke.templateSpans].sort((a, b) => a.s - b.s).filter((candidate) => candidate.s <= s + 0.0000001).at(-1);
  return span ? templates.get(span.templateId)?.lanes.find((lane) => lane.role === role) : undefined;
}
function portStation2(stroke, port) {
  return port.s ?? (port.contactPoint === "start" ? 0 : referenceLineLength({ geometry: stroke.geometry }));
}
function arrowMovements(arrow) {
  if (arrow === "straight-left-right")
    return new Set(["straight", "left", "right"]);
  if (arrow === "straight-left")
    return new Set(["straight", "left"]);
  if (arrow === "straight-right")
    return new Set(["straight", "right"]);
  if (arrow === "left-right")
    return new Set(["left", "right"]);
  return new Set([arrow]);
}
function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

// ../three-roads-inspect/packages/core/src/lanes/transition-lane-ids.ts
function transitionLaneIdAssignments(from, to) {
  const roles = [...new Set([...from.lanes.map(({ role }) => role), ...to.lanes.map(({ role }) => role)])];
  const entries = roles.map((role) => ({
    role,
    fromLane: from.lanes.find((lane) => lane.role === role),
    toLane: to.lanes.find((lane) => lane.role === role)
  }));
  const used = new Set;
  const assignments = new Map;
  for (const entry of entries.filter(({ fromLane, toLane }) => !fromLane || !toLane)) {
    const id = templateLaneId(entry.toLane ?? entry.fromLane);
    if (used.has(id))
      throw new Error(`cannot reserve lane ${id} for ${entry.role}`);
    used.add(id);
    assignments.set(entry.role, id);
  }
  const retained = entries.filter((entry) => entry.fromLane && entry.toLane).sort((left, right) => Math.abs(templateLaneId(left.fromLane)) - Math.abs(templateLaneId(right.fromLane)));
  for (const entry of retained) {
    const id = [templateLaneId(entry.fromLane), templateLaneId(entry.toLane)].find((candidate) => !used.has(candidate));
    if (id === undefined)
      throw new Error(`cannot assign a unique lane to ${entry.role}`);
    used.add(id);
    assignments.set(entry.role, id);
  }
  return entries.map((entry) => ({ ...entry, laneId: assignments.get(entry.role) }));
}
function templateLaneId(lane) {
  return lane.side === "left" ? lane.order : -lane.order;
}

// ../three-roads-inspect/packages/core/src/authoring-document/ordinary-node-validation.ts
function validateOrdinaryNodeIntents(document, diagnostics) {
  const ids = new Set;
  const contactSets = new Set;
  const roadIds = new Set(document.strokes.map(({ id }) => id));
  for (const intent of document.ordinaryNodeIntents ?? []) {
    const canonical = canonicalizeOrdinaryNodeIntent(intent);
    if (ids.has(intent.id))
      add(diagnostics, "duplicate-ordinary-node-intent", `Duplicate ordinary node intent ${intent.id}`, intent.id);
    ids.add(intent.id);
    if (intent.contacts.length < 2)
      add(diagnostics, "ordinary-node-contacts", `Ordinary node intent ${intent.id} needs at least two contacts`, intent.id);
    const contactsKey = canonical.contacts.map(ordinaryNodeContactKey).join("|");
    if (contactSets.has(contactsKey))
      add(diagnostics, "duplicate-ordinary-node-contacts", `Ordinary node intent ${intent.id} duplicates another contact set`, intent.id);
    contactSets.add(contactsKey);
    const contacts = new Set(intent.contacts.map(ordinaryNodeContactKey));
    if (contacts.size !== intent.contacts.length)
      add(diagnostics, "duplicate-ordinary-node-contact", `Ordinary node intent ${intent.id} repeats a contact`, intent.id);
    for (const contact of intent.contacts)
      if (!roadIds.has(contact.roadId))
        add(diagnostics, "ordinary-node-road-missing", `Ordinary node intent ${intent.id} references missing stroke ${contact.roadId}`, intent.id);
    const selectors = new Set;
    for (const selector of intent.prohibitedMovements ?? []) {
      const key = ordinaryNodeMovementKey(selector);
      if (selectors.has(key))
        add(diagnostics, "duplicate-ordinary-node-selector", `Ordinary node intent ${intent.id} repeats prohibited movement ${key}`, intent.id);
      selectors.add(key);
      if (!contacts.has(ordinaryNodeContactKey(selector.from)) || !contacts.has(ordinaryNodeContactKey(selector.to))) {
        add(diagnostics, "ordinary-node-selector-contact", `Ordinary node intent ${intent.id} has a selector outside its contacts`, intent.id);
      }
    }
    const mappingDestinations = new Set;
    for (const selector of intent.movementMappings ?? []) {
      const key = `${ordinaryNodeContactKey(selector.from)}:${selector.from.laneRole}->${ordinaryNodeContactKey(selector.to)}`;
      if (mappingDestinations.has(key))
        add(diagnostics, "duplicate-ordinary-node-mapping", `Ordinary node intent ${intent.id} repeats explicit mapping source/destination ${key}`, intent.id);
      mappingDestinations.add(key);
      if (!contacts.has(ordinaryNodeContactKey(selector.from)) || !contacts.has(ordinaryNodeContactKey(selector.to))) {
        add(diagnostics, "ordinary-node-mapping-contact", `Ordinary node intent ${intent.id} has a lane mapping outside its contacts`, intent.id);
      }
    }
    const participantClasses = new Set;
    for (const participantClass of intent.prohibitedParticipantClasses ?? []) {
      if (!["motor", "bicycle", "tram", "pedestrian"].includes(participantClass)) {
        add(diagnostics, "ordinary-node-participant-class", `Ordinary node intent ${intent.id} has invalid participant class ${participantClass}`, intent.id);
      }
      if (participantClasses.has(participantClass))
        add(diagnostics, "duplicate-ordinary-node-participant-class", `Ordinary node intent ${intent.id} repeats participant class ${participantClass}`, intent.id);
      participantClasses.add(participantClass);
    }
  }
}
function add(diagnostics, code, message, sourceId) {
  diagnostics.push({ severity: "error", code, message, sourceId });
}

// ../three-roads-inspect/packages/core/src/authoring-document/road-surface-elevation-validation.ts
function validateRoadSurfaceElevationIntents(document, diagnostics) {
  const ids = new Set;
  const roads = new Map(document.strokes.map((road) => [road.id, road]));
  for (const elevation of document.roadSurfaceElevations ?? []) {
    if (ids.has(elevation.id)) {
      diagnostics.push(error("duplicate-road-surface-elevation-id", `Duplicate road surface elevation id ${elevation.id}`, elevation.id));
    }
    ids.add(elevation.id);
    const road = roads.get(elevation.roadId);
    if (!road) {
      diagnostics.push(error("road-surface-elevation-road-missing", `Road surface elevation ${elevation.id} references missing road ${elevation.roadId}`, elevation.id));
      continue;
    }
    const roadLength = referenceLineLength({ geometry: road.geometry });
    const stationsAreFinite = Number.isFinite(elevation.sStart) && Number.isFinite(elevation.sEnd);
    if (!stationsAreFinite || elevation.sStart < 0 || elevation.sEnd <= elevation.sStart || elevation.sEnd > roadLength) {
      diagnostics.push(error("road-surface-elevation-range-invalid", `Road surface elevation ${elevation.id} has an invalid range on road ${elevation.roadId}`, elevation.id));
    }
    if (!Number.isFinite(elevation.height) || elevation.height <= 0) {
      diagnostics.push(error("road-surface-elevation-height-invalid", `Road surface elevation ${elevation.id} needs a positive finite height`, elevation.id));
    }
    const span = elevation.sEnd - elevation.sStart;
    if (!Number.isFinite(elevation.rampLength) || elevation.rampLength <= 0 || elevation.rampLength * 2 > span) {
      diagnostics.push(error("road-surface-elevation-ramp-invalid", `Road surface elevation ${elevation.id} needs ramps that fit inside its range`, elevation.id));
    }
  }
}
function error(code, message, sourceId) {
  return { severity: "error", code, message, sourceId };
}

// ../three-roads-inspect/packages/core/src/lanes/lane-continuation-semantics.ts
var PHYSICAL_CONTINUATION_TYPES = new Set([
  "border",
  "sidewalk",
  "shoulder",
  "median"
]);
function isPhysicalLaneContinuationType(type) {
  return PHYSICAL_CONTINUATION_TYPES.has(type);
}

// ../three-roads-inspect/packages/core/src/authoring-document/lane-continuation-flow.ts
function laneContinuationDirection(fromLane, fromContactPoint, toLane, toContactPoint, allowPhysicalMorph = false) {
  if (!isPhysicalLaneContinuationType(fromLane.type) || !isPhysicalLaneContinuationType(toLane.type) || !allowPhysicalMorph && fromLane.type !== toLane.type)
    return;
  const fromDirection = effectiveTemplateLaneDirection(fromLane);
  const toDirection = effectiveTemplateLaneDirection(toLane);
  if (fromDirection === "both" && toDirection === "both")
    return "both";
  if (!allowPhysicalMorph && fromDirection === "both" !== (toDirection === "both"))
    return;
  return laneFlowsIntoContact(fromLane, fromContactPoint) && laneFlowsOutOfContact(toLane, toContactPoint) ? "standard" : undefined;
}
function laneFlowsIntoContact(lane, contactPoint) {
  if (effectiveTemplateLaneDirection(lane) === "both")
    return true;
  const sign = templateLaneTravelSign(lane);
  return contactPoint === "end" ? sign > 0 : sign < 0;
}
function laneFlowsOutOfContact(lane, contactPoint) {
  if (lane.direction === "both")
    return true;
  return !laneFlowsIntoContact(lane, contactPoint);
}
function templateLaneTravelSign(lane) {
  const standard = lane.side === "right" ? 1 : -1;
  return effectiveTemplateLaneDirection(lane) === "reversed" ? standard === 1 ? -1 : 1 : standard;
}
function effectiveTemplateLaneDirection(lane) {
  if (lane.direction)
    return lane.direction;
  return lane.type === "border" || lane.type === "sidewalk" || lane.type === "median" ? "both" : "standard";
}

// ../three-roads-inspect/packages/core/src/authoring-document/streetscape-validation.ts
var EPSILON2 = 0.0000001;
function validateRoadStreetscape(document, diagnostics) {
  const streetscape = document.streetscape;
  if (!streetscape)
    return;
  if (streetscape.version !== 1) {
    addError6(diagnostics, "streetscape-version", `Unsupported streetscape version ${String(streetscape.version)}`);
    return;
  }
  const trackIds = new Set;
  const templates = new Map(document.templates.map((template) => [template.id, template]));
  for (const track of streetscape.tracks) {
    if (!track.id || trackIds.has(track.id)) {
      addError6(diagnostics, "streetscape-track-id", `Duplicate streetscape track ${track.id}`, track.id);
    }
    trackIds.add(track.id);
    const stroke = document.strokes.find(({ id }) => id === track.roadId);
    if (!stroke) {
      addError6(diagnostics, "streetscape-track-road", `Streetscape track ${track.id} references missing road ${track.roadId}`, track.id);
      continue;
    }
    const length = referenceLineLength({ geometry: stroke.geometry });
    if (!finite(track.sStart, track.sEnd) || track.sStart < 0 || track.sEnd > length + EPSILON2 || track.sEnd <= track.sStart) {
      addError6(diagnostics, "streetscape-track-range", `Streetscape track ${track.id} has an invalid station range`, track.id);
    }
    if (!Number.isFinite(track.period) || track.period <= 0) {
      addError6(diagnostics, "streetscape-track-period", `Streetscape track ${track.id} needs a positive period`, track.id);
    }
    if (!Number.isFinite(track.lateralOffset) || !Number.isFinite(track.heightOffset ?? 0)) {
      addError6(diagnostics, "streetscape-track-offset", `Streetscape track ${track.id} has a non-finite offset`, track.id);
    }
    if (!Number.isFinite(track.clearance.footprintRadius) || track.clearance.footprintRadius < 0 || !Number.isFinite(track.clearance.maximumSlide ?? 0) || !Number.isFinite(track.clearance.lateralSlide ?? 0)) {
      addError6(diagnostics, "streetscape-track-clearance", `Streetscape track ${track.id} has an invalid clearance policy`, track.id);
    }
    if (track.events.length === 0) {
      addError6(diagnostics, "streetscape-track-events", `Streetscape track ${track.id} needs at least one pattern event`, track.id);
    }
    const eventIds = new Set;
    for (const event of track.events) {
      if (!event.id || eventIds.has(event.id)) {
        addError6(diagnostics, "streetscape-event-id", `Streetscape track ${track.id} repeats event ${event.id}`, track.id);
      }
      eventIds.add(event.id);
      if (!event.assetSlot.trim() || !Number.isFinite(event.at) || event.at < 0 || event.at >= track.period + EPSILON2) {
        addError6(diagnostics, "streetscape-event-value", `Streetscape track ${track.id} has an invalid pattern event ${event.id}`, track.id);
      }
      if (event.probability !== undefined && (!Number.isFinite(event.probability) || event.probability < 0 || event.probability > 1)) {
        addError6(diagnostics, "streetscape-event-probability", `Streetscape event ${event.id} has an invalid probability`, track.id);
      }
      if (event.scale !== undefined && (!Number.isFinite(event.scale) || event.scale <= 0)) {
        addError6(diagnostics, "streetscape-event-scale", `Streetscape event ${event.id} has an invalid scale`, track.id);
      }
    }
    if (track.rail.kind === "lane-role") {
      const laneRole = track.rail.role;
      for (const template of templatesOverRange2(stroke.templateSpans, track.sStart, track.sEnd, templates)) {
        if (!template.lanes.some(({ role }) => role === laneRole)) {
          addError6(diagnostics, "streetscape-track-lane-role", `Streetscape track ${track.id} lane role ${laneRole} is missing from template ${template.id}`, track.id);
        }
      }
    }
  }
  uniqueOverrideIds(streetscape.instanceOverrides.map(({ instanceId }) => instanceId), "instance", diagnostics);
  uniqueOverrideIds(streetscape.ruleOverrides.map(({ ownerId, rule }) => `${ownerId}|${rule}`), "rule", diagnostics);
}
function templatesOverRange2(spans, sStart, sEnd, templates) {
  const sorted = [...spans].sort((left, right) => left.s - right.s);
  const ids = new Set;
  for (let index = 0;index < sorted.length; index++) {
    const span = sorted[index];
    const next = sorted[index + 1]?.s ?? Number.POSITIVE_INFINITY;
    if (span.s <= sEnd + EPSILON2 && next >= sStart - EPSILON2)
      ids.add(span.templateId);
    if ((span.transitionLength ?? 0) > 0 && span.s + (span.transitionLength ?? 0) >= sStart - EPSILON2) {
      const previous = sorted[index - 1];
      if (previous)
        ids.add(previous.templateId);
    }
  }
  return [...ids].flatMap((id) => {
    const template = templates.get(id);
    return template ? [template] : [];
  });
}
function uniqueOverrideIds(ids, label, diagnostics) {
  const seen = new Set;
  for (const id of ids) {
    if (seen.has(id))
      addError6(diagnostics, `streetscape-${label}-override`, `Duplicate streetscape ${label} override ${id}`);
    seen.add(id);
  }
}
function finite(...values) {
  return values.every(Number.isFinite);
}
function addError6(diagnostics, code, message, sourceId) {
  diagnostics.push({ severity: "error", code, message, ...sourceId ? { sourceId } : {} });
}

// ../three-roads-inspect/packages/core/src/authoring-document/validation.ts
function validateRoadAuthoringDocument(document) {
  const diagnostics = [];
  const templateIds = uniqueIds(document.templates.map((template) => template.id), "template", diagnostics);
  const strokeIds = uniqueIds(document.strokes.map((stroke) => stroke.id), "stroke", diagnostics);
  const junctionIds = uniqueIds(document.junctions.map((junction) => junction.id), "junction", diagnostics);
  uniqueIds(document.junctionGroups?.map((group) => group.id) ?? [], "junction group", diagnostics);
  const strokeLengths = new Map(document.strokes.map((stroke) => [stroke.id, referenceLineLength({ geometry: stroke.geometry })]));
  const strokesById = new Map(document.strokes.map((stroke) => [stroke.id, stroke]));
  const templates = templatesById(document);
  const markingControlIds = new Set(document.junctions.flatMap((junction) => junction.control?.kind === "signal" ? [junction.control.controllerId, ...junction.control.groups.map((group) => group.id)] : []));
  uniqueIds(document.markings?.map((marking) => marking.id) ?? [], "marking", diagnostics);
  uniqueIds([
    ...document.objects?.map((object) => object.id) ?? [],
    ...document.junctions.flatMap((junction) => junction.objects?.map((object) => object.id) ?? [])
  ], "object", diagnostics);
  for (const template of document.templates)
    validateTemplate(template, diagnostics);
  for (const stroke of document.strokes) {
    const length = referenceLineLength({ geometry: stroke.geometry });
    if (stroke.geometry.length === 0 || length <= 0) {
      error2(diagnostics, "empty-stroke-geometry", `Stroke ${stroke.id} needs positive-length geometry`, stroke.id);
    }
    validateTemplateSpans(stroke.id, length, stroke.templateSpans, templateIds, diagnostics);
    validateTransitionLaneIds(stroke.id, stroke.templateSpans, templates, diagnostics);
    validateStrokeLinks(stroke, strokeIds, diagnostics);
    validateStrokeLinkRoleCoverage(stroke, strokesById, templates, diagnostics);
    validateStrokeRouting(stroke, diagnostics);
  }
  for (const junction of document.junctions) {
    if (!junctionIds.has(junction.id))
      continue;
    validateJunction(junction, strokeIds, strokeLengths, strokesById, templates, diagnostics);
  }
  validateJunctionGroups(document, junctionIds, diagnostics);
  validateGradeSeparationIntents(document, diagnostics);
  validateRoadStructureIntents(document, diagnostics);
  validateRoadsideFeatureIntents(document, diagnostics);
  validateRoadSurfaceElevationIntents(document, diagnostics);
  validateWeavingSectionIntents(document, diagnostics);
  validateTrafficManagementIntents(document, diagnostics);
  validateOrdinaryNodeIntents(document, diagnostics);
  validateRoadStreetscape(document, diagnostics);
  for (const marking of document.markings ?? []) {
    const stroke = document.strokes.find((candidate) => candidate.id === marking.roadId);
    if (!stroke || !strokeIds.has(marking.roadId)) {
      error2(diagnostics, "marking-road-missing", `Marking ${marking.id} references missing stroke ${marking.roadId}`, marking.id);
      continue;
    }
    validateMarkingIntent(marking, stroke, templates, diagnostics);
    for (const controlId of "controlIds" in marking ? marking.controlIds ?? [] : []) {
      if (!markingControlIds.has(controlId)) {
        error2(diagnostics, "marking-control-missing", `Marking ${marking.id} references missing control ${controlId}`, marking.id);
      }
    }
  }
  for (const object of document.objects ?? []) {
    const stroke = document.strokes.find((candidate) => candidate.id === object.roadId);
    if (!stroke) {
      error2(diagnostics, "object-road-missing", `Object ${object.id} references missing stroke ${object.roadId}`, object.id);
      continue;
    }
    const length = referenceLineLength({ geometry: stroke.geometry });
    const repeatEnd = object.s + Math.max(0, (object.repeat?.count ?? 1) - 1) * (object.repeat?.spacing ?? 0);
    if (object.s < 0 || repeatEnd > length) {
      error2(diagnostics, "object-station-out-of-range", `Object ${object.id} is outside stroke ${object.roadId}`, object.id);
    }
    const repeatCount = object.repeat?.count ?? 1;
    const repeatSpacing = object.repeat?.spacing ?? 0;
    if (object.inset !== undefined && (!Number.isFinite(object.inset) || object.inset < 0)) {
      error2(diagnostics, "object-lane-inset-invalid", `Object ${object.id} has an invalid lane inset`, object.id);
    }
    if ((object.inset ?? 0) > 0 && (!object.anchor || object.anchor === "center")) {
      error2(diagnostics, "object-lane-inset-anchor", `Object ${object.id} needs an inner or outer anchor for its lane inset`, object.id);
    }
    if (object.allowedLaneTypes && object.allowedLaneTypes.length === 0) {
      error2(diagnostics, "object-allowed-lane-types-empty", `Object ${object.id} needs at least one allowed lane type`, object.id);
    }
    if (object.passableBy && (object.kind !== "bollard" || object.passableBy.length === 0)) {
      error2(diagnostics, "object-barrier-access-invalid", `Object ${object.id} has invalid barrier access semantics`, object.id);
    }
    if (object.structureId) {
      const structure = document.roadStructures?.find((candidate) => candidate.id === object.structureId);
      const objectHalfLength = (object.length ?? 0) * 0.5;
      const objectStart = object.s - objectHalfLength;
      const objectEnd = repeatEnd + objectHalfLength;
      if (!structure) {
        error2(diagnostics, "road-object-structure-missing", `Object ${object.id} references missing road structure ${object.structureId}`, object.id);
      } else if (structure.roadId !== object.roadId) {
        error2(diagnostics, "road-object-structure-road-mismatch", `Object ${object.id} and road structure ${structure.id} belong to different roads`, object.id);
      } else if (objectStart < structure.sStart - 0.0000001 || objectEnd > structure.sEnd + 0.0000001) {
        error2(diagnostics, "road-object-structure-range", `Object ${object.id} extends outside road structure ${structure.id}`, object.id);
      }
    }
    for (let index = 0;index < repeatCount; index++) {
      const station = object.s + index * repeatSpacing;
      if (!roleExistsAtStation(stroke.templateSpans, station, object.laneRole, templates)) {
        error2(diagnostics, "object-lane-role-missing", `Object ${object.id} references lane role ${object.laneRole} that is absent at s=${station}`, object.id);
        break;
      }
      const lane = templateLaneAtStation(stroke.templateSpans, station, object.laneRole, templates);
      if (lane && object.allowedLaneTypes && !object.allowedLaneTypes.includes(lane.type)) {
        error2(diagnostics, "object-lane-type", `Object ${object.id} cannot be placed on ${lane.type} lane ${object.laneRole}`, object.id);
        break;
      }
      if (object.kind === "parking-space" && lane?.type !== "parking") {
        error2(diagnostics, "parking-object-lane-type", `Parking object ${object.id} sits on ${lane?.type ?? "no"} lane at s=${station}`, object.id);
        break;
      }
    }
  }
  validateArrowManeuverIntents(document, diagnostics);
  return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"), diagnostics };
}
function validateStrokeLinkRoleCoverage(stroke, strokesById, templates, diagnostics) {
  const link = stroke.links?.successor;
  const target = link ? strokesById.get(link.roadId) : undefined;
  if (!link || !target)
    return;
  const sourceTemplate = endpointTemplate(stroke, "end", templates);
  const targetTemplate = endpointTemplate(target, link.contactPoint, templates);
  if (!sourceTemplate || !targetTemplate)
    return;
  const sourceRoles = new Set(sourceTemplate.lanes.map((lane) => lane.role));
  const targetRoles = new Set(targetTemplate.lanes.map((lane) => lane.role));
  const missingTarget = [...sourceRoles].filter((role) => !targetRoles.has(role));
  const missingSource = [...targetRoles].filter((role) => !sourceRoles.has(role));
  if (missingTarget.length === 0 && missingSource.length === 0)
    return;
  error2(diagnostics, "stroke-link-role-coverage", `Stroke link ${stroke.id} -> ${target.id} has unmatched roles ${[...missingTarget, ...missingSource].join(", ")}`, stroke.id);
}
function endpointTemplate(stroke, contactPoint, templates) {
  const spans = [...stroke.templateSpans].sort((left, right) => left.s - right.s);
  const span = contactPoint === "start" ? spans[0] : spans.at(-1);
  return span ? templates.get(span.templateId) : undefined;
}
function validateJunctionGroups(document, junctionIds, diagnostics) {
  for (const group of document.junctionGroups ?? []) {
    if (group.junctionIds.length < 2) {
      error2(diagnostics, "junction-group-member-count", `Junction group ${group.id} needs at least two junctions`, group.id);
    }
    const members = new Set;
    for (const junctionId of group.junctionIds) {
      if (members.has(junctionId)) {
        error2(diagnostics, "junction-group-duplicate-member", `Junction group ${group.id} repeats junction ${junctionId}`, group.id);
      } else if (!junctionIds.has(junctionId)) {
        error2(diagnostics, "junction-group-member-missing", `Junction group ${group.id} references missing junction ${junctionId}`, group.id);
      }
      members.add(junctionId);
    }
  }
}
function validateStrokeLinks(stroke, strokeIds, diagnostics) {
  for (const [direction, link] of [
    ["predecessor", stroke.links?.predecessor],
    ["successor", stroke.links?.successor]
  ]) {
    if (!link)
      continue;
    if (link.roadId === stroke.id) {
      error2(diagnostics, "stroke-link-self-reference", `Stroke ${stroke.id} cannot ${direction}-link to itself`, stroke.id);
    } else if (!strokeIds.has(link.roadId)) {
      error2(diagnostics, "stroke-link-road-missing", `Stroke ${stroke.id} ${direction}-links missing stroke ${link.roadId}`, stroke.id);
    }
  }
}
function validateStrokeRouting(stroke, diagnostics) {
  const routing = stroke.routing;
  if (!routing)
    return;
  if (routing.throughTraffic !== "allowed" && routing.throughTraffic !== "destination-only") {
    error2(diagnostics, "road-routing-policy-invalid", `Stroke ${stroke.id} has an invalid through-traffic policy`, stroke.id);
  }
  if (routing.throughTraffic === "destination-only" && !routing.destinationZoneId?.trim()) {
    error2(diagnostics, "road-routing-zone-missing", `Destination-only stroke ${stroke.id} needs a destination zone`, stroke.id);
  }
}
function validateMarkingIntent(marking, stroke, templates, diagnostics) {
  const length = referenceLineLength({ geometry: stroke.geometry });
  const stations = marking.kind === "arrow" ? [marking.s] : [marking.sStart, marking.sEnd];
  if (stations.some((station) => station < 0 || station > length) || marking.kind !== "arrow" && marking.sEnd < marking.sStart) {
    error2(diagnostics, "marking-station-out-of-range", `Marking ${marking.id} is outside or reversed on stroke ${marking.roadId}`, marking.id);
    return;
  }
  const roles = marking.kind === "arrow" || isBoundaryMarking(marking) ? [marking.laneRole] : marking.laneRoles;
  if (roles.length === 0) {
    error2(diagnostics, "marking-lane-roles-empty", `Marking ${marking.id} needs at least one lane role`, marking.id);
    return;
  }
  for (const station of stations) {
    for (const role of roles) {
      if (!roleExistsAtStation(stroke.templateSpans, station, role, templates)) {
        error2(diagnostics, "marking-lane-role-missing", `Marking ${marking.id} references lane role ${role} that is absent at its station`, marking.id);
      }
    }
  }
}
function isBoundaryMarking(marking) {
  return "boundary" in marking;
}
function validateTransitionLaneIds(strokeId, spans, templates, diagnostics) {
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  for (let index = 1;index < sorted.length; index++) {
    const previous = templates.get(sorted[index - 1].templateId);
    const next = templates.get(sorted[index].templateId);
    if (!previous || !next)
      continue;
    const transitionLength = sorted[index].transitionLength ?? 0;
    const minimumTaperLength = Math.max(previous.designLimits?.minimumTaperLength ?? 0, next.designLimits?.minimumTaperLength ?? 0);
    if (templateCrossSectionDiffers(previous, next) && transitionLength + 0.0000001 < minimumTaperLength) {
      error2(diagnostics, "transition-taper-too-short", `Stroke ${strokeId} transition at s=${sorted[index].s} is ${transitionLength}m but requires at least ${minimumTaperLength}m`, strokeId);
    }
    if (transitionLength <= 0)
      continue;
    try {
      transitionLaneIdAssignments(previous, next);
    } catch (cause) {
      error2(diagnostics, "transition-lane-id-collision", `Stroke ${strokeId} transition at s=${sorted[index].s}: ${cause instanceof Error ? cause.message : String(cause)}`, strokeId);
    }
  }
}
function templateCrossSectionDiffers(left, right) {
  if (left.lanes.length !== right.lanes.length)
    return true;
  const laneKey = (lane) => [
    lane.role,
    lane.side,
    lane.order,
    lane.type,
    lane.width,
    lane.direction ?? "standard",
    lane.level ?? false,
    [...lane.access ?? []].sort().join(",")
  ].join("|");
  return [...left.lanes].map(laneKey).sort().join(`
`) !== [...right.lanes].map(laneKey).sort().join(`
`);
}
function roleExistsAtStation(spans, s, role, templates) {
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  let currentIndex = -1;
  for (let index = 0;index < sorted.length; index++) {
    if (sorted[index].s <= s + 0.0000001)
      currentIndex = index;
  }
  if (currentIndex < 0)
    return false;
  const current = sorted[currentIndex];
  const currentTemplate = templates.get(current.templateId);
  if (currentTemplate?.lanes.some((lane) => lane.role === role))
    return true;
  if (currentIndex === 0 || !current.transitionLength || s >= current.s + current.transitionLength - 0.0000001)
    return false;
  const previous = templates.get(sorted[currentIndex - 1].templateId);
  return previous?.lanes.some((lane) => lane.role === role) ?? false;
}
function templateLaneAtStation(spans, s, role, templates) {
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  let currentIndex = -1;
  for (let index = 0;index < sorted.length; index++) {
    if (sorted[index].s <= s + 0.0000001)
      currentIndex = index;
  }
  if (currentIndex < 0)
    return;
  const current = sorted[currentIndex];
  const currentLane = templates.get(current.templateId)?.lanes.find((lane) => lane.role === role);
  if (currentLane)
    return currentLane;
  if (currentIndex === 0 || !current.transitionLength || s >= current.s + current.transitionLength - 0.0000001)
    return;
  return templates.get(sorted[currentIndex - 1].templateId)?.lanes.find((lane) => lane.role === role);
}
function templatesById(document) {
  return new Map(document.templates.map((template) => [template.id, template]));
}
function validateTemplate(template, diagnostics) {
  const roles = new Set;
  for (const lane of template.lanes) {
    if (roles.has(lane.role))
      error2(diagnostics, "duplicate-template-lane-role", `Template ${template.id} repeats lane role ${lane.role}`, template.id);
    roles.add(lane.role);
    if (!Number.isInteger(lane.order) || lane.order < 1) {
      error2(diagnostics, "template-lane-order", `Template ${template.id} lane ${lane.role} needs a positive integer order`, template.id);
    }
    if (!Number.isFinite(lane.width) || lane.width <= 0) {
      error2(diagnostics, "template-lane-width", `Template ${template.id} lane ${lane.role} needs a positive width`, template.id);
    }
    if (lane.priorityParticipants?.length === 0) {
      error2(diagnostics, "template-lane-priority-empty", `Template ${template.id} lane ${lane.role} has an empty priority participant set`, template.id);
    }
    if (new Set(lane.priorityParticipants).size !== (lane.priorityParticipants?.length ?? 0)) {
      error2(diagnostics, "template-lane-priority-duplicate", `Template ${template.id} lane ${lane.role} repeats a priority participant`, template.id);
    }
    for (const participant of lane.priorityParticipants ?? []) {
      if (lane.access && !lane.access.includes(participant)) {
        error2(diagnostics, "template-lane-priority-without-access", `Template ${template.id} lane ${lane.role} gives priority to ${participant} without access`, template.id);
      }
    }
    validateTemplateLaneHeights(template.id, lane, diagnostics);
  }
  for (const side of ["left", "right"]) {
    const sideLanes = template.lanes.filter((lane) => lane.side === side).sort((a, b) => a.order - b.order);
    const orders = sideLanes.map((lane) => lane.order);
    orders.forEach((order, index) => {
      if (order !== index + 1) {
        error2(diagnostics, "non-consecutive-template-lane-order", `Template ${template.id} ${side} lane orders must be consecutive`, template.id);
      }
    });
    let reachedLevelLane = false;
    for (const [index, lane] of sideLanes.entries()) {
      const inner = sideLanes[index - 1];
      if (inner && lanesHaveVerticalSeparation(inner, lane))
        reachedLevelLane = false;
      if (lane.level)
        reachedLevelLane = true;
      else if (reachedLevelLane) {
        error2(diagnostics, "template-lane-level-order", `Template ${template.id} lane ${lane.role} must be level because an inward lane is level`, template.id);
      }
    }
  }
  validateDesignLimits(template, diagnostics);
}
function validateTemplateLaneHeights(templateId, lane, diagnostics) {
  let previousOffset = -Infinity;
  for (const height of lane.heights ?? []) {
    if (!Number.isFinite(height.sOffset) || height.sOffset < 0 || height.sOffset <= previousOffset) {
      error2(diagnostics, "template-lane-height-order", `Template ${templateId} lane ${lane.role} has invalid height station ordering`, templateId);
    }
    if (!Number.isFinite(height.inner) || !Number.isFinite(height.outer)) {
      error2(diagnostics, "template-lane-height-value", `Template ${templateId} lane ${lane.role} has a non-finite height`, templateId);
    }
    previousOffset = height.sOffset;
  }
}
function validateDesignLimits(template, diagnostics) {
  const limits = template.designLimits;
  if (!limits)
    return;
  for (const [name, value] of [
    ["designSpeedKph", limits.designSpeedKph],
    ["minimumHorizontalRadius", limits.minimumHorizontalRadius],
    ["maximumCurvatureRate", limits.maximumCurvatureRate],
    ["minimumSpiralLength", limits.minimumSpiralLength]
  ]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      error2(diagnostics, "template-design-limit", `Template ${template.id} design limit ${name} must be positive`, template.id);
    }
  }
  for (const [name, value] of [
    ["maximumGrade", limits.maximumGrade],
    ["maximumSuperelevation", limits.maximumSuperelevation]
  ]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      error2(diagnostics, "template-design-limit", `Template ${template.id} design limit ${name} must not be negative`, template.id);
    }
  }
  if ((limits.maximumGrade ?? 0) > 0.5) {
    error2(diagnostics, "template-maximum-grade", `Template ${template.id} maximumGrade must be a ratio, not a percentage`, template.id);
  }
  if ((limits.maximumSuperelevation ?? 0) > 0.5) {
    error2(diagnostics, "template-maximum-superelevation", `Template ${template.id} maximumSuperelevation must be in radians`, template.id);
  }
}
function validateTemplateSpans(strokeId, length, spans, templateIds, diagnostics) {
  if (spans.length === 0) {
    error2(diagnostics, "missing-template-span", `Stroke ${strokeId} needs at least one template span`, strokeId);
    return;
  }
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  if (sorted[0].s !== 0)
    error2(diagnostics, "template-span-start", `Stroke ${strokeId} must start with a template span at s=0`, strokeId);
  for (let index = 0;index < sorted.length; index++) {
    const span = sorted[index];
    if (!templateIds.has(span.templateId))
      error2(diagnostics, "template-span-template-missing", `Stroke ${strokeId} references missing template ${span.templateId}`, strokeId);
    if (span.s < 0 || span.s >= length)
      error2(diagnostics, "template-span-out-of-range", `Stroke ${strokeId} span at s=${span.s} is outside its geometry`, strokeId);
    if (index > 0 && span.s <= sorted[index - 1].s)
      error2(diagnostics, "template-span-order", `Stroke ${strokeId} spans must have distinct ordered stations`, strokeId);
    if (span.transitionLength !== undefined) {
      const nextS = sorted[index + 1]?.s ?? length;
      if (span.transitionLength <= 0 || span.s + span.transitionLength >= nextS + 0.0000001) {
        error2(diagnostics, "template-transition-range", `Stroke ${strokeId} transition at s=${span.s} must fit before the next span`, strokeId);
      }
    }
  }
}
function validateJunction(junction, strokeIds, strokeLengths, strokesById, templates, diagnostics) {
  if (junction.profileTransition) {
    if (junction.kind !== "common" || junction.ports.length !== 2) {
      error2(diagnostics, "junction-profile-transition-kind", `Junction ${junction.id} profile transition requires exactly two common-junction ports`, junction.id);
    }
    if (!junction.ports.some((port) => port.roadId === junction.profileTransition?.dominantRoadId)) {
      error2(diagnostics, "junction-profile-transition-road", `Junction ${junction.id} profile transition dominant road must own one of its ports`, junction.id);
    }
  }
  if (junction.connectorGeometryPolicy === "surface-fallback" && junction.kind !== "common") {
    error2(diagnostics, "junction-connector-policy-kind", `Junction ${junction.id} can only use surface-fallback connector geometry when it is common`, junction.id);
  }
  if (junction.surfacePolygon) {
    const polygon = junction.surfacePolygon;
    const finite2 = polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (polygon.length < 3 || !finite2 || Math.abs(signedPolygonArea(polygon)) < 0.000001) {
      error2(diagnostics, "junction-surface-polygon-invalid", `Junction ${junction.id} has an invalid authored surface polygon`, junction.id);
    }
  }
  for (const patch of junction.surfacePatches ?? []) {
    const finite2 = patch.polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!patch.id || patch.polygon.length < 3 || !finite2 || Math.abs(signedPolygonArea(patch.polygon)) < 0.000001) {
      error2(diagnostics, "junction-surface-patch-invalid", `Junction ${junction.id} has an invalid authored surface patch`, junction.id);
    }
  }
  if (junction.surfaceLaneType && !junction.surfacePolygon) {
    error2(diagnostics, "junction-surface-lane-type-without-polygon", `Junction ${junction.id} has a surface lane type without an authored polygon`, junction.id);
  }
  if (junction.surfaceElevation) {
    if (junction.kind !== "common") {
      error2(diagnostics, "junction-surface-elevation-kind", `Junction ${junction.id} raised surface requires a common junction`, junction.id);
    }
    if (!Number.isFinite(junction.surfaceElevation.height) || junction.surfaceElevation.height <= 0 || !Number.isFinite(junction.surfaceElevation.rampLength) || junction.surfaceElevation.rampLength <= 0) {
      error2(diagnostics, "junction-surface-elevation-invalid", `Junction ${junction.id} has an invalid raised-surface profile`, junction.id);
    }
  }
  validateJunctionMarkingPlan(junction, diagnostics);
  validateJunctionAreaMarkings(junction, diagnostics);
  validateJunctionTerminalProtections(junction, diagnostics);
  const maneuverIds = uniqueIds(junction.maneuvers.map((maneuver) => maneuver.id), "junction maneuver", diagnostics);
  const continuationIds = uniqueIds(junction.laneContinuations?.map((continuation) => continuation.id) ?? [], "junction lane continuation", diagnostics);
  for (const continuationId of continuationIds) {
    if (maneuverIds.has(continuationId)) {
      error2(diagnostics, "duplicate-junction-participant-id", `Junction ${junction.id} repeats participant ${continuationId}`, junction.id);
    }
  }
  const portIds = new Set;
  const portsByRoad = new Map;
  for (const port of junction.ports) {
    if (!strokeIds.has(port.roadId))
      error2(diagnostics, "junction-port-road-missing", `Junction ${junction.id} references missing stroke ${port.roadId}`, junction.id);
    const portId = junctionPortId(port);
    if (portIds.has(portId))
      error2(diagnostics, "duplicate-junction-port-id", `Junction ${junction.id} repeats port ${portId}`, junction.id);
    portIds.add(portId);
    const roadPorts = portsByRoad.get(port.roadId) ?? [];
    roadPorts.push(port);
    portsByRoad.set(port.roadId, roadPorts);
    const length = strokeLengths.get(port.roadId);
    if (port.s !== undefined && (length === undefined || !Number.isFinite(port.s) || port.s < 0 || port.s > length)) {
      error2(diagnostics, "junction-port-station-out-of-range", `Junction ${junction.id} port on ${port.roadId} has an invalid station`, junction.id);
    }
  }
  for (const maneuver of junction.maneuvers) {
    const fromPort = resolveManeuverPort(portsByRoad, maneuver.fromRoadId, maneuver.fromPortId);
    const toPort = resolveManeuverPort(portsByRoad, maneuver.toRoadId, maneuver.toPortId);
    if (!fromPort || !toPort) {
      error2(diagnostics, "junction-maneuver-port-missing", `Junction ${junction.id} maneuver ${maneuver.id} references a road outside its ports`, junction.id);
    } else {
      const fromLane = laneAtPort(strokesById.get(maneuver.fromRoadId), fromPort, maneuver.fromLaneRole, templates);
      const toLane = laneAtPort(strokesById.get(maneuver.toRoadId), toPort, maneuver.toLaneRole, templates);
      if (!fromLane || !toLane) {
        error2(diagnostics, "junction-maneuver-lane-role-missing", `Junction ${junction.id} maneuver ${maneuver.id} references a lane role absent at its port`, junction.id);
      }
    }
    if (!maneuver.fromPortId && (portsByRoad.get(maneuver.fromRoadId)?.length ?? 0) > 1) {
      error2(diagnostics, "junction-maneuver-port-ambiguous", `Junction ${junction.id} maneuver ${maneuver.id} needs fromPortId`, junction.id);
    }
    if (!maneuver.toPortId && (portsByRoad.get(maneuver.toRoadId)?.length ?? 0) > 1) {
      error2(diagnostics, "junction-maneuver-port-ambiguous", `Junction ${junction.id} maneuver ${maneuver.id} needs toPortId`, junction.id);
    }
    if (maneuver.fromRoadId === maneuver.toRoadId) {
      error2(diagnostics, "junction-maneuver-self-reference", `Junction ${junction.id} maneuver ${maneuver.id} cannot enter and leave the same road`, junction.id);
    }
    if (maneuver.minimumRadius !== undefined && (!Number.isFinite(maneuver.minimumRadius) || maneuver.minimumRadius <= 0)) {
      error2(diagnostics, "junction-maneuver-minimum-radius", `Junction ${junction.id} maneuver ${maneuver.id} needs a positive minimum radius`, junction.id);
    }
    if (maneuver.conflictEnvelopeWidth !== undefined && (!Number.isFinite(maneuver.conflictEnvelopeWidth) || maneuver.conflictEnvelopeWidth <= 0)) {
      error2(diagnostics, "junction-maneuver-conflict-envelope-width", `Junction ${junction.id} maneuver ${maneuver.id} needs a positive conflict envelope width`, junction.id);
    }
    if (maneuver.connectorGeometry) {
      const label = `Junction ${junction.id} maneuver ${maneuver.id}`;
      for (const issue of validateConnectorGeometry(maneuver.connectorGeometry, label)) {
        error2(diagnostics, issue.code, issue.message, junction.id);
      }
    }
    const connectorMarkingIds = new Set;
    for (const marking of maneuver.connectorLaneMarkings ?? []) {
      if (!marking.id || connectorMarkingIds.has(marking.id)) {
        error2(diagnostics, "connector-lane-marking-id", `Junction ${junction.id} maneuver ${maneuver.id} repeats a connector marking ID`, junction.id);
      }
      connectorMarkingIds.add(marking.id);
      if (marking.width !== undefined && (!Number.isFinite(marking.width) || marking.width <= 0)) {
        error2(diagnostics, "connector-lane-marking-width", `Junction ${junction.id} maneuver ${maneuver.id} has an invalid connector marking width`, junction.id);
      }
    }
  }
  validateConnectorCorridors(junction, maneuverIds, diagnostics);
  validateLaneContinuations(junction, portsByRoad, strokesById, templates, diagnostics);
  const streamIds = validateTrafficStreams(junction, strokesById, templates, diagnostics);
  for (const streamId of streamIds) {
    if (maneuverIds.has(streamId) || continuationIds.has(streamId)) {
      error2(diagnostics, "duplicate-junction-participant-id", `Junction ${junction.id} repeats participant ${streamId}`, junction.id);
    }
  }
  validateMovementInteractions(junction, maneuverIds, diagnostics);
  validateJunctionControl(junction, new Set([...maneuverIds, ...streamIds]), maneuverIds, portIds, diagnostics);
  validateVirtualJunction(junction, portsByRoad, strokeLengths, strokesById, diagnostics);
  for (const roadId of junction.priorityRoadIds ?? []) {
    if (!portsByRoad.has(roadId)) {
      error2(diagnostics, "junction-priority-port-missing", `Junction ${junction.id} gives priority to a road outside its ports`, junction.id);
    }
  }
  for (const object of junction.objects ?? []) {
    if (object.polygon.length < 3 || object.polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      error2(diagnostics, "junction-object-polygon", `Junction ${junction.id} object ${object.id} needs a finite polygon with at least three points`, junction.id);
    }
  }
}
function validateJunctionTerminalProtections(junction, diagnostics) {
  const ids = new Set;
  const roadIds = new Set(junction.ports.map(({ roadId }) => roadId));
  const areaMarkingIds = new Set(junction.areaMarkings?.map(({ id }) => id) ?? []);
  for (const protection of junction.terminalProtections ?? []) {
    if (!protection.id || ids.has(protection.id)) {
      error2(diagnostics, "junction-terminal-protection-id", `Junction ${junction.id} repeats a terminal protection ID`, junction.id);
    }
    ids.add(protection.id);
    if (!roadIds.has(protection.roadId)) {
      error2(diagnostics, "junction-terminal-protection-road", `Junction ${junction.id} terminal protection ${protection.id} references a road outside its ports`, junction.id);
    }
    if (protection.areaMarkingId && !areaMarkingIds.has(protection.areaMarkingId)) {
      error2(diagnostics, "junction-terminal-protection-area", `Junction ${junction.id} terminal protection ${protection.id} references a missing area marking`, junction.id);
    }
  }
}
function validateJunctionAreaMarkings(junction, diagnostics) {
  const ids = new Set;
  for (const marking of junction.areaMarkings ?? []) {
    if (!marking.id || ids.has(marking.id)) {
      error2(diagnostics, "junction-area-marking-id", `Junction ${junction.id} repeats an area marking ID`, junction.id);
    }
    ids.add(marking.id);
    const finite2 = marking.polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (marking.polygon.length < 3 || !finite2 || Math.abs(signedPolygonArea(marking.polygon)) < 0.000001) {
      error2(diagnostics, "junction-area-marking-polygon", `Junction ${junction.id} area marking ${marking.id} has an invalid polygon`, junction.id);
    }
    if (marking.kind !== "solid") {
      const stripeWidth = marking.stripeWidth ?? 0.5;
      const stripeGap = marking.stripeGap ?? 1.5;
      const heading = marking.stripeHeading ?? Math.PI / 4;
      if (![stripeWidth, stripeGap].every((value) => Number.isFinite(value) && value > 0) || !Number.isFinite(heading)) {
        error2(diagnostics, "junction-area-marking-hatch", `Junction ${junction.id} area marking ${marking.id} has invalid hatch parameters`, junction.id);
      }
    }
  }
}
function validateJunctionMarkingPlan(junction, diagnostics) {
  const plan = junction.markingPlan;
  if (!plan)
    return;
  if (plan.rules !== "german") {
    error2(diagnostics, "junction-marking-rules", `Junction ${junction.id} uses unsupported marking rules`, junction.id);
  }
  const validGeneration = new Set(["derive", "explicit-only", "none"]);
  for (const [name, value] of Object.entries({
    controlLines: plan.controlLines,
    laneArrows: plan.laneArrows,
    connectorSeparators: plan.connectorSeparators,
    throughContinuity: plan.throughContinuity,
    priorityStraightContinuity: plan.priorityStraightContinuity,
    dedicatedTurnContinuity: plan.dedicatedTurnContinuity,
    signalTurnContinuity: plan.signalTurnContinuity
  })) {
    if (value !== undefined && !validGeneration.has(value)) {
      error2(diagnostics, "junction-marking-generation", `Junction ${junction.id} has invalid ${name} marking generation`, junction.id);
    }
  }
}
function signedPolygonArea(points) {
  let area = 0;
  for (let index = 0;index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area * 0.5;
}
function validateConnectorCorridors(junction, maneuverIds, diagnostics) {
  const corridors = junction.connectorCorridors ?? [];
  uniqueIds(corridors.map((corridor) => corridor.id), "junction connector corridor", diagnostics);
  const assignedManeuvers = new Set;
  for (const corridor of corridors) {
    if (junction.kind !== "common") {
      error2(diagnostics, "junction-connector-corridor-kind", `Junction ${junction.id} connector corridors require common behavior`, junction.id);
    }
    if (corridor.maneuverIds.length < 2) {
      error2(diagnostics, "junction-connector-corridor-member-count", `Junction ${junction.id} corridor ${corridor.id} needs at least two maneuvers`, junction.id);
    }
    const memberIds = new Set;
    const members = corridor.maneuverIds.flatMap((maneuverId) => {
      if (memberIds.has(maneuverId)) {
        error2(diagnostics, "junction-connector-corridor-duplicate-member", `Junction ${junction.id} corridor ${corridor.id} repeats maneuver ${maneuverId}`, junction.id);
      }
      memberIds.add(maneuverId);
      if (!maneuverIds.has(maneuverId)) {
        error2(diagnostics, "junction-connector-corridor-member-missing", `Junction ${junction.id} corridor ${corridor.id} references missing maneuver ${maneuverId}`, junction.id);
      }
      if (assignedManeuvers.has(maneuverId)) {
        error2(diagnostics, "junction-connector-corridor-member-reused", `Junction ${junction.id} maneuver ${maneuverId} belongs to multiple corridors`, junction.id);
      }
      assignedManeuvers.add(maneuverId);
      const maneuver = junction.maneuvers.find((candidate) => candidate.id === maneuverId);
      return maneuver ? [maneuver] : [];
    });
    const first = members[0];
    for (const member of members.slice(1)) {
      if (!first || member.fromRoadId !== first.fromRoadId || member.toRoadId !== first.toRoadId || (member.fromPortId ?? "") !== (first.fromPortId ?? "") || (member.toPortId ?? "") !== (first.toPortId ?? "")) {
        error2(diagnostics, "junction-connector-corridor-ports", `Junction ${junction.id} corridor ${corridor.id} maneuvers must share both road contacts`, junction.id);
        break;
      }
    }
    if (members.some((maneuver) => maneuver.connectorGeometry !== undefined)) {
      error2(diagnostics, "junction-connector-corridor-geometry-conflict", `Junction ${junction.id} corridor ${corridor.id} owns geometry for all member maneuvers`, junction.id);
    }
    if (corridor.minimumRadius !== undefined && (!Number.isFinite(corridor.minimumRadius) || corridor.minimumRadius <= 0)) {
      error2(diagnostics, "junction-connector-corridor-minimum-radius", `Junction ${junction.id} corridor ${corridor.id} needs a positive minimum radius`, junction.id);
    }
    const label = `Junction ${junction.id} corridor ${corridor.id}`;
    for (const issue of validateConnectorGeometry(corridor.geometry, label)) {
      error2(diagnostics, issue.code, issue.message, junction.id);
    }
  }
}
function validateLaneContinuations(junction, portsByRoad, strokesById, templates, diagnostics) {
  const continuations = junction.laneContinuations ?? [];
  if (continuations.length > 0 && junction.kind !== "common") {
    error2(diagnostics, "junction-lane-continuation-kind", `Junction ${junction.id} lane continuations require common behavior`, junction.id);
  }
  for (const continuation of continuations) {
    const fromPort = resolveManeuverPort(portsByRoad, continuation.fromRoadId, continuation.fromPortId);
    const toPort = resolveManeuverPort(portsByRoad, continuation.toRoadId, continuation.toPortId);
    if (!fromPort || !toPort) {
      error2(diagnostics, "junction-lane-continuation-port-missing", `Junction ${junction.id} continuation ${continuation.id} references a missing port`, junction.id);
      continue;
    }
    if (continuation.fromRoadId === continuation.toRoadId) {
      error2(diagnostics, "junction-lane-continuation-self-reference", `Junction ${junction.id} continuation ${continuation.id} cannot return to one road`, junction.id);
    }
    if (continuation.minimumRadius !== undefined && (!Number.isFinite(continuation.minimumRadius) || continuation.minimumRadius <= 0)) {
      error2(diagnostics, "junction-lane-continuation-minimum-radius", `Junction ${junction.id} continuation ${continuation.id} needs a positive minimum radius`, junction.id);
    }
    const fromLane = laneAtPort(strokesById.get(continuation.fromRoadId), fromPort, continuation.fromLaneRole, templates);
    const toLane = laneAtPort(strokesById.get(continuation.toRoadId), toPort, continuation.toLaneRole, templates);
    if (!fromLane || !toLane) {
      error2(diagnostics, "junction-lane-continuation-role-missing", `Junction ${junction.id} continuation ${continuation.id} references a missing lane role`, junction.id);
      continue;
    }
    if (!laneContinuationDirection(fromLane, fromPort.contactPoint, toLane, toPort.contactPoint, Boolean(junction.profileTransition))) {
      error2(diagnostics, "junction-lane-continuation-direction", `Junction ${junction.id} continuation ${continuation.id} needs compatible source-to-target lane flow`, junction.id);
    }
  }
}
function laneAtPort(stroke, port, laneRole, templates) {
  if (!stroke)
    return;
  const station = port.s ?? (port.contactPoint === "start" ? 0 : referenceLineLength({ geometry: stroke.geometry }));
  return templateLaneAtStation(stroke.templateSpans, station, laneRole, templates);
}
function validateTrafficStreams(junction, strokesById, templates, diagnostics) {
  const streams = junction.trafficStreams ?? [];
  const streamIds = uniqueIds(streams.map((stream) => stream.id), "junction stream", diagnostics);
  if (streams.length > 0 && junction.kind !== "crossing" && junction.kind !== "virtual") {
    error2(diagnostics, "junction-stream-kind", `Junction ${junction.id} may only use traffic streams for crossing or virtual behavior`, junction.id);
  }
  if (junction.kind === "crossing" && streams.length < 2) {
    error2(diagnostics, "crossing-junction-stream-count", `Crossing junction ${junction.id} needs at least two traffic streams`, junction.id);
  }
  for (const stream of streams) {
    const port = junction.ports.find((candidate) => candidate.roadId === stream.roadId && junctionPortId(candidate) === stream.portId);
    const stroke = strokesById.get(stream.roadId);
    if (!port || !stroke) {
      error2(diagnostics, "junction-stream-port-missing", `Junction ${junction.id} stream ${stream.id} references a missing road port`, junction.id);
      continue;
    }
    if (!["through", "entering", "leaving"].includes(stream.movement)) {
      error2(diagnostics, "junction-stream-movement", `Junction ${junction.id} stream ${stream.id} has invalid movement ${stream.movement}`, junction.id);
    }
    if (stream.movement !== "through" && !stream.contactGroupId) {
      error2(diagnostics, "junction-stream-contact-group", `Junction ${junction.id} ${stream.movement} stream ${stream.id} needs a contact group`, junction.id);
    }
    if (stream.contactGroupId !== undefined && stream.contactGroupId.trim().length === 0) {
      error2(diagnostics, "junction-stream-contact-group", `Junction ${junction.id} stream ${stream.id} has an empty contact group`, junction.id);
    }
    const s = port.s ?? (port.contactPoint === "start" ? 0 : referenceLineLength({ geometry: stroke.geometry }));
    if (!roleExistsAtStation(stroke.templateSpans, s, stream.laneRole, templates)) {
      error2(diagnostics, "junction-stream-lane-role-missing", `Junction ${junction.id} stream ${stream.id} references missing lane role ${stream.laneRole}`, junction.id);
    }
    if (stream.conflictEnvelopeWidth !== undefined && (!Number.isFinite(stream.conflictEnvelopeWidth) || stream.conflictEnvelopeWidth <= 0)) {
      error2(diagnostics, "junction-stream-envelope-width", `Junction ${junction.id} stream ${stream.id} needs a positive envelope width`, junction.id);
    }
    if (stream.conflictWindow !== undefined && (!Number.isFinite(stream.conflictWindow) || stream.conflictWindow <= 0)) {
      error2(diagnostics, "junction-stream-window", `Junction ${junction.id} stream ${stream.id} needs a positive conflict window`, junction.id);
    }
  }
  validateTrafficStreamContactGroups(junction.id, streams, diagnostics);
  return streamIds;
}
function validateTrafficStreamContactGroups(junctionId, streams, diagnostics) {
  const streamsByGroup = new Map;
  for (const stream of streams) {
    if (!stream.contactGroupId)
      continue;
    const group = streamsByGroup.get(stream.contactGroupId) ?? [];
    group.push(stream);
    streamsByGroup.set(stream.contactGroupId, group);
  }
  for (const stream of streams) {
    if (stream.movement === "through" || !stream.contactGroupId)
      continue;
    const counterparts = (streamsByGroup.get(stream.contactGroupId) ?? []).filter((candidate) => candidate.id !== stream.id);
    const hasCompatibleCounterpart = counterparts.some((candidate) => candidate.movement === "through" || candidate.movement === stream.movement);
    if (!hasCompatibleCounterpart) {
      error2(diagnostics, "junction-stream-contact-group-incomplete", `Junction ${junctionId} ${stream.movement} stream ${stream.id} has no ${stream.contactGroupId} contact counterpart`, junctionId);
    }
  }
}
function validateMovementInteractions(junction, maneuverIds, diagnostics) {
  const interactions = junction.movementInteractions ?? [];
  if (interactions.length > 0 && junction.kind !== "common") {
    error2(diagnostics, "junction-interactions-kind", `Junction ${junction.id} may only assert movement interactions for common junctions`, junction.id);
  }
  uniqueIds(interactions.flatMap((interaction) => interaction.id ? [interaction.id] : []), "junction interaction", diagnostics);
  const pairKeys = new Set;
  for (const interaction of interactions) {
    const [leftId, rightId] = interaction.maneuverIds;
    if (leftId === rightId) {
      error2(diagnostics, "junction-interaction-self-reference", `Junction ${junction.id} interaction repeats maneuver ${leftId}`, junction.id);
    }
    if (!maneuverIds.has(leftId) || !maneuverIds.has(rightId)) {
      error2(diagnostics, "junction-interaction-maneuver-missing", `Junction ${junction.id} interaction references a missing maneuver`, junction.id);
      continue;
    }
    const pairKey = [leftId, rightId].sort().join("\x00");
    if (pairKeys.has(pairKey)) {
      error2(diagnostics, "duplicate-junction-interaction-pair", `Junction ${junction.id} repeats interaction pair ${leftId}/${rightId}`, junction.id);
    }
    pairKeys.add(pairKey);
    if (interaction.priorityManeuverId && !interaction.maneuverIds.includes(interaction.priorityManeuverId)) {
      error2(diagnostics, "junction-interaction-priority-member", `Junction ${junction.id} interaction priority must name one of its maneuvers`, junction.id);
    }
    if (interaction.priorityManeuverId && (interaction.kind === "compatible" || interaction.kind === "diverge")) {
      error2(diagnostics, "junction-interaction-priority-kind", `Junction ${junction.id} cannot assign priority to a ${interaction.kind} interaction`, junction.id);
    }
    if (interaction.priorityManeuverId && ["signal", "all-way-stop", "zipper"].includes(junction.control?.kind ?? "")) {
      error2(diagnostics, "junction-interaction-control-conflict", `Junction ${junction.id} fixed pair priority conflicts with its ${junction.control?.kind} control`, junction.id);
    }
    const left = junction.maneuvers.find((maneuver) => maneuver.id === leftId);
    const right = junction.maneuvers.find((maneuver) => maneuver.id === rightId);
    if (interaction.kind === "merge" && !sameTargetLane(left, right)) {
      error2(diagnostics, "junction-interaction-merge-target", `Junction ${junction.id} merge interaction must share a target lane`, junction.id);
    }
    if (interaction.kind === "diverge" && !sameSourceLane(left, right)) {
      error2(diagnostics, "junction-interaction-diverge-source", `Junction ${junction.id} diverge interaction must share a source lane`, junction.id);
    }
  }
}
function validateJunctionControl(junction, participantIds, maneuverIds, portIds, diagnostics) {
  const control = junction.control;
  if (!control)
    return;
  if (junction.kind === "direct") {
    error2(diagnostics, "junction-control-kind", `Direct junction ${junction.id} cannot use a traffic control plan`, junction.id);
  }
  if ((junction.priorityRoadIds?.length ?? 0) > 0) {
    error2(diagnostics, "junction-control-legacy-priority-conflict", `Junction ${junction.id} cannot combine a control plan with priorityRoadIds`, junction.id);
  }
  if (control.kind === "priority") {
    const priorityPortIds = new Set(control.priorityPortIds);
    if (priorityPortIds.size !== control.priorityPortIds.length) {
      error2(diagnostics, "junction-control-priority-port-duplicate", `Junction ${junction.id} repeats a priority port`, junction.id);
    }
    if (priorityPortIds.size === 0 || priorityPortIds.size >= portIds.size) {
      error2(diagnostics, "junction-control-priority-port-count", `Junction ${junction.id} needs at least one priority and one minor port`, junction.id);
    }
    for (const portId of priorityPortIds) {
      if (!portIds.has(portId)) {
        error2(diagnostics, "junction-control-priority-port-missing", `Junction ${junction.id} control references missing port ${portId}`, junction.id);
      }
    }
    return;
  }
  if (control.kind === "roundabout") {
    if (junction.kind !== "common") {
      error2(diagnostics, "junction-control-roundabout-kind", `Junction ${junction.id} roundabout control requires common-junction maneuvers`, junction.id);
    }
    const circulating = new Set(control.circulatingManeuverIds);
    if (circulating.size === 0 || circulating.size !== control.circulatingManeuverIds.length) {
      error2(diagnostics, "junction-control-circulation-count", `Junction ${junction.id} needs distinct circulating maneuvers`, junction.id);
    }
    for (const maneuverId of circulating) {
      if (!maneuverIds.has(maneuverId)) {
        error2(diagnostics, "junction-control-circulation-missing", `Junction ${junction.id} control references missing maneuver ${maneuverId}`, junction.id);
      }
    }
    return;
  }
  if (control.kind === "signal") {
    validateSignalControl(junction.id, control, participantIds, diagnostics);
    return;
  }
  if (control.kind === "zipper") {
    if (junction.kind !== "common") {
      error2(diagnostics, "junction-control-zipper-kind", `Junction ${junction.id} zipper control requires common-junction merges`, junction.id);
    }
    const maneuvers = junction.maneuvers;
    const hasMerge = maneuvers.some((left, leftIndex) => maneuvers.slice(leftIndex + 1).some((right) => sameTargetLane(left, right)));
    if (!hasMerge) {
      error2(diagnostics, "junction-control-zipper-without-merge", `Junction ${junction.id} zipper control has no shared target lane`, junction.id);
    }
  }
}
function validateSignalControl(junctionId, control, participantIds, diagnostics) {
  if (!control.controllerId) {
    error2(diagnostics, "junction-signal-controller-id", `Junction ${junctionId} signal control needs a controller ID`, junctionId);
  }
  const groupIds = uniqueIds(control.groups.map((group) => group.id), "signal group", diagnostics);
  const assignments = new Map;
  for (const group of control.groups) {
    if (new Set(group.participantIds).size !== group.participantIds.length || group.participantIds.length === 0) {
      error2(diagnostics, "junction-signal-group-participants", `Signal group ${group.id} needs distinct participants`, junctionId);
    }
    for (const maneuverId of group.participantIds) {
      if (!participantIds.has(maneuverId)) {
        error2(diagnostics, "junction-signal-group-participant-missing", `Signal group ${group.id} references missing participant ${maneuverId}`, junctionId);
      }
      assignments.set(maneuverId, (assignments.get(maneuverId) ?? 0) + 1);
    }
  }
  for (const maneuverId of participantIds) {
    if (assignments.get(maneuverId) !== 1) {
      error2(diagnostics, "junction-signal-participant-assignment", `Junction ${junctionId} must assign participant ${maneuverId} to exactly one signal group`, junctionId);
    }
  }
  uniqueIds(control.phases.map((phase) => phase.id), "signal phase", diagnostics);
  const greenCounts = new Map;
  for (const phase of control.phases) {
    if (new Set(phase.greenGroupIds).size !== phase.greenGroupIds.length || phase.greenGroupIds.length === 0) {
      error2(diagnostics, "junction-signal-phase-groups", `Signal phase ${phase.id} needs distinct green groups`, junctionId);
    }
    for (const groupId of phase.greenGroupIds) {
      if (!groupIds.has(groupId)) {
        error2(diagnostics, "junction-signal-phase-group-missing", `Signal phase ${phase.id} references missing group ${groupId}`, junctionId);
      }
      greenCounts.set(groupId, (greenCounts.get(groupId) ?? 0) + 1);
    }
  }
  for (const groupId of groupIds) {
    if (!greenCounts.has(groupId)) {
      error2(diagnostics, "junction-signal-group-never-green", `Signal group ${groupId} is never released by a phase`, junctionId);
    }
  }
}
function sameSourceLane(left, right) {
  return left.fromRoadId === right.fromRoadId && (left.fromPortId ?? "") === (right.fromPortId ?? "") && left.fromLaneRole === right.fromLaneRole;
}
function sameTargetLane(left, right) {
  return left.toRoadId === right.toRoadId && (left.toPortId ?? "") === (right.toPortId ?? "") && left.toLaneRole === right.toLaneRole;
}
function validateVirtualJunction(junction, portsByRoad, strokeLengths, strokesById, diagnostics) {
  const range = junction.virtualRange;
  if (junction.kind !== "virtual") {
    if (range)
      error2(diagnostics, "non-virtual-junction-range", `Junction ${junction.id} has a virtual range but is ${junction.kind}`, junction.id);
    return;
  }
  if (!range) {
    error2(diagnostics, "virtual-junction-range-missing", `Virtual junction ${junction.id} needs a main-road range`, junction.id);
    return;
  }
  const mainLength = strokeLengths.get(range.mainRoadId);
  if (!portsByRoad.has(range.mainRoadId)) {
    error2(diagnostics, "virtual-junction-main-road-port-missing", `Virtual junction ${junction.id} main road is not a port`, junction.id);
  }
  if (mainLength === undefined || !Number.isFinite(range.sStart) || !Number.isFinite(range.sEnd) || range.sStart < 0 || range.sEnd > (mainLength ?? -1) || range.sEnd <= range.sStart) {
    error2(diagnostics, "virtual-junction-range-invalid", `Virtual junction ${junction.id} has an invalid main-road range`, junction.id);
  }
  for (const maneuver of junction.maneuvers) {
    if (maneuver.fromRoadId !== range.mainRoadId && maneuver.toRoadId !== range.mainRoadId) {
      error2(diagnostics, "virtual-junction-non-main-branch", `Virtual junction ${junction.id} movement ${maneuver.id} does not branch from its main road`, junction.id);
      continue;
    }
    const mainPort = maneuver.fromRoadId === range.mainRoadId ? resolveManeuverPort(portsByRoad, maneuver.fromRoadId, maneuver.fromPortId) : resolveManeuverPort(portsByRoad, maneuver.toRoadId, maneuver.toPortId);
    if (mainPort?.s === undefined || Math.abs(mainPort.s - range.sStart) > 0.0000001 && Math.abs(mainPort.s - range.sEnd) > 0.0000001) {
      error2(diagnostics, "virtual-junction-contact-station", `Virtual junction ${junction.id} movement ${maneuver.id} must meet sStart or sEnd`, junction.id);
    }
  }
  const participating = [...portsByRoad.keys()].map((roadId) => strokesById.get(roadId)).filter((stroke) => Boolean(stroke));
  const elevations = participating.map(constantStrokeElevation);
  if (elevations.some((elevation) => elevation === undefined) || elevations.some((elevation) => Math.abs((elevation ?? 0) - (elevations[0] ?? 0)) > 0.000001)) {
    error2(diagnostics, "virtual-junction-not-flat", `Virtual junction ${junction.id} requires one constant elevation`, junction.id);
  }
}
function constantStrokeElevation(stroke) {
  if ((stroke.superelevation ?? []).some((record) => Math.abs(record.a) > 0.000000001 || Math.abs(record.b) > 0.000000001 || Math.abs(record.c) > 0.000000001 || Math.abs(record.d) > 0.000000001))
    return;
  const elevation = stroke.elevation ?? [];
  if (elevation.some((record) => Math.abs(record.b) > 0.000000001 || Math.abs(record.c) > 0.000000001 || Math.abs(record.d) > 0.000000001))
    return;
  const values = elevation.map((record) => record.a);
  if (values.some((value) => Math.abs(value - (values[0] ?? 0)) > 0.000000001))
    return;
  return values[0] ?? 0;
}
function resolveManeuverPort(portsByRoad, roadId, portId) {
  const ports = portsByRoad.get(roadId) ?? [];
  return portId ? ports.find((port) => junctionPortId(port) === portId) : ports.length === 1 ? ports[0] : undefined;
}
function uniqueIds(ids, kind, diagnostics) {
  const result = new Set;
  for (const id of ids) {
    if (result.has(id))
      error2(diagnostics, `duplicate-${kind}-id`, `Duplicate ${kind} id ${id}`, id);
    result.add(id);
  }
  return result;
}
function error2(diagnostics, code, message, sourceId) {
  diagnostics.push({ severity: "error", code, message, sourceId });
}
// ../three-roads-inspect/packages/core/src/geometry/elevation.ts
function elevationAt(elevation, s) {
  const record = activeElevationRecord(elevation, s);
  if (!record)
    return 0;
  return evaluateCubic(record, s - record.s);
}
function gradeAt(elevation, s) {
  const record = activeElevationRecord(elevation, s);
  if (!record)
    return 0;
  return evaluateCubicDerivative(record, s - record.s);
}
function roadElevationAt(road, s) {
  return elevationAt(road.elevation, Math.max(0, Math.min(road.length, s)));
}
function superelevationAt(superelevation, s) {
  const record = activeElevationRecord(superelevation, s);
  if (!record)
    return 0;
  return evaluateCubic(record, s - record.s);
}
function roadSuperelevationAt(road, s) {
  return superelevationAt(road.superelevation, Math.max(0, Math.min(road.length, s)));
}
function activeElevationRecord(elevation, s) {
  if (!elevation || elevation.length === 0)
    return;
  let active;
  for (const record of elevation) {
    if (record.s <= s + 0.0000001 && (!active || record.s > active.s))
      active = record;
  }
  return active ?? elevation.reduce((first, record) => record.s < first.s ? record : first);
}

// ../three-roads-inspect/packages/core/src/geometry/vector-3.ts
function add3(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function scale3(vector, scale) {
  return { x: vector.x * scale, y: vector.y * scale, z: vector.z * scale };
}
function dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}
function length3(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}
function normalize3(vector) {
  const length = length3(vector);
  if (length <= 0.000000000001)
    throw new Error("Cannot normalize a zero-length 3D vector");
  return scale3(vector, 1 / length);
}
function rotateAroundAxis(vector, axis, angle) {
  const unitAxis = normalize3(axis);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return add3(add3(scale3(vector, cos), scale3(cross3(unitAxis, vector), sin)), scale3(unitAxis, dot3(unitAxis, vector) * (1 - cos)));
}

// ../three-roads-inspect/packages/core/src/geometry/road-frame.ts
function laneOffsetAt(road, s) {
  const record = activeRecord(road.laneOffsets, s);
  return record ? evaluateCubic(record, s - record.s) : 0;
}
function crossfallAt(road, s, t) {
  let record;
  for (const candidate of road.crossfall ?? []) {
    if (candidate.s > s + 0.0000001 || candidate.side !== "both" && candidate.side !== (t >= 0 ? "left" : "right"))
      continue;
    if (!record || candidate.s > record.s)
      record = candidate;
  }
  return record ? evaluateCubic(record, s - record.s) : 0;
}
function roadShapeHeightAt(road, s, t) {
  if (!road.shapes || road.shapes.length === 0)
    return 0;
  const stations = [...new Set(road.shapes.map((record) => record.s))].sort((a, b) => a - b);
  if (stations.length === 0)
    return 0;
  const beforeS = stations.filter((station) => station <= s + 0.0000001).at(-1) ?? stations[0];
  const afterS = stations.find((station) => station >= s - 0.0000001) ?? stations.at(-1);
  const before = shapeAtStation(road.shapes ?? [], beforeS, t);
  if (Math.abs(afterS - beforeS) <= 0.000000001)
    return before;
  const after = shapeAtStation(road.shapes ?? [], afterS, t);
  const ratio = (s - beforeS) / (afterS - beforeS);
  return before + (after - before) * ratio;
}
function evaluateRoadFrame(road, s) {
  const clampedS = Math.max(0, Math.min(road.length, s));
  const planPose = evaluateRoadReference(road, clampedS);
  const grade = gradeAt(road.elevation, clampedS);
  const tangent = normalize3({ x: Math.cos(planPose.heading), y: Math.sin(planPose.heading), z: grade });
  const unbankedLateral = normalize3({ x: -Math.sin(planPose.heading), y: Math.cos(planPose.heading), z: 0 });
  const unbankedNormal = normalize3(cross3(tangent, unbankedLateral));
  const roll = roadSuperelevationAt(road, clampedS);
  const lateral = normalize3(rotateAroundAxis(unbankedLateral, tangent, roll));
  const normal = normalize3(rotateAroundAxis(unbankedNormal, tangent, roll));
  return {
    s: clampedS,
    origin: { x: planPose.x, y: planPose.y, z: roadElevationAt(road, clampedS) },
    tangent,
    lateral,
    normal,
    heading: planPose.heading,
    curvature: planPose.curvature,
    grade,
    roll
  };
}
function roadToWorld(road, s, t, h = 0) {
  const frame = evaluateRoadFrame(road, s);
  const laneT = t + laneOffsetAt(road, frame.s);
  const localRoll = crossfallAt(road, frame.s, laneT);
  const lateral = localRoll === 0 ? frame.lateral : rotateAroundAxis(frame.lateral, frame.tangent, localRoll);
  const normal = localRoll === 0 ? frame.normal : rotateAroundAxis(frame.normal, frame.tangent, localRoll);
  const shapeHeight = roadShapeHeightAt(road, frame.s, laneT);
  return add3(frame.origin, add3(scale3(lateral, laneT), scale3(normal, h + shapeHeight)));
}
function activeRecord(records, s) {
  let active;
  for (const record of records ?? []) {
    if (record.s <= s + 0.0000001 && (!active || record.s > active.s))
      active = record;
  }
  return active;
}
function shapeAtStation(records, s, t) {
  const record = records.filter((candidate) => Math.abs(candidate.s - s) <= 0.0000001).sort((a, b) => a.t - b.t).filter((candidate) => candidate.t <= t + 0.0000001).at(-1);
  return record ? evaluateCubic(record, t - record.t) : 0;
}

// ../three-roads-inspect/packages/core/src/geometry/adaptive-sampling.ts
function sampleAdaptivePolyline(startS, endS, evaluate, options) {
  const start = { s: startS, point: evaluate(startS) };
  const end = { s: endS, point: evaluate(endS) };
  const output = [start];
  subdivide(start, end, evaluate, options, 0, output);
  return output;
}
function subdivide(start, end, evaluate, options, depth, output) {
  const interval = end.s - start.s;
  const maxDepth = options.maxDepth ?? 24;
  const maxChordError = options.maxChordError ?? 0.01;
  const quarterS = start.s + interval * 0.25;
  const midS = start.s + interval * 0.5;
  const threeQuarterS = start.s + interval * 0.75;
  const quarter = { s: quarterS, point: evaluate(quarterS) };
  const mid = { s: midS, point: evaluate(midS) };
  const threeQuarter = { s: threeQuarterS, point: evaluate(threeQuarterS) };
  const chordError = Math.max(pointToSegmentDistance2(quarter.point, start.point, end.point), pointToSegmentDistance2(mid.point, start.point, end.point), pointToSegmentDistance2(threeQuarter.point, start.point, end.point));
  if (depth < maxDepth && interval > 0.000001 && (interval > options.maxSegmentLength || chordError > maxChordError)) {
    subdivide(start, mid, evaluate, options, depth + 1, output);
    subdivide(mid, end, evaluate, options, depth + 1, output);
    return;
  }
  output.push(end);
}
function pointToSegmentDistance2(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (denominator <= 0.000000000000000001)
    return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator));
  return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
}

// ../three-roads-inspect/packages/core/src/lanes/lane-cross-section.ts
function laneWidthAt(lane, sectionLocalS) {
  return Math.max(0, laneWidthUnclampedAt(lane, sectionLocalS));
}
function laneWidthUnclampedAt(lane, sectionLocalS) {
  if (lane.id === 0 || lane.widths.length === 0)
    return 0;
  const width = [...lane.widths].sort((left, right) => left.sOffset - right.sOffset).filter((candidate) => candidate.sOffset <= sectionLocalS).at(-1);
  return width ? evaluateCubic(width, sectionLocalS - width.sOffset) : 0;
}
function laneBorderAt(lane, sectionLocalS) {
  const border = [...lane.borders ?? []].sort((left, right) => left.sOffset - right.sOffset).filter((candidate) => candidate.sOffset <= sectionLocalS).at(-1);
  return border ? evaluateCubic(border, sectionLocalS - border.sOffset) : undefined;
}
function laneHeightAt(lane, sectionLocalS) {
  const heights = [...lane.heights ?? []].sort((left, right) => left.sOffset - right.sOffset);
  const active = heights.filter((candidate) => candidate.sOffset <= sectionLocalS + 0.0000001).at(-1);
  if (!active)
    return { inner: 0, outer: 0 };
  const index = heights.indexOf(active);
  const next = heights[index + 1];
  if (!next || next.sOffset <= active.sOffset + 0.000000001)
    return { inner: active.inner, outer: active.outer };
  const ratio = Math.max(0, Math.min(1, (sectionLocalS - active.sOffset) / (next.sOffset - active.sOffset)));
  return {
    inner: active.inner + (next.inner - active.inner) * ratio,
    outer: active.outer + (next.outer - active.outer) * ratio
  };
}
function laneOffsetsAt(section, laneId, sectionLocalS) {
  if (laneId === 0)
    return { inner: 0, outer: 0 };
  const sign = Math.sign(laneId);
  return {
    inner: laneBoundaryOffsetAt(section, sign * (Math.abs(laneId) - 1), sectionLocalS),
    outer: laneBoundaryOffsetAt(section, laneId, sectionLocalS)
  };
}
function laneBoundaryOffsetAt(section, boundaryOrdinal, sectionLocalS) {
  if (boundaryOrdinal === 0)
    return 0;
  const lanes = new Map(section.lanes.map((lane) => [lane.id, lane]));
  const sign = Math.sign(boundaryOrdinal);
  let offset = 0;
  for (let order = 1;order <= Math.abs(boundaryOrdinal); order++) {
    const lane = lanes.get(sign * order);
    if (!lane)
      continue;
    const border = laneBorderAt(lane, sectionLocalS);
    offset = border === undefined ? offset + sign * laneWidthAt(lane, sectionLocalS) : sign * Math.max(0, border);
  }
  return offset;
}
function laneCenterOffsetAt(section, laneId, sectionLocalS) {
  const offsets = laneOffsetsAt(section, laneId, sectionLocalS);
  return (offsets.inner + offsets.outer) * 0.5;
}

// ../three-roads-inspect/packages/core/src/lanes/lane-surface.ts
function laneSurfacePointAt(road, section, lane, s, t, height = 0) {
  if (!lane.level)
    return addVerticalHeight(roadToWorld(road, s, t), height);
  const sectionLocalS = s - section.s;
  const anchorT = levelSideAnchorOffset(section, lane.id, sectionLocalS);
  const anchor = roadToWorld(road, s, anchorT);
  const pose = evaluateRoadReference(road, s);
  const lateralX = -Math.sin(pose.heading);
  const lateralY = Math.cos(pose.heading);
  const distance2 = t - anchorT;
  return {
    x: anchor.x + lateralX * distance2,
    y: anchor.y + lateralY * distance2,
    z: anchor.z + height
  };
}
function laneBoundarySurfacePointAt(road, section, boundaryOrdinal, s, height = 0) {
  if (boundaryOrdinal === 0)
    return addVerticalHeight(roadToWorld(road, s, 0), height);
  const lane = section.lanes.find((candidate) => candidate.id === boundaryOrdinal);
  if (!lane)
    throw new Error(`Section ${section.id} has no lane at boundary ${boundaryOrdinal}`);
  const t = laneBoundaryOffsetAt(section, boundaryOrdinal, s - section.s);
  return laneSurfacePointAt(road, section, lane, s, t, height);
}
function levelSideAnchorOffset(section, laneId, sectionLocalS) {
  const sign = Math.sign(laneId);
  const firstLevelOrder = section.lanes.filter((candidate) => Math.sign(candidate.id) === sign && candidate.level).map((candidate) => Math.abs(candidate.id)).sort((left, right) => left - right)[0];
  if (firstLevelOrder === undefined)
    return 0;
  const anchorOrdinal = sign * (firstLevelOrder - 1);
  return laneBoundaryOffsetAt(section, anchorOrdinal, sectionLocalS);
}
function addVerticalHeight(point, height) {
  return height === 0 ? point : { ...point, z: point.z + height };
}

// ../three-roads-inspect/packages/core/src/lanes/lane-geometry.ts
function findLaneSection(road, s) {
  const section = [...road.laneSections].sort((a, b) => a.s - b.s).filter((candidate) => candidate.s <= s + 0.0000001).at(-1);
  if (!section)
    throw new Error(`Road ${road.id} has no lane section at s=${s}`);
  return section;
}
function laneSectionEndS(road, section) {
  const sorted = [...road.laneSections].sort((a, b) => a.s - b.s);
  const index = sorted.findIndex((candidate) => candidate.id === section.id);
  const next = sorted[index + 1];
  return next ? next.s : road.length;
}
function sampleLaneBoundaries(road, step = 2) {
  const boundaries = [];
  for (const section of road.laneSections) {
    const endS = laneSectionEndS(road, section);
    for (const lane of section.lanes) {
      if (lane.id === 0)
        continue;
      boundaries.push({
        roadId: road.id,
        sectionId: section.id,
        laneId: lane.id,
        side: "inner",
        points: sampleLaneBoundary(road, section, lane.id, "inner", section.s, endS, step)
      });
      boundaries.push({
        roadId: road.id,
        sectionId: section.id,
        laneId: lane.id,
        side: "outer",
        points: sampleLaneBoundary(road, section, lane.id, "outer", section.s, endS, step)
      });
    }
  }
  return boundaries;
}
function sampleLaneCenterlines(road, step = 2) {
  const centerlines = [];
  for (const section of road.laneSections) {
    const endS = laneSectionEndS(road, section);
    for (const lane of section.lanes) {
      if (lane.id === 0)
        continue;
      centerlines.push({
        roadId: road.id,
        sectionId: section.id,
        laneId: lane.id,
        points: sampleLaneCenterline(road, section, lane.id, section.s, endS, step)
      });
    }
  }
  return centerlines;
}
function sampleLaneCenterline(road, section, laneId, startS = section.s, endS = laneSectionEndS(road, section), step = 2) {
  return sampleLaneOffsetLine(road, section, laneId, "center", startS, endS, step);
}
function sampleLanePolygons(road, step = 2) {
  const polygons = [];
  for (const section of road.laneSections) {
    const endS = laneSectionEndS(road, section);
    for (const lane of section.lanes) {
      if (lane.id === 0)
        continue;
      polygons.push({
        roadId: road.id,
        sectionId: section.id,
        laneId: lane.id,
        laneType: lane.type,
        points: sampleLanePolygon(road, section, lane.id, section.s, endS, step)
      });
    }
  }
  return polygons;
}
function sampleLanePolygon(road, section, laneId, startS = section.s, endS = laneSectionEndS(road, section), step = 2) {
  const inner = sampleLaneBoundary(road, section, laneId, "inner", startS, endS, step);
  const outer = sampleLaneBoundary(road, section, laneId, "outer", startS, endS, step);
  return [...inner, ...outer.reverse()];
}
function sampleLaneOccupancyPolygon(road, section, laneId, width, startS = section.s, endS = laneSectionEndS(road, section), step = 1) {
  if (!Number.isFinite(width) || width <= 0)
    throw new Error("Lane occupancy width must be positive");
  const halfWidth = width * 0.5;
  const positive = sampleAdaptivePolyline(startS, endS, (s) => {
    const offsets = laneOffsetsAt(section, laneId, s - section.s);
    const center = (offsets.inner + offsets.outer) * 0.5;
    return point2(laneSurfacePointAt(road, section, requiredLane(section, laneId), s, center + halfWidth));
  }, { maxSegmentLength: step, maxChordError: 0.01 }).map((sample) => sample.point);
  const negative = sampleAdaptivePolyline(startS, endS, (s) => {
    const offsets = laneOffsetsAt(section, laneId, s - section.s);
    const center = (offsets.inner + offsets.outer) * 0.5;
    return point2(laneSurfacePointAt(road, section, requiredLane(section, laneId), s, center - halfWidth));
  }, { maxSegmentLength: step, maxChordError: 0.01 }).map((sample) => sample.point);
  return [...positive, ...negative.reverse()];
}
function sampleLaneBoundary(road, section, laneId, side, startS = section.s, endS = laneSectionEndS(road, section), step = 2) {
  const boundaryOrdinal = side === "outer" ? laneId : Math.sign(laneId) * (Math.abs(laneId) - 1);
  return sampleLaneSectionBoundary(road, section, boundaryOrdinal, startS, endS, step);
}
function sampleLaneSectionBoundary(road, section, boundaryOrdinal, startS = section.s, endS = laneSectionEndS(road, section), step = 2) {
  return sampleAdaptivePolyline(startS, endS, (s) => point2(laneBoundarySurfacePointAt(road, section, boundaryOrdinal, s)), { maxSegmentLength: step, maxChordError: 0.01 }).map((sample) => sample.point);
}
function sampleRoadEnvelope(road, step = 2) {
  const left = [];
  const right = [];
  for (const section of road.laneSections) {
    const endS = laneSectionEndS(road, section);
    const positiveOuterLane = section.lanes.filter((lane) => lane.id > 0).sort((a, b) => b.id - a.id)[0];
    const negativeOuterLane = section.lanes.filter((lane) => lane.id < 0).sort((a, b) => a.id - b.id)[0];
    const center = sampleCenterBoundary(road, section.s, endS, step);
    if (positiveOuterLane) {
      const points = sampleLaneBoundary(road, section, positiveOuterLane.id, "outer", section.s, endS, step);
      left.push(...left.length > 0 ? points.slice(1) : points);
    } else if (negativeOuterLane) {
      left.push(...left.length > 0 ? center.slice(1) : center);
    }
    if (negativeOuterLane) {
      const points = sampleLaneBoundary(road, section, negativeOuterLane.id, "outer", section.s, endS, step);
      right.push(...right.length > 0 ? points.slice(1) : points);
    } else if (positiveOuterLane) {
      right.push(...right.length > 0 ? center.slice(1) : center);
    }
  }
  return {
    roadId: road.id,
    points: left.length > 0 && right.length > 0 ? [...left, ...right.reverse()] : [...left, ...right]
  };
}
function sampleCenterBoundary(road, startS, endS, step) {
  return sampleAdaptivePolyline(startS, endS, (s) => point2(roadToWorld(road, s, 0)), { maxSegmentLength: step, maxChordError: 0.01 }).map((sample) => sample.point);
}
function sampleLaneOffsetLine(road, section, laneId, side, startS, endS, step) {
  return sampleAdaptivePolyline(startS, endS, (s) => {
    const offsets = laneOffsetsAt(section, laneId, s - section.s);
    const t = side === "inner" ? offsets.inner : side === "outer" ? offsets.outer : (offsets.inner + offsets.outer) * 0.5;
    return point2(laneSurfacePointAt(road, section, requiredLane(section, laneId), s, t));
  }, { maxSegmentLength: step, maxChordError: 0.01 }).map((sample) => sample.point);
}
function point2(point) {
  return { x: point.x, y: point.y };
}
function requiredLane(section, laneId) {
  const lane = section.lanes.find((candidate) => candidate.id === laneId);
  if (!lane)
    throw new Error(`Section ${section.id} has no lane ${laneId}`);
  return lane;
}

// ../three-roads-inspect/packages/core/src/geometry/reference-line-slice.ts
var EPSILON3 = 0.000000001;
function sliceReferenceLine(referenceLine, startS, endS) {
  const totalLength = referenceLineLength(referenceLine);
  const start = Math.max(0, Math.min(totalLength, startS));
  const end = Math.max(start, Math.min(totalLength, endS));
  let outputS = 0;
  const geometry = [];
  for (const segment of referenceLine.geometry) {
    const overlapStart = Math.max(start, segment.s);
    const overlapEnd = Math.min(end, segment.s + segment.length);
    if (overlapEnd - overlapStart <= EPSILON3)
      continue;
    const sliced = sliceGeometrySegment(segment, overlapStart - segment.s, overlapEnd - segment.s, outputS);
    geometry.push(sliced);
    outputS += sliced.length;
  }
  return { geometry };
}
function sliceGeometrySegment(segment, localStart, localEnd, outputS) {
  const startPose = evaluateGeometrySegment(segment, localStart);
  const length = localEnd - localStart;
  const base = {
    s: outputS,
    x: startPose.x,
    y: startPose.y,
    heading: startPose.heading,
    length
  };
  if (segment.kind === "line")
    return { ...base, kind: "line" };
  if (segment.kind === "arc")
    return { ...base, kind: "arc", curvature: segment.curvature };
  if (segment.kind === "spiral") {
    return {
      ...base,
      kind: "spiral",
      curvatureStart: spiralCurvatureAt(segment, localStart),
      curvatureEnd: spiralCurvatureAt(segment, localEnd)
    };
  }
  return sliceParamPoly3(segment, localStart, localEnd, outputS);
}
function spiralCurvatureAt(segment, localS) {
  const ratio = segment.length <= EPSILON3 ? 0 : localS / segment.length;
  return segment.curvatureStart + (segment.curvatureEnd - segment.curvatureStart) * ratio;
}
function sliceParamPoly3(segment, localStart, localEnd, outputS) {
  const startPose = evaluateGeometrySegment(segment, localStart);
  const pStart = segment.pRange === "normalized" ? localStart / segment.length : localStart;
  const pEnd = segment.pRange === "normalized" ? localEnd / segment.length : localEnd;
  const pSpan = pEnd - pStart;
  const shiftedU = normalizedSlicePolynomial(segment.u, pStart, pSpan);
  const shiftedV = normalizedSlicePolynomial(segment.v, pStart, pSpan);
  const angle = segment.heading - startPose.heading;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    kind: "param-poly3",
    s: outputS,
    x: startPose.x,
    y: startPose.y,
    heading: startPose.heading,
    length: localEnd - localStart,
    pRange: "normalized",
    u: combinePolynomials(shiftedU, shiftedV, cos, -sin),
    v: combinePolynomials(shiftedU, shiftedV, sin, cos)
  };
}
function normalizedSlicePolynomial(poly, pStart, pSpan) {
  const shifted = shiftCubic(poly, pStart);
  return {
    a: 0,
    b: shifted.b * pSpan,
    c: shifted.c * pSpan * pSpan,
    d: shifted.d * pSpan * pSpan * pSpan
  };
}
function combinePolynomials(a, b, aScale, bScale) {
  return {
    a: a.a * aScale + b.a * bScale,
    b: a.b * aScale + b.b * bScale,
    c: a.c * aScale + b.c * bScale,
    d: a.d * aScale + b.d * bScale
  };
}

// ../three-roads-inspect/packages/core/src/geometry/connector-curve.ts
var EPSILON4 = 0.000000001;
function solveConnectorCurve(start, end, options = {}) {
  const chordLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (chordLength <= EPSILON4)
    throw new Error("Connector endpoints must not coincide");
  const straight = solveAlignedConnector(start, end, chordLength);
  if (straight)
    return straight;
  const sampleCount = options.sampleCount ?? 96;
  const maxHandleRatio = options.maxHandleRatio ?? 1.5;
  const minRadius = options.minRadius ?? Math.max(4, chordLength * 0.12);
  const curvatureTolerance = options.curvatureTolerance ?? 0.002;
  const fastSearch = options.searchMode === "fast";
  const ratios = (fastSearch ? [0.18, 0.36, 0.68, 1.15] : [0.08, 0.12, 0.18, 0.26, 0.36, 0.5, 0.68, 0.9, 1.15, 1.4]).filter((ratio) => ratio <= maxHandleRatio);
  let best;
  candidateSearch:
    for (const startRatio of ratios) {
      for (const endRatio of ratios) {
        const candidate = evaluateCandidate(start, end, chordLength * startRatio, chordLength * endRatio, minRadius, sampleCount, curvatureTolerance);
        if (candidate.admissible && (!best || candidate.score < best.score)) {
          best = candidate;
          if (fastSearch)
            break candidateSearch;
        }
      }
    }
  if (!best) {
    if (fastSearch) {
      return solveConnectorCurve(start, end, {
        ...options,
        searchMode: "thorough"
      });
    }
    throw new Error(`No simple connector satisfies minimum radius ${minRadius.toFixed(3)} m`);
  }
  let startHandle = Math.hypot(best.p1.x - best.p0.x, best.p1.y - best.p0.y);
  let endHandle = Math.hypot(best.p3.x - best.p2.x, best.p3.y - best.p2.y);
  for (const scale of fastSearch ? [0.12] : [0.18, 0.08, 0.035]) {
    const candidates = [];
    for (const startDelta of [-scale, 0, scale]) {
      for (const endDelta of [-scale, 0, scale]) {
        candidates.push(evaluateCandidate(start, end, clampHandle(startHandle * (1 + startDelta), chordLength, maxHandleRatio), clampHandle(endHandle * (1 + endDelta), chordLength, maxHandleRatio), minRadius, sampleCount, curvatureTolerance));
      }
    }
    const admissible = candidates.filter((candidate) => candidate.admissible);
    if (admissible.length === 0)
      continue;
    admissible.sort((a, b) => a.score - b.score);
    best = admissible[0];
    startHandle = Math.hypot(best.p1.x - best.p0.x, best.p1.y - best.p0.y);
    endHandle = Math.hypot(best.p3.x - best.p2.x, best.p3.y - best.p2.y);
  }
  return {
    segment: bezierToParamPoly3(best, start.heading),
    length: best.length,
    maxAbsCurvature: best.maxAbsCurvature,
    startCurvature: best.startCurvature,
    endCurvature: best.endCurvature
  };
}
function solveAlignedConnector(start, end, chordLength) {
  if (Math.abs(normalizeAngle(end.heading - start.heading)) > 0.000000001 || Math.abs(start.curvature ?? 0) > 0.000000001 || Math.abs(end.curvature ?? 0) > 0.000000001)
    return;
  const tangent = { x: Math.cos(start.heading), y: Math.sin(start.heading) };
  const chord = { x: end.x - start.x, y: end.y - start.y };
  const longitudinal = chord.x * tangent.x + chord.y * tangent.y;
  const lateral = -chord.x * tangent.y + chord.y * tangent.x;
  if (longitudinal <= EPSILON4 || Math.abs(lateral) > Math.max(1, chordLength) * 0.000000001) {
    return;
  }
  return {
    segment: {
      kind: "param-poly3",
      s: 0,
      x: start.x,
      y: start.y,
      heading: start.heading,
      length: longitudinal,
      pRange: "normalized",
      u: { a: 0, b: longitudinal, c: 0, d: 0 },
      v: { a: 0, b: 0, c: 0, d: 0 }
    },
    length: longitudinal,
    maxAbsCurvature: 0,
    startCurvature: 0,
    endCurvature: 0
  };
}
function evaluateCandidate(start, end, startHandle, endHandle, minRadius, sampleCount, curvatureTolerance) {
  const startTangent = { x: Math.cos(start.heading), y: Math.sin(start.heading) };
  const endTangent = { x: Math.cos(end.heading), y: Math.sin(end.heading) };
  const candidate = {
    p0: { x: start.x, y: start.y },
    p1: { x: start.x + startTangent.x * startHandle, y: start.y + startTangent.y * startHandle },
    p2: { x: end.x - endTangent.x * endHandle, y: end.y - endTangent.y * endHandle },
    p3: { x: end.x, y: end.y },
    score: 0,
    length: 0,
    maxAbsCurvature: 0,
    startCurvature: 0,
    endCurvature: 0,
    admissible: false
  };
  const points = [];
  const curvatures = [];
  let length = 0;
  let backwardsPenalty = 0;
  let minimumSpeed = Number.POSITIVE_INFINITY;
  let previous = bezierPoint(candidate, 0);
  points.push(previous);
  for (let index = 0;index <= sampleCount; index++) {
    const p = index / sampleCount;
    const point = bezierPoint(candidate, p);
    const derivative = bezierDerivative(candidate, p);
    const curvature = bezierCurvature(candidate, p);
    curvatures.push(curvature);
    if (index > 0) {
      length += Math.hypot(point.x - previous.x, point.y - previous.y);
      points.push(point);
    }
    const speed = Math.hypot(derivative.x, derivative.y);
    minimumSpeed = Math.min(minimumSpeed, speed);
    if (speed <= 0.00001)
      backwardsPenalty += 1000;
    previous = point;
  }
  candidate.length = length;
  candidate.startCurvature = curvatures[0];
  candidate.endCurvature = curvatures.at(-1) ?? 0;
  candidate.maxAbsCurvature = Math.max(...curvatures.map(Math.abs));
  const targetStart = start.curvature ?? candidate.startCurvature;
  const targetEnd = end.curvature ?? candidate.endCurvature;
  const scale = Math.max(1, length);
  const endpointPenalty = (square(candidate.startCurvature - targetStart) + square(candidate.endCurvature - targetEnd)) * scale * scale * 8;
  const curvatureLimit = 1 / minRadius;
  const radiusPenalty = square(Math.max(0, candidate.maxAbsCurvature - curvatureLimit)) * scale * scale * 500;
  let variationPenalty = 0;
  for (let index = 1;index < curvatures.length; index++) {
    variationPenalty += square(curvatures[index] - curvatures[index - 1]) * scale;
  }
  const selfIntersects = polylineSelfIntersects(points);
  const selfIntersectionPenalty = selfIntersects ? 1e6 : 0;
  const headingPenalty = Math.abs(normalizeAngle(start.heading - end.heading)) > Math.PI * 0.98 ? Math.max(0, minRadius * Math.PI - length) * 10 : 0;
  candidate.score = endpointPenalty + radiusPenalty + variationPenalty + backwardsPenalty + selfIntersectionPenalty + headingPenalty;
  candidate.admissible = Number.isFinite(candidate.maxAbsCurvature) && minimumSpeed > 0.00001 && !selfIntersects && candidate.maxAbsCurvature <= curvatureLimit + curvatureTolerance;
  return candidate;
}
function bezierToParamPoly3(candidate, heading) {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const local = [candidate.p0, candidate.p1, candidate.p2, candidate.p3].map((point) => {
    const dx = point.x - candidate.p0.x;
    const dy = point.y - candidate.p0.y;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  });
  return {
    kind: "param-poly3",
    s: 0,
    x: candidate.p0.x,
    y: candidate.p0.y,
    heading,
    length: candidate.length,
    pRange: "normalized",
    u: bezierPowerPolynomial(local.map((point) => point.x)),
    v: bezierPowerPolynomial(local.map((point) => point.y))
  };
}
function bezierPowerPolynomial(values) {
  const [p0, p1, p2, p3] = values;
  return {
    a: p0,
    b: 3 * (p1 - p0),
    c: 3 * (p2 - 2 * p1 + p0),
    d: p3 - 3 * p2 + 3 * p1 - p0
  };
}
function bezierPoint(candidate, p) {
  const q = 1 - p;
  return {
    x: q * q * q * candidate.p0.x + 3 * q * q * p * candidate.p1.x + 3 * q * p * p * candidate.p2.x + p * p * p * candidate.p3.x,
    y: q * q * q * candidate.p0.y + 3 * q * q * p * candidate.p1.y + 3 * q * p * p * candidate.p2.y + p * p * p * candidate.p3.y
  };
}
function bezierDerivative(candidate, p) {
  const q = 1 - p;
  return {
    x: 3 * q * q * (candidate.p1.x - candidate.p0.x) + 6 * q * p * (candidate.p2.x - candidate.p1.x) + 3 * p * p * (candidate.p3.x - candidate.p2.x),
    y: 3 * q * q * (candidate.p1.y - candidate.p0.y) + 6 * q * p * (candidate.p2.y - candidate.p1.y) + 3 * p * p * (candidate.p3.y - candidate.p2.y)
  };
}
function bezierSecondDerivative(candidate, p) {
  return {
    x: 6 * (1 - p) * (candidate.p2.x - 2 * candidate.p1.x + candidate.p0.x) + 6 * p * (candidate.p3.x - 2 * candidate.p2.x + candidate.p1.x),
    y: 6 * (1 - p) * (candidate.p2.y - 2 * candidate.p1.y + candidate.p0.y) + 6 * p * (candidate.p3.y - 2 * candidate.p2.y + candidate.p1.y)
  };
}
function bezierCurvature(candidate, p) {
  const derivative = bezierDerivative(candidate, p);
  const second = bezierSecondDerivative(candidate, p);
  const speedSquared = derivative.x * derivative.x + derivative.y * derivative.y;
  if (speedSquared <= 0.00000000000001)
    return Number.POSITIVE_INFINITY;
  return (derivative.x * second.y - derivative.y * second.x) / Math.pow(speedSquared, 1.5);
}
function polylineSelfIntersects(points) {
  for (let a = 0;a < points.length - 1; a++) {
    for (let b = a + 2;b < points.length - 1; b++) {
      if (a === 0 && b === points.length - 2)
        continue;
      if (segmentsIntersect2(points[a], points[a + 1], points[b], points[b + 1]))
        return true;
    }
  }
  return false;
}
function segmentsIntersect2(a, b, c, d) {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y))
    return false;
  const denominator = cross2(b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y);
  if (Math.abs(denominator) <= 0.000000000001)
    return false;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const t = cross2(acx, acy, d.x - c.x, d.y - c.y) / denominator;
  const u = cross2(acx, acy, b.x - a.x, b.y - a.y) / denominator;
  return t > 0.0000001 && t < 1 - 0.0000001 && u > 0.0000001 && u < 1 - 0.0000001;
}
function cross2(ax, ay, bx, by) {
  return ax * by - ay * bx;
}
function clampHandle(value, chordLength, maxRatio) {
  return Math.max(chordLength * 0.05, Math.min(chordLength * maxRatio, value));
}
function square(value) {
  return value * value;
}

// ../three-roads-inspect/packages/core/src/geometry/circular-connector.ts
function solveCircularConnector(start, end, minimumRadius = 0, tolerance = 0.000000001) {
  const startNormal = { x: -Math.sin(start.heading), y: Math.cos(start.heading) };
  const endNormal = { x: -Math.sin(end.heading), y: Math.cos(end.heading) };
  const normalDelta = {
    x: startNormal.x - endNormal.x,
    y: startNormal.y - endNormal.y
  };
  const denominator = normalDelta.x * normalDelta.x + normalDelta.y * normalDelta.y;
  if (denominator <= 0.0000000001)
    return;
  const chord = { x: end.x - start.x, y: end.y - start.y };
  const signedRadius = (chord.x * normalDelta.x + chord.y * normalDelta.y) / denominator;
  const residual = Math.hypot(chord.x - normalDelta.x * signedRadius, chord.y - normalDelta.y * signedRadius);
  const scale = Math.max(1, Math.hypot(chord.x, chord.y));
  if (residual > tolerance * scale || Math.abs(signedRadius) < minimumRadius)
    return;
  const sweep = normalizeAngle(end.heading - start.heading);
  const length = sweep * signedRadius;
  if (Math.abs(sweep) <= 0.000001 || length <= 0.000001)
    return;
  return {
    radius: Math.abs(signedRadius),
    segment: {
      kind: "arc",
      s: 0,
      x: start.x,
      y: start.y,
      heading: start.heading,
      length,
      curvature: 1 / signedRadius
    }
  };
}

// ../three-roads-inspect/packages/core/src/geometry/parallel-g2-connector.ts
var EPSILON5 = 0.00000001;
function solveParallelG2Connector(start, end, options = {}) {
  const headingTolerance = options.headingTolerance ?? 0.00001;
  const curvatureTolerance = options.curvatureTolerance ?? 0.00001;
  const headingDelta = normalizedAngle(end.heading - start.heading);
  if (Math.abs(headingDelta) > headingTolerance) {
    throw new Error("Parallel G2 connector requires matching endpoint headings");
  }
  if (Math.abs(start.curvature ?? 0) > curvatureTolerance || Math.abs(end.curvature ?? 0) > curvatureTolerance) {
    throw new Error("Parallel G2 connector currently requires zero endpoint curvature");
  }
  const cos = Math.cos(start.heading);
  const sin = Math.sin(start.heading);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const longitudinal = dx * cos + dy * sin;
  const lateral = -dx * sin + dy * cos;
  if (longitudinal <= EPSILON5)
    throw new Error("Parallel G2 connector endpoint must lie ahead of its start");
  const interval = longitudinal / 3;
  const jerk = lateral / (6 * interval * interval * interval);
  const pieces = splinePieces(interval, jerk);
  const geometry = [];
  let station = 0;
  let maxAbsCurvature = 0;
  for (let index = 0;index < pieces.length; index++) {
    const piece = pieces[index];
    const xStart = index * interval;
    const yStart = piece.a;
    const slopeStart = piece.b;
    const localHeading = Math.atan(slopeStart);
    const segmentHeading = start.heading + localHeading;
    const segmentLength = integrateArcLength(piece, interval);
    const segment = polynomialPieceToSegment(station, worldPoint(start, cos, sin, xStart, yStart), segmentHeading, localHeading, interval, piece, segmentLength);
    geometry.push(segment);
    station += segmentLength;
    maxAbsCurvature = Math.max(maxAbsCurvature, sampledMaxCurvature(segment));
  }
  const minRadius = options.minRadius;
  if (minRadius && maxAbsCurvature > 1 / minRadius + 0.0000001) {
    throw new Error(`Parallel G2 connector violates minimum radius ${minRadius.toFixed(3)} m`);
  }
  return { geometry, length: station, maxAbsCurvature };
}
function splinePieces(interval, jerk) {
  const h = interval;
  const first = { a: 0, b: 0, c: 0, d: jerk };
  const second = {
    a: jerk * h ** 3,
    b: 3 * jerk * h ** 2,
    c: 3 * jerk * h,
    d: -2 * jerk
  };
  const third = {
    a: 5 * jerk * h ** 3,
    b: 3 * jerk * h ** 2,
    c: -3 * jerk * h,
    d: jerk
  };
  return [first, second, third];
}
function polynomialPieceToSegment(s, start, heading, localHeading, interval, piece, length) {
  const cos = Math.cos(localHeading);
  const sin = Math.sin(localHeading);
  const dx = { a: 0, b: interval, c: 0, d: 0 };
  const dy = {
    a: 0,
    b: piece.b * interval,
    c: piece.c * interval * interval,
    d: piece.d * interval * interval * interval
  };
  return {
    kind: "param-poly3",
    s,
    x: start.x,
    y: start.y,
    heading,
    length,
    pRange: "normalized",
    u: combine(dx, dy, cos, sin),
    v: combine(dx, dy, -sin, cos)
  };
}
function combine(a, b, aScale, bScale) {
  return {
    a: a.a * aScale + b.a * bScale,
    b: a.b * aScale + b.b * bScale,
    c: a.c * aScale + b.c * bScale,
    d: a.d * aScale + b.d * bScale
  };
}
function integrateArcLength(piece, interval) {
  const steps = 64;
  let sum = 0;
  for (let index = 0;index <= steps; index++) {
    const x = interval * index / steps;
    const slope = piece.b + 2 * piece.c * x + 3 * piece.d * x * x;
    const weight = index === 0 || index === steps ? 1 : index % 2 === 0 ? 2 : 4;
    sum += weight * Math.sqrt(1 + slope * slope);
  }
  return sum * interval / (steps * 3);
}
function sampledMaxCurvature(segment) {
  let maximum = 0;
  for (let index = 0;index <= 64; index++) {
    const pose = evaluateReferenceLine({ geometry: [segment] }, segment.length * index / 64);
    maximum = Math.max(maximum, Math.abs(pose.curvature));
  }
  return maximum;
}
function worldPoint(start, cos, sin, longitudinal, lateral) {
  return {
    x: start.x + longitudinal * cos - lateral * sin,
    y: start.y + longitudinal * sin + lateral * cos
  };
}
function normalizedAngle(angle) {
  let result = angle;
  while (result <= -Math.PI)
    result += Math.PI * 2;
  while (result > Math.PI)
    result -= Math.PI * 2;
  return result;
}

// ../three-roads-inspect/packages/core/src/lanes/lane-contact.ts
function laneContactGeometry(road, section, lane, s) {
  return laneContactGeometryAlong(road, section, lane, s, laneTravelSign(lane));
}
function laneContactGeometryAlong(road, section, lane, s, travelSign) {
  if (travelSign !== 1 && travelSign !== -1)
    throw new Error("Lane contact travel sign must be -1 or 1");
  const localS = s - section.s;
  const offsets = laneOffsetsAt(section, lane.id, localS);
  const heights = laneHeightAt(lane, localS);
  const inner = laneSurfacePointAt(road, section, lane, s, offsets.inner, heights.inner);
  const outer = laneSurfacePointAt(road, section, lane, s, offsets.outer, heights.outer);
  const pose = evaluateRoadReference(road, s);
  const heading = pose.heading + (travelSign < 0 ? Math.PI : 0);
  const leftNormal2 = { x: -Math.sin(heading), y: Math.cos(heading) };
  const center = { x: (inner.x + outer.x) * 0.5, y: (inner.y + outer.y) * 0.5 };
  const innerProjection = (inner.x - center.x) * leftNormal2.x + (inner.y - center.y) * leftNormal2.y;
  const left = innerProjection >= 0 ? inner : outer;
  const right = innerProjection >= 0 ? outer : inner;
  const projectedLeftOffset = (left.x - pose.x) * leftNormal2.x + (left.y - pose.y) * leftNormal2.y;
  const denominator = 1 - pose.curvature * projectedLeftOffset;
  const offsetCurvature = Math.abs(denominator) <= 0.000001 ? pose.curvature : pose.curvature / denominator;
  const width = Math.max(0, laneWidthAt(lane, localS));
  const projectedWidth = Math.hypot(left.x - right.x, left.y - right.y);
  return {
    left,
    right,
    heading,
    curvature: offsetCurvature * travelSign,
    width,
    grade: roadGradeAlongTravel(road, s, travelSign),
    roll: Math.atan2(left.z - right.z, Math.max(0.000000001, projectedWidth))
  };
}
function laneTravelSign(lane) {
  const standard = lane.id < 0 ? 1 : -1;
  return lane.direction === "reversed" ? -standard : standard;
}
function roadGradeAlongTravel(road, s, travelSign) {
  return evaluateRoadFrame(road, s).grade * travelSign;
}

// ../three-roads-inspect/packages/core/src/lanes/connector-contact-contract.ts
var connectorContactTolerance = {
  position: 0.00001,
  heading: 0.000001,
  curvature: 0.000001,
  grade: 0.000001,
  roll: 0.000001,
  width: 0.000001
};
function connectorContactError(actual, expected) {
  return {
    position: Math.max(pointDistance3(actual.left, expected.left), pointDistance3(actual.right, expected.right)),
    heading: Math.abs(normalizeAngle(actual.heading - expected.heading)),
    curvature: Math.abs(actual.curvature - expected.curvature),
    grade: Math.abs(actual.grade - expected.grade),
    roll: Math.abs(actual.roll - expected.roll),
    width: Math.abs(actual.width - expected.width)
  };
}
function connectorContactFits(actual, expected, requiredContinuity = "g1") {
  const error3 = connectorContactError(actual, expected);
  return error3.position <= connectorContactTolerance.position && error3.heading <= connectorContactTolerance.heading && (requiredContinuity !== "g2" || error3.curvature <= connectorContactTolerance.curvature) && error3.grade <= connectorContactTolerance.grade && error3.roll <= connectorContactTolerance.roll && error3.width <= connectorContactTolerance.width;
}
function pointDistance3(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

// ../three-roads-inspect/packages/core/src/lanes/lane-participant-semantics.ts
function effectiveLaneAccess(lane) {
  if (lane.access !== undefined)
    return [...lane.access];
  if (lane.type === "biking")
    return ["bicycle"];
  if (lane.type === "sidewalk")
    return ["pedestrian"];
  if (lane.type === "tram" || lane.type === "rail")
    return ["tram"];
  if (lane.type === "bus" || lane.type === "stop")
    return ["bus"];
  if (lane.type === "restricted")
    return ["car", "emergency"];
  if (lane.type === "shared")
    return ["car", "bus", "bicycle", "pedestrian", "emergency"];
  if (lane.type === "shoulder")
    return ["emergency"];
  if (lane.type === "driving" || lane.type === "entry" || lane.type === "exit" || lane.type === "on-ramp" || lane.type === "off-ramp") {
    return ["car", "bus", "emergency"];
  }
  return [];
}
function mergeLaneAccess(incoming, outgoing) {
  if (!incoming.access)
    return outgoing.access ? [...outgoing.access] : undefined;
  if (!outgoing.access)
    return [...incoming.access];
  return incoming.access.filter((participant) => outgoing.access?.includes(participant));
}
function mergeLaneSurface(incoming, outgoing) {
  if (incoming.surface && outgoing.surface && incoming.surface !== outgoing.surface)
    return;
  return incoming.surface ?? outgoing.surface;
}
function mergeLanePriorityParticipants(incoming, outgoing) {
  if (!incoming.priorityParticipants || !outgoing.priorityParticipants)
    return;
  return incoming.priorityParticipants.filter((participant) => outgoing.priorityParticipants?.includes(participant));
}

// ../three-roads-inspect/packages/core/src/topology/polygon-ring.ts
var DEFAULT_TOLERANCE = 0.00000001;
function sanitizePolygonRing(points, tolerance = DEFAULT_TOLERANCE) {
  const snapped = points.map((point) => ({
    x: snapCoordinate(point.x, tolerance),
    y: snapCoordinate(point.y, tolerance)
  }));
  let ring = removeAdjacentDuplicates(snapped, tolerance);
  let changed = true;
  while (ring.length >= 3 && changed) {
    changed = false;
    const next = [];
    for (let index = 0;index < ring.length; index++) {
      const previous = ring[(index - 1 + ring.length) % ring.length];
      const current = ring[index];
      const following = ring[(index + 1) % ring.length];
      if (locallyCollinear(previous, current, following, tolerance)) {
        changed = true;
        continue;
      }
      next.push(current);
    }
    ring = removeAdjacentDuplicates(next, tolerance);
  }
  return ring;
}
function locallyCollinear(previous, current, following, tolerance) {
  return pointToSegmentDistance3(current, previous, following) <= tolerance || pointToSegmentDistance3(following, previous, current) <= tolerance || pointToSegmentDistance3(previous, current, following) <= tolerance;
}
function polygonRingSelfIntersections(points, tolerance = DEFAULT_TOLERANCE) {
  const ring = sanitizePolygonRing(points, tolerance);
  const issues = [];
  for (let first = 0;first < ring.length; first++) {
    const firstNext = (first + 1) % ring.length;
    for (let second = first + 1;second < ring.length; second++) {
      const secondNext = (second + 1) % ring.length;
      if (first === second || firstNext === second || secondNext === first)
        continue;
      const intersection = segmentIntersection(ring[first], ring[firstNext], ring[second], ring[secondNext], tolerance);
      if (intersection)
        issues.push({ firstEdge: first, secondEdge: second, point: intersection });
    }
  }
  return issues;
}
function isSimplePolygonRing(points, tolerance = DEFAULT_TOLERANCE) {
  const ring = sanitizePolygonRing(points, tolerance);
  return ring.length >= 3 && polygonRingSelfIntersections(ring, tolerance).length === 0;
}
function removeAdjacentDuplicates(points, tolerance) {
  const result = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (!previous || distance2(previous, point) > tolerance)
      result.push(point);
  }
  if (result.length > 1 && distance2(result[0], result.at(-1)) <= tolerance)
    result.pop();
  return result;
}
function segmentIntersection(a, b, c, d, tolerance) {
  const ab = subtract(b, a);
  const cd = subtract(d, c);
  const denominator = cross4(ab, cd);
  const scale = Math.max(1, distance2(a, b), distance2(c, d));
  if (Math.abs(denominator) <= tolerance * scale) {
    if (pointToSegmentDistance3(a, c, d) <= tolerance && !sameEndpoint(a, c, d, tolerance))
      return a;
    if (pointToSegmentDistance3(b, c, d) <= tolerance && !sameEndpoint(b, c, d, tolerance))
      return b;
    if (pointToSegmentDistance3(c, a, b) <= tolerance && !sameEndpoint(c, a, b, tolerance))
      return c;
    if (pointToSegmentDistance3(d, a, b) <= tolerance && !sameEndpoint(d, a, b, tolerance))
      return d;
    return;
  }
  const ac = subtract(c, a);
  const t = cross4(ac, cd) / denominator;
  const u = cross4(ac, ab) / denominator;
  if (t <= tolerance || t >= 1 - tolerance || u <= tolerance || u >= 1 - tolerance)
    return;
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}
function sameEndpoint(point, a, b, tolerance) {
  return distance2(point, a) <= tolerance || distance2(point, b) <= tolerance;
}
function pointToSegmentDistance3(point, start, end) {
  const segment = subtract(end, start);
  const lengthSquared = segment.x * segment.x + segment.y * segment.y;
  if (lengthSquared <= Number.EPSILON)
    return distance2(point, start);
  const relative = subtract(point, start);
  const t = Math.max(0, Math.min(1, dot(relative, segment) / lengthSquared));
  return distance2(point, { x: start.x + segment.x * t, y: start.y + segment.y * t });
}
function snapCoordinate(value, tolerance) {
  const snapped = Math.round(value / tolerance) * tolerance;
  return Math.abs(snapped) <= tolerance ? 0 : snapped;
}
function distance2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}
function cross4(a, b) {
  return a.x * b.y - a.y * b.x;
}

// ../three-roads-inspect/packages/core/src/authoring/continuation-connector-markings.ts
function continuationConnectorMarkings(spec) {
  const incoming = contactMarkings(spec.incomingRoad, spec.incomingSection, spec.incomingLane, spec.incomingS, spec.from);
  const outgoing = contactMarkings(spec.outgoingRoad, spec.outgoingSection, spec.outgoingLane, spec.outgoingS, spec.to);
  return ["inner", "outer"].flatMap((boundary) => {
    const incomingMarkings = incoming.get(boundary) ?? [];
    const outgoingMarkings = outgoing.get(boundary) ?? [];
    const match = compatibleMarking(incomingMarkings, outgoingMarkings) ?? preferredMarking(spec.preferredRoadId, spec.incomingRoad.id, incomingMarkings, spec.outgoingRoad.id, outgoingMarkings);
    return match ? [{
      ...structuredClone(match),
      id: `${spec.continuationId}-${boundary}-${match.kind}`,
      boundary,
      sStart: 0,
      sEnd: spec.connectorLength
    }] : [];
  });
}
function preferredMarking(preferredRoadId, incomingRoadId, incoming, outgoingRoadId, outgoing) {
  if (preferredRoadId === incomingRoadId)
    return incoming[0];
  if (preferredRoadId === outgoingRoadId)
    return outgoing[0];
  return;
}
function contactMarkings(road, section, lane, s, contact) {
  const result = new Map;
  for (const marking of lane.markings ?? []) {
    if (!markingActiveAt(marking, s))
      continue;
    const laneBoundary = marking.boundary ?? "outer";
    if (laneBoundary === "center")
      continue;
    const connectorBoundary = connectorBoundaryForLaneBoundary(laneBoundary, road, section, lane, s, contact);
    result.set(connectorBoundary, [...result.get(connectorBoundary) ?? [], marking]);
  }
  return result;
}
function connectorBoundaryForLaneBoundary(laneBoundary, road, section, lane, s, contact) {
  const localS = s - section.s;
  const offsets = laneOffsetsAt(section, lane.id, localS);
  const heights = laneHeightAt(lane, localS);
  const inner = laneSurfacePointAt(road, section, lane, s, offsets.inner, heights.inner);
  const connectorInnerIsLaneInner = distance3(inner, contact.left) <= distance3(inner, contact.right);
  return laneBoundary === "inner" === connectorInnerIsLaneInner ? "inner" : "outer";
}
function compatibleMarking(incoming, outgoing) {
  for (const source of incoming) {
    const target = outgoing.find((candidate) => candidate.kind === source.kind && (candidate.color ?? "white") === (source.color ?? "white"));
    if (target)
      return {
        ...source,
        width: Math.max(source.width ?? 0, target.width ?? 0) || undefined,
        laneChange: source.laneChange === target.laneChange ? source.laneChange : "none"
      };
  }
  return;
}
function markingActiveAt(marking, s) {
  return (marking.sStart === undefined || marking.sStart <= s + 0.0000001) && (marking.sEnd === undefined || marking.sEnd >= s - 0.0000001);
}
function distance3(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

// ../three-roads-inspect/packages/core/src/authoring/junction-connector-corridor-builder.ts
function buildLaneConnectorCorridorRoad(roads, junctionId, connectorId, corridorId, routes) {
  if (routes.length < 2)
    throw new Error(`Connector corridor ${corridorId} needs at least two routes`);
  const firstRoute = routes[0];
  const incomingRoad = requiredRoad(roads, firstRoute.incomingRoadId, corridorId);
  const outgoingRoad = requiredRoad(roads, firstRoute.connectingRoadId, corridorId);
  const resolved = routes.map((route) => resolveRoute(incomingRoad, outgoingRoad, route, corridorId));
  const normal = leftNormal(resolved[0].from.heading);
  resolved.sort((left, right) => lateral(right.from.left, normal) - lateral(left.from.left, normal));
  assertRouteOrder(resolved, corridorId);
  const geometry = connectorGeometry(firstRoute, resolved[0], resolved, corridorId);
  const length = referenceLineLength({ geometry });
  const lanes = [{ id: 0, type: "center", widths: [] }];
  const connections = [];
  let connectorLaneOrdinal = 1;
  for (let index = 0;index < resolved.length; index++) {
    const current = resolved[index];
    if (index > 0) {
      const previous = resolved[index - 1];
      const startGap = pointDistance(previous.from.right, current.from.left);
      const endGap = pointDistance(previous.to.right, current.to.left);
      if (Math.max(startGap, endGap) > 0.0001) {
        lanes.push(separatorLane(-connectorLaneOrdinal, startGap, endGap, length, corridorId));
        connectorLaneOrdinal += 1;
      }
    }
    const connectorLaneId = -connectorLaneOrdinal;
    lanes.push(drivingLane(connectorLaneId, current, resolved[0], length, junctionId));
    connections.push({
      id: `${current.route.id}__0`,
      sourceManeuverId: current.route.sourceManeuverId,
      sourceLaneContinuationId: current.route.sourceLaneContinuationId,
      incomingRoadId: incomingRoad.id,
      connectingRoadId: connectorId,
      incomingContactPoint: current.route.incomingContactPoint,
      incomingS: current.route.incomingS,
      connectingS: 0,
      contactPoint: "start",
      laneLinks: [{ from: current.route.laneLinks[0].from, to: connectorLaneId }],
      laneDirection: current.route.laneDirection,
      connectorCorridorId: corridorId
    });
    connectorLaneOrdinal += 1;
  }
  const first = resolved[0];
  const carriesLaneShape = resolved.some((route) => route.incomingLane.level === true || route.outgoingLane.level === true || isRaisedPerimeterLane(route.incomingLane) || isRaisedPerimeterLane(route.outgoingLane));
  const road = {
    id: connectorId,
    name: `${corridorId} multi-lane connector`,
    kind: "connector",
    junctionId,
    requiredEndpointContinuity: firstRoute.requiredContinuity ?? "g1",
    length,
    referenceLine: { geometry },
    elevation: [stationRecord(cubicTransition(first.from.left.z, first.to.left.z, length, first.from.grade, first.to.grade))],
    superelevation: [stationRecord(carriesLaneShape ? cubicTransition(0, 0, length) : cubicTransition(first.from.roll, first.to.roll, length))],
    laneSections: [{ id: `${connectorId}__section`, s: 0, lanes }],
    links: {
      predecessors: [{ roadId: incomingRoad.id, contactPoint: contactPointForStation(incomingRoad, routeStation(incomingRoad, firstRoute, "incoming")) }],
      successors: [{ roadId: outgoingRoad.id, contactPoint: contactPointForStation(outgoingRoad, routeStation(outgoingRoad, firstRoute, "outgoing")) }]
    }
  };
  if (!isSimplePolygonRing(sampleRoadEnvelope(road, 0.5).points)) {
    throw new Error(`Connector corridor ${corridorId} produces a self-intersecting road envelope`);
  }
  return { road, connections };
}
function resolveRoute(incomingRoad, outgoingRoad, route, corridorId) {
  if (route.incomingRoadId !== incomingRoad.id || route.connectingRoadId !== outgoingRoad.id) {
    throw new Error(`Connector corridor ${corridorId} routes must share roads`);
  }
  if (route.laneLinks.length !== 1)
    throw new Error(`Connector corridor ${corridorId} routes need one lane link each`);
  const incomingS = routeStation(incomingRoad, route, "incoming");
  const outgoingS = routeStation(outgoingRoad, route, "outgoing");
  const incomingSection = sectionAtIncoming(incomingRoad, incomingS);
  const outgoingSection = sectionAt(outgoingRoad, outgoingS);
  const incomingLane = incomingSection?.lanes.find((lane) => lane.id === route.laneLinks[0].from);
  const outgoingLane = outgoingSection?.lanes.find((lane) => lane.id === route.laneLinks[0].to);
  if (!incomingSection || !outgoingSection || !incomingLane || !outgoingLane) {
    throw new Error(`Connector corridor ${corridorId} cannot resolve a lane contact`);
  }
  const bidirectional = route.laneDirection === "both";
  return {
    route,
    incomingRoad,
    outgoingRoad,
    incomingSection,
    outgoingSection,
    incomingLane,
    outgoingLane,
    incomingS,
    outgoingS,
    from: bidirectional ? laneContactGeometryAlong(incomingRoad, incomingSection, incomingLane, incomingS, contactApproachSign(incomingRoad, incomingS, route.incomingContactPoint)) : laneContactGeometry(incomingRoad, incomingSection, incomingLane, incomingS),
    to: bidirectional ? laneContactGeometryAlong(outgoingRoad, outgoingSection, outgoingLane, outgoingS, -contactApproachSign(outgoingRoad, outgoingS, route.contactPoint)) : laneContactGeometry(outgoingRoad, outgoingSection, outgoingLane, outgoingS)
  };
}
function connectorGeometry(route, resolved, corridorRoutes, corridorId) {
  if (route.connectorGeometry?.length)
    return structuredClone(route.connectorGeometry);
  const start = { x: resolved.from.left.x, y: resolved.from.left.y, heading: resolved.from.heading, curvature: resolved.from.curvature };
  const end = { x: resolved.to.left.x, y: resolved.to.left.y, heading: resolved.to.heading, curvature: resolved.to.curvature };
  const minimumRadius = Math.max(route.minimumRadius ?? 0, corridorMinimumRadius(corridorRoutes));
  try {
    if (route.requiredContinuity === "g2") {
      return solveParallelG2Connector(start, end, { minRadius: minimumRadius }).geometry;
    }
    const circular = solveCircularConnector(start, end, minimumRadius);
    return circular ? [circular.segment] : [solveConnectorCurve(start, end, { minRadius: minimumRadius }).segment];
  } catch (error3) {
    throw new Error(`Connector corridor ${corridorId} geometry failed: ${error3 instanceof Error ? error3.message : String(error3)}`);
  }
}
function corridorMinimumRadius(routes) {
  const first = routes[0];
  const last = routes.at(-1);
  const chord = pointDistance(first.from.left, first.to.left);
  const width = Math.max(pointDistance(first.from.left, last.from.right), pointDistance(first.to.left, last.to.right));
  const nonMotorized = routes.every((route) => route.incomingLane.type === "border" || route.incomingLane.type === "sidewalk" || route.outgoingLane.type === "border" || route.outgoingLane.type === "sidewalk");
  return nonMotorized ? Math.max(width + 1, chord * 0.2) : Math.max(width + 1, chord * 0.12);
}
function assertRouteOrder(routes, corridorId) {
  const endNormal = leftNormal(routes[0].to.heading);
  for (let index = 1;index < routes.length; index++) {
    if (lateral(routes[index - 1].to.left, endNormal) >= lateral(routes[index].to.left, endNormal))
      continue;
    throw new Error(`Connector corridor ${corridorId} reverses lane order`);
  }
}
function drivingLane(id, route, referenceRoute, length, junctionId) {
  return {
    id,
    type: compatibleLaneType(route.incomingLane, route.outgoingLane),
    surface: mergeLaneSurface(route.incomingLane, route.outgoingLane),
    direction: route.route.laneDirection,
    level: route.incomingLane.level === true && route.outgoingLane.level === true,
    heights: connectorLaneHeights(route.from.left.z - referenceRoute.from.left.z, route.from.right.z - referenceRoute.from.left.z, route.to.left.z - referenceRoute.to.left.z, route.to.right.z - referenceRoute.to.left.z, length),
    widths: [{ sOffset: 0, ...cubicTransition(route.from.width, route.to.width, length) }],
    access: mergeLaneAccess(route.incomingLane, route.outgoingLane),
    priorityParticipants: mergeLanePriorityParticipants(route.incomingLane, route.outgoingLane),
    markings: connectorLaneMarkings(route.route, length) ?? (route.route.sourceLaneContinuationId ? continuationConnectorMarkings({
      incomingRoad: route.incomingRoad,
      incomingSection: route.incomingSection,
      incomingLane: route.incomingLane,
      incomingS: route.incomingS,
      from: route.from,
      outgoingRoad: route.outgoingRoad,
      outgoingSection: route.outgoingSection,
      outgoingLane: route.outgoingLane,
      outgoingS: route.outgoingS,
      to: route.to,
      connectorLength: length,
      continuationId: route.route.sourceLaneContinuationId
    }) : undefined),
    links: {
      predecessor: {
        roadId: route.route.incomingRoadId,
        laneId: route.route.laneLinks[0].from,
        contactPoint: route.route.incomingContactPoint ?? "end",
        s: route.route.incomingS,
        junctionId
      },
      successor: {
        roadId: route.route.connectingRoadId,
        laneId: route.route.laneLinks[0].to,
        contactPoint: route.route.contactPoint,
        s: route.route.connectingS,
        junctionId
      }
    }
  };
}
function connectorLaneHeights(startInner, startOuter, endInner, endOuter, length) {
  const start = { sOffset: 0, inner: startInner, outer: startOuter };
  return Math.max(Math.abs(endInner - startInner), Math.abs(endOuter - startOuter)) <= 0.000000001 ? [start] : [start, { sOffset: length, inner: endInner, outer: endOuter }];
}
function isRaisedPerimeterLane(lane) {
  return lane.type === "border" || lane.type === "sidewalk";
}
function contactApproachSign(road, s, contactPoint) {
  if (s <= 0.0000001)
    return -1;
  if (s >= road.length - 0.0000001)
    return 1;
  return contactPoint === "start" ? -1 : 1;
}
function connectorLaneMarkings(route, length) {
  return route.connectorLaneMarkings?.map((marking) => ({
    ...structuredClone(marking),
    sStart: 0,
    sEnd: length
  }));
}
function separatorLane(id, startWidth, endWidth, length, corridorId) {
  return {
    id,
    type: "median",
    widths: [{ sOffset: 0, ...cubicTransition(startWidth, endWidth, length) }],
    markings: [
      { id: `${corridorId}-separator-inner`, kind: "solid", boundary: "inner", sStart: 0, sEnd: length, width: 0.12 },
      { id: `${corridorId}-separator-outer`, kind: "solid", boundary: "outer", sStart: 0, sEnd: length, width: 0.12 }
    ]
  };
}
function routeStation(road, route, side) {
  return side === "incoming" ? route.incomingS ?? endpointS(road, route.incomingContactPoint) : route.connectingS ?? endpointS(road, route.contactPoint);
}
function cubicTransition(start, end, length, startDerivative = 0, endDerivative = 0) {
  const delta = end - start;
  return {
    a: start,
    b: startDerivative,
    c: (3 * delta - length * (2 * startDerivative + endDerivative)) / (length * length),
    d: (-2 * delta + length * (startDerivative + endDerivative)) / (length * length * length)
  };
}
function stationRecord(poly) {
  return { s: 0, ...poly };
}
function compatibleLaneType(incoming, outgoing) {
  if (incoming.type === outgoing.type)
    return incoming.type;
  if (incoming.type === "biking" || outgoing.type === "biking")
    return "biking";
  if (incoming.type === "tram" || outgoing.type === "tram")
    return "tram";
  if (incoming.type === "bus" || outgoing.type === "bus")
    return "bus";
  return "driving";
}
function requiredRoad(roads, roadId, corridorId) {
  const road = roads.find((candidate) => candidate.id === roadId);
  if (!road)
    throw new Error(`Connector corridor ${corridorId} references missing road ${roadId}`);
  return road;
}
function sectionAt(road, s) {
  return [...road.laneSections].sort((a, b) => a.s - b.s).filter((section) => section.s <= s + 0.0000001).at(-1);
}
function sectionAtIncoming(road, s) {
  const sorted = [...road.laneSections].sort((a, b) => a.s - b.s);
  return sorted.filter((section) => section.s < s - 0.0000001).at(-1) ?? sorted[0];
}
function endpointS(road, contactPoint) {
  return contactPoint === "start" ? 0 : road.length;
}
function contactPointForStation(road, s) {
  return Math.abs(s) <= Math.abs(road.length - s) ? "start" : "end";
}
function lateral(point, normal) {
  return point.x * normal.x + point.y * normal.y;
}
function pointDistance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

// ../three-roads-inspect/packages/core/src/authoring/junction-connector-builder.ts
var MIN_CONNECTOR_LENGTH = 0.05;
function refused(reason, detail) {
  return { reason, detail };
}
function materializeCommonJunction(network, junction) {
  if (junction.kind !== "common")
    return { network, junction };
  const roads = [...network.roads];
  const roadIndexes = new Map(roads.map((road, index) => [road.id, index]));
  const roadIds = new Set(roadIndexes.keys());
  const connections = [];
  const unmaterialized = [];
  const materializedCorridors = new Set;
  for (const route of junction.connections) {
    if (route.connectorCorridorId) {
      if (materializedCorridors.has(route.connectorCorridorId))
        continue;
      materializedCorridors.add(route.connectorCorridorId);
      const corridorRoutes = junction.connections.filter((candidate) => candidate.connectorCorridorId === route.connectorCorridorId);
      const connectorId = uniqueConnectorId(roadIds, `${junction.id}__corridor-${route.connectorCorridorId}`);
      let corridor;
      try {
        corridor = buildLaneConnectorCorridorRoad(roads, junction.id, connectorId, route.connectorCorridorId, corridorRoutes);
      } catch (error3) {
        if (junction.connectorGeometryPolicy !== "surface-fallback")
          throw error3;
        connections.push(...corridorRoutes);
        unmaterialized.push(...corridorRoutes.map((corridorRoute) => ({
          connectionId: corridorRoute.id,
          incomingRoadId: corridorRoute.incomingRoadId,
          connectingRoadId: corridorRoute.connectingRoadId,
          reason: "corridor-build-failed",
          detail: error3 instanceof Error ? error3.message : String(error3)
        })));
        continue;
      }
      appendRoad(roads, roadIndexes, roadIds, corridor.road);
      attachJunctionLink(roads, roadIndexes, route.incomingRoadId, junction.id, route.incomingS, route.incomingContactPoint);
      attachJunctionLink(roads, roadIndexes, route.connectingRoadId, junction.id, route.connectingS, route.contactPoint);
      connections.push(...corridor.connections);
      continue;
    }
    const incomingRoad = roadById(roads, roadIndexes, route.incomingRoadId);
    const outgoingRoad = roadById(roads, roadIndexes, route.connectingRoadId);
    if (!incomingRoad || !outgoingRoad) {
      connections.push(route);
      continue;
    }
    for (let laneLinkIndex = 0;laneLinkIndex < route.laneLinks.length; laneLinkIndex++) {
      const laneLink = route.laneLinks[laneLinkIndex];
      if (!isDirectedContactMovement(incomingRoad, outgoingRoad, route, laneLink)) {
        connections.push({ ...route, laneLinks: [laneLink] });
        continue;
      }
      const connectorId = uniqueConnectorId(roadIds, `${junction.id}__${route.id}__${laneLink.from}_${laneLink.to}`);
      const attempt = buildLaneConnectorRoad(roads, junction.id, junction.connectorGeometryPolicy, junction.profileTransition?.dominantRoadId, connectorId, incomingRoad, outgoingRoad, route, laneLink);
      if (!("road" in attempt)) {
        connections.push({ ...route, laneLinks: [laneLink] });
        unmaterialized.push({
          connectionId: route.id,
          incomingRoadId: incomingRoad.id,
          connectingRoadId: outgoingRoad.id,
          fromLaneId: laneLink.from,
          toLaneId: laneLink.to,
          reason: attempt.reason,
          detail: attempt.detail
        });
        attachJunctionLink(roads, roadIndexes, incomingRoad.id, junction.id, route.incomingS, route.incomingContactPoint);
        attachJunctionLink(roads, roadIndexes, outgoingRoad.id, junction.id, route.connectingS, route.contactPoint);
        continue;
      }
      const connector = attempt.road;
      appendRoad(roads, roadIndexes, roadIds, connector);
      attachJunctionLink(roads, roadIndexes, incomingRoad.id, junction.id, route.incomingS, route.incomingContactPoint);
      attachJunctionLink(roads, roadIndexes, outgoingRoad.id, junction.id, route.connectingS, route.contactPoint);
      connections.push({
        id: `${route.id}__${laneLinkIndex}`,
        sourceManeuverId: route.sourceManeuverId,
        sourceLaneContinuationId: route.sourceLaneContinuationId,
        incomingRoadId: incomingRoad.id,
        connectingRoadId: connector.id,
        incomingContactPoint: route.incomingContactPoint,
        incomingS: route.incomingS,
        connectingS: 0,
        contactPoint: "start",
        laneLinks: [{ from: laneLink.from, to: -1 }],
        laneDirection: route.laneDirection
      });
    }
  }
  if (junction.connectorGeometryPolicy === "surface-fallback") {
    for (const port of junction.ports ?? []) {
      attachJunctionLink(roads, roadIndexes, port.roadId, junction.id, port.s, port.contactPoint);
    }
  }
  return {
    network: { ...network, roads },
    junction: {
      ...junction,
      connections,
      unmaterializedConnections: unmaterialized.length > 0 ? unmaterialized : undefined
    }
  };
}
function buildLaneConnectorRoad(roads, junctionId, geometryPolicy, dominantTransitionRoadId, connectorId, incomingRoad, outgoingRoad, route, laneLink) {
  const incomingS = route.incomingS ?? endpointS2(incomingRoad, route.incomingContactPoint);
  const outgoingS = route.connectingS ?? endpointS2(outgoingRoad, route.contactPoint);
  const incomingSection = sectionAtIncoming2(incomingRoad, incomingS);
  const outgoingSection = sectionAt2(outgoingRoad, outgoingS);
  const incomingLane = incomingSection?.lanes.find((lane) => lane.id === laneLink.from);
  const outgoingLane = outgoingSection?.lanes.find((lane) => lane.id === laneLink.to);
  if (!incomingSection || !outgoingSection || !incomingLane || !outgoingLane) {
    return refused("unsolvable-geometry", `lane ${laneLink.from}>${laneLink.to} is not present at both contacts`);
  }
  const from = incomingLane.direction === "both" ? laneContactGeometryAlong(incomingRoad, incomingSection, incomingLane, incomingS, contactApproachSign2(incomingRoad, incomingS, route.incomingContactPoint)) : laneContactGeometry(incomingRoad, incomingSection, incomingLane, incomingS);
  const to = outgoingLane.direction === "both" ? laneContactGeometryAlong(outgoingRoad, outgoingSection, outgoingLane, outgoingS, -contactApproachSign2(outgoingRoad, outgoingS, route.contactPoint)) : laneContactGeometry(outgoingRoad, outgoingSection, outgoingLane, outgoingS);
  const chordLength = Math.hypot(to.left.x - from.left.x, to.left.y - from.left.y);
  if (chordLength < MIN_CONNECTOR_LENGTH) {
    return refused("degenerate-length", `chord ${chordLength.toFixed(4)}m is below ${MIN_CONNECTOR_LENGTH}m`);
  }
  if (geometryPolicy === "surface-fallback" && !canBridgeVerticalDifference(from, to, chordLength)) {
    return refused("vertical-separation", `${Math.abs(from.left.z - to.left.z).toFixed(2)}m of elevation across a ${chordLength.toFixed(2)}m chord`);
  }
  const designMinimumRadius = Math.max(route.minimumRadius ?? 0, connectorMinimumRadius(incomingLane, outgoingLane, chordLength, from.width, to.width));
  const minRadius = geometryPolicy === "surface-fallback" && !dominantTransitionRoadId ? Math.min(designMinimumRadius, Math.max(0.05, chordLength * 0.02)) : designMinimumRadius;
  let geometry;
  let length;
  try {
    const start = { x: from.left.x, y: from.left.y, heading: from.heading, curvature: from.curvature };
    const end = { x: to.left.x, y: to.left.y, heading: to.heading, curvature: to.curvature };
    if (route.connectorGeometry?.length) {
      geometry = structuredClone(route.connectorGeometry);
      length = referenceLineLength({ geometry });
    } else if (route.requiredContinuity === "g2") {
      const solved = solveParallelG2Connector(start, end, { minRadius });
      geometry = solved.geometry;
      length = solved.length;
    } else {
      const circular = solveCircularConnector(start, end, minRadius);
      if (circular) {
        geometry = [circular.segment];
        length = circular.segment.length;
      } else {
        const solved = solveConnectorCurve(start, end, {
          minRadius,
          searchMode: geometryPolicy === "surface-fallback" && !dominantTransitionRoadId ? "fast" : "thorough"
        });
        geometry = [solved.segment];
        length = solved.length;
      }
    }
  } catch (error3) {
    const message = error3 instanceof Error ? error3.message : String(error3);
    if (route.requiredContinuity === "g2") {
      throw new Error(`G2 connector ${route.id} failed: ${message}`);
    }
    return refused("unsolvable-geometry", `no curve of radius >= ${minRadius.toFixed(2)}m fits: ${message}`);
  }
  length = referenceLineLength({ geometry });
  const transitionSemanticLane = dominantTransitionRoadId === incomingRoad.id ? incomingLane : dominantTransitionRoadId === outgoingRoad.id ? outgoingLane : undefined;
  const laneType = transitionSemanticLane?.type ?? compatibleLaneType2(incomingLane, outgoingLane);
  const widthProfile = cubicTransition2(from.width, to.width, length);
  const elevation = cubicTransition2(from.left.z, to.left.z, length, from.grade, to.grade);
  const carriesLaneShape = incomingLane.level === true || outgoingLane.level === true || isRaisedPerimeterLane2(incomingLane) || isRaisedPerimeterLane2(outgoingLane);
  const superelevation = carriesLaneShape ? cubicTransition2(0, 0, length) : cubicTransition2(from.roll, to.roll, length);
  const laneHeights = carriesLaneShape ? connectorLaneHeights2(from.right.z - from.left.z, to.right.z - to.left.z, length) : undefined;
  const connector = {
    id: connectorId,
    name: `${route.id} lane ${laneLink.from}>${laneLink.to}`,
    kind: "connector",
    requiredEndpointContinuity: route.requiredContinuity ?? "g1",
    junctionId,
    length,
    referenceLine: { geometry },
    elevation: [stationRecord2(elevation)],
    superelevation: [stationRecord2(superelevation)],
    laneSections: [{
      id: `${connectorId}__section`,
      s: 0,
      lanes: [
        { id: 0, type: "center", widths: [] },
        {
          id: -1,
          type: laneType,
          surface: transitionSemanticLane?.surface ?? mergeLaneSurface(incomingLane, outgoingLane),
          direction: transitionSemanticLane?.direction ?? route.laneDirection,
          level: transitionSemanticLane ? transitionSemanticLane.level === true : incomingLane.level === true && outgoingLane.level === true,
          verticalEdges: transitionSemanticLane?.verticalEdges,
          heights: laneHeights,
          widths: [{ sOffset: 0, ...widthProfile }],
          access: transitionSemanticLane ? structuredClone(transitionSemanticLane.access) : mergeLaneAccess(incomingLane, outgoingLane),
          priorityParticipants: transitionSemanticLane ? structuredClone(transitionSemanticLane.priorityParticipants) : mergeLanePriorityParticipants(incomingLane, outgoingLane),
          markings: connectorLaneMarkings2(route, length) ?? (route.sourceLaneContinuationId || dominantTransitionRoadId ? continuationConnectorMarkings({
            incomingRoad,
            incomingSection,
            incomingLane,
            incomingS,
            from,
            outgoingRoad,
            outgoingSection,
            outgoingLane,
            outgoingS,
            to,
            connectorLength: length,
            continuationId: route.sourceLaneContinuationId ?? `profile-${route.id}`,
            preferredRoadId: dominantTransitionRoadId
          }) : undefined),
          links: {
            predecessor: {
              roadId: incomingRoad.id,
              laneId: incomingLane.id,
              contactPoint: route.incomingContactPoint ?? contactPointForStation2(incomingRoad, incomingS),
              s: incomingS,
              junctionId
            },
            successor: {
              roadId: outgoingRoad.id,
              laneId: outgoingLane.id,
              contactPoint: route.contactPoint ?? contactPointForStation2(outgoingRoad, outgoingS),
              s: outgoingS,
              junctionId
            }
          }
        }
      ]
    }],
    links: connectorRoadLinks(incomingRoad, outgoingRoad, route, incomingS, outgoingS)
  };
  const validEnvelope = sampleLanePolygons(connector, 1).every((polygon) => isSimplePolygonRing(polygon.points));
  if (!validEnvelope) {
    return refused("self-intersecting-envelope", `radius ${minRadius.toFixed(2)}m folds a ${Math.max(from.width, to.width).toFixed(2)}m lane`);
  }
  if (geometryPolicy === "surface-fallback" && !connectorFitsRouteContacts(connector, from, to)) {
    return refused("contact-mismatch");
  }
  return { road: connector };
}
function connectorFitsRouteContacts(connector, from, to) {
  const section = connector.laneSections[0];
  const lane = section?.lanes.find(({ id }) => id === -1);
  if (!section || !lane)
    return false;
  const start = laneContactGeometryAlong(connector, section, lane, 0, 1);
  const end = laneContactGeometryAlong(connector, section, lane, connector.length, 1);
  return connectorContactFits(start, from, connector.requiredEndpointContinuity) && connectorContactFits(end, to, connector.requiredEndpointContinuity);
}
function canBridgeVerticalDifference(from, to, planLength) {
  const elevationError = Math.max(Math.abs(from.left.z - to.left.z), Math.abs(from.right.z - to.right.z));
  return elevationError <= Math.max(0.05, planLength * 0.5);
}
function isRaisedPerimeterLane2(lane) {
  return lane.type === "border" || lane.type === "sidewalk";
}
function connectorLaneMarkings2(route, length) {
  return route.connectorLaneMarkings?.map((marking) => ({
    ...structuredClone(marking),
    sStart: 0,
    sEnd: length
  }));
}
function connectorLaneHeights2(startOuterHeight, endOuterHeight, length) {
  const start = { sOffset: 0, inner: 0, outer: startOuterHeight };
  if (Math.abs(endOuterHeight - startOuterHeight) <= 0.000000001)
    return [start];
  return [start, { sOffset: length, inner: 0, outer: endOuterHeight }];
}
function cubicTransition2(start, end, length, startDerivative = 0, endDerivative = 0) {
  const delta = end - start;
  const c = (3 * delta - length * (2 * startDerivative + endDerivative)) / (length * length);
  const d = (-2 * delta + length * (startDerivative + endDerivative)) / (length * length * length);
  return { a: start, b: startDerivative, c, d };
}
function stationRecord2(poly) {
  return { s: 0, ...poly };
}
function connectorMinimumRadius(incoming, outgoing, chordLength, incomingWidth, outgoingWidth) {
  const width = Math.max(incomingWidth, outgoingWidth);
  const offsetSafetyRadius = width + 0.5;
  const nonMotorized = new Set(["biking", "sidewalk"]);
  if (nonMotorized.has(incoming.type) || nonMotorized.has(outgoing.type)) {
    return Math.max(offsetSafetyRadius, 2 - width / 2, chordLength * 0.08);
  }
  if (incoming.type === "on-ramp" || incoming.type === "off-ramp" || outgoing.type === "on-ramp" || outgoing.type === "off-ramp") {
    return Math.max(offsetSafetyRadius, 12 - width / 2, chordLength * 0.18);
  }
  return Math.max(offsetSafetyRadius, 5 - width / 2, chordLength * 0.12);
}
function compatibleLaneType2(incoming, outgoing) {
  if (incoming.type === outgoing.type)
    return incoming.type;
  if (incoming.type === "biking" || outgoing.type === "biking")
    return "biking";
  if (incoming.type === "tram" || outgoing.type === "tram")
    return "tram";
  if (incoming.type === "bus" || outgoing.type === "bus")
    return "bus";
  return "driving";
}
function isDirectedContactMovement(incomingRoad, outgoingRoad, route, laneLink) {
  const incomingS = route.incomingS ?? endpointS2(incomingRoad, route.incomingContactPoint);
  const outgoingS = route.connectingS ?? endpointS2(outgoingRoad, route.contactPoint);
  const incomingSection = sectionAtIncoming2(incomingRoad, incomingS);
  const outgoingSection = sectionAt2(outgoingRoad, outgoingS);
  const incomingLane = incomingSection?.lanes.find((lane) => lane.id === laneLink.from);
  const outgoingLane = outgoingSection?.lanes.find((lane) => lane.id === laneLink.to);
  if (!incomingLane || !outgoingLane)
    return false;
  if (route.laneDirection === "both") {
    return incomingLane.direction === "both" && outgoingLane.direction === "both" && isEndpointStation(incomingRoad, incomingS) && isEndpointStation(outgoingRoad, outgoingS);
  }
  return (incomingLane.direction === "both" || laneApproachesContact(incomingLane, route.incomingContactPoint)) && (outgoingLane.direction === "both" || laneLeavesContact(outgoingLane, route.contactPoint));
}
function laneApproachesContact(lane, contactPoint) {
  const sign = laneTravelSign(lane);
  return sign > 0 ? contactPoint !== "start" : contactPoint === "start";
}
function laneLeavesContact(lane, contactPoint) {
  const sign = laneTravelSign(lane);
  return sign > 0 ? contactPoint === "start" : contactPoint !== "start";
}
function nearStart(s) {
  return Math.abs(s) <= 0.0001;
}
function nearEnd(road, s) {
  return Math.abs(road.length - s) <= 0.0001;
}
function isEndpointStation(road, s) {
  return nearStart(s) || nearEnd(road, s);
}
function contactApproachSign2(road, s, contactPoint) {
  if (contactPoint === "start")
    return -1;
  if (contactPoint === "end")
    return 1;
  return Math.abs(s) <= Math.abs(road.length - s) ? -1 : 1;
}
function sectionAt2(road, s) {
  return [...road.laneSections].sort((a, b) => a.s - b.s).filter((section) => section.s <= s + 0.0000001).at(-1);
}
function sectionAtIncoming2(road, s) {
  const sorted = [...road.laneSections].sort((a, b) => a.s - b.s);
  return sorted.filter((section) => section.s < s - 0.0000001).at(-1) ?? sorted[0];
}
function endpointS2(road, contactPoint) {
  return contactPoint === "start" ? 0 : road.length;
}
function contactPointForStation2(road, s) {
  return Math.abs(s) <= Math.abs(road.length - s) ? "start" : "end";
}
function connectorRoadLinks(incomingRoad, outgoingRoad, route, incomingS, outgoingS) {
  const predecessor = isEndpointStation(incomingRoad, incomingS) ? [{ roadId: incomingRoad.id, contactPoint: route.incomingContactPoint ?? contactPointForStation2(incomingRoad, incomingS) }] : undefined;
  const successor = isEndpointStation(outgoingRoad, outgoingS) ? [{ roadId: outgoingRoad.id, contactPoint: route.contactPoint ?? contactPointForStation2(outgoingRoad, outgoingS) }] : undefined;
  return predecessor || successor ? { predecessors: predecessor, successors: successor } : undefined;
}
function roadById(roads, roadIndexes, roadId) {
  const index = roadIndexes.get(roadId);
  return index === undefined ? undefined : roads[index];
}
function uniqueConnectorId(roadIds, base) {
  if (!roadIds.has(base))
    return base;
  let index = 2;
  while (roadIds.has(`${base}__${index}`))
    index++;
  return `${base}__${index}`;
}
function appendRoad(roads, roadIndexes, roadIds, road) {
  roadIndexes.set(road.id, roads.length);
  roadIds.add(road.id);
  roads.push(road);
}
function attachJunctionLink(roads, roadIndexes, roadId, junctionId, s, contactPoint) {
  const index = roadIndexes.get(roadId);
  if (index === undefined)
    return;
  const road = roads[index];
  const station = s ?? endpointS2(road, contactPoint);
  if (!isEndpointStation(road, station))
    return;
  const resolvedContact = contactPoint ?? contactPointForStation2(road, station);
  const link = { junctionId, contactPoint: resolvedContact };
  roads[index] = resolvedContact === "start" ? { ...road, links: { ...road.links, predecessors: addRoadEndpointLink(road.links?.predecessors, link) } } : { ...road, links: { ...road.links, successors: addRoadEndpointLink(road.links?.successors, link) } };
}
function addRoadEndpointLink(links, link) {
  const values = links ?? [];
  if (values.some((candidate) => candidate.roadId === link.roadId && candidate.junctionId === link.junctionId && candidate.contactPoint === link.contactPoint)) {
    return values;
  }
  return [...values, link];
}

// ../three-roads-inspect/packages/core/src/authoring/network-builder.ts
function createRoadNetwork(options) {
  return {
    id: options.id,
    name: options.name,
    units: "metric",
    roads: [],
    junctions: [],
    junctionGroups: [],
    roadsideFeatures: [],
    roadSurfaceElevations: []
  };
}
function createJunction(network, spec) {
  if (network.junctions.some((junction2) => junction2.id === spec.id)) {
    throw new Error(`Junction ${spec.id} already exists`);
  }
  const junction = {
    id: spec.id,
    name: spec.name,
    kind: spec.kind ?? "common",
    connectorGeometryPolicy: spec.connectorGeometryPolicy,
    profileTransition: clone(spec.profileTransition),
    ports: clone(spec.ports),
    virtualRange: clone(spec.virtualRange),
    surfaceElevation: clone(spec.surfaceElevation),
    surfacePolygon: clone(spec.surfacePolygon),
    surfaceLaneType: spec.surfaceLaneType,
    surfacePatches: clone(spec.surfacePatches),
    connections: clone(spec.connections ?? []),
    connectorRoads: clone(spec.connectorRoads),
    conflictZones: clone(spec.conflictZones),
    movementInteractions: clone(spec.movementInteractions),
    trafficStreams: clone(spec.trafficStreams),
    streamInteractions: clone(spec.streamInteractions),
    control: clone(spec.control),
    areaMarkings: clone(spec.areaMarkings),
    terminalProtections: clone(spec.terminalProtections),
    operational: clone(spec.operational)
  };
  const materialized = materializeCommonJunction(network, junction);
  return {
    ...materialized.network,
    junctions: [...materialized.network.junctions, materialized.junction]
  };
}
function clone(value) {
  if (value === undefined)
    return value;
  return structuredClone(value);
}

// ../three-roads-inspect/packages/core/src/topology/polygon-boolean.ts
var import_polygon_clipping = __toESM(require_polygon_clipping_cjs(), 1);

// ../three-roads-inspect/packages/core/src/topology/polygon-clip.ts
var EPSILON6 = 0.0000001;
function polygonArea(points) {
  let area = 0;
  for (let i = 0;i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}
function normalizedPolygon(points) {
  const deduped = [];
  for (const point of points) {
    const last = deduped.at(-1);
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > EPSILON6)
      deduped.push(point);
  }
  if (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped.at(-1);
    if (last && Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON6)
      deduped.pop();
  }
  return polygonArea(deduped) < 0 ? deduped.reverse() : deduped;
}
function clipConvexPolygon(subject, clip) {
  let output = normalizedPolygon(subject);
  const clipPolygon = normalizedPolygon(clip);
  if (output.length < 3 || clipPolygon.length < 3)
    return [];
  for (let i = 0;i < clipPolygon.length; i++) {
    const edgeStart = clipPolygon[i];
    const edgeEnd = clipPolygon[(i + 1) % clipPolygon.length];
    const input = output;
    output = [];
    if (input.length === 0)
      break;
    let previous = input.at(-1);
    if (!previous)
      continue;
    for (const current of input) {
      const currentInside = isInside(current, edgeStart, edgeEnd);
      const previousInside = isInside(previous, edgeStart, edgeEnd);
      if (currentInside) {
        if (!previousInside)
          output.push(intersection(previous, current, edgeStart, edgeEnd));
        output.push(current);
      } else if (previousInside) {
        output.push(intersection(previous, current, edgeStart, edgeEnd));
      }
      previous = current;
    }
  }
  return normalizedPolygon(output);
}
function isInside(point, edgeStart, edgeEnd) {
  return cross6(edgeEnd.x - edgeStart.x, edgeEnd.y - edgeStart.y, point.x - edgeStart.x, point.y - edgeStart.y) >= -EPSILON6;
}
function intersection(a, b, c, d) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denominator = cross6(abx, aby, cdx, cdy);
  if (Math.abs(denominator) < EPSILON6)
    return b;
  const t = cross6(c.x - a.x, c.y - a.y, cdx, cdy) / denominator;
  return { x: a.x + abx * t, y: a.y + aby * t };
}
function cross6(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

// ../three-roads-inspect/packages/core/src/topology/polygon-boolean.ts
var MINIMUM_POLYGON_COMPONENT_AREA = 0.00000001;
var MIN_AREA = MINIMUM_POLYGON_COMPONENT_AREA;
var BOOLEAN_RETRY_TOLERANCES = [0.0000001, 0.000001, 0.00001];
function unionPolygons(polygons) {
  return runUnionWithPrecisionRetries((tolerance, pairwise) => {
    const inputs = polygons.map((polygon) => toClippingPolygon(polygon, tolerance)).filter((polygon) => polygon.length > 0);
    if (inputs.length === 0)
      return [];
    if (!pairwise) {
      return fromClippingMultiPolygon(import_polygon_clipping.default.union(inputs[0], ...inputs.slice(1)));
    }
    let union = [inputs[0]];
    for (const input of inputs.slice(1))
      union = import_polygon_clipping.default.union(union, input);
    return fromClippingMultiPolygon(union);
  });
}
function intersectPolygons(subject, clips) {
  if (subject.length < 3 || clips.length === 0)
    return [];
  const clipInputs = clips.map((polygon) => toClippingPolygon(polygon)).filter((polygon) => polygon.length > 0);
  if (clipInputs.length === 0)
    return [];
  return fromClippingMultiPolygon(import_polygon_clipping.default.intersection(toClippingPolygon(subject), ...clipInputs));
}
function subtractPolygons(subject, clips) {
  if (subject.length < 3)
    return [];
  const clipInputs = clips.map((polygon) => toClippingPolygon(polygon)).filter((polygon) => polygon.length > 0);
  if (clipInputs.length === 0)
    return [{ outer: normalizedOuter(subject), holes: [] }];
  return fromClippingMultiPolygon(import_polygon_clipping.default.difference(toClippingPolygon(subject), ...clipInputs));
}
function subtractPolygonComponents(subject, clips) {
  if (subject.length < 3)
    return [];
  const clipInputs = clips.map(toClippingComponent).filter((polygon) => polygon.length > 0);
  if (clipInputs.length === 0)
    return [{ outer: normalizedOuter(subject), holes: [] }];
  return fromClippingMultiPolygon(import_polygon_clipping.default.difference(toClippingPolygon(subject), ...clipInputs));
}
function polygonComponentsArea(components) {
  return components.reduce((sum, component) => sum + Math.abs(polygonArea(component.outer)) - component.holes.reduce((holeSum, hole) => holeSum + Math.abs(polygonArea(hole)), 0), 0);
}
function toClippingPolygon(points, tolerance) {
  const normalized = normalizedOuter(sanitizePolygonRing(points, tolerance));
  if (normalized.length < 3 || Math.abs(polygonArea(normalized)) <= MIN_AREA)
    return [];
  const intersections = polygonRingSelfIntersections(normalized);
  if (intersections.length > 0) {
    const first = intersections[0];
    throw new Error(`Invalid polygon ring: edges ${first.firstEdge} and ${first.secondEdge} intersect`);
  }
  return [closeRing(normalized)];
}
function runUnionWithPrecisionRetries(operation) {
  try {
    return operation(undefined, false);
  } catch (error3) {
    if (!isRecoverablePolygonClippingFailure(error3))
      throw error3;
  }
  try {
    return operation(undefined, true);
  } catch (error3) {
    if (!isRecoverablePolygonClippingFailure(error3))
      throw error3;
  }
  let lastError;
  for (const tolerance of BOOLEAN_RETRY_TOLERANCES) {
    for (const pairwise of [false, true]) {
      try {
        return operation(tolerance, pairwise);
      } catch (error3) {
        if (!isRecoverablePolygonClippingFailure(error3, true))
          throw error3;
        lastError = error3;
      }
    }
  }
  throw lastError;
}
function isRecoverablePolygonClippingFailure(error3, precisionRetry = false) {
  const message = error3 instanceof Error ? error3.message : String(error3);
  return message.includes("Unable to complete output ring") || message.includes("infinite loop") || message.includes("sweep line") || precisionRetry && message.includes("Invalid polygon ring");
}
function toClippingComponent(component) {
  const outer = normalizedOuter(sanitizePolygonRing(component.outer));
  if (outer.length < 3 || Math.abs(polygonArea(outer)) <= MIN_AREA)
    return [];
  const holes = component.holes.map((hole) => normalizedHole(sanitizePolygonRing(hole))).filter((hole) => hole.length >= 3 && Math.abs(polygonArea(hole)) > MIN_AREA);
  return [closeRing(outer), ...holes.map(closeRing)];
}
function closeRing(points) {
  return [...points.map((point) => [point.x, point.y]), [points[0].x, points[0].y]];
}
function fromClippingMultiPolygon(multiPolygon) {
  return multiPolygon.flatMap((polygon) => {
    const rings = polygon.map(fromClippingRing).filter((ring) => ring.length >= 3);
    if (rings.length === 0)
      return [];
    const outer = normalizedOuter(rings[0]);
    if (Math.abs(polygonArea(outer)) <= MIN_AREA)
      return [];
    return [{
      outer,
      holes: rings.slice(1).map(normalizedHole).filter((hole) => Math.abs(polygonArea(hole)) > MIN_AREA)
    }];
  });
}
function fromClippingRing(ring) {
  const points = sanitizePolygonRing(ring.map(([x, y]) => ({ x, y })));
  if (points.length > 1 && samePoint(points[0], points.at(-1)))
    points.pop();
  return points;
}
function normalizedOuter(points) {
  const normalized = normalizedPolygon(points);
  return polygonArea(normalized) < 0 ? [...normalized].reverse() : normalized;
}
function normalizedHole(points) {
  const normalized = normalizedPolygon(points);
  return polygonArea(normalized) > 0 ? [...normalized].reverse() : normalized;
}
function samePoint(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= 0.000000001;
}

// ../three-roads-inspect/packages/core/src/validation/surface-clearance.ts
function connectorObjectClearanceViolations(network, step = 0.5, minimumArea = 0.005) {
  const blockingObjects = (network.objects ?? []).filter((object) => object.junctionId && object.polygon && object.polygon.length >= 3 && (object.kind === "island" || object.kind === "platform"));
  return blockingObjects.flatMap((object) => network.roads.filter((road) => road.kind === "connector" && road.junctionId === object.junctionId).flatMap((road) => sampleLanePolygons(road, step).flatMap((laneSurface) => {
    const overlapArea = polygonComponentsArea(intersectPolygons(laneSurface.points, [object.polygon]));
    if (overlapArea <= minimumArea)
      return [];
    return [{
      roadId: road.id,
      junctionId: object.junctionId,
      objectId: object.id,
      overlapArea
    }];
  })));
}

// ../three-roads-inspect/packages/core/src/geometry/minimum-radius.ts
var MINIMUM_RADIUS_ABSOLUTE_TOLERANCE = 0.01;
var MINIMUM_RADIUS_RELATIVE_TOLERANCE = 0.0001;
function isBelowMinimumRadius(radius, minimumRadius) {
  const tolerance = Math.max(MINIMUM_RADIUS_ABSOLUTE_TOLERANCE, minimumRadius * MINIMUM_RADIUS_RELATIVE_TOLERANCE);
  return radius < minimumRadius - tolerance;
}

// ../three-roads-inspect/packages/core/src/geometry/reference-offset-kinematics.ts
function evaluateReferenceOffsetKinematics(referenceLine, s, offset) {
  if (![offset.value, offset.first, offset.second].every(Number.isFinite)) {
    throw new Error("Reference offset kinematics must be finite");
  }
  const pose = evaluateReferenceLine(referenceLine, s);
  const curvatureRate = referenceCurvatureRateAt(referenceLine, s);
  const normal = leftNormal(pose.heading);
  const tangentFactor = 1 - pose.curvature * offset.value;
  const lateralFactor = offset.first;
  const speedRatio = Math.hypot(tangentFactor, lateralFactor);
  if (speedRatio <= 0.0000001)
    throw new Error("Reference offset reaches the curvature singularity");
  const numerator = pose.curvature * tangentFactor ** 2 + tangentFactor * offset.second + curvatureRate * offset.value * offset.first + 2 * pose.curvature * offset.first ** 2;
  return {
    x: pose.x + normal.x * offset.value,
    y: pose.y + normal.y * offset.value,
    heading: pose.heading + Math.atan2(lateralFactor, tangentFactor),
    curvature: numerator / speedRatio ** 3,
    speedRatio
  };
}
function referenceCurvatureRateAt(referenceLine, s) {
  const segment = segmentAt(referenceLine, s);
  if (segment.kind === "spiral") {
    return (segment.curvatureEnd - segment.curvatureStart) / segment.length;
  }
  if (segment.kind !== "param-poly3")
    return 0;
  const totalLength = referenceLineLength(referenceLine);
  const step = Math.min(0.01, Math.max(0.00001, totalLength * 0.000001));
  const before = Math.max(0, s - step);
  const after = Math.min(totalLength, s + step);
  if (after <= before)
    return 0;
  return (evaluateReferenceLine(referenceLine, after).curvature - evaluateReferenceLine(referenceLine, before).curvature) / (after - before);
}
function segmentAt(referenceLine, s) {
  const station = Math.max(0, Math.min(referenceLineLength(referenceLine), s));
  return referenceLine.geometry.find((segment) => station >= segment.s - 0.0000001 && station <= segment.s + segment.length + 0.0000001) ?? referenceLine.geometry.at(-1);
}

// ../three-roads-inspect/packages/core/src/lanes/lane-plan-kinematics.ts
function evaluateLaneCenterPlanKinematics(road, section, lane, s) {
  const localS = s - section.s;
  const innerOrdinal = Math.sign(lane.id) * (Math.abs(lane.id) - 1);
  const inner = laneBoundaryOffsetKinematicsAt(section, innerOrdinal, localS);
  const outer = laneBoundaryOffsetKinematicsAt(section, lane.id, localS);
  const center = scale(add2(inner, outer), 0.5);
  const roadOffset = stationRecordKinematics(road.laneOffsets, s, "s");
  const surfaceOffset = add2(center, roadOffset);
  const roll = stationRecordKinematics(road.superelevation, s, "s");
  const cosine = Math.cos(roll.value);
  const sine = Math.sin(roll.value);
  const projected = {
    value: surfaceOffset.value * cosine,
    first: surfaceOffset.first * cosine - surfaceOffset.value * sine * roll.first,
    second: surfaceOffset.second * cosine - 2 * surfaceOffset.first * sine * roll.first - surfaceOffset.value * cosine * roll.first ** 2 - surfaceOffset.value * sine * roll.second
  };
  return evaluateReferenceOffsetKinematics(road.referenceLine, s, projected);
}
function laneBoundaryOffsetKinematicsAt(section, boundaryOrdinal, localS) {
  if (boundaryOrdinal === 0)
    return zero();
  const lanes = new Map(section.lanes.map((lane) => [lane.id, lane]));
  const sign = Math.sign(boundaryOrdinal);
  let offset = zero();
  for (let order = 1;order <= Math.abs(boundaryOrdinal); order++) {
    const lane = lanes.get(sign * order);
    if (!lane)
      continue;
    const border = localRecordKinematics(lane.borders, localS, "sOffset");
    offset = border ? scale(clampNonNegative(border), sign) : add2(offset, scale(clampNonNegative(localRecordKinematics(lane.widths, localS, "sOffset") ?? zero()), sign));
  }
  return offset;
}
function stationRecordKinematics(records, station, key) {
  return localRecordKinematics(records, station, key) ?? zero();
}
function localRecordKinematics(records, station, key) {
  const record = [...records ?? []].sort((left, right) => Number(left[key]) - Number(right[key])).filter((candidate) => Number(candidate[key]) <= station + 0.0000001).at(-1);
  if (!record)
    return;
  const local = station - Number(record[key]);
  return {
    value: evaluateCubic(record, local),
    first: evaluateCubicDerivative(record, local),
    second: evaluateCubicSecondDerivative(record, local)
  };
}
function clampNonNegative(value) {
  return value.value < 0 ? zero() : value;
}
function add2(left, right) {
  return {
    value: left.value + right.value,
    first: left.first + right.first,
    second: left.second + right.second
  };
}
function scale(value, factor) {
  return { value: value.value * factor, first: value.first * factor, second: value.second * factor };
}
function zero() {
  return { value: 0, first: 0, second: 0 };
}

// ../three-roads-inspect/packages/core/src/validation/road-design-validation.ts
var VALUE_TOLERANCE = 0.0000001;
function validateRoadDesignRanges(road, recommendationSeverity = "error") {
  const diagnostics = [];
  const ranges = [...road.designRanges ?? []].sort((left, right) => left.sStart - right.sStart);
  for (let index = 0;index < ranges.length; index++) {
    const range = ranges[index];
    if (!validRange(road, range)) {
      diagnostics.push(error3(road, "road-design-range", `Road ${road.id} has an invalid design range ${range.sStart}..${range.sEnd}`));
      continue;
    }
    if (index > 0 && range.sStart < ranges[index - 1].sEnd - VALUE_TOLERANCE) {
      diagnostics.push(error3(road, "road-design-range-overlap", `Road ${road.id} has overlapping design ranges at s=${range.sStart}`));
    }
    validateLimitValues(road, range.limits, diagnostics);
    validateSampledLimits(road, range, diagnostics, recommendationSeverity);
    validateSegmentLimits(road, range, diagnostics, recommendationSeverity);
  }
  return diagnostics;
}
function validateSampledLimits(road, range, diagnostics, severity) {
  const stations = sampleStations(range.sStart, range.sEnd, 1);
  const radiusLimit = range.limits.minimumHorizontalRadius;
  if (radiusLimit !== undefined) {
    const violation = stations.find((s) => isBelowMinimumRadius(radiusFromCurvature(evaluateRoadReference(road, s).curvature), radiusLimit));
    if (violation !== undefined) {
      const curvature = Math.abs(evaluateRoadReference(road, violation).curvature);
      diagnostics.push(designDiagnostic(road, severity, "road-design-horizontal-radius", `Road ${road.id} radius ${(1 / curvature).toFixed(2)} m is below ${radiusLimit.toFixed(2)} m at s=${violation.toFixed(2)}`));
    }
  }
  const laneRadiusLimit = range.limits.minimumLaneCenterRadius;
  if (laneRadiusLimit !== undefined) {
    for (const s of stations) {
      const section = findLaneSection(road, s);
      const violation = section.lanes.find((lane) => lane.id !== 0 && TRAFFIC_LANE_TYPES2.has(lane.type) && laneWidthAt(lane, s - section.s) >= 1 && isBelowMinimumRadius(radiusFromCurvature(evaluateLaneCenterPlanKinematics(road, section, lane, s).curvature), laneRadiusLimit));
      if (!violation)
        continue;
      const curvature = Math.abs(evaluateLaneCenterPlanKinematics(road, section, violation, s).curvature);
      diagnostics.push(designDiagnostic(road, severity, "road-design-lane-horizontal-radius", `Road ${road.id} lane ${violation.id} radius ${(1 / curvature).toFixed(2)} m is below ${laneRadiusLimit.toFixed(2)} m at s=${s.toFixed(2)}`));
      break;
    }
  }
  const maximumGrade = range.limits.maximumGrade;
  if (maximumGrade !== undefined) {
    const violation = stations.find((s) => Math.abs(gradeAt(road.elevation, s)) > maximumGrade + 0.0000001);
    if (violation !== undefined) {
      diagnostics.push(designDiagnostic(road, severity, "road-design-grade", `Road ${road.id} exceeds grade ${maximumGrade} at s=${violation.toFixed(2)}`));
    }
  }
  const maximumSuperelevation = range.limits.maximumSuperelevation;
  if (maximumSuperelevation !== undefined) {
    const violation = stations.find((s) => Math.abs(roadSuperelevationAt(road, s)) > maximumSuperelevation + 0.0000001);
    if (violation !== undefined) {
      diagnostics.push(designDiagnostic(road, severity, "road-design-superelevation", `Road ${road.id} exceeds superelevation ${maximumSuperelevation} rad at s=${violation.toFixed(2)}`));
    }
  }
  const maximumCurvatureRate = range.limits.maximumCurvatureRate;
  if (maximumCurvatureRate !== undefined) {
    for (let index = 1;index < stations.length; index++) {
      const before = evaluateRoadReference(road, stations[index - 1]).curvature;
      const after = evaluateRoadReference(road, stations[index]).curvature;
      const rate = Math.abs((after - before) / (stations[index] - stations[index - 1]));
      if (rate <= maximumCurvatureRate + 0.0000001)
        continue;
      diagnostics.push(designDiagnostic(road, severity, "road-design-curvature-rate", `Road ${road.id} curvature rate ${rate.toFixed(6)} 1/m2 exceeds ${maximumCurvatureRate} near s=${stations[index].toFixed(2)}`));
      break;
    }
  }
}
function validateSegmentLimits(road, range, diagnostics, severity) {
  const minimumSpiralLength = range.limits.minimumSpiralLength;
  if (minimumSpiralLength !== undefined) {
    const shortSpiral = road.referenceLine.geometry.find((segment) => segment.kind === "spiral" && overlaps(segment.s, segment.s + segment.length, range.sStart, range.sEnd) && segment.length < minimumSpiralLength - VALUE_TOLERANCE);
    if (shortSpiral) {
      diagnostics.push(designDiagnostic(road, severity, "road-design-spiral-length", `Road ${road.id} spiral at s=${shortSpiral.s} is shorter than ${minimumSpiralLength} m`));
    }
  }
  if (!range.limits.requireCurvatureContinuity)
    return;
  const geometry = road.referenceLine.geometry;
  for (let index = 1;index < geometry.length; index++) {
    const station = geometry[index].s;
    if (station < range.sStart - VALUE_TOLERANCE || station > range.sEnd + VALUE_TOLERANCE)
      continue;
    const before = evaluateGeometrySegment(geometry[index - 1], geometry[index - 1].length).curvature;
    const after = evaluateGeometrySegment(geometry[index], 0).curvature;
    if (Math.abs(before - after) <= 0.0000001)
      continue;
    diagnostics.push(designDiagnostic(road, severity, "road-design-curvature-discontinuity", `Road ${road.id} curvature jumps at s=${station}`));
    break;
  }
}
function validateLimitValues(road, limits, diagnostics) {
  const positiveValues = [
    limits.designSpeedKph,
    limits.minimumHorizontalRadius,
    limits.minimumLaneCenterRadius,
    limits.maximumCurvatureRate,
    limits.minimumSpiralLength
  ];
  const nonNegativeValues = [limits.maximumGrade, limits.maximumSuperelevation];
  if (positiveValues.some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0)) || nonNegativeValues.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) {
    diagnostics.push(error3(road, "road-design-limit", `Road ${road.id} has a non-positive design limit`));
  }
}
var TRAFFIC_LANE_TYPES2 = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "shared",
  "bus"
]);
function radiusFromCurvature(curvature) {
  const magnitude = Math.abs(curvature);
  return magnitude > 0 ? 1 / magnitude : Number.POSITIVE_INFINITY;
}
function sampleStations(start, end, maximumStep) {
  const count = Math.max(1, Math.ceil((end - start) / maximumStep));
  return Array.from({ length: count + 1 }, (_, index) => start + (end - start) * index / count);
}
function validRange(road, range) {
  return Number.isFinite(range.sStart) && Number.isFinite(range.sEnd) && range.sStart >= 0 && range.sEnd <= road.length + VALUE_TOLERANCE && range.sEnd > range.sStart;
}
function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd - VALUE_TOLERANCE && rightStart < leftEnd - VALUE_TOLERANCE;
}
function error3(road, code, message) {
  return { severity: "error", code, message, roadId: road.id };
}
function designDiagnostic(road, severity, code, message) {
  return { severity, code, message, roadId: road.id };
}

// ../three-roads-inspect/packages/core/src/validation/junction-stream-validation.ts
function validateJunctionStreams(network, junction) {
  const diagnostics = [];
  const streams = junction.trafficStreams ?? [];
  const streamIds = new Set;
  const portIds = new Set((junction.ports ?? []).map((port) => port.id));
  for (const stream of streams) {
    if (streamIds.has(stream.id))
      diagnostics.push(error4(junction, "duplicate-junction-stream-id", `Junction ${junction.id} repeats stream ${stream.id}`));
    streamIds.add(stream.id);
    const road = network.roads.find((candidate) => candidate.id === stream.roadId);
    const section = road?.laneSections.find((candidate, index) => {
      const nextS = road.laneSections[index + 1]?.s ?? road.length;
      return candidate.s <= stream.s + 0.0000001 && stream.s <= nextS + 0.0000001;
    });
    if (!road || !section?.lanes.some((lane) => lane.id === stream.laneId)) {
      diagnostics.push(error4(junction, "junction-stream-lane-missing", `Junction ${junction.id} stream ${stream.id} cannot resolve its lane`));
    }
    if (!portIds.has(stream.portId))
      diagnostics.push(error4(junction, "junction-stream-port-missing", `Junction ${junction.id} stream ${stream.id} references missing port ${stream.portId}`));
    if (stream.movement !== "through" && !stream.contactGroupId) {
      diagnostics.push(error4(junction, "junction-stream-contact-group", `Junction ${junction.id} ${stream.movement} stream ${stream.id} has no contact group`));
    }
    if (stream.contactGroupId !== undefined && stream.contactGroupId.trim().length === 0) {
      diagnostics.push(error4(junction, "junction-stream-contact-group", `Junction ${junction.id} stream ${stream.id} has an empty contact group`));
    }
    if (!Number.isFinite(stream.travelHeading) || stream.conflictEnvelopeWidth <= 0 || stream.sStart < 0 || stream.sEnd > (road?.length ?? -1) || stream.sStart > stream.s || stream.sEnd < stream.s) {
      diagnostics.push(error4(junction, "junction-stream-geometry", `Junction ${junction.id} stream ${stream.id} has invalid occupancy geometry`));
    }
  }
  validateContactGroups(junction, streams, diagnostics);
  const zoneIds = new Set((junction.conflictZones ?? []).map((zone) => zone.id));
  const interactionIds = new Set;
  const pairKeys = new Set;
  const zoneClaims = new Map;
  for (const interaction of junction.streamInteractions ?? []) {
    if (interactionIds.has(interaction.id))
      diagnostics.push(error4(junction, "duplicate-junction-stream-interaction-id", `Junction ${junction.id} repeats stream interaction ${interaction.id}`));
    interactionIds.add(interaction.id);
    const pairKey = [...interaction.streamIds].sort().join("\x00");
    if (pairKeys.has(pairKey))
      diagnostics.push(error4(junction, "duplicate-junction-stream-interaction-pair", `Junction ${junction.id} repeats stream pair ${interaction.streamIds.join("/")}`));
    pairKeys.add(pairKey);
    for (const streamId of interaction.streamIds) {
      if (!streamIds.has(streamId))
        diagnostics.push(error4(junction, "junction-stream-interaction-stream-missing", `Junction ${junction.id} interaction references missing stream ${streamId}`));
    }
    if ((interaction.kind === "compatible" || interaction.kind === "diverge") && interaction.conflictZoneIds.length > 0) {
      diagnostics.push(error4(junction, "junction-compatible-stream-conflict", `Junction ${junction.id} compatible stream interaction owns a conflict`));
    }
    validateControl(junction, interaction.streamIds, interaction.kind, interaction.priorityStreamId, interaction.control, diagnostics);
    for (const zoneId of interaction.conflictZoneIds) {
      if (!zoneIds.has(zoneId))
        diagnostics.push(error4(junction, "junction-stream-conflict-zone-missing", `Junction ${junction.id} stream interaction references missing zone ${zoneId}`));
      zoneClaims.set(zoneId, (zoneClaims.get(zoneId) ?? 0) + 1);
    }
  }
  for (let leftIndex = 0;leftIndex < streams.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1;rightIndex < streams.length; rightIndex++) {
      const key = [streams[leftIndex].id, streams[rightIndex].id].sort().join("\x00");
      if (!pairKeys.has(key))
        diagnostics.push(error4(junction, "junction-stream-interaction-pair-missing", `Junction ${junction.id} has no interaction for stream pair ${key.replace("\x00", "/")}`));
    }
  }
  for (const zone of junction.conflictZones ?? []) {
    if (!zone.streamIds)
      continue;
    for (const streamId of zone.streamIds) {
      if (!streamIds.has(streamId))
        diagnostics.push(error4(junction, "conflict-zone-stream-missing", `Junction ${junction.id} zone ${zone.id} references missing stream ${streamId}`));
    }
    if (zoneClaims.get(zone.id) !== 1)
      diagnostics.push(error4(junction, "conflict-zone-stream-owner", `Junction ${junction.id} zone ${zone.id} must have one stream interaction owner`));
  }
  return diagnostics;
}
function validateContactGroups(junction, streams, diagnostics) {
  const streamsByGroup = new Map;
  for (const stream of streams) {
    if (!stream.contactGroupId)
      continue;
    const group = streamsByGroup.get(stream.contactGroupId) ?? [];
    group.push(stream);
    streamsByGroup.set(stream.contactGroupId, group);
  }
  for (const stream of streams) {
    if (stream.movement === "through" || !stream.contactGroupId)
      continue;
    const counterparts = (streamsByGroup.get(stream.contactGroupId) ?? []).filter((candidate) => candidate.id !== stream.id);
    if (!counterparts.some((candidate) => candidate.movement === "through" || candidate.movement === stream.movement)) {
      diagnostics.push(error4(junction, "junction-stream-contact-group-incomplete", `Junction ${junction.id} ${stream.movement} stream ${stream.id} has no contact counterpart`));
    }
  }
}
function validateControl(junction, participantIds, interactionKind, priorityMirror, control, diagnostics) {
  if (interactionKind === "compatible" || interactionKind === "diverge") {
    if (control.kind !== "none")
      diagnostics.push(error4(junction, "junction-stream-control-superfluous", `Junction ${junction.id} compatible streams must use no control`));
    return;
  }
  if (control.kind === "none" || control.kind === "unresolved") {
    diagnostics.push(error4(junction, "junction-stream-control-unresolved", `Junction ${junction.id} crossing stream control is ${control.kind}`));
    return;
  }
  if (control.kind === "fixed-priority") {
    if (!participantIds.includes(control.priorityParticipantId) || !participantIds.includes(control.yieldingParticipantId) || priorityMirror !== control.priorityParticipantId) {
      diagnostics.push(error4(junction, "junction-stream-fixed-priority-members", `Junction ${junction.id} stream priority members are inconsistent`));
    }
    return;
  }
  if (priorityMirror)
    diagnostics.push(error4(junction, "junction-stream-dynamic-priority", `Junction ${junction.id} dynamic stream control exposes fixed priority`));
  if (control.kind === "zipper" && interactionKind !== "merge")
    diagnostics.push(error4(junction, "junction-stream-zipper-control", `Junction ${junction.id} can only zipper merge streams`));
}
function error4(junction, code, message) {
  return { severity: "error", code, message, junctionId: junction.id };
}

// ../three-roads-inspect/packages/core/src/validation/weaving-section-validation.ts
function validateCompiledWeavingSections(network) {
  const diagnostics = [];
  const ids = new Set;
  for (const weaving of network.weavingSections ?? []) {
    if (ids.has(weaving.id))
      diagnostics.push(error5(weaving, "duplicate-weaving-section-id", `Duplicate weaving section ${weaving.id}`));
    ids.add(weaving.id);
    const road = network.roads.find((candidate) => candidate.id === weaving.roadId);
    if (!road) {
      diagnostics.push(error5(weaving, "weaving-road-missing", `Weaving section ${weaving.id} has no road ${weaving.roadId}`));
      continue;
    }
    if (!network.junctions.some((junction) => junction.id === weaving.entryJunctionId)) {
      diagnostics.push(error5(weaving, "weaving-entry-junction-missing", `Weaving section ${weaving.id} has no entry junction`));
    }
    if (!network.junctions.some((junction) => junction.id === weaving.exitJunctionId)) {
      diagnostics.push(error5(weaving, "weaving-exit-junction-missing", `Weaving section ${weaving.id} has no exit junction`));
    }
    if (weaving.lanePairs.length === 0) {
      diagnostics.push(error5(weaving, "weaving-lane-pairs-empty", `Weaving section ${weaving.id} has no lane pairs`));
      continue;
    }
    let station = weaving.sStart;
    for (const pair of weaving.lanePairs) {
      const section = road.laneSections.find((candidate) => candidate.id === pair.sectionId);
      const through = section?.lanes.find((lane) => lane.id === pair.throughLaneId);
      const auxiliary = section?.lanes.find((lane) => lane.id === pair.weavingLaneId);
      if (!section || !through || !auxiliary) {
        diagnostics.push(error5(weaving, "weaving-lane-pair-missing", `Weaving section ${weaving.id} has an unresolved lane pair`, pair.sectionId));
        continue;
      }
      if (Math.abs(pair.sStart - station) > 0.000001) {
        diagnostics.push(error5(weaving, "weaving-lane-pair-gap", `Weaving section ${weaving.id} has a lane-pair coverage gap`, pair.sectionId));
      }
      if (Math.sign(through.id) !== Math.sign(auxiliary.id) || Math.abs(Math.abs(auxiliary.id) - Math.abs(through.id)) !== 1) {
        diagnostics.push(error5(weaving, "weaving-lane-pair-not-adjacent", `Weaving section ${weaving.id} lane pair is not adjacent`, pair.sectionId));
      }
      const auxiliaryIsOutside = Math.abs(auxiliary.id) > Math.abs(through.id);
      const throughBoundary = auxiliaryIsOutside ? "outer" : "inner";
      const auxiliaryBoundary = auxiliaryIsOutside ? "inner" : "outer";
      const sharedBoundary = Math.sign(through.id) * Math.min(Math.abs(through.id), Math.abs(auxiliary.id));
      const boundaryMarkings = [
        ...(through.markings ?? []).filter((marking) => marking.boundary === throughBoundary),
        ...(auxiliary.markings ?? []).filter((marking) => marking.boundary === auxiliaryBoundary)
      ];
      if (!boundaryMarkings.some((marking) => marking.laneChange === "both" && (marking.sStart ?? section.s) <= pair.sStart + 0.0000001 && (marking.sEnd ?? pair.sEnd) >= pair.sEnd - 0.0000001)) {
        diagnostics.push(error5(weaving, "weaving-lane-change-policy", `Weaving section ${weaving.id} shared boundary ${sharedBoundary} does not permit both changes`, pair.sectionId));
      }
      station = pair.sEnd;
    }
    if (Math.abs(station - weaving.sEnd) > 0.000001) {
      diagnostics.push(error5(weaving, "weaving-lane-pair-gap", `Weaving section ${weaving.id} does not cover its full range`));
    }
  }
  for (let left = 0;left < (network.weavingSections?.length ?? 0); left++) {
    for (let right = left + 1;right < network.weavingSections.length; right++) {
      const a = network.weavingSections[left];
      const b = network.weavingSections[right];
      if (a.roadId === b.roadId && a.throughLaneRole === b.throughLaneRole && a.weavingLaneRole === b.weavingLaneRole && a.sStart < b.sEnd - 0.0000001 && a.sEnd > b.sStart + 0.0000001) {
        diagnostics.push(error5(b, "weaving-sections-overlap", `Weaving sections ${a.id} and ${b.id} overlap`));
      }
    }
  }
  return diagnostics;
}
function error5(weaving, code, message, sectionId) {
  return { severity: "error", code, message, roadId: weaving.roadId, sectionId };
}

// ../three-roads-inspect/packages/core/src/validation/road-structure-validation.ts
function validateCompiledRoadStructures(network) {
  const diagnostics = [];
  const ids = new Set;
  for (const structure of network.roadStructures ?? []) {
    if (ids.has(structure.id))
      diagnostics.push(error6(structure.roadId, "duplicate-road-structure-id", `Duplicate road structure ${structure.id}`));
    ids.add(structure.id);
    const road = network.roads.find((candidate) => candidate.id === structure.roadId);
    if (!road) {
      diagnostics.push(error6(structure.roadId, "road-structure-road-missing", `Road structure ${structure.id} has no road ${structure.roadId}`));
      continue;
    }
    if (structure.sStart < 0 || structure.sEnd > road.length || structure.sEnd <= structure.sStart) {
      diagnostics.push(error6(road.id, "road-structure-range-invalid", `Road structure ${structure.id} has an invalid range`));
    }
    if (structure.deckTMax <= structure.deckTMin || structure.structuralThickness <= 0 || structure.minimumLateralClearance < 0) {
      diagnostics.push(error6(road.id, "road-structure-properties-invalid", `Road structure ${structure.id} has invalid structural properties`));
    }
    const actualClearance = Math.min(structure.actualMinimumT - structure.deckTMin, structure.deckTMax - structure.actualMaximumT);
    if (Math.abs(actualClearance - structure.actualMinimumLateralClearance) > 0.0000001) {
      diagnostics.push(error6(road.id, "road-structure-clearance-mismatch", `Road structure ${structure.id} has inconsistent compiled clearance`));
    }
    if (structure.actualMinimumLateralClearance + 0.0000001 < structure.minimumLateralClearance) {
      diagnostics.push(error6(road.id, "road-structure-lateral-clearance", `Road structure ${structure.id} violates lateral clearance`));
    }
  }
  for (const relation of network.gradeSeparations ?? []) {
    if (!relation.structureId)
      continue;
    const structure = network.roadStructures?.find((candidate) => candidate.id === relation.structureId);
    if (!structure) {
      diagnostics.push(error6(relation.upperRoad.roadId, "grade-separation-structure-missing", `Grade separation ${relation.id} has no road structure ${relation.structureId}`));
      continue;
    }
    if (structure.roadId !== relation.upperRoad.roadId || structure.kind !== relation.kind || Math.abs(structure.structuralThickness - relation.deckThickness) > 0.0000001 || Math.abs(structure.sStart - relation.deckExtent.sStart) > 0.0000001 || Math.abs(structure.sEnd - relation.deckExtent.sEnd) > 0.0000001) {
      diagnostics.push(error6(relation.upperRoad.roadId, "grade-separation-structure-mismatch", `Grade separation ${relation.id} differs from road structure ${structure.id}`));
    }
  }
  return diagnostics;
}
function error6(roadId, code, message) {
  return { severity: "error", code, message, roadId };
}

// ../three-roads-inspect/packages/core/src/validation/lane-marking-conflict-validation.ts
function validateLaneBoundaryMarkingConflicts(network) {
  const diagnostics = [];
  for (const road of network.roads) {
    for (const section of road.laneSections) {
      const boundaries = new Map;
      const sectionEnd = laneSectionEndS(road, section);
      for (const lane of section.lanes) {
        for (const marking of lane.markings ?? []) {
          const boundary = physicalBoundaryOrdinal(lane.id, marking.boundary);
          if (boundary === undefined)
            continue;
          boundaries.set(boundary, [
            ...boundaries.get(boundary) ?? [],
            {
              lane,
              marking,
              sStart: Math.max(section.s, marking.sStart ?? section.s),
              sEnd: Math.min(sectionEnd, marking.sEnd ?? sectionEnd)
            }
          ]);
        }
      }
      for (const [boundary, markings] of boundaries) {
        for (let leftIndex = 0;leftIndex < markings.length; leftIndex++) {
          for (let rightIndex = leftIndex + 1;rightIndex < markings.length; rightIndex++) {
            const left = markings[leftIndex];
            const right = markings[rightIndex];
            if (Math.max(left.sStart, right.sStart) >= Math.min(left.sEnd, right.sEnd) - 0.0000001)
              continue;
            if (left.marking.kind === right.marking.kind && normalizedLaneChange(left.marking) === normalizedLaneChange(right.marking) && normalizedColor(left.marking) === normalizedColor(right.marking) && normalizedWidth(left.marking) === normalizedWidth(right.marking))
              continue;
            diagnostics.push({
              severity: "error",
              code: "lane-boundary-marking-conflict",
              message: `Road ${road.id} boundary ${boundary} has conflicting markings ${left.marking.id} and ${right.marking.id}`,
              roadId: road.id,
              sectionId: section.id,
              laneId: left.lane.id
            });
          }
        }
      }
    }
  }
  return diagnostics;
}
function physicalBoundaryOrdinal(laneId, boundary) {
  if (boundary === "center")
    return 0;
  if (!boundary || laneId === 0)
    return;
  return boundary === "outer" ? laneId : Math.sign(laneId) * (Math.abs(laneId) - 1);
}
function normalizedLaneChange(marking) {
  return marking.laneChange ?? "none";
}
function normalizedColor(marking) {
  return marking.color ?? "white";
}
function normalizedWidth(marking) {
  return marking.width ?? 0.15;
}

// ../three-roads-inspect/packages/core/src/topology/lane-graph.ts
function buildLaneGraph(network) {
  const nodes = network.roads.flatMap((road) => buildRoadLaneNodes(road));
  const nodeMap = new Map(nodes.map((node) => [laneNodeKey(node), node]));
  const edges = [
    ...buildSectionContinuationEdges(network, nodeMap),
    ...buildLaneChangeEdges(network, nodeMap),
    ...buildExplicitLaneLinkEdges(network, nodeMap),
    ...buildJunctionEdges(network, nodeMap)
  ];
  return { nodes, edges: annotateWeavingSections(network, edges) };
}
function buildLaneChangeEdges(network, nodeMap) {
  const edges = [];
  const edgeIds = new Set;
  for (const road of network.roads) {
    if (road.kind === "connector")
      continue;
    for (const section of road.laneSections) {
      const sectionEnd = laneSectionEndS(road, section);
      for (const lane of section.lanes) {
        if (lane.id === 0)
          continue;
        for (const marking of lane.markings ?? []) {
          if (!marking.laneChange || marking.laneChange === "none" || marking.boundary === "center")
            continue;
          const targetLaneId = adjacentLaneId(lane.id, marking.boundary ?? "outer");
          const targetLane = section.lanes.find((candidate) => candidate.id === targetLaneId);
          if (!targetLane || !laneChangeCompatible(lane, targetLane))
            continue;
          const sStart = Math.max(section.s, marking.sStart ?? section.s);
          const sEnd = Math.min(sectionEnd, marking.sEnd ?? sectionEnd);
          if (sEnd <= sStart + 0.0000001)
            continue;
          const station = (sStart + sEnd) * 0.5;
          addPermittedLaneChange(edges, edgeIds, nodeMap, road, section, lane, targetLane, station, sStart, sEnd, marking.laneChange);
          addPermittedLaneChange(edges, edgeIds, nodeMap, road, section, targetLane, lane, station, sStart, sEnd, marking.laneChange);
        }
      }
    }
  }
  return edges;
}
function addPermittedLaneChange(edges, edgeIds, nodeMap, road, section, fromLane, toLane, station, sStart, sEnd, permission) {
  const change = toLane.id > fromLane.id ? "increase" : "decrease";
  if (permission !== "both" && permission !== change)
    return;
  const from = nodeMap.get(laneNodeKey({ roadId: road.id, sectionId: section.id, laneId: fromLane.id }));
  const to = nodeMap.get(laneNodeKey({ roadId: road.id, sectionId: section.id, laneId: toLane.id }));
  if (!from || !to)
    return;
  const edge = {
    ...makeEdge("lane-change", from, to, station, station, laneCenterPointInSection(road, section, fromLane.id, station), laneCenterPointInSection(road, section, toLane.id, station)),
    sStart,
    sEnd
  };
  edge.id = `${edge.id}|${sStart}:${sEnd}`;
  if (edgeIds.has(edge.id))
    return;
  edgeIds.add(edge.id);
  edges.push(edge);
}
function annotateWeavingSections(network, edges) {
  if (!network.weavingSections?.length)
    return edges;
  return edges.map((edge) => {
    const weavingSectionIds = network.weavingSections.filter((weaving) => edgeBelongsToWeaving(edge, weaving)).map((weaving) => weaving.id).sort();
    return weavingSectionIds.length > 0 ? { ...edge, weavingSectionIds } : edge;
  });
}
function edgeBelongsToWeaving(edge, weaving) {
  if (edge.kind === "lane-change" && edge.from.roadId === weaving.roadId && edge.to.roadId === weaving.roadId) {
    return weaving.lanePairs.some((pair) => pair.sectionId === edge.from.sectionId && pair.sectionId === edge.to.sectionId && new Set([pair.throughLaneId, pair.weavingLaneId]).has(edge.from.laneId) && new Set([pair.throughLaneId, pair.weavingLaneId]).has(edge.to.laneId) && (edge.sEnd ?? edge.fromS) > pair.sStart + 0.0000001 && (edge.sStart ?? edge.fromS) < pair.sEnd - 0.0000001);
  }
  if (edge.kind !== "junction")
    return false;
  if (edge.junctionId === weaving.entryJunctionId) {
    return weaving.lanePairs.some((pair) => edge.to.roadId === weaving.roadId && edge.to.sectionId === pair.sectionId && edge.to.laneId === pair.weavingLaneId);
  }
  if (edge.junctionId === weaving.exitJunctionId) {
    return weaving.lanePairs.some((pair) => edge.from.roadId === weaving.roadId && edge.from.sectionId === pair.sectionId && edge.from.laneId === pair.weavingLaneId);
  }
  return false;
}
function adjacentLaneId(laneId, boundary) {
  const sign = Math.sign(laneId);
  return boundary === "outer" ? laneId + sign : laneId - sign;
}
function laneChangeCompatible(left, right) {
  return laneTypesCompatible(left.type, right.type) && laneTravelSigns(left).some((sign) => laneTravelSigns(right).includes(sign)) && compatibleTrafficRoles(left, right) && accessClassesOverlap(left, right);
}
function accessClassesOverlap(left, right) {
  if (!left.access || !right.access)
    return true;
  return left.access.some((participant) => right.access.includes(participant));
}
function compatibleTrafficRoles(left, right) {
  const leftRole = left.operational?.trafficRole;
  const rightRole = right.operational?.trafficRole;
  return leftRole === undefined || rightRole === undefined || leftRole === rightRole;
}
function laneTravelSigns(lane) {
  return lane.direction === "both" ? [-1, 1] : [laneTravelSign(lane)];
}
var TRAFFIC_LANE_TYPES3 = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "shared",
  "bus",
  "stop"
]);
function laneTypesCompatible(left, right) {
  return left === right || TRAFFIC_LANE_TYPES3.has(left) && TRAFFIC_LANE_TYPES3.has(right);
}
function laneNodeKey(node) {
  return `${node.roadId}:${node.sectionId}:${node.laneId}`;
}
function buildRoadLaneNodes(road) {
  return [...road.laneSections].sort((a, b) => a.s - b.s).flatMap((section) => {
    const sStart = section.s;
    const sEnd = laneSectionEndS(road, section);
    return section.lanes.filter((lane) => lane.id !== 0 && lane.operational?.status !== "closed").map((lane) => ({
      roadId: road.id,
      sectionId: section.id,
      laneId: lane.id,
      laneType: lane.type,
      sStart,
      sEnd,
      start: laneCenterPointInSection(road, section, lane.id, sStart),
      end: laneCenterPointInSection(road, section, lane.id, sEnd),
      routing: structuredClone(road.routing),
      travelSigns: laneTravelSigns(lane),
      trafficRole: lane.operational?.trafficRole ?? lane.sourceRole,
      access: effectiveLaneAccess(lane)
    }));
  });
}
function buildSectionContinuationEdges(network, nodeMap) {
  const edges = [];
  for (const road of network.roads) {
    const sections = [...road.laneSections].sort((a, b) => a.s - b.s);
    for (let i = 0;i < sections.length - 1; i++) {
      const fromSection = sections[i];
      const toSection = sections[i + 1];
      const boundaryLocalFrom = toSection.s - fromSection.s;
      for (const lane of fromSection.lanes) {
        if (lane.id === 0)
          continue;
        if (laneWidthAt(lane, boundaryLocalFrom) <= MIN_CONTINUATION_WIDTH)
          continue;
        const match = matchLaneAcrossBoundary(fromSection, toSection, lane.id, boundaryLocalFrom);
        if (match === undefined)
          continue;
        const lower = nodeMap.get(laneNodeKey({ roadId: road.id, sectionId: fromSection.id, laneId: lane.id }));
        const upper = nodeMap.get(laneNodeKey({ roadId: road.id, sectionId: toSection.id, laneId: match }));
        const targetLane = toSection.lanes.find((candidate) => candidate.id === match);
        if (!lower || !upper || !targetLane || lower.trafficRole !== upper.trafficRole)
          continue;
        const commonSigns = laneTravelSigns(lane).filter((sign) => laneTravelSigns(targetLane).includes(sign));
        for (const sign of commonSigns) {
          const from = sign > 0 ? lower : upper;
          const to = sign > 0 ? upper : lower;
          edges.push(makeEdge("section-continuation", from, to, sign > 0 ? lower.sEnd : upper.sStart, sign > 0 ? upper.sStart : lower.sEnd, sign > 0 ? lower.end : upper.start, sign > 0 ? upper.start : lower.end));
        }
      }
    }
  }
  return edges;
}
var MIN_CONTINUATION_WIDTH = 0.05;
function matchLaneAcrossBoundary(fromSection, toSection, laneId, boundaryLocalFrom) {
  const fromLane = fromSection.lanes.find((lane) => lane.id === laneId);
  if (!fromLane)
    return;
  const fromOffsets = sortedInterval(laneOffsetsAt(fromSection, laneId, boundaryLocalFrom));
  let best;
  for (const candidate of toSection.lanes) {
    if (candidate.id === 0 || Math.sign(candidate.id) !== Math.sign(laneId))
      continue;
    const roleMatch = sourceRoleMatch(fromLane, candidate);
    if (roleMatch === "incompatible")
      continue;
    if (laneWidthAt(candidate, 0) <= MIN_CONTINUATION_WIDTH)
      continue;
    const toOffsets = sortedInterval(laneOffsetsAt(toSection, candidate.id, 0));
    const overlap = Math.min(fromOffsets.max, toOffsets.max) - Math.max(fromOffsets.min, toOffsets.min);
    if (overlap <= MIN_CONTINUATION_WIDTH)
      continue;
    const exactRole = roleMatch === "exact";
    if (!best || exactRole && !best.exactRole || exactRole === best.exactRole && overlap > best.overlap) {
      best = { laneId: candidate.id, overlap, exactRole };
    }
  }
  return best?.laneId;
}
function sourceRoleMatch(fromLane, toLane) {
  if (fromLane.sourceRole !== undefined && toLane.sourceRole !== undefined) {
    return fromLane.sourceRole === toLane.sourceRole ? "exact" : "incompatible";
  }
  return "fallback";
}
function sortedInterval(offsets) {
  return {
    min: Math.min(offsets.inner, offsets.outer),
    max: Math.max(offsets.inner, offsets.outer)
  };
}
function buildExplicitLaneLinkEdges(network, nodeMap) {
  const edges = [];
  for (const road of network.roads) {
    for (const section of road.laneSections) {
      for (const lane of section.lanes) {
        if (lane.id === 0)
          continue;
        const from = nodeMap.get(laneNodeKey({ roadId: road.id, sectionId: section.id, laneId: lane.id }));
        if (!from)
          continue;
        const successor = lane.links?.successor;
        if (successor) {
          const edge = makeLaneLinkEdge(network, nodeMap, road, lane, from, successor, "successor");
          if (edge)
            edges.push(edge);
        }
        const predecessor = lane.links?.predecessor;
        if (predecessor) {
          const edge = makeLaneLinkEdge(network, nodeMap, road, lane, from, predecessor, "predecessor");
          if (edge)
            edges.push(edge);
        }
      }
    }
  }
  return edges;
}
function makeLaneLinkEdge(network, nodeMap, sourceRoad, sourceLane, from, endpoint, direction) {
  if (!endpoint)
    return;
  const targetRoad = network.roads.find((candidate) => candidate.id === endpoint.roadId);
  const targetS = targetRoad ? endpoint.s ?? (endpoint.contactPoint === "start" ? 0 : targetRoad.length) : 0;
  const targetSection = targetRoad ? sectionAt3(targetRoad, targetS) : undefined;
  if (!targetRoad || !targetSection)
    return;
  const to = nodeMap.get(laneNodeKey({ roadId: targetRoad.id, sectionId: targetSection.id, laneId: endpoint.laneId }));
  if (!to)
    return;
  const fromS = direction === "successor" ? from.sEnd : from.sStart;
  const toS = targetS;
  const sourceSection = sourceRoad.laneSections.find((section) => section.id === from.sectionId);
  if (!sourceSection)
    return;
  return makeEdge("lane-link", from, to, fromS, toS, laneCenterPointInSection(sourceRoad, sourceSection, sourceLane.id, fromS), laneCenterPointInSection(targetRoad, targetSection, endpoint.laneId, toS), endpoint.junctionId);
}
function buildJunctionEdges(network, nodeMap) {
  const edges = [];
  for (const junction of network.junctions) {
    for (const connection of junction.connections) {
      const incomingRoad = network.roads.find((road) => road.id === connection.incomingRoadId);
      const connectingRoad = network.roads.find((road) => road.id === connection.connectingRoadId);
      if (!incomingRoad || !connectingRoad)
        continue;
      const incomingS = connection.incomingS ?? (connection.incomingContactPoint === "start" ? 0 : incomingRoad.length);
      const connectingS = connection.connectingS ?? (connection.contactPoint === "start" ? 0 : connectingRoad.length);
      const incomingSection = sectionAtIncoming3(incomingRoad, incomingS);
      const connectingSection = sectionAt3(connectingRoad, connectingS);
      if (!incomingSection || !connectingSection)
        continue;
      for (const link of connection.laneLinks) {
        const from = nodeMap.get(laneNodeKey({ roadId: incomingRoad.id, sectionId: incomingSection.id, laneId: link.from }));
        const to = nodeMap.get(laneNodeKey({ roadId: connectingRoad.id, sectionId: connectingSection.id, laneId: link.to }));
        if (!from || !to)
          continue;
        edges.push(makeEdge("junction", from, to, incomingS, connectingS, laneCenterPointInSection(incomingRoad, incomingSection, link.from, incomingS), laneCenterPointInSection(connectingRoad, connectingSection, link.to, connectingS), junction.id, connection.id));
      }
    }
  }
  return edges;
}
function sectionAt3(road, s) {
  return [...road.laneSections].sort((a, b) => a.s - b.s).filter((section) => section.s <= s + 0.0000001).at(-1);
}
function sectionAtIncoming3(road, s) {
  const sorted = [...road.laneSections].sort((a, b) => a.s - b.s);
  return sorted.filter((section) => section.s < s - 0.0000001).at(-1) ?? sorted[0];
}
function laneCenterPointInSection(road, section, laneId, s) {
  const lane = section.lanes.find((candidate) => candidate.id === laneId);
  if (!lane)
    throw new Error(`Road ${road.id} section ${section.id} has no lane ${laneId}`);
  const offsets = laneOffsetsAt(section, laneId, s - section.s);
  const point = laneSurfacePointAt(road, section, lane, s, (offsets.inner + offsets.outer) * 0.5);
  return { x: point.x, y: point.y };
}
function makeEdge(kind, from, to, fromS, toS, fromPoint, toPoint, junctionId, connectionId) {
  return {
    id: [kind, laneNodeKey(from), laneNodeKey(to), junctionId, connectionId].filter(Boolean).join("|"),
    kind,
    from,
    to,
    fromS,
    toS,
    fromPoint,
    toPoint,
    junctionId,
    connectionId
  };
}

// ../three-roads-inspect/packages/core/src/validation/lane-transition-routing-validation.ts
var TRAFFIC_LANE_TYPES4 = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "shared",
  "bus"
]);
function validateDisappearingLaneEscapes(network) {
  const diagnostics = [];
  const laneChangeEdges = buildLaneGraph(network).edges.filter((edge) => edge.kind === "lane-change");
  for (const road of network.roads) {
    if (road.kind === "connector")
      continue;
    const sections = [...road.laneSections].sort((left, right) => left.s - right.s);
    for (let index = 0;index < sections.length - 1; index++) {
      validateBoundaryDirection(road, sections[index], sections[index + 1], 1, laneChangeEdges, diagnostics);
      validateBoundaryDirection(road, sections[index + 1], sections[index], -1, laneChangeEdges, diagnostics);
      validateAppearingDirection(road, sections[index], sections[index + 1], 1, laneChangeEdges, diagnostics);
      validateAppearingDirection(road, sections[index + 1], sections[index], -1, laneChangeEdges, diagnostics);
    }
  }
  return diagnostics;
}
function validateAppearingDirection(road, source, target, travelSign, laneChangeEdges, diagnostics) {
  const sourceRoles = new Set(source.lanes.filter((lane) => lane.id !== 0 && TRAFFIC_LANE_TYPES4.has(lane.type) && laneHasPositiveWidth(road, source, lane)).map((lane) => lane.sourceRole).filter((role) => role !== undefined));
  for (const lane of target.lanes) {
    if (lane.id === 0 || laneTravelSign(lane) !== travelSign || !TRAFFIC_LANE_TYPES4.has(lane.type) || !laneHasPositiveWidth(road, target, lane) || !lane.sourceRole || sourceRoles.has(lane.sourceRole))
      continue;
    const existingLaneIds = new Set(target.lanes.filter((candidate) => candidate.sourceRole !== undefined && sourceRoles.has(candidate.sourceRole)).map(({ id }) => id));
    const hasEntry = laneChangePathExists(laneChangeEdges, road.id, target.id, existingLaneIds, (laneId) => laneId === lane.id);
    if (hasEntry)
      continue;
    diagnostics.push({
      severity: "error",
      code: "appearing-traffic-lane-no-entry",
      message: `Traffic lane ${lane.sourceRole} on road ${road.id} appears without a legal lane change from an existing lane`,
      roadId: road.id,
      sectionId: target.id,
      laneId: lane.id
    });
  }
}
function validateBoundaryDirection(road, source, target, travelSign, laneChangeEdges, diagnostics) {
  const continuingRoles = new Set(target.lanes.filter((lane) => lane.id !== 0 && TRAFFIC_LANE_TYPES4.has(lane.type) && laneHasPositiveWidth(road, target, lane)).map((lane) => lane.sourceRole).filter((role) => role !== undefined));
  for (const lane of source.lanes) {
    if (lane.id === 0 || laneTravelSign(lane) !== travelSign || !TRAFFIC_LANE_TYPES4.has(lane.type) || !laneHasPositiveWidth(road, source, lane) || !lane.sourceRole || continuingRoles.has(lane.sourceRole))
      continue;
    const continuingLaneIds = new Set(source.lanes.filter((candidate) => candidate.sourceRole !== undefined && continuingRoles.has(candidate.sourceRole)).map(({ id }) => id));
    const hasEscape = laneChangePathExists(laneChangeEdges, road.id, source.id, new Set([lane.id]), (laneId) => continuingLaneIds.has(laneId));
    if (hasEscape)
      continue;
    diagnostics.push({
      severity: "error",
      code: "disappearing-traffic-lane-no-escape",
      message: `Traffic lane ${lane.sourceRole} on road ${road.id} ends without a legal lane change into a continuing lane`,
      roadId: road.id,
      sectionId: source.id,
      laneId: lane.id
    });
  }
}
function laneChangePathExists(edges, roadId, sectionId, starts, target) {
  const queue = [...starts];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const laneId = queue.shift();
    if (target(laneId))
      return true;
    for (const edge of edges) {
      if (edge.from.roadId !== roadId || edge.from.sectionId !== sectionId || edge.from.laneId !== laneId || edge.to.roadId !== roadId || edge.to.sectionId !== sectionId || visited.has(edge.to.laneId))
        continue;
      visited.add(edge.to.laneId);
      queue.push(edge.to.laneId);
    }
  }
  return false;
}
function laneHasPositiveWidth(road, section, lane) {
  const sectionLength = laneSectionEndS(road, section) - section.s;
  const candidates = new Set([0, sectionLength]);
  const widths = [...lane.widths].sort((left, right) => left.sOffset - right.sOffset);
  for (let index = 0;index < widths.length; index++) {
    const width = widths[index];
    const end = Math.min(sectionLength, widths[index + 1]?.sOffset ?? sectionLength);
    candidates.add(width.sOffset);
    candidates.add(end);
    candidates.add((width.sOffset + end) * 0.5);
    const derivativeRoots = quadraticRoots(3 * width.d, 2 * width.c, width.b);
    for (const root of derivativeRoots) {
      const localS = width.sOffset + root;
      if (localS > width.sOffset && localS < end)
        candidates.add(localS);
    }
  }
  return [...candidates].some((localS) => laneWidthUnclampedAt(lane, localS) > 0.05);
}
function quadraticRoots(a, b, c) {
  if (Math.abs(a) < 0.000000000001)
    return Math.abs(b) < 0.000000000001 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0)
    return [];
  const root = Math.sqrt(discriminant);
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

// ../three-roads-inspect/packages/core/src/validation/destination-zone-validation.ts
var TRAFFIC_LANE_TYPES5 = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "shared",
  "bus"
]);
function validateDestinationZones(network) {
  const diagnostics = [];
  const graph = buildLaneGraph(network);
  const nodeByKey = new Map(graph.nodes.map((node) => [laneNodeKey(node), node]));
  const zoneIds = new Set(network.roads.filter((road) => road.routing?.throughTraffic === "destination-only").map((road) => road.routing?.destinationZoneId).filter((zone) => zone !== undefined));
  for (const zoneId of zoneIds) {
    const zoneRoadIds = new Set(network.roads.filter((road) => road.routing?.destinationZoneId === zoneId).map((road) => road.id));
    const trafficEdges = graph.edges.filter((edge) => {
      const from = nodeByKey.get(laneNodeKey(edge.from));
      const to = nodeByKey.get(laneNodeKey(edge.to));
      return from && to && TRAFFIC_LANE_TYPES5.has(from.laneType) && TRAFFIC_LANE_TYPES5.has(to.laneType);
    });
    const incoming = trafficEdges.filter((edge) => !zoneRoadIds.has(edge.from.roadId) && zoneRoadIds.has(edge.to.roadId));
    const outgoing = trafficEdges.filter((edge) => zoneRoadIds.has(edge.from.roadId) && !zoneRoadIds.has(edge.to.roadId));
    if (incoming.length === 0)
      diagnostics.push(error7("destination-zone-entry-missing", `Destination zone ${zoneId} has no traffic ingress`));
    if (outgoing.length === 0)
      diagnostics.push(error7("destination-zone-exit-missing", `Destination zone ${zoneId} has no traffic egress`));
    if (incoming.length > 0 && outgoing.length > 0 && incoming.some((entry) => !canReachExit(entry, outgoing, trafficEdges, zoneRoadIds))) {
      diagnostics.push(error7("destination-zone-disconnected", `Destination zone ${zoneId} has no internal route from every ingress to an egress`));
    }
  }
  return diagnostics;
}
function canReachExit(entry, exits, edges, zoneRoadIds) {
  const targets = new Set(exits.map((edge) => laneNodeKey(edge.from)));
  const queue = [entry.to];
  const visited = new Set([laneNodeKey(entry.to)]);
  while (queue.length > 0) {
    const node = queue.shift();
    if (targets.has(laneNodeKey(node)))
      return true;
    for (const edge of edges) {
      if (laneNodeKey(edge.from) !== laneNodeKey(node) || !zoneRoadIds.has(edge.to.roadId))
        continue;
      const key = laneNodeKey(edge.to);
      if (visited.has(key))
        continue;
      visited.add(key);
      queue.push(edge.to);
    }
  }
  return false;
}
function error7(code, message) {
  return { severity: "error", code, message };
}

// ../three-roads-inspect/packages/core/src/geometry/road-object-footprint.ts
function roadObjectFootprintsST(object) {
  if (!(object.length && object.length > 0) || !(object.width && object.width > 0))
    return [];
  const orientation = objectAxis(object);
  const across = { ds: -orientation.dt, dt: orientation.ds };
  const count = object.repeat?.count ?? 1;
  const spacing = object.repeat?.spacing ?? defaultSpacing(object);
  return Array.from({ length: count }, (_, index) => {
    const centerS = object.s + index * spacing;
    const centerT = object.repeat?.lateralOffsets?.[index] ?? object.t;
    const points = [-1, 1].flatMap((along) => [-1, 1].map((lateral2) => ({
      s: centerS + orientation.ds * object.length * 0.5 * along + across.ds * object.width * 0.5 * lateral2,
      t: centerT + orientation.dt * object.length * 0.5 * along + across.dt * object.width * 0.5 * lateral2
    })));
    const center = points.reduce((sum, point) => ({ s: sum.s + point.s / points.length, t: sum.t + point.t / points.length }), { s: 0, t: 0 });
    return points.sort((left, right) => Math.atan2(left.t - center.t, left.s - center.s) - Math.atan2(right.t - center.t, right.s - center.s));
  });
}
function roadObjectFootprintsWorld(road, object) {
  if (object.kind !== "parking-space" && Math.abs(object.heading ?? 0) <= 0.000000001 && object.length && object.length > 0 && object.width && object.width > 0) {
    const count = object.repeat?.count ?? 1;
    const spacing = object.repeat?.spacing ?? defaultSpacing(object);
    return Array.from({ length: count }, (_, index) => {
      const centerS = object.s + index * spacing;
      const centerT = object.repeat?.lateralOffsets?.[index] ?? object.t;
      const startS = centerS - object.length * 0.5;
      const endS = centerS + object.length * 0.5;
      const intervals = Math.max(1, Math.ceil(object.length / 0.5));
      const stations = Array.from({ length: intervals + 1 }, (_2, sample) => startS + (endS - startS) * sample / intervals);
      const inner = stations.map((s) => stToWorld(road.referenceLine, s, centerT - object.width * 0.5));
      const outer = stations.map((s) => stToWorld(road.referenceLine, s, centerT + object.width * 0.5));
      return [...inner, ...outer.reverse()];
    });
  }
  return roadObjectFootprintsST(object).map((footprint) => footprint.map((point) => stToWorld(road.referenceLine, point.s, point.t)));
}
function objectAxis(object) {
  if (object.kind === "parking-space") {
    const angle = object.orientation === "parallel" ? Math.PI / 2 : object.orientation === "angled" ? object.angle ?? Math.PI / 3 : 0;
    return { ds: Math.sin(angle), dt: Math.cos(angle) };
  }
  const heading = object.heading ?? 0;
  return { ds: Math.cos(heading), dt: Math.sin(heading) };
}
function defaultSpacing(object) {
  if (object.kind !== "parking-space")
    return object.length ?? 1;
  if (object.orientation === "parallel")
    return object.length ?? 1;
  const angle = object.orientation === "angled" ? object.angle ?? Math.PI / 3 : 0;
  return (object.width ?? 1) / Math.max(Math.abs(Math.cos(angle)), 0.001);
}

// ../three-roads-inspect/packages/core/src/lanes/road-lateral-extrema.ts
function roadLateralExtentAt(road, s) {
  const station = Math.max(0, Math.min(road.length, s));
  const section = findLaneSection(road, station);
  const localS = station - section.s;
  const minimumOrdinal = Math.min(0, ...section.lanes.map((lane) => lane.id));
  const maximumOrdinal = Math.max(0, ...section.lanes.map((lane) => lane.id));
  return {
    minimumT: laneBoundaryOffsetAt(section, minimumOrdinal, localS),
    maximumT: laneBoundaryOffsetAt(section, maximumOrdinal, localS)
  };
}
function roadLateralExtremaOverRange(road, sStart, sEnd) {
  if (!Number.isFinite(sStart) || !Number.isFinite(sEnd) || sStart < 0 || sEnd > road.length || sEnd <= sStart) {
    throw new RangeError(`Invalid lateral-extrema range ${sStart}..${sEnd} on ${road.id}`);
  }
  const breakpoints = rangeBreakpoints(road, sStart, sEnd);
  const candidates = new Set(breakpoints);
  for (let index = 0;index < breakpoints.length - 1; index++) {
    addBoundaryCriticalPoints(road, breakpoints[index], breakpoints[index + 1], "minimumT", candidates);
    addBoundaryCriticalPoints(road, breakpoints[index], breakpoints[index + 1], "maximumT", candidates);
  }
  let minimumT = Number.POSITIVE_INFINITY;
  let maximumT = Number.NEGATIVE_INFINITY;
  let minimumStation = sStart;
  let maximumStation = sStart;
  for (const station of [...candidates].sort((left, right) => left - right)) {
    const extent = roadLateralExtentAt(road, station);
    if (extent.minimumT < minimumT) {
      minimumT = extent.minimumT;
      minimumStation = station;
    }
    if (extent.maximumT > maximumT) {
      maximumT = extent.maximumT;
      maximumStation = station;
    }
  }
  return { minimumT, maximumT, minimumStation, maximumStation };
}
function rangeBreakpoints(road, sStart, sEnd) {
  const points = new Set([sStart, sEnd]);
  for (const section of road.laneSections) {
    const sectionEnd = laneSectionEndS(road, section);
    if (section.s > sStart && section.s < sEnd)
      points.add(section.s);
    if (sectionEnd > sStart && sectionEnd < sEnd)
      points.add(sectionEnd);
    for (const lane of section.lanes) {
      for (const record of [...lane.widths, ...lane.borders ?? []]) {
        const station = section.s + record.sOffset;
        if (station > sStart && station < sEnd)
          points.add(station);
      }
    }
  }
  return [...points].sort((left, right) => left - right);
}
function addBoundaryCriticalPoints(road, start, end, field, candidates) {
  if (end - start <= 0.000000001)
    return;
  const evaluate = (u) => roadLateralExtentAt(road, start + (end - start) * u)[field];
  const y0 = evaluate(0);
  const y1 = evaluate(1 / 3);
  const y2 = evaluate(2 / 3);
  const y3 = evaluate(1);
  const thirdDifference = y3 - 3 * y2 + 3 * y1 - y0;
  const d = 4.5 * thirdDifference;
  const c = 4.5 * (y2 - 2 * y1 + y0) - d;
  const b = 3 * (y1 - y0) - c / 3 - d / 9;
  for (const u of quadraticRoots2(3 * d, 2 * c, b)) {
    if (u > 0.000000001 && u < 1 - 0.000000001)
      candidates.add(start + (end - start) * u);
  }
}
function quadraticRoots2(a, b, c) {
  if (Math.abs(a) <= 0.000000000001)
    return Math.abs(b) <= 0.000000000001 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -0.0000000001)
    return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

// ../three-roads-inspect/packages/core/src/validation/lane-object-containment-validation.ts
var TOLERANCE = 0.0000001;
function validateLaneObjectContainment(road) {
  const diagnostics = [];
  for (const object of road.objects ?? []) {
    const containment = object.laneBinding?.containment;
    if (!object.laneBinding || containment === undefined || containment === "none")
      continue;
    for (const footprint of roadObjectFootprintsST(object)) {
      const stationRange = footprintStationRange(footprint);
      if (stationRange.start < -TOLERANCE || stationRange.end > road.length + TOLERANCE) {
        diagnostics.push(diagnostic(road, object, "road-object-footprint-range", `Object ${object.id} footprint extends outside road ${road.id}`));
        continue;
      }
      const failure = containmentFailure(road, object, footprint);
      if (!failure)
        continue;
      diagnostics.push(diagnostic(road, object, failure.missingRole ? "road-object-lane-binding" : failure.wrongType ? "road-object-lane-type" : `road-object-${containment}-containment`, failure.missingRole ? `Object ${object.id} lane role ${object.laneBinding.role} is absent under its footprint` : failure.wrongType ? `Object ${object.id} is bound to a disallowed lane type on road ${road.id}` : `Object ${object.id} footprint escapes its ${containment} containment on road ${road.id}`));
      break;
    }
  }
  return diagnostics;
}
function containmentFailure(road, object, footprint) {
  const range = footprintStationRange(footprint);
  const breakpoints = containmentBreakpoints(road, object, footprint, range.start, range.end);
  for (let index = 0;index < breakpoints.length - 1; index++) {
    const start = breakpoints[index];
    const end = breakpoints[index + 1];
    if (end - start <= 0.000000001)
      continue;
    const midpoint = (start + end) * 0.5;
    if (object.laneBinding?.containment === "lane") {
      const lane = laneForRole(road, object.laneBinding.role, midpoint);
      if (!lane)
        return { missingRole: true };
      if (object.laneBinding.allowedLaneTypes && !object.laneBinding.allowedLaneTypes.includes(lane.type)) {
        return { missingRole: false, wrongType: true };
      }
    }
    const lowerMargin = minimumCubicMargin(start, end, (station) => {
      const objectBounds = footprintEnvelopeAt(footprint, station);
      const container = containerBoundsAt(road, object, station);
      return objectBounds.minimumT - container.minimumT;
    });
    const upperMargin = minimumCubicMargin(start, end, (station) => {
      const objectBounds = footprintEnvelopeAt(footprint, station);
      const container = containerBoundsAt(road, object, station);
      return container.maximumT - objectBounds.maximumT;
    });
    if (lowerMargin < -TOLERANCE || upperMargin < -TOLERANCE)
      return { missingRole: false };
  }
  return;
}
function containmentBreakpoints(road, object, footprint, start, end) {
  const points = new Set(footprint.map((point) => clamp(point.s, start, end)));
  points.add(start);
  points.add(end);
  for (const section of road.laneSections) {
    const sectionEnd = laneSectionEndS(road, section);
    if (section.s > start && section.s < end)
      points.add(section.s);
    if (sectionEnd > start && sectionEnd < end)
      points.add(sectionEnd);
    const lanes = object.laneBinding?.containment === "lane" ? section.lanes.filter((lane) => lane.sourceRole === object.laneBinding?.role) : section.lanes;
    for (const lane of lanes) {
      for (const width of lane.widths) {
        const station = section.s + width.sOffset;
        if (station > start && station < end)
          points.add(station);
      }
    }
  }
  return [...points].sort((left, right) => left - right);
}
function containerBoundsAt(road, object, station) {
  if (object.laneBinding?.containment === "road")
    return roadLateralExtentAt(road, station);
  const lane = laneForRole(road, object.laneBinding.role, station);
  if (!lane)
    return { minimumT: Number.POSITIVE_INFINITY, maximumT: Number.NEGATIVE_INFINITY };
  const section = findLaneSection(road, station);
  const offsets = laneOffsetsAt(section, lane.id, station - section.s);
  return {
    minimumT: Math.min(offsets.inner, offsets.outer),
    maximumT: Math.max(offsets.inner, offsets.outer)
  };
}
function laneForRole(road, role, station) {
  return findLaneSection(road, clamp(station, 0, road.length)).lanes.find((lane) => lane.sourceRole === role);
}
function footprintEnvelopeAt(footprint, station) {
  const offsets = [];
  for (let index = 0;index < footprint.length; index++) {
    const start = footprint[index];
    const end = footprint[(index + 1) % footprint.length];
    const ds = end.s - start.s;
    if (Math.abs(ds) <= 0.0000000001) {
      if (Math.abs(station - start.s) <= 0.00000001)
        offsets.push(start.t, end.t);
      continue;
    }
    const ratio = (station - start.s) / ds;
    if (ratio >= -0.000000001 && ratio <= 1 + 0.000000001)
      offsets.push(start.t + (end.t - start.t) * ratio);
  }
  if (offsets.length === 0)
    throw new Error(`Cannot evaluate object footprint at s=${station}`);
  return { minimumT: Math.min(...offsets), maximumT: Math.max(...offsets) };
}
function minimumCubicMargin(start, end, evaluate) {
  const length = end - start;
  const y0 = evaluate(start);
  const y1 = evaluate(start + length / 3);
  const y2 = evaluate(start + length * 2 / 3);
  const y3 = evaluate(end);
  const d = 4.5 * (y3 - 3 * y2 + 3 * y1 - y0);
  const c = 4.5 * (y2 - 2 * y1 + y0) - d;
  const b = 3 * (y1 - y0) - c / 3 - d / 9;
  const candidates = [0, 1, ...quadraticRoots3(3 * d, 2 * c, b).filter((root) => root > 0 && root < 1)];
  return Math.min(...candidates.map((u) => y0 + b * u + c * u * u + d * u * u * u));
}
function quadraticRoots3(a, b, c) {
  if (Math.abs(a) <= 0.000000000001)
    return Math.abs(b) <= 0.000000000001 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -0.0000000001)
    return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}
function footprintStationRange(footprint) {
  return {
    start: Math.min(...footprint.map((point) => point.s)),
    end: Math.max(...footprint.map((point) => point.s))
  };
}
function diagnostic(road, _object, code, message) {
  return { severity: "error", code, message, roadId: road.id };
}
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// ../three-roads-inspect/packages/core/src/lanes/lane-width-extrema.ts
function laneWidthExtrema(lane, sectionLength) {
  const sorted = [...lane.widths].sort((left, right) => left.sOffset - right.sOffset);
  const candidates = [];
  for (let index = 0;index < sorted.length; index++) {
    const record = sorted[index];
    const start = Math.max(0, record.sOffset);
    const end = Math.min(sectionLength, sorted[index + 1]?.sOffset ?? sectionLength);
    if (end < start)
      continue;
    addCandidate(candidates, record, start);
    addCandidate(candidates, record, end);
    for (const local of quadraticRoots4(3 * record.d, 2 * record.c, record.b)) {
      const station = record.sOffset + local;
      if (station > start && station < end)
        addCandidate(candidates, record, station);
    }
  }
  if (candidates.length === 0) {
    return { minimum: 0, minimumS: 0, maximum: 0, maximumS: 0 };
  }
  const minimum = candidates.reduce((left, right) => right.value < left.value ? right : left);
  const maximum = candidates.reduce((left, right) => right.value > left.value ? right : left);
  return { minimum: minimum.value, minimumS: minimum.s, maximum: maximum.value, maximumS: maximum.s };
}
function addCandidate(candidates, record, station) {
  candidates.push({ s: station, value: evaluateCubic(record, station - record.sOffset) });
}
function quadraticRoots4(a, b, c) {
  if (Math.abs(a) <= 0.000000000001)
    return Math.abs(b) <= 0.000000000001 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -0.0000000001)
    return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

// ../three-roads-inspect/packages/core/src/validation/traffic-management-validation.ts
function validateCompiledTrafficManagement(network) {
  const diagnostics = [];
  const active = new Set((network.activeTrafficManagement ?? []).map((phase) => `${phase.planId}:${phase.phaseId}`));
  for (const road of network.roads) {
    validateProvenance(active, road.operational, road.id, road.id, diagnostics);
    for (const section of road.laneSections) {
      for (const lane of section.lanes) {
        validateProvenance(active, lane.operational, lane.operational?.sourceId ?? `${road.id}/${lane.id}`, road.id, diagnostics);
      }
    }
    for (const marking of road.markings ?? []) {
      validateProvenance(active, marking.operational, marking.id, road.id, diagnostics);
    }
    for (const section of road.laneSections) {
      for (const lane of section.lanes) {
        for (const marking of lane.markings ?? [])
          validateProvenance(active, marking.operational, marking.id, road.id, diagnostics);
      }
    }
    for (const object of road.objects ?? []) {
      validateProvenance(active, object.operational, object.id, road.id, diagnostics);
      for (const regulationId of object.regulationIds ?? []) {
        if (!network.trafficRegulations?.some((regulation) => regulation.id === regulationId)) {
          diagnostics.push(error8("regulation-object-reference-missing", `Object ${object.id} references missing regulation ${regulationId}`, road.id));
        }
      }
    }
  }
  for (const junction of network.junctions) {
    validateProvenance(active, junction.operational, junction.id, undefined, diagnostics);
  }
  for (const group of network.junctionGroups ?? []) {
    validateProvenance(active, group.operational, group.id, undefined, diagnostics);
  }
  for (const object of network.objects ?? []) {
    validateProvenance(active, object.operational, object.id, undefined, diagnostics);
  }
  const graphNodes = new Set(buildLaneGraph(network).nodes.map(laneNodeKey));
  for (const road of network.roads) {
    for (const section of road.laneSections) {
      for (const lane of section.lanes) {
        if (lane.id === 0 || lane.operational?.status !== "closed")
          continue;
        if (graphNodes.has(laneNodeKey({ roadId: road.id, sectionId: section.id, laneId: lane.id }))) {
          diagnostics.push(error8("closed-lane-routable", `Closed lane ${road.id}/${section.id}/${lane.id} remains routable`, road.id, section.id, lane.id));
        }
      }
    }
  }
  for (const regulation of network.trafficRegulations ?? []) {
    validateProvenance(active, regulation.operational, regulation.id, regulation.roadId, diagnostics);
    const road = network.roads.find((candidate) => candidate.id === regulation.roadId);
    if (!road || regulation.sStart < 0 || regulation.sEnd > (road?.length ?? 0) || regulation.sEnd <= regulation.sStart) {
      diagnostics.push(error8("traffic-regulation-range-invalid", `Regulation ${regulation.id} has invalid compiled range`, regulation.roadId));
      continue;
    }
    if (regulation.lanes.length === 0)
      diagnostics.push(error8("traffic-regulation-lanes-empty", `Regulation ${regulation.id} resolves no active lanes`, road.id));
    for (const target of regulation.lanes) {
      const section = road.laneSections.find((candidate) => candidate.id === target.sectionId);
      const lane = section?.lanes.find((candidate) => candidate.id === target.laneId);
      if (!section || !lane || lane.operational?.status === "closed" || laneSectionEndS(road, section) <= regulation.sStart || section.s >= regulation.sEnd) {
        diagnostics.push(error8("traffic-regulation-lane-invalid", `Regulation ${regulation.id} has invalid lane target`, road.id, target.sectionId, target.laneId));
      }
    }
  }
  validateRegulationConflicts(network, diagnostics);
  return diagnostics;
}
function validateRegulationConflicts(network, diagnostics) {
  const regulations = network.trafficRegulations ?? [];
  for (let left = 0;left < regulations.length; left++) {
    for (let right = left + 1;right < regulations.length; right++) {
      const a = regulations[left];
      const b = regulations[right];
      if (a.roadId !== b.roadId || a.maximumKph === b.maximumKph || a.sStart >= b.sEnd - 0.0000001 || b.sStart >= a.sEnd - 0.0000001)
        continue;
      const aLanes = new Set(a.lanes.map((lane) => `${lane.sectionId}:${lane.laneId}`));
      if (b.lanes.some((lane) => aLanes.has(`${lane.sectionId}:${lane.laneId}`))) {
        diagnostics.push(error8("maximum-speed-conflict", `Regulations ${a.id}/${b.id} conflict`, a.roadId));
      }
    }
  }
}
function validateProvenance(active, provenance, sourceId, roadId, diagnostics) {
  if (!provenance)
    return;
  if (!active.has(`${provenance.planId}:${provenance.phaseId}`)) {
    diagnostics.push({
      severity: "error",
      code: "inactive-traffic-element",
      message: `Operational source ${sourceId} belongs to inactive phase ${provenance.planId}/${provenance.phaseId}`,
      roadId
    });
  }
}
function error8(code, message, roadId, sectionId, laneId) {
  return { severity: "error", code, message, roadId, sectionId, laneId };
}

// ../three-roads-inspect/packages/core/src/geometry/roadside-feature.ts
function roadsideDitchCrossSectionAt(road, feature, s) {
  const station = Math.max(feature.sStart, Math.min(feature.sEnd, s));
  const section = findLaneSection(road, station);
  const lane = section.lanes.find((candidate) => candidate.sourceRole === feature.laneRole);
  if (!lane || lane.id === 0)
    throw new Error(`Ditch ${feature.id} cannot resolve lane role ${feature.laneRole} at s=${station}`);
  const pavementEdgeT = laneOffsetsAt(section, lane.id, station - section.s).outer;
  const sign = lane.id > 0 ? 1 : -1;
  const bankRun = feature.depth * feature.sideSlope;
  const innerTopT = pavementEdgeT + sign * feature.gap;
  const innerBottomT = innerTopT + sign * bankRun;
  const outerBottomT = innerBottomT + sign * feature.bottomWidth;
  const outerTopT = outerBottomT + sign * bankRun;
  return { s: station, pavementEdgeT, innerTopT, innerBottomT, outerBottomT, outerTopT, depth: feature.depth };
}
function sampleRoadsideDitchPlan(network, feature, step = 2) {
  const road = network.roads.find((candidate) => candidate.id === feature.roadId);
  if (!road)
    throw new Error(`Ditch ${feature.id} has no road ${feature.roadId}`);
  const sections = samples(feature.sStart, feature.sEnd, step).map((s) => roadsideDitchCrossSectionAt(road, feature, s));
  const innerTop = sections.map((section) => point22(roadToWorld(road, section.s, section.innerTopT)));
  const outerTop = sections.map((section) => point22(roadToWorld(road, section.s, section.outerTopT)));
  return {
    feature,
    topPolygon: [...innerTop, ...outerTop.reverse()],
    innerBottom: sections.map((section) => point22(roadToWorld(road, section.s, section.innerBottomT, -section.depth))),
    outerBottom: sections.map((section) => point22(roadToWorld(road, section.s, section.outerBottomT, -section.depth)))
  };
}
function roadsideRetainingWallCrossSectionAt(road, feature, s) {
  const station = Math.max(feature.sStart, Math.min(feature.sEnd, s));
  const section = findLaneSection(road, station);
  const lane = section.lanes.find((candidate) => candidate.sourceRole === feature.laneRole);
  if (!lane || lane.id === 0)
    throw new Error(`Retaining wall ${feature.id} cannot resolve lane role ${feature.laneRole} at s=${station}`);
  const pavementEdgeT = laneOffsetsAt(section, lane.id, station - section.s).outer;
  const sign = lane.id > 0 ? 1 : -1;
  const innerFaceT = pavementEdgeT + sign * feature.gap;
  const outerFaceT = innerFaceT + sign * feature.thickness;
  const ratio = (station - feature.sStart) / (feature.sEnd - feature.sStart);
  const height = feature.heightStart + (feature.heightEnd - feature.heightStart) * ratio;
  return { s: station, pavementEdgeT, innerFaceT, outerFaceT, height };
}
function sampleRoadsideRetainingWallPlan(network, feature, step = 2) {
  const road = network.roads.find((candidate) => candidate.id === feature.roadId);
  if (!road)
    throw new Error(`Retaining wall ${feature.id} has no road ${feature.roadId}`);
  const sections = samples(feature.sStart, feature.sEnd, step).map((s) => roadsideRetainingWallCrossSectionAt(road, feature, s));
  const innerFace = sections.map((section) => point22(roadToWorld(road, section.s, section.innerFaceT)));
  const outerFace = sections.map((section) => point22(roadToWorld(road, section.s, section.outerFaceT)));
  return { feature, footprint: [...innerFace, ...[...outerFace].reverse()], innerFace, outerFace };
}
function samples(start, end, step) {
  const count = Math.max(1, Math.ceil((end - start) / Math.max(0.1, step)));
  return Array.from({ length: count + 1 }, (_, index) => start + (end - start) * index / count);
}
function point22(point) {
  return { x: point.x, y: point.y };
}

// ../three-roads-inspect/packages/core/src/validation/roadside-feature-validation.ts
function validateCompiledRoadsideFeatures(network) {
  const diagnostics = [];
  const ids = new Set;
  for (const feature of network.roadsideFeatures ?? []) {
    if (ids.has(feature.id))
      diagnostics.push(error9(feature.roadId, "duplicate-roadside-feature-id", `Duplicate roadside feature ${feature.id}`));
    ids.add(feature.id);
    const road = network.roads.find((candidate) => candidate.id === feature.roadId);
    if (!road) {
      diagnostics.push(error9(feature.roadId, "roadside-feature-road-missing", `Roadside feature ${feature.id} has no road`));
      continue;
    }
    const invalidSection = feature.kind === "ditch" ? feature.gap < 0 || feature.depth <= 0 || feature.bottomWidth <= 0 || feature.sideSlope <= 0 : feature.gap < 0 || feature.thickness <= 0 || feature.heightStart <= 0 || feature.heightEnd <= 0;
    if (feature.sStart < 0 || feature.sEnd > road.length || feature.sEnd <= feature.sStart || invalidSection) {
      diagnostics.push(error9(road.id, "roadside-feature-properties-invalid", `Roadside feature ${feature.id} has invalid properties`));
      continue;
    }
    const stations = [feature.sStart, feature.sEnd, ...road.laneSections.map((section) => section.s)].filter((s) => s >= feature.sStart - 0.0000001 && s <= feature.sEnd + 0.0000001);
    for (const station of stations) {
      const section = findLaneSection(road, station);
      const lane = section.lanes.find((candidate) => candidate.sourceRole === feature.laneRole);
      if (!lane || lane.id === 0 || (lane.id > 0 ? "left" : "right") !== feature.side) {
        diagnostics.push(error9(road.id, "roadside-feature-lane-binding-invalid", `Roadside feature ${feature.id} has an invalid lane binding at s=${station}`));
        break;
      }
      const outermost = section.lanes.filter((candidate) => Math.sign(candidate.id) === Math.sign(lane.id)).reduce((maximum, candidate) => Math.max(maximum, Math.abs(candidate.id)), 0);
      if (Math.abs(lane.id) !== outermost) {
        diagnostics.push(error9(road.id, "roadside-feature-lane-not-outermost", `Roadside feature ${feature.id} is not outside the pavement at s=${station}`));
        break;
      }
      const sign = feature.side === "left" ? 1 : -1;
      const sectionOffsets = feature.kind === "ditch" ? (() => {
        const crossSection = roadsideDitchCrossSectionAt(road, feature, station);
        return { pavementEdgeT: crossSection.pavementEdgeT, innerT: crossSection.innerTopT, outerT: crossSection.outerTopT };
      })() : (() => {
        const crossSection = roadsideRetainingWallCrossSectionAt(road, feature, station);
        return { pavementEdgeT: crossSection.pavementEdgeT, innerT: crossSection.innerFaceT, outerT: crossSection.outerFaceT };
      })();
      if ((sectionOffsets.innerT - sectionOffsets.pavementEdgeT) * sign < -0.0000001 || (sectionOffsets.outerT - sectionOffsets.innerT) * sign <= 0) {
        diagnostics.push(error9(road.id, "roadside-feature-pavement-overlap", `Roadside feature ${feature.id} overlaps the pavement at s=${station}`));
        break;
      }
    }
  }
  return diagnostics;
}
function error9(roadId, code, message) {
  return { severity: "error", code, message, roadId };
}

// ../three-roads-inspect/packages/core/src/validation/road-surface-elevation-validation.ts
function validateCompiledRoadSurfaceElevations(network) {
  const diagnostics = [];
  const ids = new Set;
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  for (const elevation of network.roadSurfaceElevations ?? []) {
    if (ids.has(elevation.id)) {
      diagnostics.push(diagnostic2("duplicate-road-surface-elevation-id", `Duplicate road surface elevation id ${elevation.id}`, elevation));
    }
    ids.add(elevation.id);
    const road = roads.get(elevation.roadId);
    if (!road) {
      diagnostics.push(diagnostic2("road-surface-elevation-road-missing", `Road surface elevation ${elevation.id} references missing road ${elevation.roadId}`, elevation));
      continue;
    }
    const span = elevation.sEnd - elevation.sStart;
    if (!Number.isFinite(elevation.sStart) || !Number.isFinite(elevation.sEnd) || elevation.sStart < 0 || elevation.sEnd <= elevation.sStart || elevation.sEnd > road.length) {
      diagnostics.push(diagnostic2("road-surface-elevation-range-invalid", `Road surface elevation ${elevation.id} has an invalid range`, elevation));
    }
    if (!Number.isFinite(elevation.height) || elevation.height <= 0) {
      diagnostics.push(diagnostic2("road-surface-elevation-height-invalid", `Road surface elevation ${elevation.id} has an invalid height`, elevation));
    }
    if (!Number.isFinite(elevation.rampLength) || elevation.rampLength <= 0 || elevation.rampLength * 2 > span) {
      diagnostics.push(diagnostic2("road-surface-elevation-ramp-invalid", `Road surface elevation ${elevation.id} has invalid ramps`, elevation));
    }
  }
  return diagnostics;
}
function diagnostic2(code, message, elevation) {
  return { severity: "error", code, message, roadId: elevation.roadId };
}

// ../three-roads-inspect/packages/core/src/validation/validation.ts
function validateRoadNetwork(network, options = {}) {
  const diagnostics = [];
  const roadIds = new Set(network.roads.map((road) => road.id));
  const roadsById = new Map(network.roads.map((road) => [road.id, road]));
  const seenRoadIds = new Set;
  const junctionIds = new Set(network.junctions.map((junction) => junction.id));
  diagnostics.push(...validateCompiledRoadSurfaceElevations(network));
  for (const road of network.roads) {
    if (seenRoadIds.has(road.id))
      push(diagnostics, "error", "duplicate-road-id", `Duplicate road id ${road.id}`, road);
    seenRoadIds.add(road.id);
    validateReferenceLine(road, diagnostics);
    validateElevation(road, diagnostics);
    validateSuperelevation(road, diagnostics);
    diagnostics.push(...validateRoadDesignRanges(road, options.designRecommendationSeverity ?? "error"));
    validateLaneSections(road, diagnostics);
    validateRoadLinks(road, network, roadsById, roadIds, junctionIds, diagnostics);
    validateRoadMarkings(road, diagnostics);
    validateRoadObjects(network, road, diagnostics);
    diagnostics.push(...validateLaneObjectContainment(road));
    validateRoadRouting(road, diagnostics);
  }
  for (const junction of network.junctions) {
    for (const dropped of junction.unmaterializedConnections ?? []) {
      if (dropped.reason === "degenerate-length")
        continue;
      diagnostics.push({
        severity: "warning",
        code: "junction-connector-unmaterialized",
        message: `Junction ${junction.id} could not mesh connector ${dropped.connectionId}` + `${dropped.fromLaneId === undefined ? "" : ` lane ${dropped.fromLaneId}>${dropped.toLaneId}`}` + ` (${dropped.reason}${dropped.detail ? `: ${dropped.detail}` : ""});` + " the junction surface owns the movement instead",
        junctionId: junction.id,
        roadId: dropped.incomingRoadId
      });
    }
    if (junction.surfaceElevation && (junction.kind !== "common" || junction.surfaceElevation.height <= 0 || junction.surfaceElevation.rampLength <= 0)) {
      diagnostics.push({
        severity: "error",
        code: "junction-surface-elevation-invalid",
        message: `Junction ${junction.id} has an invalid raised-surface profile`,
        junctionId: junction.id
      });
    }
    const portIds = new Set;
    for (const port of junction.ports ?? []) {
      if (portIds.has(port.id)) {
        diagnostics.push({
          severity: "error",
          code: "duplicate-junction-port-id",
          message: `Junction ${junction.id} repeats port ${port.id}`,
          junctionId: junction.id
        });
      }
      portIds.add(port.id);
      const road = roadsById.get(port.roadId);
      if (!road) {
        diagnostics.push({
          severity: "error",
          code: "missing-junction-port-road",
          message: `Junction ${junction.id} references missing port road ${port.roadId}`,
          junctionId: junction.id
        });
      } else if (port.s !== undefined && (!Number.isFinite(port.s) || port.s < 0 || port.s > road.length)) {
        diagnostics.push({
          severity: "error",
          code: "junction-port-s-out-of-range",
          message: `Junction ${junction.id} port station is outside road ${port.roadId}`,
          roadId: port.roadId,
          junctionId: junction.id
        });
      }
    }
    validateEmptySurfaceFallbackElevation(roadsById, junction, diagnostics);
    validateVirtualJunctionNetwork(network, junction, diagnostics);
    for (const connection of junction.connections) {
      const incomingRoad = roadsById.get(connection.incomingRoadId);
      const connectingRoad = roadsById.get(connection.connectingRoadId);
      if (!roadIds.has(connection.incomingRoadId)) {
        diagnostics.push({
          severity: "error",
          code: "missing-junction-incoming-road",
          message: `Junction ${junction.id} references missing incoming road ${connection.incomingRoadId}`,
          junctionId: junction.id
        });
      }
      if (!roadIds.has(connection.connectingRoadId)) {
        diagnostics.push({
          severity: "error",
          code: "missing-junction-connecting-road",
          message: `Junction ${junction.id} references missing connecting road ${connection.connectingRoadId}`,
          junctionId: junction.id
        });
      }
      if (incomingRoad && connectingRoad) {
        validateJunctionConnection(junction, connection, incomingRoad, connectingRoad, diagnostics);
      }
    }
    for (const zone of junction.conflictZones ?? []) {
      if (zone.polygon.length < 3) {
        diagnostics.push({
          severity: "error",
          code: "invalid-conflict-zone",
          message: `Conflict zone ${zone.id} needs at least three points`,
          junctionId: junction.id
        });
      }
    }
    validateJunctionMovementInteractions(junction, diagnostics);
    diagnostics.push(...validateJunctionStreams(network, junction));
  }
  validateJunctionGroups2(network, junctionIds, diagnostics);
  validateNetworkObjects(network, junctionIds, diagnostics);
  validateConnectorObjectClearance(network, diagnostics);
  diagnostics.push(...validateCompiledWeavingSections(network));
  diagnostics.push(...validateCompiledRoadStructures(network));
  diagnostics.push(...validateCompiledRoadsideFeatures(network));
  diagnostics.push(...validateLaneBoundaryMarkingConflicts(network));
  diagnostics.push(...validateDisappearingLaneEscapes(network));
  diagnostics.push(...validateDestinationZones(network));
  diagnostics.push(...validateCompiledTrafficManagement(network));
  validateReferenceLineIntersections(network, diagnostics);
  return { ok: diagnostics.every((diagnostic3) => diagnostic3.severity !== "error"), diagnostics };
}
function validateEmptySurfaceFallbackElevation(roadsById, junction, diagnostics) {
  if (junction.connectorGeometryPolicy !== "surface-fallback" || junction.connections.length > 0)
    return;
  const approaches = (junction.ports ?? []).flatMap((port) => {
    const road = roadsById.get(port.roadId);
    if (!road)
      return [];
    const station = port.s ?? (port.contactPoint === "start" ? 0 : road.length);
    return [{ road, frame: evaluateRoadFrame(road, station) }];
  });
  for (let leftIndex = 0;leftIndex < approaches.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1;rightIndex < approaches.length; rightIndex++) {
      const left = approaches[leftIndex];
      const right = approaches[rightIndex];
      const planDistance = Math.hypot(left.frame.origin.x - right.frame.origin.x, left.frame.origin.y - right.frame.origin.y);
      const elevationDelta = Math.abs(left.frame.origin.z - right.frame.origin.z);
      if (elevationDelta <= Math.max(0.05, planDistance * 0.5))
        continue;
      diagnostics.push({
        severity: "error",
        code: "junction-elevation-mismatch",
        message: `Junction ${junction.id} approach elevations differ by ${elevationDelta.toFixed(3)} m across ${planDistance.toFixed(3)} m`,
        roadId: left.road.id,
        junctionId: junction.id
      });
    }
  }
}
function validateJunctionGroups2(network, junctionIds, diagnostics) {
  const groupIds = new Set;
  for (const group of network.junctionGroups ?? []) {
    if (groupIds.has(group.id)) {
      diagnostics.push({ severity: "error", code: "duplicate-junction-group-id", message: `Duplicate junction group id ${group.id}` });
    }
    groupIds.add(group.id);
    if (group.junctionIds.length < 2) {
      diagnostics.push({ severity: "error", code: "junction-group-member-count", message: `Junction group ${group.id} needs at least two junctions` });
    }
    const members = new Set;
    for (const junctionId of group.junctionIds) {
      if (members.has(junctionId)) {
        diagnostics.push({ severity: "error", code: "junction-group-duplicate-member", message: `Junction group ${group.id} repeats junction ${junctionId}`, junctionId });
      } else if (!junctionIds.has(junctionId)) {
        diagnostics.push({ severity: "error", code: "junction-group-member-missing", message: `Junction group ${group.id} references missing junction ${junctionId}`, junctionId });
      }
      members.add(junctionId);
    }
  }
}
function validateJunctionMovementInteractions(junction, diagnostics) {
  const maneuverIds = new Set(junction.connections.filter((connection) => !connection.sourceLaneContinuationId).map((connection) => connection.sourceManeuverId ?? connection.id));
  const conflictZoneIds = new Set((junction.conflictZones ?? []).map((zone) => zone.id));
  const interactionIds = new Set;
  const pairKeys = new Set;
  for (const interaction of junction.movementInteractions ?? []) {
    if (interactionIds.has(interaction.id)) {
      diagnostics.push({ severity: "error", code: "duplicate-junction-interaction-id", message: `Junction ${junction.id} repeats interaction ${interaction.id}`, junctionId: junction.id });
    }
    interactionIds.add(interaction.id);
    const pairKey = [...interaction.maneuverIds].sort().join("\x00");
    if (pairKeys.has(pairKey)) {
      diagnostics.push({ severity: "error", code: "duplicate-junction-interaction-pair", message: `Junction ${junction.id} repeats maneuver interaction ${interaction.maneuverIds.join("/")}`, junctionId: junction.id });
    }
    pairKeys.add(pairKey);
    for (const maneuverId of interaction.maneuverIds) {
      if (maneuverIds.has(maneuverId))
        continue;
      diagnostics.push({ severity: "error", code: "junction-interaction-maneuver-missing", message: `Junction ${junction.id} interaction references missing maneuver ${maneuverId}`, junctionId: junction.id });
    }
    if (interaction.priorityManeuverId && !interaction.maneuverIds.includes(interaction.priorityManeuverId)) {
      diagnostics.push({ severity: "error", code: "junction-interaction-priority-member", message: `Junction ${junction.id} interaction priority is outside its maneuver pair`, junctionId: junction.id });
    }
    validateInteractionControl(junction, interaction, diagnostics);
    if (interaction.kind === "compatible" && interaction.conflictZoneIds.length > 0) {
      diagnostics.push({ severity: "error", code: "junction-compatible-interaction-conflict", message: `Junction ${junction.id} compatible interaction owns a conflict zone`, junctionId: junction.id });
    }
    for (const conflictZoneId of interaction.conflictZoneIds) {
      if (conflictZoneIds.has(conflictZoneId))
        continue;
      diagnostics.push({ severity: "error", code: "junction-interaction-conflict-zone-missing", message: `Junction ${junction.id} interaction references missing conflict zone ${conflictZoneId}`, junctionId: junction.id });
    }
  }
  for (const zone of junction.conflictZones ?? []) {
    for (const maneuverId of zone.maneuverIds ?? []) {
      if (maneuverIds.has(maneuverId))
        continue;
      diagnostics.push({ severity: "error", code: "conflict-zone-maneuver-missing", message: `Junction ${junction.id} conflict zone ${zone.id} references missing maneuver ${maneuverId}`, junctionId: junction.id });
    }
  }
}
function validateInteractionControl(junction, interaction, diagnostics) {
  const control = interaction.control;
  if (!control) {
    diagnostics.push({ severity: "error", code: "junction-interaction-control-missing", message: `Junction ${junction.id} interaction ${interaction.id} has no compiled control`, junctionId: junction.id });
    return;
  }
  if (interaction.kind === "compatible" || interaction.kind === "diverge") {
    if (control.kind !== "none") {
      diagnostics.push({ severity: "error", code: "junction-interaction-control-superfluous", message: `Junction ${junction.id} ${interaction.kind} interaction ${interaction.id} must use no control`, junctionId: junction.id });
    }
    return;
  }
  if (control.kind === "none") {
    diagnostics.push({ severity: "error", code: "junction-interaction-control-none", message: `Junction ${junction.id} conflicting interaction ${interaction.id} has no control`, junctionId: junction.id });
    return;
  }
  if (control.kind === "unresolved") {
    diagnostics.push({ severity: "error", code: "junction-interaction-control-unresolved", message: `Junction ${junction.id} interaction ${interaction.id} is unresolved: ${control.reason}`, junctionId: junction.id });
    return;
  }
  if (control.kind === "fixed-priority") {
    if (!interaction.maneuverIds.includes(control.priorityParticipantId) || !interaction.maneuverIds.includes(control.yieldingParticipantId) || control.priorityParticipantId === control.yieldingParticipantId) {
      diagnostics.push({ severity: "error", code: "junction-interaction-fixed-priority-members", message: `Junction ${junction.id} interaction ${interaction.id} has invalid fixed-priority members`, junctionId: junction.id });
    }
    if (interaction.priorityManeuverId !== control.priorityParticipantId) {
      diagnostics.push({ severity: "error", code: "junction-interaction-priority-mirror", message: `Junction ${junction.id} interaction ${interaction.id} priority mirror disagrees with its control`, junctionId: junction.id });
    }
    return;
  }
  if (interaction.priorityManeuverId) {
    diagnostics.push({ severity: "error", code: "junction-interaction-dynamic-priority", message: `Junction ${junction.id} dynamic interaction ${interaction.id} cannot expose a fixed priority`, junctionId: junction.id });
  }
  if (control.kind === "zipper" && interaction.kind !== "merge") {
    diagnostics.push({ severity: "error", code: "junction-interaction-zipper-kind", message: `Junction ${junction.id} zipper interaction ${interaction.id} is not a merge`, junctionId: junction.id });
  }
  if (control.kind === "signal") {
    const signalPlan = junction.control?.kind === "signal" ? junction.control : undefined;
    const signalGroupIds = new Set(signalPlan?.groups.map((group) => group.id) ?? []);
    if (!signalPlan || signalPlan.controllerId !== control.controllerId || control.signalGroupIds.some((groupId) => !signalGroupIds.has(groupId))) {
      diagnostics.push({ severity: "error", code: "junction-interaction-signal-reference", message: `Junction ${junction.id} interaction ${interaction.id} has invalid signal references`, junctionId: junction.id });
    }
  }
}
function validateVirtualJunctionNetwork(network, junction, diagnostics) {
  const range = junction.virtualRange;
  if (junction.kind !== "virtual") {
    if (range)
      diagnostics.push({ severity: "error", code: "non-virtual-junction-range", message: `Junction ${junction.id} has virtual range metadata`, junctionId: junction.id });
    return;
  }
  if (!range) {
    diagnostics.push({ severity: "error", code: "virtual-junction-range-missing", message: `Virtual junction ${junction.id} needs a main-road range`, junctionId: junction.id });
    return;
  }
  const mainRoad = network.roads.find((road) => road.id === range.mainRoadId);
  if (!mainRoad || range.sStart < 0 || range.sEnd <= range.sStart || range.sEnd > (mainRoad?.length ?? -1)) {
    diagnostics.push({ severity: "error", code: "virtual-junction-range-invalid", message: `Virtual junction ${junction.id} has an invalid main-road range`, roadId: range.mainRoadId, junctionId: junction.id });
  }
  if (!(junction.ports ?? []).some((port) => port.roadId === range.mainRoadId)) {
    diagnostics.push({ severity: "error", code: "virtual-junction-main-road-port-missing", message: `Virtual junction ${junction.id} has no main-road port`, roadId: range.mainRoadId, junctionId: junction.id });
  }
  for (const connection of junction.connections) {
    if (connection.incomingRoadId !== range.mainRoadId && connection.connectingRoadId !== range.mainRoadId) {
      diagnostics.push({ severity: "error", code: "virtual-junction-non-main-branch", message: `Virtual junction ${junction.id} connection ${connection.id} bypasses its main road`, junctionId: junction.id });
    }
  }
  const portFrames = (junction.ports ?? []).flatMap((port) => {
    const road = network.roads.find((candidate) => candidate.id === port.roadId);
    if (!road)
      return [];
    const s = port.s ?? (port.contactPoint === "start" ? 0 : road.length);
    return [evaluateRoadFrame(road, s)];
  });
  if (portFrames.some((frame) => Math.abs(frame.grade) > 0.000001 || Math.abs(frame.roll) > 0.000001) || portFrames.some((frame) => Math.abs(frame.origin.z - (portFrames[0]?.origin.z ?? 0)) > 0.000001)) {
    diagnostics.push({ severity: "error", code: "virtual-junction-not-flat", message: `Virtual junction ${junction.id} must be flat`, junctionId: junction.id });
  }
}
function validateConnectorObjectClearance(network, diagnostics) {
  for (const violation of connectorObjectClearanceViolations(network)) {
    diagnostics.push({
      severity: "error",
      code: "connector-object-overlap",
      message: `Connector ${violation.roadId} overlaps junction object ${violation.objectId} by ${violation.overlapArea.toFixed(3)} m2`,
      roadId: violation.roadId,
      junctionId: violation.junctionId
    });
  }
}
function validateNetworkObjects(network, junctionIds, diagnostics) {
  const ids = new Set;
  for (const object of network.objects ?? []) {
    if (ids.has(object.id))
      diagnostics.push({ severity: "error", code: "duplicate-network-object-id", message: `Duplicate network object ${object.id}`, junctionId: object.junctionId });
    ids.add(object.id);
    if (object.junctionId && !junctionIds.has(object.junctionId)) {
      diagnostics.push({ severity: "error", code: "network-object-junction-missing", message: `Object ${object.id} references missing junction ${object.junctionId}`, junctionId: object.junctionId });
    }
    if (!object.polygon || object.polygon.length < 3 || object.polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      diagnostics.push({ severity: "error", code: "network-object-polygon", message: `World-space object ${object.id} needs a finite polygon`, junctionId: object.junctionId });
    }
  }
}
function validateJunctionConnection(junction, connection, incomingRoad, connectingRoad, diagnostics) {
  if (connection.sourceManeuverId && connection.sourceLaneContinuationId) {
    diagnostics.push({
      severity: "error",
      code: "junction-connection-source-ambiguous",
      message: `Junction ${junction.id} connection ${connection.id} has both maneuver and lane-continuation identity`,
      junctionId: junction.id
    });
  }
  if (connection.sourceLaneContinuationId && connection.laneDirection === undefined) {
    diagnostics.push({
      severity: "error",
      code: "junction-lane-continuation-direction",
      message: `Junction ${junction.id} continuation connection ${connection.id} needs an explicit physical-band direction`,
      junctionId: junction.id
    });
  }
  const incomingS = connection.incomingS ?? (connection.incomingContactPoint === "start" ? 0 : incomingRoad.length);
  const connectingS = connection.connectingS ?? (connection.contactPoint === "start" ? 0 : connectingRoad.length);
  const incomingSection = sectionAtIncoming4(incomingRoad, incomingS);
  const connectingSection = sectionAt4(connectingRoad, connectingS);
  const incomingSInRange = Number.isFinite(incomingS) && incomingS >= -0.0000001 && incomingS <= incomingRoad.length + 0.0000001;
  const connectingSInRange = Number.isFinite(connectingS) && connectingS >= -0.0000001 && connectingS <= connectingRoad.length + 0.0000001;
  if (!incomingSInRange) {
    diagnostics.push({
      severity: "error",
      code: "junction-incoming-s-out-of-range",
      message: `Junction ${junction.id} connection ${connection.id} has incomingS outside road ${incomingRoad.id}`,
      roadId: incomingRoad.id,
      junctionId: junction.id
    });
  }
  if (!connectingSInRange) {
    diagnostics.push({
      severity: "error",
      code: "junction-connecting-s-out-of-range",
      message: `Junction ${junction.id} connection ${connection.id} has connectingS outside road ${connectingRoad.id}`,
      roadId: connectingRoad.id,
      junctionId: junction.id
    });
  }
  if (!incomingSection || !connectingSection)
    return;
  for (const laneLink of connection.laneLinks) {
    const incomingLane = incomingSection.lanes.find((lane) => lane.id === laneLink.from);
    const connectingLane = connectingSection.lanes.find((lane) => lane.id === laneLink.to);
    if (!incomingLane) {
      diagnostics.push({
        severity: "error",
        code: "junction-missing-from-lane",
        message: `Junction ${junction.id} connection ${connection.id} references missing incoming lane ${laneLink.from}`,
        roadId: incomingRoad.id,
        junctionId: junction.id,
        sectionId: incomingSection.id,
        laneId: laneLink.from
      });
    }
    if (!connectingLane) {
      diagnostics.push({
        severity: "error",
        code: "junction-missing-to-lane",
        message: `Junction ${junction.id} connection ${connection.id} references missing connecting lane ${laneLink.to}`,
        roadId: connectingRoad.id,
        junctionId: junction.id,
        sectionId: connectingSection.id,
        laneId: laneLink.to
      });
    }
    if (incomingLane && connectingLane) {
      if (connection.sourceLaneContinuationId && !validCompiledContinuationFlow(connection.laneDirection, incomingLane, connection.incomingContactPoint, connectingLane, connection.contactPoint, Boolean(junction.profileTransition))) {
        diagnostics.push({
          severity: "error",
          code: "junction-lane-continuation-direction",
          message: `Junction ${junction.id} continuation ${connection.id} has incompatible source-to-connector lane flow`,
          roadId: incomingRoad.id,
          junctionId: junction.id,
          sectionId: incomingSection.id,
          laneId: incomingLane.id
        });
      }
      const incomingZ = laneContactMeanZ(incomingRoad, incomingSection, incomingLane, incomingS);
      const connectingZ = laneContactMeanZ(connectingRoad, connectingSection, connectingLane, connectingS);
      if (Math.abs(incomingZ - connectingZ) > 0.05) {
        diagnostics.push({
          severity: "error",
          code: "junction-elevation-mismatch",
          message: `Junction ${junction.id} connection ${connection.id} joins lane z=${incomingZ.toFixed(3)} to z=${connectingZ.toFixed(3)}`,
          roadId: incomingRoad.id,
          junctionId: junction.id
        });
      }
      validateJunctionLaneLinkCompatibility(junction, connection, incomingRoad, incomingSection, incomingLane, connectingLane, diagnostics);
    }
    if (junction.kind === "direct" && incomingLane && connectingLane && incomingSInRange && connectingSInRange) {
      validateDirectJunctionLaneLinkDistance(junction, connection, incomingRoad, connectingRoad, incomingSection, connectingSection, laneLink, incomingS, connectingS, diagnostics);
    }
  }
}
function validCompiledContinuationFlow(direction, incomingLane, incomingContactPoint, connectingLane, connectingContactPoint, allowPhysicalMorph) {
  if (!isPhysicalLaneContinuationType(incomingLane.type) || !isPhysicalLaneContinuationType(connectingLane.type) || !allowPhysicalMorph && incomingLane.type !== connectingLane.type)
    return false;
  if (direction === "both") {
    return incomingLane.direction === "both" && connectingLane.direction === "both";
  }
  if (direction !== "standard")
    return false;
  return laneApproachesContact2(incomingLane, incomingContactPoint) && laneLeavesContact2(connectingLane, connectingContactPoint);
}
function laneApproachesContact2(lane, contactPoint) {
  if (lane.direction === "both")
    return true;
  const sign = laneTravelSign(lane);
  return sign > 0 ? contactPoint !== "start" : contactPoint === "start";
}
function laneLeavesContact2(lane, contactPoint) {
  if (lane.direction === "both")
    return true;
  const sign = laneTravelSign(lane);
  return sign > 0 ? contactPoint === "start" : contactPoint === "end";
}
function laneContactMeanZ(road, section, lane, s) {
  const contact = laneContactGeometry(road, section, lane, s);
  return (contact.left.z + contact.right.z) * 0.5;
}
function validateJunctionLaneLinkCompatibility(junction, connection, incomingRoad, incomingSection, incomingLane, connectingLane, diagnostics) {
  if (connection.sourceLaneContinuationId && (incomingLane.type === connectingLane.type || junction.profileTransition && isPhysicalLaneContinuationType(incomingLane.type) && isPhysicalLaneContinuationType(connectingLane.type)))
    return;
  const incomingModes = laneTravelModes(incomingLane);
  const connectingModes = laneTravelModes(connectingLane);
  if (incomingModes.some((mode) => connectingModes.includes(mode)))
    return;
  diagnostics.push({
    severity: "error",
    code: "junction-lane-link-modal-mismatch",
    message: `Junction ${junction.id} connection ${connection.id} links ${incomingLane.type} lane ${incomingLane.id} to ${connectingLane.type} lane ${connectingLane.id}`,
    roadId: incomingRoad.id,
    junctionId: junction.id,
    sectionId: incomingSection.id,
    laneId: incomingLane.id
  });
}
function laneTravelModes(lane) {
  return effectiveLaneAccess(lane);
}
var MAX_DIRECT_JUNCTION_POSITION_ERROR = 0.00001;
var MAX_DIRECT_JUNCTION_HEADING_ERROR = 0.000001;
var MAX_DIRECT_JUNCTION_CURVATURE_ERROR = 0.000001;
var MAX_DIRECT_JUNCTION_GRADE_ERROR = 0.000001;
var MAX_DIRECT_JUNCTION_ROLL_ERROR = 0.000001;
var MAX_DIRECT_JUNCTION_WIDTH_ERROR = 0.000001;
function validateDirectJunctionLaneLinkDistance(junction, connection, incomingRoad, connectingRoad, incomingSection, connectingSection, laneLink, incomingS, connectingS, diagnostics) {
  const incomingLane = incomingSection.lanes.find((lane) => lane.id === laneLink.from);
  const connectingLane = connectingSection.lanes.find((lane) => lane.id === laneLink.to);
  if (!incomingLane || !connectingLane)
    return;
  const from = laneContactGeometry(incomingRoad, incomingSection, incomingLane, incomingS);
  const to = laneContactGeometry(connectingRoad, connectingSection, connectingLane, connectingS);
  const positionError = Math.max(pointDistance32(from.left, to.left), pointDistance32(from.right, to.right));
  const headingError = Math.abs(normalizeAngle(from.heading - to.heading));
  const curvatureError = Math.abs(from.curvature - to.curvature);
  const gradeError = Math.abs(from.grade - to.grade);
  const rollError = Math.abs(from.roll - to.roll);
  const widthError = Math.abs(from.width - to.width);
  const context = {
    roadId: incomingRoad.id,
    junctionId: junction.id,
    sectionId: incomingSection.id,
    laneId: laneLink.from
  };
  if (positionError > MAX_DIRECT_JUNCTION_POSITION_ERROR) {
    diagnostics.push({
      severity: "error",
      code: "direct-junction-link-distance",
      message: `Direct junction ${junction.id} connection ${connection.id} lane boundaries miss by ${positionError.toFixed(6)} m`,
      ...context
    });
  }
  if (headingError > MAX_DIRECT_JUNCTION_HEADING_ERROR) {
    diagnostics.push({
      severity: "error",
      code: "direct-junction-contact-heading",
      message: `Direct junction ${junction.id} connection ${connection.id} heading differs by ${headingError.toFixed(6)} rad`,
      ...context
    });
  }
  if ((connection.requiredContinuity ?? "g1") === "g2" && curvatureError > MAX_DIRECT_JUNCTION_CURVATURE_ERROR) {
    diagnostics.push({
      severity: "error",
      code: "direct-junction-contact-curvature",
      message: `Direct junction ${junction.id} connection ${connection.id} curvature differs by ${curvatureError.toFixed(6)} 1/m`,
      ...context
    });
  }
  if (gradeError > MAX_DIRECT_JUNCTION_GRADE_ERROR) {
    diagnostics.push({
      severity: "error",
      code: "direct-junction-contact-grade",
      message: `Direct junction ${junction.id} connection ${connection.id} grade differs by ${gradeError.toFixed(6)}`,
      ...context
    });
  }
  if (rollError > MAX_DIRECT_JUNCTION_ROLL_ERROR) {
    diagnostics.push({
      severity: "error",
      code: "direct-junction-contact-roll",
      message: `Direct junction ${junction.id} connection ${connection.id} bank differs by ${rollError.toFixed(6)} rad`,
      ...context
    });
  }
  if (widthError > MAX_DIRECT_JUNCTION_WIDTH_ERROR) {
    diagnostics.push({
      severity: "error",
      code: "direct-junction-contact-width",
      message: `Direct junction ${junction.id} connection ${connection.id} width differs by ${widthError.toFixed(6)} m`,
      ...context
    });
  }
}
function validateReferenceLine(road, diagnostics) {
  const geometry = road.referenceLine.geometry;
  if (geometry.length === 0) {
    push(diagnostics, "error", "empty-reference-line", `Road ${road.id} has no reference-line geometry`, road);
    return;
  }
  if (!nearlyEqual(geometry[0].s, 0)) {
    push(diagnostics, "error", "reference-line-start", `Road ${road.id} reference line must start at s=0`, road);
  }
  for (let i = 0;i < geometry.length; i++) {
    const segment = geometry[i];
    if (segment.length <= 0) {
      push(diagnostics, "error", "invalid-geometry-length", `Road ${road.id} has non-positive geometry length`, road);
    }
    if (i > 0) {
      const previous = geometry[i - 1];
      const expectedS = previous.s + previous.length;
      if (!nearlyEqual(segment.s, expectedS, 0.0001)) {
        push(diagnostics, "error", "reference-line-gap", `Road ${road.id} geometry has a gap or overlap at s=${segment.s}`, road);
      }
      const previousEnd = evaluateGeometrySegment(previous, previous.length);
      const segmentStart = evaluateGeometrySegment(segment, 0);
      const positionGap = Math.hypot(previousEnd.x - segmentStart.x, previousEnd.y - segmentStart.y);
      if (positionGap > 0.0001) {
        push(diagnostics, "error", "reference-line-position-discontinuity", `Road ${road.id} geometry position jumps ${positionGap.toFixed(4)} m at s=${segment.s}`, road);
      }
      const headingGap = Math.abs(normalizeAngle(previousEnd.heading - segmentStart.heading));
      if (headingGap > 0.0001) {
        push(diagnostics, "error", "reference-line-heading-discontinuity", `Road ${road.id} geometry heading jumps ${headingGap.toFixed(4)} rad at s=${segment.s}`, road);
      }
    }
  }
  const computedLength = referenceLineLength(road.referenceLine);
  if (!nearlyEqual(road.length, computedLength, 0.001)) {
    push(diagnostics, "error", "road-length-mismatch", `Road ${road.id} length does not match reference-line length`, road);
  }
}
function validateLaneSections(road, diagnostics) {
  if (road.laneSections.length === 0) {
    push(diagnostics, "error", "missing-lane-sections", `Road ${road.id} has no lane sections`, road);
    return;
  }
  const sorted = [...road.laneSections].sort((a, b) => a.s - b.s);
  if (!nearlyEqual(sorted[0].s, 0)) {
    push(diagnostics, "error", "lane-section-start", `Road ${road.id} first lane section must start at s=0`, road, sorted[0]);
  }
  for (let i = 0;i < sorted.length; i++) {
    const section = sorted[i];
    if (i > 0 && section.s <= sorted[i - 1].s) {
      push(diagnostics, "error", "lane-section-order", `Road ${road.id} has unordered lane sections`, road, section);
    }
    if (section.s >= road.length && !nearlyEqual(section.s, 0)) {
      push(diagnostics, "error", "lane-section-out-of-range", `Road ${road.id} lane section ${section.id} is outside the road`, road, section);
    }
    validateLanes(road, section, diagnostics);
  }
}
function validateLanes(road, section, diagnostics) {
  const ids = section.lanes.map((lane) => lane.id);
  if (!ids.includes(0)) {
    push(diagnostics, "error", "missing-center-lane", `Road ${road.id} section ${section.id} is missing center lane 0`, road, section);
  }
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    push(diagnostics, "error", "duplicate-lane-id", `Road ${road.id} section ${section.id} has duplicate lane ids`, road, section);
  }
  validateConsecutiveLaneIds(road, section, ids.filter((id) => id > 0).sort((a, b) => a - b), diagnostics);
  validateConsecutiveLaneIds(road, section, ids.filter((id) => id < 0).sort((a, b) => b - a), diagnostics);
  for (const lane of section.lanes) {
    if (lane.id === 0 && lane.widths.length > 0) {
      push(diagnostics, "error", "center-lane-width", `Center lane 0 on road ${road.id} must not have widths`, road, section, lane);
    }
    validateLaneWidths(road, section, lane, diagnostics);
    validateLaneMarkingRanges(road, section, lane, diagnostics);
  }
  validateLaneHeightSteps(road, section, diagnostics);
  validateLevelLaneOrdering(road, section, diagnostics);
}
function validateLevelLaneOrdering(road, section, diagnostics) {
  for (const side of [1, -1]) {
    const lanes = section.lanes.filter((lane) => Math.sign(lane.id) === side).sort((left, right) => Math.abs(left.id) - Math.abs(right.id));
    let reachedLevelLane = false;
    for (const [index, lane] of lanes.entries()) {
      const inner = lanes[index - 1];
      if (inner && lanesHaveVerticalSeparation(inner, lane))
        reachedLevelLane = false;
      if (lane.level)
        reachedLevelLane = true;
      else if (reachedLevelLane) {
        push(diagnostics, "error", "lane-level-order", `Road ${road.id} lane ${lane.id} must be level because an inward lane is level`, road, section, lane);
      }
    }
  }
}
function validateLaneHeightSteps(road, section, diagnostics) {
  const sectionLength = laneSectionEndS(road, section) - section.s;
  const samples2 = [0, sectionLength * 0.5, sectionLength];
  for (const side of [1, -1]) {
    const lanes = section.lanes.filter((lane) => Math.sign(lane.id) === side).sort((a, b) => Math.abs(a.id) - Math.abs(b.id));
    for (let i = 1;i < lanes.length; i++) {
      const inner = lanes[i - 1];
      const outer = lanes[i];
      for (const localS of samples2) {
        if (laneWidthAt(inner, localS) <= 0.000001 || laneWidthAt(outer, localS) <= 0.000001)
          continue;
        const innerHeight = laneHeightAt(inner, localS).outer;
        const outerHeight = laneHeightAt(outer, localS).inner;
        const heightStep = Math.abs(innerHeight - outerHeight);
        const intentionalVerticalEdge = lanesHaveVerticalSeparation(inner, outer) && heightStep <= 0.3;
        if (heightStep > 0.02 && !intentionalVerticalEdge) {
          push(diagnostics, "warning", "lane-height-step", `Road ${road.id} lanes ${inner.id}/${outer.id} step from h=${innerHeight} to h=${outerHeight} without a curb ramp`, road, section, outer);
          break;
        }
      }
    }
  }
}
function validateLaneMarkingRanges(road, section, lane, diagnostics) {
  const sectionEnd = laneSectionEndS(road, section);
  for (const marking of lane.markings ?? []) {
    const sStart = marking.sStart ?? section.s;
    const sEnd = marking.sEnd ?? sectionEnd;
    if (sEnd < sStart || sStart < -0.0000001 || sEnd > road.length + 0.0000001) {
      push(diagnostics, "error", "lane-marking-range", `Lane ${lane.id} marking ${marking.id} on road ${road.id} has an invalid s range`, road, section, lane);
    }
    if (sStart < section.s - 0.0000001 || sEnd > sectionEnd + 0.0000001) {
      push(diagnostics, "error", "lane-marking-outside-section", `Lane ${lane.id} marking ${marking.id} on road ${road.id} extends outside section ${section.id}`, road, section, lane);
    }
  }
}
function validateConsecutiveLaneIds(road, section, ids, diagnostics) {
  ids.forEach((id, index) => {
    const expected = Math.sign(id) * (index + 1);
    if (id !== expected) {
      push(diagnostics, "error", "non-consecutive-lane-ids", `Road ${road.id} section ${section.id} lane ids must be consecutive`, road, section);
    }
  });
}
function validateLaneWidths(road, section, lane, diagnostics) {
  if (lane.id === 0)
    return;
  if (lane.widths.length === 0) {
    push(diagnostics, "error", "missing-lane-width", `Lane ${lane.id} on road ${road.id} needs a width record`, road, section, lane);
    return;
  }
  const sorted = [...lane.widths].sort((a, b) => a.sOffset - b.sOffset);
  if (!nearlyEqual(sorted[0].sOffset, 0)) {
    push(diagnostics, "error", "lane-width-start", `Lane ${lane.id} on road ${road.id} needs a width at sOffset=0`, road, section, lane);
  }
  const sectionLength = laneSectionEndS(road, section) - section.s;
  for (const width of sorted) {
    if (width.sOffset < 0 || width.sOffset >= sectionLength + 0.0000001) {
      push(diagnostics, "error", "lane-width-out-of-range", `Lane ${lane.id} on road ${road.id} has a width outside its section`, road, section, lane);
    }
    if (width.a < 0) {
      push(diagnostics, "error", "negative-lane-width", `Lane ${lane.id} on road ${road.id} has a negative width`, road, section, lane);
    }
  }
  const extrema = laneWidthExtrema(lane, sectionLength);
  if (extrema.minimum < -0.005) {
    push(diagnostics, "error", "negative-sampled-lane-width", `Lane ${lane.id} on road ${road.id} has a negative width at sOffset=${extrema.minimumS.toFixed(3)}`, road, section, lane);
    return;
  }
  if (extrema.maximum <= 0.000001) {
    push(diagnostics, "error", "zero-width-lane", `Lane ${lane.id} on road ${road.id} never reaches a positive width`, road, section, lane);
  }
}
function validateElevation(road, diagnostics) {
  validateCubicProfile(road, road.elevation, diagnostics, "elevation", "z");
}
function validateSuperelevation(road, diagnostics) {
  validateCubicProfile(road, road.superelevation, diagnostics, "superelevation", "bank");
  const records = [...road.superelevation ?? []].sort((a, b) => a.s - b.s);
  for (let index = 0;index < records.length; index++) {
    const record = records[index];
    const activeEndS = records[index + 1]?.s ?? road.length;
    const activeLength = activeEndS - record.s;
    const sampleCount = Math.max(1, Math.ceil(activeLength / 20));
    for (let i = 0;i <= sampleCount; i++) {
      const localS = activeLength * i / sampleCount;
      if (Math.abs(evaluateCubic(record, localS)) > MAX_SUPERELEVATION_RADIANS + 0.0000001) {
        push(diagnostics, "error", "superelevation-out-of-range", `Road ${road.id} superelevation exceeds plausible banking limits`, road);
        return;
      }
    }
  }
}
var MAX_SUPERELEVATION_RADIANS = 0.22;
function validateCubicProfile(road, records, diagnostics, codePrefix, label) {
  if (!records || records.length === 0)
    return;
  const sorted = [...records].sort((a, b) => a.s - b.s);
  if (!nearlyEqual(sorted[0].s, 0)) {
    push(diagnostics, "error", `${codePrefix}-start`, `Road ${road.id} ${codePrefix} profile must start at s=0`, road);
  }
  for (let i = 0;i < sorted.length; i++) {
    const record = sorted[i];
    if (record.s < -0.0000001 || record.s > road.length + 0.0000001) {
      push(diagnostics, "error", `${codePrefix}-out-of-range`, `Road ${road.id} ${codePrefix} record at s=${record.s} is outside the road`, road);
    }
    if (i > 0) {
      const previous = sorted[i - 1];
      const before = evaluateCubic(previous, record.s - previous.s);
      const after = evaluateCubic(record, 0);
      if (Math.abs(before - after) > 0.001) {
        push(diagnostics, "error", `${codePrefix}-discontinuity`, `Road ${road.id} ${codePrefix} jumps from ${label}=${before.toFixed(3)} to ${label}=${after.toFixed(3)} at s=${record.s}`, road);
      }
    }
  }
}
var BAND_MARKING_KINDS = new Set(["zebra", "crosswalk", "crossing", "stop-line", "yield-line", "hatched-area"]);
function validateRoadMarkings(road, diagnostics) {
  for (const marking of road.markings ?? []) {
    if (marking.sEnd < marking.sStart || marking.sStart < -0.0000001 || marking.sEnd > road.length + 0.0000001) {
      push(diagnostics, "error", "road-marking-range", `Marking ${marking.id} on road ${road.id} has an invalid s range`, road);
    }
    if (BAND_MARKING_KINDS.has(marking.kind)) {
      const tStart = marking.tStart ?? marking.tOffset - (marking.width ?? 0) / 2;
      const tEnd = marking.tEnd ?? marking.tOffset + (marking.width ?? 0) / 2;
      const tStartAtEnd = marking.tStartAtEnd ?? tStart;
      const tEndAtEnd = marking.tEndAtEnd ?? tEnd;
      if (tEnd - tStart <= 0.000001 || tEndAtEnd - tStartAtEnd <= 0.000001) {
        push(diagnostics, "error", "road-marking-band-extent", `Marking ${marking.id} on road ${road.id} needs a lateral extent (tStart/tEnd or width)`, road);
      }
    }
    if (marking.kind === "arrow" && !marking.arrow) {
      push(diagnostics, "error", "road-marking-arrow-direction", `Arrow marking ${marking.id} on road ${road.id} needs an arrow direction`, road);
    }
  }
}
function validateRoadObjects(network, road, diagnostics) {
  for (const object of road.objects ?? []) {
    if (object.s < -0.0000001 || object.s > road.length + 0.0000001) {
      push(diagnostics, "error", "road-object-range", `Object ${object.id} on road ${road.id} sits outside the road s range`, road);
    }
    if (object.repeat && (object.repeat.count < 1 || object.repeat.spacing <= 0)) {
      push(diagnostics, "error", "road-object-repeat", `Object ${object.id} on road ${road.id} has an invalid repeat`, road);
    }
    if (object.repeat?.lateralOffsets && (object.repeat.lateralOffsets.length !== object.repeat.count || object.repeat.lateralOffsets.some((offset) => !Number.isFinite(offset)))) {
      push(diagnostics, "error", "road-object-repeat-offsets", `Object ${object.id} on road ${road.id} has invalid repeated lateral offsets`, road);
    }
    if (object.kind === "parking-space") {
      if (!object.orientation) {
        push(diagnostics, "error", "parking-orientation-missing", `Parking object ${object.id} on road ${road.id} needs an orientation`, road);
      }
      if (!(object.length && object.length > 0) || !(object.width && object.width > 0)) {
        push(diagnostics, "error", "parking-size-missing", `Parking object ${object.id} on road ${road.id} needs positive length and width`, road);
      }
      if (object.orientation === "angled" && object.angle === undefined) {
        push(diagnostics, "error", "parking-angle-missing", `Angled parking object ${object.id} on road ${road.id} needs an angle`, road);
      }
    }
    if (object.kind === "island" && object.polygon && object.polygon.length < 3) {
      push(diagnostics, "error", "island-polygon-invalid", `Island ${object.id} on road ${road.id} needs at least three polygon points`, road);
    }
    if (object.structureId) {
      const structure = network.roadStructures?.find((candidate) => candidate.id === object.structureId);
      const halfLength = (object.length ?? 0) * 0.5;
      const halfWidth = (object.width ?? 0) * 0.5;
      const repeatEnd = object.s + Math.max(0, (object.repeat?.count ?? 1) - 1) * (object.repeat?.spacing ?? 0);
      if (!structure) {
        push(diagnostics, "error", "road-object-structure-missing", `Object ${object.id} references missing road structure ${object.structureId}`, road);
      } else if (structure.roadId !== road.id) {
        push(diagnostics, "error", "road-object-structure-road-mismatch", `Object ${object.id} and road structure ${structure.id} belong to different roads`, road);
      } else {
        if (object.s - halfLength < structure.sStart - 0.0000001 || repeatEnd + halfLength > structure.sEnd + 0.0000001) {
          push(diagnostics, "error", "road-object-structure-range", `Object ${object.id} extends outside road structure ${structure.id}`, road);
        }
        if (object.t - halfWidth < structure.deckTMin - 0.0000001 || object.t + halfWidth > structure.deckTMax + 0.0000001) {
          push(diagnostics, "error", "road-object-structure-envelope", `Object ${object.id} extends outside road structure ${structure.id}'s deck envelope`, road);
        }
      }
    }
  }
}
function validateRoadRouting(road, diagnostics) {
  const routing = road.routing;
  if (!routing)
    return;
  if (routing.throughTraffic !== "allowed" && routing.throughTraffic !== "destination-only") {
    push(diagnostics, "error", "road-routing-policy-invalid", `Road ${road.id} has an invalid through-traffic policy`, road);
  }
  if (routing.throughTraffic === "destination-only" && !routing.destinationZoneId?.trim()) {
    push(diagnostics, "error", "road-routing-zone-missing", `Destination-only road ${road.id} needs a destination zone`, road);
  }
}
function validateRoadLinks(road, network, roadsById, roadIds, junctionIds, diagnostics) {
  const predecessorRoadLinks = road.links?.predecessors?.filter((link) => link.roadId) ?? [];
  const successorRoadLinks = road.links?.successors?.filter((link) => link.roadId) ?? [];
  if (predecessorRoadLinks.length > 1 && !road.junctionId && !linksShareJunction(network, road.id, predecessorRoadLinks, "predecessor")) {
    push(diagnostics, "error", "ambiguous-road-predecessor", `Road ${road.id} has multiple predecessors without a junction`, road);
  }
  if (successorRoadLinks.length > 1 && !road.junctionId && !linksShareJunction(network, road.id, successorRoadLinks, "successor")) {
    push(diagnostics, "error", "ambiguous-road-successor", `Road ${road.id} has multiple successors without a junction`, road);
  }
  for (const link of [...road.links?.predecessors ?? [], ...road.links?.successors ?? []]) {
    if (link.roadId && !roadIds.has(link.roadId)) {
      push(diagnostics, "error", "missing-road-link", `Road ${road.id} links to missing road ${link.roadId}`, road);
    }
    if (link.junctionId && !junctionIds.has(link.junctionId)) {
      push(diagnostics, "error", "missing-junction-link", `Road ${road.id} links to missing junction ${link.junctionId}`, road);
    }
  }
  for (const section of road.laneSections) {
    for (const lane of section.lanes) {
      for (const laneLink of [lane.links?.predecessor, lane.links?.successor]) {
        if (!laneLink)
          continue;
        const targetRoad = roadsById.get(laneLink.roadId);
        if (!targetRoad) {
          push(diagnostics, "error", "missing-lane-link-road", `Lane ${lane.id} on road ${road.id} links to missing road`, road, section, lane);
          continue;
        }
        if (!targetRoad.laneSections.some((targetSection) => targetSection.lanes.some((targetLane) => targetLane.id === laneLink.laneId))) {
          push(diagnostics, "error", "missing-lane-link-lane", `Lane ${lane.id} on road ${road.id} links to missing lane`, road, section, lane);
        }
        if (laneLink.s !== undefined && (!Number.isFinite(laneLink.s) || laneLink.s < 0 || laneLink.s > targetRoad.length)) {
          push(diagnostics, "error", "lane-link-s-out-of-range", `Lane ${lane.id} on road ${road.id} links outside road ${targetRoad.id}`, road, section, lane);
        }
      }
    }
  }
  if (road.kind === "connector" && road.requiredEndpointContinuity) {
    validateConnectorContacts(road, roadsById, diagnostics);
  }
  validateDirectRoadContacts(road, roadsById, diagnostics);
}
function validateDirectRoadContacts(road, roadsById, diagnostics) {
  for (const link of road.links?.successors ?? []) {
    if (!link.roadId || !link.requiredContinuity || link.junctionId)
      continue;
    const target = roadsById.get(link.roadId);
    if (!target)
      continue;
    const targetS = link.contactPoint === "start" ? 0 : target.length;
    const orientation = link.contactPoint === "start" ? 1 : -1;
    const sourceFrame = evaluateRoadFrame(road, road.length);
    const targetFrame = evaluateRoadFrame(target, targetS);
    const positionError = Math.hypot(sourceFrame.origin.x - targetFrame.origin.x, sourceFrame.origin.y - targetFrame.origin.y, sourceFrame.origin.z - targetFrame.origin.z);
    const headingError = Math.abs(normalizeAngle(sourceFrame.heading - (targetFrame.heading + (orientation < 0 ? Math.PI : 0))));
    const gradeError = Math.abs(sourceFrame.grade - targetFrame.grade * orientation);
    const rollError = Math.abs(sourceFrame.roll - targetFrame.roll * orientation);
    const curvatureError = Math.abs(sourceFrame.curvature - targetFrame.curvature * orientation);
    validateDirectRoadLaneCoverage(road, target, link.contactPoint, diagnostics);
    if (positionError > MAX_DIRECT_CONTACT_POSITION_ERROR) {
      push(diagnostics, "error", "direct-road-contact-position", `Road ${road.id} misses successor ${target.id} by ${positionError.toFixed(3)} m`, road);
    }
    if (headingError > MAX_DIRECT_CONTACT_HEADING_ERROR) {
      push(diagnostics, "error", "direct-road-contact-heading", `Road ${road.id} successor heading differs by ${headingError.toFixed(4)} rad`, road);
    }
    if (gradeError > MAX_DIRECT_CONTACT_GRADE_ERROR) {
      push(diagnostics, "error", "direct-road-contact-grade", `Road ${road.id} successor grade differs by ${gradeError.toFixed(4)}`, road);
    }
    if (rollError > MAX_DIRECT_CONTACT_ROLL_ERROR) {
      push(diagnostics, "error", "direct-road-contact-roll", `Road ${road.id} successor bank differs by ${rollError.toFixed(4)} rad`, road);
    }
    if (link.requiredContinuity === "g2" && curvatureError > MAX_DIRECT_CONTACT_CURVATURE_ERROR) {
      push(diagnostics, "error", "direct-road-contact-curvature", `Road ${road.id} successor curvature differs by ${curvatureError.toFixed(4)} 1/m`, road);
    }
  }
}
function validateDirectRoadLaneCoverage(source, target, targetContactPoint, diagnostics) {
  const sourceSection = [...source.laneSections].sort((left, right) => left.s - right.s).at(-1);
  const targetSection = [...target.laneSections].sort((left, right) => left.s - right.s).at(targetContactPoint === "start" ? 0 : -1);
  if (!sourceSection || !targetSection)
    return;
  const sourceLanes = sourceSection.lanes.filter((lane) => lane.id !== 0 && laneWidthAt(lane, source.length - sourceSection.s) > 0.05);
  const targetS = targetContactPoint === "start" ? 0 : target.length;
  const targetLanes = targetSection.lanes.filter((lane) => lane.id !== 0 && laneWidthAt(lane, targetS - targetSection.s) > 0.05);
  const missingSource = sourceLanes.filter((lane) => lane.links?.successor?.roadId !== target.id);
  const missingTarget = targetLanes.filter((lane) => lane.links?.predecessor?.roadId !== source.id);
  if (missingSource.length === 0 && missingTarget.length === 0)
    return;
  push(diagnostics, "error", "direct-road-lane-coverage", `Road contact ${source.id} -> ${target.id} leaves endpoint lanes unmapped`, source);
}
var MAX_DIRECT_CONTACT_POSITION_ERROR = 0.02;
var MAX_DIRECT_CONTACT_HEADING_ERROR = 0.01;
var MAX_DIRECT_CONTACT_CURVATURE_ERROR = 0.005;
var MAX_DIRECT_CONTACT_GRADE_ERROR = 0.005;
var MAX_DIRECT_CONTACT_ROLL_ERROR = 0.005;
function validateConnectorContacts(road, roadsById, diagnostics) {
  const sorted = [...road.laneSections].sort((a, b) => a.s - b.s);
  const firstSection = sorted[0];
  const lastSection = sorted.at(-1);
  const firstLane = firstSection?.lanes.find((lane) => lane.id === -1);
  const lastLane = lastSection?.lanes.find((lane) => lane.id === -1);
  if (!firstSection || !lastSection || !firstLane || !lastLane) {
    push(diagnostics, "error", "connector-reference-lane-missing", `Connector ${road.id} needs reference-adjacent lane -1`, road);
    return;
  }
  validateConnectorContact(road, firstSection, firstLane, 0, firstLane.links?.predecessor, "predecessor", roadsById, diagnostics);
  validateConnectorContact(road, lastSection, lastLane, road.length, lastLane.links?.successor, "successor", roadsById, diagnostics);
}
function validateConnectorContact(connector, connectorSection, connectorLane, connectorS, endpoint, direction, roadsById, diagnostics) {
  if (!endpoint) {
    push(diagnostics, "error", "connector-lane-link-missing", `Connector ${connector.id} lane -1 has no ${direction}`, connector, connectorSection, connectorLane);
    return;
  }
  const targetRoad = roadsById.get(endpoint.roadId);
  const targetS = targetRoad ? endpoint.s ?? (endpoint.contactPoint === "start" ? 0 : targetRoad.length) : 0;
  const targetSection = targetRoad ? sectionAt4(targetRoad, targetS) : undefined;
  const targetLane = targetSection?.lanes.find((lane) => lane.id === endpoint.laneId);
  if (!targetRoad || !targetSection || !targetLane)
    return;
  const travelSign = laneTravelSign(connectorLane);
  const actual = laneContactGeometryAlong(connector, connectorSection, connectorLane, connectorS, travelSign);
  const actualHeading = actual.heading;
  const expected = targetLane.direction === "both" ? [-1, 1].map((sign) => laneContactGeometryAlong(targetRoad, targetSection, targetLane, targetS, sign)).sort((left, right) => Math.abs(normalizeAngle(actualHeading - left.heading)) - Math.abs(normalizeAngle(actualHeading - right.heading)))[0] : laneContactGeometry(targetRoad, targetSection, targetLane, targetS);
  const leftPositionError = pointDistance32(actual.left, expected.left);
  const rightPositionError = pointDistance32(actual.right, expected.right);
  const positionError = Math.max(leftPositionError, rightPositionError);
  const {
    heading: headingError,
    curvature: curvatureError,
    grade: gradeError,
    roll: rollError,
    width: widthError
  } = connectorContactError(actual, expected);
  if (positionError > connectorContactTolerance.position) {
    push(diagnostics, "error", "connector-contact-position", `Connector ${connector.id} ${direction} misses lane ${endpoint.laneId} on ${targetRoad.id} by ${positionError.toFixed(3)} m (left ${leftPositionError.toFixed(6)}, right ${rightPositionError.toFixed(6)})`, connector, connectorSection, connectorLane);
  }
  if (headingError > connectorContactTolerance.heading) {
    push(diagnostics, "error", "connector-contact-heading", `Connector ${connector.id} ${direction} tangent differs by ${headingError.toFixed(4)} rad`, connector, connectorSection, connectorLane);
  }
  if (connector.requiredEndpointContinuity === "g2" && curvatureError > connectorContactTolerance.curvature) {
    push(diagnostics, "error", "connector-contact-curvature", `Connector ${connector.id} ${direction} curvature differs by ${curvatureError.toFixed(4)} 1/m`, connector, connectorSection, connectorLane);
  }
  if (gradeError > connectorContactTolerance.grade) {
    push(diagnostics, "error", "connector-contact-grade", `Connector ${connector.id} ${direction} grade differs by ${gradeError.toFixed(4)}`, connector, connectorSection, connectorLane);
  }
  if (rollError > connectorContactTolerance.roll) {
    push(diagnostics, "error", "connector-contact-roll", `Connector ${connector.id} ${direction} bank differs by ${rollError.toFixed(4)} rad`, connector, connectorSection, connectorLane);
  }
  if (widthError > connectorContactTolerance.width) {
    push(diagnostics, "error", "connector-contact-width", `Connector ${connector.id} ${direction} width differs by ${widthError.toFixed(6)} m`, connector, connectorSection, connectorLane);
  }
}
function pointDistance32(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
function linksShareJunction(network, roadId, links, direction) {
  const linkedRoadIds = links.map((link) => link.roadId).filter((id) => Boolean(id));
  return network.junctions.some((junction) => linkedRoadIds.every((linkedRoadId) => junction.connections.some((connection) => direction === "predecessor" ? connection.incomingRoadId === linkedRoadId && connection.connectingRoadId === roadId : connection.incomingRoadId === roadId && connection.connectingRoadId === linkedRoadId)));
}
function validateReferenceLineIntersections(network, diagnostics) {
  const sampledRoads = new Map(network.roads.map((road) => {
    const samples2 = sampleRoadReferenceStations(road, 5);
    return [road.id, { samples: samples2, bounds: referenceSampleBounds(samples2) }];
  }));
  const junctionMembership = roadJunctionMembership(network);
  for (const [i, j] of referenceLineCandidatePairs(network.roads, sampledRoads)) {
    const a = network.roads[i];
    const b = network.roads[j];
    const aSample = sampledRoads.get(a.id);
    const bSample = sampledRoads.get(b.id);
    if (!referenceSampleBoundsOverlap(aSample.bounds, bSample.bounds))
      continue;
    if (shareJunction(junctionMembership, a.id, b.id))
      continue;
    const aPoints = aSample.samples;
    const bPoints = bSample.samples;
    for (let ai = 0;ai < aPoints.length - 1; ai++) {
      for (let bi = 0;bi < bPoints.length - 1; bi++) {
        if (segmentsIntersect(aPoints[ai].point, aPoints[ai + 1].point, bPoints[bi].point, bPoints[bi + 1].point)) {
          const intersection2 = segmentIntersectionParameters(aPoints[ai].point, aPoints[ai + 1].point, bPoints[bi].point, bPoints[bi + 1].point);
          if (!intersection2 && linkedContactsCoincide(a, b))
            continue;
          const aS = intersection2 ? aPoints[ai].s + (aPoints[ai + 1].s - aPoints[ai].s) * intersection2.ab : undefined;
          const bS = intersection2 ? bPoints[bi].s + (bPoints[bi + 1].s - bPoints[bi].s) * intersection2.cd : undefined;
          if (aS !== undefined && bS !== undefined && directContinuityAt(network, a, b, aS, bS))
            continue;
          if (aS !== undefined && bS !== undefined && authoredGradeSeparationAt(network, a.id, b.id, aS, bS))
            continue;
          if (intersection2 && isGradeSeparated(a, b, aPoints[ai], aPoints[ai + 1], bPoints[bi], bPoints[bi + 1], intersection2.ab, intersection2.cd)) {
            continue;
          }
          diagnostics.push({
            severity: "error",
            code: "reference-line-crossing-without-junction",
            message: `Roads ${a.id} and ${b.id} cross without a junction`,
            roadId: a.id
          });
          return;
        }
      }
    }
  }
}
var REFERENCE_LINE_GRID_CELL_SIZE = 128;
function referenceLineCandidatePairs(roads, sampledRoads) {
  const cells = new Map;
  roads.forEach((road, index) => {
    const bounds = sampledRoads.get(road.id)?.bounds;
    if (!bounds)
      return;
    const minX = Math.floor(bounds.minX / REFERENCE_LINE_GRID_CELL_SIZE);
    const maxX = Math.floor(bounds.maxX / REFERENCE_LINE_GRID_CELL_SIZE);
    const minY = Math.floor(bounds.minY / REFERENCE_LINE_GRID_CELL_SIZE);
    const maxY = Math.floor(bounds.maxY / REFERENCE_LINE_GRID_CELL_SIZE);
    for (let x = minX;x <= maxX; x++) {
      for (let y = minY;y <= maxY; y++) {
        const key = `${x}:${y}`;
        const values = cells.get(key);
        if (values)
          values.push(index);
        else
          cells.set(key, [index]);
      }
    }
  });
  const pairKeys = new Set;
  for (const indexes of cells.values()) {
    for (let left = 0;left < indexes.length; left++) {
      for (let right = left + 1;right < indexes.length; right++) {
        const first = Math.min(indexes[left], indexes[right]);
        const second = Math.max(indexes[left], indexes[right]);
        if (first !== second)
          pairKeys.add(`${first}:${second}`);
      }
    }
  }
  return [...pairKeys].map((key) => {
    const separator = key.indexOf(":");
    return [Number(key.slice(0, separator)), Number(key.slice(separator + 1))];
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}
function authoredGradeSeparationAt(network, firstRoadId, secondRoadId, firstS, secondS) {
  const stationTolerance = 0.1;
  return (network.gradeSeparations ?? []).some((separation) => {
    const direct = separation.upperRoad.roadId === firstRoadId && separation.lowerRoad.roadId === secondRoadId && nearlyEqual(separation.upperRoad.s, firstS, stationTolerance) && nearlyEqual(separation.lowerRoad.s, secondS, stationTolerance);
    const reversed = separation.upperRoad.roadId === secondRoadId && separation.lowerRoad.roadId === firstRoadId && nearlyEqual(separation.upperRoad.s, secondS, stationTolerance) && nearlyEqual(separation.lowerRoad.s, firstS, stationTolerance);
    return direct || reversed;
  });
}
function linkedContactsCoincide(a, b) {
  return linkedContactCoincides(a, b) || linkedContactCoincides(b, a);
}
function linkedContactCoincides(source, target) {
  return source.links?.successors?.some((link) => {
    if (link.roadId !== target.id)
      return false;
    const sourcePoint = evaluateRoadReference(source, source.length);
    const targetPoint = evaluateRoadReference(target, link.contactPoint === "start" ? 0 : target.length);
    return Math.hypot(sourcePoint.x - targetPoint.x, sourcePoint.y - targetPoint.y) <= 0.00001;
  }) ?? false;
}
function directContinuityAt(network, a, b, aS, bS) {
  return directSuccessorAt(a, b, aS, bS) || directSuccessorAt(b, a, bS, aS);
}
function directSuccessorAt(source, target, sourceS, targetS) {
  if (!nearlyEqual(sourceS, source.length, 0.0001))
    return false;
  return source.links?.successors?.some((link) => link.roadId === target.id && nearlyEqual(targetS, link.contactPoint === "start" ? 0 : target.length, 0.0001)) ?? false;
}
function sampleRoadReferenceStations(road, step) {
  const count = Math.max(1, Math.ceil(road.length / step));
  return Array.from({ length: count + 1 }, (_, index) => {
    const s = road.length * index / count;
    return { s, point: evaluateRoadReference(road, s) };
  });
}
function referenceSampleBounds(samples2) {
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };
  for (const { point } of samples2) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds;
}
function referenceSampleBoundsOverlap(left, right) {
  return left.maxX >= right.minX && right.maxX >= left.minX && left.maxY >= right.minY && right.maxY >= left.minY;
}
function isGradeSeparated(a, b, a0, a1, b0, b1, aT, bT) {
  const aS = a0.s + (a1.s - a0.s) * aT;
  const bS = b0.s + (b1.s - b0.s) * bT;
  return Math.abs(roadElevationAt(a, aS) - roadElevationAt(b, bS)) >= MIN_GRADE_SEPARATION;
}
var MIN_GRADE_SEPARATION = 3.5;
function roadJunctionMembership(network) {
  const memberships = new Map;
  const add4 = (roadId, junctionId) => {
    if (!roadId)
      return;
    const values = memberships.get(roadId);
    if (values)
      values.add(junctionId);
    else
      memberships.set(roadId, new Set([junctionId]));
  };
  for (const road of network.roads) {
    if (!road.junctionId)
      continue;
    add4(road.id, road.junctionId);
    for (const link of [...road.links?.predecessors ?? [], ...road.links?.successors ?? []]) {
      add4(link.roadId, road.junctionId);
    }
    for (const lane of road.laneSections.flatMap((section) => section.lanes)) {
      for (const link of [lane.links?.predecessor, lane.links?.successor]) {
        if (link?.junctionId === road.junctionId)
          add4(link.roadId, road.junctionId);
      }
    }
  }
  for (const junction of network.junctions) {
    for (const connection of junction.connections) {
      add4(connection.incomingRoadId, junction.id);
      add4(connection.connectingRoadId, junction.id);
    }
    for (const port of junction.ports ?? [])
      add4(port.roadId, junction.id);
    for (const connector of junction.connectorRoads ?? []) {
      add4(connector.roadId, junction.id);
      add4(connector.incomingRoadId, junction.id);
      add4(connector.connectingRoadId, junction.id);
    }
    for (const zone of junction.conflictZones ?? []) {
      for (const roadId of zone.roadIds)
        add4(roadId, junction.id);
    }
  }
  return memberships;
}
function shareJunction(memberships, firstRoadId, secondRoadId) {
  const first = memberships.get(firstRoadId);
  const second = memberships.get(secondRoadId);
  if (!first || !second)
    return false;
  const [smaller, larger] = first.size <= second.size ? [first, second] : [second, first];
  for (const junctionId of smaller)
    if (larger.has(junctionId))
      return true;
  return false;
}
function sectionAt4(road, s) {
  return [...road.laneSections].sort((a, b) => a.s - b.s).filter((section) => section.s <= s + 0.0000001).at(-1);
}
function sectionAtIncoming4(road, s) {
  const sorted = [...road.laneSections].sort((a, b) => a.s - b.s);
  return sorted.filter((section) => section.s < s - 0.0000001).at(-1) ?? sorted[0];
}
function push(diagnostics, severity, code, message, road, section, lane) {
  diagnostics.push({
    severity,
    code,
    message,
    roadId: road.id,
    sectionId: section?.id,
    laneId: lane?.id
  });
}

// ../three-roads-inspect/packages/core/src/validation/interactive-validation.ts
var INTERACTIVE_ADVISORY_CODES = new Set([
  "appearing-traffic-lane-no-entry",
  "closed-lane-routable",
  "destination-zone-disconnected",
  "destination-zone-entry-missing",
  "destination-zone-exit-missing",
  "disappearing-traffic-lane-no-escape",
  "inactive-traffic-element",
  "lane-boundary-marking-conflict",
  "maximum-speed-conflict"
]);
function applyInteractiveRoadValidationPolicy(result) {
  const diagnostics = result.diagnostics.map((diagnostic3) => interactiveSeverity(diagnostic3) === diagnostic3.severity ? diagnostic3 : { ...diagnostic3, severity: "warning" });
  return {
    diagnostics,
    ok: diagnostics.every(({ severity }) => severity !== "error")
  };
}
function interactiveSeverity(diagnostic3) {
  return isInteractiveRoadAdvisoryCode(diagnostic3.code) ? "warning" : diagnostic3.severity;
}
function isInteractiveRoadAdvisoryCode(code) {
  return code.startsWith("road-design-") || INTERACTIVE_ADVISORY_CODES.has(code);
}

// ../three-roads-inspect/packages/core/src/compiler/traffic-management.ts
function resolveTrafficManagement(document, options) {
  const diagnostics = [];
  if (Object.keys(options.activePhases ?? {}).length === 0 && !hasConditionalSources(document)) {
    return { document, activePhases: [], phases: [], diagnostics };
  }
  const selected = Object.entries(options.activePhases ?? {}).map(([planId, phaseId]) => {
    const plan = document.trafficManagementPlans?.find((candidate) => candidate.id === planId);
    const phase = plan?.phases.find((candidate) => candidate.id === phaseId);
    if (!plan)
      diagnostics.push(error10("traffic-selection-plan-missing", `Selected traffic plan ${planId} does not exist`, planId));
    else if (!phase)
      diagnostics.push(error10("traffic-selection-phase-missing", `Selected phase ${planId}/${phaseId} does not exist`, planId));
    return phase ? { planId, phase } : undefined;
  }).filter((value) => value !== undefined);
  const activePhases = selected.map(({ planId, phase }) => ({ planId, phaseId: phase.id }));
  const isActive = (activation) => !activation || activePhases.some((active) => active.planId === activation.planId && active.phaseId === activation.phaseId);
  const activeJunctionIds = new Set(document.junctions.filter((source) => isActive(source.activation)).map((source) => source.id));
  return {
    diagnostics,
    activePhases,
    phases: selected,
    document: {
      ...structuredClone(document),
      strokes: document.strokes.filter((source) => isActive(source.activation)).map((source) => structuredClone(source)),
      junctions: document.junctions.filter((source) => isActive(source.activation)).map((source) => structuredClone(source)),
      junctionGroups: (document.junctionGroups ?? []).filter((source) => isActive(source.activation) && source.junctionIds.every((id) => activeJunctionIds.has(id))).map((source) => structuredClone(source)),
      markings: (document.markings ?? []).filter((source) => isActive(source.activation)).map((source) => structuredClone(source)),
      objects: (document.objects ?? []).filter((source) => isActive(source.activation)).map((source) => structuredClone(source)),
      trafficManagementPlans: []
    }
  };
}
function hasConditionalSources(document) {
  return document.strokes.some((source) => source.activation) || document.junctions.some((source) => source.activation) || (document.junctionGroups ?? []).some((source) => source.activation) || (document.markings ?? []).some((source) => source.activation) || (document.objects ?? []).some((source) => source.activation);
}
function compileTrafficManagement(network, resolved) {
  let roads = network.roads;
  for (const { planId, phase } of resolved.phases) {
    for (const operation of phase.laneOperations) {
      roads = roads.map((road) => road.id !== operation.roadId ? road : {
        ...road,
        laneSections: road.laneSections.map((section) => {
          const sectionEnd = laneSectionEndS(road, section);
          if (section.s < operation.sStart - 0.0000001 || sectionEnd > operation.sEnd + 0.0000001)
            return section;
          return {
            ...section,
            lanes: section.lanes.map((lane) => lane.sourceRole !== operation.laneRole ? lane : applyLaneOperation(lane, planId, phase.id, operation))
          };
        })
      });
    }
  }
  const withOperations = { ...network, roads, activeTrafficManagement: resolved.activePhases };
  return {
    ...withOperations,
    trafficRegulations: [
      ...(resolved.document.regulations ?? []).map((regulation) => compileRegulation(withOperations, regulation)),
      ...resolved.phases.flatMap(({ planId, phase }) => (phase.regulations ?? []).map((regulation) => compileRegulation(withOperations, regulation, {
        planId,
        phaseId: phase.id,
        sourceId: regulation.id
      })))
    ]
  };
}
function activationProvenance(activation, sourceId) {
  return activation ? { ...activation, sourceId } : undefined;
}
function applyLaneOperation(lane, planId, phaseId, operation) {
  return {
    ...lane,
    direction: operation.direction ?? lane.direction,
    access: operation.access ? structuredClone(operation.access) : lane.access,
    operational: {
      planId,
      phaseId,
      sourceId: operation.id,
      status: operation.status,
      trafficRole: operation.trafficRole
    }
  };
}
function compileRegulation(network, intent, operational) {
  const road = network.roads.find((candidate) => candidate.id === intent.roadId);
  if (!road)
    throw new Error(`Traffic regulation ${intent.id} has no compiled road ${intent.roadId}`);
  const trafficTypes = new Set(["driving", "entry", "exit", "on-ramp", "off-ramp", "shared", "bus"]);
  const lanes = road.laneSections.flatMap((section) => {
    const sectionEnd = laneSectionEndS(road, section);
    if (sectionEnd <= intent.sStart + 0.0000001 || section.s >= intent.sEnd - 0.0000001)
      return [];
    return section.lanes.filter((lane) => lane.id !== 0 && lane.operational?.status !== "closed" && (intent.laneRoles === "all-traffic" ? trafficTypes.has(lane.type) : lane.sourceRole !== undefined && intent.laneRoles.includes(lane.sourceRole))).map((lane) => ({ sectionId: section.id, laneId: lane.id }));
  });
  return {
    id: intent.id,
    kind: "maximum-speed",
    roadId: intent.roadId,
    sStart: intent.sStart,
    sEnd: intent.sEnd,
    maximumKph: intent.maximumKph,
    lanes,
    operational
  };
}
function error10(code, message, sourceId) {
  return { severity: "error", code, message, sourceId };
}

// ../three-roads-inspect/packages/core/src/compiler/compile-road.ts
function compileRoadStroke(stroke, templates) {
  const spans = [...stroke.templateSpans].sort((a, b) => a.s - b.s);
  const resolved = spans.map((span) => {
    const template = templates.get(span.templateId);
    if (!template)
      throw new Error(`Stroke ${stroke.id} references missing template ${span.templateId}`);
    return { ...span, template };
  });
  const length = referenceLineLength({ geometry: stroke.geometry });
  const sections = [staticSection(stroke.id, 0, resolved[0].template)];
  for (let index = 1;index < resolved.length; index++) {
    const previous = resolved[index - 1];
    const next = resolved[index];
    const transitionLength = next.transitionLength ?? 0;
    if (transitionLength > 0) {
      sections.push(transitionSection(stroke.id, next.s, transitionLength, previous.template, next.template));
      sections.push(staticSection(stroke.id, next.s + transitionLength, next.template));
    } else {
      sections.push(staticSection(stroke.id, next.s, next.template));
    }
  }
  return {
    road: {
      id: stroke.id,
      name: stroke.name,
      kind: "road",
      routing: structuredClone(stroke.routing),
      ...stroke.earthworkPolicy ? { earthworkPolicy: stroke.earthworkPolicy } : {},
      operational: activationProvenance(stroke.activation, stroke.id),
      length,
      referenceLine: { geometry: structuredClone(stroke.geometry) },
      elevation: structuredClone(stroke.elevation),
      superelevation: structuredClone(stroke.superelevation),
      designRanges: compileDesignRanges(resolved, length),
      laneSections: bindLaneMarkingsToSections(sections, length)
    },
    templateAtStart: resolved[0].template,
    templateAtEnd: resolved.at(-1)?.template ?? resolved[0].template
  };
}
function compileDesignRanges(resolved, roadLength) {
  const ranges = resolved.flatMap((span, index) => span.template.designLimits ? [{
    sStart: span.s,
    sEnd: resolved[index + 1]?.s ?? roadLength,
    limits: structuredClone(span.template.designLimits)
  }] : []);
  return ranges.length > 0 ? ranges : undefined;
}
function bindLaneMarkingsToSections(sections, roadLength) {
  return sections.map((section, index) => {
    const sectionEnd = sections[index + 1]?.s ?? roadLength;
    return {
      ...section,
      lanes: section.lanes.map((lane) => ({
        ...lane,
        markings: lane.markings?.map((marking) => ({
          ...marking,
          sStart: Math.max(section.s, marking.sStart ?? section.s),
          sEnd: Math.min(sectionEnd, marking.sEnd ?? sectionEnd)
        })).filter((marking) => marking.sEnd > marking.sStart)
      }))
    };
  });
}
function laneIdForTemplateRole(template, role) {
  const lane = template.lanes.find((candidate) => candidate.role === role);
  return lane ? laneId(lane) : undefined;
}
function laneRolesAtStrokeEndpoint(stroke, contactPoint, templates) {
  const station = contactPoint === "start" ? 0 : referenceLineLength({ geometry: stroke.geometry });
  const spans = [...stroke.templateSpans].sort((a, b) => a.s - b.s);
  const span = [...spans].filter((candidate) => candidate.s <= station + 0.0000001).at(-1);
  const template = span ? templates.get(span.templateId) : undefined;
  if (!template)
    throw new Error(`Stroke ${stroke.id} has no template at ${contactPoint}`);
  return template.lanes.map((lane) => lane.role);
}
function laneIdForStrokeRoleAtEndpoint(stroke, contactPoint, role, templates) {
  const station = contactPoint === "start" ? 0 : referenceLineLength({ geometry: stroke.geometry });
  return laneIdForStrokeRoleAtStation(stroke, station, role, templates);
}
function laneIdForStrokeRoleAtStation(stroke, s, role, templates) {
  const spans = [...stroke.templateSpans].sort((a, b) => a.s - b.s);
  let currentIndex = -1;
  for (let index = 0;index < spans.length; index++) {
    if (spans[index].s <= s + 0.0000001)
      currentIndex = index;
  }
  if (currentIndex < 0)
    return;
  const current = spans[currentIndex];
  const currentTemplate = templates.get(current.templateId);
  if (!currentTemplate)
    return;
  const transitionEnd = current.s + (current.transitionLength ?? 0);
  if (currentIndex > 0 && current.transitionLength && s < transitionEnd - 0.0000001) {
    const previousTemplate = templates.get(spans[currentIndex - 1].templateId);
    return laneIdForTemplateRole(currentTemplate, role) ?? (previousTemplate ? laneIdForTemplateRole(previousTemplate, role) : undefined);
  }
  return laneIdForTemplateRole(currentTemplate, role);
}
function laneDirectionForStrokeRoleAtStation(stroke, s, role, templates) {
  const spans = [...stroke.templateSpans].sort((a, b) => a.s - b.s);
  let currentIndex = -1;
  for (let index = 0;index < spans.length; index++) {
    if (spans[index].s <= s + 0.0000001)
      currentIndex = index;
  }
  if (currentIndex < 0)
    return;
  const current = spans[currentIndex];
  const currentLane = templates.get(current.templateId)?.lanes.find((lane) => lane.role === role);
  if (currentLane)
    return currentLane.direction;
  if (currentIndex > 0 && current.transitionLength && s < current.s + current.transitionLength - 0.0000001) {
    return templates.get(spans[currentIndex - 1].templateId)?.lanes.find((lane) => lane.role === role)?.direction;
  }
  return;
}
function staticSection(strokeId, s, template) {
  return {
    id: `${strokeId}__s${stationId(s)}`,
    s,
    lanes: [centerLane(), ...template.lanes.map((lane) => compiledLane(lane, lane.width))].sort((a, b) => b.id - a.id)
  };
}
function transitionSection(strokeId, s, length, from, to) {
  const lanes = transitionLaneIdAssignments(from, to).map(({ role, laneId: id, fromLane, toLane }) => {
    const lane = toLane ?? fromLane;
    if (!lane)
      throw new Error(`Transition on ${strokeId} has no lane for role ${role}`);
    const fromWidth = fromLane?.width ?? 0;
    const toWidth = toLane?.width ?? 0;
    return {
      id,
      type: (toLane ?? fromLane)?.type ?? "driving",
      surface: (toLane ?? fromLane)?.surface,
      verticalEdges: (toLane ?? fromLane)?.verticalEdges,
      sourceRole: role,
      direction: compiledLaneDirection(toLane ?? fromLane),
      level: (toLane ?? fromLane)?.level,
      heights: structuredClone((toLane ?? fromLane)?.heights),
      access: structuredClone((toLane ?? fromLane)?.access),
      priorityParticipants: structuredClone((toLane ?? fromLane)?.priorityParticipants),
      markings: transitionLaneMarkings(from, to, fromLane, toLane),
      widths: smoothTransitionWidths(fromWidth, toWidth, length)
    };
  });
  ensureUniqueLaneIds(strokeId, lanes);
  return {
    id: `${strokeId}__s${stationId(s)}__transition`,
    s,
    lanes: [centerLane(), ...lanes].sort((a, b) => b.id - a.id)
  };
}
function transitionLaneMarkings(from, to, fromLane, toLane) {
  if (!fromLane)
    return structuredClone(toLane?.boundaryMarkings);
  if (!toLane)
    return structuredClone(fromLane.boundaryMarkings);
  const markings = structuredClone(fromLane.boundaryMarkings ?? []);
  for (const boundary of ["inner", "outer"]) {
    const toNeighbor = adjacentTemplateLane(to, toLane, boundary);
    const neighborAppears = toNeighbor && !from.lanes.some((candidate) => candidate.role === toNeighbor.role);
    if (!neighborAppears)
      continue;
    const destination = structuredClone((toLane.boundaryMarkings ?? []).filter((marking) => marking.boundary === boundary));
    for (let index = markings.length - 1;index >= 0; index--) {
      if (markings[index].boundary === boundary)
        markings.splice(index, 1);
    }
    markings.push(...destination);
  }
  return markings;
}
function adjacentTemplateLane(template, lane, boundary) {
  const adjacentOrder = boundary === "inner" ? lane.order - 1 : lane.order + 1;
  if (adjacentOrder === 0)
    return;
  return template.lanes.find((candidate) => candidate.side === lane.side && candidate.order === adjacentOrder);
}
function compiledLane(lane, width) {
  return {
    id: laneId(lane),
    type: lane.type,
    surface: lane.surface,
    verticalEdges: lane.verticalEdges,
    sourceRole: lane.role,
    direction: compiledLaneDirection(lane),
    level: lane.level,
    heights: structuredClone(lane.heights),
    access: structuredClone(lane.access),
    priorityParticipants: structuredClone(lane.priorityParticipants),
    markings: structuredClone(lane.boundaryMarkings),
    widths: [{ sOffset: 0, a: width, b: 0, c: 0, d: 0 }]
  };
}
function compiledLaneDirection(lane) {
  if (!lane)
    return;
  if (lane.direction)
    return lane.direction;
  return lane.type === "border" || lane.type === "sidewalk" || lane.type === "median" ? "both" : undefined;
}
function laneId(lane) {
  return lane.side === "left" ? lane.order : -lane.order;
}
function centerLane() {
  return { id: 0, type: "center", widths: [] };
}
function smoothTransitionWidths(start, end, length) {
  const delta = end - start;
  const interval = length / 3;
  const jerk = delta / (6 * interval ** 3);
  return [
    { sOffset: 0, a: start, b: 0, c: 0, d: jerk },
    {
      sOffset: interval,
      a: start + jerk * interval ** 3,
      b: 3 * jerk * interval ** 2,
      c: 3 * jerk * interval,
      d: -2 * jerk
    },
    {
      sOffset: 2 * interval,
      a: start + 5 * jerk * interval ** 3,
      b: 3 * jerk * interval ** 2,
      c: -3 * jerk * interval,
      d: jerk
    }
  ];
}
function ensureUniqueLaneIds(strokeId, lanes) {
  const ids = new Set;
  for (const lane of lanes) {
    if (ids.has(lane.id))
      throw new Error(`Stroke ${strokeId} transition maps multiple roles to lane ${lane.id}`);
    ids.add(lane.id);
  }
}
function stationId(s) {
  return String(s).replaceAll(".", "_").replaceAll("-", "m");
}

// ../three-roads-inspect/packages/core/src/compiler/compile-junction.ts
function compileJunctionIntent(document, junction, templates) {
  const corridorsByManeuver = new Map(junction.connectorCorridors?.flatMap((corridor) => corridor.maneuverIds.map((maneuverId) => [maneuverId, corridor])) ?? []);
  const continuationCorridors = continuationCorridorIds(document, junction, templates);
  return {
    connections: [
      ...junction.maneuvers.map((maneuver) => compileLaneRoute(document, junction, templates, maneuver, "maneuver", corridorsByManeuver.get(maneuver.id))),
      ...(junction.laneContinuations ?? []).map((continuation) => compileLaneRoute(document, junction, templates, continuation, "continuation", continuationCorridors.get(continuation.id)))
    ]
  };
}
function compileLaneRoute(document, junction, templates, route, kind, corridor) {
  const incomingPort = resolvePort(junction, route.fromRoadId, route.fromPortId);
  const outgoingPort = resolvePort(junction, route.toRoadId, route.toPortId);
  const incomingStroke = strokeById(document, route.fromRoadId);
  const outgoingStroke = strokeById(document, route.toRoadId);
  if (!incomingPort || !outgoingPort || !incomingStroke || !outgoingStroke) {
    throw new Error(`Junction ${junction.id} ${kind} ${route.id} has unresolved ports`);
  }
  const incomingS = portStation3(incomingStroke, incomingPort);
  const outgoingS = portStation3(outgoingStroke, outgoingPort);
  const incomingLaneId = laneIdForStrokeRoleAtStation(incomingStroke, incomingS, route.fromLaneRole, templates);
  const outgoingLaneId = laneIdForStrokeRoleAtStation(outgoingStroke, outgoingS, route.toLaneRole, templates);
  if (incomingLaneId === undefined || outgoingLaneId === undefined) {
    throw new Error(`Junction ${junction.id} ${kind} ${route.id} references a lane role absent at its port`);
  }
  const continuationDirection = kind === "continuation" ? resolvedContinuationDirection(incomingStroke, incomingS, route.fromLaneRole, incomingPort.contactPoint, outgoingStroke, outgoingS, route.toLaneRole, outgoingPort.contactPoint, templates, Boolean(junction.profileTransition)) : undefined;
  const maneuverDirection = kind === "maneuver" && laneDirectionForStrokeRoleAtStation(incomingStroke, incomingS, route.fromLaneRole, templates) === "both" && laneDirectionForStrokeRoleAtStation(outgoingStroke, outgoingS, route.toLaneRole, templates) === "both" ? "both" : undefined;
  return {
    id: route.id,
    sourceManeuverId: kind === "maneuver" ? route.id : undefined,
    sourceLaneContinuationId: kind === "continuation" ? route.id : undefined,
    incomingRoadId: route.fromRoadId,
    connectingRoadId: route.toRoadId,
    incomingContactPoint: incomingPort.contactPoint,
    incomingS: incomingPort.s,
    connectingS: outgoingPort.s,
    contactPoint: outgoingPort.contactPoint,
    laneLinks: [{ from: incomingLaneId, to: outgoingLaneId }],
    laneDirection: continuationDirection ?? maneuverDirection,
    requiredContinuity: corridor?.requiredContinuity ?? route.requiredContinuity,
    minimumRadius: corridor?.minimumRadius ?? route.minimumRadius,
    connectorGeometry: corridor ? structuredClone(corridor.geometry) : kind === "maneuver" && ("connectorGeometry" in route) ? structuredClone(route.connectorGeometry) : undefined,
    connectorCorridorId: corridor?.id,
    connectorLaneMarkings: kind === "maneuver" && "connectorLaneMarkings" in route ? structuredClone(route.connectorLaneMarkings) : undefined
  };
}
function resolvedContinuationDirection(incomingStroke, incomingS, incomingRole, incomingContactPoint, outgoingStroke, outgoingS, outgoingRole, outgoingContactPoint, templates, allowPhysicalMorph) {
  const incomingLane = templateLaneAtStation2(incomingStroke, incomingS, incomingRole, templates);
  const outgoingLane = templateLaneAtStation2(outgoingStroke, outgoingS, outgoingRole, templates);
  const direction = incomingLane && outgoingLane ? laneContinuationDirection(incomingLane, incomingContactPoint, outgoingLane, outgoingContactPoint, allowPhysicalMorph) : undefined;
  if (!direction) {
    throw new Error(`Lane continuation ${incomingStroke.id}:${incomingRole} to ${outgoingStroke.id}:${outgoingRole} has incompatible flow`);
  }
  return direction;
}
function templateLaneAtStation2(stroke, station, role, templates) {
  const span = [...stroke.templateSpans].sort((left, right) => left.s - right.s).filter((candidate) => candidate.s <= station + 0.0000001).at(-1);
  return span ? templates.get(span.templateId)?.lanes.find((lane) => lane.role === role) : undefined;
}
function continuationCorridorIds(document, junction, templates) {
  const groups = new Map;
  for (const continuation of junction.laneContinuations ?? []) {
    const key = [
      continuation.fromRoadId,
      continuation.fromPortId ?? "",
      continuation.toRoadId,
      continuation.toPortId ?? ""
    ].join("|");
    groups.set(key, [...groups.get(key) ?? [], continuation]);
  }
  const result = new Map;
  let ordinal = 0;
  for (const continuations of groups.values()) {
    if (continuations.length < 2 || !areConsecutiveContinuationBands(document, junction, templates, continuations))
      continue;
    const corridor = { id: `perimeter-${ordinal++}`, geometry: [] };
    for (const continuation of continuations)
      result.set(continuation.id, corridor);
  }
  return result;
}
function areConsecutiveContinuationBands(document, junction, templates, continuations) {
  const laneIds = (side) => continuations.flatMap((continuation) => {
    const roadId = side === "from" ? continuation.fromRoadId : continuation.toRoadId;
    const portId = side === "from" ? continuation.fromPortId : continuation.toPortId;
    const laneRole = side === "from" ? continuation.fromLaneRole : continuation.toLaneRole;
    const port = resolvePort(junction, roadId, portId);
    const stroke = strokeById(document, roadId);
    if (!port || !stroke)
      return [];
    const laneId2 = laneIdForStrokeRoleAtStation(stroke, portStation3(stroke, port), laneRole, templates);
    return laneId2 === undefined ? [] : [laneId2];
  }).sort((left, right) => left - right);
  const consecutive = (ids) => ids.length === continuations.length && ids.every((id, index) => index === 0 || id === ids[index - 1] + 1);
  return consecutive(laneIds("from")) && consecutive(laneIds("to"));
}
function resolvePort(junction, roadId, portId) {
  if (portId)
    return junction.ports.find((port) => junctionPortId(port) === portId && port.roadId === roadId);
  const candidates = junction.ports.filter((port) => port.roadId === roadId);
  if (candidates.length > 1)
    throw new Error(`Junction ${junction.id} road ${roadId} needs an explicit maneuver port`);
  return candidates[0];
}
function portStation3(stroke, port) {
  if (port.s !== undefined)
    return port.s;
  return port.contactPoint === "start" ? 0 : referenceLineLength({ geometry: stroke.geometry });
}
function strokeById(document, id) {
  return document.strokes.find((stroke) => stroke.id === id);
}

// ../three-roads-inspect/packages/core/src/topology/conflict-zones.ts
function inferConflictZones(network, options = {}) {
  const step = options.step ?? 4;
  const minArea = options.minArea ?? 0.25;
  const roadEnvelopes = new Map(network.roads.map((road) => [road.id, sampleRoadEnvelope(road, step).points]));
  const zones = [];
  for (let i = 0;i < network.roads.length; i++) {
    for (let j = i + 1;j < network.roads.length; j++) {
      const a = network.roads[i];
      const b = network.roads[j];
      if (!options.includeNonJunctionCrossings && !roadsShareJunction(network, a, b))
        continue;
      const components = intersectPolygons(roadEnvelopes.get(a.id) ?? [], [roadEnvelopes.get(b.id) ?? []]).filter((component) => Math.abs(polygonArea(component.outer)) >= minArea);
      for (let componentIndex = 0;componentIndex < components.length; componentIndex++) {
        zones.push({
          id: `inferred-conflict-${a.id}-${b.id}${components.length > 1 ? `-${componentIndex}` : ""}`,
          source: "inferred",
          roadIds: [a.id, b.id],
          polygon: components[componentIndex].outer
        });
      }
    }
  }
  return zones;
}
function roadsShareJunction(network, a, b) {
  if (a.junctionId && a.junctionId === b.junctionId)
    return true;
  return network.junctions.some((junction) => junction.ports?.some((port) => port.roadId === a.id) && junction.ports?.some((port) => port.roadId === b.id) || junction.connections.some((connection) => {
    const roadIds = [connection.incomingRoadId, connection.connectingRoadId];
    return roadIds.includes(a.id) && roadIds.includes(b.id);
  }));
}

// ../three-roads-inspect/packages/core/src/topology/traffic-occupancy.ts
function trafficOccupancyPolygon(road, section, lane, sStart, sEnd, authoredWidth) {
  const midpoint = (sStart + sEnd) * 0.5;
  const availableWidth = laneWidthAt(lane, Math.max(0, midpoint - section.s));
  const width = Math.min(availableWidth, authoredWidth ?? defaultConflictEnvelopeWidth(lane.type));
  return sampleLaneOccupancyPolygon(road, section, lane.id, Math.max(0.1, width), sStart, sEnd, 0.5);
}
function defaultConflictEnvelopeWidth(laneType) {
  if (laneType === "tram")
    return 2.65;
  if (laneType === "rail")
    return 3.1;
  if (laneType === "bus")
    return 2.55;
  if (laneType === "biking")
    return 1;
  if (laneType === "sidewalk")
    return 0.8;
  return 2.1;
}

// ../three-roads-inspect/packages/core/src/compiler/maneuver-pairs.ts
function orderedManeuverIds(left, right) {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}
function maneuverPairKey(ids) {
  return orderedManeuverIds(ids[0], ids[1]).join("\x00");
}

// ../three-roads-inspect/packages/core/src/compiler/interaction-control.ts
var OPPOSING_HEADING_TOLERANCE = Math.PI / 6;
function compileInteractionControl(source, left, right, kind, geometries) {
  if (kind === "compatible" || kind === "diverge")
    return { kind: "none" };
  const override = (source.movementInteractions ?? []).find((interaction) => maneuverPairKey(interaction.maneuverIds) === maneuverPairKey([left.id, right.id]));
  if (override?.priorityManeuverId) {
    return fixedPriority(left, right, override.priorityManeuverId, "explicit", "statutory");
  }
  const plan = source.control;
  if (!plan) {
    const legacyPriority = priorityByRoad(source.priorityRoadIds ?? [], left, right);
    if (legacyPriority) {
      return fixedPriority(left, right, legacyPriority, "legacy-priority-road", "yield");
    }
    if ((source.priorityRoadIds?.length ?? 0) > 0) {
      return equalRankGermanRule(left, right, geometries);
    }
    return { kind: "unresolved", reason: "junction has no control plan" };
  }
  if (plan.kind === "all-way-stop")
    return { kind: "all-way-stop" };
  if (plan.kind === "zipper") {
    return kind === "merge" ? { kind: "zipper" } : { kind: "unresolved", reason: "zipper control only resolves merge interactions" };
  }
  if (plan.kind === "signal") {
    const leftGroupId = signalGroupId(plan.groups, left.id);
    const rightGroupId = signalGroupId(plan.groups, right.id);
    return leftGroupId && rightGroupId ? { kind: "signal", controllerId: plan.controllerId, signalGroupIds: [leftGroupId, rightGroupId] } : { kind: "unresolved", reason: "signal plan does not assign both maneuvers" };
  }
  if (plan.kind === "roundabout") {
    const circulating = new Set(plan.circulatingManeuverIds);
    const leftCirculates = circulating.has(left.id);
    const rightCirculates = circulating.has(right.id);
    if (leftCirculates !== rightCirculates) {
      return fixedPriority(left, right, leftCirculates ? left.id : right.id, "roundabout", "yield");
    }
    return { kind: "unresolved", reason: "roundabout conflict does not pair circulation with an entering maneuver" };
  }
  if (plan.kind === "priority") {
    const priorityPorts = new Set(plan.priorityPortIds);
    const leftPort = maneuverPortId(source, left.fromRoadId, left.fromPortId);
    const rightPort = maneuverPortId(source, right.fromRoadId, right.fromPortId);
    const leftPriority = leftPort !== undefined && priorityPorts.has(leftPort);
    const rightPriority = rightPort !== undefined && priorityPorts.has(rightPort);
    if (leftPriority !== rightPriority) {
      return fixedPriority(left, right, leftPriority ? left.id : right.id, "priority-approach", plan.minorControl);
    }
    return equalRankGermanRule(left, right, geometries);
  }
  return equalRankGermanRule(left, right, geometries);
}
function validateSignalConflictPhases(source, interactions) {
  if (source.control?.kind !== "signal")
    return;
  for (const interaction of interactions) {
    if (interaction.conflictZoneIds.length === 0 || interaction.control.kind !== "signal")
      continue;
    const [leftGroupId, rightGroupId] = interaction.control.signalGroupIds;
    if (leftGroupId === rightGroupId) {
      throw new Error(`Signal group ${leftGroupId} contains conflicting maneuvers ${interaction.maneuverIds.join("/")}`);
    }
    for (const phase of source.control.phases) {
      if (phase.greenGroupIds.includes(leftGroupId) && phase.greenGroupIds.includes(rightGroupId)) {
        throw new Error(`Signal phase ${phase.id} releases conflicting maneuvers ${interaction.maneuverIds.join("/")}`);
      }
    }
  }
}
function equalRankGermanRule(left, right, geometries) {
  const leftPort = `${left.fromRoadId}\x00${left.fromPortId ?? ""}`;
  const rightPort = `${right.fromRoadId}\x00${right.fromPortId ?? ""}`;
  if (leftPort === rightPort) {
    const bicycle = left.participantClass === "bicycle" ? left : right.participantClass === "bicycle" ? right : undefined;
    const motor = left.participantClass === "motor" ? left : right.participantClass === "motor" ? right : undefined;
    if (bicycle && motor)
      return fixedPriority(left, right, bicycle.id, "parallel-cycle", "statutory");
    return { kind: "unresolved", reason: "same-approach conflict needs an explicit lane control" };
  }
  const leftGeometry = geometries.get(left.id);
  const rightGeometry = geometries.get(right.id);
  if (!leftGeometry || !rightGeometry) {
    return { kind: "unresolved", reason: "maneuver contact headings are unavailable" };
  }
  const headingDelta = normalizeAngle(rightGeometry.incomingHeading - leftGeometry.incomingHeading);
  if (Math.abs(Math.PI - Math.abs(headingDelta)) <= OPPOSING_HEADING_TOLERANCE) {
    const priorityId = opposingPriority(left, right, leftGeometry, rightGeometry);
    return priorityId ? fixedPriority(left, right, priorityId, "opposing-left-turn", "statutory") : {
      kind: "coordinated",
      basis: leftGeometry.turn === "left" && rightGeometry.turn === "left" ? "opposing-turn-in-front" : "first-arrival"
    };
  }
  if (Math.abs(headingDelta) <= 0.0001) {
    return { kind: "unresolved", reason: "parallel approaches need an explicit merge control" };
  }
  return fixedPriority(left, right, headingDelta > 0 ? right.id : left.id, "right-before-left", "statutory");
}
function opposingPriority(left, right, leftGeometry, rightGeometry) {
  const leftYields = leftGeometry.turn === "left" || leftGeometry.turn === "u-turn";
  const rightYields = rightGeometry.turn === "left" || rightGeometry.turn === "u-turn";
  if (leftYields === rightYields)
    return;
  return leftYields ? right.id : left.id;
}
function priorityByRoad(priorityRoadIds, left, right) {
  const roads = new Set(priorityRoadIds);
  const leftPriority = roads.has(left.fromRoadId);
  const rightPriority = roads.has(right.fromRoadId);
  if (leftPriority === rightPriority)
    return;
  return leftPriority ? left.id : right.id;
}
function fixedPriority(left, right, priorityManeuverId, basis, yieldingControl) {
  return {
    kind: "fixed-priority",
    basis,
    priorityParticipantId: priorityManeuverId,
    yieldingParticipantId: priorityManeuverId === left.id ? right.id : left.id,
    yieldingControl
  };
}
function signalGroupId(groups, maneuverId) {
  return groups.find((group) => group.participantIds.includes(maneuverId))?.id;
}

// ../three-roads-inspect/packages/core/src/compiler/movement-interactions.ts
function compileMovementInteractions(source, conflictZones, geometries) {
  const overrides = new Map((source.movementInteractions ?? []).map((interaction) => [
    maneuverPairKey(interaction.maneuverIds),
    interaction
  ]));
  const interactions = [];
  for (let leftIndex = 0;leftIndex < source.maneuvers.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1;rightIndex < source.maneuvers.length; rightIndex++) {
      const left = source.maneuvers[leftIndex];
      const right = source.maneuvers[rightIndex];
      const maneuverIds = orderedManeuverIds(left.id, right.id);
      const zones = conflictZones.filter((zone) => zone.maneuverIds && maneuverPairKey(zone.maneuverIds) === maneuverPairKey(maneuverIds));
      const override = overrides.get(maneuverPairKey(maneuverIds));
      const topologicalKind = maneuverPairTopologicalKind(left, right);
      const kind = override?.kind ?? (topologicalKind === "crossing" && zones.length === 0 ? "compatible" : topologicalKind);
      if (kind === "compatible" && zones.length > 0) {
        throw new Error(`Junction ${source.id} declares maneuvers ${maneuverIds.join("/")} compatible but their surfaces overlap`);
      }
      const control = compileInteractionControl(source, left, right, kind, geometries);
      interactions.push({
        id: override?.id ?? `${source.id}__interaction__${maneuverIds[0]}__${maneuverIds[1]}`,
        maneuverIds,
        kind,
        control,
        priorityManeuverId: control.kind === "fixed-priority" ? control.priorityParticipantId : undefined,
        conflictZoneIds: zones.map((zone) => zone.id).sort()
      });
    }
  }
  validateSignalConflictPhases(source, interactions);
  return interactions;
}
function maneuverPairTopologicalKind(left, right) {
  if (sameTargetLane2(left, right))
    return "merge";
  if (sameSourceLane2(left, right))
    return "diverge";
  return "crossing";
}
function sameSourceLane2(left, right) {
  return left.fromRoadId === right.fromRoadId && (left.fromPortId ?? "") === (right.fromPortId ?? "") && left.fromLaneRole === right.fromLaneRole;
}
function sameTargetLane2(left, right) {
  return left.toRoadId === right.toRoadId && (left.toPortId ?? "") === (right.toPortId ?? "") && left.toLaneRole === right.toLaneRole;
}

// ../three-roads-inspect/packages/core/src/compiler/compile-conflicts.ts
function deriveManeuverConflictZones(network, source, maneuverRoadIds, maneuverLanes = {}) {
  const zones = [];
  const envelopeCache = new Map;
  for (let leftIndex = 0;leftIndex < source.maneuvers.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1;rightIndex < source.maneuvers.length; rightIndex++) {
      const left = source.maneuvers[leftIndex];
      const right = source.maneuvers[rightIndex];
      if (sameSourceLane2(left, right))
        continue;
      const leftKey = `${source.id}:${left.id}`;
      const rightKey = `${source.id}:${right.id}`;
      const leftRefs = maneuverLanes[leftKey]?.length ? maneuverLanes[leftKey] : (maneuverRoadIds[leftKey] ?? []).map((roadId) => ({ roadId, laneId: -1 }));
      const rightRefs = maneuverLanes[rightKey]?.length ? maneuverLanes[rightKey] : (maneuverRoadIds[rightKey] ?? []).map((roadId) => ({ roadId, laneId: -1 }));
      for (const leftRef of leftRefs) {
        for (const rightRef of rightRefs) {
          if (leftRef.roadId === rightRef.roadId && leftRef.laneId === rightRef.laneId)
            continue;
          const leftEnvelope = cachedManeuverOccupancyEnvelope(envelopeCache, network, leftRef.roadId, leftRef.laneId, left.conflictEnvelopeWidth);
          const rightEnvelope = cachedManeuverOccupancyEnvelope(envelopeCache, network, rightRef.roadId, rightRef.laneId, right.conflictEnvelopeWidth);
          if (!leftEnvelope || !rightEnvelope)
            continue;
          if (!boundsOverlap(polygonBounds(leftEnvelope), polygonBounds(rightEnvelope)))
            continue;
          const matches = intersectPolygons(leftEnvelope, [rightEnvelope]).filter((component) => Math.abs(polygonArea(component.outer)) >= 0.05);
          for (let matchIndex = 0;matchIndex < matches.length; matchIndex++) {
            zones.push({
              id: `${source.id}__${left.id}__x__${right.id}${matches.length > 1 ? `__${matchIndex}` : ""}`,
              roadIds: [leftRef.roadId, rightRef.roadId],
              polygon: matches[matchIndex].outer,
              kind: maneuverPairTopologicalKind(left, right),
              maneuverIds: orderedManeuverIds(left.id, right.id)
            });
          }
        }
      }
    }
  }
  return zones;
}
function cachedManeuverOccupancyEnvelope(cache, network, roadId, laneId2, authoredWidth) {
  const key = `${roadId}\x00${laneId2}\x00${authoredWidth ?? ""}`;
  const cached = cache.get(key);
  if (cached)
    return cached;
  const envelope = maneuverOccupancyEnvelope(network, roadId, laneId2, authoredWidth);
  if (envelope)
    cache.set(key, envelope);
  return envelope;
}
function polygonBounds(points) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}
function boundsOverlap(left, right) {
  return left.minX <= right.maxX && left.maxX >= right.minX && left.minY <= right.maxY && left.maxY >= right.minY;
}
function maneuverOccupancyEnvelope(network, roadId, laneId2, authoredWidth) {
  const road = network.roads.find((candidate) => candidate.id === roadId);
  const section = road?.laneSections[0];
  const lane = section?.lanes.find((candidate) => candidate.id === laneId2);
  if (!road || !section || !lane)
    return;
  return trafficOccupancyPolygon(road, section, lane, section.s, road.length, authoredWidth);
}
function deriveCrossingConflictZones(network, source) {
  if (source.kind !== "crossing")
    return [];
  const roadIds = new Set(source.ports.map((port) => port.roadId));
  return inferConflictZones(network, { step: 1 }).filter((zone) => zone.roadIds.length === 2 && zone.roadIds.every((roadId) => roadIds.has(roadId))).map((zone, index) => ({
    id: `${source.id}__crossing${index > 0 ? `__${index}` : ""}`,
    roadIds: [...zone.roadIds].sort(),
    polygon: zone.polygon,
    priorityRoadId: zone.roadIds.find((roadId) => source.priorityRoadIds?.includes(roadId)),
    kind: "crossing"
  }));
}
function deriveVirtualConflictZones(network, source) {
  const mainRoadId = source.virtualRange?.mainRoadId;
  if (source.kind !== "virtual" || !mainRoadId)
    return [];
  const portRoadIds = new Set(source.ports.map((port) => port.roadId));
  return inferConflictZones(network, { step: 1 }).filter((zone) => zone.roadIds.includes(mainRoadId) && zone.roadIds.every((roadId) => portRoadIds.has(roadId))).map((zone, index) => {
    const branchRoadId = zone.roadIds.find((roadId) => roadId !== mainRoadId);
    const maneuver = source.maneuvers.find((candidate) => branchRoadId && [candidate.fromRoadId, candidate.toRoadId].includes(branchRoadId) && [candidate.fromRoadId, candidate.toRoadId].includes(mainRoadId));
    return {
      id: `${source.id}__virtual-contact${index > 0 ? `__${index}` : ""}`,
      roadIds: [...zone.roadIds].sort(),
      polygon: zone.polygon,
      priorityRoadId: mainRoadId,
      kind: maneuver?.toRoadId === mainRoadId ? "merge" : "diverge"
    };
  });
}

// ../three-roads-inspect/packages/core/src/topology/corridor-topology.ts
var CONTACT_TOLERANCE = 0.000001;
function buildRoadCorridorTopology(road) {
  const sections = road.laneSections.map((section) => {
    const sEnd = laneSectionEndS(road, section);
    const bands = section.lanes.filter((lane) => lane.id !== 0).map((lane) => corridorBand(road, section.id, section.s, sEnd, lane));
    return {
      id: `${road.id}|${section.id}`,
      roadId: road.id,
      sectionId: section.id,
      sStart: section.s,
      sEnd,
      bands,
      boundaries: corridorBoundaries(road, section.id, section.lanes, bands)
    };
  });
  return {
    roadId: road.id,
    roadKind: road.kind,
    junctionId: road.junctionId,
    sections,
    contacts: corridorSectionContacts(road, sections)
  };
}
function corridorBoundaryId(roadId, sectionId, ordinal) {
  return `${roadId}|${sectionId}|boundary:${ordinal < 0 ? `m${-ordinal}` : ordinal}`;
}
function laneBoundaryOrdinal(laneId2, side) {
  if (side === "center" || laneId2 === 0)
    return 0;
  return side === "outer" ? laneId2 : Math.sign(laneId2) * (Math.abs(laneId2) - 1);
}
function corridorBand(road, sectionId, sStart, sEnd, lane) {
  const inner = corridorBoundaryId(road.id, sectionId, laneBoundaryOrdinal(lane.id, "inner"));
  const outer = corridorBoundaryId(road.id, sectionId, laneBoundaryOrdinal(lane.id, "outer"));
  return {
    id: `${road.id}|${sectionId}|lane:${lane.id}`,
    roadId: road.id,
    sectionId,
    laneId: lane.id,
    laneType: lane.type,
    surface: lane.surface,
    verticalEdges: lane.verticalEdges,
    sourceRole: lane.sourceRole,
    direction: lane.direction ?? "standard",
    level: lane.level ?? false,
    access: structuredClone(lane.access),
    sStart,
    sEnd,
    leftBoundaryId: lane.id > 0 ? outer : inner,
    rightBoundaryId: lane.id > 0 ? inner : outer,
    surfaceOwner: road.kind === "connector" && road.junctionId ? { kind: "junction", id: road.junctionId } : { kind: "road", id: road.id }
  };
}
function corridorSectionContacts(road, sections) {
  return sections.slice(0, -1).map((upstream, index) => {
    const downstream = sections[index + 1];
    const sourceUpstream = road.laneSections.find((section) => section.id === upstream.sectionId);
    const sourceDownstream = road.laneSections.find((section) => section.id === downstream.sectionId);
    if (!sourceUpstream || !sourceDownstream) {
      throw new Error(`Road ${road.id} has an unresolved physical lane-section contact`);
    }
    const s = downstream.sStart;
    const contactId = `${road.id}|contact:${upstream.sectionId}:${downstream.sectionId}`;
    const upstreamOffsets = boundaryOffsets(road, sourceUpstream, upstream, s);
    const downstreamOffsets = boundaryOffsets(road, sourceDownstream, downstream, s);
    const nodes = contactNodes(contactId, upstreamOffsets, downstreamOffsets);
    const bandContacts = contactBands(contactId, upstream, downstream, upstreamOffsets, downstreamOffsets);
    return {
      id: contactId,
      roadId: road.id,
      s,
      upstreamSectionId: upstream.sectionId,
      downstreamSectionId: downstream.sectionId,
      nodes,
      bandContacts
    };
  });
}
function boundaryOffsets(road, sourceSection, topologySection, s) {
  const sectionLocalS = s - sourceSection.s;
  const centerOffset = laneOffsetAt(road, s);
  return new Map(topologySection.boundaries.map((boundary) => [
    boundary.id,
    centerOffset + laneBoundaryOffsetAt(sourceSection, boundary.ordinal, sectionLocalS)
  ]));
}
function contactNodes(contactId, upstream, downstream) {
  const entries = [
    ...[...upstream].map(([boundaryId, t]) => ({ side: "upstream", boundaryId, t })),
    ...[...downstream].map(([boundaryId, t]) => ({ side: "downstream", boundaryId, t }))
  ].sort((left, right) => left.t - right.t || left.boundaryId.localeCompare(right.boundaryId));
  const groups = [];
  for (const entry of entries) {
    const group = groups.at(-1);
    if (!group || Math.abs(group[0].t - entry.t) > CONTACT_TOLERANCE)
      groups.push([entry]);
    else
      group.push(entry);
  }
  return groups.map((group, index) => ({
    id: `${contactId}|node:${index}`,
    t: group.reduce((sum, entry) => sum + entry.t, 0) / group.length,
    upstreamBoundaryIds: group.filter((entry) => entry.side === "upstream").map((entry) => entry.boundaryId).sort(),
    downstreamBoundaryIds: group.filter((entry) => entry.side === "downstream").map((entry) => entry.boundaryId).sort()
  }));
}
function contactBands(contactId, upstream, downstream, upstreamOffsets, downstreamOffsets) {
  const candidates = upstream.bands.flatMap((source) => {
    const sourceInterval = bandInterval(source, upstreamOffsets);
    const matches = downstream.bands.flatMap((target) => {
      const roleMatch = sourceRoleMatch2(source.sourceRole, target.sourceRole);
      if (roleMatch === "incompatible")
        return [];
      const targetInterval = bandInterval(target, downstreamOffsets);
      const overlapMinT = Math.max(sourceInterval.min, targetInterval.min);
      const overlapMaxT = Math.min(sourceInterval.max, targetInterval.max);
      if (overlapMaxT - overlapMinT <= CONTACT_TOLERANCE)
        return [];
      return [{
        id: `${contactId}|band:${source.id}>${target.id}`,
        upstreamBandId: source.id,
        downstreamBandId: target.id,
        overlapMinT,
        overlapMaxT,
        roleMatch,
        kind: "continuation"
      }];
    });
    const hasExactRole = matches.some((contact) => contact.roleMatch === "exact");
    return matches.filter((contact) => !hasExactRole || contact.roleMatch === "exact").map(({ roleMatch: _roleMatch, ...contact }) => contact);
  });
  const upstreamCounts = countBy(candidates.map((contact) => contact.upstreamBandId));
  const downstreamCounts = countBy(candidates.map((contact) => contact.downstreamBandId));
  return candidates.map((contact) => {
    const diverges = (upstreamCounts.get(contact.upstreamBandId) ?? 0) > 1;
    const merges = (downstreamCounts.get(contact.downstreamBandId) ?? 0) > 1;
    return {
      ...contact,
      kind: diverges && merges ? "complex" : diverges ? "diverge" : merges ? "merge" : "continuation"
    };
  });
}
function sourceRoleMatch2(sourceRole, targetRole) {
  if (sourceRole !== undefined && targetRole !== undefined) {
    return sourceRole === targetRole ? "exact" : "incompatible";
  }
  return "fallback";
}
function bandInterval(band, offsets) {
  const left = offsets.get(band.leftBoundaryId);
  const right = offsets.get(band.rightBoundaryId);
  if (left === undefined || right === undefined) {
    throw new Error(`Band ${band.id} has an unresolved boundary at its section contact`);
  }
  return { min: Math.min(left, right), max: Math.max(left, right) };
}
function countBy(values) {
  const counts = new Map;
  for (const value of values)
    counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
function corridorBoundaries(road, sectionId, lanes, bands) {
  const byId = new Map;
  const boundary = (ordinal) => {
    const id = corridorBoundaryId(road.id, sectionId, ordinal);
    const existing = byId.get(id);
    if (existing)
      return existing;
    const created = { id, ordinal, markings: [] };
    byId.set(id, created);
    return created;
  };
  boundary(0);
  for (const band of bands) {
    boundaryById(byId, band.leftBoundaryId).negativeSideBandId = band.id;
    boundaryById(byId, band.rightBoundaryId).positiveSideBandId = band.id;
  }
  for (const lane of lanes) {
    for (const marking of lane.markings ?? []) {
      const target = boundary(laneBoundaryOrdinal(lane.id, marking.boundary ?? "outer"));
      if (!target.markings.some((candidate) => sameMarking(candidate, marking))) {
        target.markings.push(structuredClone(marking));
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
}
function boundaryById(boundaries, id) {
  const boundary = boundaries.get(id);
  if (!boundary) {
    const ordinal = Number(id.split(":").at(-1)?.replace("m", "-"));
    const created = { id, ordinal, markings: [] };
    boundaries.set(id, created);
    return created;
  }
  return boundary;
}
function sameMarking(left, right) {
  return left.kind === right.kind && left.color === right.color && left.width === right.width && left.sStart === right.sStart && left.sEnd === right.sEnd;
}

// ../three-roads-inspect/packages/core/src/compiler/compile-markings.ts
function compileLaneMarkingIntents(network, document, templates) {
  const markingsByRoad = new Map;
  const boundaryMarkingsByRoad = new Map;
  for (const intent of document.markings ?? []) {
    const road = network.roads.find((candidate) => candidate.id === intent.roadId);
    const stroke = document.strokes.find((candidate) => candidate.id === intent.roadId);
    if (!road || !stroke)
      throw new Error(`Marking ${intent.id} references unavailable road ${intent.roadId}`);
    if (isBoundaryMarking2(intent)) {
      boundaryMarkingsByRoad.set(road.id, [
        ...boundaryMarkingsByRoad.get(road.id) ?? [],
        ...compileBoundaryMarking(intent, road, stroke, templates)
      ]);
    } else {
      const marking = intent.kind === "arrow" ? compileArrowMarking(intent, road, stroke, templates) : compileBandMarking(intent, road, stroke, templates);
      markingsByRoad.set(road.id, [...markingsByRoad.get(road.id) ?? [], marking]);
    }
  }
  return {
    ...network,
    roads: network.roads.map((road) => ({
      ...road,
      markings: [...road.markings ?? [], ...markingsByRoad.get(road.id) ?? []],
      laneSections: applyBoundaryMarkings(road, boundaryMarkingsByRoad.get(road.id) ?? [])
    }))
  };
}
function compileBoundaryMarking(intent, road, stroke, templates) {
  const result = [];
  for (const section of road.laneSections) {
    const sectionStart = section.s;
    const sectionEnd = laneSectionEndS(road, section);
    const sStart = Math.max(intent.sStart, sectionStart);
    const sEnd = Math.min(intent.sEnd, sectionEnd);
    if (sEnd - sStart <= 0.0000001)
      continue;
    const midpoint = (sStart + sEnd) * 0.5;
    const resolved = resolveLane(intent.id, intent.laneRole, midpoint, road, stroke, templates);
    if (resolved.section.id !== section.id)
      continue;
    result.push({
      sectionId: section.id,
      laneId: resolved.lane.id,
      marking: {
        id: intent.id,
        kind: intent.kind,
        boundary: intent.boundary,
        sStart,
        sEnd,
        width: intent.width,
        laneChange: intent.laneChange,
        color: intent.color,
        operational: activationProvenance(intent.activation, intent.id)
      },
      application: intent.application
    });
  }
  return result;
}
function applyBoundaryMarkings(road, compiled) {
  if (compiled.length === 0)
    return road.laneSections;
  return road.laneSections.map((section) => {
    const additions = compiled.filter((item) => item.sectionId === section.id);
    if (additions.length === 0)
      return section;
    let lanes = section.lanes.map((lane) => ({ ...lane, markings: [...lane.markings ?? []] }));
    for (const addition of additions) {
      if (addition.application === "replace-base") {
        const replacedOrdinal = laneBoundaryOrdinal(addition.laneId, addition.marking.boundary ?? "outer");
        lanes = lanes.map((lane) => ({
          ...lane,
          markings: lane.markings?.flatMap((marking) => laneBoundaryOrdinal(lane.id, marking.boundary ?? "outer") === replacedOrdinal ? subtractMarkingRange(marking, addition.marking.sStart, addition.marking.sEnd) : [marking])
        }));
      }
      lanes = lanes.map((lane) => lane.id === addition.laneId ? { ...lane, markings: [...lane.markings ?? [], addition.marking] } : lane);
    }
    return { ...section, lanes };
  });
}
function isBoundaryMarking2(intent) {
  return "boundary" in intent;
}
function compileArrowMarking(intent, road, stroke, templates) {
  const resolved = resolveLane(intent.id, intent.laneRole, intent.s, road, stroke, templates);
  return {
    id: intent.id,
    kind: "arrow",
    arrow: intent.arrow,
    sStart: intent.s,
    sEnd: intent.s,
    tOffset: laneCenterOffsetAt(resolved.section, resolved.lane.id, intent.s - resolved.section.s),
    direction: laneTravelDirection(resolved.lane),
    color: intent.color,
    operational: activationProvenance(intent.activation, intent.id)
  };
}
function compileBandMarking(intent, road, stroke, templates) {
  const start = bandAtStation(intent.id, intent.laneRoles, intent.sStart, road, stroke, templates);
  const end = bandAtStation(intent.id, intent.laneRoles, intent.sEnd, road, stroke, templates);
  return {
    id: intent.id,
    kind: intent.kind,
    sStart: intent.sStart,
    sEnd: intent.sEnd,
    tOffset: (start.tStart + start.tEnd) * 0.5,
    tStart: start.tStart,
    tEnd: start.tEnd,
    tStartAtEnd: end.tStart,
    tEndAtEnd: end.tEnd,
    width: intent.width,
    color: intent.color,
    operational: activationProvenance(intent.activation, intent.id),
    controlIds: structuredClone(intent.controlIds)
  };
}
function subtractMarkingRange(marking, start, end) {
  const markingStart = marking.sStart ?? Number.NEGATIVE_INFINITY;
  const markingEnd = marking.sEnd ?? Number.POSITIVE_INFINITY;
  if (markingEnd <= start + 0.0000001 || markingStart >= end - 0.0000001)
    return [marking];
  const result = [];
  if (markingStart < start - 0.0000001)
    result.push({ ...marking, sEnd: start });
  if (markingEnd > end + 0.0000001)
    result.push({ ...marking, sStart: end });
  return result;
}
function bandAtStation(markingId, roles, s, road, stroke, templates) {
  const bounds = roles.flatMap((role) => {
    const resolved = resolveLane(markingId, role, s, road, stroke, templates);
    const offsets = laneOffsetsAt(resolved.section, resolved.lane.id, s - resolved.section.s);
    return [offsets.inner, offsets.outer];
  });
  return { tStart: Math.min(...bounds), tEnd: Math.max(...bounds) };
}
function resolveLane(markingId, role, s, road, stroke, templates) {
  const laneId2 = laneIdForStrokeRoleAtStation(stroke, s, role, templates);
  const section = sectionAt5(road, s);
  const lane = section?.lanes.find((candidate) => candidate.id === laneId2);
  if (!section || !lane || laneId2 === undefined)
    throw new Error(`Marking ${markingId} cannot resolve lane role ${role}`);
  return { section, lane };
}
function laneTravelDirection(lane) {
  const standard = lane.id < 0 ? "forward" : "backward";
  if (lane.direction !== "reversed")
    return standard;
  return standard === "forward" ? "backward" : "forward";
}
function sectionAt5(road, s) {
  return [...road.laneSections].sort((a, b) => a.s - b.s).filter((section) => section.s <= s + 0.0000001).at(-1);
}

// ../three-roads-inspect/packages/core/src/compiler/compile-objects.ts
function compileLaneObjectIntents(network, document, templates) {
  const objectsByRoad = new Map;
  for (const intent of document.objects ?? []) {
    const road = network.roads.find((candidate) => candidate.id === intent.roadId);
    const stroke = document.strokes.find((candidate) => candidate.id === intent.roadId);
    if (!road || !stroke)
      throw new Error(`Object ${intent.id} references unavailable road ${intent.roadId}`);
    const anchor = intent.anchor ?? "center";
    const inset = intent.inset ?? 0;
    const repeatCount = intent.repeat?.count ?? 1;
    const repeatSpacing = intent.repeat?.spacing ?? 0;
    const lateralOffsets = Array.from({ length: repeatCount }, (_, index) => resolveAnchorOffset(road, stroke, templates, intent.laneRole, anchor, inset, intent.s + index * repeatSpacing));
    const {
      roadId: _roadId,
      laneRole,
      anchor: _anchor,
      inset: _inset,
      containment = defaultContainment(intent.kind),
      allowedLaneTypes,
      activation,
      ...object
    } = intent;
    objectsByRoad.set(road.id, [...objectsByRoad.get(road.id) ?? [], {
      ...object,
      ...object.repeat ? { repeat: { ...object.repeat, lateralOffsets } } : {},
      t: lateralOffsets[0],
      laneBinding: {
        role: laneRole,
        anchor,
        containment,
        ...inset > 0 ? { inset } : {},
        ...allowedLaneTypes ? { allowedLaneTypes } : {}
      },
      operational: activationProvenance(activation, intent.id)
    }]);
  }
  return {
    ...network,
    roads: network.roads.map((road) => ({
      ...road,
      objects: [...road.objects ?? [], ...objectsByRoad.get(road.id) ?? []]
    }))
  };
}
function resolveAnchorOffset(road, stroke, templates, laneRole, anchor, inset, station) {
  const laneId2 = laneIdForStrokeRoleAtStation(stroke, station, laneRole, templates);
  const section = [...road.laneSections].sort((a, b) => a.s - b.s).filter((candidate) => candidate.s <= station + 0.0000001).at(-1);
  const lane = section?.lanes.find((candidate) => candidate.id === laneId2);
  if (!section || !lane || laneId2 === undefined)
    throw new Error(`Object cannot resolve lane role ${laneRole} at s=${station}`);
  const offsets = laneOffsetsAt(section, lane.id, station - section.s);
  if (anchor === "inner")
    return offsets.inner + Math.sign(offsets.outer - offsets.inner) * inset;
  if (anchor === "outer")
    return offsets.outer + Math.sign(offsets.inner - offsets.outer) * inset;
  return laneCenterOffsetAt(section, lane.id, station - section.s);
}
function defaultContainment(kind) {
  return kind === "parking-space" ? "lane" : "none";
}

// ../three-roads-inspect/packages/core/src/compiler/compile-road-links.ts
function compileRoadStrokeLinks(network, document, templates) {
  let roads = network.roads;
  for (const source of document.strokes) {
    const link = source.links?.successor;
    if (!link)
      continue;
    const target = document.strokes.find((stroke) => stroke.id === link.roadId);
    if (!target)
      throw new Error(`Stroke ${source.id} successor ${link.roadId} is unavailable`);
    roads = attachContinuity(roads, source, target, link.contactPoint, templates);
  }
  return { ...network, roads };
}
function attachContinuity(roads, source, target, targetContactPoint, templates) {
  const sourceRoad = requireRoad(roads, source.id);
  const targetRoad = requireRoad(roads, target.id);
  const lanePairs = laneRolesAtStrokeEndpoint(source, "end", templates).flatMap((role) => {
    const from = laneIdForStrokeRoleAtEndpoint(source, "end", role, templates);
    const to = laneIdForStrokeRoleAtEndpoint(target, targetContactPoint, role, templates);
    return from === undefined || to === undefined ? [] : [{ from, to }];
  });
  const requiredContinuity = source.links?.successor?.requiredContinuity ?? "g1";
  return roads.map((road) => {
    if (road.id === sourceRoad.id) {
      return {
        ...road,
        links: { ...road.links, successors: [{ roadId: targetRoad.id, contactPoint: targetContactPoint, requiredContinuity }] },
        laneSections: updateEndpointSection(road, "end", (lane) => {
          const pair = lanePairs.find((candidate) => candidate.from === lane.id);
          return pair ? { ...lane, links: { ...lane.links, successor: { roadId: targetRoad.id, laneId: pair.to, contactPoint: targetContactPoint } } } : lane;
        })
      };
    }
    if (road.id === targetRoad.id) {
      return {
        ...road,
        links: { ...road.links, predecessors: [{ roadId: sourceRoad.id, contactPoint: "end", requiredContinuity }] },
        laneSections: updateEndpointSection(road, targetContactPoint, (lane) => {
          const pair = lanePairs.find((candidate) => candidate.to === lane.id);
          return pair ? { ...lane, links: { ...lane.links, predecessor: { roadId: sourceRoad.id, laneId: pair.from, contactPoint: "end" } } } : lane;
        })
      };
    }
    return road;
  });
}
function updateEndpointSection(road, contactPoint, update) {
  const sections = [...road.laneSections].sort((a, b) => a.s - b.s);
  const endpoint = contactPoint === "start" ? sections[0] : sections.at(-1);
  if (!endpoint)
    throw new Error(`Road ${road.id} has no lane sections`);
  return road.laneSections.map((section) => section.id === endpoint.id ? { ...section, lanes: section.lanes.map(update) } : section);
}
function requireRoad(roads, roadId) {
  const road = roads.find((candidate) => candidate.id === roadId);
  if (!road)
    throw new Error(`Compiled road ${roadId} is unavailable`);
  return road;
}

// ../three-roads-inspect/packages/core/src/topology/junction-topology.ts
function buildJunctionPhysicalTopologies(network, corridors, reuse) {
  const corridorByRoad = new Map(corridors.map((corridor) => [corridor.roadId, corridor]));
  const roadsById = new Map(network.roads.map((road) => [road.id, road]));
  const ownedRoadIdsByJunction = new Map;
  for (const road of network.roads) {
    if (!road.junctionId)
      continue;
    const values = ownedRoadIdsByJunction.get(road.junctionId);
    if (values)
      values.push(road.id);
    else
      ownedRoadIdsByJunction.set(road.junctionId, [road.id]);
  }
  const previousJunctions = new Map(reuse?.previousNetwork.junctions.map((junction) => [junction.id, junction]) ?? []);
  const previousTopologies = new Map(reuse?.previousTopologies.map((topology) => [topology.junctionId, topology]) ?? []);
  return network.junctions.map((junction) => {
    const previous = previousTopologies.get(junction.id);
    if (previous && previousJunctions.get(junction.id) === junction)
      return previous;
    const movements = junction.connections.flatMap((connection) => {
      if (connection.sourceLaneContinuationId)
        return [];
      const connector = roadsById.get(connection.connectingRoadId);
      if (!connector || connector.kind !== "connector" || connector.junctionId !== junction.id)
        return [];
      return connection.laneLinks.flatMap((laneLink) => {
        const movement = movementTopology(roadsById, corridorByRoad, junction, connection, connector, laneLink.from, laneLink.to);
        return movement ? [movement] : [];
      });
    });
    const laneContinuations = junction.connections.flatMap((connection) => {
      if (!connection.sourceLaneContinuationId)
        return [];
      const connector = roadsById.get(connection.connectingRoadId);
      if (!connector || connector.kind !== "connector" || connector.junctionId !== junction.id)
        return [];
      return connection.laneLinks.flatMap((laneLink) => {
        const continuation = laneContinuationTopology(roadsById, corridorByRoad, junction, connection, connector, laneLink.from, laneLink.to);
        return continuation ? [continuation] : [];
      });
    });
    const directLaneLinks = junction.connections.flatMap((connection) => {
      const connectingRoad = roadsById.get(connection.connectingRoadId);
      if (connectingRoad?.kind === "connector" && connectingRoad.junctionId === junction.id)
        return [];
      return connection.laneLinks.map((laneLink) => directLaneLinkTopology(roadsById, corridorByRoad, junction, connection, laneLink.from, laneLink.to));
    });
    const movementInteractions = junctionMovementInteractions(junction, movements);
    const trafficStreams = junctionTrafficStreams(roadsById, corridorByRoad, junction);
    const streamInteractions = junctionStreamInteractions(junction, trafficStreams);
    return {
      id: `junction-topology|${junction.id}`,
      junctionId: junction.id,
      junctionKind: junction.kind,
      surfaceOwnerId: `junction:${junction.id}`,
      surfacePolicy: junction.surfacePolygon || junction.surfacePatches?.length ? "authored" : junction.connectorGeometryPolicy === "surface-fallback" ? "surface-fallback" : junction.kind === "crossing" || junction.kind === "virtual" ? "overlap" : movements.length > 0 || laneContinuations.length > 0 ? "connector-bands" : "none",
      roadIds: junctionRoadIds(ownedRoadIdsByJunction, junction, movements, laneContinuations),
      movements,
      laneContinuations,
      directLaneLinks,
      movementInteractions,
      trafficStreams,
      streamInteractions,
      virtualRange: structuredClone(junction.virtualRange),
      surfaceElevation: structuredClone(junction.surfaceElevation),
      surfacePolygon: structuredClone(junction.surfacePolygon),
      surfaceLaneType: junction.surfaceLaneType,
      surfacePatches: structuredClone(junction.surfacePatches),
      holeObjectIds: junctionHoleObjectIds(network, junction.id),
      conflictZoneIds: (junction.conflictZones ?? []).map((zone) => zone.id).sort()
    };
  });
}
function laneContinuationTopology(roadsById, corridorByRoad, junction, connection, connector, incomingLaneId, connectorLaneId) {
  const sourceLaneContinuationId = connection.sourceLaneContinuationId;
  if (!sourceLaneContinuationId)
    return;
  const base = movementTopology(roadsById, corridorByRoad, junction, connection, connector, incomingLaneId, connectorLaneId);
  if (!base)
    return;
  return {
    id: `junction-lane-continuation|${junction.id}|${connection.id}|${connector.id}|${connectorLaneId}`,
    junctionId: base.junctionId,
    connectionId: base.connectionId,
    sourceLaneContinuationId,
    connectorRoadId: base.connectorRoadId,
    connectorBandIds: base.connectorBandIds,
    from: base.from,
    to: base.to,
    requiredContinuity: base.requiredContinuity
  };
}
function junctionTrafficStreams(roadsById, corridorByRoad, junction) {
  return (junction.trafficStreams ?? []).map((stream) => {
    const road = requiredRoad2(roadsById, stream.roadId, junction.id);
    const section = sectionAtContact(road, stream.s);
    const band = requiredBand(corridorByRoad, road.id, section.id, stream.laneId, junction.id);
    return {
      id: `junction-stream|${junction.id}|${stream.id}`,
      junctionId: junction.id,
      sourceStreamId: stream.id,
      movement: stream.movement,
      contactGroupId: stream.contactGroupId,
      roadId: road.id,
      sectionId: section.id,
      laneId: stream.laneId,
      bandId: band.id,
      s: stream.s,
      sStart: stream.sStart,
      sEnd: stream.sEnd,
      travelHeading: stream.travelHeading,
      conflictEnvelopeWidth: stream.conflictEnvelopeWidth
    };
  });
}
function junctionStreamInteractions(junction, streams) {
  const topologyIdBySource = new Map(streams.map((stream) => [stream.sourceStreamId, stream.id]));
  return (junction.streamInteractions ?? []).map((interaction) => ({
    id: `physical-${interaction.id}`,
    junctionId: junction.id,
    sourceStreamIds: [...interaction.streamIds],
    streamTopologyIds: interaction.streamIds.map((streamId) => topologyIdBySource.get(streamId) ?? ""),
    kind: interaction.kind,
    control: structuredClone(interaction.control),
    prioritySourceStreamId: interaction.priorityStreamId,
    conflictZoneIds: [...interaction.conflictZoneIds]
  }));
}
function directLaneLinkTopology(roadsById, corridorByRoad, junction, connection, incomingLaneId, connectingLaneId) {
  const incomingRoad = requiredRoad2(roadsById, connection.incomingRoadId, junction.id);
  const connectingRoad = requiredRoad2(roadsById, connection.connectingRoadId, junction.id);
  const incomingS = connection.incomingS ?? endpointS3(incomingRoad, connection.incomingContactPoint);
  const connectingS = connection.connectingS ?? endpointS3(connectingRoad, connection.contactPoint);
  const incomingSection = sectionAtIncoming5(incomingRoad, incomingS);
  const connectingSection = sectionAtContact(connectingRoad, connectingS);
  return {
    id: `junction-direct-link|${junction.id}|${connection.id}|${incomingLaneId}>${connectingLaneId}`,
    junctionId: junction.id,
    connectionId: connection.id,
    sourceManeuverId: connection.sourceManeuverId ?? connection.id,
    from: laneContact(corridorByRoad, incomingRoad, incomingSection, incomingLaneId, incomingS, connection.incomingContactPoint ?? contactPointForStation3(incomingRoad, incomingS), junction.id, "from"),
    to: laneContact(corridorByRoad, connectingRoad, connectingSection, connectingLaneId, connectingS, connection.contactPoint, junction.id, "to"),
    requiredContinuity: connection.requiredContinuity ?? "g1"
  };
}
function movementTopology(roadsById, corridorByRoad, junction, connection, connector, incomingLaneId, connectorLaneId) {
  const incomingRoad = requiredRoad2(roadsById, connection.incomingRoadId, junction.id);
  const incomingS = connection.incomingS ?? endpointS3(incomingRoad, connection.incomingContactPoint);
  const incomingSection = sectionAtIncoming5(incomingRoad, incomingS);
  const connectorSections = [...connector.laneSections].sort((left, right) => left.s - right.s);
  const connectorBands = connectorSections.flatMap((section) => {
    const lane = section.lanes.find((candidate) => candidate.id === connectorLaneId);
    return lane ? [requiredBand(corridorByRoad, connector.id, section.id, lane.id, junction.id)] : [];
  });
  if (connectorBands.length === 0) {
    return;
  }
  const lastSection = connectorSections.at(-1);
  const connectorLane = lastSection?.lanes.find((lane) => lane.id === connectorLaneId);
  const successor = connectorLane?.links?.successor;
  if (!lastSection || !connectorLane || !successor) {
    return;
  }
  const outgoingRoad = requiredRoad2(roadsById, successor.roadId, junction.id);
  const outgoingS = successor.s ?? endpointS3(outgoingRoad, successor.contactPoint);
  const outgoingSection = successor.s === undefined ? endpointSection(outgoingRoad, successor.contactPoint) : sectionAtContact(outgoingRoad, successor.s);
  return {
    id: `junction-movement|${junction.id}|${connection.id}|${connector.id}|${connectorLaneId}`,
    junctionId: junction.id,
    connectionId: connection.id,
    sourceManeuverId: connection.sourceManeuverId ?? connection.id,
    connectorRoadId: connector.id,
    connectorBandIds: connectorBands.map((band) => band.id),
    from: laneContact(corridorByRoad, incomingRoad, incomingSection, incomingLaneId, incomingS, connection.incomingContactPoint ?? contactPointForStation3(incomingRoad, incomingS), junction.id, "from"),
    to: laneContact(corridorByRoad, outgoingRoad, outgoingSection, successor.laneId, outgoingS, successor.contactPoint, junction.id, "to"),
    requiredContinuity: connector.requiredEndpointContinuity ?? connection.requiredContinuity ?? "g1"
  };
}
function junctionMovementInteractions(junction, movements) {
  const movementIdsBySource = new Map;
  for (const movement of movements) {
    movementIdsBySource.set(movement.sourceManeuverId, [
      ...movementIdsBySource.get(movement.sourceManeuverId) ?? [],
      movement.id
    ]);
  }
  return (junction.movementInteractions ?? []).map((interaction) => ({
    id: `physical-${interaction.id}`,
    junctionId: junction.id,
    sourceManeuverIds: [...interaction.maneuverIds],
    movementTopologyIds: interaction.maneuverIds.flatMap((maneuverId) => movementIdsBySource.get(maneuverId) ?? []),
    kind: interaction.kind,
    control: structuredClone(interaction.control),
    prioritySourceManeuverId: interaction.control.kind === "fixed-priority" ? interaction.control.priorityParticipantId : undefined,
    priorityMovementTopologyIds: interaction.control.kind === "fixed-priority" ? [...movementIdsBySource.get(interaction.control.priorityParticipantId) ?? []] : [],
    conflictZoneIds: [...interaction.conflictZoneIds]
  }));
}
function laneContact(corridorByRoad, road, section, laneId2, s, contactPoint, junctionId, side) {
  const band = requiredBand(corridorByRoad, road.id, section.id, laneId2, junctionId);
  return {
    id: `junction-contact|${junctionId}|${side}|${road.id}|${section.id}|${laneId2}`,
    roadId: road.id,
    sectionId: section.id,
    laneId: laneId2,
    bandId: band.id,
    s,
    contactPoint,
    leftBoundaryId: band.leftBoundaryId,
    rightBoundaryId: band.rightBoundaryId
  };
}
function requiredBand(corridorByRoad, roadId, sectionId, laneId2, junctionId) {
  const band = corridorByRoad.get(roadId)?.sections.find((section) => section.sectionId === sectionId)?.bands.find((candidate) => candidate.laneId === laneId2);
  if (!band)
    throw new Error(`Junction ${junctionId} cannot resolve band ${roadId}/${sectionId}/${laneId2}`);
  return band;
}
function junctionRoadIds(ownedRoadIdsByJunction, junction, movements, laneContinuations) {
  const ids = new Set;
  for (const port of junction.ports ?? [])
    ids.add(port.roadId);
  for (const connection of junction.connections) {
    ids.add(connection.incomingRoadId);
    ids.add(connection.connectingRoadId);
  }
  for (const movement of movements) {
    ids.add(movement.connectorRoadId);
    ids.add(movement.from.roadId);
    ids.add(movement.to.roadId);
  }
  for (const continuation of laneContinuations) {
    ids.add(continuation.connectorRoadId);
    ids.add(continuation.from.roadId);
    ids.add(continuation.to.roadId);
  }
  for (const roadId of ownedRoadIdsByJunction.get(junction.id) ?? [])
    ids.add(roadId);
  return [...ids].sort();
}
function junctionHoleObjectIds(network, junctionId) {
  const ids = new Set;
  for (const object of network.objects ?? []) {
    if (object.junctionId === junctionId && (object.kind === "island" || object.kind === "platform"))
      ids.add(object.id);
  }
  for (const road of network.roads) {
    for (const object of road.objects ?? []) {
      if ((road.junctionId === junctionId || object.junctionId === junctionId) && (object.kind === "island" || object.kind === "platform"))
        ids.add(object.id);
    }
  }
  return [...ids].sort();
}
function requiredRoad2(roadsById, roadId, junctionId) {
  const road = roadsById.get(roadId);
  if (!road)
    throw new Error(`Junction ${junctionId} references missing road ${roadId}`);
  return road;
}
function endpointS3(road, contactPoint) {
  return contactPoint === "start" ? 0 : road.length;
}
function endpointSection(road, contactPoint) {
  const sections = [...road.laneSections].sort((left, right) => left.s - right.s);
  const section = contactPoint === "start" ? sections[0] : sections.at(-1);
  if (!section)
    throw new Error(`Road ${road.id} has no lane section at ${contactPoint}`);
  return section;
}
function sectionAtIncoming5(road, s) {
  const sections = [...road.laneSections].sort((left, right) => left.s - right.s);
  const section = sections.filter((candidate) => candidate.s < s - 0.0000001).at(-1) ?? sections[0];
  if (!section)
    throw new Error(`Road ${road.id} has no incoming lane section at s=${s}`);
  return section;
}
function sectionAtContact(road, s) {
  const section = [...road.laneSections].sort((left, right) => left.s - right.s).filter((candidate) => candidate.s <= s + 0.0000001).at(-1);
  if (!section)
    throw new Error(`Road ${road.id} has no lane section at s=${s}`);
  return section;
}
function contactPointForStation3(road, s) {
  return s <= road.length / 2 ? "start" : "end";
}

// ../three-roads-inspect/packages/core/src/topology/physical-topology.ts
function buildRoadPhysicalTopology(network, reuse) {
  const previousRoads = new Map(reuse?.previousNetwork.roads.map((road) => [road.id, road]) ?? []);
  const previousCorridors = new Map(reuse?.previousTopology.corridors.map((corridor) => [corridor.roadId, corridor]) ?? []);
  const sourceCorridors = network.roads.map((road) => previousRoads.get(road.id) === road ? previousCorridors.get(road.id) ?? buildRoadCorridorTopology(road) : buildRoadCorridorTopology(road));
  const junctions = buildJunctionPhysicalTopologies(network, sourceCorridors, reuse ? {
    previousNetwork: reuse.previousNetwork,
    previousTopologies: reuse.previousTopology.junctions
  } : undefined);
  const corridors = assignJunctionSurfaceCutouts(sourceCorridors, junctions);
  return {
    corridors,
    junctions,
    gradeSeparations: structuredClone(network.gradeSeparations ?? []),
    roadStructures: structuredClone(network.roadStructures ?? []),
    roadsideFeatures: structuredClone(network.roadsideFeatures ?? []),
    weavingSections: (network.weavingSections ?? []).map((weaving) => {
      const corridor = corridors.find((candidate) => candidate.roadId === weaving.roadId);
      if (!corridor)
        throw new Error(`Weaving section ${weaving.id} has no physical corridor`);
      return {
        id: weaving.id,
        roadId: weaving.roadId,
        sStart: weaving.sStart,
        sEnd: weaving.sEnd,
        entryJunctionId: weaving.entryJunctionId,
        entryManeuverId: weaving.entryManeuverId,
        exitJunctionId: weaving.exitJunctionId,
        exitManeuverId: weaving.exitManeuverId,
        lanePairs: weaving.lanePairs.map((pair) => {
          const section = corridor.sections.find((candidate) => candidate.sectionId === pair.sectionId);
          const through = section?.bands.find((band) => band.laneId === pair.throughLaneId);
          const auxiliary = section?.bands.find((band) => band.laneId === pair.weavingLaneId);
          if (!through || !auxiliary)
            throw new Error(`Weaving section ${weaving.id} has an unresolved physical lane pair`);
          const sharedBoundaryId = [through.leftBoundaryId, through.rightBoundaryId].find((boundaryId) => boundaryId === auxiliary.leftBoundaryId || boundaryId === auxiliary.rightBoundaryId);
          if (!sharedBoundaryId)
            throw new Error(`Weaving section ${weaving.id} lane pair has no shared physical boundary`);
          return {
            sectionId: pair.sectionId,
            throughLaneId: pair.throughLaneId,
            weavingLaneId: pair.weavingLaneId,
            throughBandId: through.id,
            weavingBandId: auxiliary.id,
            sharedBoundaryId,
            sStart: pair.sStart,
            sEnd: pair.sEnd
          };
        })
      };
    })
  };
}
function assignJunctionSurfaceCutouts(corridors, junctions) {
  const ownersByRoad = new Map;
  for (const junction of junctions) {
    if (junction.surfacePolicy === "none")
      continue;
    for (const roadId of junction.roadIds) {
      const owners = ownersByRoad.get(roadId) ?? [];
      if (!owners.includes(junction.junctionId))
        ownersByRoad.set(roadId, [...owners, junction.junctionId].sort());
    }
  }
  return corridors.map((corridor) => {
    const ownerIds = ownersByRoad.get(corridor.roadId);
    if (!ownerIds || corridor.roadKind === "connector")
      return corridor;
    return {
      ...corridor,
      sections: corridor.sections.map((section) => ({
        ...section,
        bands: section.bands.map((band) => band.surfaceOwner.kind === "road" ? { ...band, surfaceCutoutOwnerIds: [...ownerIds] } : band)
      }))
    };
  });
}

// ../three-roads-inspect/packages/core/src/topology/junction-perimeter-surface.ts
function junctionPerimeterSurfaces(network, movements, step, minArea) {
  return junctionPerimeterBoundarySurfaces(network, movements, step, minArea, "inner");
}
function junctionOuterPerimeterSurfaces(network, movements, step, minArea) {
  return junctionPerimeterBoundarySurfaces(network, movements, step, minArea, "outer");
}
function junctionPerimeterBoundarySurfaces(network, movements, step, minArea, boundary) {
  const edges = perimeterEdges(network, movements, step, boundary);
  if (edges.length < 3)
    return [];
  const incident = new Map;
  edges.forEach((edge, index) => {
    appendIncident(incident, edge.fromKey, index);
    appendIncident(incident, edge.toKey, index);
  });
  if ([...incident.values()].some((indices) => indices.length !== 2))
    return [];
  const unused = new Set(edges.map((_, index) => index));
  const surfaces = [];
  while (unused.size > 0) {
    const firstIndex = unused.values().next().value;
    const first = edges[firstIndex];
    const ring = [];
    const startKey = first.fromKey;
    let currentKey = startKey;
    let edgeIndex = firstIndex;
    let closed = false;
    for (let count = 0;count <= edges.length; count++) {
      const edge = edges[edgeIndex];
      if (!unused.delete(edgeIndex))
        break;
      const forward = edge.fromKey === currentKey;
      appendPolyline(ring, forward ? edge.points : [...edge.points].reverse());
      currentKey = forward ? edge.toKey : edge.fromKey;
      if (currentKey === startKey) {
        closed = true;
        break;
      }
      const next = incident.get(currentKey)?.find((candidate) => unused.has(candidate));
      if (next === undefined)
        break;
      edgeIndex = next;
    }
    const polygon = normalizedPolygon(ring);
    if (closed && polygon.length >= 3 && isSimplePolygonRing(polygon) && Math.abs(polygonArea(polygon)) >= minArea) {
      surfaces.push(polygon);
    }
  }
  return surfaces;
}
function perimeterEdges(network, movements, step, boundary) {
  const byConnector = new Map;
  for (const movement of movements) {
    if (movement.surfaceKind !== "lane-continuation" || movement.laneType !== "border" && movement.laneType !== "sidewalk")
      continue;
    const previous = byConnector.get(movement.connectorRoadId);
    const preferMovement = boundary === "inner" ? !previous || Math.abs(movement.connectorLaneId) < Math.abs(previous.connectorLaneId) : !previous || Math.abs(movement.connectorLaneId) > Math.abs(previous.connectorLaneId);
    if (preferMovement) {
      byConnector.set(movement.connectorRoadId, movement);
    }
  }
  return [...byConnector.values()].flatMap((movement) => {
    const road = network.roads.find((candidate) => candidate.id === movement.connectorRoadId);
    const section = road?.laneSections.find((candidate) => candidate.id === movement.connectorSectionId);
    const lane = section?.lanes.find((candidate) => candidate.id === movement.connectorLaneId);
    if (!road || !section || !lane)
      return [];
    const points = sampleLaneBoundary(road, section, lane.id, boundary, section.s, laneSectionEndS(road, section), step);
    if (points.length < 2)
      return [];
    return [{
      id: movement.id,
      fromKey: contactKey(movement.from),
      toKey: contactKey(movement.to),
      points
    }];
  });
}
function contactKey(contact) {
  return `${contact.roadId}@${contact.s.toFixed(6)}`;
}
function appendIncident(map, key, edgeIndex) {
  map.set(key, [...map.get(key) ?? [], edgeIndex]);
}
function appendPolyline(target, points) {
  if (target.length === 0) {
    target.push(...points);
    return;
  }
  const start = points[0];
  const previous = target.at(-1);
  target.push(...Math.hypot(start.x - previous.x, start.y - previous.y) <= 0.00000001 ? points.slice(1) : points);
}

// ../three-roads-inspect/packages/core/src/topology/junction-surface-material-partition.ts
var PERIMETER_LANE_TYPES = new Set(["shoulder", "border"]);
var CROSS_SECTION_MORPH_LANE_TYPES = new Set(["shoulder", "median"]);
var FALLBACK_RESIDUAL_LANE_TYPES = new Set(["border", "sidewalk"]);
function partitionJunctionSurfaceMaterials(connectorBands, patches, holes, assemblyComponents) {
  const crossSectionMorph = connectorBands.some((band) => CROSS_SECTION_MORPH_LANE_TYPES.has(band.laneType));
  const mixedOrdinaryFallback = patches.some((patch) => patch.id.startsWith("surface-fallback|")) && connectorBands.some((band) => FALLBACK_RESIDUAL_LANE_TYPES.has(band.laneType));
  if (!crossSectionMorph && !mixedOrdinaryFallback) {
    return partitionLegacyJunctionMaterials(connectorBands, patches, holes, assemblyComponents);
  }
  const explicitPolygons = [
    ...connectorBands.map((band) => ({
      ...band,
      key: materialKey(band)
    })),
    ...patches.flatMap((patch) => {
      if (!patch.laneType || patch.id.startsWith("movement-band|") || patch.id.startsWith("surface-fallback|"))
        return [];
      const band = {
        laneType: patch.laneType,
        ...patch.surface !== undefined ? { surface: patch.surface } : {},
        polygon: patch.polygon
      };
      return [{
        ...band,
        key: materialKey(band)
      }];
    })
  ];
  const fallbackPolygons = patches.flatMap((patch) => {
    if (!patch.laneType || !patch.id.startsWith("surface-fallback|"))
      return [];
    const band = {
      laneType: patch.laneType,
      ...patch.surface !== undefined ? { surface: patch.surface } : {},
      polygon: patch.polygon
    };
    return [{ ...band, key: materialKey(band) }];
  });
  const orderedGroups = groupedMaterialPolygons([...explicitPolygons, ...fallbackPolygons]);
  if (orderedGroups.length === 1 && holes.length === 0 && !PERIMETER_LANE_TYPES.has(orderedGroups[0].laneType)) {
    return [{
      laneType: orderedGroups[0].laneType,
      ...orderedGroups[0].surface !== undefined ? { surface: orderedGroups[0].surface } : {},
      components: [...assemblyComponents]
    }];
  }
  const holePolygons = holes.map((hole) => hole.polygon);
  const nonPerimeterPolygons = explicitPolygons.filter((surface) => !PERIMETER_LANE_TYPES.has(surface.laneType)).map((surface) => surface.polygon);
  const explicitGroups = groupedMaterialPolygons(explicitPolygons);
  const visibleExplicit = new Map(explicitGroups.map((group) => [
    group.key,
    significantComponents(unionPolygons(group.polygons).flatMap((component) => subtractPolygons(component.outer, [
      ...component.holes,
      ...holePolygons,
      ...PERIMETER_LANE_TYPES.has(group.laneType) ? nonPerimeterPolygons : []
    ])))
  ]));
  const componentsByKey = new Map(visibleExplicit);
  for (const fallbackGroup of groupedMaterialPolygons(fallbackPolygons)) {
    const sameKeyExplicit = explicitGroups.find((group) => group.key === fallbackGroup.key)?.polygons ?? [];
    const visibleOtherMaterials = [...visibleExplicit.entries()].filter(([key]) => key !== fallbackGroup.key).flatMap(([, components2]) => components2);
    const clips = [
      ...holes.map((hole) => ({ outer: hole.polygon, holes: [] })),
      ...visibleOtherMaterials
    ];
    const components = unionPolygons([...fallbackGroup.polygons, ...sameKeyExplicit]).flatMap((component) => subtractPolygonComponents(component.outer, [
      ...component.holes.map((hole) => ({ outer: hole, holes: [] })),
      ...clips
    ]));
    componentsByKey.set(fallbackGroup.key, components);
  }
  return orderedGroups.flatMap((group) => {
    const components = componentsByKey.get(group.key) ?? [];
    if (components.length === 0)
      return [];
    return [{
      laneType: group.laneType,
      ...group.surface !== undefined ? { surface: group.surface } : {},
      components
    }];
  });
}
function partitionLegacyJunctionMaterials(connectorBands, patches, holes, assemblyComponents) {
  const typedPolygons = [
    ...connectorBands.map((band) => ({
      ...band,
      key: materialKey(band)
    })),
    ...patches.flatMap((patch) => {
      if (!patch.laneType || patch.id.startsWith("movement-band|"))
        return [];
      const band = {
        laneType: patch.laneType,
        ...patch.surface !== undefined ? { surface: patch.surface } : {},
        polygon: patch.polygon
      };
      return [{
        ...band,
        key: materialKey(band),
        isFallback: patch.id.startsWith("surface-fallback|")
      }];
    })
  ];
  const groups = groupedMaterialPolygons(typedPolygons);
  if (groups.length === 1 && holes.length === 0 && !PERIMETER_LANE_TYPES.has(groups[0].laneType)) {
    return [{
      laneType: groups[0].laneType,
      ...groups[0].surface !== undefined ? { surface: groups[0].surface } : {},
      components: [...assemblyComponents]
    }];
  }
  const occupiedPavement = typedPolygons.filter((surface) => !surface.isFallback && !PERIMETER_LANE_TYPES.has(surface.laneType)).map((surface) => surface.polygon);
  return groups.flatMap((group) => {
    const components = unionPolygons(group.polygons).flatMap((component) => subtractPolygons(component.outer, [
      ...component.holes,
      ...holes.map((hole) => hole.polygon),
      ...PERIMETER_LANE_TYPES.has(group.laneType) ? occupiedPavement : []
    ]));
    if (components.length === 0)
      return [];
    return [{
      laneType: group.laneType,
      ...group.surface !== undefined ? { surface: group.surface } : {},
      components
    }];
  });
}
function groupedMaterialPolygons(polygons) {
  const groups = new Map;
  for (const polygon of polygons) {
    const group = groups.get(polygon.key) ?? {
      key: polygon.key,
      laneType: polygon.laneType,
      ...polygon.surface !== undefined ? { surface: polygon.surface } : {},
      polygons: []
    };
    group.polygons.push(polygon.polygon);
    groups.set(polygon.key, group);
  }
  return [...groups.values()];
}
function materialKey(surface) {
  return `${surface.laneType}\x00${surface.surface ?? ""}`;
}
function significantComponents(components) {
  return components.filter((component) => polygonComponentsArea([component]) > MINIMUM_POLYGON_COMPONENT_AREA);
}

// ../three-roads-inspect/packages/core/src/topology/junction-surface-fallback.ts
var NON_PAVEMENT_PERIMETER_TYPES = new Set([
  "center",
  "shoulder",
  "border",
  "sidewalk",
  "median"
]);
function junctionSurfaceFallbackPolygon(network, junctionId, minArea) {
  const junction = network.junctions.find((candidate) => candidate.id === junctionId);
  if (junction?.connectorGeometryPolicy !== "surface-fallback")
    return;
  const portals = fallbackPortals(network, junction);
  const polygon = normalizedPolygon(portalRing(portals));
  const fallback = polygon.length >= 3 && isSimplePolygonRing(polygon) ? polygon : normalizedPolygon(convexHull(portals.flatMap(({ face }) => face)));
  return fallback.length >= 3 && Math.abs(polygonArea(fallback)) >= minArea ? fallback : undefined;
}
function fallbackPortals(network, junction) {
  return (junction.ports ?? []).flatMap((port) => {
    const road = network.roads.find((candidate) => candidate.id === port.roadId);
    if (!road || road.kind === "connector")
      return [];
    const station = port.s ?? (port.contactPoint === "start" ? 0 : road.length);
    const extent = junctionPavementLateralExtentAt(road, station);
    const outwardLeftSign = port.contactPoint === "start" ? -1 : 1;
    const offsets = [extent.minimumT, extent.maximumT].sort((left, right) => left * outwardLeftSign - right * outwardLeftSign);
    const heading = evaluateReferenceLine(road.referenceLine, station).heading;
    return [{
      outwardHeading: port.contactPoint === "start" ? heading + Math.PI : heading,
      face: offsets.map((offset) => planePoint(road, station, offset))
    }];
  });
}
function junctionPavementLateralExtentAt(road, s) {
  const station = Math.max(0, Math.min(road.length, s));
  const section = findLaneSection(road, station);
  const pavementLanes = section.lanes.filter((lane) => lane.id !== 0 && !NON_PAVEMENT_PERIMETER_TYPES.has(lane.type));
  if (pavementLanes.length === 0)
    return roadLateralExtentAt(road, station);
  const localS = station - section.s;
  const minimumOrdinal = Math.min(0, ...pavementLanes.map(({ id }) => id));
  const maximumOrdinal = Math.max(0, ...pavementLanes.map(({ id }) => id));
  return {
    minimumT: laneBoundaryOffsetAt(section, minimumOrdinal, localS),
    maximumT: laneBoundaryOffsetAt(section, maximumOrdinal, localS)
  };
}
function portalRing(portals) {
  return [...portals].sort((left, right) => normalizedBearing(left.outwardHeading) - normalizedBearing(right.outwardHeading)).flatMap(({ face }) => face);
}
function planePoint(road, station, offset) {
  const point = roadToWorld(road, station, offset);
  return { x: point.x, y: point.y };
}
function normalizedBearing(angle) {
  const fullTurn = Math.PI * 2;
  return (angle % fullTurn + fullTurn) % fullTurn;
}
function convexHull(points) {
  const sorted = [
    ...new Map(points.map((point) => [`${point.x}\x00${point.y}`, point])).values()
  ].sort((left, right) => left.x - right.x || left.y - right.y);
  if (sorted.length <= 2)
    return sorted;
  const cross5 = (origin, left, right) => (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
  const half = (candidates) => {
    const result = [];
    for (const point of candidates) {
      while (result.length >= 2 && cross5(result.at(-2), result.at(-1), point) <= 0.0000000001)
        result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// ../three-roads-inspect/packages/core/src/topology/junction-surface-geometry.ts
function junctionSurfacesForRoad(junctionSurfaces, roadId) {
  return junctionSurfaces.flatMap((surface) => {
    const sourcePatches = surface.patches ?? [];
    const patches = sourcePatches.filter((patch) => patch.roadIds.includes(roadId));
    if (patches.length > 0)
      return [{ ...surface, patches }];
    return sourcePatches.length === 0 && surface.roadIds.includes(roadId) ? [{ ...surface, patches: [] }] : [];
  });
}
function junctionSurfaceClipPolygons(junctionSurfaces) {
  return junctionSurfaces.flatMap((surface) => {
    const patches = surface.patches ?? [];
    if (patches.length === 0) {
      return [{
        junctionId: surface.junctionId,
        kind: "fallback",
        roadIds: surface.roadIds,
        polygon: surface.polygon
      }];
    }
    return patches.map((patch) => ({
      junctionId: surface.junctionId,
      patchId: patch.id,
      kind: patch.kind,
      roadIds: patch.roadIds,
      polygon: patch.polygon,
      connectionId: patch.connectionId,
      fromLaneId: patch.fromLaneId,
      toLaneId: patch.toLaneId,
      conflictZoneId: patch.conflictZoneId
    }));
  });
}
function junctionSurfacePavementClipPolygons(junctionSurfaces) {
  return junctionSurfaces.flatMap((surface) => {
    const patches = surface.patches ?? [];
    const connectionPatches = patches.filter((patch) => patch.kind === "connection");
    if (connectionPatches.length === 0)
      return junctionSurfaceClipPolygons([surface]);
    return junctionSurfaceClipPolygons([{ ...surface, patches: connectionPatches }]);
  });
}

// ../three-roads-inspect/packages/core/src/topology/path-clipping.ts
var EPSILON7 = 0.0000001;
function clipPathByJunctionSurfaces(points, junctionSurfaces, options = {}) {
  if (points.length < 2)
    return [];
  if (junctionSurfaces.length === 0)
    return [{ points, cutoutJunctionIds: [] }];
  const minSegmentLength = options.minSegmentLength ?? 0.00001;
  const clipPolygons = junctionSurfacePavementClipPolygons(junctionSurfaces);
  const clipped = [];
  let currentPoints = [];
  let currentCutoutIds = new Set;
  const flush = () => {
    if (currentPoints.length >= 2 && polylineLength(currentPoints) >= minSegmentLength) {
      clipped.push({
        points: dedupePoints(currentPoints),
        cutoutJunctionIds: [...currentCutoutIds].sort()
      });
    }
    currentPoints = [];
    currentCutoutIds = new Set;
  };
  for (let i = 1;i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    const cuts = segmentCutParameters(start, end, clipPolygons);
    for (let cutIndex = 1;cutIndex < cuts.length; cutIndex++) {
      const t0 = cuts[cutIndex - 1];
      const t1 = cuts[cutIndex];
      if (t1 - t0 <= EPSILON7)
        continue;
      const intervalStart = interpolate2(start, end, t0);
      const intervalEnd = interpolate2(start, end, t1);
      if (distance4(intervalStart, intervalEnd) < minSegmentLength)
        continue;
      const midpoint = interpolate2(start, end, (t0 + t1) / 2);
      if (clipPolygons.some((clipPolygon) => pointInPolygon(midpoint, clipPolygon.polygon, false))) {
        flush();
        continue;
      }
      const touchingIds = clipPolygons.filter((clipPolygon) => segmentTouchesPolygon(intervalStart, intervalEnd, clipPolygon.polygon)).map((clipPolygon) => clipPolygon.junctionId);
      appendInterval(intervalStart, intervalEnd, touchingIds);
    }
  }
  flush();
  return clipped;
  function appendInterval(start, end, cutoutIds) {
    for (const id of cutoutIds)
      currentCutoutIds.add(id);
    const last = currentPoints.at(-1);
    if (!last) {
      currentPoints.push(start, end);
      return;
    }
    if (samePoint2(last, start)) {
      currentPoints.push(end);
      return;
    }
    flush();
    for (const id of cutoutIds)
      currentCutoutIds.add(id);
    currentPoints.push(start, end);
  }
}
function segmentCutParameters(start, end, clipPolygons) {
  const parameters = [0, 1];
  for (const clipPolygon of clipPolygons) {
    for (let i = 0;i < clipPolygon.polygon.length; i++) {
      const edgeStart = clipPolygon.polygon[i];
      const edgeEnd = clipPolygon.polygon[(i + 1) % clipPolygon.polygon.length];
      const t = segmentIntersectionParameter(start, end, edgeStart, edgeEnd);
      if (t !== undefined)
        parameters.push(t);
    }
  }
  return sortedUniqueParameters(parameters);
}
function segmentTouchesPolygon(start, end, polygon) {
  if (pointInPolygon(start, polygon, true) || pointInPolygon(end, polygon, true))
    return true;
  for (let i = 0;i < polygon.length; i++) {
    const t = segmentIntersectionParameter(start, end, polygon[i], polygon[(i + 1) % polygon.length]);
    if (t !== undefined)
      return true;
  }
  return false;
}
function pointInPolygon(point, polygon, includeBoundary) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1;i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (pointOnSegment(point, a, b))
      return includeBoundary;
    const crosses = a.y > point.y !== b.y > point.y && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
    if (crosses)
      inside = !inside;
  }
  return inside;
}
function segmentIntersectionParameter(a, b, c, d) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denominator = cross7(abx, aby, cdx, cdy);
  if (Math.abs(denominator) <= EPSILON7)
    return;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const t = cross7(acx, acy, cdx, cdy) / denominator;
  const u = cross7(acx, acy, abx, aby) / denominator;
  if (t < -EPSILON7 || t > 1 + EPSILON7 || u < -EPSILON7 || u > 1 + EPSILON7)
    return;
  return Math.min(1, Math.max(0, t));
}
function pointOnSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const crossValue = cross7(dx, dy, point.x - start.x, point.y - start.y);
  if (Math.abs(crossValue) > EPSILON7)
    return false;
  const dot2 = (point.x - start.x) * dx + (point.y - start.y) * dy;
  if (dot2 < -EPSILON7)
    return false;
  const squaredLength = dx * dx + dy * dy;
  return dot2 <= squaredLength + EPSILON7;
}
function sortedUniqueParameters(values) {
  const sorted = values.map((value) => Math.min(1, Math.max(0, value))).sort((a, b) => a - b);
  const unique = [];
  for (const value of sorted) {
    if (unique.length === 0 || Math.abs(value - unique[unique.length - 1]) > EPSILON7)
      unique.push(value);
  }
  return unique;
}
function dedupePoints(points) {
  const result = [];
  for (const point of points) {
    if (!result.at(-1) || !samePoint2(result.at(-1), point))
      result.push(point);
  }
  return result;
}
function polylineLength(points) {
  let length = 0;
  for (let i = 1;i < points.length; i++)
    length += distance4(points[i - 1], points[i]);
  return length;
}
function interpolate2(start, end, t) {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t
  };
}
function samePoint2(a, b) {
  return distance4(a, b) <= EPSILON7;
}
function distance4(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function cross7(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

// ../three-roads-inspect/packages/core/src/topology/junction-surface-fallback-selection.ts
function resolveJunctionFallbackPavement(exactPatches, fallbackPatches, samplingTolerance = 0) {
  if (patchesOwnEveryPortal(exactPatches, fallbackPatches)) {
    const exactComponents = tryUnion(exactPatches);
    if (exactComponents) {
      const repairedComponents = discardSamplingSlivers(exactComponents, samplingTolerance);
      if (exactOwnsEveryPortal(repairedComponents, fallbackPatches, samplingTolerance)) {
        return { components: repairedComponents, activeFallbackPatches: [] };
      }
    }
  }
  const activeFallbackPatches = [...fallbackPatches];
  try {
    return {
      components: unionPolygons([...activeFallbackPatches, ...exactPatches].map((patch) => patch.polygon)),
      activeFallbackPatches
    };
  } catch {
    return {
      components: activeFallbackPatches.map((patch) => ({ outer: patch.polygon, holes: [] })),
      activeFallbackPatches
    };
  }
}
function discardSamplingSlivers(components, samplingTolerance) {
  return components.map((component) => ({
    outer: component.outer,
    holes: component.holes.filter((hole) => ringThickness(hole) > samplingTolerance)
  }));
}
function ringThickness(ring) {
  const perimeter = ringPerimeter(ring);
  if (perimeter <= 0)
    return 0;
  return Math.abs(polygonArea([...ring])) / (perimeter * 0.5);
}
function ringPerimeter(ring) {
  let total = 0;
  for (let index = 0;index < ring.length; index++) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    total += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return total;
}
function patchesOwnEveryPortal(exactPatches, fallbackPatches) {
  return fallbackPatches.every((fallback) => fallback.polygon.every((point) => exactPatches.some((patch) => pointInPolygon(point, patch.polygon, true))));
}
function tryUnion(patches) {
  try {
    return unionPolygons(patches.map((patch) => patch.polygon));
  } catch {
    return;
  }
}
function exactOwnsEveryPortal(exactComponents, fallbackPatches, samplingTolerance) {
  if (exactComponents.length === 0)
    return false;
  if (exactComponents.some((component) => component.holes.length > 0))
    return false;
  if (!componentsFormOneDomain(exactComponents, samplingTolerance))
    return false;
  return fallbackPatches.every((fallback) => fallback.polygon.every((point) => exactComponents.some((component) => pointInPolygon(point, component.outer, true))));
}
function componentsFormOneDomain(components, samplingTolerance) {
  if (components.length === 1)
    return true;
  if (samplingTolerance <= 0)
    return false;
  const group = components.map((_, index) => index);
  const rootOf = (index) => {
    let root = index;
    while (group[root] !== root)
      root = group[root];
    return root;
  };
  for (let left = 0;left < components.length; left++) {
    for (let right = left + 1;right < components.length; right++) {
      const leftRoot = rootOf(left);
      const rightRoot = rootOf(right);
      if (leftRoot === rightRoot)
        continue;
      if (!ringsTouch(components[left].outer, components[right].outer, samplingTolerance))
        continue;
      group[rightRoot] = leftRoot;
    }
  }
  return components.every((_, index) => rootOf(index) === rootOf(0));
}
function ringsTouch(left, right, tolerance) {
  if (!boundsOverlap2(left, right, tolerance))
    return false;
  return left.some((point) => pointToRingDistance(point, right) <= tolerance) || right.some((point) => pointToRingDistance(point, left) <= tolerance);
}
function boundsOverlap2(left, right, tolerance) {
  const leftBounds = ringBounds(left);
  const rightBounds = ringBounds(right);
  return leftBounds.minX - tolerance <= rightBounds.maxX && rightBounds.minX - tolerance <= leftBounds.maxX && leftBounds.minY - tolerance <= rightBounds.maxY && rightBounds.minY - tolerance <= leftBounds.maxY;
}
function ringBounds(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of ring) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}
function pointToRingDistance(point, ring) {
  let nearest = Infinity;
  for (let index = 0;index < ring.length; index++) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    nearest = Math.min(nearest, pointToSegmentDistance4(point, start, end));
    if (nearest === 0)
      return 0;
  }
  return nearest;
}
function pointToSegmentDistance4(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.00000000000001)
    return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
}

// ../three-roads-inspect/packages/core/src/topology/junction-topology-tessellation.ts
function tessellateJunctionPhysicalTopology(network, physicalTopology, options = {}) {
  const step = options.step ?? 2;
  const minArea = options.minArea ?? 0.01;
  const junctionIds = options.junctionIds ? new Set(options.junctionIds) : undefined;
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const bands = new Map(physicalTopology.corridors.flatMap((corridor) => corridor.sections.flatMap((section) => section.bands.map((band) => [band.id, band]))));
  const junctions = physicalTopology.junctions.filter((junction) => !junctionIds || junctionIds.has(junction.junctionId));
  const movementSurfaces = junctions.flatMap((junction) => [
    ...junction.movements.flatMap((movement) => tessellateConnectorParticipant(roads, bands, junction.junctionId, movement, "maneuver", step, minArea, options.bandSamples)),
    ...junction.laneContinuations.flatMap((continuation) => tessellateConnectorParticipant(roads, bands, junction.junctionId, continuation, "lane-continuation", step, minArea, options.bandSamples))
  ]);
  const junctionSurfaces = junctions.flatMap((junction) => {
    const movementPatches = movementSurfacePatches(junction, movementSurfaces);
    const perimeterPatches = junctionPerimeterSurfaces(network, movementSurfaces.filter((surface) => surface.junctionId === junction.junctionId), step, minArea).map((polygon, index) => ({
      id: `perimeter-interior|${junction.junctionId}|${index}`,
      kind: "connection",
      roadIds: junction.roadIds,
      polygon,
      laneType: "driving"
    }));
    const outerPerimeterPatches = junctionOuterPerimeterSurfaces(network, movementSurfaces.filter((surface) => surface.junctionId === junction.junctionId), step, minArea).map((polygon, index) => ({
      id: `perimeter-outer|${junction.junctionId}|${index}`,
      kind: "connection",
      roadIds: junction.roadIds,
      polygon
    }));
    const authoredPatches = authoredSurfacePatches(junction, minArea);
    const fallbackPatches = surfaceFallbackPatches(network, junction, minArea);
    const hasDirectPerimeter = directAutomaticPerimeterComponents(junction, perimeterPatches, outerPerimeterPatches) !== undefined;
    const overlapPatches = !hasDirectPerimeter && (junction.surfacePolicy === "overlap" || junction.surfacePolicy === "connector-bands") ? crossingOverlapPatches(roads, junction, step, minArea) : [];
    const conflictPatches = conflictSurfacePatches(network, junction, minArea);
    const coveragePatches = [
      ...authoredPatches,
      ...perimeterPatches,
      ...overlapPatches
    ];
    const visibleMovementPatches = movementPatches.filter((movement) => !materialPolygonCovered(movement, coveragePatches));
    const fallbackPavement = junction.surfacePolicy === "surface-fallback" ? resolveJunctionFallbackPavement([...visibleMovementPatches, ...perimeterPatches], fallbackPatches, connectorSamplingTolerance(step)) : undefined;
    const pavement = junction.surfacePolicy === "authored" ? [...authoredPatches, ...visibleMovementPatches, ...perimeterPatches] : junction.surfacePolicy === "connector-bands" ? [...visibleMovementPatches, ...perimeterPatches, ...overlapPatches] : junction.surfacePolicy === "surface-fallback" ? [] : junction.surfacePolicy === "overlap" ? overlapPatches : [];
    const components = fallbackPavement?.components ?? (hasDirectPerimeter ? [{ outer: outerPerimeterPatches[0].polygon, holes: [] }] : undefined) ?? unionJunctionPavement(junction, pavement, fallbackPatches);
    if (components.length === 0)
      return [];
    const largest = [...components].sort((left, right) => componentArea(right) - componentArea(left))[0];
    return [{
      junctionId: junction.junctionId,
      roadIds: junction.roadIds,
      patches: [
        ...authoredPatches,
        ...fallbackPavement?.activeFallbackPatches ?? fallbackPatches,
        ...movementPatches,
        ...perimeterPatches,
        ...outerPerimeterPatches,
        ...overlapPatches,
        ...conflictPatches
      ],
      components,
      polygon: largest.outer
    }];
  });
  const assemblySurfaces = junctionSurfaces.flatMap((surface) => {
    const topology = physicalTopology.junctions.find((junction) => junction.junctionId === surface.junctionId);
    if (!topology)
      return [];
    return [junctionAssembly(network, topology, surface, movementSurfaces, minArea)];
  });
  return { junctionSurfaces, movementSurfaces, assemblySurfaces };
}
function connectorSamplingTolerance(step) {
  return step / 8;
}
function directAutomaticPerimeterComponents(junction, interior, outer) {
  if (!junction.junctionId.startsWith("auto-junction|") || junction.surfacePolicy !== "connector-bands" || interior.length !== 1 || outer.length !== 1)
    return;
  return [{ outer: outer[0].polygon, holes: [] }];
}
function unionJunctionPavement(junction, pavement, fallbackPatches) {
  try {
    return unionPolygons(pavement.map((patch) => patch.polygon));
  } catch (error11) {
    if (junction.surfacePolicy !== "surface-fallback")
      throw error11;
    return fallbackPatches.map((patch) => ({ outer: patch.polygon, holes: [] }));
  }
}
function surfaceFallbackPatches(network, junction, minArea) {
  if (junction.surfacePolicy !== "surface-fallback")
    return [];
  const polygon = junctionSurfaceFallbackPolygon(network, junction.junctionId, minArea);
  if (!polygon)
    return [];
  return [{
    id: `surface-fallback|${junction.junctionId}`,
    kind: "connection",
    roadIds: junction.roadIds,
    polygon,
    laneType: "driving"
  }];
}
function authoredSurfacePatches(junction, minArea) {
  const sources = [
    ...junction.surfacePolygon ? [{
      id: `authored|${junction.junctionId}`,
      polygon: junction.surfacePolygon,
      laneType: junction.surfaceLaneType
    }] : [],
    ...(junction.surfacePatches ?? []).map((patch) => ({
      id: `authored|${junction.junctionId}|${patch.id}`,
      polygon: patch.polygon,
      laneType: patch.laneType
    }))
  ];
  return sources.flatMap((source) => {
    const polygon = normalizedPolygon(source.polygon);
    if (polygon.length < 3 || Math.abs(polygonArea(polygon)) < minArea)
      return [];
    return [{
      id: source.id,
      kind: "authored",
      roadIds: junction.roadIds,
      polygon,
      laneType: source.laneType
    }];
  });
}
function tessellateConnectorParticipant(roads, bands, junctionId, participant, surfaceKind, step, minArea, bandSamples) {
  return participant.connectorBandIds.flatMap((bandId, index) => {
    const band = bands.get(bandId);
    if (!band)
      throw new Error(`Physical connector participant ${participant.id} references missing band ${bandId}`);
    const resolved = resolveBand(roads, band);
    const cached = bandSamples?.get(bandId);
    const polygon = cached?.polygon ?? sampleLanePolygon(resolved.road, resolved.section, resolved.lane.id, band.sStart, band.sEnd, step);
    if (Math.abs(polygonArea(polygon)) < minArea)
      return [];
    const first = index === 0;
    const last = index === participant.connectorBandIds.length - 1;
    return [{
      id: participant.connectorBandIds.length === 1 ? participant.id : `${participant.id}|segment:${index}`,
      junctionId,
      surfaceKind,
      connectionId: participant.connectionId,
      sourceManeuverId: "sourceManeuverId" in participant ? participant.sourceManeuverId : undefined,
      sourceLaneContinuationId: "sourceLaneContinuationId" in participant ? participant.sourceLaneContinuationId : undefined,
      connectorRoadId: participant.connectorRoadId,
      connectorSectionId: resolved.section.id,
      connectorLaneId: resolved.lane.id,
      from: first ? contactEndpoint(roads, participant.from) : bandEndpoint(resolved, band.sStart),
      to: last ? contactEndpoint(roads, participant.to) : bandEndpoint(resolved, band.sEnd),
      laneType: resolved.lane.type,
      ...resolved.lane.surface !== undefined ? { surface: resolved.lane.surface } : {},
      centerline: cached?.centerline ?? sampleLaneCenterline(resolved.road, resolved.section, resolved.lane.id, band.sStart, band.sEnd, step),
      polygon: normalizedPolygon(polygon),
      widthStart: laneWidthAt(resolved.lane, band.sStart - resolved.section.s),
      widthEnd: laneWidthAt(resolved.lane, band.sEnd - resolved.section.s)
    }];
  });
}
function crossingOverlapPatches(roads, junction, step, minArea) {
  const pairs = new Map;
  for (const link of junction.directLaneLinks) {
    if (link.from.roadId === link.to.roadId)
      continue;
    const roadIds = [link.from.roadId, link.to.roadId].sort();
    const key = roadIds.join("|");
    if (!pairs.has(key))
      pairs.set(key, { roadIds, connectionId: link.connectionId });
  }
  if (pairs.size === 0) {
    const roadIds = junction.roadIds.filter((roadId) => requiredRoad3(roads, roadId).kind !== "connector");
    for (let left = 0;left < roadIds.length; left++) {
      for (let right = left + 1;right < roadIds.length; right++) {
        const pair = [roadIds[left], roadIds[right]].sort();
        pairs.set(pair.join("|"), { roadIds: pair });
      }
    }
  }
  return [...pairs.values()].flatMap(({ roadIds, connectionId }) => {
    const left = sampleRoadEnvelope(requiredRoad3(roads, roadIds[0]), step).points;
    const right = sampleRoadEnvelope(requiredRoad3(roads, roadIds[1]), step).points;
    return intersectPolygons(left, [right]).flatMap((component, index) => {
      if (componentArea(component) < minArea)
        return [];
      return [{
        id: `overlap|${junction.junctionId}|${roadIds.join("|")}|${index}`,
        kind: "connection",
        roadIds,
        polygon: component.outer,
        holes: component.holes,
        connectionId,
        laneType: "driving"
      }];
    });
  });
}
function movementSurfacePatches(junction, movements) {
  return movements.filter((surface) => surface.junctionId === junction.junctionId).map((surface) => ({
    id: `movement-band|${surface.id}`,
    kind: "connection",
    roadIds: uniqueStrings([surface.from.roadId, surface.connectorRoadId, surface.to.roadId]),
    polygon: surface.polygon,
    connectionId: surface.connectionId,
    fromLaneId: surface.from.laneId,
    toLaneId: surface.to.laneId,
    laneType: surface.laneType,
    ...surface.surface !== undefined ? { surface: surface.surface } : {}
  }));
}
function conflictSurfacePatches(network, junction, minArea) {
  const source = network.junctions.find((candidate) => candidate.id === junction.junctionId);
  const ownedIds = new Set(junction.conflictZoneIds);
  return (source?.conflictZones ?? []).flatMap((zone) => {
    if (!ownedIds.has(zone.id) || Math.abs(polygonArea(zone.polygon)) < minArea)
      return [];
    return [{
      id: `conflict|${zone.id}`,
      kind: "conflict",
      roadIds: [...zone.roadIds].sort(),
      polygon: normalizedPolygon(zone.polygon),
      conflictZoneId: zone.id
    }];
  });
}
function junctionAssembly(network, topology, surface, allMovements, minArea) {
  const movements = allMovements.filter((movement) => movement.junctionId === topology.junctionId);
  const lanePatches = movements.map((movement) => ({
    roadId: movement.connectorRoadId,
    sectionId: movement.connectorSectionId,
    laneId: movement.connectorLaneId,
    laneType: movement.laneType,
    ...movement.surface !== undefined ? { surface: movement.surface } : {},
    surfacePatchId: `movement-band|${movement.id}`,
    polygon: movement.polygon
  }));
  const holes = topology.holeObjectIds.flatMap((objectId) => {
    const hole = junctionHole(network, objectId);
    return hole && Math.abs(polygonArea(hole.polygon)) >= minArea ? [hole] : [];
  });
  const components = holes.length === 0 ? surface.components : surface.components.flatMap((component) => subtractPolygons(component.outer, [...component.holes, ...holes.map((hole) => hole.polygon)]));
  const largest = [...components].sort((left, right) => componentArea(right) - componentArea(left))[0];
  const surfaceParts = movements.map((movement) => ({
    id: `movement|${movement.id}`,
    kind: movement.surfaceKind === "maneuver" ? "movement" : "lane-continuation",
    laneType: movement.laneType,
    ...movement.surface !== undefined ? { surface: movement.surface } : {},
    polygon: movement.polygon,
    holes: holes.filter((hole) => polygonsOverlapByCentroid(hole.polygon, movement.polygon)),
    roadId: movement.connectorRoadId,
    sectionId: movement.connectorSectionId,
    laneId: movement.connectorLaneId,
    surfacePatchId: `movement-band|${movement.id}`,
    movementId: movement.id
  }));
  const materialMovements = movements.filter((movement) => !materialPolygonCovered(movement, surface.patches.filter((patch) => !patch.id.startsWith("movement-band|") && patch.kind !== "conflict")));
  const laneTypeSurfaces = directAutomaticPerimeterMaterials(topology, materialMovements, surface.patches, holes) ?? junctionLaneTypeSurfaces(materialMovements, surface.patches, holes, components);
  return {
    junctionId: topology.junctionId,
    components,
    outer: largest?.outer ?? surface.polygon,
    holes,
    surfaceParts,
    laneTypeSurfaces,
    lanePatches,
    movementSurfaces: movements,
    boundaryEdges: assemblyBoundaryEdges(topology.junctionId, components, movements, holes),
    fallbackSurface: surface
  };
}
function directAutomaticPerimeterMaterials(topology, movements, patches, holes) {
  if (!topology.junctionId.startsWith("auto-junction|") || holes.length > 0) {
    return;
  }
  const interior = patches.filter((patch) => patch.id.startsWith("perimeter-interior|"));
  const outer = patches.filter((patch) => patch.id.startsWith("perimeter-outer|"));
  if (interior.length !== 1 || outer.length !== 1) {
    return;
  }
  const groups = new Map;
  groups.set("driving\x00", {
    laneType: "driving",
    components: [{ outer: interior[0].polygon, holes: [] }]
  });
  for (const movement of movements) {
    if (movement.laneType === "driving")
      continue;
    const key = `${movement.laneType}\x00${movement.surface ?? ""}`;
    const group = groups.get(key) ?? {
      laneType: movement.laneType,
      ...movement.surface !== undefined ? { surface: movement.surface } : {},
      components: []
    };
    group.components.push({ outer: movement.polygon, holes: [] });
    groups.set(key, group);
  }
  return [...groups.values()];
}
function materialPolygonCovered(candidate, covers) {
  if (!candidate.laneType)
    return false;
  return covers.some((cover) => cover.laneType === candidate.laneType && cover.surface === candidate.surface && isConvexPolygon(cover.polygon) && candidate.polygon.every((point) => pointInPolygon(point, cover.polygon, true)));
}
function isConvexPolygon(polygon) {
  let orientation = 0;
  for (let index = 0;index < polygon.length; index++) {
    const previous = polygon[index];
    const current = polygon[(index + 1) % polygon.length];
    const next = polygon[(index + 2) % polygon.length];
    const cross5 = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    if (Math.abs(cross5) <= 0.00000001)
      continue;
    const sign = Math.sign(cross5);
    if (orientation !== 0 && sign !== orientation)
      return false;
    orientation = sign;
  }
  return orientation !== 0;
}
function junctionLaneTypeSurfaces(surfaces, patches, holes, assemblyComponents) {
  return partitionJunctionSurfaceMaterials(surfaces, patches, holes, assemblyComponents);
}
function assemblyBoundaryEdges(junctionId, components, movements, holes) {
  return [
    ...components.flatMap((component, index) => [
      { id: `outer|${junctionId}|${index}`, kind: "outer", points: component.outer },
      ...component.holes.map((hole, holeIndex) => ({
        id: `component-hole|${junctionId}|${index}|${holeIndex}`,
        kind: "hole",
        points: hole
      }))
    ]),
    ...movements.map((movement) => ({
      id: `movement|${movement.id}`,
      kind: "movement",
      movementId: movement.id,
      roadId: movement.connectorRoadId,
      laneId: movement.connectorLaneId,
      points: movement.polygon
    })),
    ...holes.map((hole) => ({
      id: `hole|${junctionId}|${hole.roadId}|${hole.id}`,
      kind: "hole",
      roadId: hole.roadId,
      objectId: hole.id,
      points: hole.polygon
    }))
  ];
}
function contactEndpoint(roads, contact) {
  const road = requiredRoad3(roads, contact.roadId);
  const section = requiredSection(road, contact.sectionId);
  return laneEndpoint(road, section, contact.laneId, contact.s);
}
function bandEndpoint(resolved, s) {
  return laneEndpoint(resolved.road, resolved.section, resolved.lane.id, s);
}
function laneEndpoint(road, section, laneId2, s) {
  const lane = section.lanes.find((candidate) => candidate.id === laneId2);
  if (!lane)
    throw new Error(`Physical topology references missing lane ${road.id}/${section.id}/${laneId2}`);
  const point = laneSurfacePointAt(road, section, lane, s, laneCenterOffsetAt(section, laneId2, s - section.s));
  return { roadId: road.id, sectionId: section.id, laneId: laneId2, s, point: { x: point.x, y: point.y } };
}
function resolveBand(roads, band) {
  const road = requiredRoad3(roads, band.roadId);
  const section = requiredSection(road, band.sectionId);
  const lane = section.lanes.find((candidate) => candidate.id === band.laneId);
  if (!lane)
    throw new Error(`Physical band ${band.id} references missing lane ${band.laneId}`);
  return { road, section, lane };
}
function requiredRoad3(roads, roadId) {
  const road = roads.get(roadId);
  if (!road)
    throw new Error(`Physical topology references missing road ${roadId}`);
  return road;
}
function requiredSection(road, sectionId) {
  const section = road.laneSections.find((candidate) => candidate.id === sectionId);
  if (!section)
    throw new Error(`Physical topology references missing section ${road.id}/${sectionId}`);
  return section;
}
function junctionHole(network, objectId) {
  const worldObject = (network.objects ?? []).find((object) => object.id === objectId);
  if (worldObject?.polygon) {
    return {
      id: worldObject.id,
      roadId: worldObject.junctionId ? `junction:${worldObject.junctionId}` : "network",
      objectKind: worldObject.kind,
      polygon: normalizedPolygon(worldObject.polygon)
    };
  }
  for (const road of network.roads) {
    const object = (road.objects ?? []).find((candidate) => candidate.id === objectId);
    if (!object)
      continue;
    const polygon = object.polygon ?? objectFootprint(road, object);
    if (!polygon)
      return;
    return { id: object.id, roadId: road.id, objectKind: object.kind, polygon: normalizedPolygon(polygon) };
  }
  return;
}
function objectFootprint(road, object) {
  if (!object.length || !object.width)
    return;
  const length = object.length;
  const width = object.width;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([along, across]) => {
    const point = roadToWorld(road, object.s + length / 2 * along, object.t + width / 2 * across, object.height ?? 0);
    return { x: point.x, y: point.y };
  });
}
function polygonsOverlapByCentroid(left, right) {
  const center = left.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  center.x /= left.length;
  center.y /= left.length;
  let inside = false;
  for (let current = 0, previous = right.length - 1;current < right.length; previous = current++) {
    const a = right[current];
    const b = right[previous];
    if (a.y > center.y !== b.y > center.y && center.x < (b.x - a.x) * (center.y - a.y) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}
function componentArea(component) {
  return Math.abs(polygonArea(component.outer)) - component.holes.reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0);
}
function uniqueStrings(values) {
  return [...new Set(values)].sort();
}

// ../three-roads-inspect/packages/core/src/validation/physical-topology-validation.ts
var POSITION_TOLERANCE2 = 0.00001;
function validateRoadPhysicalTopology(network, topology, options = {}) {
  const diagnostics = [];
  const bandIds = new Set;
  const boundaryIds = new Set;
  const corridorRoadIds = new Set(topology.corridors.map((corridor) => corridor.roadId));
  const semanticJunctions = new Map(network.junctions.map((junction) => [junction.id, junction]));
  const bandById = new Map(topology.corridors.flatMap((corridor) => corridor.sections.flatMap((section) => section.bands.map((band) => [band.id, band]))));
  for (const road of network.roads) {
    if (!corridorRoadIds.has(road.id)) {
      diagnostics.push(error11("physical-corridor-missing", `Road ${road.id} has no physical corridor`, { roadId: road.id }));
    }
  }
  for (const corridor of topology.corridors) {
    for (const section of corridor.sections) {
      validateSection(corridor.roadId, section, bandIds, boundaryIds, diagnostics);
    }
    for (const contact of corridor.contacts) {
      const upstream = corridor.sections.find((section) => section.sectionId === contact.upstreamSectionId);
      const downstream = corridor.sections.find((section) => section.sectionId === contact.downstreamSectionId);
      validateSectionContact(contact, upstream?.boundaries.map((boundary) => boundary.id) ?? [], downstream?.boundaries.map((boundary) => boundary.id) ?? [], diagnostics);
    }
  }
  const claims = new Map;
  for (const junction of topology.junctions) {
    const semanticJunction = semanticJunctions.get(junction.junctionId);
    if (!semanticJunction) {
      diagnostics.push(error11("physical-junction-missing", `Physical junction ${junction.junctionId} has no semantic junction`, { junctionId: junction.junctionId }));
    }
    if (junction.junctionKind === "crossing" && junction.surfacePolicy !== "overlap") {
      diagnostics.push(error11("physical-crossing-surface-policy", `Crossing junction ${junction.junctionId} must own its overlap surface`, { junctionId: junction.junctionId }));
    }
    if (junction.junctionKind === "virtual" && (!junction.virtualRange || junction.surfacePolicy !== "overlap")) {
      diagnostics.push(error11("physical-virtual-junction-policy", `Virtual junction ${junction.junctionId} needs a main-road range and overlap ownership`, { junctionId: junction.junctionId }));
    }
    for (const link of junction.directLaneLinks) {
      for (const contact of [link.from, link.to]) {
        if (bandById.has(contact.bandId))
          continue;
        diagnostics.push(error11("physical-direct-link-contact-band-missing", `Direct lane link ${link.id} references missing contact band ${contact.bandId}`, { roadId: contact.roadId, junctionId: junction.junctionId, sectionId: contact.sectionId, laneId: contact.laneId }));
      }
      validateDirectLaneLinkGeometry(network, link, diagnostics, semanticJunction?.connectorGeometryPolicy === "surface-fallback");
    }
    for (const movement of junction.movements) {
      for (const contact of [movement.from, movement.to]) {
        if (!bandById.has(contact.bandId)) {
          diagnostics.push(error11("physical-movement-contact-band-missing", `Movement ${movement.id} references missing contact band ${contact.bandId}`, { roadId: contact.roadId, junctionId: junction.junctionId, sectionId: contact.sectionId, laneId: contact.laneId }));
        }
      }
      for (const connectorBandId of movement.connectorBandIds) {
        const band = bandById.get(connectorBandId);
        if (!band) {
          diagnostics.push(error11("physical-movement-band-missing", `Movement ${movement.id} references missing connector band ${connectorBandId}`, { junctionId: junction.junctionId }));
          continue;
        }
        if (band.surfaceOwner.kind !== "junction" || band.surfaceOwner.id !== junction.junctionId) {
          diagnostics.push(error11("physical-movement-band-owner", `Movement ${movement.id} uses band ${connectorBandId} owned by ${band.surfaceOwner.kind}:${band.surfaceOwner.id}`, { roadId: band.roadId, junctionId: junction.junctionId, sectionId: band.sectionId, laneId: band.laneId }));
        }
        const owners = claims.get(connectorBandId) ?? [];
        owners.push(movement.id);
        claims.set(connectorBandId, owners);
      }
    }
    for (const continuation of junction.laneContinuations) {
      for (const contact of [continuation.from, continuation.to]) {
        if (!bandById.has(contact.bandId)) {
          diagnostics.push(error11("physical-continuation-contact-band-missing", `Lane continuation ${continuation.id} references missing contact band ${contact.bandId}`, { roadId: contact.roadId, junctionId: junction.junctionId, sectionId: contact.sectionId, laneId: contact.laneId }));
        }
      }
      for (const connectorBandId of continuation.connectorBandIds) {
        const band = bandById.get(connectorBandId);
        if (!band) {
          diagnostics.push(error11("physical-continuation-band-missing", `Lane continuation ${continuation.id} references missing connector band ${connectorBandId}`, { junctionId: junction.junctionId }));
          continue;
        }
        if (band.surfaceOwner.kind !== "junction" || band.surfaceOwner.id !== junction.junctionId) {
          diagnostics.push(error11("physical-continuation-band-owner", `Lane continuation ${continuation.id} uses band ${connectorBandId} owned by ${band.surfaceOwner.kind}:${band.surfaceOwner.id}`, { roadId: band.roadId, junctionId: junction.junctionId, sectionId: band.sectionId, laneId: band.laneId }));
        }
        if (!isPhysicalLaneContinuationType(band.laneType)) {
          diagnostics.push(error11("physical-continuation-lane-type", `Lane continuation ${continuation.id} band ${connectorBandId} uses participant lane type ${band.laneType}`, { roadId: band.roadId, junctionId: junction.junctionId, sectionId: band.sectionId, laneId: band.laneId }));
        }
        if (band.direction !== "both" && band.direction !== "standard") {
          diagnostics.push(error11("physical-continuation-direction", `Lane continuation ${continuation.id} band ${connectorBandId} has no physical direction`, { roadId: band.roadId, junctionId: junction.junctionId, sectionId: band.sectionId, laneId: band.laneId }));
        }
        claims.set(connectorBandId, [...claims.get(connectorBandId) ?? [], continuation.id]);
      }
    }
    for (const stream of junction.trafficStreams) {
      if (!bandById.has(stream.bandId)) {
        diagnostics.push(error11("physical-stream-band-missing", `Traffic stream ${stream.id} references missing band ${stream.bandId}`, { roadId: stream.roadId, junctionId: junction.junctionId, sectionId: stream.sectionId, laneId: stream.laneId }));
      }
    }
    if (semanticJunction && options.trafficInteractions !== false) {
      validateMovementInteractions2(semanticJunction, junction, diagnostics);
      validateStreamInteractions(semanticJunction, junction, diagnostics);
    }
  }
  for (const band of bandById.values()) {
    if (band.surfaceOwner.kind !== "junction")
      continue;
    const owners = claims.get(band.id) ?? [];
    if (owners.length === 0) {
      diagnostics.push(error11("physical-junction-band-unclaimed", `Junction-owned band ${band.id} has no physical movement owner`, { roadId: band.roadId, junctionId: band.surfaceOwner.id, sectionId: band.sectionId, laneId: band.laneId }));
    } else if (owners.length > 1) {
      diagnostics.push(error11("physical-junction-band-multiply-claimed", `Junction-owned band ${band.id} is claimed by ${owners.join(", ")}`, { roadId: band.roadId, junctionId: band.surfaceOwner.id, sectionId: band.sectionId, laneId: band.laneId }));
    }
  }
  const semanticStructures = new Map((network.roadStructures ?? []).map((structure) => [structure.id, structure]));
  const physicalStructureIds = new Set;
  for (const structure of topology.roadStructures) {
    const semantic = semanticStructures.get(structure.id);
    if (physicalStructureIds.has(structure.id)) {
      diagnostics.push(error11("physical-road-structure-duplicate", `Physical road structure ${structure.id} is duplicated`, { roadId: structure.roadId }));
    } else if (!semantic) {
      diagnostics.push(error11("physical-road-structure-semantic-missing", `Physical road structure ${structure.id} has no semantic structure`, { roadId: structure.roadId }));
    } else if (JSON.stringify(structure) !== JSON.stringify(semantic)) {
      diagnostics.push(error11("physical-road-structure-mismatch", `Physical road structure ${structure.id} differs from its semantic structure`, { roadId: structure.roadId }));
    }
    physicalStructureIds.add(structure.id);
  }
  for (const structure of semanticStructures.values()) {
    if (!physicalStructureIds.has(structure.id)) {
      diagnostics.push(error11("physical-road-structure-missing", `Road structure ${structure.id} has no physical structure`, { roadId: structure.roadId }));
    }
  }
  const semanticRoadsideFeatures = new Map((network.roadsideFeatures ?? []).map((feature) => [feature.id, feature]));
  const physicalRoadsideFeatureIds = new Set;
  for (const feature of topology.roadsideFeatures ?? []) {
    const semantic = semanticRoadsideFeatures.get(feature.id);
    if (physicalRoadsideFeatureIds.has(feature.id)) {
      diagnostics.push(error11("physical-roadside-feature-duplicate", `Physical roadside feature ${feature.id} is duplicated`, { roadId: feature.roadId }));
    } else if (!semantic) {
      diagnostics.push(error11("physical-roadside-feature-semantic-missing", `Physical roadside feature ${feature.id} has no semantic feature`, { roadId: feature.roadId }));
    } else if (JSON.stringify(feature) !== JSON.stringify(semantic)) {
      diagnostics.push(error11("physical-roadside-feature-mismatch", `Physical roadside feature ${feature.id} differs from its semantic feature`, { roadId: feature.roadId }));
    }
    physicalRoadsideFeatureIds.add(feature.id);
  }
  for (const feature of semanticRoadsideFeatures.values()) {
    if (!physicalRoadsideFeatureIds.has(feature.id)) {
      diagnostics.push(error11("physical-roadside-feature-missing", `Roadside feature ${feature.id} has no physical feature`, { roadId: feature.roadId }));
    }
  }
  const semanticGradeSeparations = new Map((network.gradeSeparations ?? []).map((relation) => [relation.id, relation]));
  const physicalGradeSeparationIds = new Set;
  for (const relation of topology.gradeSeparations) {
    const semantic = semanticGradeSeparations.get(relation.id);
    if (physicalGradeSeparationIds.has(relation.id)) {
      diagnostics.push(error11("physical-grade-separation-duplicate", `Physical grade separation ${relation.id} is duplicated`, { roadId: relation.upperRoad.roadId }));
    } else if (!semantic) {
      diagnostics.push(error11("physical-grade-separation-semantic-missing", `Physical grade separation ${relation.id} has no semantic relation`, { roadId: relation.upperRoad.roadId }));
    } else if (JSON.stringify(relation) !== JSON.stringify(semantic)) {
      diagnostics.push(error11("physical-grade-separation-mismatch", `Physical grade separation ${relation.id} differs from its semantic relation`, { roadId: relation.upperRoad.roadId }));
    }
    physicalGradeSeparationIds.add(relation.id);
  }
  for (const relation of semanticGradeSeparations.values()) {
    if (!physicalGradeSeparationIds.has(relation.id)) {
      diagnostics.push(error11("physical-grade-separation-missing", `Grade separation ${relation.id} has no physical relation`, { roadId: relation.upperRoad.roadId }));
    }
  }
  for (const weaving of topology.weavingSections) {
    for (const pair of weaving.lanePairs) {
      const through = bandById.get(pair.throughBandId);
      const auxiliary = bandById.get(pair.weavingBandId);
      if (!through || !auxiliary) {
        diagnostics.push(error11("physical-weaving-band-missing", `Weaving section ${weaving.id} has a missing physical band`, {
          roadId: weaving.roadId,
          sectionId: pair.sectionId
        }));
      } else if (through.surfaceOwner.kind !== "road" || auxiliary.surfaceOwner.kind !== "road" || through.surfaceOwner.id !== weaving.roadId || auxiliary.surfaceOwner.id !== weaving.roadId) {
        diagnostics.push(error11("physical-weaving-band-owner", `Weaving section ${weaving.id} does not use road-owned bands`, {
          roadId: weaving.roadId,
          sectionId: pair.sectionId
        }));
      } else {
        const corridor = topology.corridors.find((candidate) => candidate.roadId === weaving.roadId);
        const section = corridor?.sections.find((candidate) => candidate.sectionId === pair.sectionId);
        if (!section?.boundaries.some((boundary) => boundary.id === pair.sharedBoundaryId)) {
          diagnostics.push(error11("physical-weaving-boundary-missing", `Weaving section ${weaving.id} has no shared physical boundary`, {
            roadId: weaving.roadId,
            sectionId: pair.sectionId
          }));
        }
      }
    }
  }
  if (options.junctionSurfaceOwnership !== false) {
    validateJunctionSurfaceOwnership(network, topology, diagnostics);
  }
  return { ok: diagnostics.every(({ severity }) => severity !== "error"), diagnostics };
}
function validateStreamInteractions(semanticJunction, junction, diagnostics) {
  const topologyBySource = new Map(junction.trafficStreams.map((stream) => [stream.sourceStreamId, stream]));
  const semanticById = new Map((semanticJunction.streamInteractions ?? []).map((interaction) => [`physical-${interaction.id}`, interaction]));
  const interactionPairKeys = new Set;
  const conflictClaims = new Map;
  for (const interaction of junction.streamInteractions) {
    const semantic = semanticById.get(interaction.id);
    const pairKey = [...interaction.sourceStreamIds].sort().join("\x00");
    if (interactionPairKeys.has(pairKey)) {
      diagnostics.push(error11("physical-duplicate-stream-interaction-pair", `Junction ${junction.junctionId} repeats physical stream pair`, { junctionId: junction.junctionId }));
    }
    interactionPairKeys.add(pairKey);
    const expectedTopologyIds = interaction.sourceStreamIds.map((streamId) => topologyBySource.get(streamId)?.id ?? "");
    if (expectedTopologyIds.some((id) => !id) || expectedTopologyIds.join("\x00") !== interaction.streamTopologyIds.join("\x00")) {
      diagnostics.push(error11("physical-stream-interaction-coverage", `Interaction ${interaction.id} does not resolve both source streams`, { junctionId: junction.junctionId }));
    }
    if (!semantic || JSON.stringify(semantic.control) !== JSON.stringify(interaction.control)) {
      diagnostics.push(error11("physical-stream-interaction-control", `Interaction ${interaction.id} does not preserve semantic stream control`, { junctionId: junction.junctionId }));
    }
    if (interaction.prioritySourceStreamId && !interaction.sourceStreamIds.includes(interaction.prioritySourceStreamId)) {
      diagnostics.push(error11("physical-stream-interaction-priority", `Interaction ${interaction.id} priority is outside its stream pair`, { junctionId: junction.junctionId }));
    }
    for (const zoneId of interaction.conflictZoneIds) {
      conflictClaims.set(zoneId, (conflictClaims.get(zoneId) ?? 0) + 1);
    }
  }
  const sourceIds = [...topologyBySource.keys()].sort();
  for (let leftIndex = 0;leftIndex < sourceIds.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1;rightIndex < sourceIds.length; rightIndex++) {
      const pairKey = [sourceIds[leftIndex], sourceIds[rightIndex]].join("\x00");
      if (!interactionPairKeys.has(pairKey)) {
        diagnostics.push(error11("physical-stream-interaction-pair-missing", `Junction ${junction.junctionId} has no physical interaction for ${sourceIds[leftIndex]}/${sourceIds[rightIndex]}`, { junctionId: junction.junctionId }));
      }
    }
  }
  for (const zone of semanticJunction.conflictZones ?? []) {
    if (!zone.streamIds || conflictClaims.get(zone.id) === 1)
      continue;
    diagnostics.push(error11("physical-stream-conflict-owner", `Conflict zone ${zone.id} must have one physical stream owner`, { junctionId: junction.junctionId }));
  }
}
function validateMovementInteractions2(semanticJunction, junction, diagnostics) {
  const movementIds = new Set(junction.movements.map((movement) => movement.id));
  const movementIdsBySource = new Map;
  for (const movement of junction.movements) {
    movementIdsBySource.set(movement.sourceManeuverId, [
      ...movementIdsBySource.get(movement.sourceManeuverId) ?? [],
      movement.id
    ]);
  }
  const semanticConflictIds = new Set((semanticJunction.conflictZones ?? []).map((zone) => zone.id));
  const conflictClaims = new Map;
  const interactionIds = new Set;
  const interactionPairKeys = new Set;
  for (const interaction of junction.movementInteractions) {
    const semanticInteraction = (semanticJunction.movementInteractions ?? []).find((candidate) => `physical-${candidate.id}` === interaction.id);
    if (interactionIds.has(interaction.id)) {
      diagnostics.push(error11("physical-duplicate-interaction-id", `Junction ${junction.junctionId} repeats physical interaction ${interaction.id}`, { junctionId: junction.junctionId }));
    }
    interactionIds.add(interaction.id);
    const pairKey = [...interaction.sourceManeuverIds].sort().join("\x00");
    if (interactionPairKeys.has(pairKey)) {
      diagnostics.push(error11("physical-duplicate-interaction-pair", `Junction ${junction.junctionId} repeats physical interaction pair`, { junctionId: junction.junctionId }));
    }
    interactionPairKeys.add(pairKey);
    if (!semanticInteraction || JSON.stringify(semanticInteraction.control) !== JSON.stringify(interaction.control)) {
      diagnostics.push(error11("physical-interaction-control-mismatch", `Interaction ${interaction.id} does not preserve its semantic control`, { junctionId: junction.junctionId }));
    }
    for (const sourceManeuverId of interaction.sourceManeuverIds) {
      if ((movementIdsBySource.get(sourceManeuverId) ?? []).length > 0)
        continue;
      diagnostics.push(error11("physical-interaction-source-movement-missing", `Interaction ${interaction.id} cannot resolve source maneuver ${sourceManeuverId}`, { junctionId: junction.junctionId }));
    }
    for (const movementTopologyId of interaction.movementTopologyIds) {
      if (movementIds.has(movementTopologyId))
        continue;
      diagnostics.push(error11("physical-interaction-movement-missing", `Interaction ${interaction.id} references missing movement ${movementTopologyId}`, { junctionId: junction.junctionId }));
    }
    const expectedMovementIds = interaction.sourceManeuverIds.flatMap((sourceManeuverId) => movementIdsBySource.get(sourceManeuverId) ?? []).sort();
    const actualMovementIds = [...interaction.movementTopologyIds].sort();
    if (expectedMovementIds.join("\x00") !== actualMovementIds.join("\x00")) {
      diagnostics.push(error11("physical-interaction-movement-coverage", `Interaction ${interaction.id} does not exactly cover its source maneuver movements`, { junctionId: junction.junctionId }));
    }
    if (interaction.prioritySourceManeuverId && !interaction.sourceManeuverIds.includes(interaction.prioritySourceManeuverId)) {
      diagnostics.push(error11("physical-interaction-priority-source", `Interaction ${interaction.id} priority is not one of its source maneuvers`, { junctionId: junction.junctionId }));
    }
    for (const priorityMovementId of interaction.priorityMovementTopologyIds) {
      if (interaction.movementTopologyIds.includes(priorityMovementId))
        continue;
      diagnostics.push(error11("physical-interaction-priority-movement", `Interaction ${interaction.id} priority movement is outside the interaction`, { junctionId: junction.junctionId }));
    }
    if (interaction.kind === "compatible" && interaction.conflictZoneIds.length > 0) {
      diagnostics.push(error11("physical-compatible-interaction-conflict", `Compatible interaction ${interaction.id} owns a conflict zone`, { junctionId: junction.junctionId }));
    }
    for (const conflictZoneId of interaction.conflictZoneIds) {
      if (!semanticConflictIds.has(conflictZoneId)) {
        diagnostics.push(error11("physical-interaction-conflict-zone-missing", `Interaction ${interaction.id} references missing conflict zone ${conflictZoneId}`, { junctionId: junction.junctionId }));
      }
      conflictClaims.set(conflictZoneId, [...conflictClaims.get(conflictZoneId) ?? [], interaction.id]);
    }
  }
  if (semanticJunction.kind === "common") {
    const sourceManeuverIds = [...movementIdsBySource.keys()].sort();
    for (let left = 0;left < sourceManeuverIds.length; left++) {
      for (let right = left + 1;right < sourceManeuverIds.length; right++) {
        const pairKey = [sourceManeuverIds[left], sourceManeuverIds[right]].join("\x00");
        if (interactionPairKeys.has(pairKey))
          continue;
        diagnostics.push(error11("physical-interaction-pair-missing", `Junction ${junction.junctionId} has no interaction for ${sourceManeuverIds[left]}/${sourceManeuverIds[right]}`, { junctionId: junction.junctionId }));
      }
    }
  }
  for (const zone of semanticJunction.conflictZones ?? []) {
    if (!zone.maneuverIds)
      continue;
    const owners = conflictClaims.get(zone.id) ?? [];
    if (owners.length === 1)
      continue;
    diagnostics.push(error11(owners.length === 0 ? "physical-conflict-zone-unclaimed" : "physical-conflict-zone-multiply-claimed", `Conflict zone ${zone.id} has ${owners.length} movement interaction owners`, { junctionId: junction.junctionId }));
  }
}
function validateJunctionSurfaceOwnership(network, topology, diagnostics) {
  const tessellation = tessellateJunctionPhysicalTopology(network, topology, { step: 0.5 });
  const surfaces = tessellation.junctionSurfaces;
  for (const junction of topology.junctions) {
    if (junction.surfacePolicy === "none")
      continue;
    for (const corridor of topology.corridors.filter((candidate) => candidate.roadKind !== "connector" && junction.roadIds.includes(candidate.roadId))) {
      for (const band of corridor.sections.flatMap((section) => section.bands).filter((candidate) => candidate.surfaceOwner.kind === "road")) {
        if (band.surfaceCutoutOwnerIds?.includes(junction.junctionId))
          continue;
        diagnostics.push(error11("physical-junction-road-cutout-missing", `Road band ${band.id} does not yield pavement to junction ${junction.junctionId}`, { roadId: band.roadId, junctionId: junction.junctionId, sectionId: band.sectionId, laneId: band.laneId }));
      }
    }
    if (!surfaces.some((surface) => surface.junctionId === junction.junctionId)) {
      diagnostics.push(error11("physical-junction-surface-missing", `Junction ${junction.junctionId} owns ${junction.surfacePolicy} pavement but has no positive-area surface`, { junctionId: junction.junctionId }));
    }
  }
  for (let leftIndex = 0;leftIndex < surfaces.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1;rightIndex < surfaces.length; rightIndex++) {
      const left = surfaces[leftIndex];
      const right = surfaces[rightIndex];
      const overlapArea = left.components.reduce((sum, leftComponent) => sum + right.components.reduce((innerSum, rightComponent) => innerSum + polygonComponentsArea(intersectPolygons(leftComponent.outer, [rightComponent.outer])), 0), 0);
      if (overlapArea <= 0.0001)
        continue;
      diagnostics.push(error11("physical-junction-surface-overlap", `Junctions ${left.junctionId} and ${right.junctionId} overlap by ${overlapArea.toFixed(3)} m2`, { junctionId: left.junctionId }));
    }
  }
}
function validateDirectLaneLinkGeometry(network, link, diagnostics, surfaceFallback) {
  const from = resolveLaneContact(network, link.from.roadId, link.from.sectionId, link.from.laneId);
  const to = resolveLaneContact(network, link.to.roadId, link.to.sectionId, link.to.laneId);
  if (!from || !to)
    return;
  const fromGeometry = laneContactGeometry(from.road, from.section, from.lane, link.from.s);
  const toGeometry = laneContactGeometry(to.road, to.section, to.lane, link.to.s);
  const boundaryError = Math.max(distance32(fromGeometry.left, toGeometry.left), distance32(fromGeometry.right, toGeometry.right));
  const elevationError = Math.max(Math.abs(fromGeometry.left.z - toGeometry.left.z), Math.abs(fromGeometry.right.z - toGeometry.right.z));
  const headingError = Math.abs(normalizeAngle(fromGeometry.heading - toGeometry.heading));
  const curvatureError = Math.abs(fromGeometry.curvature - toGeometry.curvature);
  const gradeError = Math.abs(fromGeometry.grade - toGeometry.grade);
  const rollError = Math.abs(fromGeometry.roll - toGeometry.roll);
  const context = {
    roadId: link.from.roadId,
    junctionId: link.junctionId,
    sectionId: link.from.sectionId,
    laneId: link.from.laneId
  };
  if (!surfaceFallback && boundaryError > 0.02)
    diagnostics.push(error11("physical-direct-link-position", `Direct lane link ${link.id} has a ${boundaryError.toFixed(3)} m boundary gap`, context));
  if (surfaceFallback && elevationError > 0.02)
    diagnostics.push(error11("physical-direct-link-elevation", `Direct lane link ${link.id} has a ${elevationError.toFixed(3)} m elevation gap`, context));
  if (!surfaceFallback && headingError > 0.01)
    diagnostics.push(error11("physical-direct-link-heading", `Direct lane link ${link.id} has a ${headingError.toFixed(4)} rad heading discontinuity`, context));
  if (!surfaceFallback && link.requiredContinuity === "g2" && curvatureError > 0.005)
    diagnostics.push(error11("physical-direct-link-curvature", `Direct lane link ${link.id} has a ${curvatureError.toFixed(4)} 1/m curvature discontinuity`, context));
  if (gradeError > 0.005)
    diagnostics.push(error11("physical-direct-link-grade", `Direct lane link ${link.id} has a ${gradeError.toFixed(4)} grade discontinuity`, context));
  if (rollError > 0.005)
    diagnostics.push(error11("physical-direct-link-roll", `Direct lane link ${link.id} has a ${rollError.toFixed(4)} rad roll discontinuity`, context));
}
function resolveLaneContact(network, roadId, sectionId, laneId2) {
  const road = network.roads.find((candidate) => candidate.id === roadId);
  const section = road?.laneSections.find((candidate) => candidate.id === sectionId);
  const lane = section?.lanes.find((candidate) => candidate.id === laneId2);
  return road && section && lane ? { road, section, lane } : undefined;
}
function distance32(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
function validateSection(roadId, section, allBandIds, allBoundaryIds, diagnostics) {
  const localBoundaries = new Set(section.boundaries.map((boundary) => boundary.id));
  for (const boundary of section.boundaries) {
    if (allBoundaryIds.has(boundary.id)) {
      diagnostics.push(error11("physical-duplicate-boundary-id", `Duplicate physical boundary ${boundary.id}`, { roadId, sectionId: section.sectionId }));
    }
    allBoundaryIds.add(boundary.id);
  }
  for (const band of section.bands) {
    if (allBandIds.has(band.id)) {
      diagnostics.push(error11("physical-duplicate-band-id", `Duplicate physical band ${band.id}`, { roadId, sectionId: section.sectionId, laneId: band.laneId }));
    }
    allBandIds.add(band.id);
    for (const boundaryId of [band.leftBoundaryId, band.rightBoundaryId]) {
      if (!localBoundaries.has(boundaryId)) {
        diagnostics.push(error11("physical-band-boundary-missing", `Band ${band.id} references boundary ${boundaryId} outside section ${section.sectionId}`, { roadId, sectionId: section.sectionId, laneId: band.laneId }));
      }
    }
  }
}
function validateSectionContact(contact, expectedUpstreamBoundaryIds, expectedDownstreamBoundaryIds, diagnostics) {
  const upstreamBoundaryIds = contact.nodes.flatMap((node) => node.upstreamBoundaryIds);
  const downstreamBoundaryIds = contact.nodes.flatMap((node) => node.downstreamBoundaryIds);
  validateContactBoundaries(contact, upstreamBoundaryIds, expectedUpstreamBoundaryIds, "upstream", diagnostics);
  validateContactBoundaries(contact, downstreamBoundaryIds, expectedDownstreamBoundaryIds, "downstream", diagnostics);
  const upstreamNodes = contact.nodes.filter((node) => node.upstreamBoundaryIds.length > 0);
  const downstreamNodes = contact.nodes.filter((node) => node.downstreamBoundaryIds.length > 0);
  if (upstreamNodes.length === 0 || downstreamNodes.length === 0)
    return;
  const upstreamEnvelope = envelope(upstreamNodes.map((node) => node.t));
  const downstreamEnvelope = envelope(downstreamNodes.map((node) => node.t));
  if (Math.abs(upstreamEnvelope.min - downstreamEnvelope.min) > POSITION_TOLERANCE2 || Math.abs(upstreamEnvelope.max - downstreamEnvelope.max) > POSITION_TOLERANCE2) {
    diagnostics.push(error11("physical-section-envelope-discontinuity", `Road ${contact.roadId} pavement envelope jumps at s=${contact.s}`, { roadId: contact.roadId, sectionId: contact.downstreamSectionId }));
  }
}
function validateContactBoundaries(contact, ids, expectedIds, side, diagnostics) {
  const counts = new Map;
  for (const id of ids)
    counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count === 1)
      continue;
    diagnostics.push(error11("physical-section-contact-duplicate-boundary", `Section contact ${contact.id} maps ${side} boundary ${id} ${count} times`, { roadId: contact.roadId, sectionId: side === "upstream" ? contact.upstreamSectionId : contact.downstreamSectionId }));
  }
  for (const id of expectedIds) {
    if (counts.has(id))
      continue;
    diagnostics.push(error11("physical-section-contact-boundary-missing", `Section contact ${contact.id} does not map ${side} boundary ${id}`, { roadId: contact.roadId, sectionId: side === "upstream" ? contact.upstreamSectionId : contact.downstreamSectionId }));
  }
}
function envelope(values) {
  return { min: Math.min(...values), max: Math.max(...values) };
}
function error11(code, message, context = {}) {
  return { severity: "error", code, message, ...context };
}

// ../three-roads-inspect/packages/core/src/compiler/maneuver-geometry.ts
function compileManeuverGeometries(network, source, maneuverRoadIds) {
  const geometries = new Map;
  for (const maneuver of source.maneuvers) {
    const roadIds = maneuverRoadIds[`${source.id}:${maneuver.id}`] ?? [];
    const connector = roadIds.map((roadId) => network.roads.find((road) => road.id === roadId)).find((road) => road?.kind === "connector");
    if (!connector)
      continue;
    const incoming = evaluateRoadReference(connector, 0);
    const outgoing = evaluateRoadReference(connector, connector.length);
    const turnAngle = normalizeAngle(outgoing.heading - incoming.heading);
    const returnsToSourceApproach = maneuver.fromRoadId === maneuver.toRoadId && (maneuver.fromPortId ?? "") === (maneuver.toPortId ?? "");
    geometries.set(maneuver.id, {
      maneuverId: maneuver.id,
      incomingHeading: normalizeAngle(incoming.heading),
      outgoingHeading: normalizeAngle(outgoing.heading),
      turnAngle,
      turn: classifyManeuverTurn(turnAngle, returnsToSourceApproach)
    });
  }
  return geometries;
}
function classifyManeuverTurn(turnAngle, returnsToSourceApproach = true) {
  const normalized = normalizeAngle(turnAngle);
  const throughLimit = Math.PI / 4;
  const uTurnLimit = Math.PI * 3 / 4;
  if (Math.abs(normalized) <= throughLimit)
    return "through";
  if (returnsToSourceApproach && Math.abs(normalized) >= uTurnLimit)
    return "u-turn";
  return normalized > 0 ? "left" : "right";
}

// ../three-roads-inspect/packages/core/src/compiler/compile-traffic-streams.ts
var DEFAULT_CONFLICT_WINDOW = 15;
function compileTrafficStreams(network, document, junction, templates) {
  return (junction.trafficStreams ?? []).map((stream) => {
    const port = junction.ports.find((candidate) => candidate.roadId === stream.roadId && junctionPortId(candidate) === stream.portId);
    const stroke = document.strokes.find((candidate) => candidate.id === stream.roadId);
    const road = network.roads.find((candidate) => candidate.id === stream.roadId);
    if (!port || !stroke || !road) {
      throw new Error(`Junction ${junction.id} stream ${stream.id} has an unresolved road or port`);
    }
    const s = port.s ?? (port.contactPoint === "start" ? 0 : referenceLineLength({ geometry: stroke.geometry }));
    const laneId2 = laneIdForStrokeRoleAtStation(stroke, s, stream.laneRole, templates);
    const section = [...road.laneSections].sort((left, right) => left.s - right.s).filter((candidate) => candidate.s <= s + 0.0000001).at(-1);
    const lane = section?.lanes.find((candidate) => candidate.id === laneId2);
    if (laneId2 === undefined || !section || !lane || lane.id === 0) {
      throw new Error(`Junction ${junction.id} stream ${stream.id} cannot resolve lane role ${stream.laneRole}`);
    }
    const sectionEnd = laneSectionEndS(road, section);
    const window = stream.conflictWindow ?? DEFAULT_CONFLICT_WINDOW;
    const sStart = Math.max(section.s, s - window);
    const sEnd = Math.min(sectionEnd, s + window);
    if (sEnd - sStart <= 0.000001) {
      throw new Error(`Junction ${junction.id} stream ${stream.id} has an empty conflict window`);
    }
    const availableWidth = laneWidthAt(lane, s - section.s);
    const conflictEnvelopeWidth = Math.min(availableWidth, stream.conflictEnvelopeWidth ?? defaultConflictEnvelopeWidth(lane.type));
    return {
      id: stream.id,
      roadId: stream.roadId,
      portId: stream.portId,
      movement: stream.movement,
      contactGroupId: stream.contactGroupId,
      laneId: laneId2,
      s,
      sStart,
      sEnd,
      travelHeading: laneContactGeometry(road, section, lane, s).heading,
      conflictEnvelopeWidth
    };
  });
}

// ../three-roads-inspect/packages/core/src/compiler/stream-interactions.ts
function deriveStreamConflictZones(network, source, streams) {
  const zones = [];
  for (let leftIndex = 0;leftIndex < streams.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1;rightIndex < streams.length; rightIndex++) {
      const left = streams[leftIndex];
      const right = streams[rightIndex];
      const topologicalKind = streamPairTopologicalKind(left, right);
      if (topologicalKind === "compatible" || topologicalKind === "diverge")
        continue;
      const leftPolygon = streamOccupancyPolygon(network, left);
      const rightPolygon = streamOccupancyPolygon(network, right);
      if (!leftPolygon || !rightPolygon)
        continue;
      const components = intersectPolygons(leftPolygon, [rightPolygon]).filter((component) => Math.abs(polygonArea(component.outer)) >= 0.05);
      for (let componentIndex = 0;componentIndex < components.length; componentIndex++) {
        zones.push({
          id: `${source.id}__stream__${left.id}__x__${right.id}${components.length > 1 ? `__${componentIndex}` : ""}`,
          roadIds: [...new Set([left.roadId, right.roadId])].sort(),
          polygon: components[componentIndex].outer,
          kind: topologicalKind,
          streamIds: orderedManeuverIds(left.id, right.id)
        });
      }
    }
  }
  return zones;
}
function compileStreamInteractions(source, streams, zones) {
  const interactions = [];
  for (let leftIndex = 0;leftIndex < streams.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1;rightIndex < streams.length; rightIndex++) {
      const left = streams[leftIndex];
      const right = streams[rightIndex];
      const streamIds = orderedManeuverIds(left.id, right.id);
      const pairZones = zones.filter((zone) => zone.streamIds && maneuverPairKey(zone.streamIds) === maneuverPairKey(streamIds));
      const topologicalKind = streamPairTopologicalKind(left, right);
      if (topologicalKind === "merge" && pairZones.length === 0) {
        throw new Error(`Junction ${source.id} merge streams ${streamIds.join("/")} have no occupancy overlap`);
      }
      const kind = topologicalKind === "crossing" && pairZones.length === 0 ? "compatible" : topologicalKind;
      const control = compileStreamControl(source, left, right, kind);
      interactions.push({
        id: `${source.id}__stream-interaction__${streamIds[0]}__${streamIds[1]}`,
        streamIds,
        kind,
        control,
        priorityStreamId: control.kind === "fixed-priority" ? control.priorityParticipantId : undefined,
        conflictZoneIds: pairZones.map((zone) => zone.id).sort()
      });
    }
  }
  validateSignalPhases(source, interactions);
  return interactions;
}
function compileStreamControl(source, left, right, kind) {
  if (kind === "compatible" || kind === "diverge")
    return { kind: "none" };
  const plan = source.control;
  if (!plan) {
    const priorityRoads = new Set(source.priorityRoadIds ?? []);
    const leftPriority = priorityRoads.has(left.roadId);
    const rightPriority = priorityRoads.has(right.roadId);
    if (leftPriority !== rightPriority) {
      return fixedPriority2(left.id, right.id, leftPriority ? left.id : right.id, "legacy-priority-road", "yield");
    }
    return { kind: "unresolved", reason: "crossing stream has no control plan" };
  }
  if (plan.kind === "priority") {
    const priorityPorts = new Set(plan.priorityPortIds);
    const leftPriority = priorityPorts.has(left.portId);
    const rightPriority = priorityPorts.has(right.portId);
    if (leftPriority !== rightPriority) {
      return fixedPriority2(left.id, right.id, leftPriority ? left.id : right.id, "priority-approach", plan.minorControl);
    }
    return rightBeforeLeft(left, right);
  }
  if (plan.kind === "uncontrolled")
    return rightBeforeLeft(left, right);
  if (plan.kind === "all-way-stop")
    return { kind: "all-way-stop" };
  if (plan.kind === "zipper") {
    return kind === "merge" ? { kind: "zipper" } : { kind: "unresolved", reason: "zipper control only resolves merge streams" };
  }
  if (plan.kind === "signal") {
    const leftGroupId = plan.groups.find((group) => group.participantIds.includes(left.id))?.id;
    const rightGroupId = plan.groups.find((group) => group.participantIds.includes(right.id))?.id;
    return leftGroupId && rightGroupId ? { kind: "signal", controllerId: plan.controllerId, signalGroupIds: [leftGroupId, rightGroupId] } : { kind: "unresolved", reason: "signal plan does not assign both crossing streams" };
  }
  return { kind: "unresolved", reason: `${plan.kind} control cannot regulate continuous crossing streams` };
}
function rightBeforeLeft(left, right) {
  const headingDelta = normalizeAngle(right.travelHeading - left.travelHeading);
  if (Math.abs(headingDelta) <= 0.0001 || Math.abs(Math.PI - Math.abs(headingDelta)) <= 0.0001) {
    return { kind: "unresolved", reason: "parallel or opposing crossing streams need explicit control" };
  }
  return fixedPriority2(left.id, right.id, headingDelta > 0 ? right.id : left.id, "right-before-left", "statutory");
}
function validateSignalPhases(source, interactions) {
  if (source.control?.kind !== "signal")
    return;
  for (const interaction of interactions) {
    if (interaction.conflictZoneIds.length === 0 || interaction.control.kind !== "signal")
      continue;
    const [leftGroupId, rightGroupId] = interaction.control.signalGroupIds;
    if (leftGroupId === rightGroupId) {
      throw new Error(`Signal group ${leftGroupId} contains conflicting streams ${interaction.streamIds.join("/")}`);
    }
    for (const phase of source.control.phases) {
      if (phase.greenGroupIds.includes(leftGroupId) && phase.greenGroupIds.includes(rightGroupId)) {
        throw new Error(`Signal phase ${phase.id} releases conflicting streams ${interaction.streamIds.join("/")}`);
      }
    }
  }
}
function streamOccupancyPolygon(network, stream) {
  const road = network.roads.find((candidate) => candidate.id === stream.roadId);
  const section = road?.laneSections.find((candidate, index) => {
    const nextS = road.laneSections[index + 1]?.s ?? road.length;
    return candidate.s <= stream.s + 0.0000001 && stream.s <= nextS + 0.0000001;
  });
  const lane = section?.lanes.find((candidate) => candidate.id === stream.laneId);
  if (!road || !section || !lane)
    return;
  return trafficOccupancyPolygon(road, section, lane, stream.sStart, stream.sEnd, stream.conflictEnvelopeWidth);
}
function streamPairTopologicalKind(left, right) {
  if (left.roadId === right.roadId && left.laneId === right.laneId)
    return "compatible";
  const sharesContact = left.contactGroupId !== undefined && left.contactGroupId === right.contactGroupId;
  const movements = new Set([left.movement, right.movement]);
  if (sharesContact && movements.has("leaving") && movements.has("through"))
    return "diverge";
  if (sharesContact && movements.has("entering") && movements.has("through"))
    return "merge";
  if (sharesContact && left.movement === "entering" && right.movement === "entering")
    return "merge";
  if (sharesContact && left.movement === "leaving" && right.movement === "leaving")
    return "diverge";
  return "crossing";
}
function fixedPriority2(leftId, rightId, priorityParticipantId, basis, yieldingControl) {
  return {
    kind: "fixed-priority",
    basis,
    priorityParticipantId,
    yieldingParticipantId: priorityParticipantId === leftId ? rightId : leftId,
    yieldingControl
  };
}

// ../three-roads-inspect/packages/core/src/lanes/lane-surface-extrema.ts
function laneSurfaceCrossSectionExtrema(road, s) {
  const section = findLaneSection(road, s);
  const values = section.lanes.filter((lane) => lane.id !== 0).flatMap((lane) => laneSurfaceExtrema(road, lane, section, s));
  if (values.length === 0)
    throw new Error(`Road ${road.id} has no lane surface at s=${s}`);
  return {
    minimumZ: Math.min(...values),
    maximumZ: Math.max(...values)
  };
}
function laneSurfaceExtrema(road, lane, section, s) {
  const offsets = laneOffsetsAt(section, lane.id, s - section.s);
  if (Math.abs(offsets.outer - offsets.inner) <= 0.000000001)
    return [];
  const heights = laneHeightAt(lane, s - section.s);
  const heightAt = (t) => {
    const ratio = (t - offsets.inner) / (offsets.outer - offsets.inner);
    return heights.inner + (heights.outer - heights.inner) * ratio;
  };
  const zAt = (t) => laneSurfacePointAt(road, section, lane, s, t, heightAt(t)).z;
  const minimumT = Math.min(offsets.inner, offsets.outer);
  const maximumT = Math.max(offsets.inner, offsets.outer);
  const offset = laneOffsetAt(road, s);
  const breakpoints = [...new Set([
    minimumT,
    maximumT,
    -offset,
    ...(road.shapes ?? []).map((shape) => shape.t - offset)
  ].filter((t) => t >= minimumT - 0.000000001 && t <= maximumT + 0.000000001))].sort((left, right) => left - right);
  const candidates = new Set(breakpoints);
  if (!lane.level) {
    for (let index = 0;index < breakpoints.length - 1; index++) {
      addCubicCriticalPoints(breakpoints[index], breakpoints[index + 1], zAt, candidates);
    }
  }
  return [...candidates].map(zAt);
}
function addCubicCriticalPoints(start, end, evaluate, candidates) {
  if (end - start <= 0.000000001)
    return;
  const y0 = evaluate(start);
  const y1 = evaluate(start + (end - start) / 3);
  const y2 = evaluate(start + (end - start) * 2 / 3);
  const y3 = evaluate(end);
  const thirdDifference = y3 - 3 * y2 + 3 * y1 - y0;
  const d = 4.5 * thirdDifference;
  const c = 4.5 * (y2 - 2 * y1 + y0) - d;
  const b = 3 * (y1 - y0) - c / 3 - d / 9;
  for (const u of quadraticRoots5(3 * d, 2 * c, b)) {
    if (u > 0.000000001 && u < 1 - 0.000000001)
      candidates.add(start + (end - start) * u);
  }
}
function quadraticRoots5(a, b, c) {
  if (Math.abs(a) <= 0.000000000001)
    return Math.abs(b) <= 0.000000000001 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -0.0000000001)
    return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

// ../three-roads-inspect/packages/core/src/compiler/compile-grade-separations.ts
function compileGradeSeparations(network, intents) {
  const diagnostics = [];
  const gradeSeparations = intents.map((intent) => {
    const upperRoad = requiredRoad4(network, intent.upperRoad.roadId, intent.id);
    const lowerRoad = requiredRoad4(network, intent.lowerRoad.roadId, intent.id);
    const upperSurface = laneSurfaceCrossSectionExtrema(upperRoad, intent.upperRoad.s);
    const lowerSurface = laneSurfaceCrossSectionExtrema(lowerRoad, intent.lowerRoad.s);
    const actualPavementClearance = upperSurface.minimumZ - intent.deckThickness - lowerSurface.maximumZ;
    if (actualPavementClearance + 0.0000001 < intent.minimumClearance) {
      diagnostics.push({
        severity: "error",
        code: "grade-separation-insufficient-clearance",
        message: `Grade separation ${intent.id} provides ${actualPavementClearance.toFixed(3)} m pavement clearance; ${intent.minimumClearance.toFixed(3)} m is required`,
        sourceId: intent.id
      });
    }
    return {
      ...structuredClone(intent),
      actualPavementClearance
    };
  });
  return { gradeSeparations, diagnostics };
}
function requiredRoad4(network, roadId, gradeSeparationId) {
  const road = network.roads.find((candidate) => candidate.id === roadId);
  if (!road)
    throw new Error(`Grade separation ${gradeSeparationId} references missing compiled road ${roadId}`);
  return road;
}

// ../three-roads-inspect/packages/core/src/compiler/compile-weaving-sections.ts
var MIN_WIDTH = 0.05;
function compileWeavingSections(network, intents) {
  return intents.map((intent) => {
    const road = network.roads.find((candidate) => candidate.id === intent.roadId);
    if (!road)
      throw new Error(`Weaving section ${intent.id} references missing compiled road ${intent.roadId}`);
    const lanePairs = road.laneSections.flatMap((section) => {
      const sStart = Math.max(intent.sStart, section.s);
      const sEnd = Math.min(intent.sEnd, laneSectionEndS(road, section));
      if (sEnd <= sStart + 0.0000001)
        return [];
      const through = section.lanes.find((lane) => lane.sourceRole === intent.throughLaneRole);
      const weaving = section.lanes.find((lane) => lane.sourceRole === intent.weavingLaneRole);
      if (!through || !weaving) {
        throw new Error(`Weaving section ${intent.id} cannot resolve both lane roles in ${section.id}`);
      }
      const localStart = sStart - section.s;
      const localEnd = sEnd - section.s;
      if (Math.min(laneWidthAt(through, localStart), laneWidthAt(through, localEnd), laneWidthAt(weaving, localStart), laneWidthAt(weaving, localEnd)) <= MIN_WIDTH) {
        throw new Error(`Weaving section ${intent.id} has a zero-width lane in ${section.id}`);
      }
      return [{
        sectionId: section.id,
        throughLaneId: through.id,
        weavingLaneId: weaving.id,
        sStart,
        sEnd
      }];
    });
    if (lanePairs.length === 0)
      throw new Error(`Weaving section ${intent.id} has no compiled lane intervals`);
    return { ...structuredClone(intent), lanePairs };
  });
}

// ../three-roads-inspect/packages/core/src/compiler/compile-road-structures.ts
function compileRoadStructures(network, intents) {
  const diagnostics = [];
  const roadStructures = intents.map((intent) => {
    const road = network.roads.find((candidate) => candidate.id === intent.roadId);
    if (!road)
      throw new Error(`Road structure ${intent.id} references missing compiled road ${intent.roadId}`);
    const extent = roadLateralExtremaOverRange(road, intent.sStart, intent.sEnd);
    const followsRoadSurface = intent.lateralExtentMode === "road-surface";
    const deckTMin = followsRoadSurface ? extent.minimumT - intent.minimumLateralClearance : intent.deckTMin;
    const deckTMax = followsRoadSurface ? extent.maximumT + intent.minimumLateralClearance : intent.deckTMax;
    const minimumClearance = Math.min(extent.minimumT - deckTMin, deckTMax - extent.maximumT);
    if (minimumClearance + 0.0000001 < intent.minimumLateralClearance) {
      diagnostics.push({
        severity: "error",
        code: "road-structure-lateral-clearance",
        message: `Road structure ${intent.id} provides ${minimumClearance.toFixed(3)} m lateral clearance; ${intent.minimumLateralClearance.toFixed(3)} m is required`,
        sourceId: intent.id
      });
    }
    return {
      ...structuredClone(intent),
      deckTMin,
      deckTMax,
      actualMinimumT: extent.minimumT,
      actualMaximumT: extent.maximumT,
      actualMinimumLateralClearance: minimumClearance
    };
  });
  return { roadStructures, diagnostics };
}

// ../three-roads-inspect/packages/core/src/compiler/compile-roadside-features.ts
function compileRoadsideFeatures(network, intents) {
  return intents.map((intent) => {
    const road = network.roads.find((candidate) => candidate.id === intent.roadId);
    if (!road)
      throw new Error(`Roadside feature ${intent.id} has no compiled road ${intent.roadId}`);
    const section = findLaneSection(road, intent.sStart);
    const lane = section.lanes.find((candidate) => candidate.sourceRole === intent.laneRole);
    if (!lane || lane.id === 0)
      throw new Error(`Roadside feature ${intent.id} has no compiled lane role ${intent.laneRole}`);
    return {
      ...structuredClone(intent),
      side: lane.id > 0 ? "left" : "right"
    };
  });
}

// ../three-roads-inspect/packages/core/src/compiler/junction-marking-directions.ts
function classifyLaneManeuver(sourceRoad, sourceLane, sourceS, targetRoad, targetLane, targetS) {
  const sourceHeading = laneHeading(sourceRoad, sourceLane, sourceS);
  const targetHeading = laneHeading(targetRoad, targetLane, targetS);
  const delta = normalizeAngle(targetHeading - sourceHeading);
  if (Math.abs(delta) > Math.PI * 0.8)
    return;
  if (Math.abs(delta) < Math.PI / 4)
    return "straight";
  return delta > 0 ? "left" : "right";
}
function arrowForManeuverDirections(directions) {
  const values = new Set(directions);
  const straight = values.has("straight");
  const left = values.has("left");
  const right = values.has("right");
  if (straight && left && right)
    return "straight-left-right";
  if (straight && left)
    return "straight-left";
  if (straight && right)
    return "straight-right";
  if (left && right)
    return "left-right";
  if (straight)
    return "straight";
  if (left)
    return "left";
  if (right)
    return "right";
  return;
}
function laneHeading(road, lane, s) {
  const referenceHeading = evaluateRoadReference(road, s).heading;
  return normalizeAngle(referenceHeading + (laneTravelSign(lane) < 0 ? Math.PI : 0));
}

// ../three-roads-inspect/packages/core/src/compiler/junction-marking-roads.ts
function junctionMarkingRoadIds(network, junctions) {
  const junctionIds = new Set(junctions.map(({ id }) => id));
  return new Set([
    ...junctions.flatMap(({ ports }) => ports.map(({ roadId }) => roadId)),
    ...network.roads.filter((road) => road.junctionId && junctionIds.has(road.junctionId)).map(({ id }) => id)
  ]);
}

// ../three-roads-inspect/packages/core/src/compiler/junction-marking-plan.ts
var GERMAN_DEFAULT = {
  rules: "german",
  controlLines: "derive",
  laneArrows: "derive",
  connectorSeparators: "derive",
  throughContinuity: "derive",
  priorityStraightContinuity: "derive",
  dedicatedTurnContinuity: "derive",
  signalTurnContinuity: "derive"
};
function resolveJunctionMarkingPlan(junction) {
  return {
    ...GERMAN_DEFAULT,
    ...junction.markingPlan
  };
}

// ../three-roads-inspect/packages/core/src/compiler/compile-junction-corner-markings.ts
function compileJunctionCornerMarkings(network, document, junctionIds) {
  const additions = new Map;
  const selectedJunctions = document.junctions.filter((junction) => junction.kind === "common" && (!junctionIds || junctionIds.has(junction.id)));
  const relevantRoadIds = junctionMarkingRoadIds(network, selectedJunctions);
  const corridors = new Map(network.roads.filter((road) => relevantRoadIds.has(road.id)).map((road) => [road.id, buildRoadCorridorTopology(road)]));
  for (const source of selectedJunctions) {
    if (resolveJunctionMarkingPlan(source).connectorSeparators !== "derive")
      continue;
    const compiled = network.junctions.find((junction) => junction.id === source.id);
    if (!compiled)
      continue;
    const ports = orderedPorts(network, source);
    if (ports.length < 2)
      continue;
    const center = averagePoint(ports.map((port) => port.center));
    for (let index = 0;index < ports.length; index++) {
      const from = ports[index];
      const to = ports[(index + 1) % ports.length];
      if (hasPerimeterOwner(source, from.id, to.id))
        continue;
      const endAngle = to.angle <= from.angle ? to.angle + Math.PI * 2 : to.angle;
      const cornerAngle = (from.angle + endAngle) * 0.5;
      const cornerDirection = { x: Math.cos(cornerAngle), y: Math.sin(cornerAngle) };
      const candidates = source.maneuvers.filter((maneuver) => connectsPorts(maneuver, from.id, to.id)).flatMap((maneuver) => cornerCandidate(network, compiled, maneuver, corridors, center, cornerDirection) ?? []);
      const selected = candidates.sort((left, right) => right.score - left.score)[0];
      if (!selected)
        continue;
      const byLane = additions.get(selected.connectorRoad.id) ?? new Map;
      byLane.set(selected.connectorLane.id, [
        ...byLane.get(selected.connectorLane.id) ?? [],
        {
          ...structuredClone(selected.marking),
          id: `generated-junction|${source.id}|${selected.maneuverId}|corner-${selected.boundary}`,
          boundary: selected.boundary,
          sStart: 0,
          sEnd: selected.connectorRoad.length,
          laneChange: "none"
        }
      ]);
      additions.set(selected.connectorRoad.id, byLane);
    }
  }
  if (additions.size === 0)
    return network;
  return {
    ...network,
    roads: network.roads.map((road) => additions.has(road.id) ? {
      ...road,
      laneSections: road.laneSections.map((section) => ({
        ...section,
        lanes: section.lanes.map((lane) => additions.get(road.id)?.has(lane.id) ? { ...lane, markings: mergeMarkings(lane.markings, additions.get(road.id)?.get(lane.id) ?? []) } : lane)
      }))
    } : road)
  };
}
function hasPerimeterOwner(junction, leftPortId, rightPortId) {
  return (junction.laneContinuations ?? []).some((continuation) => continuation.fromPortId === leftPortId && continuation.toPortId === rightPortId || continuation.fromPortId === rightPortId && continuation.toPortId === leftPortId);
}
function cornerCandidate(network, compiled, maneuver, corridors, junctionCenter, cornerDirection) {
  const connection = compiled.connections.find((candidate) => candidate.sourceManeuverId === maneuver.id);
  const connectorRoad = connection && network.roads.find((road) => road.id === connection.connectingRoadId);
  const connectorSection = connectorRoad?.laneSections[0];
  const laneLink = connection?.laneLinks[0];
  const connectorLane = connectorSection?.lanes.find((lane) => lane.id === laneLink?.to);
  const incomingRoad = network.roads.find((road) => road.id === maneuver.fromRoadId);
  const successor = connectorLane?.links?.successor;
  const outgoingRoad = successor && network.roads.find((road) => road.id === successor.roadId);
  if (!connection || !connectorRoad || !connectorSection || !connectorLane || !incomingRoad || !successor || !outgoingRoad) {
    return;
  }
  const incomingS = connection.incomingS ?? endpointS4(incomingRoad, connection.incomingContactPoint);
  const outgoingS = successor.s ?? endpointS4(outgoingRoad, successor.contactPoint);
  const incomingSection = findLaneSection(incomingRoad, incomingS);
  const outgoingSection = findLaneSection(outgoingRoad, outgoingS);
  const incomingLane = incomingSection.lanes.find((lane) => lane.id === laneLink?.from);
  const outgoingLane = outgoingSection.lanes.find((lane) => lane.id === successor.laneId);
  if (!incomingLane || !outgoingLane)
    return;
  const sourceBoundary = cornerFacingBoundary(incomingRoad, incomingSection, incomingLane, incomingS, cornerDirection);
  const targetBoundary = cornerFacingBoundary(outgoingRoad, outgoingSection, outgoingLane, outgoingS, cornerDirection);
  const sourceMarking = physicalEdgeMarking(corridors.get(incomingRoad.id), incomingSection.id, incomingLane.id, sourceBoundary, incomingS);
  const targetMarking = physicalEdgeMarking(corridors.get(outgoingRoad.id), outgoingSection.id, outgoingLane.id, targetBoundary, outgoingS);
  const marking = matchingEdgeMarking(sourceMarking, targetMarking);
  if (!marking)
    return;
  const fromContact = laneContactGeometry(incomingRoad, incomingSection, incomingLane, incomingS);
  const connectorBoundary = connectorBoundaryForLaneBoundary(sourceBoundary, incomingRoad, incomingSection, incomingLane, incomingS, fromContact);
  const ordinal = laneBoundaryOrdinal(connectorLane.id, connectorBoundary);
  const midpointS = connectorRoad.length * 0.5;
  const offset = laneBoundaryOffsetAt(connectorSection, ordinal, midpointS - connectorSection.s);
  const midpoint = roadToWorld(connectorRoad, midpointS, offset);
  return {
    connectorRoad,
    connectorLane,
    boundary: connectorBoundary,
    marking,
    score: (midpoint.x - junctionCenter.x) * cornerDirection.x + (midpoint.y - junctionCenter.y) * cornerDirection.y,
    maneuverId: maneuver.id
  };
}
function orderedPorts(network, junction) {
  const ports = junction.ports.flatMap((port) => {
    const road = network.roads.find((candidate) => candidate.id === port.roadId);
    if (!road)
      return [];
    const s = Math.max(0, Math.min(road.length, port.s ?? endpointS4(road, port.contactPoint)));
    const point = roadToWorld(road, s, 0);
    return [{ id: junctionPortId(port), road, s, center: { x: point.x, y: point.y }, angle: 0 }];
  });
  const center = averagePoint(ports.map((port) => port.center));
  for (const port of ports)
    port.angle = normalizedAngle2(Math.atan2(port.center.y - center.y, port.center.x - center.x));
  return ports.sort((left, right) => left.angle - right.angle || left.id.localeCompare(right.id));
}
function cornerFacingBoundary(road, section, lane, s, cornerDirection) {
  const localS = s - section.s;
  const offsets = laneOffsetsAt(section, lane.id, localS);
  const heights = laneHeightAt(lane, localS);
  const reference = roadToWorld(road, s, 0);
  const score = (boundary) => {
    const point = laneSurfacePointAt(road, section, lane, s, offsets[boundary], heights[boundary]);
    return (point.x - reference.x) * cornerDirection.x + (point.y - reference.y) * cornerDirection.y;
  };
  return score("outer") > score("inner") ? "outer" : "inner";
}
function physicalEdgeMarking(corridor, sectionId, laneId2, boundary, s) {
  const ordinal = laneBoundaryOrdinal(laneId2, boundary);
  return corridor?.sections.find((section) => section.sectionId === sectionId)?.boundaries.find((candidate) => candidate.ordinal === ordinal)?.markings.find((marking) => (marking.kind === "edge" || marking.kind === "curb") && (marking.sStart === undefined || marking.sStart <= s + 0.0000001) && (marking.sEnd === undefined || marking.sEnd >= s - 0.0000001));
}
function matchingEdgeMarking(left, right) {
  if (!left || !right || left.kind !== right.kind || (left.color ?? "white") !== (right.color ?? "white"))
    return;
  return { ...left, width: Math.max(left.width ?? 0, right.width ?? 0) || undefined };
}
function connectsPorts(maneuver, leftPortId, rightPortId) {
  return maneuver.fromPortId === leftPortId && maneuver.toPortId === rightPortId || maneuver.fromPortId === rightPortId && maneuver.toPortId === leftPortId;
}
function mergeMarkings(existing, additions) {
  const result = [...existing ?? []];
  for (const marking of additions) {
    if (!result.some((candidate) => candidate.boundary === marking.boundary && candidate.kind === marking.kind && candidate.sStart === marking.sStart && candidate.sEnd === marking.sEnd))
      result.push(marking);
  }
  return result;
}
function endpointS4(road, contactPoint) {
  return contactPoint === "start" ? 0 : road.length;
}
function averagePoint(points) {
  const sum = points.reduce((result, point) => ({ x: result.x + point.x, y: result.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}
function normalizedAngle2(angle) {
  const fullTurn = Math.PI * 2;
  return (angle % fullTurn + fullTurn) % fullTurn;
}

// ../three-roads-inspect/packages/core/src/compiler/compile-junction-flow-markings.ts
var CONTINUOUS_KINDS = new Set([
  "broken",
  "guide",
  "solid",
  "solid-solid",
  "solid-broken",
  "broken-solid"
]);
var MOTOR_LANE_TYPES = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "bus",
  "restricted",
  "stop"
]);
function compileJunctionFlowMarkings(network, document, junctionIds) {
  const additions = new Map;
  const claimedBoundaries = new Set;
  const claimedBoundaryChains = new Set;
  const selectedJunctions = document.junctions.filter((junction) => junction.kind === "common" && (!junctionIds || junctionIds.has(junction.id)));
  const relevantRoadIds = junctionMarkingRoadIds(network, selectedJunctions);
  const corridors = new Map(network.roads.filter((road) => relevantRoadIds.has(road.id)).map((road) => [road.id, buildRoadCorridorTopology(road)]));
  for (const source of selectedJunctions) {
    const compiled = network.junctions.find((junction) => junction.id === source.id);
    if (!compiled)
      continue;
    const plan = resolveJunctionMarkingPlan(source);
    const movements = source.maneuvers.flatMap((maneuver) => {
      const movement = resolveMovement(network, source, compiled, maneuver);
      return movement ? [movement] : [];
    }).sort((left, right) => left.maneuver.id.localeCompare(right.maneuver.id));
    for (const movement of movements) {
      if (!mayContinueMarking(source, movement, movements, plan))
        continue;
      for (const sourceBoundary of ["inner", "outer"]) {
        const sourcePaint = physicalBoundaryPaint(corridors.get(movement.sourceRoad.id), movement.sourceSection, movement.sourceLane, sourceBoundary, movement.sourceS);
        if (!sourcePaint)
          continue;
        const connectorBoundary = mappedBoundary(movement.sourceRoad, movement.sourceSection, movement.sourceLane, movement.sourceS, sourceBoundary);
        const boundaryOrdinal = laneBoundaryOrdinal(movement.connectorLane.id, connectorBoundary);
        const boundaryKey = `${movement.connectorRoad.id}|${boundaryOrdinal}`;
        const targetPaint = ["inner", "outer"].flatMap((targetBoundary) => {
          if (mappedBoundary(movement.targetRoad, movement.targetSection, movement.targetLane, movement.targetS, targetBoundary) !== connectorBoundary)
            return [];
          const paint = physicalBoundaryPaint(corridors.get(movement.targetRoad.id), movement.targetSection, movement.targetLane, targetBoundary, movement.targetS);
          return paint ? [paint] : [];
        });
        if (targetPaint.length === 0)
          continue;
        const boundaryChainKey = canonicalBoundaryChainKey(sourcePaint.id, targetPaint.map((paint) => paint.id));
        const connectorTopology = corridors.get(movement.connectorRoad.id);
        const hasAuthoredMarking = connectorTopology?.sections[0]?.boundaries.find((boundary) => boundary.ordinal === boundaryOrdinal)?.markings.length;
        if (hasAuthoredMarking) {
          claimedBoundaryChains.add(boundaryChainKey);
          continue;
        }
        if (claimedBoundaries.has(boundaryKey) || claimedBoundaryChains.has(boundaryChainKey))
          continue;
        const marking = guideMarking(sourcePaint.markings, targetPaint.flatMap((paint) => paint.markings));
        addMarking(additions, movement.connectorRoad.id, movement.connectorLaneId, [
          {
            ...marking,
            id: `generated-junction|${source.id}|${movement.maneuver.id}|flow-${connectorBoundary}`,
            boundary: connectorBoundary,
            sStart: 0,
            sEnd: movement.connectorRoad.length,
            laneChange: "none"
          }
        ]);
        claimedBoundaries.add(boundaryKey);
        claimedBoundaryChains.add(boundaryChainKey);
      }
    }
  }
  return applyAdditions(network, additions);
}
function canonicalBoundaryChainKey(sourceBoundaryId, targetBoundaryIds) {
  return [sourceBoundaryId, ...targetBoundaryIds].sort().join("\x00");
}
function mayContinueMarking(junction, movement, movements, plan) {
  const control = junction.control;
  if (!control || movement.direction === undefined)
    return false;
  if (movement.direction === "straight") {
    if (control.kind === "priority") {
      const priorityPorts = new Set(control.priorityPortIds);
      if (priorityPorts.has(movement.sourcePortId ?? "") && priorityPorts.has(movement.targetPortId ?? "")) {
        return plan.priorityStraightContinuity === "derive";
      }
    }
    return plan.throughContinuity === "derive";
  }
  if (control.kind === "signal" && movement.direction === "left") {
    return plan.signalTurnContinuity === "derive";
  }
  return control.kind !== "roundabout" && plan.dedicatedTurnContinuity === "derive" && isDedicatedMovement(movement, movements);
}
function isDedicatedMovement(movement, movements) {
  return movements.filter((candidate) => candidate.sourcePortId === movement.sourcePortId && candidate.sourceLane.id === movement.sourceLane.id).length === 1;
}
function resolveMovement(network, sourceJunction, junction, maneuver) {
  const connection = junction.connections.find((candidate) => candidate.sourceManeuverId === maneuver.id);
  const connectorRoad = connection && network.roads.find((road) => road.id === connection.connectingRoadId);
  const laneLink = connection?.laneLinks[0];
  const connectorLane = connectorRoad?.laneSections[0]?.lanes.find((lane) => lane.id === laneLink?.to);
  const sourceRoad = network.roads.find((road) => road.id === maneuver.fromRoadId);
  const successor = connectorLane?.links?.successor;
  const targetRoad = successor && network.roads.find((road) => road.id === successor.roadId);
  if (!connection || !connectorRoad || !connectorLane || !sourceRoad || !successor || !targetRoad)
    return;
  const sourceS = connection.incomingS ?? endpointS5(sourceRoad, connection.incomingContactPoint);
  const targetS = successor.s ?? endpointS5(targetRoad, successor.contactPoint);
  const sourceSection = findLaneSection(sourceRoad, sourceS);
  const targetSection = findLaneSection(targetRoad, targetS);
  const sourceLane = sourceSection.lanes.find((lane) => lane.id === laneLink?.from);
  const targetLane = targetSection.lanes.find((lane) => lane.id === successor.laneId);
  if (!sourceLane || !targetLane)
    return;
  return {
    maneuver,
    connectorRoad,
    connectorLane,
    connectorLaneId: connectorLane.id,
    sourceRoad,
    sourceSection,
    sourceLane,
    sourceS,
    targetRoad,
    targetSection,
    targetLane,
    targetS,
    direction: classifyLaneManeuver(sourceRoad, sourceLane, sourceS, targetRoad, targetLane, targetS),
    sourcePortId: resolvePortId(sourceJunction, maneuver.fromRoadId, maneuver.fromPortId),
    targetPortId: resolvePortId(sourceJunction, maneuver.toRoadId, maneuver.toPortId)
  };
}
function physicalBoundaryPaint(corridor, section, lane, boundary, s) {
  const ordinal = laneBoundaryOrdinal(lane.id, boundary);
  const topologySection = corridor?.sections.find((candidate) => candidate.sectionId === section.id);
  const topologyBoundary = topologySection?.boundaries.find((candidate) => candidate.ordinal === ordinal);
  if (!topologySection || !topologyBoundary || !isInternalMotorBoundary(topologySection, topologyBoundary)) {
    return;
  }
  const markings = topologyBoundary.markings.filter((marking) => CONTINUOUS_KINDS.has(marking.kind) && marking.color !== "none" && (marking.sStart === undefined || marking.sStart <= s + 0.0000001) && (marking.sEnd === undefined || marking.sEnd >= s - 0.0000001));
  return markings.length > 0 ? { id: topologyBoundary.id, markings } : undefined;
}
function isInternalMotorBoundary(section, boundary) {
  if (!boundary.positiveSideBandId || !boundary.negativeSideBandId)
    return false;
  const positive = section.bands.find((band) => band.id === boundary.positiveSideBandId);
  const negative = section.bands.find((band) => band.id === boundary.negativeSideBandId);
  return Boolean(positive && negative && MOTOR_LANE_TYPES.has(positive.laneType) && MOTOR_LANE_TYPES.has(negative.laneType));
}
function mappedBoundary(road, section, lane, s, boundary) {
  return connectorBoundaryForLaneBoundary(boundary, road, section, lane, s, laneContactGeometry(road, section, lane, s));
}
function guideMarking(source, target) {
  for (const marking of source) {
    const match = target.find((candidate) => candidate.kind === marking.kind && (candidate.color ?? "white") === (marking.color ?? "white"));
    if (match)
      return {
        kind: "guide",
        id: marking.id,
        color: marking.color,
        width: Math.max(marking.width ?? 0, match.width ?? 0) || undefined
      };
  }
  const hint = source[0] ?? target[0];
  return {
    kind: "guide",
    id: hint?.id ?? "junction-guide",
    color: hint?.color,
    width: hint?.width
  };
}
function addMarking(additions, roadId, laneId2, markings) {
  const byLane = additions.get(roadId) ?? new Map;
  byLane.set(laneId2, [...byLane.get(laneId2) ?? [], ...markings]);
  additions.set(roadId, byLane);
}
function applyAdditions(network, additions) {
  if (additions.size === 0)
    return network;
  return {
    ...network,
    roads: network.roads.map((road) => additions.has(road.id) ? {
      ...road,
      laneSections: road.laneSections.map((section) => ({
        ...section,
        lanes: section.lanes.map((lane) => additions.get(road.id)?.has(lane.id) ? { ...lane, markings: [...lane.markings ?? [], ...additions.get(road.id)?.get(lane.id) ?? []] } : lane)
      }))
    } : road)
  };
}
function resolvePortId(junction, roadId, requestedId) {
  const port = junction.ports.find((candidate) => candidate.roadId === roadId && (!requestedId || junctionPortId(candidate) === requestedId));
  return port ? junctionPortId(port) : undefined;
}
function endpointS5(road, contactPoint) {
  return contactPoint === "start" ? 0 : road.length;
}

// ../three-roads-inspect/packages/core/src/compiler/junction-marking-eligibility.ts
var LONGITUDINAL_PAINT_KINDS = new Set([
  "solid",
  "broken",
  "guide",
  "solid-solid",
  "solid-broken",
  "broken-solid",
  "edge"
]);
function isLongitudinalPaint(marking) {
  return LONGITUDINAL_PAINT_KINDS.has(marking.kind) && marking.color !== "none";
}
function laneSectionHasLongitudinalPaint(section) {
  return section.lanes.some((lane) => lane.markings?.some(isLongitudinalPaint));
}
function roadHasLongitudinalPaint(road, s) {
  if (s === undefined)
    return road.laneSections.some(laneSectionHasLongitudinalPaint);
  const section = [...road.laneSections].sort((left, right) => left.s - right.s).filter((candidate) => candidate.s <= s + 0.0000001).at(-1);
  return section ? laneSectionHasLongitudinalPaint(section) : false;
}

// ../three-roads-inspect/packages/core/src/compiler/compile-junction-markings.ts
var CONTROL_LINE_DISTANCE = 1.25;
var ARROW_DISTANCE = 10;
var MOTOR_LANE_TYPES2 = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "bus",
  "restricted",
  "stop"
]);
function compileJunctionMarkings(network, document, templates, junctionIds) {
  const additions = new Map;
  const selectedJunctions = document.junctions.filter((candidate) => candidate.kind === "common" && (!junctionIds || junctionIds.has(candidate.id)));
  for (const junction of selectedJunctions) {
    const markingPlan = resolveJunctionMarkingPlan(junction);
    const groups = incomingLaneGroups(junction);
    for (const group of groups) {
      const road = network.roads.find((candidate) => candidate.id === group.roadId);
      const stroke = document.strokes.find((candidate) => candidate.id === group.roadId);
      const port = junction.ports.find((candidate) => junctionPortId(candidate) === group.portId);
      if (!road || !stroke || !port)
        continue;
      const portS = port.s ?? (port.contactPoint === "start" ? 0 : referenceLineLength({ geometry: stroke.geometry }));
      const laneId2 = laneIdForStrokeRoleAtStation(stroke, portS, group.laneRole, templates);
      const laneAtPort2 = laneAtStation(road, laneId2, portS);
      if (!laneAtPort2 || !MOTOR_LANE_TYPES2.has(laneAtPort2.lane.type))
        continue;
      const paintedApproach = roadHasLongitudinalPaint(road, portS);
      const controlKind = approachControlKind(group);
      if (markingPlan.controlLines === "derive" && paintedApproach && controlKind && !hasExplicitControlLine(document, group, portS)) {
        const marking = transverseMarking(road, laneAtPort2.lane, portS, CONTROL_LINE_DISTANCE, {
          id: `generated-junction|${junction.id}|${group.portId}|${group.laneRole}|${controlKind}`,
          kind: controlKind,
          width: controlKind === "stop-line" ? 0.5 : 0.45,
          controlIds: controlIds(group)
        });
        if (marking)
          push2(additions, road.id, marking);
      }
      const hasMultipleInboundLanes = groups.filter((candidate) => candidate.portId === group.portId).length > 1;
      if (markingPlan.laneArrows === "derive" && paintedApproach && hasMultipleInboundLanes && junction.control?.kind !== "roundabout" && !hasExplicitArrow(document, group, portS)) {
        const arrow = arrowForGroup(network, document, templates, group);
        const marking = arrow ? laneArrowMarking(road, laneAtPort2.lane, portS, ARROW_DISTANCE, {
          id: `generated-junction|${junction.id}|${group.portId}|${group.laneRole}|arrow`,
          arrow
        }) : undefined;
        if (marking)
          push2(additions, road.id, marking);
      }
    }
  }
  const markedNetwork = {
    ...network,
    roads: network.roads.map((road) => {
      const markings = [...road.markings ?? [], ...additions.get(road.id) ?? []];
      return {
        ...road,
        markings,
        laneSections: junctionIds && (!road.junctionId || !junctionIds.has(road.junctionId)) ? road.laneSections : addConnectorGuidance(road, network, document)
      };
    })
  };
  const withFlowMarkings = compileJunctionFlowMarkings(markedNetwork, document, junctionIds);
  return compileJunctionCornerMarkings(withFlowMarkings, document, junctionIds);
}
function incomingLaneGroups(junction) {
  const groups = new Map;
  for (const maneuver of junction.maneuvers) {
    const port = junction.ports.find((candidate) => candidate.roadId === maneuver.fromRoadId && (!maneuver.fromPortId || junctionPortId(candidate) === maneuver.fromPortId));
    if (!port)
      continue;
    const portId = junctionPortId(port);
    const key = `${portId}\x00${maneuver.fromLaneRole}`;
    const existing = groups.get(key);
    if (existing)
      existing.maneuvers.push(maneuver);
    else
      groups.set(key, {
        junction,
        portId,
        roadId: maneuver.fromRoadId,
        laneRole: maneuver.fromLaneRole,
        maneuvers: [maneuver]
      });
  }
  return [...groups.values()];
}
function approachControlKind(group) {
  const control = group.junction.control;
  if (!control || control.kind === "uncontrolled" || control.kind === "zipper")
    return;
  if (control.kind === "all-way-stop")
    return "stop-line";
  if (control.kind === "signal") {
    return control.groups.some((signalGroup) => group.maneuvers.some((maneuver) => signalGroup.participantIds.includes(maneuver.id))) ? "stop-line" : undefined;
  }
  if (control.kind === "priority") {
    return control.priorityPortIds.includes(group.portId) ? undefined : control.minorControl === "stop" ? "stop-line" : "yield-line";
  }
  const circulating = new Set(control.circulatingManeuverIds);
  return group.maneuvers.some((maneuver) => circulating.has(maneuver.id)) ? undefined : "yield-line";
}
function controlIds(group) {
  const control = group.junction.control;
  if (!control || control.kind !== "signal")
    return;
  return control.groups.filter((signalGroup) => group.maneuvers.some((maneuver) => signalGroup.participantIds.includes(maneuver.id))).map((signalGroup) => signalGroup.id);
}
function arrowForGroup(network, document, templates, group) {
  const sourceRoad = network.roads.find((candidate) => candidate.id === group.roadId);
  const sourceStroke = document.strokes.find((candidate) => candidate.id === group.roadId);
  const sourcePort = group.junction.ports.find((candidate) => junctionPortId(candidate) === group.portId);
  if (!sourceRoad || !sourceStroke || !sourcePort)
    return;
  const sourceS = sourcePort.s ?? (sourcePort.contactPoint === "start" ? 0 : sourceRoad.length);
  const sourceLaneId = laneIdForStrokeRoleAtStation(sourceStroke, sourceS, group.laneRole, templates);
  const sourceLane = laneAtStation(sourceRoad, sourceLaneId, sourceS)?.lane;
  if (!sourceLane)
    return;
  return arrowForManeuverDirections(group.maneuvers.flatMap((maneuver) => {
    const targetRoad = network.roads.find((candidate) => candidate.id === maneuver.toRoadId);
    const targetStroke = document.strokes.find((candidate) => candidate.id === maneuver.toRoadId);
    const targetPort = group.junction.ports.find((candidate) => candidate.roadId === maneuver.toRoadId && (!maneuver.toPortId || junctionPortId(candidate) === maneuver.toPortId));
    if (!targetRoad || !targetStroke || !targetPort)
      return [];
    const targetS = targetPort.s ?? (targetPort.contactPoint === "start" ? 0 : targetRoad.length);
    const targetLaneId = laneIdForStrokeRoleAtStation(targetStroke, targetS, maneuver.toLaneRole, templates);
    const targetLane = laneAtStation(targetRoad, targetLaneId, targetS)?.lane;
    if (!targetLane)
      return [];
    const direction = classifyLaneManeuver(sourceRoad, sourceLane, sourceS, targetRoad, targetLane, targetS);
    return direction ? [direction] : [];
  }));
}
function transverseMarking(road, lane, portS, distance5, spec) {
  const station = approachStation(road, lane, portS, distance5);
  if (station === undefined)
    return;
  const resolved = laneAtStation(road, lane.id, station);
  if (!resolved)
    return;
  const offsets = laneOffsetsAt(resolved.section, lane.id, station - resolved.section.s);
  return {
    ...spec,
    sStart: station,
    sEnd: station,
    tOffset: (offsets.inner + offsets.outer) * 0.5,
    tStart: Math.min(offsets.inner, offsets.outer),
    tEnd: Math.max(offsets.inner, offsets.outer)
  };
}
function laneArrowMarking(road, lane, portS, distance5, spec) {
  const station = approachStation(road, lane, portS, distance5);
  if (station === undefined)
    return;
  const resolved = laneAtStation(road, lane.id, station);
  if (!resolved)
    return;
  const offsets = laneOffsetsAt(resolved.section, lane.id, station - resolved.section.s);
  return {
    ...spec,
    kind: "arrow",
    sStart: station,
    sEnd: station,
    tOffset: (offsets.inner + offsets.outer) * 0.5,
    direction: laneTravelSign(lane) > 0 ? "forward" : "backward"
  };
}
function approachStation(road, lane, portS, requestedDistance) {
  const sign = laneTravelSign(lane);
  const available = sign > 0 ? portS : road.length - portS;
  if (available < 2)
    return;
  const distance5 = Math.min(requestedDistance, Math.max(1, available * 0.55));
  return Math.max(0, Math.min(road.length, portS - sign * distance5));
}
function hasExplicitArrow(document, group, portS) {
  return (document.markings ?? []).some((marking) => marking.kind === "arrow" && marking.roadId === group.roadId && marking.laneRole === group.laneRole && Math.abs(marking.s - portS) <= 25);
}
function hasExplicitControlLine(document, group, portS) {
  return (document.markings ?? []).some((marking) => (marking.kind === "stop-line" || marking.kind === "yield-line") && marking.roadId === group.roadId && marking.laneRoles.includes(group.laneRole) && Math.min(Math.abs(marking.sStart - portS), Math.abs(marking.sEnd - portS)) <= 8);
}
function laneAtStation(road, laneId2, s) {
  if (laneId2 === undefined)
    return;
  const section = [...road.laneSections].sort((left, right) => left.s - right.s).filter((candidate) => candidate.s <= s + 0.0000001).at(-1);
  const lane = section?.lanes.find((candidate) => candidate.id === laneId2);
  return section && lane ? { section, lane } : undefined;
}
function addConnectorGuidance(road, network, document) {
  if (road.kind !== "connector")
    return road.laneSections;
  const junction = document.junctions.find((candidate) => candidate.id === road.junctionId);
  if (!junction || resolveJunctionMarkingPlan(junction).connectorSeparators !== "derive")
    return road.laneSections;
  return road.laneSections.map((section) => {
    const additions = new Map;
    for (const side of [-1, 1]) {
      const lanes = section.lanes.filter((lane) => Math.sign(lane.id) === side && MOTOR_LANE_TYPES2.has(lane.type)).sort((left, right) => Math.abs(left.id) - Math.abs(right.id));
      for (let index = 0;index < lanes.length - 1; index++) {
        const inner = lanes[index];
        const outer = lanes[index + 1];
        if (Math.abs(outer.id) !== Math.abs(inner.id) + 1)
          continue;
        if (inner.markings?.some((marking) => marking.boundary === "outer"))
          continue;
        if (!connectorLaneHasPaintedContext(network, road, inner.id) || !connectorLaneHasPaintedContext(network, road, outer.id))
          continue;
        additions.set(inner.id, [{
          id: `generated-junction|${road.junctionId}|${road.id}|${inner.id}-${outer.id}|guide`,
          kind: "guide",
          boundary: "outer",
          sStart: section.s,
          sEnd: road.length,
          width: 0.12,
          laneChange: "none"
        }]);
      }
    }
    if (additions.size === 0)
      return section;
    return {
      ...section,
      lanes: section.lanes.map((lane) => additions.has(lane.id) ? { ...lane, markings: [...lane.markings ?? [], ...additions.get(lane.id) ?? []] } : lane)
    };
  });
}
function connectorLaneHasPaintedContext(network, connector, laneId2) {
  const connections = network.junctions.flatMap((junction) => junction.connections).filter((connection) => connection.connectingRoadId === connector.id && connection.laneLinks.some((laneLink) => laneLink.to === laneId2));
  return connections.some((connection) => {
    const source = network.roads.find((road) => road.id === connection.incomingRoadId);
    const lane = connector.laneSections[0]?.lanes.find((candidate) => candidate.id === laneId2);
    const successor = lane?.links?.successor;
    const target = successor && network.roads.find((road) => road.id === successor.roadId);
    return source && target ? roadHasLongitudinalPaint(source, connection.incomingS ?? endpointS6(source, connection.incomingContactPoint)) && roadHasLongitudinalPaint(target, successor?.s ?? endpointS6(target, successor?.contactPoint)) : false;
  });
}
function push2(markings, roadId, marking) {
  markings.set(roadId, [...markings.get(roadId) ?? [], marking]);
}
function endpointS6(road, contactPoint) {
  return contactPoint === "start" ? 0 : road.length;
}

// ../three-roads-inspect/packages/core/src/compiler/infer-junction-lane-continuations.ts
var CORNER_BAND_TYPES = new Set(["border", "sidewalk"]);
var THROUGH_BAND_TYPES = new Set([
  "border",
  "sidewalk",
  "shoulder",
  "median"
]);
var MOTOR_LANE_TYPES3 = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "bus"
]);
var COMPACT_APPROACH_LENGTH = 3;
var MAX_BAND_PROFILE_HEIGHT_DIFFERENCE = 0.3;
var MAX_BAND_CONNECTOR_GRADE = 0.5;
function inferJunctionLaneContinuations(network, _document, junction) {
  if (junction.kind !== "common" || junction.surfacePolygon || junction.surfacePatches?.length) {
    return junction;
  }
  const ports = resolvePorts(network, junction);
  if (ports.length < 2)
    return junction;
  if (!junction.profileTransition && junction.id.startsWith("auto-junction|") && ports.some(({ road }) => road.length <= COMPACT_APPROACH_LENGTH + 0.0000001))
    return junction;
  ports.sort((left, right) => normalizedAngle3(left.outwardHeading) - normalizedAngle3(right.outwardHeading) || left.id.localeCompare(right.id));
  const existing = junction.laneContinuations ?? [];
  const usedLaneRoles = new Set(existing.flatMap((continuation) => [
    `${continuation.fromPortId}:${continuation.fromLaneRole}`,
    `${continuation.toPortId}:${continuation.toLaneRole}`
  ]));
  const additions = [];
  if (ports.length === 2) {
    additions.push(...twoPortBandContinuations(ports[0], ports[1], usedLaneRoles));
    if (junction.profileTransition) {
      additions.push(...profileMorphBandContinuations(ports[0], ports[1], usedLaneRoles));
    }
    return additions.length === 0 ? junction : { ...junction, laneContinuations: [...existing, ...additions] };
  }
  for (const laneType of CORNER_BAND_TYPES) {
    const pairs = ports.map((from, index) => ({
      from,
      to: ports[(index + 1) % ports.length],
      index,
      capacity: from.lanes.filter(({ lane }) => lane.type === laneType).length + ports[(index + 1) % ports.length].lanes.filter(({ lane }) => lane.type === laneType).length
    })).sort((left, right) => right.capacity - left.capacity || left.index - right.index);
    for (const { from, to } of pairs) {
      const fromLane = cornerLane(from, laneType, "left", usedLaneRoles);
      const toLane = cornerLane(to, laneType, "right", usedLaneRoles);
      if (!fromLane || !toLane || !compatiblePhysicalBand(fromLane, toLane))
        continue;
      const continuation = {
        id: `auto-${laneType}-${from.id}-to-${to.id}`,
        fromRoadId: from.road.id,
        fromPortId: from.id,
        fromLaneRole: fromLane.role,
        toRoadId: to.road.id,
        toPortId: to.id,
        toLaneRole: toLane.role,
        requiredContinuity: "g1"
      };
      additions.push(continuation);
      usedLaneRoles.add(`${from.id}:${fromLane.role}`);
      usedLaneRoles.add(`${to.id}:${toLane.role}`);
    }
  }
  return additions.length === 0 ? junction : { ...junction, laneContinuations: [...existing, ...additions] };
}
function resolvePorts(network, junction) {
  return junction.ports.flatMap((source) => {
    const road = network.roads.find((candidate) => candidate.id === source.roadId);
    if (!road)
      return [];
    const s = Math.max(0, Math.min(road.length, source.s ?? (source.contactPoint === "start" ? 0 : road.length)));
    const section = findLaneSection(road, s);
    const motorLaneOrders = section.lanes.filter((lane) => MOTOR_LANE_TYPES3.has(lane.type)).map((lane) => Math.abs(lane.id));
    const center3 = roadToWorld(road, s, 0);
    const reference = evaluateReferenceLine(road.referenceLine, s);
    const lanes = section.lanes.flatMap((lane) => {
      if (!lane.sourceRole || !THROUGH_BAND_TYPES.has(lane.type))
        return [];
      const laneCenter = roadToWorld(road, s, laneCenterOffsetAt(section, lane.id, s - section.s));
      const contact = laneContactGeometry(road, section, lane, s);
      const bandZ = (contact.left.z + contact.right.z) * 0.5;
      return [{
        role: lane.sourceRole,
        lane,
        center: { x: laneCenter.x, y: laneCenter.y, z: bandZ },
        profileHeight: bandZ - center3.z,
        position: physicalBandPosition(lane, motorLaneOrders)
      }];
    });
    return [{
      id: junctionPortId(source),
      road,
      s,
      contactPoint: source.contactPoint,
      center: { x: center3.x, y: center3.y },
      lanes,
      outwardHeading: source.contactPoint === "start" ? reference.heading : reference.heading + Math.PI
    }];
  });
}
function twoPortBandContinuations(first, second, usedLaneRoles) {
  const additions = [];
  for (const laneType of THROUGH_BAND_TYPES) {
    const firstBands = availableBands(first, laneType, usedLaneRoles).sort((left, right) => outwardLateral(first, left) - outwardLateral(first, right));
    const secondBands = availableBands(second, laneType, usedLaneRoles).sort((left, right) => outwardLateral(second, right) - outwardLateral(second, left));
    appendBandPairs(additions, laneType, first, firstBands.filter((band) => band.lane.direction === "both"), second, secondBands.filter((band) => band.lane.direction === "both"), usedLaneRoles);
    appendBandPairs(additions, laneType, first, firstBands.filter((band) => band.lane.direction !== "both" && laneCanEnter(band.lane, first.contactPoint)), second, secondBands.filter((band) => band.lane.direction !== "both" && laneCanLeave(band.lane, second.contactPoint)), usedLaneRoles);
    appendBandPairs(additions, laneType, second, [...secondBands].reverse().filter((band) => band.lane.direction !== "both" && laneCanEnter(band.lane, second.contactPoint)), first, [...firstBands].reverse().filter((band) => band.lane.direction !== "both" && laneCanLeave(band.lane, first.contactPoint)), usedLaneRoles);
  }
  return additions;
}
function profileMorphBandContinuations(first, second, usedLaneRoles) {
  const additions = [];
  for (const position of ["inner", "outer"]) {
    const firstBands = availableProfileBands(first, position, usedLaneRoles).sort((left, right) => outwardLateral(first, left) - outwardLateral(first, right));
    const secondBands = availableProfileBands(second, position, usedLaneRoles).sort((left, right) => outwardLateral(second, right) - outwardLateral(second, left));
    for (const [firstBand, secondBand] of pairedByLateralOrder(firstBands, secondBands)) {
      if (!compatibleProfileBand(firstBand, secondBand))
        continue;
      const oriented = orientedBandPair(first, firstBand, second, secondBand);
      if (!oriented)
        continue;
      additions.push({
        id: `auto-profile-${position}-${idToken(oriented.fromPort.id)}-${idToken(oriented.fromBand.role)}-to-${idToken(oriented.toPort.id)}-${idToken(oriented.toBand.role)}`,
        fromRoadId: oriented.fromPort.road.id,
        fromPortId: oriented.fromPort.id,
        fromLaneRole: oriented.fromBand.role,
        toRoadId: oriented.toPort.road.id,
        toPortId: oriented.toPort.id,
        toLaneRole: oriented.toBand.role,
        requiredContinuity: "g1"
      });
      usedLaneRoles.add(`${first.id}:${firstBand.role}`);
      usedLaneRoles.add(`${second.id}:${secondBand.role}`);
    }
  }
  return additions;
}
function availableProfileBands(port, position, usedLaneRoles) {
  return port.lanes.filter((candidate) => candidate.position === position && !usedLaneRoles.has(`${port.id}:${candidate.role}`));
}
function orientedBandPair(firstPort, firstBand, secondPort, secondBand) {
  if (laneCanEnter(firstBand.lane, firstPort.contactPoint) && laneCanLeave(secondBand.lane, secondPort.contactPoint)) {
    return {
      fromPort: firstPort,
      fromBand: firstBand,
      toPort: secondPort,
      toBand: secondBand
    };
  }
  if (laneCanEnter(secondBand.lane, secondPort.contactPoint) && laneCanLeave(firstBand.lane, firstPort.contactPoint)) {
    return {
      fromPort: secondPort,
      fromBand: secondBand,
      toPort: firstPort,
      toBand: firstBand
    };
  }
  return;
}
function appendBandPairs(additions, laneType, fromPort, fromBands, toPort, toBands, usedLaneRoles) {
  for (const [fromBand, toBand] of pairedByLateralOrder(fromBands, toBands)) {
    if (!compatiblePhysicalBand(fromBand, toBand))
      continue;
    additions.push({
      id: `auto-through-${laneType}-${idToken(fromPort.id)}-${idToken(fromBand.role)}-to-${idToken(toPort.id)}-${idToken(toBand.role)}`,
      fromRoadId: fromPort.road.id,
      fromPortId: fromPort.id,
      fromLaneRole: fromBand.role,
      toRoadId: toPort.road.id,
      toPortId: toPort.id,
      toLaneRole: toBand.role,
      requiredContinuity: "g1"
    });
    usedLaneRoles.add(`${fromPort.id}:${fromBand.role}`);
    usedLaneRoles.add(`${toPort.id}:${toBand.role}`);
  }
}
function availableBands(port, laneType, usedLaneRoles) {
  return port.lanes.filter((candidate) => candidate.lane.type === laneType && !usedLaneRoles.has(`${port.id}:${candidate.role}`));
}
function physicalBandPosition(lane, motorLaneOrders) {
  if (lane.type === "median")
    return "inner";
  if (lane.type === "border" || lane.type === "sidewalk")
    return "outer";
  const nearestMotorOrder = Math.min(...motorLaneOrders);
  return Math.abs(lane.id) < nearestMotorOrder ? "inner" : "outer";
}
function pairedByLateralOrder(first, second) {
  const count = Math.min(first.length, second.length);
  if (count === 0)
    return [];
  if (count === 1) {
    return [[first[Math.floor((first.length - 1) / 2)], second[Math.floor((second.length - 1) / 2)]]];
  }
  return Array.from({ length: count }, (_, index) => [
    first[Math.round(index * (first.length - 1) / (count - 1))],
    second[Math.round(index * (second.length - 1) / (count - 1))]
  ]);
}
function laneCanEnter(lane, contactPoint) {
  if (lane.direction === "both")
    return true;
  const sign = laneTravelSign(lane);
  return contactPoint === "end" ? sign > 0 : sign < 0;
}
function laneCanLeave(lane, contactPoint) {
  return lane.direction === "both" || !laneCanEnter(lane, contactPoint);
}
function outwardLateral(port, band) {
  const normal = { x: -Math.sin(port.outwardHeading), y: Math.cos(port.outwardHeading) };
  return (band.center.x - port.center.x) * normal.x + (band.center.y - port.center.y) * normal.y;
}
function idToken(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}
function cornerLane(port, laneType, side, usedLaneRoles) {
  return port.lanes.filter((candidate) => candidate.lane.type === laneType && !usedLaneRoles.has(`${port.id}:${candidate.role}`)).sort((left, right) => cornerScore(right, port, side) - cornerScore(left, port, side))[0];
}
function cornerScore(candidate, port, side) {
  const sideSign = side === "left" ? 1 : -1;
  const leftNormal2 = {
    x: -Math.sin(port.outwardHeading),
    y: Math.cos(port.outwardHeading)
  };
  return sideSign * ((candidate.center.x - port.center.x) * leftNormal2.x + (candidate.center.y - port.center.y) * leftNormal2.y);
}
function compatibleAccess(left, right) {
  if (!left.access || !right.access)
    return true;
  return left.access.some((participant) => right.access?.includes(participant)) || left.access.length === 0 && right.access.length === 0;
}
function compatiblePhysicalBand(left, right) {
  return compatibleBandHeight(left, right) && compatibleAccess(left.lane, right.lane);
}
function compatibleProfileBand(left, right) {
  return compatibleBandHeight(left, right);
}
function compatibleBandHeight(left, right) {
  if (Math.abs(left.profileHeight - right.profileHeight) > MAX_BAND_PROFILE_HEIGHT_DIFFERENCE) {
    return false;
  }
  const span = Math.hypot(left.center.x - right.center.x, left.center.y - right.center.y);
  return Math.abs(left.center.z - right.center.z) <= Math.max(MAX_BAND_PROFILE_HEIGHT_DIFFERENCE, span * MAX_BAND_CONNECTOR_GRADE);
}
function normalizedAngle3(angle) {
  const fullTurn = Math.PI * 2;
  return (angle % fullTurn + fullTurn) % fullTurn;
}

// ../three-roads-inspect/packages/core/src/topology/indexed-polygon.ts
var EPSILON8 = 0.0000001;
var MIN_BUCKETS = 8;
var MAX_BUCKETS = 256;
function indexPolygon(points) {
  if (points.length < 3)
    throw new Error("Indexed polygon needs at least three points");
  const minX = Math.min(...points.map(({ x }) => x));
  const minY = Math.min(...points.map(({ y }) => y));
  const maxX = Math.max(...points.map(({ x }) => x));
  const maxY = Math.max(...points.map(({ y }) => y));
  const bucketCount = Math.max(MIN_BUCKETS, Math.min(MAX_BUCKETS, Math.ceil(Math.sqrt(points.length))));
  const bucketHeight = Math.max(EPSILON8, (maxY - minY) / bucketCount);
  const buckets = Array.from({ length: bucketCount }, () => []);
  for (let index = 0;index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const edge = { start, end, minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y) };
    const first = bucketIndex(edge.minY, minY, bucketHeight, bucketCount);
    const last = bucketIndex(edge.maxY, minY, bucketHeight, bucketCount);
    for (let bucket = first;bucket <= last; bucket++)
      buckets[bucket].push(edge);
  }
  return { points, minX, minY, maxX, maxY, bucketHeight, buckets };
}
function pointInIndexedPolygon(point, polygon, includeBoundary) {
  if (point.x < polygon.minX - EPSILON8 || point.x > polygon.maxX + EPSILON8 || point.y < polygon.minY - EPSILON8 || point.y > polygon.maxY + EPSILON8)
    return false;
  const edges = polygon.buckets[bucketIndex(point.y, polygon.minY, polygon.bucketHeight, polygon.buckets.length)];
  let inside = false;
  for (const edge of edges) {
    if (point.y < edge.minY - EPSILON8 || point.y > edge.maxY + EPSILON8)
      continue;
    if (pointOnSegment2(point, edge.start, edge.end))
      return includeBoundary;
    const crosses = edge.start.y > point.y !== edge.end.y > point.y && point.x < (edge.end.x - edge.start.x) * (point.y - edge.start.y) / (edge.end.y - edge.start.y) + edge.start.x;
    if (crosses)
      inside = !inside;
  }
  return inside;
}
function bucketIndex(y, minY, height, count) {
  return Math.max(0, Math.min(count - 1, Math.floor((y - minY) / height)));
}
function pointOnSegment2(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const cross5 = dx * (point.y - start.y) - dy * (point.x - start.x);
  if (Math.abs(cross5) > EPSILON8)
    return false;
  const dot2 = (point.x - start.x) * dx + (point.y - start.y) * dy;
  if (dot2 < -EPSILON8)
    return false;
  return dot2 <= dx * dx + dy * dy + EPSILON8;
}

// ../three-roads-inspect/packages/core/src/compiler/clip-direct-junction-edge-markings.ts
var SAMPLE_STEP = 1;
var EXPOSURE_STEP = 0.5;
var SEARCH_EPSILON = 0.0001;
var OUTWARD_PROBE = 0.05;
function clipDirectJunctionEdgeMarkings(network, junctionIds) {
  let roads = network.roads;
  const polygonCache = new Map;
  for (const junction of network.junctions.filter((candidate) => candidate.kind === "direct" && (!junctionIds || junctionIds.has(candidate.id)))) {
    roads = clipJunctionRoads(roads, junction, polygonCache);
  }
  for (const junction of network.junctions.filter((candidate) => candidate.kind === "common" && (!junctionIds || junctionIds.has(candidate.id)))) {
    roads = clipCommonJunctionEdges(roads, junction, polygonCache);
  }
  return roads === network.roads ? network : { ...network, roads };
}
function clipCommonJunctionEdges(roads, junction, polygonCache) {
  const roadIds = new Set([
    ...junction.ports?.map((port) => port.roadId) ?? [],
    ...roads.filter((road) => road.junctionId === junction.id).map((road) => road.id)
  ]);
  const junctionRoads = roads.filter((road) => roadIds.has(road.id));
  if (junctionRoads.length < 2)
    return roads;
  const markedRoadIds = new Set(junctionRoads.filter(hasOuterEdgeMarking).map((road) => road.id));
  if (markedRoadIds.size === 0)
    return roads;
  let changed = false;
  const next = roads.map((road) => {
    if (!markedRoadIds.has(road.id))
      return road;
    const coveringPolygons = junctionRoads.filter((candidate) => candidate.id !== road.id).flatMap((candidate) => roadPolygons(candidate, polygonCache));
    const contacts = junctionContacts(junction, road);
    const clipped = road.kind === "connector" ? splitCoveredEdgeMarkings(road, coveringPolygons) : contacts.length > 0 ? clipRoadMarkings(road, contacts, coveringPolygons) : road;
    if (clipped !== road)
      changed = true;
    return clipped;
  });
  return changed ? next : roads;
}
function hasOuterEdgeMarking(road) {
  return road.laneSections.some((section) => section.lanes.some((lane) => lane.markings?.some((marking) => marking.kind === "edge" && marking.boundary !== "center")));
}
function splitCoveredEdgeMarkings(road, coveringPolygons) {
  let changed = false;
  const laneSections = road.laneSections.map((section) => ({
    ...section,
    lanes: section.lanes.map((lane) => {
      const markings = lane.markings?.flatMap((marking) => {
        if (marking.kind !== "edge" || marking.boundary === "center")
          return [marking];
        const segments = exposedSegments(road, section, lane, marking, coveringPolygons);
        if (segments.length === 1 && segments[0].sStart === marking.sStart && segments[0].sEnd === marking.sEnd)
          return [marking];
        changed = true;
        return segments.map((segment, index) => segments.length === 1 ? segment : { ...segment, id: `${marking.id}|exposed-${index}` });
      });
      return markings && markings !== lane.markings ? { ...lane, markings } : lane;
    })
  }));
  return changed ? { ...road, laneSections } : road;
}
function exposedSegments(road, section, lane, marking, coveringPolygons) {
  const start = Math.max(section.s, marking.sStart ?? section.s);
  const end = Math.min(sectionEnd(road, section), marking.sEnd ?? sectionEnd(road, section));
  if (end - start <= 0.0000001)
    return [];
  const stations = [start];
  for (let s = start + EXPOSURE_STEP;s < end - 0.0000001; s += EXPOSURE_STEP)
    stations.push(s);
  stations.push(end);
  const exposed = stations.map((s) => !coveredOutsideAt(road, section, lane, marking, s, coveringPolygons));
  if (exposed.every(Boolean))
    return [marking];
  const boundaries = [start];
  for (let index = 1;index < stations.length; index++) {
    if (exposed[index] === exposed[index - 1])
      continue;
    boundaries.push(refineOutsideExposureBoundary(road, section, lane, marking, stations[index - 1], stations[index], exposed[index - 1], coveringPolygons));
  }
  boundaries.push(end);
  const segments = [];
  for (let index = 0;index < boundaries.length - 1; index++) {
    const segmentStart = boundaries[index];
    const segmentEnd = boundaries[index + 1];
    if (coveredOutsideAt(road, section, lane, marking, (segmentStart + segmentEnd) * 0.5, coveringPolygons))
      continue;
    if (segmentEnd - segmentStart > 0.0001)
      segments.push({ ...marking, sStart: segmentStart, sEnd: segmentEnd });
  }
  return segments;
}
function refineOutsideExposureBoundary(road, section, lane, marking, leftStation, rightStation, leftExposed, coveringPolygons) {
  let left = leftStation;
  let right = rightStation;
  for (let iteration = 0;iteration < 12; iteration++) {
    const midpoint = (left + right) * 0.5;
    const midpointExposed = !coveredOutsideAt(road, section, lane, marking, midpoint, coveringPolygons);
    if (midpointExposed === leftExposed)
      left = midpoint;
    else
      right = midpoint;
  }
  return (left + right) * 0.5;
}
function coveredOutsideAt(road, section, lane, marking, s, coveringPolygons) {
  const offsets = laneOffsetsAt(section, lane.id, s - section.s);
  const boundary = marking.boundary === "inner" ? "inner" : "outer";
  const boundaryOffset = offsets[boundary];
  const otherOffset = offsets[boundary === "inner" ? "outer" : "inner"];
  const outwardSign = Math.sign(boundaryOffset - otherOffset) || 1;
  const point = roadToWorld(road, s, boundaryOffset + outwardSign * OUTWARD_PROBE);
  return coveringPolygons.some((polygon) => pointInIndexedPolygon(point, polygon, false));
}
function clipJunctionRoads(roads, junction, polygonCache) {
  const roadIds = new Set(junction.ports?.map((port) => port.roadId) ?? junction.connections.flatMap((connection) => [connection.incomingRoadId, connection.connectingRoadId]));
  const junctionRoads = roads.filter((road) => roadIds.has(road.id));
  if (junctionRoads.length < 2)
    return roads;
  let changed = false;
  const next = roads.map((road) => {
    if (!roadIds.has(road.id))
      return road;
    const contacts = junctionContacts(junction, road);
    if (contacts.length === 0)
      return road;
    const coveringPolygons = junctionRoads.filter((candidate) => candidate.id !== road.id).flatMap((candidate) => roadPolygons(candidate, polygonCache));
    const clipped = clipRoadMarkings(road, contacts, coveringPolygons);
    if (clipped !== road)
      changed = true;
    return clipped;
  });
  return changed ? next : roads;
}
function roadPolygons(road, cache) {
  const existing = cache.get(road.id);
  if (existing)
    return existing;
  const polygons = sampleLanePolygons(road, SAMPLE_STEP).filter((polygon) => polygon.laneId !== 0).map((polygon) => indexPolygon(polygon.points));
  cache.set(road.id, polygons);
  return polygons;
}
function junctionContacts(junction, road) {
  const ports = junction.ports?.filter((port) => port.roadId === road.id) ?? [];
  if (ports.length > 0)
    return ports.map((port) => port.s ?? (port.contactPoint === "start" ? 0 : road.length));
  return junction.connections.flatMap((connection) => {
    const stations = [];
    if (connection.incomingRoadId === road.id) {
      stations.push(connection.incomingS ?? (connection.incomingContactPoint === "start" ? 0 : road.length));
    }
    if (connection.connectingRoadId === road.id) {
      stations.push(connection.connectingS ?? (connection.contactPoint === "end" ? road.length : 0));
    }
    return stations;
  });
}
function clipRoadMarkings(road, contacts, coveringPolygons) {
  let changed = false;
  const laneSections = road.laneSections.map((section) => ({
    ...section,
    lanes: section.lanes.map((lane) => {
      const markings = lane.markings?.flatMap((marking) => {
        if (marking.kind !== "edge" || marking.boundary === "center")
          return [marking];
        let next = marking;
        for (const contact of contacts) {
          next = clipAtContact(road, section, lane, next, contact, coveringPolygons);
          if (!next)
            break;
        }
        if (!next) {
          changed = true;
          return [];
        }
        if (next.sStart !== marking.sStart || next.sEnd !== marking.sEnd)
          changed = true;
        return [next];
      });
      return markings && markings !== lane.markings ? { ...lane, markings } : lane;
    })
  }));
  return changed ? { ...road, laneSections } : road;
}
function clipAtContact(road, section, lane, marking, contact, coveringPolygons) {
  const start = Math.max(section.s, marking.sStart ?? section.s);
  const end = Math.min(sectionEnd(road, section), marking.sEnd ?? sectionEnd(road, section));
  const atStart = Math.abs(contact - start) <= 0.0000001;
  const atEnd = Math.abs(contact - end) <= 0.0000001;
  if (!atStart && !atEnd)
    return marking;
  const direction = atEnd ? -1 : 1;
  const insideStation = Math.max(start, Math.min(end, contact + direction * SEARCH_EPSILON));
  if (!coveredAt(road, section, lane, marking, insideStation, coveringPolygons))
    return marking;
  let covered = insideStation;
  let exposed = covered;
  while (direction < 0 ? exposed > start : exposed < end) {
    exposed = Math.max(start, Math.min(end, exposed + direction * SAMPLE_STEP));
    if (!coveredAt(road, section, lane, marking, exposed, coveringPolygons))
      break;
  }
  if (exposed === covered || coveredAt(road, section, lane, marking, exposed, coveringPolygons))
    return;
  const boundary = refineExposureBoundary(road, section, lane, marking, exposed, covered, coveringPolygons);
  const clipped = atEnd ? { ...marking, sEnd: boundary } : { ...marking, sStart: boundary };
  return (clipped.sEnd ?? end) - (clipped.sStart ?? start) > 0.0000001 ? clipped : undefined;
}
function refineExposureBoundary(road, section, lane, marking, exposedStation, coveredStation, coveringPolygons) {
  let exposed = exposedStation;
  let covered = coveredStation;
  for (let iteration = 0;iteration < 20; iteration++) {
    const midpoint = (exposed + covered) * 0.5;
    if (coveredAt(road, section, lane, marking, midpoint, coveringPolygons))
      covered = midpoint;
    else
      exposed = midpoint;
  }
  return exposed;
}
function coveredAt(road, section, lane, marking, s, coveringPolygons) {
  const boundary = marking.boundary === "inner" ? "inner" : "outer";
  const offset = laneOffsetsAt(section, lane.id, s - section.s)[boundary];
  const point = roadToWorld(road, s, offset);
  return coveringPolygons.some((polygon) => pointInIndexedPolygon(point, polygon, false));
}
function sectionEnd(road, section) {
  return road.laneSections.find((candidate) => candidate.s > section.s)?.s ?? road.length;
}

// ../three-roads-inspect/packages/core/src/compiler/compile-protected-cycle-corners.ts
var MOTOR_LANE_TYPES4 = new Set(["driving", "entry", "exit", "on-ramp", "off-ramp", "shared", "bus"]);
function compileProtectedCycleCorners(network, facilities, maneuverRoadIds, junctions) {
  let objects = [...network.objects ?? []];
  for (const facility of [...facilities].sort((a, b) => a.id.localeCompare(b.id))) {
    validateCornerRelationship(facility, junctions);
    const cycleRoads = movementRoads(network, facility, facility.config.cycleManeuverId);
    const trafficRoads = movementRoads(network, facility, facility.config.adjacentTrafficManeuverId);
    const cycle = cycleRoads.flatMap((road) => sampleLanePolygons(road, 0.25));
    const traffic = trafficRoads.flatMap((road) => sampleLanePolygons(road, 0.25));
    if (!cycle.some(({ laneType }) => laneType === "biking"))
      fail(facility, "cycle maneuver has no bicycle connector pavement");
    if (!traffic.some(({ laneType }) => MOTOR_LANE_TYPES4.has(laneType)))
      fail(facility, "adjacent maneuver is not motor-compatible");
    const cycleTrimmed = cycleRoads.flatMap((road) => trimmedPavement(road, facility));
    const trafficTrimmed = trafficRoads.flatMap((road) => trimmedPavement(road, facility));
    const junctionPavement = network.roads.filter((road) => road.kind === "connector" && road.junctionId === facility.junctionId).flatMap((road) => sampleLanePolygons(road, 0.25).map(({ points }) => points));
    const polygon = gapRectangle(cycleTrimmed.flat(), trafficTrimmed.flat(), junctionPavement, facility);
    if (!isSimplePolygonRing(polygon) || polygon.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y)))
      fail(facility, "derived island polygon is invalid");
    if (junctionPavement.some((surface) => polygonComponentsArea(intersectPolygons(polygon, [surface])) > 0.000001))
      fail(facility, "derived island overlaps movement pavement");
    objects.push({ id: `${facility.id}|island`, junctionId: facility.junctionId, kind: "island", s: 0, t: 0, height: facility.config.islandHeight, polygon });
  }
  return { ...network, objects };
  function movementRoads(current, facility, maneuverId) {
    const key = `${facility.junctionId}:${maneuverId}`;
    const ids = maneuverRoadIds[key];
    if (!ids?.length)
      fail(facility, `maneuver ${maneuverId} does not resolve through junction ${facility.junctionId}`);
    return current.roads.filter(({ id }) => ids.includes(id));
  }
}
function gapRectangle(cycle, traffic, pavement, facility) {
  const clearance = facility.config.minimumClearance ?? 0;
  const cycleCandidates = cycle.filter((_, index) => index % 8 === 0);
  const trafficCandidates = traffic.filter((_, index) => index % 8 === 0);
  const pairs = cycleCandidates.flatMap((a) => trafficCandidates.map((b) => ({ a, b, distance: Math.hypot(b.x - a.x, b.y - a.y) }))).filter(({ distance: distance5 }) => distance5 > clearance * 2 + 0.05 && Number.isFinite(distance5)).sort((left, right) => left.distance - right.distance || left.a.x - right.a.x || left.a.y - right.a.y).slice(0, 300);
  if (pairs.length === 0)
    fail(facility, "minimum clearance leaves no separator width");
  for (const pair of pairs) {
    const nx = (pair.b.x - pair.a.x) / pair.distance, ny = (pair.b.y - pair.a.y) / pair.distance;
    const tx = -ny, ty = nx;
    const cx = (pair.a.x + pair.b.x) / 2, cy = (pair.a.y + pair.b.y) / 2;
    for (let across = Math.min(facility.config.islandWidth, pair.distance - clearance * 2 - 0.02);across >= 0.05; across *= 0.75) {
      const hx = across / 2;
      for (let along = Math.min(6, trimmedExtent(cycle), trimmedExtent(traffic));along >= 0.1; along *= 0.75) {
        const hy = along / 2;
        const polygon = [
          { x: cx - nx * hx - tx * hy, y: cy - ny * hx - ty * hy },
          { x: cx + nx * hx - tx * hy, y: cy + ny * hx - ty * hy },
          { x: cx + nx * hx + tx * hy, y: cy + ny * hx + ty * hy },
          { x: cx - nx * hx + tx * hy, y: cy - ny * hx + ty * hy }
        ];
        const probes = [
          ...polygon,
          { x: cx, y: cy },
          ...polygon.map((point, index) => ({ x: (point.x + polygon[(index + 1) % 4].x) / 2, y: (point.y + polygon[(index + 1) % 4].y) / 2 }))
        ];
        if (pavement.some((surface) => probes.some((point) => pointInPolygon(point, surface, true))))
          continue;
        if (pavement.every((surface) => polygonComponentsArea(intersectPolygons(polygon, [surface])) <= 0.000001))
          return polygon;
      }
    }
  }
  fail(facility, "trimmed connector gap has no non-overlapping island area");
}
function trimmedPavement(road, facility) {
  const length = referenceLineLength(road.referenceLine);
  const start = facility.config.approachSetback;
  const end = length - facility.config.departureSetback;
  if (end <= start + 0.1)
    fail(facility, `setbacks consume connector ${road.id}`);
  return road.laneSections.flatMap((section) => section.lanes.filter(({ id }) => id !== 0).map(({ id }) => sampleLanePolygon(road, section, id, Math.max(start, section.s), end, 0.25)));
}
function trimmedExtent(points) {
  if (points.length < 2)
    return 0;
  const xs = points.map(({ x }) => x), ys = points.map(({ y }) => y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}
function validateCornerRelationship(facility, junctions) {
  const junction = junctions.find(({ id }) => id === facility.junctionId);
  if (!junction)
    fail(facility, "junction reference is unresolved");
  const cycle = junction.maneuvers.find(({ id }) => id === facility.config.cycleManeuverId);
  const traffic = junction.maneuvers.find(({ id }) => id === facility.config.adjacentTrafficManeuverId);
  if (!cycle)
    fail(facility, `cycle maneuver ${facility.config.cycleManeuverId} is not in the junction`);
  if (!traffic)
    fail(facility, `adjacent maneuver ${facility.config.adjacentTrafficManeuverId} is not in the junction`);
  if (cycle.fromRoadId !== traffic.fromRoadId || cycle.toRoadId !== traffic.toRoadId)
    fail(facility, "maneuvers do not share the same approach and departure corner");
}
function fail(facility, message) {
  throw new Error(`Facility ${facility.id} (${facility.junctionId}): ${message}`);
}

// ../three-roads-inspect/packages/core/src/facilities/materialize-facility.ts
function materializeFacilities(facilities) {
  return facilities.map((facility) => {
    if (facility.kind !== "parking-run")
      return materializeFacility(facility);
    const clearIntervals = facilities.filter((candidate) => candidate.kind === "driveway" && candidate.strokeId === facility.strokeId && candidate.config.side === facility.config.side && candidate.sStart < facility.sEnd && candidate.sEnd > facility.sStart).map((candidate) => ({ sStart: candidate.sStart, sEnd: candidate.sEnd })).sort((a, b) => a.sStart - b.sStart || a.sEnd - b.sEnd);
    return materializeFacility(facility, clearIntervals);
  });
}
function materializeFacility(facility, parkingClearIntervals = []) {
  if (facility.kind === "protected-cycle-corner") {
    return { markings: [], objects: [], surfaceElevations: [], regulations: [] };
  }
  if (facility.kind === "pedestrian-crossing") {
    return {
      markings: [{
        id: `${facility.id}|marking`,
        facilityId: facility.id,
        roadId: facility.strokeId,
        laneRoles: [...facility.config.laneRoles],
        kind: facility.config.marking,
        sStart: facility.sStart,
        sEnd: facility.sEnd,
        width: facility.config.width
      }],
      objects: [],
      surfaceElevations: [],
      regulations: []
    };
  }
  if (facility.kind === "raised-table") {
    const marking = facility.config.marking ?? "none";
    return {
      markings: marking === "none" ? [] : [{
        id: `${facility.id}|marking`,
        facilityId: facility.id,
        roadId: facility.strokeId,
        laneRoles: [...facility.config.laneRoles],
        kind: marking,
        sStart: facility.sStart,
        sEnd: facility.sEnd
      }],
      objects: [],
      surfaceElevations: [{
        id: `${facility.id}|surface`,
        facilityId: facility.id,
        roadId: facility.strokeId,
        kind: "raised-table",
        sStart: facility.sStart,
        sEnd: facility.sEnd,
        height: facility.config.height,
        rampLength: facility.config.rampLength
      }],
      regulations: []
    };
  }
  if (facility.kind === "driveway") {
    return {
      markings: [],
      objects: [{
        id: `${facility.id}|driveway`,
        facilityId: facility.id,
        roadId: facility.strokeId,
        laneRole: facility.config.laneRole,
        anchor: "center",
        containment: "lane",
        allowedLaneTypes: facility.config.allowedLaneTypes,
        kind: "driveway",
        s: (facility.sStart + facility.sEnd) / 2,
        length: facility.sEnd - facility.sStart,
        width: facility.config.width
      }],
      surfaceElevations: [],
      regulations: []
    };
  }
  if (facility.kind === "traffic-calming-gateway") {
    return materializeTrafficCalmingGateway(facility);
  }
  const override = {
    id: `${facility.id}|override`,
    facilityId: facility.id,
    sStart: facility.sStart,
    sEnd: facility.sEnd,
    transitionLength: facility.config.transitionLength,
    laneChanges: facilityLanes(facility).map((lane) => ({ operation: "add", lane }))
  };
  const objects = [];
  const plateauStart = facility.sStart + (facility.config.transitionLength ?? 0);
  const plateauEnd = facility.sEnd;
  const plateauLength = Math.max(0, plateauEnd - plateauStart);
  if (facility.kind === "parking-run") {
    const count = Math.max(1, Math.floor(plateauLength / facility.config.spacing));
    const stallOrdinals = Array.from({ length: count }, (_, ordinal) => ordinal).filter((ordinal) => {
      const center = plateauStart + facility.config.stallLength / 2 + ordinal * facility.config.spacing;
      const stallStart = center - facility.config.stallLength / 2;
      const stallEnd = center + facility.config.stallLength / 2;
      return !parkingClearIntervals.some(({ sStart, sEnd }) => stallStart < sEnd && stallEnd > sStart);
    });
    const groups = parkingClearIntervals.length === 0 ? [stallOrdinals] : consecutiveOrdinalGroups(stallOrdinals);
    for (const group of groups) {
      if (group.length === 0)
        continue;
      const first = group[0];
      const last = group[group.length - 1];
      objects.push({
        id: parkingClearIntervals.length === 0 ? `${facility.id}|stalls` : `${facility.id}|stalls|${first}-${last}`,
        facilityId: facility.id,
        roadId: facility.strokeId,
        laneRole: facility.config.laneRole,
        anchor: "center",
        containment: "lane",
        allowedLaneTypes: ["parking"],
        kind: "parking-space",
        orientation: facility.config.orientation,
        angle: facility.config.angle,
        s: plateauStart + facility.config.stallLength / 2 + first * facility.config.spacing,
        length: facility.config.stallLength,
        width: facility.config.stallWidth,
        repeat: { count: group.length, spacing: facility.config.spacing }
      });
    }
  } else if (facility.kind === "bus-bay" && facility.config.stopObject) {
    const length = Math.min(12, plateauLength);
    objects.push({
      id: `${facility.id}|stop`,
      facilityId: facility.id,
      roadId: facility.strokeId,
      laneRole: facility.config.laneRole,
      anchor: "center",
      containment: "lane",
      kind: "platform",
      s: (plateauStart + plateauEnd) / 2,
      length,
      width: facility.config.width * 0.8
    });
  } else if (facility.kind === "tram-stop-island") {
    objects.push({
      id: `${facility.id}|platform`,
      facilityId: facility.id,
      roadId: facility.strokeId,
      laneRole: facility.config.laneRole,
      anchor: "center",
      containment: "lane",
      allowedLaneTypes: ["sidewalk"],
      kind: "platform",
      s: (plateauStart + plateauEnd) / 2,
      length: plateauLength,
      width: facility.config.width,
      height: facility.config.platformHeight
    });
  }
  return { override, markings: [], objects, surfaceElevations: [], regulations: [] };
}
function materializeTrafficCalmingGateway(facility) {
  const { config } = facility;
  const plateauStart = facility.sStart + config.transitionLength;
  const regulationId = `${facility.id}|maximum-speed`;
  const islandHalfWidth = config.islandWidth / 2;
  const laneChanges = [];
  for (const side of ["left", "right"]) {
    const trafficRole = side === "left" ? config.leftTrafficLaneRole : config.rightTrafficLaneRole;
    laneChanges.push({
      operation: "add",
      lane: {
        role: `${facility.id}|${side}-island-half`,
        side,
        order: 1,
        type: "median",
        width: islandHalfWidth,
        direction: "both",
        access: [],
        heights: [{ sOffset: 0, inner: config.islandHeight, outer: config.islandHeight }],
        boundaryMarkings: [{
          id: `${facility.id}|${side}-island-curb`,
          kind: "curb",
          boundary: "outer",
          width: 0.15,
          laneChange: "none"
        }]
      }
    }, {
      operation: "add",
      lane: {
        role: `${facility.id}|${side}-curb-ramp`,
        side,
        order: 2,
        type: "border",
        width: 0.2,
        direction: "both",
        access: [],
        heights: [{ sOffset: 0, inner: config.islandHeight, outer: 0 }]
      }
    }, {
      operation: "update",
      role: trafficRole,
      values: {
        width: config.narrowedLaneWidth,
        boundaryMarkings: []
      }
    });
  }
  const override = {
    id: `${facility.id}|override`,
    facilityId: facility.id,
    sStart: facility.sStart,
    sEnd: facility.sEnd,
    transitionLength: config.transitionLength,
    laneChanges
  };
  const signStation = Math.min(config.regulationEnd, plateauStart + 1);
  const objects = [
    ["left", config.leftRoadsideLaneRole],
    ["right", config.rightRoadsideLaneRole]
  ].map(([side, laneRole]) => ({
    id: `${facility.id}|${side}-speed-sign`,
    facilityId: facility.id,
    roadId: facility.strokeId,
    laneRole,
    anchor: "inner",
    inset: 0.65,
    containment: "lane",
    kind: "traffic-sign",
    regulationIds: [regulationId],
    s: signStation,
    length: 0.25,
    width: 0.65,
    height: 2.2
  }));
  return {
    override,
    markings: [],
    objects,
    surfaceElevations: [],
    regulations: [{
      id: regulationId,
      facilityId: facility.id,
      kind: "maximum-speed",
      roadId: facility.strokeId,
      laneRoles: [config.leftTrafficLaneRole, config.rightTrafficLaneRole],
      sStart: plateauStart,
      sEnd: config.regulationEnd,
      maximumKph: config.maximumKph
    }]
  };
}
function consecutiveOrdinalGroups(ordinals) {
  const groups = [];
  for (const ordinal of ordinals) {
    const group = groups.at(-1);
    if (!group || ordinal !== group[group.length - 1] + 1)
      groups.push([ordinal]);
    else
      group.push(ordinal);
  }
  return groups;
}
function facilityLanes(facility) {
  if (facility.kind === "tram-stop-island") {
    const { laneRole, side, order, width, platformHeight } = facility.config;
    return [
      {
        role: `${laneRole}|inner-ramp`,
        side,
        order,
        type: "border",
        width: 0.18,
        direction: "both",
        heights: [{ sOffset: 0, inner: 0, outer: platformHeight }]
      },
      {
        role: laneRole,
        side,
        order: order + 1,
        type: "sidewalk",
        width,
        direction: "both",
        heights: [{ sOffset: 0, inner: platformHeight, outer: platformHeight }],
        access: ["pedestrian"]
      },
      {
        role: `${laneRole}|outer-ramp`,
        side,
        order: order + 2,
        type: "border",
        width: 0.18,
        direction: "both",
        heights: [{ sOffset: 0, inner: platformHeight, outer: 0 }]
      }
    ];
  }
  const type = facility.kind === "parking-run" || facility.kind === "loading-bay" ? "parking" : "shoulder";
  const access = facility.kind === "bus-bay" ? ["bus"] : facility.kind === "emergency-lay-by" ? ["emergency"] : ["car"];
  return [{
    role: facility.config.laneRole,
    side: facility.config.side,
    order: facility.config.order,
    type,
    width: facility.config.width,
    access
  }];
}

// ../three-roads-inspect/packages/core/src/compiler/incremental-compile-reuse.ts
function indexConnectorsByJunction(roads) {
  const result = new Map;
  for (const road of roads) {
    if (road.kind !== "connector" || !road.junctionId)
      continue;
    const connectors = result.get(road.junctionId);
    if (connectors)
      connectors.push(road);
    else
      result.set(road.junctionId, [road]);
  }
  return result;
}
function indexJunctionSourceMap(source) {
  const result = new Map;
  for (const [key, value] of Object.entries(source)) {
    const separator = key.indexOf(":");
    if (separator < 0)
      continue;
    const junctionId = key.slice(0, separator);
    const entries = result.get(junctionId);
    if (entries)
      entries.push([key, value]);
    else
      result.set(junctionId, [[key, value]]);
  }
  return result;
}
function copyIndexedJunctionSourceMap(source, target, junctionId) {
  for (const [key, value] of source.get(junctionId) ?? []) {
    target[key] = structuredClone(value);
  }
}

// ../three-roads-inspect/packages/core/src/compiler/compile-road-network.ts
function compileRoadNetwork(document, options = {}) {
  const profileStart = performance.now();
  let profilePrevious = profileStart;
  const profile = (stage) => {
    if (document.id !== "connected-edit-grid" || !options.incremental)
      return;
    const now = performance.now();
    console.info(`[three-roads-core-stage] ${stage} ${Math.round(now - profilePrevious)}`);
    profilePrevious = now;
  };
  const interactiveCompilation = options.validationProfile === "interactive";
  const sourceValidation = interactiveCompilation ? { ok: true, diagnostics: [] } : validateRoadAuthoringDocument(document);
  const sourceMap = {
    roads: {},
    junctions: {},
    maneuvers: {},
    maneuverLanes: {},
    laneContinuations: {},
    gradeSeparations: {},
    roadStructures: {},
    roadsideFeatures: {},
    roadSurfaceElevations: {},
    weavingSections: {},
    facilities: {}
  };
  indexFacilitySources(sourceMap, document.facilities ?? []);
  if (!sourceValidation.ok)
    return { ok: false, diagnostics: sourceValidation.diagnostics, sourceMap };
  const trafficManagement = resolveTrafficManagement(document, options);
  if (trafficManagement.diagnostics.length > 0) {
    return { ok: false, diagnostics: trafficManagement.diagnostics, sourceMap };
  }
  document = trafficManagement.document;
  try {
    const templates = new Map(document.templates.map((template) => [template.id, template]));
    const reusable = options.incremental?.previousCompilation.network?.id === document.id ? options.incremental : undefined;
    const dirtyRoadIds = new Set(reusable?.dirtyRoadIds ?? []);
    const dirtyJunctionIds = new Set(reusable?.dirtyJunctionIds ?? []);
    const previousRoads = new Map(reusable?.previousCompilation.network?.roads.map((road) => [road.id, road]) ?? []);
    const previousJunctions = new Map(reusable?.previousCompilation.network?.junctions.map((junction) => [junction.id, junction]) ?? []);
    const previousConnectorsByJunction = indexConnectorsByJunction(reusable?.previousCompilation.network?.roads ?? []);
    const previousJunctionSourceMaps = reusable ? {
      maneuvers: indexJunctionSourceMap(reusable.previousCompilation.sourceMap.maneuvers),
      maneuverLanes: indexJunctionSourceMap(reusable.previousCompilation.sourceMap.maneuverLanes),
      laneContinuations: indexJunctionSourceMap(reusable.previousCompilation.sourceMap.laneContinuations)
    } : undefined;
    let network = createRoadNetwork({ id: document.id, name: document.name });
    for (const stroke of document.strokes) {
      const previousRoadId = reusable?.previousCompilation.sourceMap.roads[stroke.id];
      const previousRoad = previousRoadId ? previousRoads.get(previousRoadId) : undefined;
      if (previousRoad && !dirtyRoadIds.has(stroke.id)) {
        network = { ...network, roads: [...network.roads, previousRoad] };
        sourceMap.roads[stroke.id] = previousRoad.id;
        continue;
      }
      const compiled = compileRoadStroke(stroke, templates);
      network = { ...network, roads: [...network.roads, compiled.road] };
      sourceMap.roads[stroke.id] = compiled.road.id;
    }
    network = compileRoadStrokeLinks(network, document, templates);
    const roadSurfaceElevations = structuredClone(document.roadSurfaceElevations ?? []);
    network = {
      ...network,
      roadSurfaceElevations
    };
    for (const elevation of roadSurfaceElevations) {
      sourceMap.roadSurfaceElevations[elevation.id] = elevation.id;
    }
    const roadStructureCompilation = compileRoadStructures(network, document.roadStructures ?? []);
    network = { ...network, roadStructures: roadStructureCompilation.roadStructures };
    for (const structure of roadStructureCompilation.roadStructures) {
      sourceMap.roadStructures[structure.id] = structure.id;
    }
    const roadsideFeatures = compileRoadsideFeatures(network, document.roadsideFeatures ?? []);
    network = { ...network, roadsideFeatures };
    for (const feature of roadsideFeatures)
      sourceMap.roadsideFeatures[feature.id] = feature.id;
    const gradeSeparationCompilation = compileGradeSeparations(network, document.gradeSeparations ?? []);
    network = { ...network, gradeSeparations: gradeSeparationCompilation.gradeSeparations };
    for (const gradeSeparation of gradeSeparationCompilation.gradeSeparations) {
      sourceMap.gradeSeparations[gradeSeparation.id] = gradeSeparation.id;
    }
    profile("roads");
    const resolvedJunctions = [];
    for (const junction of document.junctions) {
      if (reusable && !dirtyJunctionIds.has(junction.id)) {
        const reused = reuseCompiledJunction(network, junction, reusable.previousCompilation, sourceMap, previousJunctions, previousConnectorsByJunction, previousJunctionSourceMaps);
        if (reused) {
          network = reused;
          resolvedJunctions.push(structuredClone(junction));
          continue;
        }
      }
      const resolvedJunction = inferJunctionLaneContinuations(network, document, junction);
      resolvedJunctions.push(resolvedJunction);
      network = compileJunction(network, document, resolvedJunction, templates, sourceMap, options.validationProfile !== "interactive");
    }
    profile("junctions");
    network = {
      ...network,
      junctionGroups: (document.junctionGroups ?? []).map(({ activation, ...group }) => ({
        ...structuredClone(group),
        operational: activationProvenance(activation, group.id)
      }))
    };
    network = compileTrafficManagement(network, trafficManagement);
    network = compileLaneMarkingIntents(network, document, templates);
    const resolvedDocument = { ...document, junctions: resolvedJunctions };
    network = compileJunctionMarkings(network, resolvedDocument, templates, reusable ? dirtyJunctionIds : undefined);
    profile("markings");
    if (reusable) {
      network = reuseStableCompiledRoads(network, reusable, sourceMap);
    }
    network = clipDirectJunctionEdgeMarkings(network, reusable ? dirtyJunctionIds : undefined);
    network = compileLaneObjectIntents(network, document, templates);
    const protectedCorners = (document.facilities ?? []).filter((facility) => facility.kind === "protected-cycle-corner");
    network = compileProtectedCycleCorners(network, protectedCorners, sourceMap.maneuvers, document.junctions);
    network = {
      ...network,
      weavingSections: compileWeavingSections(network, document.weavingSections ?? [])
    };
    if (reusable)
      network = reuseStableCompiledRoads(network, reusable, sourceMap);
    profile("decorations");
    for (const weaving of network.weavingSections ?? [])
      sourceMap.weavingSections[weaving.id] = weaving.id;
    const strictValidation = interactiveCompilation ? { ok: true, diagnostics: [] } : validateRoadNetwork(network, {
      designRecommendationSeverity: options.validationProfile === "interactive" ? "warning" : "error"
    });
    const validation = options.validationProfile === "interactive" ? applyInteractiveRoadValidationPolicy(strictValidation) : strictValidation;
    const physicalTopology = validation.ok ? buildRoadPhysicalTopology(network, reusable?.previousCompilation.network && reusable.previousCompilation.physicalTopology ? {
      previousNetwork: reusable.previousCompilation.network,
      previousTopology: reusable.previousCompilation.physicalTopology
    } : undefined) : undefined;
    profile("physical");
    const physicalValidation = physicalTopology && !interactiveCompilation ? validateRoadPhysicalTopology(network, physicalTopology, {
      junctionSurfaceOwnership: options.validationProfile !== "interactive",
      trafficInteractions: options.validationProfile !== "interactive"
    }) : { ok: interactiveCompilation, diagnostics: [] };
    const diagnostics = [
      ...roadStructureCompilation.diagnostics,
      ...gradeSeparationCompilation.diagnostics,
      ...validation.diagnostics,
      ...physicalValidation.diagnostics
    ];
    const ok = roadStructureCompilation.diagnostics.length === 0 && gradeSeparationCompilation.diagnostics.length === 0 && validation.ok && physicalValidation.ok;
    return {
      ok,
      network: ok ? network : undefined,
      physicalTopology: ok ? physicalTopology : undefined,
      diagnostics,
      sourceMap
    };
  } catch (error12) {
    const message = error12 instanceof Error ? error12.message : String(error12);
    const facilityId = /^Facility ([^ ]+)/.exec(message)?.[1];
    return {
      ok: false,
      diagnostics: [{ severity: "error", code: facilityId ? "facility-compilation-failed" : "compilation-failed", message, sourceId: facilityId }],
      sourceMap
    };
  }
}
function indexFacilitySources(sourceMap, facilities) {
  const materialized = materializeFacilities(facilities);
  facilities.forEach((facility, index) => {
    if (facility.kind === "protected-cycle-corner") {
      sourceMap.facilities[facility.id] = [`${facility.id}|island`];
      return;
    }
    const result = materialized[index];
    if (!result)
      return;
    sourceMap.facilities[facility.id] = [
      ...result.override ? [result.override.id] : [],
      ...result.markings.map(({ id }) => id),
      ...result.objects.map(({ id }) => id),
      ...result.surfaceElevations.map(({ id }) => id),
      ...result.regulations.map(({ id }) => id)
    ].sort();
  });
}
function reuseCompiledJunction(network, source, previous, sourceMap, previousJunctions, previousConnectorsByJunction, previousSourceMaps) {
  const previousNetwork = previous.network;
  const junction = previousJunctions.get(source.id);
  if (!previousNetwork || !junction)
    return;
  const connectors = previousConnectorsByJunction.get(source.id) ?? [];
  sourceMap.junctions[source.id] = previous.sourceMap.junctions[source.id] ?? source.id;
  copyIndexedJunctionSourceMap(previousSourceMaps.maneuvers, sourceMap.maneuvers, source.id);
  copyIndexedJunctionSourceMap(previousSourceMaps.maneuverLanes, sourceMap.maneuverLanes, source.id);
  copyIndexedJunctionSourceMap(previousSourceMaps.laneContinuations, sourceMap.laneContinuations, source.id);
  return {
    ...network,
    roads: [...network.roads, ...connectors],
    junctions: [...network.junctions, junction]
  };
}
function reuseStableCompiledRoads(network, reuse, sourceMap) {
  const previousNetwork = reuse.previousCompilation.network;
  if (!previousNetwork)
    return network;
  const dirtyCompiledRoadIds = new Set(reuse.dirtyRoadIds.flatMap((sourceId) => {
    const roadId = sourceMap.roads[sourceId];
    return roadId ? [roadId] : [];
  }));
  for (const junctionId of reuse.dirtyJunctionIds) {
    const junction = network.junctions.find((candidate) => candidate.id === junctionId);
    for (const roadId of junction?.connections.map((connection) => connection.connectingRoadId) ?? []) {
      dirtyCompiledRoadIds.add(roadId);
    }
  }
  const previousRoads = new Map(previousNetwork.roads.map((road) => [road.id, road]));
  return {
    ...network,
    roads: network.roads.map((road) => dirtyCompiledRoadIds.has(road.id) ? road : previousRoads.get(road.id) ?? road)
  };
}
function compileJunction(network, document, source, templates, sourceMap, deriveConflictZones) {
  const compiled = compileJunctionIntent(document, source, templates);
  const trafficStreams = compileTrafficStreams(network, document, source, templates);
  const beforeRoads = new Set(network.roads.map((road) => road.id));
  let next = createJunction(network, {
    id: source.id,
    name: source.name,
    kind: source.kind,
    connectorGeometryPolicy: source.connectorGeometryPolicy,
    profileTransition: structuredClone(source.profileTransition),
    ports: source.ports.map((port) => ({
      ...structuredClone(port),
      id: junctionPortId(port)
    })),
    virtualRange: structuredClone(source.virtualRange),
    surfaceElevation: structuredClone(source.surfaceElevation),
    surfacePolygon: structuredClone(source.surfacePolygon),
    surfaceLaneType: source.surfaceLaneType,
    surfacePatches: structuredClone(source.surfacePatches),
    connections: compiled.connections,
    movementInteractions: [],
    trafficStreams,
    streamInteractions: [],
    control: structuredClone(source.control),
    areaMarkings: source.areaMarkings?.map((marking) => ({
      ...structuredClone(marking),
      color: marking.color ?? "white"
    })),
    terminalProtections: structuredClone(source.terminalProtections),
    operational: activationProvenance(source.activation, source.id)
  });
  if (source.objects?.length) {
    next = {
      ...next,
      objects: [
        ...next.objects ?? [],
        ...source.objects.map((object) => ({
          ...structuredClone(object),
          s: 0,
          t: 0,
          junctionId: source.id,
          operational: activationProvenance(source.activation, object.id)
        }))
      ]
    };
  }
  sourceMap.junctions[source.id] = source.id;
  const connectorIds = next.roads.filter((road) => !beforeRoads.has(road.id) && road.kind === "connector").map((road) => road.id);
  const operational = activationProvenance(source.activation, source.id);
  if (operational && connectorIds.length > 0) {
    next = {
      ...next,
      roads: next.roads.map((road) => connectorIds.includes(road.id) ? { ...road, operational } : road)
    };
  }
  const expectedConnectorCount = compiled.connections.filter((connection) => !connection.connectorCorridorId).length + new Set(compiled.connections.flatMap((connection) => connection.connectorCorridorId ? [connection.connectorCorridorId] : [])).size;
  if (source.kind === "common" && source.connectorGeometryPolicy !== "surface-fallback" && connectorIds.length !== expectedConnectorCount) {
    throw new Error(`Junction ${source.id} materialized ${connectorIds.length} of ${expectedConnectorCount} required connector roads`);
  }
  for (const maneuver of source.maneuvers) {
    const corridor = source.connectorCorridors?.find((candidate) => candidate.maneuverIds.includes(maneuver.id));
    const ids = corridor ? connectorIds.filter((id) => id.startsWith(`${source.id}__corridor-${corridor.id}`)) : connectorIds.filter((id) => id.startsWith(`${source.id}__${maneuver.id}__`));
    const sourceKey = `${source.id}:${maneuver.id}`;
    sourceMap.maneuvers[sourceKey] = ids;
    const compiledJunction = next.junctions.find((candidate) => candidate.id === source.id);
    sourceMap.maneuverLanes[sourceKey] = (compiledJunction?.connections ?? []).filter((connection) => connection.sourceManeuverId === maneuver.id && ids.includes(connection.connectingRoadId)).flatMap((connection) => connection.laneLinks.map((laneLink) => ({
      roadId: connection.connectingRoadId,
      laneId: laneLink.to
    })));
  }
  for (const continuation of source.laneContinuations ?? []) {
    sourceMap.laneContinuations[`${source.id}:${continuation.id}`] = next.junctions.find((junction) => junction.id === source.id)?.connections.filter((connection) => connection.sourceLaneContinuationId === continuation.id).map((connection) => connection.connectingRoadId) ?? [];
  }
  if (deriveConflictZones || trafficStreams.length > 0) {
    next = attachDerivedConflictZones(next, source, sourceMap);
  }
  return next;
}
function attachDerivedConflictZones(network, source, sourceMap) {
  const trafficStreams = network.junctions.find((junction) => junction.id === source.id)?.trafficStreams ?? [];
  const rawZones = trafficStreams.length > 0 ? deriveStreamConflictZones(network, source, trafficStreams) : source.kind === "crossing" ? deriveCrossingConflictZones(network, source) : source.kind === "virtual" ? deriveVirtualConflictZones(network, source) : deriveManeuverConflictZones(network, source, sourceMap.maneuvers, sourceMap.maneuverLanes);
  const movementInteractions = source.kind === "common" ? compileMovementInteractions(source, rawZones, compileManeuverGeometries(network, source, sourceMap.maneuvers)) : [];
  const streamInteractions = source.kind === "crossing" || source.kind === "virtual" ? compileStreamInteractions(source, network.junctions.find((junction) => junction.id === source.id)?.trafficStreams ?? [], rawZones) : [];
  const zones = rawZones.map((zone) => {
    if (zone.streamIds) {
      const interaction2 = streamInteractions.find((candidate) => maneuverPairKey(candidate.streamIds) === maneuverPairKey(zone.streamIds));
      const priorityStreamId = interaction2?.control.kind === "fixed-priority" ? interaction2.control.priorityParticipantId : undefined;
      const priorityRoadId2 = priorityStreamId ? network.junctions.find((junction) => junction.id === source.id)?.trafficStreams?.find((stream) => stream.id === priorityStreamId)?.roadId : undefined;
      return { ...zone, priorityStreamId, priorityRoadId: priorityRoadId2 };
    }
    if (!zone.maneuverIds)
      return zone;
    const interaction = movementInteractions.find((candidate) => maneuverPairKey(candidate.maneuverIds) === maneuverPairKey(zone.maneuverIds));
    const priorityManeuverId = interaction?.control.kind === "fixed-priority" ? interaction.control.priorityParticipantId : undefined;
    const priorityRoadId = priorityManeuverId ? zone.roadIds.find((roadId) => (sourceMap.maneuvers[`${source.id}:${priorityManeuverId}`] ?? []).includes(roadId)) : undefined;
    return { ...zone, priorityManeuverId, priorityRoadId };
  });
  return {
    ...network,
    junctions: network.junctions.map((junction) => junction.id === source.id ? { ...junction, conflictZones: zones, movementInteractions, streamInteractions } : junction)
  };
}
// ../three-roads-inspect/packages/core/src/authoring-document/road-station-remap.ts
var EPSILON9 = 0.0000001;
function remapRangeAfterTrim(value, frame) {
  if (!validRange2(value) || !validFrame(frame)) {
    return { ...value, sStart: value.sStart - frame.start, sEnd: value.sEnd - frame.start };
  }
  const physicalLength = value.sEnd - value.sStart;
  if (physicalLength >= frame.length - EPSILON9) {
    return { ...value, sStart: 0, sEnd: frame.length };
  }
  const requestedStart = value.sStart - frame.start;
  const sStart = clamp2(requestedStart, 0, frame.length - physicalLength);
  return { ...value, sStart, sEnd: sStart + physicalLength };
}
function remapStationAfterTrim(station, frame) {
  if (!Number.isFinite(station) || !validFrame(frame))
    return station - frame.start;
  return clamp2(station - frame.start, 0, frame.length);
}
function remapObjectAfterTrim(object, frame) {
  if (!validFrame(frame)) {
    return { ...object, s: object.s - frame.start };
  }
  const requestedLength = Math.max(0, object.length ?? 0);
  const objectLength = Math.min(requestedLength, frame.length);
  const usableRepeat = object.repeat && Number.isInteger(object.repeat.count) && object.repeat.count >= 1 && Number.isFinite(object.repeat.spacing) && object.repeat.spacing > 0;
  const maximumRepeatCount = usableRepeat ? Math.max(1, Math.floor(Math.max(0, frame.length - objectLength) / object.repeat.spacing) + 1) : 1;
  const repeatCount = usableRepeat ? Math.min(object.repeat.count, maximumRepeatCount) : 1;
  const repeat = usableRepeat ? {
    ...object.repeat,
    count: repeatCount,
    lateralOffsets: object.repeat.lateralOffsets?.slice(0, repeatCount)
  } : undefined;
  const halfLength = objectLength * 0.5;
  const repeatLength = Math.max(0, repeatCount - 1) * (repeat?.spacing ?? 0);
  const footprint = remapRangeAfterTrim({ sStart: object.s - halfLength, sEnd: object.s + repeatLength + halfLength }, frame);
  return {
    ...object,
    ...object.length === undefined ? {} : { length: objectLength },
    ...repeat ? { repeat } : { repeat: undefined },
    s: footprint.sStart + halfLength
  };
}
function remapRangeAfterSplit(value, splitStation, description) {
  if (value.sEnd <= splitStation + EPSILON9)
    return { side: "first", value };
  if (value.sStart >= splitStation - EPSILON9) {
    return {
      side: "second",
      value: { ...value, sStart: value.sStart - splitStation, sEnd: value.sEnd - splitStation }
    };
  }
  throw new Error(`${description} spans split s=${splitStation}; split or move it first`);
}
function remapStationAfterSplit(station, splitStation) {
  return station <= splitStation + EPSILON9 ? { side: "first", station } : { side: "second", station: station - splitStation };
}
function objectStationRange(object) {
  const halfLength = Math.max(0, object.length ?? 0) * 0.5;
  const repeatLength = Math.max(0, (object.repeat?.count ?? 1) - 1) * Math.max(0, object.repeat?.spacing ?? 0);
  return { sStart: object.s - halfLength, sEnd: object.s + repeatLength + halfLength };
}
function validRange2(value) {
  return Number.isFinite(value.sStart) && Number.isFinite(value.sEnd) && value.sEnd >= value.sStart;
}
function validFrame(frame) {
  return Number.isFinite(frame.start) && Number.isFinite(frame.length) && frame.length >= 0;
}
function clamp2(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// ../three-roads-inspect/packages/core/src/authoring-document/automatic-split-attachment-fit.ts
var EPSILON10 = 0.0000001;
function fitRangeForAutomaticSplit(value, split, options = {}) {
  if (options.forcedSide) {
    return [{
      side: options.forcedSide,
      value: remapRangeAfterTrim(value, stationFrame(split, options.forcedSide))
    }];
  }
  if (value.sEnd <= split.splitStation + EPSILON10)
    return [{ side: "first", value }];
  if (value.sStart >= split.splitStation - EPSILON10) {
    return [{
      side: "second",
      value: remapRangeAfterTrim(value, stationFrame(split, "second"))
    }];
  }
  const physicalLength = Math.max(0, value.sEnd - value.sStart);
  const firstLength = split.splitStation;
  const secondLength = split.sourceLength - split.splitStation;
  const fittingSides = ["first", "second"].filter((side2) => physicalLength <= childLength(split, side2) + EPSILON10);
  if (fittingSides.length > 0) {
    const side2 = greatestOverlapSide(value, split, fittingSides);
    return [{ side: side2, value: remapRangeAfterTrim(value, stationFrame(split, side2)) }];
  }
  if (options.fragmentWhenNecessary) {
    const firstEnd = Math.min(value.sEnd, split.splitStation);
    const secondStart = Math.max(value.sStart, split.splitStation);
    const parts = [];
    if (firstEnd > value.sStart + EPSILON10) {
      parts.push({ side: "first", value: { ...value, sEnd: firstEnd } });
    }
    if (value.sEnd > secondStart + EPSILON10) {
      parts.push({
        side: "second",
        value: {
          ...value,
          sStart: secondStart - split.splitStation,
          sEnd: value.sEnd - split.splitStation
        }
      });
    }
    if (parts.length > 0)
      return parts;
  }
  const side = greatestOverlapSide(value, split, ["first", "second"]);
  return [{ side, value: remapRangeAfterTrim(value, stationFrame(split, side)) }];
}
function fitObjectForAutomaticSplit(object, split, forcedSide) {
  const [placement] = fitRangeForAutomaticSplit(objectStationRange(object), split, { forcedSide });
  const side = placement?.side ?? "first";
  return {
    side,
    value: remapObjectAfterTrim(object, stationFrame(split, side))
  };
}
function remapStationForAutomaticSplit(station, split, forcedSide) {
  const side = forcedSide ?? (station <= split.splitStation + EPSILON10 ? "first" : "second");
  return {
    side,
    station: remapStationAfterTrim(station, stationFrame(split, side))
  };
}
function fitSurfaceElevationAfterAutomaticSplit(elevation, split, forcedSide) {
  const [placement] = fitRangeForAutomaticSplit(elevation, split, { forcedSide });
  return {
    side: placement.side,
    value: fitSurfaceElevationSpan(placement.value)
  };
}
function fitSurfaceElevationAfterTrim(elevation, frame) {
  return fitSurfaceElevationSpan(remapRangeAfterTrim(elevation, frame));
}
function fitWeavingAfterAutomaticSplit(weaving, split) {
  const [placement] = fitRangeForAutomaticSplit(weaving, split);
  return {
    side: placement.side,
    value: fitWeavingSpan(placement.value)
  };
}
function fitWeavingAfterTrim(weaving, frame) {
  return fitWeavingSpan(remapRangeAfterTrim(weaving, frame));
}
function alignLaneOperationToStroke(operation, stroke) {
  const roadLength = referenceLineLength({ geometry: stroke.geometry });
  const boundaries = [...new Set([
    0,
    roadLength,
    ...stroke.templateSpans.flatMap((span) => [span.s, span.s + (span.transitionLength ?? 0)])
  ].filter((station) => station >= 0 && station <= roadLength))].sort((left, right) => left - right);
  const candidates = boundaries.flatMap((sStart, startIndex) => boundaries.slice(startIndex + 1).map((sEnd) => ({
    sStart,
    sEnd,
    cost: Math.abs(sStart - operation.sStart) + Math.abs(sEnd - operation.sEnd),
    overlap: Math.max(0, Math.min(sEnd, operation.sEnd) - Math.max(sStart, operation.sStart))
  })));
  const best = candidates.sort((left, right) => Number(right.overlap > EPSILON10) - Number(left.overlap > EPSILON10) || left.cost - right.cost || Math.abs(left.sEnd - left.sStart - (operation.sEnd - operation.sStart)) || left.sStart - right.sStart)[0];
  return best ? { ...operation, sStart: best.sStart, sEnd: best.sEnd } : { ...operation, sStart: 0, sEnd: roadLength };
}
function stationFrame(split, side) {
  return side === "first" ? { start: 0, length: split.splitStation } : { start: split.splitStation, length: split.sourceLength - split.splitStation };
}
function childLength(split, side) {
  return side === "first" ? split.splitStation : split.sourceLength - split.splitStation;
}
function fitSurfaceElevationSpan(value) {
  return {
    ...value,
    rampLength: Math.min(value.rampLength, Math.max(EPSILON10, (value.sEnd - value.sStart) * 0.5))
  };
}
function fitWeavingSpan(value) {
  const length = value.sEnd - value.sStart;
  return {
    ...value,
    ...value.minimumLength === undefined ? {} : { minimumLength: Math.min(value.minimumLength, length) }
  };
}
function greatestOverlapSide(value, split, candidates) {
  const overlap = (side) => side === "first" ? Math.max(0, Math.min(value.sEnd, split.splitStation) - Math.max(0, value.sStart)) : Math.max(0, Math.min(value.sEnd, split.sourceLength) - Math.max(split.splitStation, value.sStart));
  const first = candidates[0] ?? "first";
  return candidates.reduce((best, side) => {
    const difference = overlap(side) - overlap(best);
    if (difference > EPSILON10)
      return side;
    if (Math.abs(difference) <= EPSILON10) {
      const center = (value.sStart + value.sEnd) * 0.5;
      return center <= split.splitStation ? "first" : "second";
    }
    return best;
  }, first);
}

// ../three-roads-inspect/packages/core/src/authoring-document/split-road-attachments.ts
function remapDocumentAttachmentsAfterSplit(document, firstRoadId, secondRoadId, splitStation) {
  const range = (value) => {
    if (value.roadId !== firstRoadId)
      return value;
    const result = remapRangeAfterSplit(value, splitStation, `${sourceName(value.id)}`);
    return result.side === "first" ? result.value : { ...result.value, roadId: secondRoadId };
  };
  const marking = (value) => {
    if (value.roadId !== firstRoadId)
      return value;
    if (value.kind !== "arrow")
      return range(value);
    const result = remapStationAfterSplit(value.s, splitStation);
    return result.side === "first" ? value : { ...value, roadId: secondRoadId, s: result.station };
  };
  const object = (value) => {
    if (value.roadId !== firstRoadId)
      return value;
    const result = remapRangeAfterSplit(objectStationRange(value), splitStation, `${sourceName(value.id)}`);
    return result.side === "first" ? value : { ...value, roadId: secondRoadId, s: value.s - splitStation };
  };
  const gradeSeparation = (value) => {
    const upper = splitContact(value.upperRoad, firstRoadId, secondRoadId, splitStation);
    const lower = splitContact(value.lowerRoad, firstRoadId, secondRoadId, splitStation);
    if (value.upperRoad.roadId !== firstRoadId) {
      return { ...value, upperRoad: upper, lowerRoad: lower };
    }
    const deck = remapRangeAfterSplit(value.deckExtent, splitStation, `${sourceName(value.id)} deck`);
    if (deck.side !== (upper.roadId === firstRoadId ? "first" : "second")) {
      throw new Error(`Grade separation ${value.id} contact and deck would land on different split roads`);
    }
    return {
      ...value,
      upperRoad: upper,
      lowerRoad: lower,
      deckExtent: deck.value
    };
  };
  return {
    ...document,
    junctions: document.junctions.map((junction) => remapJunctionAfterRoadSplit(junction, firstRoadId, secondRoadId, splitStation)),
    gradeSeparations: document.gradeSeparations?.map(gradeSeparation),
    roadStructures: document.roadStructures?.map(range),
    roadsideFeatures: document.roadsideFeatures?.map(range),
    roadSurfaceElevations: document.roadSurfaceElevations?.map(range),
    weavingSections: document.weavingSections?.map(range),
    markings: document.markings?.map(marking),
    objects: document.objects?.map(object),
    regulations: document.regulations?.map(range),
    trafficManagementPlans: document.trafficManagementPlans?.map((plan) => ({
      ...plan,
      phases: plan.phases.map((phase) => ({
        ...phase,
        laneOperations: phase.laneOperations.map(range),
        regulations: phase.regulations?.map(range)
      }))
    })),
    facilities: document.facilities?.map((facility) => {
      if (facility.kind === "protected-cycle-corner" || facility.strokeId !== firstRoadId)
        return facility;
      if (facility.kind !== "traffic-calming-gateway") {
        const result2 = remapRangeAfterSplit(facility, splitStation, `${sourceName(facility.id)}`);
        return result2.side === "first" ? result2.value : { ...result2.value, strokeId: secondRoadId };
      }
      const result = remapRangeAfterSplit(facility, splitStation, `${sourceName(facility.id)}`);
      const remapped = result.side === "first" ? result.value : { ...result.value, strokeId: secondRoadId };
      const regulation = remapStationAfterSplit(facility.config.regulationEnd, splitStation);
      if (regulation.side !== result.side) {
        throw new Error(`Facility ${facility.id} regulation spans split s=${splitStation}; split or move it first`);
      }
      return {
        ...remapped,
        config: { ...remapped.config, regulationEnd: regulation.station }
      };
    }),
    ordinaryNodeIntents: remapOrdinaryNodeIntentsAfterRoadSplit(document.ordinaryNodeIntents, firstRoadId, secondRoadId)
  };
}
function remapJunctionAfterRoadSplit(junction, firstRoadId, secondRoadId, splitStation, automaticSplit) {
  const ports = junction.ports.map((port) => {
    if (port.roadId !== firstRoadId)
      return port;
    if (port.s === undefined) {
      return port.contactPoint === "end" ? { ...port, roadId: secondRoadId } : port;
    }
    const result = automaticSplit ? remapStationForAutomaticSplit(port.s, automaticSplit) : remapStationAfterSplit(port.s, splitStation);
    return result.side === "first" ? port : { ...port, roadId: secondRoadId, s: result.station };
  });
  const roadAtPort = (roadId, portId) => {
    if (roadId !== firstRoadId)
      return roadId;
    if (portId !== undefined) {
      const index = junction.ports.findIndex((port) => port.id === portId);
      if (index >= 0)
        return ports[index].roadId;
    }
    const candidates = ports.filter((_, index) => junction.ports[index].roadId === firstRoadId);
    return candidates.length === 1 ? candidates[0].roadId : firstRoadId;
  };
  const priorityRoadIds = junction.priorityRoadIds?.flatMap((roadId) => {
    if (roadId !== firstRoadId)
      return [roadId];
    const replacements = ports.filter((_, index) => junction.ports[index].roadId === firstRoadId).map((port) => port.roadId);
    return [...new Set(replacements.length > 0 ? replacements : [firstRoadId])];
  });
  const virtualRange = junction.virtualRange?.mainRoadId === firstRoadId ? (() => {
    const result = automaticSplit ? fitRangeForAutomaticSplit(junction.virtualRange, automaticSplit)[0] : remapRangeAfterSplit(junction.virtualRange, splitStation, `Junction ${junction.id} virtual range`);
    return {
      ...result.value,
      mainRoadId: result.side === "first" ? firstRoadId : secondRoadId
    };
  })() : junction.virtualRange;
  return {
    ...junction,
    ports,
    virtualRange,
    maneuvers: junction.maneuvers.map((maneuver) => ({
      ...maneuver,
      fromRoadId: roadAtPort(maneuver.fromRoadId, maneuver.fromPortId),
      toRoadId: roadAtPort(maneuver.toRoadId, maneuver.toPortId)
    })),
    laneContinuations: junction.laneContinuations?.map((continuation) => ({
      ...continuation,
      fromRoadId: roadAtPort(continuation.fromRoadId, continuation.fromPortId),
      toRoadId: roadAtPort(continuation.toRoadId, continuation.toPortId)
    })),
    trafficStreams: junction.trafficStreams?.map((stream) => ({
      ...stream,
      roadId: roadAtPort(stream.roadId, stream.portId)
    })),
    terminalProtections: junction.terminalProtections?.map((protection) => ({
      ...protection,
      roadId: roadAtPort(protection.roadId, undefined)
    })),
    priorityRoadIds
  };
}
function splitContact(value, firstRoadId, secondRoadId, splitStation) {
  if (value.roadId !== firstRoadId)
    return value;
  const result = remapStationAfterSplit(value.s, splitStation);
  return result.side === "first" ? value : { ...value, roadId: secondRoadId, s: result.station };
}
function splitEndpointContact(value, firstRoadId, secondRoadId) {
  return value.roadId === firstRoadId && value.contactPoint === "end" ? { ...value, roadId: secondRoadId } : value;
}
function remapOrdinaryNodeIntentsAfterRoadSplit(intents, firstRoadId, secondRoadId) {
  return intents?.map((intent) => {
    if (intent.contacts.some(({ roadId }) => roadId === secondRoadId))
      return intent;
    return {
      ...intent,
      contacts: intent.contacts.map((contact) => splitEndpointContact(contact, firstRoadId, secondRoadId)),
      prohibitedMovements: intent.prohibitedMovements?.map((movement) => ({
        from: splitEndpointContact(movement.from, firstRoadId, secondRoadId),
        to: splitEndpointContact(movement.to, firstRoadId, secondRoadId)
      })),
      movementMappings: intent.movementMappings?.map((movement) => ({
        from: splitEndpointContact(movement.from, firstRoadId, secondRoadId),
        to: splitEndpointContact(movement.to, firstRoadId, secondRoadId)
      }))
    };
  });
}
function sourceName(id) {
  return `Road-owned source ${id}`;
}

// ../three-roads-inspect/packages/core/src/authoring-document/generated-facility-fit.ts
var EPSILON11 = 0.0000001;
function fitFacilityAfterAutomaticSplit(facility, split) {
  const [placement] = fitRangeForAutomaticSplit(facility, split);
  return {
    side: placement.side,
    value: fitFacilitySpan(placement.value, facility, stationFrame(split, placement.side))
  };
}
function fitFacilityAfterTrim(facility, frame) {
  return fitFacilitySpan(remapRangeAfterTrim(facility, frame), facility, frame);
}
function fitFacilitySpan(value, source, frame) {
  const span = value.sEnd - value.sStart;
  if (value.kind === "raised-table") {
    return {
      ...value,
      config: {
        ...value.config,
        rampLength: Math.min(value.config.rampLength, Math.max(EPSILON11, span * 0.5))
      }
    };
  }
  if (value.kind === "traffic-calming-gateway") {
    const transitionLength = Math.min(value.config.transitionLength, span * 0.5);
    const plateauStart = value.sStart + transitionLength;
    const regulationEnd = source.kind === "traffic-calming-gateway" ? remapStationAfterTrim(source.config.regulationEnd, frame) : value.config.regulationEnd;
    return {
      ...value,
      config: {
        ...value.config,
        transitionLength,
        regulationEnd: Math.min(frame.length, Math.max(value.sEnd, plateauStart + EPSILON11, regulationEnd))
      }
    };
  }
  if (value.kind === "parking-run") {
    const transitionLength = Math.min(value.config.transitionLength ?? 0, Math.max(0, span * 0.5));
    const plateauLength = span - transitionLength;
    return {
      ...value,
      config: {
        ...value.config,
        ...value.config.transitionLength === undefined ? {} : { transitionLength },
        stallLength: Math.min(value.config.stallLength, plateauLength),
        spacing: Math.min(value.config.spacing, plateauLength)
      }
    };
  }
  if (value.kind === "bus-bay" || value.kind === "loading-bay" || value.kind === "emergency-lay-by" || value.kind === "tram-stop-island") {
    return clampOptionalTransition(value, span);
  }
  return value;
}
function clampOptionalTransition(value, span) {
  if (value.config.transitionLength === undefined)
    return value;
  return {
    ...value,
    config: {
      ...value.config,
      transitionLength: Math.min(value.config.transitionLength, Math.max(0, span * 0.5))
    }
  };
}

// ../three-roads-inspect/packages/core/src/authoring-document/fit-automatic-split-attachments.ts
function fitDocumentAttachmentsAfterAutomaticSplit(document, firstRoadId, secondRoadId, splitStation, sourceLength) {
  const split = { splitStation, sourceLength };
  const roadId = (side) => side === "first" ? firstRoadId : secondRoadId;
  const sideForRoad = (candidate) => candidate === firstRoadId ? "first" : candidate === secondRoadId ? "second" : undefined;
  const facilities = document.facilities?.map((facility) => {
    if (facility.kind === "protected-cycle-corner" || facility.strokeId !== firstRoadId)
      return facility;
    const placement = fitFacilityAfterAutomaticSplit(facility, split);
    return { ...placement.value, strokeId: roadId(placement.side) };
  });
  const facilityRoads = new Map(facilities?.flatMap((facility) => facility.kind === "protected-cycle-corner" ? [] : [[facility.id, facility.strokeId]]));
  const forcedSide = (value) => {
    const facilityId = sourceReference(value, "facilityId");
    return sideForRoad(facilityId ? facilityRoads.get(facilityId) : undefined);
  };
  const singleRange = (value, force = forcedSide(value)) => {
    if (value.roadId !== firstRoadId)
      return value;
    const [placement] = fitRangeForAutomaticSplit(value, split, { forcedSide: force });
    return { ...placement.value, roadId: roadId(placement.side) };
  };
  const fragmentableRange = (value) => {
    if (value.roadId !== firstRoadId)
      return [value];
    const force = forcedSide(value);
    const placements = fitRangeForAutomaticSplit(value, split, {
      forcedSide: force,
      fragmentWhenNecessary: force === undefined
    });
    return placements.map((placement, index) => ({
      ...placement.value,
      id: placements.length > 1 && index > 0 ? `${value.id}|automatic-part|${secondRoadId}` : value.id,
      roadId: roadId(placement.side)
    }));
  };
  const roadStructures = document.roadStructures?.map((structure) => singleRange(structure));
  const structureRoads = new Map(roadStructures?.map((structure) => [structure.id, structure.roadId]));
  const strokes = new Map(document.strokes.map((stroke) => [stroke.id, stroke]));
  const marking = (value) => {
    if (value.roadId !== firstRoadId)
      return [value];
    if (value.kind !== "arrow")
      return fragmentableRange(value);
    const station = remapStationForAutomaticSplit(value.s, split, forcedSide(value));
    return [{ ...value, roadId: roadId(station.side), s: station.station }];
  };
  const object = (value) => {
    if (value.roadId !== firstRoadId)
      return value;
    const structureSide = sideForRoad(value.structureId ? structureRoads.get(value.structureId) : undefined);
    const placement = fitObjectForAutomaticSplit(value, split, structureSide ?? forcedSide(value));
    return { ...placement.value, roadId: roadId(placement.side) };
  };
  const gradeSeparation = (value) => {
    const structureSide = sideForRoad(value.structureId ? structureRoads.get(value.structureId) : undefined);
    const deck = value.upperRoad.roadId === firstRoadId ? fitRangeForAutomaticSplit(value.deckExtent, split, { forcedSide: structureSide })[0] : undefined;
    const upper = value.upperRoad.roadId === firstRoadId ? remapStationForAutomaticSplit(value.upperRoad.s, split, deck?.side) : undefined;
    const lower = value.lowerRoad.roadId === firstRoadId ? remapStationForAutomaticSplit(value.lowerRoad.s, split) : undefined;
    return {
      ...value,
      upperRoad: upper ? { ...value.upperRoad, roadId: roadId(upper.side), s: upper.station } : value.upperRoad,
      lowerRoad: lower ? { ...value.lowerRoad, roadId: roadId(lower.side), s: lower.station } : value.lowerRoad,
      deckExtent: deck?.value ?? value.deckExtent
    };
  };
  return {
    ...document,
    junctions: document.junctions.map((junction) => remapJunctionAfterRoadSplit(junction, firstRoadId, secondRoadId, splitStation, split)),
    gradeSeparations: document.gradeSeparations?.map(gradeSeparation),
    roadStructures,
    roadsideFeatures: document.roadsideFeatures?.flatMap(fragmentableRange),
    roadSurfaceElevations: document.roadSurfaceElevations?.map((elevation) => {
      if (elevation.roadId !== firstRoadId)
        return elevation;
      const placement = fitSurfaceElevationAfterAutomaticSplit(elevation, split, forcedSide(elevation));
      return { ...placement.value, roadId: roadId(placement.side) };
    }),
    weavingSections: document.weavingSections?.map((weaving) => {
      if (weaving.roadId !== firstRoadId)
        return weaving;
      const placement = fitWeavingAfterAutomaticSplit(weaving, split);
      return { ...placement.value, roadId: roadId(placement.side) };
    }),
    markings: document.markings?.flatMap(marking),
    objects: document.objects?.map(object),
    regulations: document.regulations?.flatMap(fragmentableRange),
    trafficManagementPlans: document.trafficManagementPlans?.map((plan) => ({
      ...plan,
      phases: plan.phases.map((phase) => ({
        ...phase,
        laneOperations: phase.laneOperations.flatMap((operation) => fragmentableRange(operation).map((fitted) => {
          const stroke = strokes.get(fitted.roadId);
          return stroke ? alignLaneOperationToStroke(fitted, stroke) : fitted;
        })),
        regulations: phase.regulations?.flatMap(fragmentableRange)
      }))
    })),
    facilities,
    ordinaryNodeIntents: remapOrdinaryNodeIntentsAfterRoadSplit(document.ordinaryNodeIntents, firstRoadId, secondRoadId)
  };
}
function sourceReference(value, key) {
  if (!value || typeof value !== "object" || !(key in value))
    return;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

// ../three-roads-inspect/packages/core/src/streetscape/streetscape-road-transforms.ts
var EPSILON12 = 0.0000001;
function remapStreetscapeAfterRoadSplit(document, firstRoadId, secondRoadId, splitStation, originalLength) {
  const streetscape = document.streetscape;
  if (!streetscape)
    return document;
  const usedIds = new Set(streetscape.tracks.map(({ id }) => id));
  const tracks = streetscape.tracks.flatMap((track) => {
    if (track.roadId !== firstRoadId)
      return [track];
    const lineageId = track.lineageId ?? track.id;
    if (track.sEnd <= splitStation + EPSILON12) {
      return [{
        ...track,
        lineageId,
        phase: splitPhase(track, "first", splitStation, originalLength)
      }];
    }
    if (track.sStart >= splitStation - EPSILON12) {
      return [{
        ...track,
        lineageId,
        roadId: secondRoadId,
        sStart: Math.max(0, track.sStart - splitStation),
        sEnd: track.sEnd - splitStation,
        phase: splitPhase(track, "second", splitStation, originalLength)
      }];
    }
    const secondId = uniqueSplitId(track.id, secondRoadId, usedIds);
    usedIds.add(secondId);
    return [
      {
        ...track,
        lineageId,
        sEnd: splitStation,
        phase: splitPhase(track, "first", splitStation, originalLength)
      },
      {
        ...track,
        id: secondId,
        lineageId,
        roadId: secondRoadId,
        sStart: 0,
        sEnd: track.sEnd - splitStation,
        phase: splitPhase(track, "second", splitStation, originalLength)
      }
    ];
  });
  return { ...document, streetscape: { ...streetscape, tracks } };
}
function remapStreetscapeAfterRoadTrims(previous, document, trims) {
  const streetscape = document.streetscape;
  if (!streetscape?.tracks.length || trims.size === 0)
    return document;
  const usesCorridorPhase = streetscape.tracks.some(({ phaseOrigin }) => phaseOrigin === "corridor");
  const previousCorridorOffsets = usesCorridorPhase ? corridorStationOffsets(previous) : new Map;
  const nextCorridorOffsets = usesCorridorPhase ? corridorStationOffsets(document) : new Map;
  const tracks = streetscape.tracks.flatMap((track) => {
    const trim = trims.get(track.roadId);
    const clipped = trim ? clipTrackToTrim(track, trim) : track;
    if (!clipped)
      return [];
    if (clipped.placement === "single")
      return [clipped];
    const phaseAdjustment = trackPhaseAdjustment(clipped, trim, previousCorridorOffsets.get(track.roadId) ?? 0, nextCorridorOffsets.get(track.roadId) ?? 0);
    if (Math.abs(phaseAdjustment) <= EPSILON12)
      return [clipped];
    return [{ ...clipped, phase: (clipped.phase ?? 0) + phaseAdjustment }];
  });
  return { ...document, streetscape: { ...streetscape, tracks } };
}
function splitPhase(track, side, splitStation, originalLength) {
  const phase = track.phase;
  if (phase === undefined || track.phaseOrigin === "corridor")
    return phase;
  if (track.phaseOrigin === "road-end") {
    return side === "first" ? phase - (originalLength - splitStation) : phase;
  }
  return side === "second" ? phase - splitStation : phase;
}
function clipTrackToTrim(track, trim) {
  const retainedStart = trim.start;
  const retainedEnd = trim.end;
  const intersectionStart = Math.max(track.sStart, retainedStart);
  const intersectionEnd = Math.min(track.sEnd, retainedEnd);
  if (intersectionEnd - intersectionStart <= EPSILON12)
    return;
  if (track.placement !== "single") {
    return {
      ...track,
      sStart: intersectionStart - retainedStart,
      sEnd: intersectionEnd - retainedStart
    };
  }
  const phase = track.phase ?? 0;
  const events = track.events.filter((event) => {
    const station = clamp3(track.sStart + phase + event.at, track.sStart, track.sEnd);
    return station >= retainedStart - EPSILON12 && station <= retainedEnd + EPSILON12;
  });
  if (events.length === 0)
    return;
  return {
    ...track,
    sStart: intersectionStart - retainedStart,
    sEnd: intersectionEnd - retainedStart,
    phase: phase + track.sStart - intersectionStart,
    events
  };
}
function trackPhaseAdjustment(track, trim, previousCorridorOffset, nextCorridorOffset) {
  if (track.phaseOrigin === "corridor") {
    return nextCorridorOffset - previousCorridorOffset - (trim?.start ?? 0);
  }
  if (!trim)
    return 0;
  if (track.phaseOrigin === "road-end") {
    return trim.end - trim.originalLength;
  }
  return -trim.start;
}
function corridorStationOffsets(document) {
  const strokes = new Map(document.strokes.map((stroke) => [stroke.id, stroke]));
  const lengths = new Map(document.strokes.map((stroke) => [
    stroke.id,
    referenceLineLength({ geometry: stroke.geometry })
  ]));
  const offsets = new Map;
  const roots = document.strokes.filter((stroke) => !stroke.links?.predecessor || !strokes.has(stroke.links.predecessor.roadId)).map(({ id }) => id).sort();
  for (const root of roots)
    walkCorridor(root, strokes, lengths, offsets);
  for (const roadId of [...strokes.keys()].sort()) {
    if (!offsets.has(roadId))
      walkCorridor(roadId, strokes, lengths, offsets);
  }
  return offsets;
}
function walkCorridor(rootId, strokes, lengths, offsets) {
  let roadId = rootId;
  let offset = 0;
  while (roadId && !offsets.has(roadId)) {
    offsets.set(roadId, offset);
    const successor = strokes.get(roadId)?.links?.successor;
    if (!successor || successor.contactPoint !== "start")
      return;
    offset += lengths.get(roadId) ?? 0;
    roadId = successor.roadId;
  }
}
function clamp3(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
function uniqueSplitId(base, secondRoadId, used) {
  const prefix = `${base}|${secondRoadId}`;
  let id = prefix;
  let ordinal = 2;
  while (used.has(id))
    id = `${prefix}|${ordinal++}`;
  return id;
}

// ../three-roads-inspect/packages/core/src/authoring-document/split-road-stroke.ts
var EPSILON13 = 0.0000001;
function splitRoadStroke(document, strokeId, s, options = {}) {
  const stroke = requireStroke(document, strokeId);
  const length = referenceLineLength({ geometry: stroke.geometry });
  if (s <= EPSILON13 || s >= length - EPSILON13)
    throw new Error(`Split s=${s} must be inside stroke ${strokeId}`);
  if (isInsideTransition(stroke.templateSpans, s))
    throw new Error(`Split s=${s} crosses an active template transition on ${strokeId}`);
  const secondStrokeId = options.secondStrokeId ?? `${strokeId}-split`;
  if (document.strokes.some((candidate) => candidate.id === secondStrokeId)) {
    throw new Error(`Document already has stroke ${secondStrokeId}`);
  }
  const first = {
    ...structuredClone(stroke),
    name: options.firstStrokeName ?? stroke.name,
    geometry: sliceReferenceLine({ geometry: stroke.geometry }, 0, s).geometry,
    elevation: sliceProfile(stroke.elevation, 0, s),
    superelevation: sliceProfile(stroke.superelevation, 0, s),
    templateSpans: spansBefore(stroke.templateSpans, s),
    links: { predecessor: structuredClone(stroke.links?.predecessor), successor: { roadId: secondStrokeId, contactPoint: "start" } }
  };
  const second = {
    ...structuredClone(stroke),
    id: secondStrokeId,
    derivedFromStrokeId: stroke.derivedFromStrokeId ?? stroke.id,
    name: options.secondStrokeName ?? (stroke.name ? `${stroke.name} continuation` : undefined),
    geometry: sliceReferenceLine({ geometry: stroke.geometry }, s, length).geometry,
    elevation: sliceProfile(stroke.elevation, s, length),
    superelevation: sliceProfile(stroke.superelevation, s, length),
    templateSpans: spansAfter(stroke.templateSpans, s),
    links: { predecessor: { roadId: stroke.id, contactPoint: "end" }, successor: structuredClone(stroke.links?.successor) }
  };
  const strokes = document.strokes.flatMap((candidate) => candidate.id === stroke.id ? [first, second] : [rewriteLinkedStroke(candidate, stroke.id, secondStrokeId)]);
  const splitDocument = { ...document, strokes };
  const remapped = options.attachmentPolicy === "automatic-fit" ? fitDocumentAttachmentsAfterAutomaticSplit(splitDocument, stroke.id, secondStrokeId, s, length) : remapDocumentAttachmentsAfterSplit(splitDocument, stroke.id, secondStrokeId, s);
  return {
    document: remapStreetscapeAfterRoadSplit(remapped, stroke.id, secondStrokeId, s, length),
    firstStrokeId: stroke.id,
    secondStrokeId
  };
}
function spansBefore(spans, splitS) {
  return [...spans].filter((span) => span.s < splitS - EPSILON13).map((span) => structuredClone(span));
}
function spansAfter(spans, splitS) {
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  const active = sorted.filter((span) => span.s <= splitS + EPSILON13).at(-1);
  if (!active)
    throw new Error("Road stroke has no active template at split");
  const startsAtSplit = Math.abs(active.s - splitS) <= EPSILON13;
  const first = { ...structuredClone(active), s: 0 };
  if (!startsAtSplit)
    delete first.transitionLength;
  return [first, ...sorted.filter((span) => span.s > splitS + EPSILON13).map((span) => ({ ...structuredClone(span), s: span.s - splitS }))];
}
function isInsideTransition(spans, s) {
  return spans.some((span) => span.transitionLength && s > span.s + EPSILON13 && s < span.s + span.transitionLength - EPSILON13);
}
function rewriteLinkedStroke(stroke, oldRoadId, secondRoadId) {
  const rewrite = (link) => {
    if (!link || link.roadId !== oldRoadId)
      return link;
    return { ...link, roadId: link.contactPoint === "start" ? oldRoadId : secondRoadId };
  };
  const predecessor = rewrite(stroke.links?.predecessor);
  const successor = rewrite(stroke.links?.successor);
  return predecessor === stroke.links?.predecessor && successor === stroke.links?.successor ? stroke : { ...stroke, links: { predecessor, successor } };
}
function requireStroke(document, strokeId) {
  const stroke = document.strokes.find((candidate) => candidate.id === strokeId);
  if (!stroke)
    throw new Error(`Document has no stroke ${strokeId}`);
  return stroke;
}
function sliceProfile(records, startS, endS) {
  if (!records?.length)
    return;
  const sorted = [...records].sort((a, b) => a.s - b.s);
  const active = sorted.filter((record) => record.s <= startS + EPSILON13).at(-1);
  const within = sorted.filter((record) => record.s > startS + EPSILON13 && record.s < endS - EPSILON13);
  const first = active ? [{ ...active, ...shiftCubic(active, startS - active.s), s: 0 }] : [];
  return [...first, ...within.map((record) => ({ ...record, s: record.s - startS }))];
}

// ../three-roads-inspect/packages/core/src/authoring-document/lane-mapped-junction-builder.ts
function createLaneMappedJunctionIntent(spec) {
  const approaches = validateApproaches(spec.approaches);
  const movementIds = new Set;
  const lanePairs = new Set;
  const maneuvers = spec.movements.map((movement) => {
    const from = approaches.get(movement.fromApproachKey);
    const to = approaches.get(movement.toApproachKey);
    if (!from || !to) {
      throw new Error(`Junction movement references missing approach ${!from ? movement.fromApproachKey : movement.toApproachKey}`);
    }
    if (from.key === to.key && !spec.allowUTurns) {
      throw new Error(`Junction movement ${from.key} to itself requires allowUTurns`);
    }
    if (!movement.fromLaneRole || !movement.toLaneRole) {
      throw new Error("Junction movements require source and target lane roles");
    }
    if (movement.minimumRadius !== undefined && (!Number.isFinite(movement.minimumRadius) || movement.minimumRadius <= 0)) {
      throw new Error("Junction movement minimum radius must be positive");
    }
    const pairKey = [from.key, movement.fromLaneRole, to.key, movement.toLaneRole].join("\x00");
    if (lanePairs.has(pairKey))
      throw new Error(`Duplicate junction lane movement ${movementLabel(movement)}`);
    lanePairs.add(pairKey);
    const id = movement.id ?? generatedMovementId(movement);
    if (!id || movementIds.has(id))
      throw new Error(`Duplicate junction movement ID ${id}`);
    movementIds.add(id);
    return {
      id,
      fromRoadId: from.roadId,
      fromPortId: from.key,
      fromLaneRole: movement.fromLaneRole,
      toRoadId: to.roadId,
      toPortId: to.key,
      toLaneRole: movement.toLaneRole,
      participantClass: movement.participantClass,
      requiredContinuity: movement.requiredContinuity,
      minimumRadius: movement.minimumRadius,
      conflictEnvelopeWidth: movement.conflictEnvelopeWidth,
      connectorGeometry: structuredClone(movement.connectorGeometry),
      connectorLaneMarkings: structuredClone(movement.connectorLaneMarkings)
    };
  });
  if (maneuvers.length === 0)
    throw new Error("Lane-mapped junction needs at least one movement");
  return {
    id: spec.id,
    name: spec.name,
    kind: "common",
    ports: spec.approaches.map(({ key, roadId, contactPoint }) => ({ id: key, roadId, contactPoint })),
    maneuvers,
    control: spec.control ?? { kind: "uncontrolled", rule: "right-before-left" }
  };
}
function validateApproaches(approaches) {
  if (approaches.length < 2)
    throw new Error("Lane-mapped junction needs at least two approaches");
  const byKey = new Map;
  const roadIds = new Set;
  for (const approach of approaches) {
    if (!approach.key || !approach.roadId)
      throw new Error("Junction approaches require a key and road ID");
    if (byKey.has(approach.key))
      throw new Error(`Duplicate junction approach key ${approach.key}`);
    if (roadIds.has(approach.roadId))
      throw new Error(`Duplicate junction approach road ${approach.roadId}`);
    byKey.set(approach.key, approach);
    roadIds.add(approach.roadId);
  }
  return byKey;
}
function generatedMovementId(movement) {
  return [
    movement.fromApproachKey,
    movement.fromLaneRole,
    "to",
    movement.toApproachKey,
    movement.toLaneRole
  ].map(idToken2).join("-");
}
function movementLabel(movement) {
  return `${movement.fromApproachKey}:${movement.fromLaneRole} to ${movement.toApproachKey}:${movement.toLaneRole}`;
}
function idToken2(value) {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

// ../three-roads-inspect/packages/core/src/authoring-document/junction-intent-builders.ts
function createSingleLaneMultiArmJunctionIntent(spec) {
  if (spec.approaches.length < 3)
    throw new Error("Multi-arm junction needs at least three approaches");
  return createAllToAllIntent(spec.id, spec.name, spec.approaches, spec.priorityRoadIds);
}
function createAllToAllIntent(id, name, approaches, priorityRoadIds) {
  validateApproaches2(approaches);
  const roadIds = new Set(approaches.map((approach) => approach.roadId));
  for (const roadId of priorityRoadIds ?? []) {
    if (!roadIds.has(roadId))
      throw new Error(`Priority road ${roadId} is not a junction approach`);
  }
  return {
    id,
    name,
    kind: "common",
    ports: approaches.map(({ key, roadId, contactPoint }) => ({ id: key, roadId, contactPoint })),
    maneuvers: approaches.flatMap((from) => approaches.filter((to) => to.key !== from.key).map((to) => ({
      id: `${from.key}-to-${to.key}`,
      fromRoadId: from.roadId,
      fromPortId: from.key,
      fromLaneRole: from.inboundLaneRole,
      toRoadId: to.roadId,
      toPortId: to.key,
      toLaneRole: to.outboundLaneRole
    }))),
    control: priorityRoadIds?.length ? {
      kind: "priority",
      priorityPortIds: approaches.filter((approach) => priorityRoadIds.includes(approach.roadId)).map((approach) => approach.key),
      minorControl: "yield"
    } : { kind: "uncontrolled", rule: "right-before-left" }
  };
}
function validateApproaches2(approaches) {
  const keys = new Set;
  const roadIds = new Set;
  for (const approach of approaches) {
    if (!approach.key || !approach.roadId || !approach.inboundLaneRole || !approach.outboundLaneRole) {
      throw new Error("Junction approaches require a key, road ID, inbound role, and outbound role");
    }
    if (keys.has(approach.key))
      throw new Error(`Duplicate junction approach key ${approach.key}`);
    if (roadIds.has(approach.roadId))
      throw new Error(`Duplicate junction approach road ${approach.roadId}`);
    keys.add(approach.key);
    roadIds.add(approach.roadId);
  }
}

// ../three-roads-inspect/packages/core/src/geometry/reference-line-boundary-contacts.ts
function findReferenceLineBoundaryContacts(left, right, options, leftIntervals, rightIntervals) {
  const leftLength = referenceLineLength(left);
  const rightLength = referenceLineLength(right);
  return [
    ...contactsForEndpoint(left, right, 0, options, false, leftIntervals),
    ...contactsForEndpoint(left, right, rightLength, options, false, leftIntervals),
    ...contactsForEndpoint(right, left, 0, options, true, rightIntervals),
    ...contactsForEndpoint(right, left, leftLength, options, true, rightIntervals)
  ];
}
function contactsForEndpoint(host, endpointLine, endpointStation, options, swapsOutput, intervals) {
  const endpointPose = evaluateReferenceLine(endpointLine, endpointStation);
  const contacts = [];
  const hostIntervals = intervals ?? boundaryIntervals(host, options.step);
  for (const interval of hostIntervals) {
    if (!intervalCanReachEndpoint(interval, endpointPose, options.step))
      continue;
    const hostStation = nearestStationInInterval(host, interval.startS, interval.endS, endpointPose);
    const hostPose = evaluateReferenceLine(host, hostStation);
    if (Math.hypot(hostPose.x - endpointPose.x, hostPose.y - endpointPose.y) > options.tolerance)
      continue;
    if (!isTransverse(hostPose.heading, endpointPose.heading, options))
      continue;
    const contact = {
      leftS: swapsOutput ? endpointStation : hostStation,
      rightS: swapsOutput ? hostStation : endpointStation,
      point: {
        x: (hostPose.x + endpointPose.x) * 0.5,
        y: (hostPose.y + endpointPose.y) * 0.5
      }
    };
    if (!contacts.some((candidate) => sameContact(candidate, contact, options.tolerance))) {
      contacts.push(contact);
    }
  }
  return contacts;
}
function boundaryIntervals(referenceLine, step) {
  return referenceLine.geometry.flatMap((segment) => {
    const intervalCount = Math.max(1, Math.ceil(segment.length / step));
    return Array.from({ length: intervalCount }, (_, index) => {
      const startS = segment.s + segment.length * index / intervalCount;
      const endS = segment.s + segment.length * (index + 1) / intervalCount;
      return {
        startS,
        endS,
        start: evaluateReferenceLine(referenceLine, startS),
        end: evaluateReferenceLine(referenceLine, endS)
      };
    });
  });
}
function intervalCanReachEndpoint(interval, point, step) {
  return Math.min(Math.hypot(interval.start.x - point.x, interval.start.y - point.y), Math.hypot(interval.end.x - point.x, interval.end.y - point.y)) <= step * 2;
}
function nearestStationInInterval(referenceLine, intervalStart, intervalEnd, point) {
  let start = intervalStart;
  let end = intervalEnd;
  for (let iteration = 0;iteration < 64; iteration++) {
    const first = start + (end - start) / 3;
    const second = end - (end - start) / 3;
    if (distanceSquared(referenceLine, first, point) <= distanceSquared(referenceLine, second, point)) {
      end = second;
    } else {
      start = first;
    }
  }
  return (start + end) * 0.5;
}
function distanceSquared(referenceLine, station, point) {
  const pose = evaluateReferenceLine(referenceLine, station);
  return (pose.x - point.x) ** 2 + (pose.y - point.y) ** 2;
}
function isTransverse(leftHeading, rightHeading, options) {
  const threshold = Math.min(0.001, Math.max(0.00000001, 2 * Math.sqrt(options.tolerance / options.step)));
  return Math.abs(Math.sin(leftHeading - rightHeading)) > threshold;
}
function sameContact(left, right, tolerance) {
  const stationTolerance = Math.max(0.00000001, tolerance * 16);
  return Math.abs(left.leftS - right.leftS) <= stationTolerance && Math.abs(left.rightS - right.rightS) <= stationTolerance;
}

// ../three-roads-inspect/packages/core/src/geometry/reference-line-intersections.ts
var DEFAULT_STEP = 1;
var DEFAULT_TOLERANCE2 = 0.0000000001;
var DEFAULT_MAX_ITERATIONS = 24;
function referenceLinePlanBounds(referenceLine, step = 8) {
  return sampleReferenceLineEdges(referenceLine, step).bounds;
}
var sampledReferenceLines = new WeakMap;
var sampledReferenceLineContentCache = new Map;
var MAX_CONTENT_CACHE_ENTRIES = 512;
function findReferenceLineIntersections(left, right, options = {}) {
  const resolved = resolveOptions(options);
  if (left.geometry.length === 0 || right.geometry.length === 0)
    return [];
  const leftLength = referenceLineLength(left);
  const rightLength = referenceLineLength(right);
  const leftSample = sampleReferenceLineEdges(left, resolved.step);
  const rightSample = sampleReferenceLineEdges(right, resolved.step);
  if (!referenceBoundsOverlap(leftSample.bounds, rightSample.bounds, resolved.step + resolved.tolerance))
    return [];
  const intersections = findReferenceLineBoundaryContacts(left, right, resolved, leftSample.edges, rightSample.edges);
  for (const leftEdge of leftSample.edges) {
    for (const rightEdge of candidateEdges(rightSample, leftEdge, resolved.tolerance)) {
      if (!boundsOverlap3(leftEdge, rightEdge, resolved.tolerance))
        continue;
      const seed = segmentIntersectionSeed(leftEdge, rightEdge);
      if (!seed)
        continue;
      const intersection2 = refineIntersection(left, right, leftLength, rightLength, seed, resolved);
      if (intersection2)
        intersections.push(intersection2);
    }
  }
  intersections.sort((a, b) => a.leftS - b.leftS || a.rightS - b.rightS);
  return deduplicate(intersections, resolved.tolerance);
}
function resolveOptions(options) {
  const step = options.step ?? DEFAULT_STEP;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE2;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isFinite(step) || step <= 0)
    throw new RangeError("step must be a positive finite number");
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RangeError("tolerance must be a positive finite number");
  }
  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    throw new RangeError("maxIterations must be a positive integer");
  }
  return { step, tolerance, maxIterations };
}
function sampleReferenceLineEdges(referenceLine, step) {
  let samplesByStep = sampledReferenceLines.get(referenceLine.geometry);
  if (!samplesByStep) {
    samplesByStep = new Map;
    sampledReferenceLines.set(referenceLine.geometry, samplesByStep);
  }
  const cached = samplesByStep.get(step);
  if (cached)
    return cached;
  const contentKey = `${step}:${JSON.stringify(referenceLine.geometry)}`;
  const contentCached = sampledReferenceLineContentCache.get(contentKey);
  if (contentCached) {
    samplesByStep.set(step, contentCached);
    return contentCached;
  }
  const edges = [];
  for (const segment of referenceLine.geometry) {
    if (!Number.isFinite(segment.length) || segment.length <= 0)
      continue;
    const points = sampleReferenceLine({ geometry: [segment] }, {
      step,
      maxChordError: Number.POSITIVE_INFINITY,
      maxHeadingDelta: Number.POSITIVE_INFINITY
    });
    const intervalCount = points.length - 1;
    for (let index = 0;index < intervalCount; index++) {
      edges.push({
        startS: segment.s + segment.length * index / intervalCount,
        endS: segment.s + segment.length * (index + 1) / intervalCount,
        start: points[index],
        end: points[index + 1]
      });
    }
  }
  const gridCellSize = Math.max(1, step * 4);
  const sampled = {
    edges,
    bounds: sampleBounds(edges),
    edgeGrid: buildEdgeGrid(edges, gridCellSize),
    gridCellSize
  };
  samplesByStep.set(step, sampled);
  sampledReferenceLineContentCache.set(contentKey, sampled);
  if (sampledReferenceLineContentCache.size > MAX_CONTENT_CACHE_ENTRIES) {
    sampledReferenceLineContentCache.delete(sampledReferenceLineContentCache.keys().next().value);
  }
  return sampled;
}
function sampleBounds(edges) {
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };
  for (const edge of edges) {
    bounds.minX = Math.min(bounds.minX, edge.start.x, edge.end.x);
    bounds.minY = Math.min(bounds.minY, edge.start.y, edge.end.y);
    bounds.maxX = Math.max(bounds.maxX, edge.start.x, edge.end.x);
    bounds.maxY = Math.max(bounds.maxY, edge.start.y, edge.end.y);
  }
  return bounds;
}
function buildEdgeGrid(edges, cellSize) {
  const grid = new Map;
  edges.forEach((edge, index) => {
    const bounds = sampleEdgeBounds(edge);
    for (let x = Math.floor(bounds.minX / cellSize);x <= Math.floor(bounds.maxX / cellSize); x++) {
      for (let y = Math.floor(bounds.minY / cellSize);y <= Math.floor(bounds.maxY / cellSize); y++) {
        const key = `${x}:${y}`;
        const entries = grid.get(key);
        if (entries)
          entries.push(index);
        else
          grid.set(key, [index]);
      }
    }
  });
  return grid;
}
function candidateEdges(sample, edge, tolerance) {
  const bounds = sampleEdgeBounds(edge);
  const indexes = new Set;
  const minX = Math.floor((bounds.minX - tolerance) / sample.gridCellSize);
  const maxX = Math.floor((bounds.maxX + tolerance) / sample.gridCellSize);
  const minY = Math.floor((bounds.minY - tolerance) / sample.gridCellSize);
  const maxY = Math.floor((bounds.maxY + tolerance) / sample.gridCellSize);
  for (let x = minX;x <= maxX; x++) {
    for (let y = minY;y <= maxY; y++) {
      for (const index of sample.edgeGrid.get(`${x}:${y}`) ?? [])
        indexes.add(index);
    }
  }
  return [...indexes].map((index) => sample.edges[index]);
}
function sampleEdgeBounds(edge) {
  return {
    minX: Math.min(edge.start.x, edge.end.x),
    minY: Math.min(edge.start.y, edge.end.y),
    maxX: Math.max(edge.start.x, edge.end.x),
    maxY: Math.max(edge.start.y, edge.end.y)
  };
}
function referenceBoundsOverlap(left, right, padding) {
  return left.maxX + padding >= right.minX && right.maxX + padding >= left.minX && left.maxY + padding >= right.minY && right.maxY + padding >= left.minY;
}
function boundsOverlap3(left, right, tolerance) {
  return Math.max(left.start.x, left.end.x) + tolerance >= Math.min(right.start.x, right.end.x) && Math.max(right.start.x, right.end.x) + tolerance >= Math.min(left.start.x, left.end.x) && Math.max(left.start.y, left.end.y) + tolerance >= Math.min(right.start.y, right.end.y) && Math.max(right.start.y, right.end.y) + tolerance >= Math.min(left.start.y, left.end.y);
}
function segmentIntersectionSeed(left, right) {
  const leftX = left.end.x - left.start.x;
  const leftY = left.end.y - left.start.y;
  const rightX = right.end.x - right.start.x;
  const rightY = right.end.y - right.start.y;
  const denominator = cross8(leftX, leftY, rightX, rightY);
  const scale2 = Math.max(1, Math.hypot(leftX, leftY) * Math.hypot(rightX, rightY));
  if (Math.abs(denominator) <= Number.EPSILON * scale2 * 32)
    return;
  const startX = right.start.x - left.start.x;
  const startY = right.start.y - left.start.y;
  const leftRatio = cross8(startX, startY, rightX, rightY) / denominator;
  const rightRatio = cross8(startX, startY, leftX, leftY) / denominator;
  const ratioTolerance = 0.000000000001;
  if (leftRatio < -ratioTolerance || leftRatio > 1 + ratioTolerance || rightRatio < -ratioTolerance || rightRatio > 1 + ratioTolerance)
    return;
  return {
    leftS: interpolate3(left.startS, left.endS, clamp4(leftRatio, 0, 1)),
    rightS: interpolate3(right.startS, right.endS, clamp4(rightRatio, 0, 1))
  };
}
function refineIntersection(left, right, leftLength, rightLength, seed, options) {
  let leftS = clamp4(seed.leftS, 0, leftLength);
  let rightS = clamp4(seed.rightS, 0, rightLength);
  let converged = false;
  for (let iteration = 0;iteration < options.maxIterations; iteration++) {
    const leftPose2 = evaluateReferenceLine(left, leftS);
    const rightPose2 = evaluateReferenceLine(right, rightS);
    const residualX = leftPose2.x - rightPose2.x;
    const residualY = leftPose2.y - rightPose2.y;
    const leftTangent = stationTangent(left, leftS, leftPose2.heading);
    const rightTangent = stationTangent(right, rightS, rightPose2.heading);
    const denominator = cross8(leftTangent.x, leftTangent.y, rightTangent.x, rightTangent.y);
    const tangentScale = Math.hypot(leftTangent.x, leftTangent.y) * Math.hypot(rightTangent.x, rightTangent.y);
    if (tangentScale <= Number.EPSILON || Math.abs(denominator) <= Number.EPSILON * tangentScale * 32) {
      return;
    }
    const leftDelta = -cross8(residualX, residualY, rightTangent.x, rightTangent.y) / denominator;
    const rightDelta = -cross8(residualX, residualY, leftTangent.x, leftTangent.y) / denominator;
    if (Math.hypot(residualX, residualY) <= options.tolerance && Math.max(Math.abs(leftDelta), Math.abs(rightDelta)) <= options.tolerance) {
      converged = true;
      break;
    }
    const nextLeftS = clamp4(leftS + leftDelta, 0, leftLength);
    const nextRightS = clamp4(rightS + rightDelta, 0, rightLength);
    if (nextLeftS === leftS && nextRightS === rightS)
      return;
    leftS = nextLeftS;
    rightS = nextRightS;
  }
  if (!converged)
    return;
  const leftPose = evaluateReferenceLine(left, leftS);
  const rightPose = evaluateReferenceLine(right, rightS);
  if (Math.hypot(leftPose.x - rightPose.x, leftPose.y - rightPose.y) > options.tolerance)
    return;
  const headingCross = Math.abs(Math.sin(leftPose.heading - rightPose.heading));
  const transverseThreshold = Math.min(0.001, Math.max(0.00000001, 2 * Math.sqrt(options.tolerance / options.step)));
  if (headingCross <= transverseThreshold)
    return;
  return {
    leftS,
    rightS,
    point: {
      x: (leftPose.x + rightPose.x) * 0.5,
      y: (leftPose.y + rightPose.y) * 0.5
    }
  };
}
function stationTangent(referenceLine, s, heading) {
  const segment = segmentAt2(referenceLine, s);
  const speed = segment.kind === "param-poly3" ? paramPolySpeed(segment, s - segment.s) : 1;
  return { x: Math.cos(heading) * speed, y: Math.sin(heading) * speed };
}
function segmentAt2(referenceLine, s) {
  for (const segment of referenceLine.geometry) {
    if (s >= segment.s - 0.0000001 && s <= segment.s + segment.length + 0.0000001)
      return segment;
  }
  return referenceLine.geometry[referenceLine.geometry.length - 1];
}
function paramPolySpeed(segment, localS) {
  const clampedS = clamp4(localS, 0, segment.length);
  const parameter = segment.pRange === "normalized" ? clampedS / segment.length : clampedS;
  const parameterRate = segment.pRange === "normalized" ? 1 / segment.length : 1;
  return Math.hypot(evaluateCubicDerivative(segment.u, parameter), evaluateCubicDerivative(segment.v, parameter)) * parameterRate;
}
function deduplicate(intersections, tolerance) {
  const stationTolerance = Math.max(0.00000001, tolerance * 16);
  const unique = [];
  for (const intersection2 of intersections) {
    const duplicate = unique.some((candidate) => Math.abs(candidate.leftS - intersection2.leftS) <= stationTolerance && Math.abs(candidate.rightS - intersection2.rightS) <= stationTolerance);
    if (!duplicate)
      unique.push(intersection2);
  }
  return unique;
}
function interpolate3(start, end, ratio) {
  return start + (end - start) * ratio;
}
function clamp4(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
function cross8(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

// ../three-roads-inspect/packages/core/src/authoring-document/plan-crossing-audit.ts
var DEFAULT_STATION_TOLERANCE = 0.00001;
var CROSSING_GRID_CELL_SIZE = 128;
var CROSSING_BOUNDS_PADDING = 8;
function auditPlanCrossings(document, options = {}) {
  const stationTolerance = options.stationTolerance ?? DEFAULT_STATION_TOLERANCE;
  if (!Number.isFinite(stationTolerance) || stationTolerance < 0) {
    throw new RangeError("stationTolerance must be a non-negative finite number");
  }
  const strokes = [...document.strokes].sort((left, right) => compareText(left.id, right.id));
  const strokeLengths = new Map(strokes.map((stroke) => [
    stroke.id,
    referenceLineLength({ geometry: stroke.geometry })
  ]));
  const junctionsByRoad = ownersByRoad(document.junctions, (junction) => junction.ports.map(({ roadId }) => roadId));
  const separationsByRoad = ownersByRoad(document.gradeSeparations ?? [], (separation) => [
    separation.upperRoad.roadId,
    separation.lowerRoad.roadId
  ]);
  const crossings = [];
  for (const [leftIndex, rightIndex] of candidateStrokePairs(strokes)) {
    const left = strokes[leftIndex];
    const right = strokes[rightIndex];
    for (const intersection2 of findReferenceLineIntersections({ geometry: left.geometry }, { geometry: right.geometry }, options.intersectionOptions)) {
      const topologyJunctionIds = sharedOwners(junctionsByRoad.get(left.id), junctionsByRoad.get(right.id)).filter((junction) => junctionCoversCrossing(junction, left, right, intersection2.leftS, intersection2.rightS, strokeLengths, stationTolerance)).map((junction) => junction.id).sort(compareText);
      const gradeSeparationIds = sharedOwners(separationsByRoad.get(left.id), separationsByRoad.get(right.id)).filter((intent) => gradeSeparationCoversCrossing(intent, left.id, right.id, intersection2.leftS, intersection2.rightS, stationTolerance)).map((intent) => intent.id).sort(compareText);
      crossings.push({
        leftRoadId: left.id,
        rightRoadId: right.id,
        leftS: intersection2.leftS,
        rightS: intersection2.rightS,
        point: intersection2.point,
        classification: classify(topologyJunctionIds.length, gradeSeparationIds.length),
        topologyJunctionIds,
        gradeSeparationIds
      });
    }
  }
  crossings.sort(compareCrossings);
  return {
    ok: crossings.every((crossing) => crossing.classification !== "missing" && crossing.classification !== "multiply-covered"),
    crossings
  };
}
function ownersByRoad(owners, roadIds) {
  const index = new Map;
  for (const owner of owners) {
    for (const roadId of new Set(roadIds(owner))) {
      const values = index.get(roadId);
      if (values)
        values.push(owner);
      else
        index.set(roadId, [owner]);
    }
  }
  return index;
}
function sharedOwners(left, right) {
  if (!left || !right)
    return [];
  const rightIds = new Set(right.map(({ id }) => id));
  return left.filter(({ id }) => rightIds.has(id));
}
function candidateStrokePairs(strokes) {
  const cells = new Map;
  strokes.forEach((stroke, index) => {
    const bounds = referenceLinePlanBounds({ geometry: stroke.geometry });
    const minX = Math.floor((bounds.minX - CROSSING_BOUNDS_PADDING) / CROSSING_GRID_CELL_SIZE);
    const maxX = Math.floor((bounds.maxX + CROSSING_BOUNDS_PADDING) / CROSSING_GRID_CELL_SIZE);
    const minY = Math.floor((bounds.minY - CROSSING_BOUNDS_PADDING) / CROSSING_GRID_CELL_SIZE);
    const maxY = Math.floor((bounds.maxY + CROSSING_BOUNDS_PADDING) / CROSSING_GRID_CELL_SIZE);
    for (let x = minX;x <= maxX; x++) {
      for (let y = minY;y <= maxY; y++) {
        const key = `${x}:${y}`;
        const values = cells.get(key);
        if (values)
          values.push(index);
        else
          cells.set(key, [index]);
      }
    }
  });
  const keys = new Set;
  for (const indexes of cells.values()) {
    for (let left = 0;left < indexes.length; left++) {
      for (let right = left + 1;right < indexes.length; right++) {
        const a = Math.min(indexes[left], indexes[right]);
        const b = Math.max(indexes[left], indexes[right]);
        if (a !== b)
          keys.add(`${a}:${b}`);
      }
    }
  }
  return [...keys].map((key) => {
    const separator = key.indexOf(":");
    return [Number(key.slice(0, separator)), Number(key.slice(separator + 1))];
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}
function junctionCoversCrossing(junction, left, right, leftS, rightS, strokeLengths, tolerance) {
  const leftPorts = matchingPorts(junction, left.id, leftS, strokeLengths, tolerance);
  const rightPorts = matchingPorts(junction, right.id, rightS, strokeLengths, tolerance);
  if (leftPorts.length === 0 || rightPorts.length === 0)
    return false;
  if (junction.kind === "crossing")
    return true;
  const leftPortIds = new Set(leftPorts.map(junctionPortId));
  const rightPortIds = new Set(rightPorts.map(junctionPortId));
  return junction.maneuvers.some((maneuver) => {
    if (maneuver.fromRoadId === left.id && maneuver.toRoadId === right.id) {
      return maneuverUsesPorts(junction, maneuver.fromRoadId, maneuver.fromPortId, leftPortIds, maneuver.toRoadId, maneuver.toPortId, rightPortIds);
    }
    if (maneuver.fromRoadId === right.id && maneuver.toRoadId === left.id) {
      return maneuverUsesPorts(junction, maneuver.fromRoadId, maneuver.fromPortId, rightPortIds, maneuver.toRoadId, maneuver.toPortId, leftPortIds);
    }
    return false;
  });
}
function matchingPorts(junction, roadId, crossingS, strokeLengths, tolerance) {
  const roadLength = strokeLengths.get(roadId);
  if (roadLength === undefined)
    return [];
  return junction.ports.filter((port) => port.roadId === roadId && Math.abs(portStation4(port, roadLength) - crossingS) <= tolerance);
}
function portStation4(port, roadLength) {
  return port.s ?? (port.contactPoint === "start" ? 0 : roadLength);
}
function maneuverUsesPorts(junction, fromRoadId, fromPortId, matchingFromPortIds, toRoadId, toPortId, matchingToPortIds) {
  const resolvedFromPortId = maneuverPortId(junction, fromRoadId, fromPortId);
  const resolvedToPortId = maneuverPortId(junction, toRoadId, toPortId);
  return resolvedFromPortId !== undefined && resolvedToPortId !== undefined && matchingFromPortIds.has(resolvedFromPortId) && matchingToPortIds.has(resolvedToPortId);
}
function gradeSeparationCoversCrossing(intent, leftRoadId, rightRoadId, leftS, rightS, tolerance) {
  if (intent.upperRoad.roadId === leftRoadId && intent.lowerRoad.roadId === rightRoadId) {
    return stationsMatch(intent.upperRoad.s, leftS, intent.lowerRoad.s, rightS, tolerance);
  }
  if (intent.upperRoad.roadId === rightRoadId && intent.lowerRoad.roadId === leftRoadId) {
    return stationsMatch(intent.upperRoad.s, rightS, intent.lowerRoad.s, leftS, tolerance);
  }
  return false;
}
function stationsMatch(firstIntentS, firstCrossingS, secondIntentS, secondCrossingS, tolerance) {
  return Math.abs(firstIntentS - firstCrossingS) <= tolerance && Math.abs(secondIntentS - secondCrossingS) <= tolerance;
}
function classify(topologyCount, gradeSeparationCount) {
  const coverageCount = topologyCount + gradeSeparationCount;
  if (coverageCount === 0)
    return "missing";
  if (coverageCount > 1)
    return "multiply-covered";
  return topologyCount === 1 ? "topology-covered" : "grade-separation-covered";
}
function compareCrossings(left, right) {
  return compareText(left.leftRoadId, right.leftRoadId) || compareText(left.rightRoadId, right.rightRoadId) || left.leftS - right.leftS || left.rightS - right.rightS || left.point.x - right.point.x || left.point.y - right.point.y;
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ../three-roads-inspect/packages/core/src/automatic-network/reserve-junction-footprint.ts
var EPSILON14 = 0.0000001;
function reserveJunctionFootprints(document, reservations) {
  const setbacks = new Map;
  for (const { endpoints, setback } of reservations) {
    for (const endpoint of endpoints) {
      const current = setbacks.get(endpoint.road.id) ?? { start: 0, end: 0 };
      current[endpoint.contactPoint] = Math.max(current[endpoint.contactPoint], setback);
      setbacks.set(endpoint.road.id, current);
    }
  }
  const trims = new Map;
  const strokes = document.strokes.map((stroke) => {
    const reserved = setbacks.get(stroke.id);
    if (!reserved)
      return stroke;
    const length = referenceLineLength({ geometry: stroke.geometry });
    if (length <= reserved.start + reserved.end + EPSILON14) {
      throw new Error(`Road ${stroke.id} is too short for its junction portal setbacks`);
    }
    const start = reserved.start;
    const end = length - reserved.end;
    trims.set(stroke.id, { start, end, length: end - start, originalLength: length });
    return trimStroke(stroke, start, end, length);
  });
  if (trims.size === 0)
    return document;
  return remapAttachments({ ...document, strokes }, document, trims);
}
function trimStroke(stroke, start, end, originalLength) {
  return {
    ...stroke,
    geometry: sliceReferenceLine({ geometry: stroke.geometry }, start, end).geometry,
    templateSpans: start > EPSILON14 ? shiftTemplateSpans(stroke.templateSpans, start).filter((span) => span.s < end - start - EPSILON14) : stroke.templateSpans.filter((span) => span.s < end - EPSILON14),
    elevation: shiftProfile(stroke.elevation, start, end),
    superelevation: shiftProfile(stroke.superelevation, start, end),
    links: {
      ...stroke.links,
      predecessor: start > EPSILON14 ? undefined : stroke.links?.predecessor,
      successor: end < originalLength - EPSILON14 ? undefined : stroke.links?.successor
    }
  };
}
function remapAttachments(document, previous, trims) {
  const frame = (roadId) => trims.get(roadId);
  const strokes = new Map(document.strokes.map((stroke) => [stroke.id, stroke]));
  const range = (value) => {
    const trim = frame(value.roadId);
    return trim ? remapRangeAfterTrim(value, trim) : value;
  };
  const marking = (value) => {
    const trim = frame(value.roadId);
    if (!trim)
      return value;
    return value.kind === "arrow" ? { ...value, s: remapStationAfterTrim(value.s, trim) } : remapRangeAfterTrim(value, trim);
  };
  const object = (value) => {
    const trim = frame(value.roadId);
    return trim ? remapObjectAfterTrim(value, trim) : value;
  };
  const gradeSeparation = (value) => {
    const upperTrim = frame(value.upperRoad.roadId);
    const lowerTrim = frame(value.lowerRoad.roadId);
    return {
      ...value,
      upperRoad: upperTrim ? { ...value.upperRoad, s: remapStationAfterTrim(value.upperRoad.s, upperTrim) } : value.upperRoad,
      lowerRoad: lowerTrim ? { ...value.lowerRoad, s: remapStationAfterTrim(value.lowerRoad.s, lowerTrim) } : value.lowerRoad,
      deckExtent: upperTrim ? remapRangeAfterTrim(value.deckExtent, upperTrim) : value.deckExtent
    };
  };
  const remapped = {
    ...document,
    junctions: document.junctions.map((junction) => ({
      ...junction,
      ports: junction.ports.map((port) => {
        const trim = frame(port.roadId);
        return trim && port.s !== undefined ? { ...port, s: remapStationAfterTrim(port.s, trim) } : port;
      }),
      virtualRange: junction.virtualRange && frame(junction.virtualRange.mainRoadId) ? remapRangeAfterTrim(junction.virtualRange, frame(junction.virtualRange.mainRoadId)) : junction.virtualRange
    })),
    gradeSeparations: document.gradeSeparations?.map(gradeSeparation),
    roadStructures: document.roadStructures?.map(range),
    roadsideFeatures: document.roadsideFeatures?.map(range),
    roadSurfaceElevations: document.roadSurfaceElevations?.map((elevation) => {
      const trim = frame(elevation.roadId);
      return trim ? fitSurfaceElevationAfterTrim(elevation, trim) : elevation;
    }),
    weavingSections: document.weavingSections?.map((weaving) => {
      const trim = frame(weaving.roadId);
      return trim ? fitWeavingAfterTrim(weaving, trim) : weaving;
    }),
    markings: document.markings?.map(marking),
    objects: document.objects?.map(object),
    regulations: document.regulations?.map(range),
    trafficManagementPlans: document.trafficManagementPlans?.map((plan) => ({
      ...plan,
      phases: plan.phases.map((phase) => ({
        ...phase,
        laneOperations: phase.laneOperations.map((operation) => {
          const remapped2 = range(operation);
          const stroke = strokes.get(remapped2.roadId);
          return stroke ? alignLaneOperationToStroke(remapped2, stroke) : remapped2;
        }),
        regulations: phase.regulations?.map(range)
      }))
    })),
    facilities: document.facilities?.map((facility) => {
      if (facility.kind === "protected-cycle-corner")
        return facility;
      const trim = frame(facility.strokeId);
      if (!trim)
        return facility;
      return fitFacilityAfterTrim(facility, trim);
    })
  };
  return remapStreetscapeAfterRoadTrims(previous, remapped, trims);
}
function shiftTemplateSpans(spans, start) {
  const sorted = [...spans].sort((left, right) => left.s - right.s);
  const active = sorted.filter((span) => span.s <= start + EPSILON14).at(-1);
  if (!active)
    throw new Error("Road has no active template at its junction portal");
  const first = { ...active, s: 0 };
  if (Math.abs(active.s - start) > EPSILON14)
    delete first.transitionLength;
  return [first, ...sorted.filter((span) => span.s > start + EPSILON14).map((span) => ({ ...span, s: span.s - start }))];
}
function shiftProfile(profile, start, end) {
  if (!profile)
    return;
  const sorted = [...profile].sort((left, right) => left.s - right.s);
  const active = sorted.filter((record) => record.s <= start + EPSILON14).at(-1);
  if (!active)
    return;
  return [
    { ...active, ...shiftCubic(active, start - active.s), s: 0 },
    ...sorted.filter((record) => record.s > start + EPSILON14 && record.s < end - EPSILON14).map((record) => ({ ...record, s: record.s - start }))
  ];
}

// ../three-roads-inspect/packages/core/src/automatic-network/apply-ordinary-node-intents.ts
function applyOrdinaryNodeIntents(document, nodes) {
  const diagnostics = [];
  const generatedIds = new Set(nodes.filter(({ kind }) => kind === "common-junction").map(({ sourceId }) => sourceId));
  let junctions = document.junctions;
  for (const intent of document.ordinaryNodeIntents ?? []) {
    const index = junctions.findIndex((junction2) => generatedIds.has(junction2.id) && junctionContactsKey(junction2) === ordinaryNodeContactsKey(intent.contacts));
    const point = nodePoint(nodes, intent.contacts.map(({ roadId }) => roadId));
    const roadIds = intent.contacts.map(({ roadId }) => roadId).sort();
    if (index < 0) {
      diagnostics.push({ code: "ordinary-node-target-missing", message: `Ordinary node intent ${intent.id} does not match generated topology`, roadIds, point, sourceId: intent.id });
      continue;
    }
    const junction = junctions[index];
    const remapped = applyMovementMappings(document, junction, intent.movementMappings ?? [], diagnostics, roadIds, point, intent.id);
    const prohibitedClasses = new Set(intent.prohibitedParticipantClasses ?? []);
    const classFiltered = remapped.filter(({ participantClass }) => !participantClass || !prohibitedClasses.has(participantClass));
    const prohibited = new Set;
    for (const selector of intent.prohibitedMovements ?? []) {
      const maneuver = classFiltered.find((candidate) => matchesSelector(junction, candidate, selector));
      if (!maneuver)
        diagnostics.push({ code: "ordinary-node-selector-stale", message: `Ordinary node intent ${intent.id} has a stale prohibited movement selector`, roadIds, point, sourceId: intent.id });
      else
        prohibited.add(maneuver.id);
    }
    const maneuvers = classFiltered.filter(({ id }) => !prohibited.has(id));
    if (intent.control) {
      for (const reference of staleControlReferences(junction, maneuvers, intent.control)) {
        diagnostics.push({ code: "ordinary-node-control-reference-stale", message: `Ordinary node intent ${intent.id} control references missing ${reference}`, roadIds, point, sourceId: intent.id });
      }
    }
    const updated = {
      ...junction,
      maneuvers,
      ...intent.control ? { control: structuredClone(intent.control) } : {}
    };
    junctions = junctions.map((candidate, candidateIndex) => candidateIndex === index ? updated : candidate);
  }
  return { document: { ...document, junctions }, diagnostics };
}
function applyMovementMappings(document, junction, mappings, diagnostics, roadIds, point, sourceId) {
  let maneuvers = [...junction.maneuvers];
  for (const selector of mappings) {
    const candidates = maneuvers.filter((maneuver) => matchesOriginDestination(junction, maneuver, selector));
    const targetLane = endpointLane(document, selector.to);
    const participantCompatible = candidates.length > 0 && targetLane ? laneSupportsParticipant(targetLane.type, candidates[0].participantClass) : false;
    if (candidates.length === 0 || !targetLane || !participantCompatible) {
      diagnostics.push({ code: "ordinary-node-mapping-stale", message: `Ordinary node intent ${sourceId} has a stale explicit lane mapping`, roadIds, point, sourceId });
      continue;
    }
    const base = candidates[0];
    maneuvers = [
      ...maneuvers.filter((maneuver) => !matchesOriginDestination(junction, maneuver, selector)),
      {
        ...base,
        id: `${sourceId}|mapped|${ordinaryNodeMappingToken(selector)}`,
        toLaneRole: selector.to.laneRole
      }
    ];
  }
  return maneuvers;
}
function endpointLane(document, endpoint) {
  const stroke = document.strokes.find(({ id }) => id === endpoint.roadId);
  if (!stroke)
    return;
  const station = endpoint.contactPoint === "start" ? 0 : stroke.geometry.reduce((sum, segment) => sum + segment.length, 0);
  const span = [...stroke.templateSpans].sort((left, right) => left.s - right.s).filter(({ s }) => s <= station + 0.0000001).at(-1);
  const template = document.templates.find(({ id }) => id === span?.templateId);
  return template?.lanes.find(({ role }) => role === endpoint.laneRole);
}
function laneSupportsParticipant(laneType, participantClass) {
  if (participantClass === "bicycle")
    return laneType === "biking";
  if (participantClass === "tram")
    return laneType === "tram" || laneType === "rail";
  if (participantClass === "pedestrian")
    return laneType === "sidewalk";
  return ["driving", "entry", "exit", "on-ramp", "off-ramp", "bus", "restricted", "shared"].includes(laneType);
}
function matchesOriginDestination(junction, maneuver, selector) {
  const fromPort = junction.ports.find(({ id }) => id === maneuver.fromPortId);
  const toPort = junction.ports.find(({ id }) => id === maneuver.toPortId);
  return maneuver.fromRoadId === selector.from.roadId && maneuver.fromLaneRole === selector.from.laneRole && fromPort?.contactPoint === selector.from.contactPoint && maneuver.toRoadId === selector.to.roadId && toPort?.contactPoint === selector.to.contactPoint;
}
function ordinaryNodeMappingToken(selector) {
  return [selector.from.roadId, selector.from.laneRole, selector.to.roadId, selector.to.laneRole].join("-").replace(/[^a-zA-Z0-9_-]/g, "_");
}
function junctionContactsKey(junction) {
  return ordinaryNodeContactsKey(junction.ports.map(({ roadId, contactPoint }) => ({ roadId, contactPoint })));
}
function matchesSelector(junction, maneuver, selector) {
  const fromPort = junction.ports.find(({ id }) => id === maneuver.fromPortId);
  const toPort = junction.ports.find(({ id }) => id === maneuver.toPortId);
  return maneuver.fromRoadId === selector.from.roadId && maneuver.fromLaneRole === selector.from.laneRole && fromPort?.contactPoint === selector.from.contactPoint && maneuver.toRoadId === selector.to.roadId && maneuver.toLaneRole === selector.to.laneRole && toPort?.contactPoint === selector.to.contactPoint;
}
function staleControlReferences(junction, maneuvers, control) {
  const portIds = new Set(junction.ports.flatMap(({ id }) => id ? [id] : []));
  const maneuverIds = new Set(maneuvers.map(({ id }) => id));
  if (control.kind === "priority")
    return control.priorityPortIds.filter((id) => !portIds.has(id)).map((id) => `port ${id}`);
  if (control.kind === "roundabout")
    return control.circulatingManeuverIds.filter((id) => !maneuverIds.has(id)).map((id) => `maneuver ${id}`);
  if (control.kind !== "signal")
    return [];
  const groupIds = new Set(control.groups.map(({ id }) => id));
  return [
    ...control.groups.flatMap(({ participantIds }) => participantIds.filter((id) => !maneuverIds.has(id)).map((id) => `participant ${id}`)),
    ...control.phases.flatMap(({ greenGroupIds }) => greenGroupIds.filter((id) => !groupIds.has(id)).map((id) => `group ${id}`))
  ];
}
function nodePoint(nodes, roadIds) {
  return nodes.find((node) => roadIds.every((id) => node.roadIds.includes(id)))?.point ?? { x: 0, y: 0 };
}

// ../three-roads-inspect/packages/core/src/automatic-network/fit-automatic-bridge-clearance.ts
var EPSILON15 = 0.0000001;
var MAX_NEAR_CLEARANCE_LIFT = 0.5;
function fitAutomaticBridgeClearance(document) {
  const crossings = auditPlanCrossings(document).crossings.filter(({ classification }) => classification === "missing");
  if (crossings.length === 0 || !document.roadStructures?.length)
    return document;
  const templates = new Map(document.templates.map((template) => [template.id, template]));
  const roads = new Map(document.strokes.flatMap((stroke) => {
    try {
      return [[stroke.id, compileRoadStroke(stroke, templates).road]];
    } catch {
      return [];
    }
  }));
  const lifts = new Map;
  for (const crossing of crossings) {
    const left = roads.get(crossing.leftRoadId);
    const right = roads.get(crossing.rightRoadId);
    if (!left || !right)
      continue;
    const leftSurface = laneSurfaceCrossSectionExtrema(left, crossing.leftS);
    const rightSurface = laneSurfaceCrossSectionExtrema(right, crossing.rightS);
    const upper = leftSurface.minimumZ > rightSurface.maximumZ + EPSILON15 ? { road: left, station: crossing.leftS, gap: leftSurface.minimumZ - rightSurface.maximumZ } : rightSurface.minimumZ > leftSurface.maximumZ + EPSILON15 ? { road: right, station: crossing.rightS, gap: rightSurface.minimumZ - leftSurface.maximumZ } : undefined;
    if (!upper)
      continue;
    const structure = coveringFullSpanBridge(document.roadStructures, upper.road, upper.station);
    if (!structure || hasOwnedEndpoint(document, upper.road.id))
      continue;
    const lift = structure.structuralThickness - upper.gap;
    if (lift <= EPSILON15 || lift > MAX_NEAR_CLEARANCE_LIFT + EPSILON15)
      continue;
    lifts.set(upper.road.id, Math.max(lifts.get(upper.road.id) ?? 0, lift + EPSILON15));
  }
  if (lifts.size === 0)
    return document;
  return {
    ...document,
    strokes: document.strokes.map((stroke) => {
      const lift = lifts.get(stroke.id);
      return lift === undefined ? stroke : liftStroke(stroke, lift);
    })
  };
}
function coveringFullSpanBridge(structures, road, station) {
  return structures.find((structure) => structure.kind === "bridge" && structure.roadId === road.id && structure.sStart <= EPSILON15 && structure.sEnd >= road.length - EPSILON15 && structure.sStart <= station + EPSILON15 && structure.sEnd >= station - EPSILON15);
}
function hasOwnedEndpoint(document, roadId) {
  const stroke = document.strokes.find(({ id }) => id === roadId);
  if (!stroke)
    return true;
  if (stroke.links?.predecessor || stroke.links?.successor)
    return true;
  if (document.junctions.some((junction) => junction.ports.some((port) => port.roadId === roadId))) {
    return true;
  }
  const endpoints = strokeEndpoints(stroke);
  return document.strokes.some((candidate) => candidate.id !== roadId && endpoints.some((endpoint) => strokeEndpoints(candidate).some((other) => Math.hypot(endpoint.x - other.x, endpoint.y - other.y) <= 0.05)));
}
function strokeEndpoints(stroke) {
  const length = referenceLineLength({ geometry: stroke.geometry });
  return [
    evaluateReferenceLine({ geometry: stroke.geometry }, 0),
    evaluateReferenceLine({ geometry: stroke.geometry }, length)
  ];
}
function liftStroke(stroke, lift) {
  return {
    ...stroke,
    elevation: stroke.elevation?.length ? stroke.elevation.map((record) => ({ ...record, a: record.a + lift })) : [{ s: 0, a: lift, b: 0, c: 0, d: 0 }]
  };
}

// ../three-roads-inspect/packages/core/src/automatic-network/infer-automatic-grade-separations.ts
var SURFACE_SEPARATION_TOLERANCE = 0.00001;
var STRUCTURELESS_MIN_PAVEMENT_GAP = 0.5;
var FREE_SURFACE_THICKNESS = 0.01;
var FREE_DECK_EXTENT_LENGTH = 1;
function inferAutomaticGradeSeparations(document) {
  if (hasNoVerticalSeparationIntent(document))
    return document;
  const fittedDocument = fitAutomaticBridgeClearance(document);
  const missingCrossings = auditPlanCrossings(fittedDocument).crossings.filter((crossing) => crossing.classification === "missing");
  if (missingCrossings.length === 0)
    return fittedDocument;
  const templates = new Map(fittedDocument.templates.map((template) => [template.id, template]));
  const crossingRoadIds = new Set(missingCrossings.flatMap((crossing) => [
    crossing.leftRoadId,
    crossing.rightRoadId
  ]));
  const roads = new Map;
  for (const stroke of fittedDocument.strokes.filter(({ id }) => crossingRoadIds.has(id))) {
    const road = compileSurfaceRoad(stroke, templates);
    if (road)
      roads.set(stroke.id, road);
  }
  const inferred = missingCrossings.flatMap((crossing) => {
    const intent = inferredIntent(fittedDocument, roads, crossing);
    return intent ? [intent] : [];
  });
  if (inferred.length === 0)
    return fittedDocument;
  return {
    ...fittedDocument,
    gradeSeparations: [
      ...(fittedDocument.gradeSeparations ?? []).map((intent) => structuredClone(intent)),
      ...inferred
    ]
  };
}
function hasNoVerticalSeparationIntent(document) {
  if ((document.roadStructures ?? []).some(({ kind }) => kind === "bridge")) {
    return false;
  }
  const elevations = document.strokes.map((stroke) => constantProfileElevation(stroke.elevation));
  return elevations.every((elevation) => elevation !== undefined) && new Set(elevations).size <= 1;
}
function constantProfileElevation(records) {
  if (!records || records.length === 0)
    return 0;
  const elevation = records[0].a;
  return records.every(({ a, b, c, d }) => a === elevation && b === 0 && c === 0 && d === 0) ? elevation : undefined;
}
function compileSurfaceRoad(stroke, templates) {
  try {
    return compileRoadStroke(stroke, templates).road;
  } catch {
    return;
  }
}
function inferredIntent(document, roads, crossing) {
  const leftRoad = roads.get(crossing.leftRoadId);
  const rightRoad = roads.get(crossing.rightRoadId);
  if (!leftRoad || !rightRoad)
    return;
  const leftSurface = laneSurfaceCrossSectionExtrema(leftRoad, crossing.leftS);
  const rightSurface = laneSurfaceCrossSectionExtrema(rightRoad, crossing.rightS);
  const leftAboveGap = leftSurface.minimumZ - rightSurface.maximumZ;
  const rightAboveGap = rightSurface.minimumZ - leftSurface.maximumZ;
  const upperIsLeft = leftAboveGap > SURFACE_SEPARATION_TOLERANCE ? true : rightAboveGap > SURFACE_SEPARATION_TOLERANCE ? false : undefined;
  if (upperIsLeft === undefined)
    return;
  const upperRoad = upperIsLeft ? leftRoad : rightRoad;
  const lowerRoad = upperIsLeft ? rightRoad : leftRoad;
  const upperS = upperIsLeft ? crossing.leftS : crossing.rightS;
  const lowerS = upperIsLeft ? crossing.rightS : crossing.leftS;
  const pavementGap = upperIsLeft ? leftAboveGap : rightAboveGap;
  const structure = coveringBridge(document.roadStructures ?? [], upperRoad.id, upperS);
  if (!structure && pavementGap < STRUCTURELESS_MIN_PAVEMENT_GAP)
    return;
  const deckThickness = structure?.structuralThickness ?? Math.min(FREE_SURFACE_THICKNESS, pavementGap / 2);
  if (pavementGap + 0.0000001 < deckThickness)
    return;
  return {
    id: automaticGradeSeparationId(upperRoad.id, lowerRoad.id, upperS, lowerS),
    structureId: structure?.id,
    upperRoad: { roadId: upperRoad.id, s: upperS },
    lowerRoad: { roadId: lowerRoad.id, s: lowerS },
    kind: structure?.kind ?? "bridge",
    deckThickness,
    minimumClearance: 0,
    deckExtent: structure ? { sStart: structure.sStart, sEnd: structure.sEnd } : centeredExtent(upperRoad.length, upperS)
  };
}
function coveringBridge(structures, roadId, station) {
  return structures.filter((structure) => structure.kind === "bridge" && structure.roadId === roadId && structure.sStart <= station + SURFACE_SEPARATION_TOLERANCE && structure.sEnd >= station - SURFACE_SEPARATION_TOLERANCE).sort((left, right) => left.id.localeCompare(right.id))[0];
}
function centeredExtent(roadLength, station) {
  const length = Math.min(FREE_DECK_EXTENT_LENGTH, roadLength);
  const sStart = Math.max(0, Math.min(roadLength - length, station - length / 2));
  return { sStart, sEnd: sStart + length };
}
function automaticGradeSeparationId(upperRoadId, lowerRoadId, upperS, lowerS) {
  return `auto-grade-separation|${upperRoadId}|over|${lowerRoadId}|${stationToken(upperS)}|${stationToken(lowerS)}`;
}
function stationToken(station) {
  return String(Math.round(station * 1e6));
}

// ../three-roads-inspect/packages/core/src/automatic-network/resolve-automatic-network.ts
var MAX_PROFILE_TRANSITION_DEFLECTION = Math.PI * 2 / 3;
var PROFILE_TRANSITION_MARKING_PLAN = {
  rules: "german",
  controlLines: "explicit-only",
  laneArrows: "explicit-only",
  connectorSeparators: "explicit-only",
  throughContinuity: "explicit-only",
  priorityStraightContinuity: "explicit-only",
  dedicatedTurnContinuity: "explicit-only",
  signalTurnContinuity: "explicit-only"
};
function resolveAutomaticNetwork(document, options = {}) {
  const tolerance = options.snapTolerance ?? 0.05;
  if (!Number.isFinite(tolerance) || tolerance <= 0)
    throw new Error("Automatic node snap tolerance must be positive");
  const setback = options.junctionPortalSetback ?? 10;
  if (!Number.isFinite(setback) || setback <= 0)
    throw new Error("Junction portal setback must be positive");
  const gradeSeparated = inferAutomaticGradeSeparations(document);
  const split = options.splitInteriorCrossings ? splitMissingCrossings(gradeSeparated) : gradeSeparated;
  const groups = endpointGroups(split.strokes, tolerance).flatMap((group) => partitionEndpointGroupByGradeSeparation(group, split.gradeSeparations ?? []));
  const templates = new Map(document.templates.map((template) => [template.id, template]));
  const diagnostics = [];
  const nodes = [];
  const footprintReservations = [];
  let next = structuredClone(split);
  for (const group of groups.filter((candidate) => candidate.length >= 2)) {
    const point = average(group.map((endpoint) => endpoint.point));
    const roadIds = group.map((endpoint) => endpoint.road.id).sort();
    if (coveredByExistingJunction(next, group)) {
      diagnostics.push({ code: "automatic-node-covered", message: `Node ${roadIds.join("/")} already has authored topology`, roadIds, point });
      continue;
    }
    if (group.length === 2) {
      if (continuationCompatible(group[0], group[1], templates)) {
        next = linkContinuation(next, group[0], group[1]);
        nodes.push({ id: nodeId("continuation", group), kind: "continuation", point, roadIds });
      } else {
        const bendSetback = fitPortalSetback(group, Math.max(twoArmPortalSetback(group[0], group[1], setback), adaptivePortalSetback(group, templates, setback)));
        const approaches2 = group.map((endpoint) => ({ endpoint, roles: endpointLaneRoles(endpoint, templates) }));
        if (approaches2.some((approach) => !approach.roles)) {
          diagnostics.push({ code: "automatic-node-lane-roles", message: `Two-arm node ${roadIds.join("/")} has unresolved lane roles`, roadIds, point });
          continue;
        }
        const id2 = `${options.junctionIdPrefix ?? "auto-junction"}|${roadIds.join("|")}`;
        const [left, right] = approaches2;
        const plainManeuvers = twoArmManeuvers(left, right, false);
        const dominantRoadId = profileTransitionDominantRoad(left, right, templates, plainManeuvers);
        const maneuvers = dominantRoadId ? twoArmManeuvers(left, right, true) : plainManeuvers;
        footprintReservations.push({ endpoints: group, setback: bendSetback });
        next.junctions.push({
          id: id2,
          kind: "common",
          connectorGeometryPolicy: "surface-fallback",
          profileTransition: dominantRoadId ? { dominantRoadId } : undefined,
          ports: approaches2.map(({ endpoint }) => ({ id: idToken3(endpoint.road.id), roadId: endpoint.road.id, contactPoint: endpoint.contactPoint })),
          maneuvers,
          control: dominantRoadId && containsMotorLaneMerge(maneuvers) ? { kind: "zipper" } : { kind: "uncontrolled", rule: "right-before-left" },
          markingPlan: dominantRoadId ? { ...PROFILE_TRANSITION_MARKING_PLAN } : undefined
        });
        nodes.push({ id: nodeId("junction", group), kind: "common-junction", point, roadIds, sourceId: id2 });
      }
      continue;
    }
    const approaches = group.flatMap((endpoint) => {
      const roles = endpointLaneRoles(endpoint, templates);
      if (!roles) {
        diagnostics.push({
          code: "automatic-node-lane-roles",
          message: `Road ${endpoint.road.id} does not expose exactly one incoming and outgoing motor lane`,
          roadIds: [endpoint.road.id],
          point
        });
        return [];
      }
      return [{
        key: idToken3(endpoint.road.id),
        roadId: endpoint.road.id,
        contactPoint: endpoint.contactPoint,
        roles
      }];
    });
    if (approaches.length !== group.length)
      continue;
    const priorityRoadIds = priorityPair(group, templates).map((endpoint) => endpoint.road.id);
    const priorityPortIds = priorityRoadIds.map(idToken3);
    const id = `${options.junctionIdPrefix ?? "auto-junction"}|${roadIds.join("|")}`;
    const singleLane = approaches.every(({ roles }) => roles.inbound.length === 1 && roles.outbound.length === 1 && roles.bicycleInbound.length === 0 && roles.bicycleOutbound.length === 0 && roles.tramInbound.length === 0 && roles.tramOutbound.length === 0 && roles.pedestrianInbound.length === 0 && roles.pedestrianOutbound.length === 0);
    const movements = approaches.flatMap((from) => [
      ...automaticLaneMappedMovements(group, from, approaches),
      ...automaticBicycleMovements(group, from, approaches),
      ...automaticModalMovements(group, from, approaches, "tram"),
      ...automaticModalMovements(group, from, approaches, "pedestrian")
    ]);
    const junction = singleLane ? createSingleLaneMultiArmJunctionIntent({
      id,
      approaches: approaches.map(({ roles, ...approach }) => ({
        ...approach,
        inboundLaneRole: roles.inbound[0],
        outboundLaneRole: roles.outbound[0]
      })),
      priorityRoadIds
    }) : movements.length === 0 ? {
      id,
      kind: "common",
      ports: approaches.map(({ key, roadId, contactPoint }) => ({ id: key, roadId, contactPoint })),
      maneuvers: [],
      priorityRoadIds,
      control: { kind: "priority", priorityPortIds, minorControl: "yield" }
    } : createLaneMappedJunctionIntent({
      id,
      approaches: approaches.map(({ roles: _roles, ...approach }) => approach),
      movements,
      control: { kind: "priority", priorityPortIds, minorControl: "yield" }
    });
    const portalSetback = fitPortalSetback(group, adaptivePortalSetback(group, templates, setback));
    footprintReservations.push({ endpoints: group, setback: portalSetback });
    next.junctions.push({ ...junction, connectorGeometryPolicy: "surface-fallback" });
    nodes.push({ id: nodeId("junction", group), kind: "common-junction", point, roadIds, sourceId: id });
  }
  next = reserveJunctionFootprints(next, footprintReservations);
  next = pruneStaleAutomaticGradeSeparations(next);
  for (const crossing of auditPlanCrossings(next).crossings.filter((entry) => entry.classification === "missing")) {
    const roadIds = [crossing.leftRoadId, crossing.rightRoadId].sort();
    diagnostics.push({
      code: "automatic-crossing-requires-split",
      message: `Crossing ${roadIds.join("/")} needs road splits before automatic junction resolution`,
      roadIds,
      point: crossing.point
    });
    nodes.push({ id: `requires-split|${roadIds.join("|")}`, kind: "requires-split", point: crossing.point, roadIds });
  }
  const applied = applyOrdinaryNodeIntents(next, nodes);
  return { document: applied.document, nodes, diagnostics: [...diagnostics, ...applied.diagnostics] };
}
function fitPortalSetback(group, preferred) {
  const shortest = Math.min(...group.map((endpoint) => referenceLineLength({ geometry: endpoint.road.geometry })));
  const retainedApproachLength = Math.min(2, shortest * 0.5);
  return Math.min(preferred, shortest - retainedApproachLength);
}
function continuationCompatible(left, right, templates) {
  return left.contactPoint !== right.contactPoint && Math.abs(Math.PI - angleDistance(left.outwardHeading, right.outwardHeading)) <= 0.001 && endpointCrossSectionsIdentical(left, right, templates);
}
function endpointCrossSectionsIdentical(left, right, templates) {
  const leftTemplate = endpointTemplate2(left, templates);
  const rightTemplate = endpointTemplate2(right, templates);
  return Boolean(leftTemplate && rightTemplate && roadTemplatesHaveIdenticalCrossSection(leftTemplate, rightTemplate));
}
function endpointTemplate2(endpoint, templates) {
  const station = endpoint.contactPoint === "start" ? 0 : referenceLineLength({ geometry: endpoint.road.geometry });
  const span = [...endpoint.road.templateSpans].sort((left, right) => left.s - right.s).filter((candidate) => candidate.s <= station + 0.0000001).at(-1);
  return span ? templates.get(span.templateId) : undefined;
}
function twoArmPortalSetback(left, right, minimum) {
  const outwardSeparation = angleDistance(left.outwardHeading, right.outwardHeading);
  const travelDeflection = Math.PI - outwardSeparation;
  return minimum / Math.max(0.2, Math.cos(travelDeflection * 0.5));
}
function adaptivePortalSetback(group, templates, minimum) {
  const halfWidth = Math.max(0, ...group.map((endpoint) => approachHalfWidth(endpoint, templates)));
  const curved = group.some((endpoint) => {
    const station = endpoint.contactPoint === "start" ? 0 : referenceLineLength({ geometry: endpoint.road.geometry });
    return Math.abs(evaluateReferenceLine({ geometry: endpoint.road.geometry }, station).curvature) > 0.000001;
  });
  const clearance = Math.max(minimum, halfWidth + 2, curved ? 15 : 0);
  const angle = minimumApproachAngle(group);
  if (angle >= Math.PI / 2 - 0.000001)
    return clearance;
  const factor = Math.min(4, Math.sin(Math.PI / 4) / Math.max(0.1, Math.sin(angle / 2)));
  return clearance * factor;
}
function approachHalfWidth(endpoint, templates) {
  const station = endpoint.contactPoint === "start" ? 0 : referenceLineLength({ geometry: endpoint.road.geometry });
  const span = [...endpoint.road.templateSpans].filter((candidate) => candidate.s <= station + 0.0000001).at(-1);
  const template = span && templates.get(span.templateId);
  if (!template)
    return 0;
  const sideWidth = (side) => template.lanes.filter((lane) => lane.side === side).reduce((sum, lane) => sum + lane.width, 0);
  return Math.max(sideWidth("left"), sideWidth("right"));
}
function minimumApproachAngle(group) {
  if (group.length < 2)
    return Math.PI;
  const angles = group.map((endpoint) => normalizeHeading(endpoint.outwardHeading)).sort((a, b) => a - b);
  let minimum = Math.PI * 2;
  for (let index = 0;index < angles.length; index++) {
    const next = index + 1 < angles.length ? angles[index + 1] : angles[0] + Math.PI * 2;
    const separation = next - angles[index];
    if (separation > 0.001)
      minimum = Math.min(minimum, separation);
  }
  return minimum;
}
function normalizeHeading(value) {
  const turn = Math.PI * 2;
  return (value % turn + turn) % turn;
}
function laneMappedMovements(from, to, innerAnchored = false) {
  if (from.roles.inbound.length === 0 || to.roles.outbound.length === 0)
    return [];
  const fromKey = idToken3(from.endpoint.road.id);
  const toKey = idToken3(to.endpoint.road.id);
  return from.roles.inbound.flatMap((fromLaneRole, index) => {
    const targets = compatibleTargetRoles(fromLaneRole, from.roles, to.roles.outbound, to.roles);
    if (targets.length === 0)
      return [];
    const targetIndex = innerAnchored ? Math.min(index, targets.length - 1) : proportionalIndex(index, from.roles.inbound.length, targets.length);
    return {
      id: `${fromKey}-${idToken3(fromLaneRole)}-to-${toKey}-${idToken3(to.roles.outbound[targetIndex])}`,
      fromRoadId: from.endpoint.road.id,
      fromPortId: fromKey,
      fromLaneRole,
      toRoadId: to.endpoint.road.id,
      toPortId: toKey,
      toLaneRole: targets[targetIndex],
      participantClass: "motor"
    };
  });
}
function twoArmManeuvers(left, right, innerAnchored) {
  return [left, right].flatMap((from, index) => {
    const to = index === 0 ? right : left;
    return [
      ...laneMappedMovements(from, to, innerAnchored),
      ...laneMappedBicycleMovements(from, to),
      ...laneMappedModalMovements(from, to, "tram"),
      ...laneMappedModalMovements(from, to, "pedestrian")
    ];
  });
}
function profileTransitionDominantRoad(left, right, templates, throughManeuvers) {
  if (left.endpoint.contactPoint === right.endpoint.contactPoint)
    return;
  const deflection = Math.abs(Math.PI - angleDistance(left.endpoint.outwardHeading, right.endpoint.outwardHeading));
  if (deflection > MAX_PROFILE_TRANSITION_DEFLECTION + 0.0000001)
    return;
  if (throughManeuvers.length === 0)
    return;
  const leftTemplate = endpointTemplate2(left.endpoint, templates);
  const rightTemplate = endpointTemplate2(right.endpoint, templates);
  if (!leftTemplate || !rightTemplate)
    return;
  const leftWidth = templateCrossSectionWidth(leftTemplate);
  const rightWidth = templateCrossSectionWidth(rightTemplate);
  if (Math.abs(leftWidth - rightWidth) > 0.0000001) {
    return leftWidth > rightWidth ? left.endpoint.road.id : right.endpoint.road.id;
  }
  const leftHierarchy = approachHierarchy(left.endpoint, templates);
  const rightHierarchy = approachHierarchy(right.endpoint, templates);
  if (Math.abs(leftHierarchy - rightHierarchy) > 0.0000001) {
    return leftHierarchy > rightHierarchy ? left.endpoint.road.id : right.endpoint.road.id;
  }
  return left.endpoint.road.id.localeCompare(right.endpoint.road.id) <= 0 ? left.endpoint.road.id : right.endpoint.road.id;
}
function containsMotorLaneMerge(maneuvers) {
  return maneuvers.some((maneuver, index) => maneuver.participantClass === "motor" && maneuvers.slice(index + 1).some((candidate) => candidate.participantClass === "motor" && candidate.fromRoadId === maneuver.fromRoadId && candidate.fromPortId === maneuver.fromPortId && candidate.toRoadId === maneuver.toRoadId && candidate.toPortId === maneuver.toPortId && candidate.toLaneRole === maneuver.toLaneRole));
}
function templateCrossSectionWidth(template) {
  return template.lanes.reduce((sum, lane) => sum + lane.width, 0);
}
function laneMappedBicycleMovements(from, to) {
  const fromKey = idToken3(from.endpoint.road.id);
  const toKey = idToken3(to.endpoint.road.id);
  return from.roles.bicycleInbound.map((fromLaneRole, index) => {
    const targets = compatibleTargetRoles(fromLaneRole, from.roles, to.roles.bicycleOutbound, to.roles);
    const targetIndex = proportionalIndex(index, from.roles.bicycleInbound.length, targets.length);
    const toLaneRole = targets[targetIndex];
    if (!toLaneRole)
      return;
    return {
      id: `${fromKey}-${idToken3(fromLaneRole)}-to-${toKey}-${idToken3(toLaneRole)}`,
      fromRoadId: from.endpoint.road.id,
      fromPortId: fromKey,
      fromLaneRole,
      toRoadId: to.endpoint.road.id,
      toPortId: toKey,
      toLaneRole,
      participantClass: "bicycle",
      requiredContinuity: "g1",
      minimumRadius: 5
    };
  }).filter((movement) => movement !== undefined);
}
function laneMappedModalMovements(from, to, participantClass) {
  const inbound = participantClass === "tram" ? from.roles.tramInbound : from.roles.pedestrianInbound;
  const outbound = participantClass === "tram" ? to.roles.tramOutbound : to.roles.pedestrianOutbound;
  const fromKey = idToken3(from.endpoint.road.id);
  const toKey = idToken3(to.endpoint.road.id);
  return inbound.flatMap((fromLaneRole, index) => {
    const targets = compatibleTargetRoles(fromLaneRole, from.roles, outbound, to.roles);
    const toLaneRole = targets[proportionalIndex(index, inbound.length, targets.length)];
    if (!toLaneRole)
      return [];
    return [{
      id: `${fromKey}-${idToken3(fromLaneRole)}-to-${toKey}-${idToken3(toLaneRole)}`,
      fromRoadId: from.endpoint.road.id,
      fromPortId: fromKey,
      fromLaneRole,
      toRoadId: to.endpoint.road.id,
      toPortId: toKey,
      toLaneRole,
      participantClass,
      requiredContinuity: "g1",
      minimumRadius: participantClass === "tram" ? 12 : 2
    }];
  });
}
function proportionalIndex(index, sourceCount, targetCount) {
  if (targetCount <= 1 || sourceCount <= 1)
    return 0;
  return Math.min(targetCount - 1, Math.round(index * (targetCount - 1) / (sourceCount - 1)));
}
function automaticLaneMappedMovements(group, from, approaches) {
  if (from.roles.inbound.length === 0)
    return [];
  const fromEndpoint = requiredEndpoint(group, from.roadId);
  const destinations = approaches.filter((to) => to !== from && to.roles.outbound.length > 0).sort((left, right) => turnDeflection(fromEndpoint, requiredEndpoint(group, right.roadId)) - turnDeflection(fromEndpoint, requiredEndpoint(group, left.roadId)));
  return destinations.flatMap((to, destinationIndex) => {
    const fromIndex = proportionalIndex(destinationIndex, destinations.length, from.roles.inbound.length);
    const fromLaneRole = from.roles.inbound[fromIndex];
    const targets = compatibleTargetRoles(fromLaneRole, from.roles, to.roles.outbound, to.roles);
    if (targets.length === 0)
      return [];
    const toIndex = proportionalIndex(fromIndex, from.roles.inbound.length, targets.length);
    return {
      fromApproachKey: from.key,
      fromLaneRole,
      toApproachKey: to.key,
      toLaneRole: targets[toIndex],
      participantClass: "motor"
    };
  });
}
function compatibleTargetRoles(sourceRole, source, targets, target) {
  const sourceAccess = source.accessByRole.get(sourceRole) ?? [];
  return targets.filter((role) => {
    const targetAccess = target.accessByRole.get(role) ?? [];
    const sourceHeight = source.heightByRole.get(sourceRole) ?? 0;
    const targetHeight = target.heightByRole.get(role) ?? 0;
    return Math.abs(sourceHeight - targetHeight) <= 0.05 && sourceAccess.some((participant) => targetAccess.includes(participant));
  });
}
function automaticBicycleMovements(group, from, approaches) {
  if (from.roles.bicycleInbound.length === 0)
    return [];
  const fromEndpoint = requiredEndpoint(group, from.roadId);
  const destinations = approaches.filter((to) => to !== from && to.roles.bicycleOutbound.length > 0).sort((left, right) => turnDeflection(fromEndpoint, requiredEndpoint(group, right.roadId)) - turnDeflection(fromEndpoint, requiredEndpoint(group, left.roadId)));
  return destinations.flatMap((to) => from.roles.bicycleInbound.map((fromLaneRole, index) => {
    const targets = compatibleTargetRoles(fromLaneRole, from.roles, to.roles.bicycleOutbound, to.roles);
    const toLaneRole = targets[proportionalIndex(index, from.roles.bicycleInbound.length, targets.length)];
    return toLaneRole ? {
      fromApproachKey: from.key,
      fromLaneRole,
      toApproachKey: to.key,
      toLaneRole,
      participantClass: "bicycle",
      requiredContinuity: "g1",
      minimumRadius: 5
    } : undefined;
  }).filter((movement) => movement !== undefined));
}
function automaticModalMovements(group, from, approaches, participantClass) {
  const inbound = participantClass === "tram" ? from.roles.tramInbound : from.roles.pedestrianInbound;
  if (inbound.length === 0)
    return [];
  const outboundRoles = (roles) => participantClass === "tram" ? roles.tramOutbound : roles.pedestrianOutbound;
  const fromEndpoint = requiredEndpoint(group, from.roadId);
  const destinations = approaches.filter((to) => to !== from && outboundRoles(to.roles).length > 0).sort((left, right) => turnDeflection(fromEndpoint, requiredEndpoint(group, right.roadId)) - turnDeflection(fromEndpoint, requiredEndpoint(group, left.roadId)));
  return destinations.flatMap((to) => inbound.map((fromLaneRole, index) => {
    const targets = compatibleTargetRoles(fromLaneRole, from.roles, outboundRoles(to.roles), to.roles);
    const toLaneRole = targets[proportionalIndex(index, inbound.length, targets.length)];
    return toLaneRole ? {
      fromApproachKey: from.key,
      fromLaneRole,
      toApproachKey: to.key,
      toLaneRole,
      participantClass,
      requiredContinuity: "g1",
      minimumRadius: participantClass === "tram" ? 12 : 2
    } : undefined;
  }).filter((movement) => movement !== undefined));
}
function requiredEndpoint(group, roadId) {
  const endpoint = group.find((candidate) => candidate.road.id === roadId);
  if (!endpoint)
    throw new Error(`Automatic approach road ${roadId} is unavailable`);
  return endpoint;
}
function turnDeflection(from, to) {
  const incomingHeading = from.outwardHeading + Math.PI;
  return Math.atan2(Math.sin(to.outwardHeading - incomingHeading), Math.cos(to.outwardHeading - incomingHeading));
}
function splitMissingCrossings(document) {
  if (supportsBatchedAutomaticSplits(document)) {
    return splitPlainCrossingsInBatch(document);
  }
  let next = structuredClone(document);
  for (let iteration = 0;iteration < 256; iteration++) {
    const operations = missingCrossingSplitOperations(next);
    if (operations.length === 0)
      return next;
    for (const operation of operations) {
      if (!isInterior(next, operation.roadId, operation.station))
        continue;
      const id = automaticSplitId(next, operation.roadId, operation.otherRoadId);
      next = splitRoadStroke(next, operation.roadId, operation.station, {
        secondStrokeId: id,
        attachmentPolicy: "automatic-fit"
      }).document;
    }
  }
  throw new Error("Automatic crossing split did not converge");
}
function supportsBatchedAutomaticSplits(document) {
  return document.junctions.length === 0 && (document.gradeSeparations?.length ?? 0) === 0 && (document.roadStructures?.length ?? 0) === 0 && (document.roadsideFeatures?.length ?? 0) === 0 && (document.roadSurfaceElevations?.length ?? 0) === 0 && (document.weavingSections?.length ?? 0) === 0 && (document.markings?.length ?? 0) === 0 && (document.objects?.length ?? 0) === 0 && (document.regulations?.length ?? 0) === 0 && (document.trafficManagementPlans?.length ?? 0) === 0 && (document.facilities?.length ?? 0) === 0 && (document.streetscape?.tracks.length ?? 0) === 0 && (document.streetscape?.instanceOverrides.length ?? 0) === 0;
}
function splitPlainCrossingsInBatch(document) {
  const stationsByRoad = new Map;
  const crossings = auditPlanCrossings(document).crossings.filter(({ classification }) => classification === "missing");
  for (const crossing of crossings) {
    addInteriorSplitStation(document, stationsByRoad, crossing.leftRoadId, crossing.leftS);
    addInteriorSplitStation(document, stationsByRoad, crossing.rightRoadId, crossing.rightS);
  }
  if (stationsByRoad.size === 0)
    return structuredClone(document);
  const usedIds = new Set(document.strokes.map(({ id }) => id));
  const strokes = document.strokes.flatMap((stroke) => {
    const stations = uniqueStations(stationsByRoad.get(stroke.id) ?? []);
    if (stations.length === 0)
      return [structuredClone(stroke)];
    let local = emptySplitDocument(document, stroke);
    let activeRoadId = stroke.id;
    let previousStation = 0;
    stations.forEach((station, index) => {
      const secondStrokeId = automaticBatchSplitId(stroke.id, station, index, usedIds);
      local = splitRoadStroke(local, activeRoadId, station - previousStation, { secondStrokeId, attachmentPolicy: "automatic-fit" }).document;
      activeRoadId = secondStrokeId;
      previousStation = station;
    });
    return local.strokes;
  });
  return { ...structuredClone(document), strokes };
}
function addInteriorSplitStation(document, stationsByRoad, roadId, station) {
  if (!isInterior(document, roadId, station))
    return;
  const stations = stationsByRoad.get(roadId);
  if (stations)
    stations.push(station);
  else
    stationsByRoad.set(roadId, [station]);
}
function uniqueStations(stations) {
  return [...stations].sort((left, right) => left - right).filter((station, index, sorted) => index === 0 || Math.abs(station - sorted[index - 1]) > 0.00001);
}
function automaticBatchSplitId(rootRoadId, station, ordinal, usedIds) {
  const base = `${rootRoadId}|auto-split|at-${Math.round(station * 1e6)}`;
  let candidate = base;
  let collision = ordinal + 2;
  while (usedIds.has(candidate))
    candidate = `${base}|${collision++}`;
  usedIds.add(candidate);
  return candidate;
}
function emptySplitDocument(document, stroke) {
  return {
    ...document,
    strokes: [structuredClone(stroke)],
    junctions: [],
    junctionGroups: [],
    gradeSeparations: [],
    roadStructures: [],
    roadsideFeatures: [],
    roadSurfaceElevations: [],
    weavingSections: [],
    markings: [],
    objects: [],
    regulations: [],
    trafficManagementPlans: [],
    facilities: [],
    ordinaryNodeIntents: [],
    streetscape: document.streetscape ? { ...document.streetscape, tracks: [], instanceOverrides: [] } : undefined
  };
}
function missingCrossingSplitOperations(document) {
  const operations = auditPlanCrossings(document).crossings.filter(({ classification }) => classification === "missing").flatMap((crossing) => [
    ...isInterior(document, crossing.leftRoadId, crossing.leftS) ? [{ roadId: crossing.leftRoadId, otherRoadId: crossing.rightRoadId, station: crossing.leftS }] : [],
    ...isInterior(document, crossing.rightRoadId, crossing.rightS) ? [{ roadId: crossing.rightRoadId, otherRoadId: crossing.leftRoadId, station: crossing.rightS }] : []
  ]).sort((left, right) => left.roadId.localeCompare(right.roadId) || right.station - left.station || left.otherRoadId.localeCompare(right.otherRoadId));
  return operations.filter((operation, index) => {
    const previous = operations[index - 1];
    return !previous || previous.roadId !== operation.roadId || Math.abs(previous.station - operation.station) > 0.00001;
  });
}
function isInterior(document, roadId, station) {
  const stroke = document.strokes.find((candidate) => candidate.id === roadId);
  if (!stroke)
    return false;
  const length = referenceLineLength({ geometry: stroke.geometry });
  return station > 0.00001 && station < length - 0.00001;
}
function automaticSplitId(document, roadId, otherRoadId) {
  const base = `${roadId}|auto-split|with-${idToken3(otherRoadId)}`;
  if (!document.strokes.some(({ id }) => id === base))
    return base;
  let ordinal = 2;
  while (document.strokes.some(({ id }) => id === `${base}|${ordinal}`))
    ordinal++;
  return `${base}|${ordinal}`;
}
function endpointGroups(strokes, tolerance) {
  const endpoints = strokes.flatMap((road) => {
    const length = referenceLineLength({ geometry: road.geometry });
    const start = evaluateReferenceLine({ geometry: road.geometry }, 0);
    const end = evaluateReferenceLine({ geometry: road.geometry }, length);
    return [
      { road, contactPoint: "start", point: start, outwardHeading: start.heading },
      { road, contactPoint: "end", point: end, outwardHeading: end.heading + Math.PI }
    ];
  }).sort((left, right) => left.road.id.localeCompare(right.road.id) || left.contactPoint.localeCompare(right.contactPoint));
  const groups = [];
  const groupGrid = new Map;
  for (const endpoint of endpoints) {
    const cellX = Math.floor(endpoint.point.x / tolerance);
    const cellY = Math.floor(endpoint.point.y / tolerance);
    const candidateIndexes = new Set;
    for (let x = cellX - 1;x <= cellX + 1; x++) {
      for (let y = cellY - 1;y <= cellY + 1; y++) {
        for (const index2 of groupGrid.get(`${x}:${y}`) ?? [])
          candidateIndexes.add(index2);
      }
    }
    const groupIndex = [...candidateIndexes].sort((left, right) => left - right).find((index2) => distance5(endpoint.point, groups[index2][0].point) <= tolerance);
    if (groupIndex !== undefined) {
      groups[groupIndex].push(endpoint);
      continue;
    }
    const index = groups.length;
    groups.push([endpoint]);
    const key = `${cellX}:${cellY}`;
    const values = groupGrid.get(key);
    if (values)
      values.push(index);
    else
      groupGrid.set(key, [index]);
  }
  return groups;
}
function partitionEndpointGroupByGradeSeparation(group, gradeSeparations) {
  const sorted = [...group].sort((left, right) => endpointElevation(left) - endpointElevation(right) || left.road.id.localeCompare(right.road.id) || left.contactPoint.localeCompare(right.contactPoint));
  const partitions = [];
  for (const endpoint of sorted) {
    const partition = partitions.find((candidate) => candidate.every((member) => !gradeSeparationAtContacts(member, endpoint, gradeSeparations)));
    if (partition)
      partition.push(endpoint);
    else
      partitions.push([endpoint]);
  }
  return partitions;
}
function gradeSeparationAtContacts(left, right, gradeSeparations) {
  const leftS = endpointStation(left);
  const rightS = endpointStation(right);
  return gradeSeparations.some((separation) => {
    const direct = separation.upperRoad.roadId === left.road.id && separation.lowerRoad.roadId === right.road.id && Math.abs(separation.upperRoad.s - leftS) <= 0.0001 && Math.abs(separation.lowerRoad.s - rightS) <= 0.0001;
    const reversed = separation.upperRoad.roadId === right.road.id && separation.lowerRoad.roadId === left.road.id && Math.abs(separation.upperRoad.s - rightS) <= 0.0001 && Math.abs(separation.lowerRoad.s - leftS) <= 0.0001;
    return direct || reversed;
  });
}
function pruneStaleAutomaticGradeSeparations(document) {
  const gradeSeparations = (document.gradeSeparations ?? []).filter((separation) => {
    if (!separation.id.startsWith("auto-grade-separation|"))
      return true;
    const upper = document.strokes.find(({ id }) => id === separation.upperRoad.roadId);
    const lower = document.strokes.find(({ id }) => id === separation.lowerRoad.roadId);
    if (!upper || !lower)
      return false;
    const upperLength = referenceLineLength({ geometry: upper.geometry });
    const lowerLength = referenceLineLength({ geometry: lower.geometry });
    if (separation.upperRoad.s > upperLength + 0.00001 || separation.lowerRoad.s > lowerLength + 0.00001)
      return false;
    const upperPoint = evaluateReferenceLine({ geometry: upper.geometry }, separation.upperRoad.s);
    const lowerPoint = evaluateReferenceLine({ geometry: lower.geometry }, separation.lowerRoad.s);
    return distance5(upperPoint, lowerPoint) <= 0.0001;
  });
  return gradeSeparations.length === (document.gradeSeparations ?? []).length ? document : { ...document, gradeSeparations };
}
function endpointElevation(endpoint) {
  return elevationAt(endpoint.road.elevation, endpointStation(endpoint));
}
function endpointStation(endpoint) {
  return endpoint.contactPoint === "start" ? 0 : referenceLineLength({ geometry: endpoint.road.geometry });
}
function endpointLaneRoles(endpoint, templates) {
  const station = endpoint.contactPoint === "start" ? 0 : referenceLineLength({ geometry: endpoint.road.geometry });
  const span = [...endpoint.road.templateSpans].filter((candidate) => candidate.s <= station + 0.0000001).at(-1);
  const template = span && templates.get(span.templateId);
  if (!template)
    return;
  const motorTypes = new Set(["driving", "entry", "exit", "on-ramp", "off-ramp", "bus"]);
  const carriesOnlyPedestrians = template.lanes.every((lane) => effectiveLaneAccess(lane).every((participant) => participant === "pedestrian"));
  const inbound = [];
  const outbound = [];
  const bicycleInbound = [];
  const bicycleOutbound = [];
  const tramInbound = [];
  const tramOutbound = [];
  const pedestrianInbound = [];
  const pedestrianOutbound = [];
  const accessByRole = new Map;
  const heightByRole = new Map;
  for (const lane of template.lanes.filter((candidate) => motorTypes.has(candidate.type) || candidate.type === "shared" || candidate.type === "biking" || candidate.type === "tram" || candidate.type === "rail" || candidate.type === "sidewalk" && carriesOnlyPedestrians || candidate.type === "restricted" && candidate.access?.some(isMotorAccess)).sort((left, right) => left.order - right.order)) {
    accessByRole.set(lane.role, effectiveLaneAccess(lane));
    const activeHeight = [...lane.heights ?? []].sort((left, right) => left.sOffset - right.sOffset).filter((height) => height.sOffset <= station + 0.0000001).at(-1);
    heightByRole.set(lane.role, activeHeight ? (activeHeight.inner + activeHeight.outer) * 0.5 : 0);
    const laneAccess = effectiveLaneAccess(lane);
    const modalRoles = lane.type === "biking" ? { inbound: bicycleInbound, outbound: bicycleOutbound } : lane.type === "tram" || lane.type === "rail" ? { inbound: tramInbound, outbound: tramOutbound } : lane.type === "sidewalk" ? { inbound: pedestrianInbound, outbound: pedestrianOutbound } : lane.type === "shared" && !laneAccess.some(isOrdinaryMotorAccess) ? laneAccess.includes("bicycle") ? { inbound: bicycleInbound, outbound: bicycleOutbound } : { inbound: pedestrianInbound, outbound: pedestrianOutbound } : { inbound, outbound };
    if (lane.direction === "both") {
      modalRoles.inbound.push(lane.role);
      modalRoles.outbound.push(lane.role);
      continue;
    }
    const standard = lane.side === "right" ? 1 : -1;
    const sign = lane.direction === "reversed" ? -standard : standard;
    const enters = endpoint.contactPoint === "end" ? sign > 0 : sign < 0;
    const target = enters ? modalRoles.inbound : modalRoles.outbound;
    target.push(lane.role);
  }
  return inbound.length > 0 || outbound.length > 0 || bicycleInbound.length > 0 || bicycleOutbound.length > 0 || tramInbound.length > 0 || tramOutbound.length > 0 || pedestrianInbound.length > 0 || pedestrianOutbound.length > 0 ? {
    inbound,
    outbound,
    bicycleInbound,
    bicycleOutbound,
    tramInbound,
    tramOutbound,
    pedestrianInbound,
    pedestrianOutbound,
    accessByRole,
    heightByRole
  } : undefined;
}
function isMotorAccess(participant) {
  return participant === "car" || participant === "bus" || participant === "emergency";
}
function isOrdinaryMotorAccess(participant) {
  return participant === "car" || participant === "bus";
}
function linkContinuation(document, left, right) {
  const update = (source, target) => {
    const current = document.strokes.find((stroke) => stroke.id === source.road.id);
    if (!current)
      throw new Error(`Automatic continuation road ${source.road.id} is unavailable`);
    return {
      ...current,
      links: {
        ...current.links,
        [source.contactPoint === "end" ? "successor" : "predecessor"]: {
          roadId: target.road.id,
          contactPoint: target.contactPoint,
          requiredContinuity: "g1"
        }
      }
    };
  };
  const replacements = new Map([
    [left.road.id, update(left, right)],
    [right.road.id, update(right, left)]
  ]);
  return { ...document, strokes: document.strokes.map((stroke) => replacements.get(stroke.id) ?? stroke) };
}
function priorityPair(group, templates) {
  let selected = [group[0], group[1]];
  let bestAlignment = Number.POSITIVE_INFINITY;
  let bestHierarchy = Number.NEGATIVE_INFINITY;
  for (let left = 0;left < group.length; left++) {
    for (let right = left + 1;right < group.length; right++) {
      const error12 = Math.abs(Math.PI - angleDistance(group[left].outwardHeading, group[right].outwardHeading));
      const hierarchy = approachHierarchy(group[left], templates) + approachHierarchy(group[right], templates);
      if (hierarchy > bestHierarchy + 0.000000001 || Math.abs(hierarchy - bestHierarchy) <= 0.000000001 && error12 < bestAlignment - 0.000000001) {
        selected = [group[left], group[right]];
        bestAlignment = error12;
        bestHierarchy = hierarchy;
      }
    }
  }
  return selected;
}
function approachHierarchy(endpoint, templates) {
  const station = endpoint.contactPoint === "start" ? 0 : referenceLineLength({ geometry: endpoint.road.geometry });
  const span = [...endpoint.road.templateSpans].filter((candidate) => candidate.s <= station + 0.0000001).at(-1);
  const template = span && templates.get(span.templateId);
  const motorLaneCount = template?.lanes.filter((lane) => ["driving", "entry", "exit", "on-ramp", "off-ramp", "bus"].includes(lane.type)).length ?? 0;
  return (template?.designLimits?.designSpeedKph ?? 0) * 10 + motorLaneCount;
}
function coveredByExistingJunction(document, group) {
  return document.junctions.some((junction) => group.every((endpoint) => junction.ports.some((port) => port.roadId === endpoint.road.id && port.contactPoint === endpoint.contactPoint)));
}
function nodeId(kind, group) {
  return `${kind}|${group.map((endpoint) => `${endpoint.road.id}:${endpoint.contactPoint}`).sort().join("|")}`;
}
function idToken3(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}
function average(points) {
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}
function distance5(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}
function angleDistance(left, right) {
  const delta = Math.atan2(Math.sin(left - right), Math.cos(left - right));
  return Math.abs(delta);
}
// ../three-roads-inspect/packages/core/src/road-presets/german-preset-builders.ts
var drivingAccess = ["car", "bus", "emergency"];
function roadPreset(options) {
  const highSpeed = options.designSpeedKph >= 70;
  return {
    id: options.id,
    name: options.name,
    family: options.family,
    template: {
      id: `${options.id}|base`,
      name: options.name,
      lanes: options.lanes,
      designLimits: {
        designSpeedKph: options.designSpeedKph,
        minimumHorizontalRadius: options.minimumHorizontalRadius,
        requireCurvatureContinuity: highSpeed,
        minimumSpiralLength: highSpeed ? 20 : undefined,
        maximumGrade: options.maximumGrade ?? (options.family === "motorway" ? 0.04 : 0.08)
      }
    }
  };
}
function motorLane(role, side, order, width, marking) {
  return {
    role,
    side,
    order,
    type: "driving",
    width,
    access: [...drivingAccess],
    boundaryMarkings: marking ? [innerMarking(role, marking)] : []
  };
}
function specialLane(role, side, order, type, width, access, marking) {
  return {
    role,
    side,
    order,
    type,
    width,
    access,
    boundaryMarkings: marking ? [innerMarking(role, marking)] : []
  };
}
function shoulderLane(role, side, order, width, markingBoundary) {
  return {
    role,
    side,
    order,
    type: "shoulder",
    width,
    access: ["emergency"],
    boundaryMarkings: [{
      id: `${role}-edge`,
      kind: "edge",
      boundary: markingBoundary,
      width: 0.15,
      laneChange: "none"
    }]
  };
}
function medianLane(role, side, order, width) {
  return {
    role,
    side,
    order,
    type: "median",
    direction: "both",
    width,
    access: []
  };
}
function parkingLane(role, side, order, width = 2.1) {
  return specialLane(role, side, order, "parking", width, ["car", "emergency"], "broken");
}
function cycleLane(role, side, order, width = 2, marking = "solid") {
  return specialLane(role, side, order, "biking", width, ["bicycle"], marking);
}
function curbLane(role, side, order) {
  return {
    role,
    side,
    order,
    type: "border",
    direction: "both",
    width: 0.2,
    level: true,
    heights: [{ sOffset: 0, inner: 0, outer: 0.15 }],
    access: []
  };
}
function sidewalkLane(role, side, order, width = 2.2) {
  return {
    role,
    side,
    order,
    type: "sidewalk",
    direction: "both",
    width,
    level: true,
    heights: [{ sOffset: 0, inner: 0.15, outer: 0.15 }],
    access: ["pedestrian"]
  };
}
function appendUrbanEdge(lanes, side, nextOrder, sidewalkWidth = 2.2) {
  lanes.push(curbLane(`${side}-curb`, side, nextOrder), sidewalkLane(`${side}-sidewalk`, side, nextOrder + 1, sidewalkWidth));
}
function innerMarking(role, kind, width = 0.12) {
  return {
    id: `${role}-${kind}`,
    kind,
    boundary: "inner",
    width,
    laneChange: kind === "broken" ? "both" : "none"
  };
}

// ../three-roads-inspect/packages/core/src/road-presets/german-rural-presets.ts
var germanRuralRoadPresets = [
  roadPreset({ id: "de-rural-two-way", name: "Rural two-way road", family: "rural-road", lanes: ruralLanes(3.25, 1.25), designSpeedKph: 80, minimumHorizontalRadius: 180 }),
  roadPreset({ id: "de-rural-narrow-two-way", name: "Narrow rural road", family: "rural-road", lanes: ruralLanes(2.75, 0.75), designSpeedKph: 70, minimumHorizontalRadius: 120 }),
  roadPreset({ id: "de-country-lane", name: "Country Lane", family: "rural-road", lanes: unmarkedTwoWayLanes(2.5, 0.5), designSpeedKph: 50, minimumHorizontalRadius: 40 }),
  roadPreset({ id: "de-agricultural-track", name: "Agricultural access track", family: "service-access", lanes: [{ role: "agricultural-access", side: "right", order: 1, type: "shared", direction: "both", width: 3.5, access: ["car", "bicycle", "pedestrian", "emergency"] }], designSpeedKph: 30, minimumHorizontalRadius: 18, maximumGrade: 0.12 }),
  roadPreset({ id: "de-forest-service-road", name: "Forest service road", family: "service-access", lanes: [{ role: "forest-access", side: "right", order: 1, type: "restricted", direction: "both", width: 4, access: ["car", "bicycle", "pedestrian", "emergency"] }], designSpeedKph: 30, minimumHorizontalRadius: 25, maximumGrade: 0.12 }),
  roadPreset({ id: "de-rural-cycleway", name: "Rural bidirectional cycleway", family: "modal-corridor", lanes: [specialLane("cycleway", "right", 1, "biking", 3, ["bicycle"], "edge")], designSpeedKph: 30, minimumHorizontalRadius: 18, maximumGrade: 0.08 }),
  roadPreset({ id: "de-service-access", name: "Service and agricultural access", family: "service-access", lanes: ruralLanes(2.75, 0.5), designSpeedKph: 30, minimumHorizontalRadius: 35 })
];
function ruralLanes(width, shoulderWidth) {
  return [
    motorLane("outbound", "left", 1, width),
    shoulderLane("left-shoulder", "left", 2, shoulderWidth, "inner"),
    motorLane("inbound", "right", 1, width, "broken"),
    shoulderLane("right-shoulder", "right", 2, shoulderWidth, "inner")
  ];
}
function unmarkedTwoWayLanes(width, vergeWidth) {
  return [
    motorLane("outbound", "left", 1, width),
    { ...shoulderLane("left-verge", "left", 2, vergeWidth, "inner"), boundaryMarkings: [] },
    motorLane("inbound", "right", 1, width),
    { ...shoulderLane("right-verge", "right", 2, vergeWidth, "inner"), boundaryMarkings: [] }
  ];
}

// ../three-roads-inspect/packages/core/src/road-presets/german-highway-presets.ts
var germanHighwayRoadPresets = [
  roadPreset({ id: "de-federal-road", name: "Federal Road", family: "federal-road", lanes: ruralLanes(3.5, 1.75), designSpeedKph: 100, minimumHorizontalRadius: 320 }),
  roadPreset({ id: "de-federal-road-2-plus-1", name: "Federal Road 2+1", family: "federal-road", lanes: twoPlusOneLanes(), designSpeedKph: 100, minimumHorizontalRadius: 350 }),
  roadPreset({ id: "de-federal-road-2x2", name: "Divided Federal Road 2x2", family: "federal-road", lanes: dividedLanes(2, 3.5, 1.75), designSpeedKph: 100, minimumHorizontalRadius: 450 }),
  roadPreset({ id: "de-expressway-2x2", name: "Expressway 2x2", family: "federal-road", lanes: dividedLanes(2, 3.5, 1.5), designSpeedKph: 100, minimumHorizontalRadius: 450 }),
  roadPreset({ id: "de-motorway-two-lane", name: "Two-lane Motorway carriageway", family: "motorway", lanes: carriagewayLanes(2), designSpeedKph: 130, minimumHorizontalRadius: 900 }),
  roadPreset({ id: "de-motorway-three-lane-carriageway", name: "Three-lane Motorway carriageway", family: "motorway", lanes: carriagewayLanes(3), designSpeedKph: 130, minimumHorizontalRadius: 900 }),
  roadPreset({ id: "de-motorway-four-lane-carriageway", name: "Four-lane Motorway carriageway", family: "motorway", lanes: carriagewayLanes(4), designSpeedKph: 130, minimumHorizontalRadius: 1000 }),
  roadPreset({ id: "de-motorway-2x2", name: "Motorway 2x2", family: "motorway", lanes: dividedLanes(2, 3.75, 3), designSpeedKph: 130, minimumHorizontalRadius: 900 }),
  roadPreset({ id: "de-motorway-2x3", name: "Motorway 2x3", family: "motorway", lanes: dividedLanes(3, 3.75, 3), designSpeedKph: 130, minimumHorizontalRadius: 900 }),
  roadPreset({ id: "de-motorway-2x4", name: "Motorway 2x4", family: "motorway", lanes: dividedLanes(4, 3.75, 3), designSpeedKph: 130, minimumHorizontalRadius: 1000 }),
  roadPreset({ id: "de-ramp-one-lane", name: "One-lane motorway ramp", family: "ramp", lanes: rampLanes(1), designSpeedKph: 80, minimumHorizontalRadius: 250 }),
  roadPreset({ id: "de-ramp-two-lane", name: "Two-lane motorway ramp", family: "ramp", lanes: rampLanes(2), designSpeedKph: 80, minimumHorizontalRadius: 280 }),
  roadPreset({ id: "de-ramp-tight-one-lane", name: "Tight one-lane motorway ramp", family: "ramp", lanes: rampLanes(1, 3.75, 1), designSpeedKph: 50, minimumHorizontalRadius: 80, maximumGrade: 0.06 }),
  roadPreset({ id: "de-ramp-terminal-two-way", name: "Two-way ramp terminal road", family: "ramp", lanes: ruralLanes(3.5, 1), designSpeedKph: 60, minimumHorizontalRadius: 120, maximumGrade: 0.06 })
];
function twoPlusOneLanes() {
  return [
    motorLane("single-direction", "left", 1, 3.5),
    shoulderLane("left-shoulder", "left", 2, 1.5, "inner"),
    motorLane("passing-direction-inner", "right", 1, 3.5, "solid-solid"),
    motorLane("passing-direction-outer", "right", 2, 3.5, "broken"),
    shoulderLane("right-shoulder", "right", 3, 1.5, "inner")
  ];
}
function carriagewayLanes(count) {
  const lanes = [shoulderLane("median-shoulder", "right", 1, 0.75, "outer")];
  for (let index = 0;index < count; index++) {
    lanes.push(motorLane(index === 0 ? "left-through" : index === count - 1 ? "right-through" : `middle-through-${index}`, "right", index + 2, 3.75, index === 0 ? undefined : "broken"));
  }
  lanes.push(shoulderLane("outside-shoulder", "right", count + 2, 3, "inner"));
  return lanes;
}
function dividedLanes(count, laneWidth, outsideShoulderWidth) {
  return ["left", "right"].flatMap((side) => {
    const prefix = side === "left" ? "opposite" : "forward";
    const lanes = [shoulderLane(`${prefix}-median-shoulder`, side, 1, 0.75, "outer")];
    for (let index = 0;index < count; index++) {
      lanes.push(motorLane(`${prefix}-lane-${index + 1}`, side, index + 2, laneWidth, index === 0 ? undefined : "broken"));
    }
    lanes.push(shoulderLane(`${prefix}-outside-shoulder`, side, count + 2, outsideShoulderWidth, "inner"));
    return lanes;
  });
}
function rampLanes(count, laneWidth = 4, outsideShoulderWidth = 1.5) {
  const lanes = [shoulderLane("left-shoulder", "right", 1, 0.5, "outer")];
  for (let index = 0;index < count; index++) {
    const lane = motorLane(index === 0 ? "ramp" : `ramp-${index + 1}`, "right", index + 2, laneWidth, index === 0 ? undefined : "broken");
    lanes.push({ ...lane, type: "on-ramp" });
  }
  lanes.push(shoulderLane("right-shoulder", "right", count + 2, outsideShoulderWidth, "inner"));
  return lanes;
}

// ../three-roads-inspect/packages/core/src/road-presets/german-modal-presets.ts
var germanModalRoadPresets = [
  roadPreset({ id: "de-pedestrian-promenade", name: "Pedestrian promenade", family: "modal-corridor", lanes: [{ ...specialLane("pedestrian", "right", 1, "sidewalk", 4, ["pedestrian"]), direction: "both" }], designSpeedKph: 10, minimumHorizontalRadius: 8, maximumGrade: 0.08 }),
  roadPreset({ id: "de-cycleway-one-way", name: "One-way cycleway", family: "modal-corridor", lanes: [specialLane("cycleway", "right", 1, "biking", 2.5, ["bicycle"], "edge")], designSpeedKph: 30, minimumHorizontalRadius: 15, maximumGrade: 0.08 }),
  roadPreset({ id: "de-shared-foot-cycleway", name: "Shared foot and cycleway", family: "modal-corridor", lanes: [{ role: "shared-modal", side: "right", order: 1, type: "shared", direction: "both", width: 3.5, access: ["bicycle", "pedestrian", "emergency"], priorityParticipants: ["pedestrian", "bicycle"] }], designSpeedKph: 20, minimumHorizontalRadius: 12, maximumGrade: 0.08 }),
  roadPreset({ id: "de-busway-two-way", name: "Two-way dedicated busway", family: "modal-corridor", lanes: [specialLane("outbound-bus", "left", 1, "bus", 3.25, ["bus", "emergency"]), specialLane("inbound-bus", "right", 1, "bus", 3.25, ["bus", "emergency"], "broken")], designSpeedKph: 50, minimumHorizontalRadius: 80 }),
  roadPreset({ id: "de-tramway-double-track", name: "Double-track tramway", family: "modal-corridor", lanes: [specialLane("outbound-tram", "left", 1, "tram", 3, ["tram"]), specialLane("inbound-tram", "right", 1, "tram", 3, ["tram"])], designSpeedKph: 60, minimumHorizontalRadius: 50, maximumGrade: 0.06 }),
  roadPreset({ id: "de-railway-double-track", name: "Double-track railway", family: "modal-corridor", lanes: [specialLane("outbound-rail", "left", 1, "rail", 4.4, ["tram"]), specialLane("inbound-rail", "right", 1, "rail", 4.4, ["tram"])], designSpeedKph: 120, minimumHorizontalRadius: 300, maximumGrade: 0.025 }),
  roadPreset({ id: "de-service-lane-one-way", name: "One-way service lane", family: "service-access", lanes: [specialLane("service", "right", 1, "restricted", 3.25, ["car", "emergency"], "edge")], designSpeedKph: 30, minimumHorizontalRadius: 20, maximumGrade: 0.1 }),
  roadPreset({ id: "de-service-lane-sidewalk", name: "Service lane with sidewalk", family: "service-access", lanes: [specialLane("service", "right", 1, "restricted", 3.25, ["car", "emergency"]), curbLane("right-curb", "right", 2), sidewalkLane("right-sidewalk", "right", 3)], designSpeedKph: 30, minimumHorizontalRadius: 20, maximumGrade: 0.1 }),
  roadPreset({ id: "de-roundabout-single-ring", name: "Single-lane roundabout ring", family: "urban-street", lanes: [{ role: "circulation", side: "right", order: 1, type: "driving", width: 4.5, access: ["car", "bus", "emergency"], boundaryMarkings: [{ id: "ring-inner-edge", kind: "edge", boundary: "inner", width: 0.15 }, { id: "ring-outer-edge", kind: "edge", boundary: "outer", width: 0.15 }] }], designSpeedKph: 40, minimumHorizontalRadius: 18 })
];

// ../three-roads-inspect/packages/core/src/road-presets/german-urban-presets.ts
var germanUrbanRoadPresets = [
  roadPreset({ id: "de-urban-two-way", name: "Urban two-way street", family: "urban-street", lanes: urbanLanes(), designSpeedKph: 50, minimumHorizontalRadius: 80 }),
  roadPreset({ id: "de-collector-two-way", name: "Urban collector street", family: "urban-street", lanes: urbanLanes(), designSpeedKph: 40, minimumHorizontalRadius: 45 }),
  roadPreset({ id: "de-residential-two-way", name: "Residential street", family: "urban-street", lanes: urbanLanes(), designSpeedKph: 30, minimumHorizontalRadius: 12 }),
  roadPreset({ id: "de-urban-one-way", name: "Urban one-way street", family: "urban-street", lanes: oneWayUrbanLanes(1), designSpeedKph: 50, minimumHorizontalRadius: 55 }),
  roadPreset({ id: "de-urban-one-way-two-lane", name: "Urban two-lane one-way street", family: "urban-street", lanes: oneWayUrbanLanes(2), designSpeedKph: 50, minimumHorizontalRadius: 65 }),
  roadPreset({ id: "de-urban-four-lane", name: "Four-lane urban arterial", family: "urban-street", lanes: urbanMotorLanes(2), designSpeedKph: 60, minimumHorizontalRadius: 140 }),
  roadPreset({ id: "de-urban-six-lane", name: "Six-lane urban arterial", family: "urban-street", lanes: urbanMotorLanes(3), designSpeedKph: 60, minimumHorizontalRadius: 170 }),
  roadPreset({ id: "de-urban-eight-lane", name: "Eight-lane urban arterial", family: "urban-street", lanes: urbanMotorLanes(4), designSpeedKph: 60, minimumHorizontalRadius: 200 }),
  roadPreset({ id: "de-urban-four-lane-median", name: "Four-lane urban boulevard with median", family: "urban-street", lanes: urbanMotorLanes(2, 2.5), designSpeedKph: 60, minimumHorizontalRadius: 150 }),
  roadPreset({ id: "de-urban-six-lane-median", name: "Six-lane urban boulevard with median", family: "urban-street", lanes: urbanMotorLanes(3, 3), designSpeedKph: 60, minimumHorizontalRadius: 180 }),
  roadPreset({ id: "de-urban-parking", name: "Urban street with parking lanes", family: "urban-street", lanes: parkingStreetLanes(), designSpeedKph: 30, minimumHorizontalRadius: 25 }),
  roadPreset({ id: "de-urban-cycle", name: "Urban street with cycle tracks", family: "modal-corridor", lanes: cycleStreetLanes(false), designSpeedKph: 50, minimumHorizontalRadius: 100 }),
  roadPreset({ id: "de-urban-protected-cycle", name: "Urban street with protected cycle tracks", family: "modal-corridor", lanes: cycleStreetLanes(true), designSpeedKph: 50, minimumHorizontalRadius: 100 }),
  roadPreset({ id: "de-urban-bus-lanes", name: "Urban arterial with curbside bus lanes", family: "modal-corridor", lanes: busStreetLanes(), designSpeedKph: 50, minimumHorizontalRadius: 120 }),
  roadPreset({ id: "de-urban-tram-median", name: "Urban boulevard with median tramway", family: "modal-corridor", lanes: tramBoulevardLanes(), designSpeedKph: 50, minimumHorizontalRadius: 120 }),
  roadPreset({ id: "de-bicycle-street", name: "Bicycle Street", family: "modal-corridor", lanes: bicycleStreetLanes(), designSpeedKph: 30, minimumHorizontalRadius: 20 }),
  roadPreset({ id: "de-shared-space", name: "Traffic-Calmed Area", family: "shared-space", lanes: [{ role: "shared", side: "right", order: 1, type: "driving", direction: "both", width: 5.5, access: ["car", "bicycle", "pedestrian", "emergency"], priorityParticipants: ["pedestrian"] }], designSpeedKph: 10, minimumHorizontalRadius: 12 })
];
function urbanLanes(laneWidth = 3.25, sidewalkWidth = 2.2) {
  return [
    motorLane("outbound", "left", 1, laneWidth),
    curbLane("left-curb", "left", 2),
    sidewalkLane("left-sidewalk", "left", 3, sidewalkWidth),
    motorLane("inbound", "right", 1, laneWidth, "broken"),
    curbLane("right-curb", "right", 2),
    sidewalkLane("right-sidewalk", "right", 3, sidewalkWidth)
  ];
}
function oneWayUrbanLanes(count) {
  const lanes = [curbLane("left-curb", "left", 1), sidewalkLane("left-sidewalk", "left", 2)];
  for (let index = 0;index < count; index++) {
    lanes.push(motorLane(`forward-lane-${index + 1}`, "right", index + 1, 3.25, index === 0 ? "edge" : "broken"));
  }
  appendUrbanEdge(lanes, "right", count + 1);
  return lanes;
}
function urbanMotorLanes(count, medianWidth = 0) {
  const lanes = [];
  for (const side of ["left", "right"]) {
    let order = 1;
    if (medianWidth > 0)
      lanes.push(medianLane(`${side}-median`, side, order++, medianWidth / 2));
    for (let index = 0;index < count; index++) {
      const marking = medianWidth > 0 || index > 0 || side === "right" ? index === 0 && medianWidth > 0 ? "solid" : "broken" : undefined;
      const position = index === 0 ? "inner" : count === 2 ? "outer" : `lane-${index + 1}`;
      lanes.push(motorLane(`${side === "left" ? "outbound" : "inbound"}-${position}`, side, order++, 3.25, marking));
    }
    appendUrbanEdge(lanes, side, order);
  }
  return lanes;
}
function parkingStreetLanes() {
  return [
    motorLane("outbound", "left", 1, 3),
    parkingLane("left-parking", "left", 2),
    curbLane("left-curb", "left", 3),
    sidewalkLane("left-sidewalk", "left", 4),
    motorLane("inbound", "right", 1, 3, "broken"),
    parkingLane("right-parking", "right", 2),
    curbLane("right-curb", "right", 3),
    sidewalkLane("right-sidewalk", "right", 4)
  ];
}
function cycleStreetLanes(protectedTrack) {
  const lanes = [];
  for (const side of ["left", "right"]) {
    const direction = side === "left" ? "outbound" : "inbound";
    lanes.push(motorLane(direction, side, 1, 3.25, side === "right" ? "broken" : undefined));
    let order = 2;
    if (protectedTrack)
      lanes.push(specialLane(`${side}-cycle-buffer`, side, order++, "restricted", 0.6, [], "solid"));
    const cycle = cycleLane(`${side}-cycle`, side, order++, 2);
    if (!protectedTrack) {
      cycle.boundaryMarkings = [{ id: `${side}-cycle-edge`, kind: "solid", boundary: "outer", width: 0.12 }];
    }
    lanes.push(cycle);
    appendUrbanEdge(lanes, side, order);
  }
  return lanes;
}
function busStreetLanes() {
  const lanes = [];
  for (const side of ["left", "right"]) {
    const prefix = side === "left" ? "outbound" : "inbound";
    lanes.push(motorLane(`${prefix}-general`, side, 1, 3.25, side === "right" ? "broken" : undefined));
    lanes.push(specialLane(`${prefix}-bus`, side, 2, "bus", 3.25, ["bus", "emergency"], "broken"));
    appendUrbanEdge(lanes, side, 3);
  }
  return lanes;
}
function tramBoulevardLanes() {
  const lanes = [];
  for (const side of ["left", "right"]) {
    const prefix = side === "left" ? "outbound" : "inbound";
    lanes.push(specialLane(`${prefix}-tram`, side, 1, "tram", 3, ["tram"]));
    lanes.push(motorLane(`${prefix}-car`, side, 2, 3.25, "solid"));
    appendUrbanEdge(lanes, side, 3);
  }
  return lanes;
}
function bicycleStreetLanes() {
  return [
    { ...motorLane("outbound", "left", 1, 2.75), access: ["bicycle", "car", "emergency"], priorityParticipants: ["bicycle"] },
    curbLane("left-curb", "left", 2),
    sidewalkLane("left-sidewalk", "left", 3),
    { ...motorLane("inbound", "right", 1, 2.75, "broken"), access: ["bicycle", "car", "emergency"], priorityParticipants: ["bicycle"] },
    curbLane("right-curb", "right", 2),
    sidewalkLane("right-sidewalk", "right", 3)
  ];
}

// ../three-roads-inspect/packages/core/src/road-presets/german-road-presets.ts
var germanRoadPresets = [
  ...germanUrbanRoadPresets,
  ...germanRuralRoadPresets,
  ...germanHighwayRoadPresets,
  ...germanModalRoadPresets
];
function germanRoadPreset(id) {
  const found = germanRoadPresets.find((preset) => preset.id === id);
  if (!found)
    throw new Error(`Unknown German road preset ${id}`);
  return structuredClone(found);
}
// ../three-roads-inspect/packages/core/src/topology/junction-portals.ts
var STATION_TOLERANCE3 = 0.00001;
function inferJunctionPortals(network, _options = {}) {
  return network.junctions.flatMap((junction) => {
    const contacts = junctionContacts2(network, junction);
    const roadIndices = new Map;
    return contacts.map((contact) => {
      const index = roadIndices.get(contact.road.id) ?? 0;
      roadIndices.set(contact.road.id, index + 1);
      return portalAt(junction.id, contact.road, contact.s, index);
    });
  });
}
function junctionContacts2(network, junction) {
  const contacts = [];
  for (const port of junction.ports ?? []) {
    const road = roadById2(network, port.roadId);
    if (road)
      contacts.push({ road, s: port.s ?? endpointS7(road, port.contactPoint) });
  }
  for (const connection of junction.connections) {
    const incoming = roadById2(network, connection.incomingRoadId);
    const connected = roadById2(network, connection.connectingRoadId);
    if (incoming && isApproachRoad(incoming, junction)) {
      contacts.push({
        road: incoming,
        s: connection.incomingS ?? endpointS7(incoming, connection.incomingContactPoint)
      });
    }
    if (!connected)
      continue;
    if (isApproachRoad(connected, junction)) {
      contacts.push({
        road: connected,
        s: connection.connectingS ?? endpointS7(connected, connection.contactPoint)
      });
    }
    if (junction.kind === "common" && connected.kind === "connector") {
      for (const lane of connected.laneSections.flatMap((section) => section.lanes)) {
        const successor = lane.links?.successor;
        if (!successor)
          continue;
        const outgoing = roadById2(network, successor.roadId);
        if (!outgoing || !isApproachRoad(outgoing, junction))
          continue;
        contacts.push({ road: outgoing, s: successor.s ?? endpointS7(outgoing, successor.contactPoint) });
      }
    }
  }
  return uniqueContacts(contacts);
}
function isApproachRoad(road, junction) {
  return !(junction.kind === "common" && road.kind === "connector" && road.junctionId === junction.id);
}
function uniqueContacts(contacts) {
  return contacts.filter((contact) => contact.s >= -STATION_TOLERANCE3 && contact.s <= contact.road.length + STATION_TOLERANCE3).sort((a, b) => a.road.id.localeCompare(b.road.id) || a.s - b.s).filter((contact, index, sorted) => {
    const previous = sorted[index - 1];
    return !previous || previous.road.id !== contact.road.id || Math.abs(previous.s - contact.s) > STATION_TOLERANCE3;
  });
}
function portalAt(junctionId, road, s, index) {
  const clampedS = Math.max(0, Math.min(road.length, s));
  const section = findLaneSection(road, clampedS);
  const boundaryPoints = sectionBoundaryPoints(road, section, clampedS);
  const center3 = roadToWorld(road, clampedS, 0);
  const center = { x: center3.x, y: center3.y };
  const cutLine = sortedCrossSectionPoints(road, section, clampedS, center, boundaryPoints);
  return {
    junctionId,
    roadId: road.id,
    index,
    center,
    cutLine,
    laneIds: [...new Set(boundaryPoints.map((point) => point.laneId))].sort((a, b) => a - b),
    boundaryPoints
  };
}
function sectionBoundaryPoints(road, section, s) {
  const localS = s - section.s;
  return section.lanes.flatMap((lane) => {
    if (lane.id === 0)
      return [];
    const offsets = laneOffsetsAt(section, lane.id, localS);
    const heights = laneHeightAt(lane, localS);
    return [
      boundaryPoint(road, section, lane, "inner", s, offsets.inner, heights.inner),
      boundaryPoint(road, section, lane, "outer", s, offsets.outer, heights.outer)
    ];
  });
}
function boundaryPoint(road, section, lane, side, s, t, height) {
  const point = laneSurfacePointAt(road, section, lane, s, t, height);
  return { sectionId: section.id, laneId: lane.id, side, point: { x: point.x, y: point.y } };
}
function sortedCrossSectionPoints(road, section, s, center, points) {
  const localS = s - section.s;
  const withOffsets = points.map((point) => {
    const offsets = laneOffsetsAt(section, point.laneId, localS);
    return { point: point.point, t: point.side === "inner" ? offsets.inner : offsets.outer };
  });
  withOffsets.push({ point: center, t: 0 });
  return dedupeByOffset(withOffsets.sort((a, b) => a.t - b.t)).map((item) => item.point);
}
function dedupeByOffset(values) {
  return values.filter((value, index) => index === 0 || Math.abs(value.t - values[index - 1].t) > 0.0000001);
}
function endpointS7(road, contactPoint) {
  return contactPoint === "start" ? 0 : road.length;
}
function roadById2(network, roadId) {
  return network.roads.find((road) => road.id === roadId);
}

// ../three-roads-inspect/packages/core/src/topology/junction-surfaces.ts
function inferJunctionSurfaces(network, options = {}) {
  const step = options.step ?? 2;
  const minArea = options.minArea ?? 0.01;
  return network.junctions.flatMap((junction) => {
    const roadIds = junctionRoadIds2(network, junction);
    const connectionPatches = junction.kind === "common" ? commonConnectorPatches(network, junction, step, minArea) : overlapPatches(network, junction, step, minArea);
    const conflictPatches = authoredConflictPatches(junction, minArea);
    const authoredPatches = authoredSurfacePatches2(junction, roadIds, minArea);
    const fallbackPatches = surfaceFallbackPatches2(network, junction, roadIds, minArea);
    const pavementInputs = [...authoredPatches, ...fallbackPatches, ...connectionPatches].map((patch) => patch.polygon);
    const components = pavementInputs.length > 0 ? unionPolygons(pavementInputs) : unionPolygons(conflictPatches.map((patch) => patch.polygon));
    if (components.length === 0 || polygonComponentsArea(components) < minArea)
      return [];
    const largest = [...components].sort((a, b) => componentArea2(b) - componentArea2(a))[0];
    return [{
      junctionId: junction.id,
      roadIds,
      patches: [...authoredPatches, ...fallbackPatches, ...connectionPatches, ...conflictPatches],
      components,
      polygon: largest.outer
    }];
  });
}
function surfaceFallbackPatches2(network, junction, roadIds, minArea) {
  const polygon = junctionSurfaceFallbackPolygon(network, junction.id, minArea);
  return polygon ? [{
    id: `surface-fallback|${junction.id}`,
    kind: "connection",
    roadIds,
    polygon,
    laneType: "driving"
  }] : [];
}
function authoredSurfacePatches2(junction, roadIds, minArea) {
  const sources = [
    ...junction.surfacePolygon ? [{
      id: `authored|${junction.id}`,
      polygon: junction.surfacePolygon,
      laneType: junction.surfaceLaneType
    }] : [],
    ...(junction.surfacePatches ?? []).map((patch) => ({
      id: `authored|${junction.id}|${patch.id}`,
      polygon: patch.polygon,
      laneType: patch.laneType
    }))
  ];
  return sources.flatMap((source) => {
    const polygon = normalizedPolygon(source.polygon);
    if (polygon.length < 3 || Math.abs(polygonArea(polygon)) < minArea)
      return [];
    return [{
      id: source.id,
      kind: "authored",
      roadIds,
      polygon,
      laneType: source.laneType
    }];
  });
}
function commonConnectorPatches(network, junction, step, minArea) {
  const connectorRoads = network.roads.filter((road) => road.kind === "connector" && road.junctionId === junction.id);
  return connectorRoads.flatMap((road) => {
    const connection = junction.connections.find((candidate) => candidate.connectingRoadId === road.id);
    return sampleLanePolygons(road, step).flatMap((lanePolygon) => {
      if (Math.abs(polygonArea(lanePolygon.points)) < minArea)
        return [];
      const laneLink = connection?.laneLinks.find((link) => link.to === lanePolygon.laneId);
      const lane = road.laneSections.find((section) => section.id === lanePolygon.sectionId)?.lanes.find((candidate) => candidate.id === lanePolygon.laneId);
      return [{
        id: `connector|${road.id}|${lanePolygon.sectionId}|${lanePolygon.laneId}`,
        kind: "connection",
        roadIds: uniqueStrings2([connection?.incomingRoadId, road.id].filter((id) => Boolean(id))),
        polygon: normalizedPolygon(lanePolygon.points),
        connectionId: connection?.id,
        fromLaneId: laneLink?.from,
        toLaneId: lanePolygon.laneId,
        ...lane ? { laneType: lane.type } : {},
        ...lane?.surface !== undefined ? { surface: lane.surface } : {}
      }];
    });
  });
}
function overlapPatches(network, junction, step, minArea) {
  return junction.connections.flatMap((connection) => {
    const incoming = roadById3(network, connection.incomingRoadId);
    const linked = roadById3(network, connection.connectingRoadId);
    if (!incoming || !linked)
      return [];
    const intersections = contactOverlapComponents(connectionContactPoints(incoming, linked, connection), intersectPolygons(sampleRoadEnvelope(incoming, step).points, [sampleRoadEnvelope(linked, step).points]));
    return intersections.flatMap((component, index) => {
      if (componentArea2(component) < minArea)
        return [];
      return [{
        id: `overlap|${connection.id}|${index}`,
        kind: "connection",
        roadIds: [incoming.id, linked.id].sort(),
        polygon: component.outer,
        holes: component.holes,
        connectionId: connection.id
      }];
    });
  });
}
function connectionContactPoints(incoming, linked, connection) {
  const incomingS = connection.incomingS ?? endpointS8(incoming, connection.incomingContactPoint);
  const linkedS = connection.connectingS ?? endpointS8(linked, connection.contactPoint);
  return [roadToWorld(incoming, incomingS, 0), roadToWorld(linked, linkedS, 0)];
}
function contactOverlapComponents(contacts, components) {
  const containing = components.filter((component) => contacts.some((point) => pointInComponent(point, component)));
  if (containing.length > 0 || components.length <= 1)
    return containing.length > 0 ? containing : components;
  const nearest = [...components].sort((left, right) => distanceToComponent(contacts, left) - distanceToComponent(contacts, right))[0];
  return nearest ? [nearest] : [];
}
function pointInComponent(point, component) {
  return pointInPolygon(point, component.outer, true) && !component.holes.some((hole) => pointInPolygon(point, hole, false));
}
function distanceToComponent(points, component) {
  return Math.min(...points.flatMap((point) => component.outer.map((start, index) => pointToSegmentDistance5(point, start, component.outer[(index + 1) % component.outer.length]))));
}
function pointToSegmentDistance5(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.00000000000001)
    return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
}
function authoredConflictPatches(junction, minArea) {
  return (junction.conflictZones ?? []).flatMap((zone) => {
    const polygon = normalizedPolygon(zone.polygon);
    if (polygon.length < 3 || Math.abs(polygonArea(polygon)) < minArea)
      return [];
    return [{
      id: `conflict|${zone.id}`,
      kind: "conflict",
      roadIds: [...zone.roadIds].sort(),
      polygon,
      conflictZoneId: zone.id
    }];
  });
}
function junctionRoadIds2(network, junction) {
  const ids = new Set;
  for (const port of junction.ports ?? [])
    ids.add(port.roadId);
  for (const road of network.roads)
    if (road.junctionId === junction.id)
      ids.add(road.id);
  for (const connection of junction.connections) {
    ids.add(connection.incomingRoadId);
    ids.add(connection.connectingRoadId);
  }
  return [...ids].sort();
}
function roadById3(network, roadId) {
  return network.roads.find((road) => road.id === roadId);
}
function endpointS8(road, contactPoint) {
  return contactPoint === "start" ? 0 : road.length;
}
function componentArea2(component) {
  return Math.abs(polygonArea(component.outer)) - component.holes.reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0);
}
function uniqueStrings2(values) {
  return [...new Set(values)].sort();
}

// ../three-roads-inspect/packages/core/src/topology/surface-patches.ts
function inferRoadSurfacePatches(network, options = {}) {
  const step = options.step ?? 4;
  const junctionSurfaces = options.junctionSurfaces ?? inferJunctionSurfaces(network, { step });
  const excludedRoadIds = new Set(options.excludedRoadIds ?? []);
  return network.roads.filter((road) => !excludedRoadIds.has(road.id)).flatMap((road) => {
    const roadJunctionSurfaces = road.kind === "connector" && road.junctionId ? [] : junctionSurfacesForRoad(junctionSurfaces, road.id);
    const envelope2 = sampleRoadEnvelope(road, step);
    if (envelope2.points.length < 3)
      return [];
    const cutouts = cutoutHoles(envelope2.points, roadJunctionSurfaces, options.minHoleArea);
    return [{
      kind: "road",
      roadId: road.id,
      outer: normalizedPolygon(envelope2.points),
      holes: cutouts.map((cutout) => cutout.hole),
      cutoutJunctionIds: uniqueStrings3(cutouts.map((cutout) => cutout.junctionId))
    }];
  });
}
function inferLaneSurfacePatches(network, options = {}) {
  const step = options.step ?? 4;
  const junctionSurfaces = options.junctionSurfaces ?? inferJunctionSurfaces(network, { step });
  const excludedRoadIds = new Set(options.excludedRoadIds ?? []);
  return network.roads.filter((road) => !excludedRoadIds.has(road.id)).flatMap((road) => sampleLanePolygons(road, step).filter((laneSurface) => laneSurface.points.length >= 3).map((laneSurface) => {
    const roadJunctionSurfaces = road.kind === "connector" && road.junctionId ? [] : junctionSurfacesForRoad(junctionSurfaces, road.id);
    const cutouts = cutoutHoles(laneSurface.points, roadJunctionSurfaces, options.minHoleArea);
    return {
      kind: "lane",
      roadId: road.id,
      sectionId: laneSurface.sectionId,
      laneId: laneSurface.laneId,
      laneType: laneSurface.laneType,
      outer: normalizedPolygon(laneSurface.points),
      holes: cutouts.map((cutout) => cutout.hole),
      cutoutJunctionIds: uniqueStrings3(cutouts.map((cutout) => cutout.junctionId))
    };
  }));
}
function uniqueStrings3(values) {
  return [...new Set(values)].sort();
}
function cutoutHoles(outer, junctionSurfaces, minHoleArea = 0.05) {
  return junctionSurfacePavementClipPolygons(junctionSurfaces).flatMap((clipPolygon) => {
    const hole = clipConvexPolygon(outer, clipPolygon.polygon);
    if (hole.length < 3 || Math.abs(polygonArea(hole)) < minHoleArea)
      return [];
    return [{ junctionId: clipPolygon.junctionId, hole: normalizedPolygon(hole) }];
  });
}

// ../three-roads-inspect/packages/core/src/svg/svg-render-presets.ts
function svgRenderPresetOptions(preset) {
  if (preset === "full")
    return {};
  if (preset === "base") {
    return withLayers({
      referenceLines: false,
      laneBoundaries: false,
      connectorRoads: false,
      laneLinks: false,
      laneCenterlines: false,
      laneSurfaces: true,
      roadSurfaces: true,
      junctionSurfaces: false,
      junctionAssemblies: true,
      junctionAssemblyDetails: false,
      junctionMovementSurfaces: false,
      junctionPortals: false,
      junctionStreams: false,
      conflictZones: false,
      markings: true,
      islands: true,
      objects: true,
      elevationLabels: false,
      gradeSeparations: true,
      weavingSections: false,
      roadStructures: true,
      roadsideFeatures: true
    }, { inferConflictZones: false, surfaceOutlines: false, surfacePalette: "material" });
  }
  if (preset === "topology") {
    return withLayers({
      referenceLines: true,
      laneBoundaries: true,
      connectorRoads: true,
      laneLinks: true,
      laneCenterlines: true,
      laneSurfaces: false,
      roadSurfaces: false,
      junctionSurfaces: true,
      junctionAssemblies: false,
      junctionMovementSurfaces: false,
      junctionPortals: true,
      junctionStreams: true,
      conflictZones: false,
      markings: false,
      islands: true,
      objects: true,
      elevationLabels: false,
      gradeSeparations: true,
      weavingSections: true,
      roadStructures: true,
      roadsideFeatures: true
    }, { inferConflictZones: false });
  }
  if (preset === "movements") {
    return withLayers({
      referenceLines: false,
      laneBoundaries: false,
      connectorRoads: false,
      laneLinks: true,
      laneCenterlines: false,
      laneSurfaces: false,
      roadSurfaces: true,
      junctionSurfaces: true,
      junctionAssemblies: true,
      junctionAssemblyDetails: false,
      junctionMovementSurfaces: true,
      junctionPortals: true,
      junctionStreams: true,
      conflictZones: false,
      markings: false,
      islands: true,
      objects: false,
      elevationLabels: false,
      gradeSeparations: false,
      weavingSections: true,
      roadStructures: false,
      roadsideFeatures: false
    }, { inferConflictZones: false, surfaceOutlines: false });
  }
  return withLayers({
    referenceLines: false,
    laneBoundaries: false,
    connectorRoads: false,
    laneLinks: false,
    laneCenterlines: false,
    laneSurfaces: true,
    roadSurfaces: true,
    junctionSurfaces: true,
    junctionAssemblies: true,
    junctionAssemblyDetails: false,
    junctionMovementSurfaces: false,
    junctionPortals: false,
    junctionStreams: true,
    conflictZones: true,
    markings: false,
    islands: true,
    objects: false,
    elevationLabels: false,
    gradeSeparations: false,
    weavingSections: true,
    roadStructures: false,
    roadsideFeatures: false
  }, { inferConflictZones: false, surfaceOutlines: false });
}
function withLayers(layers, options = {}) {
  return { ...options, layers };
}

// ../three-roads-inspect/packages/core/src/svg/road-structure.ts
function buildRoadStructureEvidence(network, structures, step) {
  return structures.map((roadStructure) => {
    const road = network.roads.find((candidate) => candidate.id === roadStructure.roadId);
    if (!road)
      throw new Error(`Road structure ${roadStructure.id} has no road ${roadStructure.roadId}`);
    const positive = boundary(road, roadStructure.sStart, roadStructure.sEnd, roadStructure.deckTMax, step);
    const negative = boundary(road, roadStructure.sStart, roadStructure.sEnd, roadStructure.deckTMin, step);
    return { roadStructure, polygon: [...positive, ...negative.reverse()] };
  });
}
function boundary(road, sStart, sEnd, t, step) {
  return sampleAdaptivePolyline(sStart, sEnd, (s) => {
    const point = roadToWorld(road, s, t);
    return { x: point.x, y: point.y };
  }, { maxSegmentLength: step, maxChordError: 0.01 }).map((sample) => sample.point);
}

// ../three-roads-inspect/packages/core/src/svg/grade-separation-deck.ts
function buildGradeSeparationDeckEvidence(network, gradeSeparations, step) {
  return mergePhysicalDecks(gradeSeparations).map((group) => {
    const gradeSeparation = group.relations[0];
    const upperRoad = network.roads.find((road) => road.id === gradeSeparation.upperRoad.roadId);
    if (!upperRoad)
      throw new Error(`Grade separation ${gradeSeparation.id} has no upper road ${gradeSeparation.upperRoad.roadId}`);
    const structure = gradeSeparation.structureId ? network.roadStructures?.find((candidate) => candidate.id === gradeSeparation.structureId) : undefined;
    const contact = evaluateRoadReference(upperRoad, (group.sStart + group.sEnd) * 0.5);
    return {
      gradeSeparation,
      gradeSeparations: group.relations,
      deckExtent: { sStart: group.sStart, sEnd: group.sEnd },
      polygon: structure ? buildRoadStructureEvidence(network, [structure], step)[0].polygon : sampleDeckPolygon(upperRoad, group.sStart, group.sEnd, step),
      labelPoint: { x: contact.x, y: contact.y }
    };
  });
}
function mergePhysicalDecks(gradeSeparations) {
  const sorted = [...gradeSeparations].sort((left, right) => left.upperRoad.roadId.localeCompare(right.upperRoad.roadId) || left.deckExtent.sStart - right.deckExtent.sStart || left.deckExtent.sEnd - right.deckExtent.sEnd || left.id.localeCompare(right.id));
  const groups = [];
  for (const relation of sorted) {
    const previous = groups.at(-1);
    const joinsPrevious = previous && previous.upperRoadId === relation.upperRoad.roadId && previous.kind === relation.kind && previous.deckThickness === relation.deckThickness && previous.structureId === relation.structureId && relation.deckExtent.sStart <= previous.sEnd + 0.0000001;
    if (joinsPrevious) {
      previous.sEnd = Math.max(previous.sEnd, relation.deckExtent.sEnd);
      previous.relations.push(relation);
      continue;
    }
    groups.push({
      upperRoadId: relation.upperRoad.roadId,
      kind: relation.kind,
      deckThickness: relation.deckThickness,
      structureId: relation.structureId,
      sStart: relation.deckExtent.sStart,
      sEnd: relation.deckExtent.sEnd,
      relations: [relation]
    });
  }
  return groups;
}
function sampleDeckPolygon(road, sStart, sEnd, step) {
  const left = [];
  const right = [];
  for (const section of [...road.laneSections].sort((a, b) => a.s - b.s)) {
    const start = Math.max(sStart, section.s);
    const end = Math.min(sEnd, laneSectionEndS(road, section));
    if (end <= start)
      continue;
    const leftOrdinal = Math.max(0, ...section.lanes.map((lane) => lane.id));
    const rightOrdinal = Math.min(0, ...section.lanes.map((lane) => lane.id));
    appendDistinct(left, boundary2(road, section, leftOrdinal, start, end, step));
    appendDistinct(right, boundary2(road, section, rightOrdinal, start, end, step));
  }
  return [...left, ...right.reverse()];
}
function boundary2(road, section, ordinal, start, end, step) {
  if (ordinal !== 0)
    return sampleLaneSectionBoundary(road, section, ordinal, start, end, step);
  const count = Math.max(1, Math.ceil((end - start) / step));
  return Array.from({ length: count + 1 }, (_, index) => {
    const point = roadToWorld(road, start + (end - start) * index / count, 0);
    return { x: point.x, y: point.y };
  });
}
function appendDistinct(target, points) {
  const start = target.length > 0 && points.length > 0 && Math.hypot(target.at(-1).x - points[0].x, target.at(-1).y - points[0].y) <= 0.0000001 ? 1 : 0;
  target.push(...points.slice(start));
}

// ../three-roads-inspect/packages/core/src/svg/weaving-section.ts
function buildWeavingSectionEvidence(network, weavingSections, step) {
  return weavingSections.map((weavingSection) => {
    const road = network.roads.find((candidate) => candidate.id === weavingSection.roadId);
    if (!road)
      throw new Error(`Weaving section ${weavingSection.id} has no road ${weavingSection.roadId}`);
    const inner = [];
    const outer = [];
    for (const pair of [...weavingSection.lanePairs].sort((left, right) => left.sStart - right.sStart)) {
      const section = road.laneSections.find((candidate) => candidate.id === pair.sectionId);
      const laneIds = [pair.throughLaneId, pair.weavingLaneId].sort((left, right) => Math.abs(left) - Math.abs(right));
      const innerLaneId = laneIds[0];
      const outerLaneId = laneIds[1];
      if (!section) {
        throw new Error(`Weaving section ${weavingSection.id} has invalid physical lane evidence`);
      }
      const sign = Math.sign(innerLaneId);
      appendDistinct2(inner, sampleLaneSectionBoundary(road, section, sign * (Math.abs(innerLaneId) - 1), pair.sStart, pair.sEnd, step));
      appendDistinct2(outer, sampleLaneSectionBoundary(road, section, outerLaneId, pair.sStart, pair.sEnd, step));
    }
    return { weavingSection, polygon: [...inner, ...outer.reverse()] };
  });
}
function appendDistinct2(target, points) {
  const start = target.length > 0 && points.length > 0 && Math.hypot(target.at(-1).x - points[0].x, target.at(-1).y - points[0].y) <= 0.0000001 ? 1 : 0;
  target.push(...points.slice(start));
}

// ../three-roads-inspect/packages/core/src/svg/traffic-management.ts
function buildTrafficManagementEvidence(network, step) {
  const closedLanes = [];
  const temporaryRoads = [];
  for (const road of network.roads) {
    const polygons = sampleLanePolygons(road, step);
    if (road.operational) {
      for (const polygon of polygons) {
        temporaryRoads.push({ roadId: road.id, polygon: polygon.points, provenance: road.operational });
      }
    }
    for (const polygon of polygons) {
      const section = road.laneSections.find((candidate) => candidate.id === polygon.sectionId);
      const lane = section?.lanes.find((candidate) => candidate.id === polygon.laneId);
      if (lane?.operational?.status !== "closed")
        continue;
      closedLanes.push({
        roadId: road.id,
        sectionId: polygon.sectionId,
        laneId: polygon.laneId,
        polygon: polygon.points,
        provenance: lane.operational
      });
    }
  }
  return { closedLanes, temporaryRoads };
}

// ../three-roads-inspect/packages/core/src/svg/roadside-feature.ts
function buildRoadsideFeatureEvidence(network, features, step) {
  return features.map((feature) => {
    if (feature.kind === "ditch") {
      const geometry2 = sampleRoadsideDitchPlan(network, feature, step);
      return { feature, polygon: geometry2.topPolygon, detailLines: [geometry2.innerBottom, geometry2.outerBottom] };
    }
    const geometry = sampleRoadsideRetainingWallPlan(network, feature, step);
    return { feature, polygon: geometry.footprint, detailLines: [geometry.innerFace, geometry.outerFace] };
  });
}

// ../three-roads-inspect/packages/core/src/svg/svg-surface-palette.ts
var ENGINEERING_PALETTE = {
  roadSurface: "#d1d5db",
  roadEdge: "#6b7280",
  laneOpacity: ".34",
  junctionLaneOpacity: ".34",
  island: "#94a3b8",
  islandEdge: "#475569",
  islandOpacity: ".65",
  platform: "#a8a29e",
  platformEdge: "#57534e",
  platformOpacity: ".8",
  laneFill: engineeringLaneFill
};
var MATERIAL_PREVIEW_BACKGROUND = "#4b554b";
var MATERIAL_PALETTE = {
  background: MATERIAL_PREVIEW_BACKGROUND,
  roadSurface: "#3f454b",
  roadEdge: "#252a30",
  laneOpacity: ".9",
  junctionLaneOpacity: ".9",
  island: "#8c9292",
  islandEdge: "#4c5253",
  islandOpacity: ".9",
  platform: "#9b9b96",
  platformEdge: "#555752",
  platformOpacity: ".9",
  laneFill: materialLaneFill
};
function svgSurfacePalette(id) {
  return id === "material" ? MATERIAL_PALETTE : ENGINEERING_PALETTE;
}
function engineeringLaneFill(laneType) {
  if (laneType === "biking")
    return "#22c55e";
  if (laneType === "parking")
    return "#94a3b8";
  if (laneType === "shoulder" || laneType === "border")
    return "#cbd5e1";
  if (laneType === "entry" || laneType === "exit" || laneType === "on-ramp" || laneType === "off-ramp")
    return "#fde68a";
  if (laneType === "sidewalk" || laneType === "shared")
    return "#e9d5ff";
  if (laneType === "tram")
    return "#f0abfc";
  if (laneType === "rail")
    return "#c4b5fd";
  if (laneType === "restricted" || laneType === "none")
    return "#fca5a5";
  if (laneType === "bus")
    return "#fecaca";
  if (laneType === "stop")
    return "#a5b4fc";
  if (laneType === "median")
    return "#d6d3d1";
  return "#bfdbfe";
}
function materialLaneFill(laneType) {
  if (laneType === "biking")
    return "#9f443b";
  if (laneType === "parking")
    return "#59616a";
  if (laneType === "shoulder" || laneType === "border")
    return "#555d64";
  if (laneType === "entry" || laneType === "exit" || laneType === "on-ramp" || laneType === "off-ramp")
    return "#464d54";
  if (laneType === "sidewalk" || laneType === "shared")
    return "#8c8f91";
  if (laneType === "tram")
    return "#5b5f63";
  if (laneType === "rail")
    return "#4d4a43";
  if (laneType === "restricted" || laneType === "none")
    return "#655552";
  if (laneType === "bus")
    return "#704b4e";
  if (laneType === "stop")
    return "#535b67";
  if (laneType === "median")
    return "#77766f";
  return "#454c53";
}

// ../three-roads-inspect/packages/core/src/svg/svg-renderer.ts
function renderRoadNetworkSvg(network, options = {}) {
  const presetOptions = options.preset ? svgRenderPresetOptions(options.preset) : {};
  const step = options.step ?? presetOptions.step ?? 4;
  const padding = options.padding ?? presetOptions.padding ?? 8;
  const strokeScale = options.strokeScale ?? presetOptions.strokeScale ?? 1;
  const includeValidation = options.includeValidation ?? presetOptions.includeValidation ?? false;
  const inferConflictZoneLayer = options.inferConflictZones ?? presetOptions.inferConflictZones ?? true;
  const surfaceOutlines = options.surfaceOutlines ?? presetOptions.surfaceOutlines ?? true;
  const palette = svgSurfacePalette(options.surfacePalette ?? presetOptions.surfacePalette ?? "engineering");
  const layers = {
    referenceLines: true,
    laneBoundaries: true,
    connectorRoads: true,
    laneLinks: true,
    laneCenterlines: false,
    laneSurfaces: true,
    roadSurfaces: true,
    junctionSurfaces: true,
    junctionAssemblies: true,
    junctionAssemblyDetails: true,
    junctionMovementSurfaces: true,
    junctionPortals: true,
    junctionStreams: true,
    conflictZones: true,
    markings: true,
    islands: true,
    objects: true,
    elevationLabels: true,
    gradeSeparations: true,
    weavingSections: true,
    roadStructures: true,
    trafficManagement: true,
    roadsideFeatures: true,
    ...presetOptions.layers,
    ...options.layers
  };
  const physicalTopology = options.physicalTopology ?? buildRoadPhysicalTopology(network);
  const gradeSeparationDecks = layers.gradeSeparations ? buildGradeSeparationDeckEvidence(network, physicalTopology.gradeSeparations ?? network.gradeSeparations ?? [], step) : [];
  const weavingSections = layers.weavingSections ? buildWeavingSectionEvidence(network, physicalTopology.weavingSections, step) : [];
  const roadStructures = layers.roadStructures ? buildRoadStructureEvidence(network, physicalTopology.roadStructures, step) : [];
  const roadsideFeatures = layers.roadsideFeatures ? buildRoadsideFeatureEvidence(network, physicalTopology.roadsideFeatures ?? [], step) : [];
  const trafficManagement = layers.trafficManagement ? buildTrafficManagementEvidence(network, step) : { closedLanes: [], temporaryRoads: [] };
  const junctionTessellation = tessellateJunctionPhysicalTopology(network, physicalTopology, { step });
  const junctionLaneTypes = physicalJunctionLaneTypes(physicalTopology);
  const junctionSurfaces = junctionTessellation.junctionSurfaces;
  const junctionPortals = inferJunctionPortals(network, { step, junctionSurfaces });
  const junctionMovementSurfaces = junctionTessellation.movementSurfaces;
  const junctionAssemblySurfaces = junctionTessellation.assemblySurfaces;
  const junctionOwnedRoadIds = new Set(layers.junctionAssemblies ? physicalTopology.junctions.flatMap((junction) => junction.movements.map((movement) => movement.connectorRoadId)) : []);
  const crossingJunctionIds = new Set(network.junctions.filter((junction) => junction.kind === "crossing").map((junction) => junction.id));
  const pavementCutouts = layers.junctionAssemblies ? junctionSurfaces.filter((surface) => !crossingJunctionIds.has(surface.junctionId)) : [];
  const roadSurfacePatches = inferRoadSurfacePatches(network, { step, junctionSurfaces: pavementCutouts, excludedRoadIds: junctionOwnedRoadIds });
  const laneSurfacePatches = inferLaneSurfacePatches(network, { step, junctionSurfaces: pavementCutouts, excludedRoadIds: junctionOwnedRoadIds });
  const allPoints = collectPoints(network, step, junctionSurfaces, junctionPortals, junctionMovementSurfaces, junctionAssemblySurfaces, roadSurfacePatches, laneSurfacePatches, [
    ...gradeSeparationDecks.flatMap((deck) => [...deck.polygon, deck.labelPoint]),
    ...weavingSections.flatMap((weaving) => weaving.polygon),
    ...roadStructures.flatMap((structure) => structure.polygon),
    ...roadsideFeatures.flatMap((feature) => [feature.polygon, ...feature.detailLines].flat())
  ]);
  const bounds = options.viewBox ?? computeBounds(allPoints, padding);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${formatNumber(bounds.minX)} ${formatNumber(bounds.minY)} ${formatNumber(bounds.width)} ${formatNumber(bounds.height)}" fill="none">`,
    `<title>${escapeXml(network.name ?? network.id)}</title>`,
    `<style>.road-structure{fill:#94a3b8;fill-opacity:.55;stroke:#334155}.tunnel-portal{stroke:#1e293b}.road-surface{fill:${palette.roadSurface};stroke:${palette.roadEdge}}.junction-surface{fill:none;stroke:#475569;stroke-dasharray:1.5 1}.junction-assembly{fill:${palette.roadSurface};fill-opacity:1;stroke:${palette.roadEdge}}.raised-table{fill:#d6b98c;fill-opacity:.38;stroke:#8a6a3e}.junction-assembly-part{fill-opacity:.6;stroke:#64748b;stroke-opacity:.28}.junction-lane-patch{fill:none;stroke:#0284c7}.junction-movement{fill-opacity:.28;stroke:#0ea5e9;stroke-opacity:.55}.junction-continuation{fill-opacity:.35;stroke:#a855f7;stroke-opacity:.75}.portal{stroke:#0f766e}.portal-point{fill:#0f766e;stroke:none}.junction-stream{stroke:#db2777}.lane-surface{stroke:none;fill-opacity:${palette.laneOpacity}}.reference{stroke:#1d4ed8}.lane-boundary{stroke:#111827}.lane-center{stroke:#16a34a}.connector{stroke:#7c3aed}.lane-link{stroke:#0891b2}.conflict{fill:#f97316;fill-opacity:.22;stroke:#ea580c}.weaving-section{fill:#f59e0b;fill-opacity:.16;stroke:#b45309;stroke-dasharray:2 1}.temporary-road{fill:#f59e0b;fill-opacity:.08;stroke:none}.closed-lane{fill:url(#closed-lane-hatch);stroke:#dc2626}.marking{stroke:var(--marking-color,#fff)}.marking-fill{fill:var(--marking-color,#fff);stroke:none}.hatched{fill:none;stroke:var(--marking-color,#fff)}.island{fill:${palette.island};fill-opacity:${palette.islandOpacity};stroke:${palette.islandEdge}}.platform{fill:${palette.platform};fill-opacity:${palette.platformOpacity};stroke:${palette.platformEdge}}.custom-object{fill:#fbbf24;fill-opacity:.32;stroke:#92400e}.guard-rail{fill:#64748b;fill-opacity:.9;stroke:#1e293b}.traffic-light{fill:#ef4444;stroke:#7f1d1d}.traffic-sign{fill:#f8fafc;stroke:#334155}.bollard{fill:#334155;stroke:none}.parking-bay{fill:none;stroke:#f8fafc}.elev{fill:#7c2d12;font:2.6px monospace}.bank{fill:#164e63;font:2.6px monospace}.diagnostic{fill:#dc2626;font:3px sans-serif}</style>`,
    '<defs><marker id="lane-link-arrow" markerWidth="5" markerHeight="5" refX="4.4" refY="2.5" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L5 2.5 L0 5 Z" fill="#0891b2"/></marker><marker id="stream-arrow" markerWidth="5" markerHeight="5" refX="4.4" refY="2.5" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L5 2.5 L0 5 Z" fill="#db2777"/></marker><pattern id="closed-lane-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#fee2e2" fill-opacity=".7"/><line x1="0" y1="0" x2="0" y2="4" stroke="#dc2626" stroke-width=".45"/></pattern></defs>'
  ];
  if (palette.background) {
    parts.push(`<rect id="canvas-background" x="${formatNumber(bounds.minX)}" y="${formatNumber(bounds.minY)}" width="${formatNumber(bounds.width)}" height="${formatNumber(bounds.height)}" fill="${palette.background}"/>`);
  }
  if (layers.roadsideFeatures && roadsideFeatures.length > 0) {
    parts.push("<style>.roadside-ditch{fill:#86a98f;fill-opacity:.5;stroke:#3f6212}.ditch-bottom{fill:none;stroke:#365314;stroke-dasharray:2 1}.retaining-wall{fill:#9ca3af;stroke:#374151}.wall-face{fill:none;stroke:#111827}</style>");
    parts.push('<g id="roadside-features">');
    for (const evidence of roadsideFeatures) {
      const feature = evidence.feature;
      const attrs = `data-roadside-feature-id="${escapeXml(feature.id)}" data-road-id="${escapeXml(feature.roadId)}" data-kind="${feature.kind}" data-lane-role="${escapeXml(feature.laneRole)}" data-side="${feature.side}" data-s-start="${formatNumber(feature.sStart)}" data-s-end="${formatNumber(feature.sEnd)}"`;
      if (feature.kind === "ditch") {
        const dimensions = `data-depth="${formatNumber(feature.depth)}" data-bottom-width="${formatNumber(feature.bottomWidth)}" data-side-slope="${formatNumber(feature.sideSlope)}"`;
        parts.push(`<polygon class="roadside-ditch" ${attrs} ${dimensions} points="${pointsAttr(evidence.polygon)}" stroke-width="${formatNumber(0.24 * strokeScale)}"/>`);
        for (const line of evidence.detailLines)
          parts.push(`<path class="ditch-bottom" ${attrs} d="${pathD(line)}" stroke-width="${formatNumber(0.18 * strokeScale)}"/>`);
      } else {
        const dimensions = `data-face="${feature.face}" data-thickness="${formatNumber(feature.thickness)}" data-height-start="${formatNumber(feature.heightStart)}" data-height-end="${formatNumber(feature.heightEnd)}"`;
        parts.push(`<polygon class="retaining-wall" ${attrs} ${dimensions} points="${pointsAttr(evidence.polygon)}" stroke-width="${formatNumber(0.25 * strokeScale)}"/>`);
        for (const line of evidence.detailLines)
          parts.push(`<path class="wall-face" ${attrs} d="${pathD(line)}" stroke-width="${formatNumber(0.16 * strokeScale)}"/>`);
      }
    }
    parts.push("</g>");
  }
  if (gradeSeparationDecks.length > 0) {
    parts.push("<style>.grade-separation-deck{fill:#cbd5e1;fill-opacity:1;stroke:#334155}.grade-separation-label{fill:#111827;font:1.6px monospace;paint-order:stroke;stroke:#f8fafc;stroke-width:.5px}</style>");
  }
  if (layers.roadStructures && roadStructures.length > 0) {
    parts.push('<g id="road-structures">');
    for (const evidence of roadStructures) {
      const structure = evidence.roadStructure;
      const attrs = `data-road-structure-id="${escapeXml(structure.id)}" data-road-id="${escapeXml(structure.roadId)}" data-kind="${structure.kind}" data-s-start="${formatNumber(structure.sStart)}" data-s-end="${formatNumber(structure.sEnd)}" data-deck-t-min="${formatNumber(structure.deckTMin)}" data-deck-t-max="${formatNumber(structure.deckTMax)}" data-structural-thickness="${formatNumber(structure.structuralThickness)}" data-minimum-lateral-clearance="${formatNumber(structure.minimumLateralClearance)}" data-actual-minimum-t="${formatNumber(structure.actualMinimumT)}" data-actual-maximum-t="${formatNumber(structure.actualMaximumT)}" data-actual-minimum-lateral-clearance="${formatNumber(structure.actualMinimumLateralClearance)}"`;
      parts.push(`<polygon class="road-structure" ${attrs} points="${pointsAttr(evidence.polygon)}" stroke-width="${formatNumber(0.3 * strokeScale)}"/>`);
    }
    parts.push("</g>");
  }
  if (layers.roadSurfaces) {
    parts.push('<g id="road-surfaces">');
    for (const patch of roadSurfacePatches) {
      parts.push(renderRoadSurfacePatch(patch, strokeScale, surfaceOutlines, palette));
    }
    parts.push("</g>");
  }
  if (layers.laneSurfaces) {
    parts.push('<g id="lane-surfaces">');
    for (const patch of laneSurfacePatches) {
      parts.push(renderLaneSurfacePatch(patch, palette));
    }
    parts.push("</g>");
  }
  if (layers.trafficManagement && (trafficManagement.temporaryRoads.length > 0 || trafficManagement.closedLanes.length > 0)) {
    parts.push('<g id="traffic-management">');
    for (const evidence of trafficManagement.temporaryRoads) {
      parts.push(`<polygon class="temporary-road" data-road-id="${escapeXml(evidence.roadId)}" data-plan-id="${escapeXml(evidence.provenance.planId)}" data-phase-id="${escapeXml(evidence.provenance.phaseId)}" points="${pointsAttr(evidence.polygon)}" stroke-width="${formatNumber(0.3 * strokeScale)}"/>`);
    }
    for (const evidence of trafficManagement.closedLanes) {
      parts.push(`<polygon class="closed-lane" data-road-id="${escapeXml(evidence.roadId)}" data-section-id="${escapeXml(evidence.sectionId)}" data-lane-id="${evidence.laneId}" data-plan-id="${escapeXml(evidence.provenance.planId)}" data-phase-id="${escapeXml(evidence.provenance.phaseId)}" points="${pointsAttr(evidence.polygon)}" stroke-width="${formatNumber(0.25 * strokeScale)}"/>`);
    }
    parts.push("</g>");
  }
  if (layers.roadStructures && roadStructures.some((evidence) => evidence.roadStructure.kind === "tunnel")) {
    parts.push('<g id="tunnel-portals">');
    for (const evidence of roadStructures.filter((candidate) => candidate.roadStructure.kind === "tunnel")) {
      const start = evidence.polygon[0];
      const end = evidence.polygon.at(-1);
      if (!start || !end)
        continue;
      parts.push(`<path class="tunnel-portal" data-road-structure-id="${escapeXml(evidence.roadStructure.id)}" data-road-id="${escapeXml(evidence.roadStructure.roadId)}" d="${pathD([start, end])}" stroke-width="${formatNumber(0.75 * strokeScale)}"/>`);
    }
    parts.push("</g>");
  }
  if (layers.weavingSections && weavingSections.length > 0) {
    parts.push('<g id="weaving-sections">');
    for (const evidence of weavingSections) {
      const weaving = evidence.weavingSection;
      const throughBandIds = weaving.lanePairs.map((pair) => pair.throughBandId).join(",");
      const weavingBandIds = weaving.lanePairs.map((pair) => pair.weavingBandId).join(",");
      const sharedBoundaryIds = weaving.lanePairs.map((pair) => pair.sharedBoundaryId).join(",");
      parts.push(`<polygon class="weaving-section" data-weaving-section-id="${escapeXml(weaving.id)}" data-road-id="${escapeXml(weaving.roadId)}" data-through-band-ids="${escapeXml(throughBandIds)}" data-weaving-band-ids="${escapeXml(weavingBandIds)}" data-shared-boundary-ids="${escapeXml(sharedBoundaryIds)}" data-entry-junction-id="${escapeXml(weaving.entryJunctionId)}" data-entry-maneuver-id="${escapeXml(weaving.entryManeuverId)}" data-exit-junction-id="${escapeXml(weaving.exitJunctionId)}" data-exit-maneuver-id="${escapeXml(weaving.exitManeuverId)}" data-s-start="${formatNumber(weaving.sStart)}" data-s-end="${formatNumber(weaving.sEnd)}" points="${pointsAttr(evidence.polygon)}" stroke-width="${formatNumber(0.3 * strokeScale)}"/>`);
    }
    parts.push("</g>");
  }
  if (layers.gradeSeparations && gradeSeparationDecks.length > 0) {
    parts.push('<g id="grade-separations">');
    for (const evidence of gradeSeparationDecks) {
      const relation = evidence.gradeSeparation;
      const relationIds = evidence.gradeSeparations.map((candidate) => candidate.id);
      const lowerRoadIds = [...new Set(evidence.gradeSeparations.map((candidate) => candidate.lowerRoad.roadId))];
      const minimumClearance = Math.max(...evidence.gradeSeparations.map((candidate) => candidate.minimumClearance));
      const actualClearance = Math.min(...evidence.gradeSeparations.map((candidate) => candidate.actualPavementClearance));
      const structureAttr = relation.structureId ? ` data-road-structure-id="${escapeXml(relation.structureId)}"` : "";
      const attrs = `data-grade-separation-id="${escapeXml(relation.id)}" data-grade-separation-ids="${escapeXml(relationIds.join(","))}"${structureAttr} data-kind="${relation.kind}" data-upper-road-id="${escapeXml(relation.upperRoad.roadId)}" data-upper-s="${formatNumber(relation.upperRoad.s)}" data-lower-road-id="${escapeXml(relation.lowerRoad.roadId)}" data-lower-road-ids="${escapeXml(lowerRoadIds.join(","))}" data-lower-s="${formatNumber(relation.lowerRoad.s)}" data-deck-thickness="${formatNumber(relation.deckThickness)}" data-deck-s-start="${formatNumber(evidence.deckExtent.sStart)}" data-deck-s-end="${formatNumber(evidence.deckExtent.sEnd)}" data-minimum-clearance="${formatNumber(minimumClearance)}" data-actual-pavement-clearance="${formatNumber(actualClearance)}"`;
      if (relation.structureId) {
        parts.push(`<g class="grade-separation-relation" ${attrs}></g>`);
      } else {
        parts.push(`<polygon class="grade-separation-deck" ${attrs} points="${pointsAttr(evidence.polygon)}" stroke-width="${formatNumber(0.3 * strokeScale)}"/>`);
      }
      if (layers.elevationLabels) {
        parts.push(`<text class="grade-separation-label" ${attrs} x="${formatNumber(evidence.labelPoint.x + 1)}" y="${formatNumber(evidence.labelPoint.y - 1)}">clearance=${formatNumber(actualClearance)}m</text>`);
      }
    }
    parts.push("</g>");
  }
  if (layers.junctionSurfaces) {
    parts.push('<g id="junction-surfaces">');
    for (const surface of junctionSurfaces) {
      if (surface.patches.length === 0) {
        parts.push(`<polygon class="junction-surface" data-junction-id="${escapeXml(surface.junctionId)}" data-road-ids="${escapeXml(surface.roadIds.join(","))}" points="${pointsAttr(surface.polygon)}" fill="none" stroke-width="${formatNumber(0.28 * strokeScale)}"/>`);
        continue;
      }
      for (const patch of surface.patches) {
        parts.push(`<polygon class="junction-surface" data-junction-id="${escapeXml(surface.junctionId)}" data-surface-patch-id="${escapeXml(patch.id)}" data-surface-patch-kind="${escapeXml(patch.kind)}"${patch.connectionId ? ` data-connection-id="${escapeXml(patch.connectionId)}"` : ""}${patch.fromLaneId !== undefined ? ` data-from-lane-id="${patch.fromLaneId}"` : ""}${patch.toLaneId !== undefined ? ` data-to-lane-id="${patch.toLaneId}"` : ""} data-road-ids="${escapeXml(patch.roadIds.join(","))}" points="${pointsAttr(patch.polygon)}" fill="none" stroke-width="${formatNumber(0.28 * strokeScale)}"/>`);
      }
    }
    parts.push("</g>");
  }
  if (layers.junctionAssemblies) {
    parts.push('<g id="junction-assemblies">');
    for (const assembly of junctionAssemblySurfaces) {
      parts.push(renderJunctionAssemblySurface(assembly, strokeScale, layers.junctionAssemblyDetails, surfaceOutlines, layers.laneSurfaces, junctionLaneTypes.get(assembly.junctionId) ?? [], palette));
      const surfaceElevation = network.junctions.find((junction) => junction.id === assembly.junctionId)?.surfaceElevation;
      if (surfaceElevation) {
        parts.push(`<path class="raised-table" data-junction-id="${escapeXml(assembly.junctionId)}" data-height="${formatNumber(surfaceElevation.height)}" data-ramp-length="${formatNumber(surfaceElevation.rampLength)}" d="${assemblyPathD(assembly)}" fill-rule="evenodd" stroke-width="${formatNumber(0.16 * strokeScale)}"/>`);
      }
    }
    parts.push("</g>");
  }
  if (layers.junctionMovementSurfaces) {
    parts.push('<g id="junction-movement-surfaces">');
    for (const surface of junctionMovementSurfaces) {
      parts.push(renderJunctionMovementSurface(surface, strokeScale, palette));
    }
    parts.push("</g>");
  }
  if (layers.junctionPortals) {
    parts.push('<g id="junction-portals">');
    for (const portal of junctionPortals) {
      parts.push(renderJunctionPortal(portal, strokeScale));
    }
    parts.push("</g>");
  }
  if (layers.junctionStreams) {
    parts.push('<g id="junction-traffic-streams">');
    for (const junction of network.junctions) {
      for (const stream of junction.trafficStreams ?? []) {
        const road = network.roads.find((candidate) => candidate.id === stream.roadId);
        const section = road?.laneSections.find((candidate) => candidate.id === physicalTopology.junctions.find((topology) => topology.junctionId === junction.id)?.trafficStreams.find((topologyStream) => topologyStream.sourceStreamId === stream.id)?.sectionId);
        const lane = section?.lanes.find((candidate) => candidate.id === stream.laneId);
        if (!road || !section || !lane)
          continue;
        const sampled = sampleLaneCenterline(road, section, lane.id, stream.sStart, stream.sEnd, step);
        const points = laneTravelSign(lane) < 0 ? [...sampled].reverse() : sampled;
        parts.push(`<path class="junction-stream" data-junction-id="${escapeXml(junction.id)}" data-stream-id="${escapeXml(stream.id)}" data-road-id="${escapeXml(stream.roadId)}" data-lane-id="${stream.laneId}" data-movement="${stream.movement}"${stream.contactGroupId ? ` data-contact-group-id="${escapeXml(stream.contactGroupId)}"` : ""} d="${pathD(points)}" marker-end="url(#stream-arrow)" stroke-width="${formatNumber(0.3 * strokeScale)}"/>`);
      }
    }
    parts.push("</g>");
  }
  if (layers.conflictZones) {
    parts.push('<g id="conflict-zones">');
    for (const junction of network.junctions) {
      for (const zone of junction.conflictZones ?? []) {
        const colors = conflictColors(zone.kind);
        const movementInteraction = junction.movementInteractions?.find((candidate) => candidate.conflictZoneIds.includes(zone.id));
        const streamInteraction = junction.streamInteractions?.find((candidate) => candidate.conflictZoneIds.includes(zone.id));
        const control = movementInteraction?.control ?? streamInteraction?.control;
        const controlKind = control?.kind;
        const controlBasis = control?.kind === "fixed-priority" ? control.basis : undefined;
        parts.push(`<polygon class="conflict" data-source="authored" data-zone-id="${escapeXml(zone.id)}"${zone.kind ? ` data-conflict-kind="${zone.kind}"` : ""}${controlKind ? ` data-control-kind="${controlKind}"` : ""}${controlBasis ? ` data-control-basis="${controlBasis}"` : ""}${zone.maneuverIds ? ` data-maneuver-ids="${escapeXml(zone.maneuverIds.join(","))}"` : ""}${zone.streamIds ? ` data-stream-ids="${escapeXml(zone.streamIds.join(","))}"` : ""}${zone.priorityManeuverId ? ` data-priority-maneuver-id="${escapeXml(zone.priorityManeuverId)}"` : ""}${zone.priorityStreamId ? ` data-priority-stream-id="${escapeXml(zone.priorityStreamId)}"` : ""} points="${pointsAttr(zone.polygon)}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="${formatNumber(0.4 * strokeScale)}" style="fill:${colors.fill};stroke:${colors.stroke}"/>`);
      }
    }
    if (inferConflictZoneLayer) {
      for (const zone of inferConflictZones(network, { step })) {
        parts.push(`<polygon class="conflict" data-source="inferred" data-zone-id="${escapeXml(zone.id)}" data-road-ids="${escapeXml(zone.roadIds.join(","))}" points="${pointsAttr(zone.polygon)}" stroke-width="${formatNumber(0.32 * strokeScale)}" stroke-dasharray="1 1"/>`);
      }
    }
    parts.push("</g>");
  }
  if (layers.referenceLines) {
    parts.push('<g id="reference-lines">');
    for (const road of network.roads) {
      const roadJunctionSurfaces = roadPathCutouts(road, junctionSurfaces, gradeSeparationDecks);
      for (const segment of clipPathByJunctionSurfaces(sampleRoadReference(road, { step }), roadJunctionSurfaces)) {
        parts.push(`<path class="reference" data-road-id="${escapeXml(road.id)}"${cutoutAttrs(segment)} d="${pathD(segment.points)}" stroke-width="${formatNumber(0.35 * strokeScale)}"/>`);
      }
    }
    parts.push("</g>");
  }
  if (layers.laneBoundaries) {
    parts.push('<g id="lane-boundaries">');
    for (const road of network.roads) {
      const roadJunctionSurfaces = roadPathCutouts(road, junctionSurfaces, gradeSeparationDecks);
      for (const boundary3 of sampleLaneBoundaries(road, step)) {
        for (const segment of clipPathByJunctionSurfaces(boundary3.points, roadJunctionSurfaces)) {
          parts.push(`<path class="lane-boundary" data-road-id="${escapeXml(road.id)}" data-section-id="${escapeXml(boundary3.sectionId)}" data-lane-id="${boundary3.laneId}" data-side="${boundary3.side}"${cutoutAttrs(segment)} d="${pathD(segment.points)}" stroke-width="${formatNumber(0.18 * strokeScale)}"/>`);
        }
      }
    }
    parts.push("</g>");
  }
  if (layers.laneCenterlines) {
    parts.push('<g id="lane-centerlines">');
    for (const road of network.roads) {
      const roadJunctionSurfaces = roadPathCutouts(road, junctionSurfaces, gradeSeparationDecks);
      for (const centerline of sampleLaneCenterlines(road, step)) {
        for (const segment of clipPathByJunctionSurfaces(centerline.points, roadJunctionSurfaces)) {
          parts.push(`<path class="lane-center" data-road-id="${escapeXml(road.id)}" data-section-id="${escapeXml(centerline.sectionId)}" data-lane-id="${centerline.laneId}"${cutoutAttrs(segment)} d="${pathD(segment.points)}" stroke-width="${formatNumber(0.12 * strokeScale)}" stroke-dasharray="1 2"/>`);
        }
      }
    }
    parts.push("</g>");
  }
  if (layers.connectorRoads) {
    parts.push('<g id="connector-roads">');
    for (const road of network.roads.filter((candidate) => candidate.kind === "connector")) {
      parts.push(`<path class="connector" data-road-id="${escapeXml(road.id)}" data-required-continuity="${road.requiredEndpointContinuity ?? "g1"}" d="${pathD(sampleRoadReference(road, { step }))}" stroke-width="${formatNumber(0.5 * strokeScale)}" stroke-dasharray="2 1"/>`);
    }
    parts.push("</g>");
  }
  if (layers.laneLinks) {
    parts.push('<g id="lane-links">');
    for (const edge of buildLaneGraph(network).edges.filter((candidate) => candidate.kind === "junction" || candidate.kind === "lane-link" || candidate.kind === "lane-change")) {
      const rangeAttrs = edge.sStart === undefined || edge.sEnd === undefined ? "" : ` data-s-start="${formatNumber(edge.sStart)}" data-s-end="${formatNumber(edge.sEnd)}"`;
      const weavingAttrs = edge.weavingSectionIds?.length ? ` data-weaving-section-ids="${escapeXml(edge.weavingSectionIds.join(","))}"` : "";
      parts.push(`<path class="lane-link" data-edge-kind="${edge.kind}" data-from-road-id="${escapeXml(edge.from.roadId)}" data-from-lane-id="${edge.from.laneId}" data-to-road-id="${escapeXml(edge.to.roadId)}" data-to-lane-id="${edge.to.laneId}"${rangeAttrs}${weavingAttrs} d="${pathD([edge.fromPoint, edge.toPoint])}" stroke-width="${formatNumber(0.18 * strokeScale)}" stroke-dasharray="1 1" marker-end="url(#lane-link-arrow)"/>`);
    }
    parts.push("</g>");
  }
  if (layers.markings) {
    parts.push('<g id="markings">');
    for (const road of network.roads) {
      const roadJunctionSurfaces = roadPathCutouts(road, junctionSurfaces, gradeSeparationDecks);
      for (const marking of road.markings ?? []) {
        parts.push(...renderRoadMarking(road, marking, step, strokeScale));
      }
      const corridor = physicalTopology.corridors.find((candidate) => candidate.roadId === road.id);
      for (const corridorSection of corridor?.sections ?? []) {
        const section = road.laneSections.find((candidate) => candidate.id === corridorSection.sectionId);
        if (!section)
          continue;
        for (const physicalBoundary of corridorSection.boundaries) {
          for (const marking of physicalBoundary.markings) {
            const markingStart = Math.max(corridorSection.sStart, marking.sStart ?? corridorSection.sStart);
            const markingEnd = Math.min(corridorSection.sEnd, marking.sEnd ?? corridorSection.sEnd);
            if (markingEnd <= markingStart)
              continue;
            const boundary3 = sampleLaneSectionBoundary(road, section, physicalBoundary.ordinal, markingStart, markingEnd, step);
            for (const segment of clipPathByJunctionSurfaces(boundary3, roadJunctionSurfaces)) {
              const color = markingColor(marking.color);
              parts.push(`<path class="marking" data-road-id="${escapeXml(road.id)}" data-section-id="${escapeXml(section.id)}" data-boundary-id="${escapeXml(physicalBoundary.id)}" data-boundary-ordinal="${physicalBoundary.ordinal}" data-marking-kind="${escapeXml(marking.kind)}" data-marking-color="${escapeXml(marking.color ?? "white")}" style="--marking-color:${color};stroke:${color}"${cutoutAttrs(segment)} d="${pathD(segment.points)}" stroke-width="${formatNumber((marking.width ?? 0.15) * strokeScale)}"${laneMarkingDash(marking.kind)}/>`);
            }
          }
        }
      }
    }
    parts.push("</g>");
  }
  if (layers.islands) {
    parts.push('<g id="islands">');
    for (const road of network.roads) {
      for (const object of road.objects ?? []) {
        if (object.kind !== "island" && object.kind !== "platform")
          continue;
        const polygon = object.polygon ?? objectFootprint2(road, object);
        if (!polygon)
          continue;
        const cssClass = object.kind === "platform" ? "platform" : "island";
        parts.push(`<polygon class="${cssClass}" data-road-id="${escapeXml(road.id)}" data-object-id="${escapeXml(object.id)}" data-object-kind="${object.kind}" points="${pointsAttr(polygon)}" stroke-width="${formatNumber(0.2 * strokeScale)}"/>`);
      }
    }
    for (const object of network.objects ?? []) {
      if (object.kind !== "island" && object.kind !== "platform" || !object.polygon)
        continue;
      const cssClass = object.kind === "platform" ? "platform" : "island";
      parts.push(`<polygon class="${cssClass}" data-junction-id="${escapeXml(object.junctionId ?? "")}" data-object-id="${escapeXml(object.id)}" data-object-kind="${object.kind}" points="${pointsAttr(object.polygon)}" stroke-width="${formatNumber(0.2 * strokeScale)}"/>`);
    }
    parts.push("</g>");
  }
  if (layers.objects) {
    parts.push('<g id="objects">');
    for (const road of network.roads) {
      for (const object of road.objects ?? []) {
        parts.push(...renderRoadObject(road, object, strokeScale));
      }
    }
    parts.push("</g>");
  }
  if (layers.elevationLabels && network.roads.some((road) => road.elevation?.length || road.superelevation?.length)) {
    parts.push('<g id="elevation-labels">');
    for (const road of network.roads) {
      if (!road.elevation?.length && !road.superelevation?.length)
        continue;
      for (const s of profileLabelStations(road)) {
        const point = stToWorld(road.referenceLine, s, 0);
        if (road.elevation?.length) {
          const z = roadElevationAt(road, s);
          parts.push(`<text class="elev" data-road-id="${escapeXml(road.id)}" data-s="${formatNumber(s)}" x="${formatNumber(point.x)}" y="${formatNumber(point.y)}">z=${formatNumber(z)}</text>`);
        }
        if (road.superelevation?.length) {
          const bank = roadSuperelevationAt(road, s);
          parts.push(`<text class="bank" data-road-id="${escapeXml(road.id)}" data-s="${formatNumber(s)}" x="${formatNumber(point.x)}" y="${formatNumber(point.y + 3)}">bank=${formatNumber(bank)}</text>`);
        }
      }
    }
    parts.push("</g>");
  }
  if (includeValidation) {
    const validation = validateRoadNetwork(network);
    parts.push('<g id="validation">');
    validation.diagnostics.forEach((diagnostic3, index) => {
      parts.push(`<text class="diagnostic" x="${formatNumber(bounds.minX + padding)}" y="${formatNumber(bounds.minY + padding + index * 4)}">${escapeXml(diagnostic3.code)}</text>`);
    });
    parts.push("</g>");
  }
  parts.push("</svg>");
  return parts.join("");
}
function conflictColors(kind) {
  if (kind === "merge")
    return { fill: "#22c55e", stroke: "#15803d" };
  if (kind === "diverge")
    return { fill: "#38bdf8", stroke: "#0284c7" };
  return { fill: "#f97316", stroke: "#ea580c" };
}
function profileLabelStations(road) {
  return [...new Set([
    0,
    road.length,
    ...(road.elevation ?? []).map((record) => record.s),
    ...(road.superelevation ?? []).map((record) => record.s)
  ].map((s) => formatNumber(Math.max(0, Math.min(road.length, s)))))].map(Number).sort((a, b) => a - b);
}
function collectPoints(network, step, junctionSurfaces, junctionPortals, junctionMovementSurfaces, junctionAssemblySurfaces, roadSurfacePatches, laneSurfacePatches, gradeSeparationPoints) {
  return [
    ...network.roads.flatMap((road) => sampleRoadReference(road, { step })),
    ...network.roads.flatMap((road) => sampleLaneBoundaries(road, step).flatMap((boundary3) => boundary3.points)),
    ...network.roads.flatMap((road) => sampleLaneCenterlines(road, step).flatMap((centerline) => centerline.points)),
    ...roadSurfacePatches.flatMap((patch) => [patch.outer, ...patch.holes].flat()),
    ...laneSurfacePatches.flatMap((patch) => [patch.outer, ...patch.holes].flat()),
    ...gradeSeparationPoints,
    ...junctionSurfaces.flatMap((surface) => [surface.polygon, ...surface.patches.map((patch) => patch.polygon)].flat()),
    ...junctionPortals.flatMap((portal) => [portal.center, ...portal.cutLine]),
    ...junctionMovementSurfaces.flatMap((surface) => [...surface.polygon, ...surface.centerline]),
    ...junctionAssemblySurfaces.flatMap((surface) => [
      ...surface.components.flatMap((component) => [component.outer, ...component.holes]),
      ...surface.surfaceParts.map((part) => part.polygon)
    ].flat()),
    ...network.junctions.flatMap((junction) => (junction.conflictZones ?? []).flatMap((zone) => zone.polygon)),
    ...inferConflictZones(network, { step }).flatMap((zone) => zone.polygon),
    ...network.roads.flatMap((road) => (road.objects ?? []).flatMap((object) => object.polygon ?? roadObjectFootprintsWorld(road, object).flat())),
    ...(network.objects ?? []).flatMap((object) => object.polygon ?? []),
    ...network.roads.flatMap((road) => (road.markings ?? []).flatMap((marking) => {
      const bands = markingBands(marking);
      return [
        stToWorld(road.referenceLine, marking.sStart, bands.start.tStart),
        stToWorld(road.referenceLine, marking.sStart, bands.start.tEnd),
        stToWorld(road.referenceLine, marking.sEnd, bands.end.tStart),
        stToWorld(road.referenceLine, marking.sEnd, bands.end.tEnd)
      ];
    }))
  ];
}
function renderRoadSurfacePatch(patch, strokeScale, surfaceOutlines, palette) {
  return `<path class="road-surface" data-road-id="${escapeXml(patch.roadId)}"${cutoutAttrs(patch)} d="${surfacePathD(patch)}" fill="${palette.roadSurface}" fill-opacity="1" fill-rule="evenodd" stroke="${palette.roadEdge}" stroke-width="${formatNumber(0.2 * strokeScale)}"${surfaceOutlines ? "" : ' style="stroke:none"'}/>`;
}
function renderLaneSurfacePatch(patch, palette) {
  return `<path class="lane-surface" data-road-id="${escapeXml(patch.roadId)}" data-section-id="${escapeXml(patch.sectionId)}" data-lane-id="${patch.laneId}" data-lane-type="${escapeXml(patch.laneType)}"${cutoutAttrs(patch)} d="${surfacePathD(patch)}" fill="${palette.laneFill(patch.laneType)}" fill-rule="evenodd"/>`;
}
function renderJunctionMovementSurface(surface, strokeScale, palette) {
  const className = surface.surfaceKind === "lane-continuation" ? "junction-continuation" : "junction-movement";
  return `<polygon class="${className}" data-junction-id="${escapeXml(surface.junctionId)}" data-surface-kind="${surface.surfaceKind}" data-movement-id="${escapeXml(surface.id)}" data-connection-id="${escapeXml(surface.connectionId ?? "")}"${surface.sourceManeuverId ? ` data-source-maneuver-id="${escapeXml(surface.sourceManeuverId)}"` : ""}${surface.sourceLaneContinuationId ? ` data-source-lane-continuation-id="${escapeXml(surface.sourceLaneContinuationId)}"` : ""} data-from-road-id="${escapeXml(surface.from.roadId)}" data-from-lane-id="${surface.from.laneId}" data-to-road-id="${escapeXml(surface.to.roadId)}" data-to-lane-id="${surface.to.laneId}" data-lane-type="${escapeXml(surface.laneType)}" points="${pointsAttr(surface.polygon)}" fill="${palette.laneFill(surface.laneType)}" stroke-width="${formatNumber(0.16 * strokeScale)}"/>`;
}
function renderJunctionAssemblySurface(assembly, strokeScale, includeDetails, surfaceOutlines, tintLaneSurface, ownedLaneTypes, palette) {
  const surface = `<path class="junction-assembly" data-junction-id="${escapeXml(assembly.junctionId)}" data-surface-part-count="${assembly.surfaceParts.length}" data-lane-type-surface-count="${assembly.laneTypeSurfaces.length}" data-lane-patch-count="${assembly.lanePatches.length}" data-movement-count="${assembly.movementSurfaces.length}" data-hole-count="${assembly.holes.length}" d="${assemblyPathD(assembly)}" fill-rule="evenodd" stroke-width="${formatNumber(0.22 * strokeScale)}"${surfaceOutlines ? "" : ' style="stroke:none"'}/>`;
  const laneTypes = new Set([
    ...assembly.movementSurfaces.map((movement) => movement.laneType),
    ...ownedLaneTypes
  ]);
  const typedLaneTints = tintLaneSurface ? assembly.laneTypeSurfaces.map((laneTypeSurface) => `<path class="junction-lane-surface" data-junction-id="${escapeXml(assembly.junctionId)}" data-lane-type="${escapeXml(laneTypeSurface.laneType)}" d="${polygonComponentsPathD(laneTypeSurface.components)}" fill="${palette.laneFill(laneTypeSurface.laneType)}" fill-opacity="${palette.junctionLaneOpacity}" fill-rule="evenodd" style="stroke:none"/>`).join("") : "";
  const fallbackLaneTint = tintLaneSurface && assembly.laneTypeSurfaces.length === 0 && laneTypes.size === 1 ? `<path class="junction-lane-surface" data-junction-id="${escapeXml(assembly.junctionId)}" data-lane-type="${escapeXml([...laneTypes][0])}" d="${assemblyPathD(assembly)}" fill="${palette.laneFill([...laneTypes][0])}" fill-opacity="${palette.junctionLaneOpacity}" fill-rule="evenodd" style="stroke:none"/>` : "";
  if (!includeDetails)
    return `${surface}${typedLaneTints}${fallbackLaneTint}`;
  return [
    surface,
    typedLaneTints,
    fallbackLaneTint,
    ...assembly.surfaceParts.map((part) => `<path class="junction-assembly-part" data-junction-id="${escapeXml(assembly.junctionId)}" data-part-id="${escapeXml(part.id)}" data-part-kind="${escapeXml(part.kind)}" data-lane-type="${escapeXml(part.laneType)}"${part.roadId ? ` data-road-id="${escapeXml(part.roadId)}"` : ""}${part.sectionId ? ` data-section-id="${escapeXml(part.sectionId)}"` : ""}${part.laneId !== undefined ? ` data-lane-id="${part.laneId}"` : ""}${part.surfacePatchId ? ` data-surface-patch-id="${escapeXml(part.surfacePatchId)}"` : ""}${part.movementId ? ` data-movement-id="${escapeXml(part.movementId)}"` : ""} data-hole-count="${part.holes.length}" d="${assemblyPartPathD(part)}" fill="${palette.laneFill(part.laneType)}" fill-rule="evenodd" stroke-width="${formatNumber(0.08 * strokeScale)}"/>`),
    ...assembly.lanePatches.map((patch) => `<polygon class="junction-lane-patch" data-junction-id="${escapeXml(assembly.junctionId)}" data-road-id="${escapeXml(patch.roadId)}" data-section-id="${escapeXml(patch.sectionId)}" data-lane-id="${patch.laneId}" data-lane-type="${escapeXml(patch.laneType)}"${patch.surfacePatchId ? ` data-surface-patch-id="${escapeXml(patch.surfacePatchId)}"` : ""} points="${pointsAttr(patch.polygon)}" stroke-width="${formatNumber(0.08 * strokeScale)}"/>`)
  ].join("");
}
function physicalJunctionLaneTypes(topology) {
  const laneTypeByBandId = new Map(topology.corridors.flatMap((corridor) => corridor.sections.flatMap((section) => section.bands.map((band) => [band.id, band.laneType]))));
  return new Map(topology.junctions.map((junction) => {
    if (junction.junctionKind === "crossing")
      return [junction.junctionId, []];
    const bandIds = [
      ...junction.movements.flatMap((movement) => movement.connectorBandIds),
      ...junction.laneContinuations.flatMap((continuation) => continuation.connectorBandIds),
      ...junction.directLaneLinks.flatMap((link) => [link.from.bandId, link.to.bandId])
    ];
    return [
      junction.junctionId,
      [...new Set(bandIds.map((bandId) => laneTypeByBandId.get(bandId)).filter((laneType) => laneType !== undefined))]
    ];
  }));
}
function renderJunctionPortal(portal, strokeScale) {
  const attrs = `data-junction-id="${escapeXml(portal.junctionId)}" data-road-id="${escapeXml(portal.roadId)}" data-portal-index="${portal.index}" data-lane-ids="${escapeXml(portal.laneIds.join(","))}"`;
  return [
    `<path class="portal" ${attrs} d="${pathD(portal.cutLine)}" stroke-width="${formatNumber(0.22 * strokeScale)}"/>`,
    `<circle class="portal-point" ${attrs} cx="${formatNumber(portal.center.x)}" cy="${formatNumber(portal.center.y)}" r="${formatNumber(0.28 * strokeScale)}"/>`
  ].join("");
}
function surfacePathD(patch) {
  return [patch.outer, ...patch.holes].map((ring) => `${pathD(ring)} Z`).join(" ");
}
function assemblyPathD(assembly) {
  return polygonComponentsPathD(assembly.components);
}
function polygonComponentsPathD(components) {
  const rings = components.flatMap((component) => [component.outer, ...component.holes]);
  return rings.map((ring) => `${pathD(ring)} Z`).join(" ");
}
function assemblyPartPathD(part) {
  return [part.polygon, ...part.holes.map((hole) => hole.polygon)].map((ring) => `${pathD(ring)} Z`).join(" ");
}
function cutoutAttrs(item) {
  return item.cutoutJunctionIds.length > 0 ? ` data-cutout-junction-ids="${escapeXml(item.cutoutJunctionIds.join(","))}"` : "";
}
function computeBounds(points, padding) {
  if (points.length === 0)
    return { minX: -padding, minY: -padding, width: padding * 2, height: padding * 2 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - padding;
  const maxX = Math.max(...xs) + padding;
  const minY = Math.min(...ys) - padding;
  const maxY = Math.max(...ys) + padding;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}
function sampleMarking(road, startS, endS, tOffset, step) {
  const count = Math.max(1, Math.ceil((endS - startS) / step));
  const points = [];
  for (let i = 0;i <= count; i++) {
    points.push(stToWorld(road.referenceLine, startS + (endS - startS) * i / count, tOffset));
  }
  return points;
}
function markingBands(marking) {
  const tStart = marking.tStart ?? marking.tOffset - (marking.width ?? 0) / 2;
  const tEnd = marking.tEnd ?? marking.tOffset + (marking.width ?? 0) / 2;
  const start = orderedBand(tStart, tEnd);
  return {
    start,
    end: orderedBand(marking.tStartAtEnd ?? start.tStart, marking.tEndAtEnd ?? start.tEnd)
  };
}
function orderedBand(tStart, tEnd) {
  return tStart <= tEnd ? { tStart, tEnd } : { tStart: tEnd, tEnd: tStart };
}
function bandAt(marking, s) {
  const bands = markingBands(marking);
  if (marking.sEnd <= marking.sStart + 0.0000001)
    return bands.start;
  const ratio = Math.max(0, Math.min(1, (s - marking.sStart) / (marking.sEnd - marking.sStart)));
  return {
    tStart: interpolate4(bands.start.tStart, bands.end.tStart, ratio),
    tEnd: interpolate4(bands.start.tEnd, bands.end.tEnd, ratio)
  };
}
function interpolate4(start, end, ratio) {
  return start + (end - start) * ratio;
}
function renderRoadMarking(road, marking, step, strokeScale) {
  const color = markingColor(marking.color);
  const dataAttrs = `data-road-id="${escapeXml(road.id)}" data-marking-id="${escapeXml(marking.id)}" data-marking-kind="${escapeXml(marking.kind)}" data-marking-color="${escapeXml(marking.color ?? "white")}"`;
  const strokeAttrs = `${dataAttrs} style="--marking-color:${color};stroke:${color}"`;
  const fillAttrs = `${dataAttrs} style="--marking-color:${color};fill:${color};stroke:none"`;
  const lateralLine = (s) => {
    const band = bandAt(marking, s);
    return pathD([stToWorld(road.referenceLine, s, band.tStart), stToWorld(road.referenceLine, s, band.tEnd)]);
  };
  if (marking.kind === "zebra" || marking.kind === "crosswalk") {
    const parts = [];
    const stripe = 0.5;
    for (let s = marking.sStart;s < marking.sEnd - 0.000001; s += stripe * 2) {
      const sEnd = Math.min(s + stripe, marking.sEnd);
      const startBand = bandAt(marking, s);
      const endBand = bandAt(marking, sEnd);
      const polygon = [
        stToWorld(road.referenceLine, s, startBand.tStart),
        stToWorld(road.referenceLine, sEnd, endBand.tStart),
        stToWorld(road.referenceLine, sEnd, endBand.tEnd),
        stToWorld(road.referenceLine, s, startBand.tEnd)
      ];
      parts.push(`<polygon class="marking-fill" ${fillAttrs} points="${pointsAttr(polygon)}"/>`);
    }
    return parts;
  }
  if (marking.kind === "crossing" || marking.kind === "cycle-crossing") {
    return [marking.sStart, marking.sEnd].map((s) => `<path class="marking" ${strokeAttrs} d="${lateralLine(s)}" stroke-width="${formatNumber((marking.width ?? 0.25) * strokeScale)}" stroke-dasharray="0.5 0.5"/>`);
  }
  if (marking.kind === "stop-line") {
    return [`<path class="marking" ${strokeAttrs} d="${lateralLine(marking.sStart)}" stroke-width="${formatNumber((marking.width ?? 0.5) * strokeScale)}"/>`];
  }
  if (marking.kind === "yield-line") {
    return [`<path class="marking" ${strokeAttrs} d="${lateralLine(marking.sStart)}" stroke-width="${formatNumber((marking.width ?? 0.5) * strokeScale)}" stroke-dasharray="0.6 0.3"/>`];
  }
  if (marking.kind === "hatched-area") {
    const startBand = bandAt(marking, marking.sStart);
    const endBand = bandAt(marking, marking.sEnd);
    const outline = [
      stToWorld(road.referenceLine, marking.sStart, startBand.tStart),
      stToWorld(road.referenceLine, marking.sEnd, endBand.tStart),
      stToWorld(road.referenceLine, marking.sEnd, endBand.tEnd),
      stToWorld(road.referenceLine, marking.sStart, startBand.tEnd)
    ];
    const parts = [`<polygon class="hatched" ${strokeAttrs} points="${pointsAttr(outline)}" stroke-width="${formatNumber(0.15 * strokeScale)}"/>`];
    for (let s = marking.sStart;s + 1.5 <= marking.sEnd + 0.000001; s += 2) {
      const fromBand = bandAt(marking, s);
      const toBand = bandAt(marking, s + 1.5);
      parts.push(`<path class="hatched" ${strokeAttrs} d="${pathD([stToWorld(road.referenceLine, s, fromBand.tStart), stToWorld(road.referenceLine, s + 1.5, toBand.tEnd)])}" stroke-width="${formatNumber(0.12 * strokeScale)}"/>`);
    }
    return parts;
  }
  if (marking.kind === "arrow") {
    return renderArrowMarking(road, marking, strokeScale, strokeAttrs, fillAttrs);
  }
  const points = sampleMarking(road, marking.sStart, marking.sEnd, marking.tOffset, step);
  return [`<path class="marking" ${strokeAttrs} d="${pathD(points)}" stroke-width="${formatNumber((marking.width ?? 0.15) * strokeScale)}"${laneMarkingDash(marking.kind)}/>`];
}
function laneMarkingDash(kind) {
  if (kind === "guide")
    return ' stroke-dasharray="0.5 0.5"';
  if (kind === "broken")
    return ' stroke-dasharray="3 3"';
  return "";
}
function markingColor(color) {
  if (color === "yellow")
    return "#facc15";
  if (color === "blue")
    return "#3b82f6";
  if (color === "red")
    return "#ef4444";
  if (color === "none")
    return "transparent";
  return "#fff";
}
var ARROW_SHAPES = {
  straight: { lines: [[[0, 0], [3, 0]]], triangles: [[[3, 0.4], [3, -0.4], [4.2, 0]]] },
  left: { lines: [[[0, 0], [2.2, 0]], [[2.2, 0], [2.2, 1]]], triangles: [[[1.8, 1], [2.6, 1], [2.2, 2]]] },
  right: { lines: [[[0, 0], [2.2, 0]], [[2.2, 0], [2.2, -1]]], triangles: [[[1.8, -1], [2.6, -1], [2.2, -2]]] },
  "straight-left": {
    lines: [[[0, 0], [3, 0]], [[1.6, 0], [1.6, 0.9]]],
    triangles: [[[3, 0.4], [3, -0.4], [4.2, 0]], [[1.25, 0.9], [1.95, 0.9], [1.6, 1.8]]]
  },
  "straight-right": {
    lines: [[[0, 0], [3, 0]], [[1.6, 0], [1.6, -0.9]]],
    triangles: [[[3, 0.4], [3, -0.4], [4.2, 0]], [[1.25, -0.9], [1.95, -0.9], [1.6, -1.8]]]
  },
  "left-right": {
    lines: [[[0, 0], [2.2, 0]], [[2.2, 0], [2.2, 0.9]], [[2.2, 0], [2.2, -0.9]]],
    triangles: [[[1.85, 0.9], [2.55, 0.9], [2.2, 1.8]], [[1.85, -0.9], [2.55, -0.9], [2.2, -1.8]]]
  },
  "straight-left-right": {
    lines: [[[0, 0], [3, 0]], [[1.6, 0], [1.6, 0.9]], [[1.6, 0], [1.6, -0.9]]],
    triangles: [
      [[3, 0.4], [3, -0.4], [4.2, 0]],
      [[1.25, 0.9], [1.95, 0.9], [1.6, 1.8]],
      [[1.25, -0.9], [1.95, -0.9], [1.6, -1.8]]
    ]
  },
  "merge-left": { lines: [[[0, 0], [2.8, 0.9]]], triangles: [[[2.45, 1.15], [2.75, 0.4], [3.8, 1.25]]] },
  "merge-right": { lines: [[[0, 0], [2.8, -0.9]]], triangles: [[[2.45, -1.15], [2.75, -0.4], [3.8, -1.25]]] }
};
function renderArrowMarking(road, marking, strokeScale, strokeAttrs, fillAttrs) {
  const shape = ARROW_SHAPES[marking.arrow ?? "straight"] ?? ARROW_SHAPES.straight;
  const travelSign = marking.direction === "backward" ? -1 : 1;
  const toWorld = (du, dn) => stToWorld(road.referenceLine, marking.sStart + du * travelSign, marking.tOffset + dn * travelSign);
  const parts = [];
  for (const [[u0, n0], [u1, n1]] of shape.lines) {
    parts.push(`<path class="marking" ${strokeAttrs} data-arrow="${escapeXml(marking.arrow ?? "straight")}" d="${pathD([toWorld(u0, n0), toWorld(u1, n1)])}" stroke-width="${formatNumber(0.25 * strokeScale)}"/>`);
  }
  for (const triangle of shape.triangles) {
    parts.push(`<polygon class="marking-fill" ${fillAttrs} data-arrow="${escapeXml(marking.arrow ?? "straight")}" points="${pointsAttr(triangle.map(([du, dn]) => toWorld(du, dn)))}"/>`);
  }
  return parts;
}
function renderRoadObject(road, object, strokeScale) {
  if (object.kind === "parking-space") {
    return parkingStallPolygons(road, object).map((stall, index) => `<polygon class="parking-bay" data-road-id="${escapeXml(road.id)}" data-object-id="${escapeXml(object.id)}" data-orientation="${escapeXml(object.orientation ?? "parallel")}" data-stall="${index}" points="${pointsAttr(stall)}" stroke-width="${formatNumber(0.12 * strokeScale)}"/>`);
  }
  if (object.kind === "bollard") {
    const count = object.repeat?.count ?? 1;
    const spacing = object.repeat?.spacing ?? 1;
    const parts = [];
    for (let i = 0;i < count; i++) {
      const point = stToWorld(road.referenceLine, object.s + i * spacing, object.repeat?.lateralOffsets?.[i] ?? object.t);
      parts.push(`<circle class="bollard" data-road-id="${escapeXml(road.id)}" data-object-id="${escapeXml(object.id)}" data-object-kind="${object.kind}" cx="${formatNumber(point.x)}" cy="${formatNumber(point.y)}" r="${formatNumber(0.25 * strokeScale)}"/>`);
    }
    return parts;
  }
  if (object.kind === "traffic-light" || object.kind === "traffic-sign") {
    const point = stToWorld(road.referenceLine, object.s, object.t);
    const cssClass = object.kind === "traffic-light" ? "traffic-light" : "traffic-sign";
    return [`<circle class="${cssClass}" data-road-id="${escapeXml(road.id)}" data-object-id="${escapeXml(object.id)}" data-object-kind="${object.kind}" cx="${formatNumber(point.x)}" cy="${formatNumber(point.y)}" r="${formatNumber(0.42 * strokeScale)}" stroke-width="${formatNumber(0.12 * strokeScale)}"/>`];
  }
  if (object.kind === "guard-rail") {
    const polygons = object.polygon ? [object.polygon] : roadObjectFootprintsWorld(road, object);
    return polygons.map((polygon, index) => `<polygon class="guard-rail" data-road-id="${escapeXml(road.id)}" data-object-id="${escapeXml(object.id)}" data-object-kind="${object.kind}" data-instance="${index}" points="${pointsAttr(polygon)}" stroke-width="${formatNumber(0.1 * strokeScale)}"/>`);
  }
  if (object.kind === "driveway") {
    const polygons = object.polygon ? [object.polygon] : roadObjectFootprintsWorld(road, object);
    return polygons.map((polygon, index) => `<polygon class="driveway" data-road-id="${escapeXml(road.id)}" data-object-id="${escapeXml(object.id)}" data-object-kind="${object.kind}" data-instance="${index}" points="${pointsAttr(polygon)}" fill="#d6b98c" fill-opacity=".72" stroke="#8a6a3e" stroke-width="${formatNumber(0.12 * strokeScale)}"/>`);
  }
  if (object.kind === "planter") {
    const polygons = object.polygon ? [object.polygon] : roadObjectFootprintsWorld(road, object);
    return polygons.map((polygon, index) => `<polygon class="planter" data-road-id="${escapeXml(road.id)}" data-object-id="${escapeXml(object.id)}" data-object-kind="${object.kind}" data-instance="${index}" points="${pointsAttr(polygon)}" fill="#86a873" fill-opacity=".82" stroke="#36543a" stroke-width="${formatNumber(0.12 * strokeScale)}"/>`);
  }
  if (object.kind === "custom") {
    const polygons = object.polygon ? [object.polygon] : roadObjectFootprintsWorld(road, object);
    return polygons.map((polygon, index) => `<polygon class="custom-object" data-road-id="${escapeXml(road.id)}" data-object-id="${escapeXml(object.id)}" data-object-kind="${object.kind}" data-instance="${index}" points="${pointsAttr(polygon)}" stroke-width="${formatNumber(0.16 * strokeScale)}"/>`);
  }
  return [];
}
function parkingStallPolygons(road, object) {
  return roadObjectFootprintsWorld(road, object);
}
function objectFootprint2(road, object) {
  return roadObjectFootprintsWorld(road, object)[0];
}
function cutoutSurfacesForRoad(road, junctionSurfaces) {
  if (road.kind === "connector" && road.junctionId)
    return [];
  return junctionSurfacesForRoad(junctionSurfaces, road.id);
}
function roadPathCutouts(road, junctionSurfaces, gradeSeparationDecks) {
  const deckCutouts = gradeSeparationDecks.filter((evidence) => evidence.gradeSeparations.some((relation) => relation.lowerRoad.roadId === road.id)).map((evidence) => ({
    junctionId: evidence.gradeSeparations.map((relation) => relation.id).join(","),
    roadIds: [road.id],
    patches: [],
    components: [],
    polygon: evidence.polygon
  }));
  return [...cutoutSurfacesForRoad(road, junctionSurfaces), ...deckCutouts];
}
function pathD(points) {
  if (points.length === 0)
    return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${formatNumber(point.x)} ${formatNumber(point.y)}`).join(" ");
}
function pointsAttr(points) {
  return points.map((point) => `${formatNumber(point.x)},${formatNumber(point.y)}`).join(" ");
}
function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
// ../three-roads-inspect/packages/core/src/topology/junction-band-corridors.ts
var MOTOR_LANE_TYPES5 = new Set([
  "driving",
  "entry",
  "exit",
  "on-ramp",
  "off-ramp",
  "bus"
]);
function junctionBandCorridors(network) {
  const roads = new Map(network.roads.map((road) => [road.id, road]));
  const corridors = [];
  const usedConnectorIds = new Set;
  for (const junction of network.junctions) {
    for (const connection of junction.connections) {
      if (!connection.sourceLaneContinuationId || usedConnectorIds.has(connection.connectingRoadId))
        continue;
      const connector = roads.get(connection.connectingRoadId);
      if (!connector || connector.kind !== "connector" || connector.junctionId !== junction.id)
        continue;
      const connectorLaneId = connection.laneLinks[0]?.to;
      const connectorLane = connector.laneSections.flatMap((section) => section.lanes).find((lane) => lane.id === connectorLaneId);
      if (!connectorLane?.links?.predecessor || !connectorLane.links.successor)
        continue;
      const first = resolvedBandContact(roads, connectorLane.links.predecessor);
      const second = resolvedBandContact(roads, connectorLane.links.successor);
      if (!first || !second || first.position !== second.position)
        continue;
      usedConnectorIds.add(connector.id);
      corridors.push({
        junctionId: junction.id,
        connectorRoadId: connector.id,
        dominantRoadId: junction.profileTransition?.dominantRoadId,
        position: first.position,
        contacts: [first.contact, second.contact]
      });
    }
  }
  return corridors.sort((left, right) => left.junctionId.localeCompare(right.junctionId) || left.position.localeCompare(right.position) || left.connectorRoadId.localeCompare(right.connectorRoadId));
}
function resolvedBandContact(roads, link) {
  const road = roads.get(link.roadId);
  if (!road)
    return;
  const station = link.s ?? (link.contactPoint === "start" ? 0 : road.length);
  const section = sectionAt6(road, station);
  const lane = section?.lanes.find((candidate) => candidate.id === link.laneId);
  if (!section || !lane)
    return;
  const position = physicalBandPosition2(section, lane);
  return position ? {
    position,
    contact: {
      roadId: road.id,
      station,
      laneId: lane.id,
      laneRole: lane.sourceRole,
      laneType: lane.type,
      side: lane.id > 0 ? "left" : "right"
    }
  } : undefined;
}
function physicalBandPosition2(section, lane) {
  if (lane.type === "median")
    return "inner";
  if (lane.type === "border" || lane.type === "sidewalk")
    return "outer";
  if (lane.type !== "shoulder")
    return;
  const motorOrders = section.lanes.filter((candidate) => MOTOR_LANE_TYPES5.has(candidate.type)).map((candidate) => Math.abs(candidate.id));
  if (motorOrders.length === 0)
    return;
  return Math.abs(lane.id) < Math.min(...motorOrders) ? "inner" : "outer";
}
function sectionAt6(road, station) {
  return [...road.laneSections].sort((left, right) => left.s - right.s).filter((section) => section.s <= station + 0.0000001).at(-1);
}

// ../three-roads-inspect/packages/core/src/topology/profile-transition-corridors.ts
function profileTransitionCorridors(network) {
  return junctionBandCorridors(network).flatMap((corridor) => {
    const { dominantRoadId, contacts } = corridor;
    if (!dominantRoadId)
      return [];
    return [{
      junctionId: corridor.junctionId,
      connectorRoadId: corridor.connectorRoadId,
      dominantRoadId,
      position: corridor.position,
      sourceRoadIds: [contacts[0].roadId, contacts[1].roadId],
      sourceLaneTypes: [contacts[0].laneType, contacts[1].laneType]
    }];
  });
}
export {
  validateRoadAuthoringDocument,
  tessellateJunctionPhysicalTopology,
  subtractPolygonComponents,
  sampleReferenceLine,
  roadTemplatesHaveCompatibleLaneRoles,
  roadSuperelevationAt,
  roadObjectFootprintsST,
  roadLateralExtentAt,
  resolveAutomaticNetwork,
  renderRoadNetworkSvg,
  profileTransitionCorridors,
  pointInPolygon,
  makeLineSegment,
  lanesHaveVerticalSeparation,
  laneWidthAt,
  laneSurfacePointAt,
  laneSectionEndS,
  laneOffsetsAt,
  laneHeightAt,
  laneHasVerticalEdge,
  laneCenterOffsetAt,
  laneBoundarySurfacePointAt,
  laneBoundaryOffsetAt,
  intersectPolygons,
  gradeAt,
  germanRoadPresets,
  germanRoadPreset,
  findLaneSection,
  evaluateRoadReference,
  evaluateReferenceLine,
  createRoadAuthoringDocument,
  compileRoadNetwork,
  addRoadTemplate,
  addRoadStroke,
  addJunctionIntent
};
