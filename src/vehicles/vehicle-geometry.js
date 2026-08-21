// Vehicle geometry - a parametric body builder that survives a 3 m close-up.
//
// Owner: Rendering / vehicle presentation.
//
// HOW A BODY IS BUILT
//
// A vehicle is a *loft*: a chain of cross-sections swept along +Z. Each control
// station in `spec.profile` carries `{ z, sill, top, half }` in metres, and the
// cross-section at that station is a superellipse spanning `sill..top` and
// `-half..+half`. Because the section is a superellipse and not a rectangle,
// the flank, the shoulder and the roof rail each catch their own highlight -
// which is the whole difference between "a car" and "a box".
//
// Three things fall out of that for free:
//
//   * WHEEL ARCHES. `sill` is raised locally around each axle by a circular
//     arch of radius `wheelRadius * 1.35`, so the silhouette has a real arch
//     opening and the underbody between the axles is a tunnel, not a slab.
//     The loft stays a closed manifold, so it shadows correctly.
//   * A RAKED GREENHOUSE. The glasshouse is a second loft whose top drops to
//     the belt line at the cowl and at the rear deck. Interpolating between
//     the cowl and the roof header IS the windscreen rake - no special case.
//   * GLAZING THAT FOLLOWS THE BODY. Because the greenhouse section is an
//     analytic superellipse, the window panes can be projected onto it exactly
//     (`greenhouseXAt`), so glass follows the tumblehome instead of floating.
//
// Everything else - bumper valances, rocker panels, grille, mirrors, wipers,
// door shut lines, handles, exhaust, roof rails, bed walls, panel ribs, light
// bars, roof signs - is added as small parts in the same buffers.
//
// MATERIAL GROUPS. A built vehicle returns at most three geometries:
//   `paint` clear-coat body panels, tinted per instance by instanceColor;
//   `glass` inset window panes;
//   `trim`  everything chrome, black-plastic, rubber or interior, with its
//           colour baked absolutely so an instance tint cannot touch it.
// Wheels, lamps and plates are returned as PLACEMENT RECORDS, not geometry:
// they are drawn from one shared instanced mesh each for the whole city, which
// is what keeps the draw-call count flat as the vehicle count grows.
//
// Determinism: pure functions of the spec and the level of detail. No RNG.

import * as THREE from 'three';

export const VEHICLE_GEOMETRY_VERSION = 'vehicle-geometry-v1';

/** Level-of-detail table. `lod` is an index into this array. */
export const VEHICLE_LOD_CONFIG = Object.freeze([
  Object.freeze({
    lod: 0, profilePoints: 12, roofPoints: 9, archSamples: 5, maxStationGap: 0.80,
    glass: true, details: 'full', instancedWheels: true, bakedWheels: false,
    instancedLamps: true, plates: true,
  }),
  // ROUND 3 CHANGE. `glass: false` did NOT remove the glazing at this tier -
  // `buildVehicleGeometry` still emits every pane, into the TRIM buffer, where
  // it is drawn with the opaque dark trim material. A mid-ring car therefore
  // had windows the exact colour of its bumper rubber and read as a solid
  // capsule. Giving the tier its own glass buffer moves those same triangles
  // to the glass material - a dielectric with real Fresnel - and costs one
  // extra instanced draw call per vehicle class present at this tier, not one
  // per vehicle. The triangle count of the tier is unchanged: the panes move
  // between buffers, they are not added.
  Object.freeze({
    lod: 1, profilePoints: 8, roofPoints: 7, archSamples: 3, maxStationGap: 1.60,
    glass: true, details: 'lite', instancedWheels: false, bakedWheels: 'cylinder',
    instancedLamps: false, plates: false,
  }),
  Object.freeze({
    lod: 2, profilePoints: 8, roofPoints: 5, archSamples: 0, maxStationGap: Infinity,
    glass: false, details: 'none', instancedWheels: false, bakedWheels: 'box',
    instancedLamps: false, plates: false,
  }),
]);

// Superellipse exponents. Higher is boxier.
const P_BODY_UPPER = 4.6;
const P_BODY_LOWER = 7.0;
const P_ROOF = 4.0;

// Wheel arch, metres / ratios.
const ARCH_GAP = 0.055;          // suspension gap above the tyre
const ARCH_HEADROOM = 0.10;      // body left above the arch crown
const ARCH_LENGTH_FACTOR = 1.55; // arch half-length as a multiple of the wheel radius

/**
 * How far a window pane stands PROUD of the body surface, metres.
 *
 * The first cut of this builder inset the panes 14-16 mm INTO the shell, on the
 * reasoning that a window is a recess. The shell is opaque, so every pane was
 * either buried or z-fighting a chord of the polygonal section, and the whole
 * catalogue rendered with no glass at all. A pane must be outside the surface,
 * and by more than the sagitta of one facet: a 9-point half section at a 0.8 m
 * radius cuts up to 15 mm inside the analytic curve it samples.
 */
const GLASS_PROUD = 0.034;

/**
 * Stand-off for a flat panel on a flat end face (transit coach front and rear,
 * van rear doors). A flat quad on a flat face has no chord error to clear, so
 * it uses a smaller offset and stays inside the declared overall length.
 */
const END_GLASS_PROUD = 0.018;

// Vertex-colour multipliers applied to the *paint* buffer. The instance tint is
// the paint colour, so these read as the same paint in shadow or in gloss.
// Vertex-colour multipliers on the paint buffer. `under` and `archInner` used
// to be 0.10 / 0.07: with no environment light reaching the underbody that read
// as a hole under the car rather than as a shaded inner fender, and the whole
// catalogue looked like it was standing on stilts.
const PAINT_SHADE = Object.freeze({
  body: 1.0,
  under: 0.30,
  archInner: 0.18,
  lowerBand: 0.82,
});

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex -> linear RGB triple, matching the repo's vertex-colour convention. */
export function hexToLinear(hex) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

// ---------------------------------------------------------------------------
// buffers
// ---------------------------------------------------------------------------

function makeBuffer() {
  return { position: [], color: [], index: [], count: 0 };
}

function vertex(buf, x, y, z, rgb) {
  buf.position.push(x, y, z);
  buf.color.push(rgb[0], rgb[1], rgb[2]);
  return buf.count++;
}

/** Push a triangle oriented so its normal points away from `ref`. */
function triangle(buf, a, b, c, ref) {
  const p = buf.position;
  const ax = p[a * 3]; const ay = p[a * 3 + 1]; const az = p[a * 3 + 2];
  const bx = p[b * 3]; const by = p[b * 3 + 1]; const bz = p[b * 3 + 2];
  const cx = p[c * 3]; const cy = p[c * 3 + 1]; const cz = p[c * 3 + 2];
  const ux = bx - ax; const uy = by - ay; const uz = bz - az;
  const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  if (!(Math.abs(nx) + Math.abs(ny) + Math.abs(nz) > 1e-12)) return;
  if (ref) {
    const mx = (ax + bx + cx) / 3 - ref[0];
    const my = (ay + by + cy) / 3 - ref[1];
    const mz = (az + bz + cz) / 3 - ref[2];
    if (nx * mx + ny * my + nz * mz < 0) { buf.index.push(a, c, b); return; }
  }
  buf.index.push(a, b, c);
}

function bufferTriangles(buf) { return buf.index.length / 3; }

function toGeometry(buf, name) {
  if (!buf || buf.index.length < 3) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buf.position, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(buf.color, 3));
  geometry.setIndex(buf.index);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = name;
  return geometry;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** Closed superellipse section. `ux` in [-1,1], `uy` in [0,1]. */
function closedSection(points, pUpper, pLower) {
  const out = [];
  for (let i = 0; i < points; i += 1) {
    const th = (i / points) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const p = s >= 0 ? pUpper : pLower;
    const e = 2 / p;
    const ux = Math.sign(c) * Math.abs(c) ** e;
    const uy = 0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** e;
    out.push([ux, uy]);
  }
  return out;
}

/** Arc section closed by a flat bottom: `uy` 0 at the ends, 1 at the crown. */
function archSection(points, p) {
  const out = [];
  const n = Math.max(3, points | 1);
  for (let i = 0; i < n; i += 1) {
    const th = (i / (n - 1)) * Math.PI;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const e = 2 / p;
    out.push([Math.sign(c) * Math.abs(c) ** e, Math.abs(s) ** e]);
  }
  return out;
}

/**
 * Loft a section along a chain of rings.
 * `rings` is `[{ z, half, bottom, top }]`; the section is scaled into each.
 */
function addLoft(buf, rings, section, colorAt, { caps = true } = {}) {
  if (rings.length < 2) return;
  const n = section.length;
  const ringIndex = [];
  const centres = [];
  for (const ring of rings) {
    const height = Math.max(1e-4, ring.top - ring.bottom);
    const row = [];
    for (let i = 0; i < n; i += 1) {
      const [ux, uy] = section[i];
      const x = ux * ring.half;
      const y = ring.bottom + uy * height;
      row.push(vertex(buf, x, y, ring.z, colorAt(ux, uy, ring.z, y)));
    }
    ringIndex.push(row);
    centres.push([0, ring.bottom + height * 0.5, ring.z]);
  }
  for (let r = 0; r < rings.length - 1; r += 1) {
    const a = ringIndex[r];
    const b = ringIndex[r + 1];
    const ref = [
      0,
      (centres[r][1] + centres[r + 1][1]) * 0.5,
      (centres[r][2] + centres[r + 1][2]) * 0.5,
    ];
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      triangle(buf, a[i], b[i], b[j], ref);
      triangle(buf, a[i], b[j], a[j], ref);
    }
  }
  if (!caps) return;
  for (const end of [0, rings.length - 1]) {
    const row = ringIndex[end];
    const ring = rings[end];
    const height = Math.max(1e-4, ring.top - ring.bottom);
    const centre = vertex(buf, 0, ring.bottom + height * 0.5, ring.z, colorAt(0, 0.5, ring.z, ring.bottom + height * 0.5));
    const neighbour = centres[end === 0 ? 1 : rings.length - 2];
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      triangle(buf, centre, row[i], row[j], neighbour);
    }
  }
}

/** Axis-aligned box, optionally yawed about Y around its own centre. */
function addBox(buf, cx, cy, cz, sx, sy, sz, rgb, yaw = 0) {
  const hx = sx / 2; const hy = sy / 2; const hz = sz / 2;
  const cs = Math.cos(yaw); const sn = Math.sin(yaw);
  const idx = [];
  for (const sxs of [-1, 1]) {
    for (const sys of [-1, 1]) {
      for (const szs of [-1, 1]) {
        const lx = sxs * hx;
        const lz = szs * hz;
        idx.push(vertex(buf, cx + lx * cs + lz * sn, cy + sys * hy, cz - lx * sn + lz * cs, rgb));
      }
    }
  }
  // index bits: x(4) y(2) z(1)
  const at = (x, y, z) => idx[(x << 2) | (y << 1) | z];
  const ref = [cx, cy, cz];
  const quad = (a, b, c, d) => { triangle(buf, a, b, c, ref); triangle(buf, a, c, d, ref); };
  quad(at(0, 0, 0), at(0, 0, 1), at(0, 1, 1), at(0, 1, 0));
  quad(at(1, 0, 0), at(1, 0, 1), at(1, 1, 1), at(1, 1, 0));
  quad(at(0, 0, 0), at(1, 0, 0), at(1, 0, 1), at(0, 0, 1));
  quad(at(0, 1, 0), at(1, 1, 0), at(1, 1, 1), at(0, 1, 1));
  quad(at(0, 0, 0), at(1, 0, 0), at(1, 1, 0), at(0, 1, 0));
  quad(at(0, 0, 1), at(1, 0, 1), at(1, 1, 1), at(0, 1, 1));
}

/** A flat quad from four world points, normal pointing away from `ref`. */
function addQuad(buf, p0, p1, p2, p3, rgb, ref) {
  const a = vertex(buf, p0[0], p0[1], p0[2], rgb);
  const b = vertex(buf, p1[0], p1[1], p1[2], rgb);
  const c = vertex(buf, p2[0], p2[1], p2[2], rgb);
  const d = vertex(buf, p3[0], p3[1], p3[2], rgb);
  triangle(buf, a, b, c, ref);
  triangle(buf, a, c, d, ref);
}

/** Cylinder about the Y axis. */
function addCylinderY(buf, cx, cy, cz, radius, height, sides, rgb) {
  const ref = [cx, cy, cz];
  const top = [];
  const bottom = [];
  for (let i = 0; i < sides; i += 1) {
    const th = (i / sides) * Math.PI * 2;
    const x = cx + Math.cos(th) * radius;
    const z = cz + Math.sin(th) * radius;
    top.push(vertex(buf, x, cy + height / 2, z, rgb));
    bottom.push(vertex(buf, x, cy - height / 2, z, rgb));
  }
  const topC = vertex(buf, cx, cy + height / 2, cz, rgb);
  const bottomC = vertex(buf, cx, cy - height / 2, cz, rgb);
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    triangle(buf, bottom[i], top[i], top[j], ref);
    triangle(buf, bottom[i], top[j], bottom[j], ref);
    triangle(buf, topC, top[i], top[j], [cx, cy, cz]);
    triangle(buf, bottomC, bottom[i], bottom[j], [cx, cy, cz]);
  }
}

// ---------------------------------------------------------------------------
// spec sampling
// ---------------------------------------------------------------------------

function sampleStations(stations, z, key) {
  if (!stations.length) return 0;
  if (z <= stations[0].z) return stations[0][key];
  const last = stations[stations.length - 1];
  if (z >= last.z) return last[key];
  for (let i = 0; i < stations.length - 1; i += 1) {
    const a = stations[i];
    const b = stations[i + 1];
    if (z >= a.z && z <= b.z) {
      const span = b.z - a.z;
      const t = span > 1e-9 ? (z - a.z) / span : 0;
      return lerp(a[key], b[key], t);
    }
  }
  return last[key];
}

/**
 * Sample the arch-cut sill. `archTop` is the crown of the wheel opening, set
 * from the wheel that is actually fitted so a bigger tyre always gets a bigger
 * arch. The crown is clamped below the body top so the section never inverts.
 */
export function bodySillAt(spec, z) {
  return sillAt(spec, z);
}

/** Half-width of the body section at `(z, y)`. Exported for the verifier. */
export function bodyHalfWidthAt(spec, z, y) {
  return bodyXAt(spec, z, y);
}

function sillAt(spec, z) {
  const base = sampleStations(spec.profile, z, 'sill');
  const top = sampleStations(spec.profile, z, 'top');
  // The arch opening has to clear the TOP of the tyre, not its centre: a crown
  // at the hub height would bury half the wheel in the flank, which is exactly
  // the slab look this pass exists to remove. `crown` is one tyre diameter plus
  // a suspension gap, and the opening is about 1.5 wheel radii each side of the
  // axle, which is the proportion a real wheel arch has.
  const crown = Math.min(2 * spec.wheelRadius + ARCH_GAP, top - ARCH_HEADROOM);
  const archLen = spec.wheelRadius * ARCH_LENGTH_FACTOR;
  let sill = base;
  for (const axleZ of [spec.frontAxleZ, spec.rearAxleZ]) {
    const dz = (z - axleZ) / archLen;
    if (Math.abs(dz) >= 1) continue;
    const arch = base + (crown - base) * Math.sqrt(Math.max(0, 1 - dz * dz));
    if (arch > sill) sill = arch;
  }
  return Math.min(sill, top - ARCH_HEADROOM);
}

/** Analytic half-width of the greenhouse section at height `y`. */
function greenhouseXAt(spec, z, y) {
  const bottom = sampleStations(spec.profile, z, 'top');
  const top = sampleStations(spec.roof, z, 'top');
  const half = sampleStations(spec.roof, z, 'half');
  const height = top - bottom;
  if (!(height > 1e-3)) return half;
  const uy = clamp((y - bottom) / height, 0, 1);
  return half * (1 - uy ** P_ROOF) ** (1 / P_ROOF);
}

/**
 * A point ON the greenhouse shell, exactly where the loft puts it.
 *
 * `ux` in [-1, 1] is the normalised lateral parameter of the arch section, so
 * `ux = 0` is the crown and `|ux| = 1` is the belt line. This is the inverse of
 * `greenhouseXAt` and uses the same exponent, so a patch built from it lies on
 * the shell rather than near it.
 */
function greenhousePoint(spec, z, ux) {
  const bottom = sampleStations(spec.profile, z, 'top') - 0.03;
  const top = Math.min(spec.height, Math.max(bottom + 0.004, sampleStations(spec.roof, z, 'top')));
  const half = sampleStations(spec.roof, z, 'half');
  const a = Math.min(1, Math.abs(ux));
  const uy = (1 - a ** P_ROOF) ** (1 / P_ROOF);
  return [ux * half, bottom + uy * (top - bottom), z];
}

/**
 * Emit a glazed patch that lies on the greenhouse shell and is pushed out along
 * the shell's own normal. Used for the windscreen and the backlight, where the
 * shell curves in BOTH directions and a flat quad sinks into it: on a compact
 * hatchback the roof profile between the cowl and the header bulges 70 mm above
 * the straight chord, which buried the whole screen.
 */
function addShellPatch(buf, spec, z0, z1, uxSpan, rgb, zSteps = 3, uSteps = 4) {
  const pt = (t, u) => greenhousePoint(spec, z0 + (z1 - z0) * t, -uxSpan + 2 * uxSpan * u);
  // Push each vertex RADIALLY out of its own cross-section, from the section's
  // bottom-centre. Every section here is star-shaped about that point, so a
  // radial displacement is guaranteed to leave the shell - which a surface
  // normal estimated by finite differences is not, at the edges of a patch.
  const push = (t, u) => {
    const z = z0 + (z1 - z0) * t;
    const p = pt(t, u);
    const bottom = sampleStations(spec.profile, z, 'top') - 0.03;
    const dx = p[0];
    const dy = p[1] - bottom;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return p;
    return [p[0] + (dx / len) * GLASS_PROUD, p[1] + (dy / len) * GLASS_PROUD, p[2]];
  };
  for (let i = 0; i < zSteps; i += 1) {
    for (let j = 0; j < uSteps; j += 1) {
      const ta = i / zSteps;
      const tb = (i + 1) / zSteps;
      const ua = j / uSteps;
      const ub = (j + 1) / uSteps;
      addQuad(buf, push(ta, ua), push(ta, ub), push(tb, ub), push(tb, ua), rgb,
        [0, greenhousePoint(spec, z0, 0)[1] - 2, (z0 + z1) / 2]);
    }
  }
}

/** Analytic half-width of the body section at height `y`. */
function bodyXAt(spec, z, y) {
  const bottom = sillAt(spec, z);
  const top = sampleStations(spec.profile, z, 'top');
  const half = sampleStations(spec.profile, z, 'half');
  const mid = (bottom + top) / 2;
  const halfHeight = Math.max(1e-4, (top - bottom) / 2);
  const uy = clamp(Math.abs(y - mid) / halfHeight, 0, 1);
  const p = y >= mid ? P_BODY_UPPER : P_BODY_LOWER;
  return half * (1 - uy ** p) ** (1 / p);
}

/** The z stations the loft is actually swept on, for a level of detail. */
function loftStations(spec, config) {
  const zs = new Set();
  for (const s of spec.profile) zs.add(Number(s.z.toFixed(4)));
  if (config.archSamples > 0) {
    const archLen = spec.wheelRadius * ARCH_LENGTH_FACTOR;
    for (const axleZ of [spec.frontAxleZ, spec.rearAxleZ]) {
      for (let i = 0; i < config.archSamples; i += 1) {
        const t = -1 + (2 * i) / (config.archSamples - 1);
        zs.add(Number((axleZ + t * archLen * 0.985).toFixed(4)));
      }
    }
  }
  let list = [...zs].sort((a, b) => a - b);
  if (Number.isFinite(config.maxStationGap)) {
    const filled = [];
    for (let i = 0; i < list.length; i += 1) {
      filled.push(list[i]);
      if (i === list.length - 1) break;
      const gap = list[i + 1] - list[i];
      const steps = Math.floor(gap / config.maxStationGap);
      for (let k = 1; k <= steps; k += 1) filled.push(list[i] + (gap * k) / (steps + 1));
    }
    list = filled;
  } else {
    // Far level of detail: decimate to the load-bearing stations only.
    const keep = [];
    for (let i = 0; i < list.length; i += 1) {
      if (i === 0 || i === list.length - 1 || i % 2 === 0) keep.push(list[i]);
    }
    list = keep;
  }
  const out = [];
  for (const z of list) {
    if (!Number.isFinite(z)) continue;
    if (out.length && z - out[out.length - 1] < 0.015) continue;
    out.push(z);
  }
  return out;
}

// ---------------------------------------------------------------------------
// detail parts
// ---------------------------------------------------------------------------

/**
 * Emit one window pane as a strip that FOLLOWS the shell it sits on.
 *
 * A pane cannot be a single flat quad. Its corners can be correctly proud of a
 * curved section and its middle still be inside it: on a sedan greenhouse the
 * chord between the belt line and the roof rail cuts 23 mm inside the surface,
 * which is more than the stand-off, so the pane's interior disappeared into the
 * bodywork while its edges did not. Subdividing into rows drops that sagitta by
 * the square of the row count.
 *
 * `halfAt(z, y)` returns the shell's half-width at that point.
 */
function addSurfacePane(buf, spec, z0, z1, y0, y1, rgb, halfAt, rows = 3) {
  if (!(y1 - y0 > 0.05) || !(Math.abs(z1 - z0) > 0.05)) return 0;
  let emitted = 0;
  for (const side of [1, -1]) {
    for (let r = 0; r < rows; r += 1) {
      const ya = y0 + ((y1 - y0) * r) / rows;
      const yb = y0 + ((y1 - y0) * (r + 1)) / rows;
      const p = (z, y) => [side * Math.max(0.02, halfAt(z, y) + GLASS_PROUD), y, z];
      addQuad(buf, p(z0, ya), p(z1, ya), p(z1, yb), p(z0, yb), rgb, [side * 0.001, (ya + yb) / 2, (z0 + z1) / 2]);
      emitted += 2;
    }
  }
  return emitted;
}

/** The roof station index that carries the roof crown nearest one end. */
function headerStation(spec, rear) {
  let maxTop = -Infinity;
  for (const s of spec.roof) maxTop = Math.max(maxTop, s.top);
  const threshold = maxTop - 0.06;
  if (rear) {
    for (let i = 0; i < spec.roof.length; i += 1) if (spec.roof[i].top >= threshold) return spec.roof[i];
    return spec.roof[0];
  }
  for (let i = spec.roof.length - 1; i >= 0; i -= 1) if (spec.roof[i].top >= threshold) return spec.roof[i];
  return spec.roof[spec.roof.length - 1];
}

function addWindscreen(buf, spec, rgb, rear, rows = 3) {
  const cowl = rear ? spec.roof[0] : spec.roof[spec.roof.length - 1];
  const header = headerStation(spec, rear);
  if (Math.abs(header.z - cowl.z) < 0.12) return;
  const bodyTop = sampleStations(spec.profile, cowl.z, 'top');
  if (!(header.top - bodyTop > 0.12)) return;
  // Start where the glasshouse actually HAS a glasshouse. Near the cowl (or a
  // hatchback's tailgate) the greenhouse section collapses onto the body top,
  // and a pane placed there is a pane lying on the boot lid: on the estate the
  // whole rear screen was hidden under the tail deck.
  const minRise = 0.14;
  let z0 = cowl.z;
  for (let i = 1; i <= 12; i += 1) {
    const t = i / 12;
    const z = cowl.z + (header.z - cowl.z) * t;
    const rise = sampleStations(spec.roof, z, 'top') - sampleStations(spec.profile, z, 'top');
    if (rise >= minRise) { z0 = z; break; }
    z0 = z;
  }
  const z1 = cowl.z + (header.z - cowl.z) * 0.94;
  if (!(Math.abs(z1 - z0) > 0.10)) return;
  addShellPatch(buf, spec, z0, z1, 0.80, rgb, rows, rows + 1);
}

/** A flat glazed panel on the front or rear face of a one-box body. */
function addEndGlass(buf, spec, rgb) {
  for (const panel of spec.features.endGlass || []) {
    const midY = (panel.y0 + panel.y1) / 2;
    const endZ = panel.facing > 0 ? spec.zFront : spec.zRear;
    const z = bodySurfaceZ(spec, endZ, midY) + panel.facing * END_GLASS_PROUD;
    const x = Math.max(0.05, bodyXAt(spec, z, midY) * (panel.halfF ?? 0.9));
    addQuad(
      buf,
      [-x, panel.y0, z], [x, panel.y0, z], [x, panel.y1, z], [-x, panel.y1, z],
      rgb, [0, midY, z - panel.facing * 1.2],
    );
  }
}

function addSidePanes(buf, spec, rgb, rows = 3) {
  // Two glazing models, because a car and a bus do not carry glass in the same
  // place. A car's side windows sit on the GREENHOUSE, above the belt line. A
  // one-box body - transit coach, panel van - carries a window BAND in the body
  // side itself, at absolute heights, so `glazing.bandY` selects that model.
  const band = spec.glazing.bandY;
  for (const [z0, z1] of spec.glazing.sidePanes) {
    if (band) {
      const [y0, y1] = band;
      const topA = sampleStations(spec.profile, z0, 'top');
      const topB = sampleStations(spec.profile, z1, 'top');
      const ceiling = Math.min(topA, topB) - 0.06;
      const yTop = Math.min(y1, ceiling);
      if (!(yTop - y0 > 0.06)) continue;
      addSurfacePane(buf, spec, z0 + 0.03, z1 - 0.03, y0, yTop, rgb,
        (z, y) => bodyXAt(spec, z, y), rows);
      continue;
    }
    // Greenhouse model. The pane must stay under the roof line at BOTH ends,
    // or its forward corner slides past the A-pillar and collapses onto the
    // centreline where the greenhouse section has closed.
    const belt = sampleStations(spec.profile, (z0 + z1) / 2, 'top');
    const roofA = sampleStations(spec.roof, z0, 'top');
    const roofB = sampleStations(spec.roof, z1, 'top');
    const y0 = belt + spec.glazing.paneRise;
    const yTop = Math.min(roofA, roofB) - spec.glazing.paneDrop;
    if (!(yTop - y0 > 0.06)) continue;
    addSurfacePane(buf, spec, z0 + 0.02, z1 - 0.02, y0, yTop, rgb,
      (z, y) => greenhouseXAt(spec, z, y), rows);
  }
}

// ---------------------------------------------------------------------------
// the vehicle builder
// ---------------------------------------------------------------------------

/**
 * Build one catalogue entry at one level of detail.
 *
 * @param {object} spec  a `VEHICLE_SPECS` entry
 * @param {number} lod   index into VEHICLE_LOD_CONFIG
 * @param {object} [palette] absolute trim colours (see catalogue `TRIM`)
 * @returns {{paint, glass, trim, solid, wheels, lamps, plates, bounds, triangles}}
 */
export function buildVehicleGeometry(spec, lod, palette) {
  const config = VEHICLE_LOD_CONFIG[clamp(lod, 0, VEHICLE_LOD_CONFIG.length - 1)];
  const merged = config.lod === 2;
  const paint = makeBuffer();
  const trim = merged ? paint : makeBuffer();
  // Glass earns its own draw call only where the window is more than a few
  // pixels wide. Past the near ring the panes are baked into the trim buffer:
  // same dark inset, one fewer instanced mesh per type.
  const glassBuf = !merged && config.glass ? makeBuffer() : null;
  const glass = glassBuf || trim;
  const T = palette;
  const L = (hex) => hexToLinear(hex);

  const half = spec.width / 2;
  const bodySection = closedSection(config.profilePoints, P_BODY_UPPER, P_BODY_LOWER);
  const roofSection = archSection(config.roofPoints, P_ROOF);
  const livery = spec.features.livery || null;

  // --- body shell ---------------------------------------------------------
  const stations = loftStations(spec, config);
  const bodyRings = stations.map((z) => ({
    z,
    half: sampleStations(spec.profile, z, 'half'),
    bottom: sillAt(spec, z),
    top: sampleStations(spec.profile, z, 'top'),
  }));
  const bodyColour = liveryColourFn(spec, livery, T, L);
  addLoft(paint, bodyRings, bodySection, bodyColour);

  // --- greenhouse ---------------------------------------------------------
  const roofZs = [];
  for (const s of spec.roof) roofZs.push(s.z);
  if (config.lod < 2) {
    for (let i = 0; i < spec.roof.length - 1; i += 1) {
      const gap = spec.roof[i + 1].z - spec.roof[i].z;
      if (gap > config.maxStationGap * 1.4) {
        const steps = Math.floor(gap / (config.maxStationGap * 1.4));
        for (let k = 1; k <= steps; k += 1) roofZs.push(spec.roof[i].z + (gap * k) / (steps + 1));
      }
    }
  }
  roofZs.sort((a, b) => a - b);
  const roofRings = roofZs.map((z) => ({
    z,
    half: sampleStations(spec.roof, z, 'half'),
    bottom: sampleStations(spec.profile, z, 'top') - 0.03,
    top: Math.min(spec.height, Math.max(sampleStations(spec.profile, z, 'top') + 0.004, sampleStations(spec.roof, z, 'top'))),
  }));
  const roofColour = liveryRoofColourFn(spec, livery, T, L);
  if (roofRings.length >= 2) addLoft(paint, roofRings, roofSection, roofColour, { caps: false });

  // --- glazing ------------------------------------------------------------
  // Rows exist to stop a flat pane sinking into a curved shell. At the far
  // level of detail there is no shell curvature worth resolving and the whole
  // vehicle is ten pixels wide, so the glazing is dropped entirely.
  if (config.lod < 2) {
    const paneColour = L(T.glassSeal);
    const rows = config.lod === 0 ? 3 : 1;
    if (spec.glazing.windscreen) addWindscreen(glass, spec, paneColour, false, rows);
    if (spec.glazing.backlight) addWindscreen(glass, spec, paneColour, true, rows);
    addSidePanes(glass, spec, paneColour, rows);
    addEndGlass(glass, spec, paneColour);
  }

  // --- wheels -------------------------------------------------------------
  const wheels = [];
  const axleList = [
    { z: spec.frontAxleZ, track: spec.trackFront, steer: true, dual: false },
    { z: spec.rearAxleZ, track: spec.trackRear, steer: false, dual: spec.dualRear },
  ];
  for (const axle of axleList) {
    for (const side of [1, -1]) {
      if (axle.dual) {
        wheels.push({ x: side * (axle.track / 2 + spec.wheelWidth * 0.52), y: spec.wheelRadius, z: axle.z, radius: spec.wheelRadius, width: spec.wheelWidth, steer: axle.steer, side });
        wheels.push({ x: side * (axle.track / 2 - spec.wheelWidth * 0.52), y: spec.wheelRadius, z: axle.z, radius: spec.wheelRadius, width: spec.wheelWidth, steer: axle.steer, side, inner: true });
      } else {
        wheels.push({ x: side * axle.track / 2, y: spec.wheelRadius, z: axle.z, radius: spec.wheelRadius, width: spec.wheelWidth, steer: axle.steer, side });
      }
    }
  }
  if (config.bakedWheels) {
    // Beyond the near ring a wheel is a few dark triangles under the arch: it
    // must read as round in silhouette, and nothing more.
    const target = config.lod === 2 ? paint : trim;
    for (const wheel of wheels) {
      if (wheel.inner) continue;
      if (config.bakedWheels === 'cylinder') {
        addCylinderX(target, wheel.x, wheel.radius, wheel.width, 8, L(T.rubber), wheel.y, wheel.z);
      } else {
        addBox(target, wheel.x, wheel.y, wheel.z, wheel.width, wheel.radius * 2, wheel.radius * 2, L(T.rubber));
      }
    }
  }

  // --- lamps --------------------------------------------------------------
  const lamps = buildLampPlan(spec);
  if (!config.instancedLamps && config.lod < 2) {
    for (const lamp of lamps) {
      if (lamp.kind === 'brake' || lamp.kind === 'indicator') continue;
      const hex = lamp.kind === 'tail' ? T.lensRed : T.lensClear;
      addBox(trim, lamp.x, lamp.y, lamp.z, lamp.w, lamp.h, lamp.d, L(hex));
    }
  }

  // --- plates -------------------------------------------------------------
  const plates = buildPlatePlan(spec);
  if (!config.plates && config.lod < 2) {
    for (const plate of plates) addBox(trim, plate.x, plate.y, plate.z, plate.w, plate.h, 0.014, L(T.plateWhite));
  }

  // --- everything that makes it a vehicle rather than a shape -------------
  if (config.details !== 'none') {
    addBumpersAndRockers(trim, spec, T, L, config);
    if (spec.features.grille !== false) addGrille(trim, spec, T, L);
    addPlateRecesses(trim, spec, T, L);
    if (spec.features.bed) addBed(paint, trim, spec, T, L, bodyColour);
    if (spec.features.boxBody) addBoxBodyDetails(trim, spec, T, L);
    if (spec.features.doors) addTransitDoors(glass, trim, spec, T, L);
  }
  if (config.details === 'full') {
    if (spec.features.mirrors) addMirrors(trim, spec, T, L);
    if (spec.features.wipers) addWipers(trim, spec, T, L);
    addDoorLines(trim, spec, T, L);
    addHandles(trim, spec, T, L);
    addBeltMoulding(trim, spec, T, L);
    if (spec.features.exhaust && spec.features.exhaust !== 'none') addExhaust(trim, spec, T, L);
    if (spec.features.roofRails) addRoofRails(trim, spec, T, L);
    if (spec.features.panelRibs) addPanelRibs(trim, spec, T, L);
    if (spec.features.cladding) addCladding(trim, spec, T, L);
    if (spec.features.roofSign) addRoofSign(trim, spec, T, L);
    if (spec.features.lightBar) addLightBar(trim, spec, T, L);
    if (spec.features.pushBar) addPushBar(trim, spec, T, L);
    if (spec.features.roofPods) addRoofPods(trim, spec, T, L);
    if (spec.features.destinationSign) addDestinationSign(trim, spec, T, L);
  }

  const paintGeometry = toGeometry(paint, `vehicle-${spec.id}-paint-lod${config.lod}`);
  const glassGeometry = glassBuf ? toGeometry(glassBuf, `vehicle-${spec.id}-glass-lod${config.lod}`) : null;
  const trimGeometry = merged ? null : toGeometry(trim, `vehicle-${spec.id}-trim-lod${config.lod}`);

  const bounds = measureBounds(spec, [paintGeometry, glassGeometry, trimGeometry], wheels, lamps, plates, config);
  const triangles = bufferTriangles(paint)
    + (merged ? 0 : bufferTriangles(trim))
    + (glassBuf ? bufferTriangles(glassBuf) : 0);

  return {
    spec,
    lod: config.lod,
    config,
    paint: paintGeometry,
    glass: glassGeometry,
    trim: trimGeometry,
    wheels: config.instancedWheels ? wheels : [],
    lamps: config.instancedLamps ? lamps : [],
    plates: config.plates ? plates : [],
    allWheels: wheels,
    allLamps: lamps,
    bounds,
    triangles,
  };
}

// ---------------------------------------------------------------------------
// livery colour functions
// ---------------------------------------------------------------------------

function liveryColourFn(spec, livery, T, L) {
  const white = [PAINT_SHADE.body, PAINT_SHADE.body, PAINT_SHADE.body];
  const under = [PAINT_SHADE.under, PAINT_SHADE.under, PAINT_SHADE.under];
  const arch = [PAINT_SHADE.archInner, PAINT_SHADE.archInner, PAINT_SHADE.archInner];
  const belt = spec.beltY;
  const taxiBody = L(T.liveryYellow);
  const taxiLower = L(T.liveryYellowDeep);
  const patrolBody = L(T.liveryWhite);
  const patrolDoor = L(T.liveryPatrolBlue);
  const transitBody = L(T.transitSilver);
  const transitSkirt = L(T.transitRed);
  return (ux, uy, z, y) => {
    if (uy < 0.05) return arch;
    if (uy < 0.11) return under;
    if (livery === 'taxi') return y < belt * 0.62 ? taxiLower : taxiBody;
    if (livery === 'patrol') {
      const doorZone = z > spec.rearAxleZ - 0.1 && z < spec.frontAxleZ - 0.2 && y < belt && Math.abs(ux) > 0.55;
      return doorZone ? patrolDoor : patrolBody;
    }
    if (livery === 'transit') return y < 1.10 ? transitSkirt : transitBody;
    if (y < spec.sillY + 0.16) return [PAINT_SHADE.lowerBand, PAINT_SHADE.lowerBand, PAINT_SHADE.lowerBand];
    return white;
  };
}

function liveryRoofColourFn(spec, livery, T, L) {
  const white = [PAINT_SHADE.body, PAINT_SHADE.body, PAINT_SHADE.body];
  const taxi = L(T.liveryYellow);
  const patrol = L(T.liveryWhite);
  const transit = L(T.transitSilver);
  return () => {
    if (livery === 'taxi') return taxi;
    if (livery === 'patrol') return patrol;
    if (livery === 'transit') return transit;
    return white;
  };
}

// ---------------------------------------------------------------------------
// lamp / plate plans
// ---------------------------------------------------------------------------

/**
 * Where the lamps sit, in the vehicle frame. `kind` selects which shared
 * emissive material draws it; `brake` and `indicator` instances are hidden by
 * zero scale when they are not lit, which is how per-vehicle lamp state works
 * without a per-vehicle material.
 */
export function buildLampPlan(spec) {
  const half = spec.width / 2;
  const zF = spec.zFront;
  const zR = spec.zRear;
  const noseTop = sampleStations(spec.profile, zF - 0.30, 'top');
  const tailTop = sampleStations(spec.profile, zR + 0.30, 'top');
  const big = spec.bodyClass === 'truck' || spec.bodyClass === 'bus';
  const headY = big ? Math.min(noseTop - 0.22, 1.05) : noseTop - 0.20;
  const tailY = big ? Math.min(tailTop - 0.30, 1.15) : tailTop - 0.24;
  const headW = big ? 0.26 : 0.32;
  const tailW = big ? 0.22 : 0.26;
  const headX = half * (big ? 0.80 : 0.62);
  const tailX = half * (big ? 0.84 : 0.74);
  const headD = 0.11;
  const tailD = 0.09;
  // Flush with the body end, and never proud of the declared length.
  const noseZ = Math.min(bodySurfaceZ(spec, zF, headY), zF) - headD / 2 - 0.004;
  const tailZ = Math.max(bodySurfaceZ(spec, zR, tailY), zR) + tailD / 2 + 0.004;
  const lamps = [];
  for (const side of [1, -1]) {
    lamps.push({ kind: 'head', x: side * headX, y: headY, z: noseZ, w: headW, h: 0.15, d: headD, side });
    lamps.push({ kind: 'indicator', x: side * (headX + headW * 0.60), y: headY - 0.015, z: noseZ - 0.012, w: 0.12, h: 0.10, d: 0.09, side, end: 'front' });
    lamps.push({ kind: 'tail', x: side * tailX, y: tailY, z: tailZ, w: tailW, h: 0.20, d: tailD, side });
    lamps.push({ kind: 'brake', x: side * tailX, y: tailY + 0.02, z: tailZ + 0.022, w: tailW * 0.80, h: 0.09, d: 0.05, side, end: 'rear' });
  }
  return lamps;
}

/** Front and rear plate positions. North American plates are 305 x 152 mm. */
export function buildPlatePlan(spec) {
  const zF = spec.zFront;
  const zR = spec.zRear;
  const w = 0.305;
  const h = 0.152;
  const frontY = Math.max(spec.sillY + 0.16, sampleStations(spec.profile, zF - 0.20, 'top') - 0.46);
  const rearY = Math.max(spec.sillY + 0.16, sampleStations(spec.profile, zR + 0.20, 'top') - 0.48);
  const plates = [];
  const rearZ = bodySurfaceZ(spec, zR, rearY);
  plates.push({ x: 0, y: rearY, z: rearZ + 0.012, w, h, facing: -1 });
  if (spec.bodyClass === 'car' || spec.bodyClass === 'suv') {
    const frontZ = bodySurfaceZ(spec, zF, frontY);
    plates.push({ x: 0, y: frontY, z: frontZ - 0.012, w, h, facing: 1 });
  }
  return plates;
}

/** The z of the body surface nearest the given end, at height `y`. */
function bodySurfaceZ(spec, endZ, y) {
  const first = spec.profile[0].z;
  const last = spec.profile[spec.profile.length - 1].z;
  const front = endZ > 0;
  // Walk in from the end until the section is wide enough to carry a lamp.
  const step = 0.02;
  let z = front ? Math.min(endZ, last) : Math.max(endZ, first);
  for (let i = 0; i < 40; i += 1) {
    const top = sampleStations(spec.profile, z, 'top');
    const bottom = sillAt(spec, z);
    if (y > bottom + 0.02 && y < top - 0.02 && bodyXAt(spec, z, y) > spec.width * 0.22) break;
    z += front ? -step : step;
  }
  return z;
}

// ---------------------------------------------------------------------------
// detail part builders
// ---------------------------------------------------------------------------

function addBumpersAndRockers(buf, spec, T, L, config) {
  const half = spec.width / 2;
  const dark = L(T.blackPlastic);
  const rubber = L(T.rubber);
  // Front and rear lower valance, wrapping the nose in three facets.
  for (const front of [true, false]) {
    const endZ = front ? spec.zFront : spec.zRear;
    const inZ = front ? spec.zFront - 0.34 : spec.zRear + 0.34;
    const yTop = sillAt(spec, inZ) + (spec.bodyClass === 'bus' ? 0.30 : 0.24);
    const yBottom = Math.max(0.06, sillAt(spec, inZ) - 0.02);
    const steps = config.details === 'full' ? 5 : 3;
    for (let i = 0; i < steps; i += 1) {
      const t = i / (steps - 1);
      const z = lerp(inZ, endZ - (front ? 0.01 : -0.01), t);
      const x = bodyXAt(spec, z, (yTop + yBottom) / 2);
      const nextT = Math.min(1, (i + 1) / (steps - 1));
      const nz = lerp(inZ, endZ - (front ? 0.01 : -0.01), nextT);
      if (i === steps - 1) break;
      const nx = bodyXAt(spec, nz, (yTop + yBottom) / 2);
      for (const side of [1, -1]) {
        addQuad(
          buf,
          [side * (x + 0.012), yBottom, z],
          [side * (nx + 0.012), yBottom, nz],
          [side * (nx + 0.012), yTop, nz],
          [side * (x + 0.012), yTop, z],
          dark,
          [0, (yTop + yBottom) / 2, (z + nz) / 2],
        );
      }
    }
  }
  // Rocker panel between the arches.
  const z0 = spec.rearAxleZ + spec.wheelRadius * 1.3;
  const z1 = spec.frontAxleZ - spec.wheelRadius * 1.3;
  if (z1 - z0 > 0.4) {
    const y = spec.sillY + 0.055;
    for (const side of [1, -1]) {
      const x0 = bodyXAt(spec, z0, y);
      const x1 = bodyXAt(spec, z1, y);
      addQuad(
        buf,
        [side * (x0 + 0.008), spec.sillY + 0.005, z0],
        [side * (x1 + 0.008), spec.sillY + 0.005, z1],
        [side * (x1 + 0.008), y + 0.05, z1],
        [side * (x0 + 0.008), y + 0.05, z0],
        rubber,
        [0, y, (z0 + z1) / 2],
      );
    }
  }
}

function addGrille(buf, spec, T, L) {
  const zF = spec.zFront;
  const noseTop = sampleStations(spec.profile, zF - 0.24, 'top');
  const y = noseTop - 0.26;
  const z = bodySurfaceZ(spec, zF, y) - 0.010;
  const w = spec.width * (spec.bodyClass === 'truck' ? 0.62 : 0.46);
  addBox(buf, 0, y, z, w, 0.17, 0.03, L(T.grille));
  addBox(buf, 0, y + 0.10, z + 0.006, w * 1.04, 0.035, 0.028, L(T.chrome));
  addBox(buf, 0, y - 0.10, z + 0.004, w * 1.02, 0.028, 0.024, L(T.darkChrome));
  // Lower air intake.
  const lowY = Math.max(spec.sillY + 0.12, y - 0.34);
  addBox(buf, 0, lowY, bodySurfaceZ(spec, zF, lowY) - 0.008, w * 1.25, 0.13, 0.026, L(T.grille));
}

function addPlateRecesses(buf, spec, T, L) {
  for (const plate of buildPlatePlan(spec)) {
    addBox(buf, plate.x, plate.y, plate.z - plate.facing * 0.008, plate.w + 0.03, plate.h + 0.03, 0.012, L(T.blackPlastic));
  }
}

function addMirrors(buf, spec, T, L) {
  const half = spec.width / 2;
  const roofFrontZ = spec.roof[spec.roof.length - 1].z;
  const tall = spec.bodyClass === 'bus' || spec.bodyClass === 'truck' || spec.bodyClass === 'van';
  const z = roofFrontZ - (tall ? 0.30 : 0.24);
  const y = tall ? spec.height * 0.72 : spec.beltY + 0.10;
  const housingW = Math.max(0.06, spec.mirrorReach * 0.86);
  const stalk = Math.max(0.02, spec.mirrorReach - housingW);
  for (const side of [1, -1]) {
    const xBody = bodyXAt(spec, z, y);
    addBox(buf, side * (xBody + stalk / 2), y, z, stalk + 0.02, 0.035, 0.045, L(T.blackPlastic));
    addBox(buf, side * (half + spec.mirrorReach - housingW / 2), y + 0.015, z, housingW, 0.115, 0.16, L(T.greyPlastic));
    addBox(buf, side * (half + spec.mirrorReach - housingW / 2), y + 0.015, z - 0.075, housingW * 0.86, 0.09, 0.012, L(T.chrome));
  }
}

function addWipers(buf, spec, T, L) {
  const cowlZ = spec.roof[spec.roof.length - 1].z;
  const y = sampleStations(spec.profile, cowlZ, 'top') + 0.022;
  const reach = Math.min(0.62, spec.width * 0.34);
  for (const side of [1, -1]) {
    addBox(buf, side * spec.width * 0.16, y, cowlZ - 0.06, reach, 0.016, 0.026, L(T.blackPlastic), side * 0.30);
  }
}

function addDoorLines(buf, spec, T, L) {
  const dark = L(T.glassSeal);
  for (const z of spec.features.doorLines || []) {
    const top = sampleStations(spec.profile, z, 'top');
    const bottom = sillAt(spec, z) + 0.06;
    if (!(top - bottom > 0.15)) continue;
    for (const side of [1, -1]) {
      const x = bodyXAt(spec, z, (top + bottom) / 2);
      addBox(buf, side * (x + 0.004), (top + bottom) / 2, z, 0.012, top - bottom, 0.012, dark);
    }
  }
}

function addHandles(buf, spec, T, L) {
  for (const [z, y] of spec.features.handles || []) {
    for (const side of [1, -1]) {
      const x = bodyXAt(spec, z, y);
      addBox(buf, side * (x + 0.016), y, z, 0.026, 0.038, 0.135, L(T.darkChrome));
    }
  }
}

function addBeltMoulding(buf, spec, T, L) {
  if (spec.glazing.bandY) return;
  const seal = L(T.glassSeal);
  for (const [z0, z1] of spec.glazing.sidePanes) {
    const mid = (z0 + z1) / 2;
    const y = sampleStations(spec.profile, mid, 'top') + spec.glazing.paneRise * 0.45;
    for (const side of [1, -1]) {
      const x0 = greenhouseXAt(spec, z0, y);
      const x1 = greenhouseXAt(spec, z1, y);
      addQuad(
        buf,
        [side * (x0 + 0.006), y - 0.022, z0],
        [side * (x1 + 0.006), y - 0.022, z1],
        [side * (x1 + 0.006), y + 0.022, z1],
        [side * (x0 + 0.006), y + 0.022, z0],
        seal,
        [0, y, mid],
      );
    }
  }
}

function addExhaust(buf, spec, T, L) {
  const y = spec.sillY + 0.02;
  const z = spec.zRear + 0.10;
  const xs = spec.features.exhaust === 'twin' ? [-spec.width * 0.28, spec.width * 0.28] : [-spec.width * 0.30];
  if (spec.features.exhaust === 'stack') {
    addCylinderY(buf, spec.width * 0.44, spec.beltY + 0.55, spec.rearAxleZ + 0.9, 0.055, 1.4, 8, L(T.exhaust));
    return;
  }
  for (const x of xs) addBox(buf, x, y, z, 0.075, 0.075, 0.17, L(T.exhaust));
}

function addRoofRails(buf, spec, T, L) {
  const z0 = spec.roof[2].z;
  const z1 = spec.roof[spec.roof.length - 3].z;
  const y = sampleStations(spec.roof, (z0 + z1) / 2, 'top');
  const x = sampleStations(spec.roof, (z0 + z1) / 2, 'half') * 0.72;
  for (const side of [1, -1]) {
    addBox(buf, side * x, y - 0.018, (z0 + z1) / 2, 0.05, 0.036, Math.abs(z1 - z0) * 0.92, L(T.darkChrome));
  }
}

function addPanelRibs(buf, spec, T, L) {
  const seal = L(T.greyPlastic);
  for (const z of spec.features.panelRibs || []) {
    const top = sampleStations(spec.profile, z, 'top') - 0.10;
    const bottom = sillAt(spec, z) + 0.12;
    if (!(top - bottom > 0.2)) continue;
    for (const side of [1, -1]) {
      const x = bodyXAt(spec, z, (top + bottom) / 2);
      addBox(buf, side * (x + 0.010), (top + bottom) / 2, z, 0.020, top - bottom, 0.05, seal);
    }
  }
}

function addCladding(buf, spec, T, L) {
  const dark = L(T.greyPlastic);
  const archLen = spec.wheelRadius * ARCH_LENGTH_FACTOR;
  for (const axleZ of [spec.frontAxleZ, spec.rearAxleZ]) {
    const steps = 5;
    for (let i = 0; i < steps - 1; i += 1) {
      const t0 = -1 + (2 * i) / (steps - 1);
      const t1 = -1 + (2 * (i + 1)) / (steps - 1);
      const z0 = axleZ + t0 * archLen;
      const z1 = axleZ + t1 * archLen;
      const y0 = sillAt(spec, z0);
      const y1 = sillAt(spec, z1);
      for (const side of [1, -1]) {
        const x0 = bodyXAt(spec, z0, y0 + 0.05);
        const x1 = bodyXAt(spec, z1, y1 + 0.05);
        addQuad(
          buf,
          [side * (x0 + 0.010), y0 - 0.005, z0],
          [side * (x1 + 0.010), y1 - 0.005, z1],
          [side * (x1 + 0.010), y1 + 0.085, z1],
          [side * (x0 + 0.010), y0 + 0.085, z0],
          dark,
          [0, (y0 + y1) / 2, (z0 + z1) / 2],
        );
      }
    }
  }
}

function addBed(paintBuf, trimBuf, spec, T, L, bodyColour) {
  const bed = spec.features.bed;
  const half = spec.width / 2;
  const wallT = 0.10;
  const paintRgb = bodyColour(0.9, 0.7, bed.front, bed.sideY);
  const liner = L(T.bedLiner);
  const zMid = (bed.rear + bed.front) / 2;
  const len = bed.front - bed.rear;
  for (const side of [1, -1]) {
    addBox(paintBuf, side * (half - wallT / 2), (bed.floorY + bed.sideY) / 2, zMid, wallT, bed.sideY - bed.floorY, len, paintRgb);
  }
  addBox(paintBuf, 0, (bed.floorY + bed.sideY) / 2, bed.rear + wallT / 2, half * 2 - 0.02, bed.sideY - bed.floorY, wallT, paintRgb);
  addBox(paintBuf, 0, (bed.floorY + bed.sideY) / 2, bed.front - wallT / 2, half * 2 - 0.02, bed.sideY - bed.floorY, wallT, paintRgb);
  addBox(trimBuf, 0, bed.floorY + 0.012, zMid, (half - wallT) * 2, 0.024, len - wallT * 2, liner);
}

function addBoxBodyDetails(buf, spec, T, L) {
  const box = spec.features.boxBody;
  const half = spec.width / 2;
  const trimRgb = L(T.greyPlastic);
  const seal = L(T.glassSeal);
  // Roll-up rear door surround and the lift-gate lip.
  addBox(buf, 0, (box.top + 0.9) / 2, box.rear + 0.05, half * 1.92, box.top - 1.1, 0.05, seal);
  addBox(buf, 0, 0.86, box.rear + 0.16, half * 1.9, 0.09, 0.34, trimRgb);
  // Body-to-chassis skirt.
  for (const side of [1, -1]) {
    addBox(buf, side * (half - 0.03), 0.56, (box.rear + box.front) / 2, 0.06, 0.10, box.front - box.rear - 0.1, trimRgb);
  }
}

function addTransitDoors(glassBuf, trimBuf, spec, T, L) {
  const seal = L(T.transitCharcoal);
  const paneColour = L(T.glassSeal);
  for (const [z0, z1] of spec.features.doors || []) {
    const y0 = 0.44;
    const y1 = 2.42;
    for (const side of [1, -1]) {
      const xa = bodyXAt(spec, z0, (y0 + y1) / 2);
      const xb = bodyXAt(spec, z1, (y0 + y1) / 2);
      addQuad(
        trimBuf,
        [side * (xa + 0.010), y0, z0], [side * (xb + 0.010), y0, z1],
        [side * (xb + 0.010), y1, z1], [side * (xa + 0.010), y1, z0],
        seal, [0, (y0 + y1) / 2, (z0 + z1) / 2],
      );
      addQuad(
        glassBuf,
        [side * (xa + 0.028), y0 + 0.30, z0 + 0.06], [side * (xb + 0.028), y0 + 0.30, z1 - 0.06],
        [side * (xb + 0.028), y1 - 0.10, z1 - 0.06], [side * (xa + 0.028), y1 - 0.10, z0 + 0.06],
        paneColour, [0, (y0 + y1) / 2, (z0 + z1) / 2],
      );
    }
  }
}

function addRoofSign(buf, spec, T, L) {
  const sign = spec.features.roofSign;
  addBox(buf, 0, sign.y + sign.h / 2, sign.z, sign.w, sign.h, sign.d, L(T.liveryYellow));
  addBox(buf, 0, sign.y + sign.h / 2, sign.z - sign.d / 2 - 0.008, sign.w * 0.84, sign.h * 0.7, 0.012, L(T.lensClear));
  addBox(buf, 0, sign.y + sign.h / 2, sign.z + sign.d / 2 + 0.008, sign.w * 0.84, sign.h * 0.7, 0.012, L(T.lensClear));
  addBox(buf, 0, sign.y - 0.02, sign.z, sign.w * 0.5, 0.05, sign.d * 0.6, L(T.liveryBlack));
}

function addLightBar(buf, spec, T, L) {
  const bar = spec.features.lightBar;
  addBox(buf, 0, bar.y + bar.h / 2, bar.z, bar.w, bar.h, bar.d, L(T.liveryBlack));
  for (const side of [1, -1]) {
    addBox(buf, side * bar.w * 0.28, bar.y + bar.h / 2, bar.z - bar.d / 2 - 0.006, bar.w * 0.30, bar.h * 0.62, 0.014,
      side > 0 ? L(T.lensRed) : L(0x2a4fa8));
    addBox(buf, side * bar.w * 0.28, bar.y + bar.h / 2, bar.z + bar.d / 2 + 0.006, bar.w * 0.30, bar.h * 0.62, 0.014,
      side > 0 ? L(0x2a4fa8) : L(T.lensRed));
  }
  addBox(buf, 0, bar.y - 0.025, bar.z, bar.w * 0.6, 0.05, bar.d * 0.7, L(T.liveryBlack));
}

function addPushBar(buf, spec, T, L) {
  const z = spec.zFront - 0.12;
  const grey = L(T.greyPlastic);
  const y0 = spec.sillY + 0.10;
  const y1 = sampleStations(spec.profile, z, 'top') - 0.08;
  for (const side of [1, -1]) {
    addBox(buf, side * spec.width * 0.30, (y0 + y1) / 2, z - 0.05, 0.09, y1 - y0, 0.07, grey);
  }
  addBox(buf, 0, y1 - 0.06, z - 0.05, spec.width * 0.72, 0.08, 0.07, grey);
  addBox(buf, 0, y0 + 0.10, z - 0.05, spec.width * 0.72, 0.07, 0.07, grey);
}

function addRoofPods(buf, spec, T, L) {
  const y = spec.height;
  const grey = L(T.transitCharcoal);
  addBox(buf, 0, y + 0.10, spec.zRear + 2.4, spec.width * 0.62, 0.20, 2.0, grey);
  addBox(buf, 0, y + 0.07, spec.zFront - 2.6, spec.width * 0.5, 0.14, 1.2, grey);
}

function addDestinationSign(buf, spec, T, L) {
  const z = spec.zFront - 0.10;
  const y = spec.height - 0.34;
  addBox(buf, 0, y, bodySurfaceZ(spec, spec.zFront, y) - 0.010, spec.width * 0.62, 0.24, 0.03, L(T.liveryBlack));
  addBox(buf, 0, y, bodySurfaceZ(spec, spec.zFront, y) - 0.024, spec.width * 0.56, 0.17, 0.012, L(0xd8a63a));
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

function measureBounds(spec, geometries, wheels, lamps, plates, config) {
  const box = new THREE.Box3();
  box.makeEmpty();
  for (const geometry of geometries) {
    if (!geometry?.boundingBox) continue;
    box.union(geometry.boundingBox);
  }
  if (config.instancedWheels) {
    for (const wheel of wheels) {
      box.expandByPoint(new THREE.Vector3(wheel.x - wheel.width / 2, 0, wheel.z - wheel.radius));
      box.expandByPoint(new THREE.Vector3(wheel.x + wheel.width / 2, wheel.radius * 2, wheel.z + wheel.radius));
    }
  }
  if (config.instancedLamps) {
    for (const lamp of lamps) {
      box.expandByPoint(new THREE.Vector3(lamp.x - lamp.w / 2, lamp.y - lamp.h / 2, lamp.z - lamp.d / 2));
      box.expandByPoint(new THREE.Vector3(lamp.x + lamp.w / 2, lamp.y + lamp.h / 2, lamp.z + lamp.d / 2));
    }
  }
  if (config.plates) {
    for (const plate of plates) {
      box.expandByPoint(new THREE.Vector3(plate.x - plate.w / 2, plate.y - plate.h / 2, plate.z - 0.01));
      box.expandByPoint(new THREE.Vector3(plate.x + plate.w / 2, plate.y + plate.h / 2, plate.z + 0.01));
    }
  }
  const size = box.getSize(new THREE.Vector3());
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
    width: size.x,
    height: size.y,
    length: size.z,
  };
}

// ---------------------------------------------------------------------------
// shared instanced geometry: wheels, lamps, plates
// ---------------------------------------------------------------------------

/**
 * Unit wheel. Radius 1 in Y/Z, width 1 in X, centred on the hub, so the
 * instance matrix scale is `(wheelWidth, wheelRadius, wheelRadius)` and one
 * geometry serves every class in the catalogue.
 *
 * `side` is +1 for a wheel whose face shows toward +X and -1 for the mirror,
 * because a negative instance scale would invert the shading.
 */
export function buildWheelGeometry(lod, palette) {
  const detailed = lod === 0;
  const sides = detailed ? 12 : 8;
  const T = palette;
  const rubber = hexToLinear(T.rubber);
  const tread = hexToLinear(0x0d0e10);

  const tyre = makeBuffer();
  const rings = [
    { x: -0.5, r: 0.86 },
    { x: -0.34, r: 1.0 },
    { x: 0.34, r: 1.0 },
    { x: 0.5, r: 0.86 },
  ];
  const rows = rings.map((ring) => {
    const row = [];
    for (let i = 0; i < sides; i += 1) {
      const th = (i / sides) * Math.PI * 2;
      row.push(vertex(tyre, ring.x, Math.sin(th) * ring.r, Math.cos(th) * ring.r, ring.r > 0.95 ? tread : rubber));
    }
    return row;
  });
  for (let r = 0; r < rows.length - 1; r += 1) {
    const ref = [(rings[r].x + rings[r + 1].x) / 2, 0, 0];
    for (let i = 0; i < sides; i += 1) {
      const j = (i + 1) % sides;
      triangle(tyre, rows[r][i], rows[r + 1][i], rows[r + 1][j], ref);
      triangle(tyre, rows[r][i], rows[r + 1][j], rows[r][j], ref);
    }
  }
  for (const end of [0, rows.length - 1]) {
    const centre = vertex(tyre, rings[end].x, 0, 0, rubber);
    const neighbour = [rings[end === 0 ? 1 : rows.length - 2].x, 0, 0];
    for (let i = 0; i < sides; i += 1) {
      const j = (i + 1) % sides;
      triangle(tyre, centre, rows[end][i], rows[end][j], neighbour);
    }
  }

  const makeRim = (side) => {
    const buf = makeBuffer();
    const bright = [1, 1, 1];
    const dark = hexToLinear(0x24272b);
    const faceX = side * 0.40;
    const outwardRef = [side * -4, 0, 0];
    // Rim barrel inside the tyre.
    const inner = [];
    const outer = [];
    for (let i = 0; i < sides; i += 1) {
      const th = (i / sides) * Math.PI * 2;
      inner.push(vertex(buf, side * 0.06, Math.sin(th) * 0.80, Math.cos(th) * 0.80, dark));
      outer.push(vertex(buf, faceX, Math.sin(th) * 0.86, Math.cos(th) * 0.86, bright));
    }
    for (let i = 0; i < sides; i += 1) {
      const j = (i + 1) % sides;
      triangle(buf, inner[i], outer[i], outer[j], [0, 0, 0]);
      triangle(buf, inner[i], outer[j], inner[j], [0, 0, 0]);
    }
    // Dark face behind the spokes, closing the wheel.
    const faceRing = [];
    for (let i = 0; i < sides; i += 1) {
      const th = (i / sides) * Math.PI * 2;
      faceRing.push(vertex(buf, faceX, Math.sin(th) * 0.84, Math.cos(th) * 0.84, dark));
    }
    const faceCentre = vertex(buf, faceX, 0, 0, dark);
    for (let i = 0; i < sides; i += 1) {
      const j = (i + 1) % sides;
      triangle(buf, faceCentre, faceRing[i], faceRing[j], outwardRef);
    }
    // Bright outer lip.
    const lipInner = [];
    for (let i = 0; i < sides; i += 1) {
      const th = (i / sides) * Math.PI * 2;
      lipInner.push(vertex(buf, faceX + side * 0.012, Math.sin(th) * 0.78, Math.cos(th) * 0.78, bright));
    }
    for (let i = 0; i < sides; i += 1) {
      const j = (i + 1) % sides;
      triangle(buf, outer[i], lipInner[i], lipInner[j], outwardRef);
      triangle(buf, outer[i], lipInner[j], outer[j], outwardRef);
    }
    if (detailed) {
      const spokes = 5;
      const x = faceX + side * 0.022;
      for (let sIdx = 0; sIdx < spokes; sIdx += 1) {
        const base = (sIdx / spokes) * Math.PI * 2;
        const dth = Math.PI / spokes * 0.44;
        const p = (r, th) => [x, Math.sin(th) * r, Math.cos(th) * r];
        addQuad(buf, p(0.24, base - dth * 1.5), p(0.76, base - dth), p(0.76, base + dth), p(0.24, base + dth * 1.5), bright, outwardRef);
      }
    }
    return buf;
  };

  return {
    tyre: toGeometry(tyre, `vehicle-tyre-lod${lod}`),
    rimRight: toGeometry(makeRim(1), `vehicle-rim-right-lod${lod}`),
    rimLeft: toGeometry(makeRim(-1), `vehicle-rim-left-lod${lod}`),
  };
}

function addCylinderX(buf, cx, radius, length, sides, rgb, cy = 0, cz = 0) {
  const a = [];
  const b = [];
  for (let i = 0; i < sides; i += 1) {
    const th = (i / sides) * Math.PI * 2;
    const y = cy + Math.sin(th) * radius;
    const z = cz + Math.cos(th) * radius;
    a.push(vertex(buf, cx - length / 2, y, z, rgb));
    b.push(vertex(buf, cx + length / 2, y, z, rgb));
  }
  const capA = vertex(buf, cx - length / 2, cy, cz, rgb);
  const capB = vertex(buf, cx + length / 2, cy, cz, rgb);
  const ref = [cx, cy, cz];
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    triangle(buf, a[i], b[i], b[j], ref);
    triangle(buf, a[i], b[j], a[j], ref);
    triangle(buf, capA, a[i], a[j], ref);
    triangle(buf, capB, b[i], b[j], ref);
  }
}

/**
 * Unit lamp lens: 1 x 1 x 1 about the origin with a slightly domed +Z face, so
 * the instance matrix scale is the lamp's `(w, h, d)` in metres.
 */
export function buildLampGeometry(hex) {
  const buf = makeBuffer();
  const rgb = hexToLinear(hex);
  const section = closedSection(8, 3.2, 3.2);
  const rings = [
    { z: -0.5, half: 0.46, bottom: 0.02, top: 0.98 },
    { z: 0.5, half: 0.5, bottom: 0, top: 1 },
  ];
  const shifted = rings.map((r) => ({ z: r.z, half: r.half, bottom: r.bottom - 0.5, top: r.top - 0.5 }));
  addLoft(buf, shifted, section, () => rgb);
  return toGeometry(buf, 'vehicle-lamp-lens');
}

/** Unit plate: 1 x 1 in X/Y, 0.02 deep, so the scale is `(w, h, 1)` in metres. */
export function buildPlateGeometry() {
  const buf = makeBuffer();
  const white = hexToLinear(0xdadcd6);
  const blue = hexToLinear(0x2b4a7a);
  addBox(buf, 0, 0, 0, 1, 1, 0.02, white);
  addBox(buf, 0, 0.36, -0.014, 0.78, 0.16, 0.006, blue);
  return toGeometry(buf, 'vehicle-plate');
}

export default buildVehicleGeometry;
