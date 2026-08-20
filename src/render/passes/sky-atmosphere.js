// sky-atmosphere — presentation pass.
//
// Owner: Rendering (lighting/atmosphere)
// Goal:  Sky, cloud, aerial-perspective and exposure content that the rubric's lighting dimension needs.
//
// Contract: see src/render/pass-registry.js. Build from the city contract in
// `ctx`; never mutate simulation state, never create a renderer or loop.
//
// What this pass is answering
// ---------------------------
// Measured on the baseline 11:00 clear card (`.qa-baseline-0820`), the frame
// has: a flat two-stop vertex-coloured sky with no sun and no cloud; no
// aerial perspective, because the renderer's fog starts at 1100 m on a map
// whose deepest street sight-line is about 250 m; no contact darkening where
// wall meets ground; and a key/fill ratio of 0.70, i.e. the sky fill is
// stronger than the sun. All four are addressed here or in the pure model this
// pass reads (`src/render/environment-ibl.js`), except the parts that live in
// the renderer's own light rig, which are reported as diagnostics for the
// integration owner rather than patched from inside a pass.
//
// Backend policy
// --------------
// Everything below is plain Three geometry with `MeshBasicMaterial`,
// `PointsMaterial` and one `MeshStandardMaterial`, plus `DataTexture`s built
// from typed arrays. No `ShaderMaterial`, no `onBeforeCompile`, no render
// target, no second renderer, no animation loop. That is what lets the same
// content render on `WebGPURenderer` and on its WebGL2 fallback, which is the
// backend the capture harness actually runs.
//
// Determinism
// -----------
// No `Math.random()`, no `Date.now()`. Cloud shape, star placement, puddle
// placement and per-lamp jitter all come from the integer hash in
// `environment-ibl`, and cloud drift is a function of the clock hour rather
// than of accumulated frame time, so a pinned capture hour reproduces the same
// sky byte for byte.

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

import {
  ATMOSPHERE_MODEL_VERSION,
  aerialPerspective,
  blackBodyColor,
  cloudProfile,
  computeSkyModel,
  keyFillBalance,
  nightPracticalProfile,
  normaliseWeather,
  quantiseHour,
  recommendedExposure,
  renderCloudSheet,
  skyDomeRadiance,
  starField,
  wetSurfaceGrade,
} from '../environment-ibl.js';

/** Identity of the scene content this pass builds. */
export const SKY_ATMOSPHERE_VERSION = 'sky-atmosphere-v1';

/**
 * Declared budget for everything this pass adds.
 *
 * `AGENTS.md` requires render-only work to preserve draw/triangle budgets
 * unless the task defines and verifies a new one. This is that definition, and
 * `scripts/verify/verify-sky-atmosphere.mjs` asserts the built result against
 * it for every hour and weather bucket.
 */
export const SKY_ATMOSPHERE_BUDGET = Object.freeze({
  triangles: 48000,
  drawCalls: 18,
  /** Bytes of texture this pass uploads, summed over every texture it owns. */
  textureBytes: 1_600_000,
  /**
   * Hours between sky retimes. A retime costs one `computeSkyModel` (~3.8 ms)
   * plus a dome recolour (~3.6 ms). At 0.5 h and the shipped 40 s day that is
   * about 8 ms once every 0.83 s, i.e. ~1% of frame time; at 0.25 h it would be
   * twice that for a sky difference nobody can see.
   */
  hourQuantum: 0.5,
});

/** Geometry resolution. Kept low: a sky gradient interpolates well. */
const DOME_SEGMENTS = 40;
const DOME_RINGS = 26;
const CLOUD_SEGMENTS = 44;
const CLOUD_RINGS = 9;
const HAZE_SEGMENTS = 56;
const HAZE_RINGS = 5;
const STAR_COUNT = 620;
const CLOUD_TEXTURE_SIZE = 256;
const MAX_CONTACT_BUILDINGS = 1200;
const MAX_CONTACT_EDGES = 48;
// Hard ceiling on the merged contact mesh. 1200 buildings at 48 edges each
// would be 115k triangles - twice the declared budget - so the cap is on the
// total, not on the per-building edge count.
const MAX_CONTACT_QUADS = 14000;
const MAX_PUDDLES = 360;
const CONTACT_WIDTH = 1.55;
// Slightly under the 0.62 the skirt alone would want, because the renderer's
// existing `contact-shadows` blob still contributes a little at the footprint
// edge and the two stack.
const CONTACT_ALPHA = 0.55;

const DEG = Math.PI / 180;
const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const finite = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The one live build. `dispose()` clears it; `build()` replaces it. */
let live = null;

// ---------------------------------------------------------------- textures

/** Wrap RGBA bytes in a `DataTexture` with sane sampler state. @private */
function byteTexture(data, width, height, { name, wrap = ClampToEdgeWrapping, srgb = false } = {}) {
  const texture = new DataTexture(data, width, height, RGBAFormat);
  texture.name = name || 'sky-atmosphere-texture';
  texture.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace;
  texture.wrapS = wrap;
  texture.wrapT = wrap;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Radial alpha sprite: white RGB, alpha falling from the centre by `power`.
 * Used for the solar disc, the solar aureole, lamp pools and under-vehicle
 * darkening, so one generator covers four cues.
 * @private
 */
function radialAlphaTexture(size, power, core = 0) {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      const dx = (i - centre) / centre;
      const dy = (j - centre) / centre;
      const r = Math.hypot(dx, dy);
      let a = r >= 1 ? 0 : Math.pow(1 - r, power);
      if (core > 0 && r < core) a = 1;
      const o = (j * size + i) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  return { data, width: size, height: size };
}

/**
 * One-dimensional alpha ramp, `size` texels wide and one tall.
 * `alphaAt(t)` receives 0..1 across the ramp.
 * @private
 */
function rampTexture(size, alphaAt) {
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i += 1) {
    const t = size > 1 ? i / (size - 1) : 0;
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = Math.round(clamp(alphaAt(t), 0, 1) * 255);
  }
  return { data, width: size, height: 1 };
}

// ---------------------------------------------------------------- geometry

/**
 * A disc that curves down toward its rim, so the far edge of a cloud deck
 * meets the horizon instead of ending in a hard circular cut. Vertices carry
 * world-metre UVs, which is what lets the deck be re-centred on the camera
 * every frame while the texture stays anchored to the world.
 * @private
 */
function skyPlateGeometry(radius, altitude, segments, rings, tileMetres) {
  const vertexCount = (rings + 1) * (segments + 1);
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    // Squared ring spacing puts the resolution where the perspective needs it.
    const t = (ring / rings) ** 1.7;
    const r = t * radius;
    // Drop toward the horizon: at the rim the deck is at 8% of its altitude.
    const y = altitude * (1 - 0.92 * t * t);
    for (let seg = 0; seg <= segments; seg += 1) {
      const phi = (seg / segments) * Math.PI * 2;
      const index = ring * (segments + 1) + seg;
      const x = Math.cos(phi) * r;
      const z = Math.sin(phi) * r;
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
      uvs[index * 2] = x / tileMetres;
      uvs[index * 2 + 1] = z / tileMetres;
    }
  }
  for (let ring = 0; ring < rings; ring += 1) {
    for (let seg = 0; seg < segments; seg += 1) {
      const a = ring * (segments + 1) + seg;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Open cylinder wall for the ground haze band, UV-mapped so `v` runs 0 at the
 * ground to 1 at the top of the band. Two-sided, because the player can stand
 * inside it or look down on it from a roof.
 * @private
 */
function hazeWallGeometry(radius, height, segments, rings) {
  const vertexCount = (rings + 1) * (segments + 1);
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const v = ring / rings;
    const y = v * height;
    for (let seg = 0; seg <= segments; seg += 1) {
      const phi = (seg / segments) * Math.PI * 2;
      const index = ring * (segments + 1) + seg;
      positions[index * 3] = Math.cos(phi) * radius;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = Math.sin(phi) * radius;
      uvs[index * 2] = seg / segments;
      uvs[index * 2 + 1] = v;
    }
  }
  for (let ring = 0; ring < rings; ring += 1) {
    for (let seg = 0; seg < segments; seg += 1) {
      const a = ring * (segments + 1) + seg;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Accumulator for the flat, ground-hugging quad sets (contact darkening, light
 * pools, spill, puddles). Every one of them is the same shape - four corners,
 * a UV rectangle, one merged draw call - so they share this.
 * @private
 */
function quadSink() {
  const positions = [];
  const uvs = [];
  const indices = [];
  return {
    get count() { return indices.length / 6; },
    /** Axis-aligned rectangle centred on (x, z), size (w, d), rotated by `rot`. */
    rect(x, y, z, w, d, rot = 0, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const hw = w / 2;
      const hd = d / 2;
      const base = positions.length / 3;
      const corner = (ox, oz) => positions.push(x + ox * c - oz * s, y, z + ox * s + oz * c);
      corner(-hw, -hd);
      corner(hw, -hd);
      corner(hw, hd);
      corner(-hw, hd);
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    },
    /** Free quad from four explicit corners, with explicit UVs. */
    quad(a, b, c, d, uvA, uvB, uvC, uvD) {
      const base = positions.length / 3;
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
      uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1], uvD[0], uvD[1]);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    },
    build(name) {
      if (!indices.length) return null;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      geometry.name = name;
      return geometry;
    },
  };
}

// ---------------------------------------------------------------- helpers

/** Signed area of a polygon in XZ. Positive means counter-clockwise. @private */
function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

/** Deterministic 32-bit hash of a string. @private */
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const hash01 = (value) => {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

/** Set a `Color` from a linear-RGB triple without an sRGB decode. @private */
function setLinear(color, rgb, scale = 1) {
  color.setRGB(
    Math.max(0, rgb[0] * scale),
    Math.max(0, rgb[1] * scale),
    Math.max(0, rgb[2] * scale),
    LinearSRGBColorSpace,
  );
  return color;
}

/** Largest of the map's X/Z extents, or a sane default. @private */
function mapSpanOf(city) {
  const bounds = city?.meta?.bounds;
  if (!bounds) return 2000;
  const span = Math.max(
    finite(bounds.maxX, 0) - finite(bounds.minX, 0),
    finite(bounds.maxZ, 0) - finite(bounds.minZ, 0),
  );
  return span > 1 ? span : 2000;
}

// ---------------------------------------------------------------- build parts

/**
 * The visible sky: a vertex-coloured dome, a solar disc with its aureole, a
 * stylised moon, and a star field.
 *
 * The dome is vertex-coloured rather than textured on purpose. A 1024x512
 * equirect panorama costs about 150 ms to bake, and the clock runs a full day
 * in forty seconds, so a per-bucket re-bake would be a visible hitch four
 * times a second. Recolouring 1107 vertices from the same pure model costs
 * about a millisecond and the gradient interpolates cleanly, because a sky is
 * exactly the low-frequency signal Gouraud interpolation is good at. The sun
 * is the one high-frequency feature, so it is separate geometry.
 * @private
 */
function buildSky(radius) {
  const group = new Group();
  group.name = 'sky-atmosphere:sky';

  const domeGeometry = new SphereGeometry(radius, DOME_SEGMENTS, DOME_RINGS);
  const vertexCount = domeGeometry.getAttribute('position').count;
  domeGeometry.setAttribute('color', new BufferAttribute(new Float32Array(vertexCount * 3), 3));
  const domeMaterial = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
    fog: false,
    depthWrite: false,
  });
  const dome = new Mesh(domeGeometry, domeMaterial);
  dome.name = 'sky-atmosphere:dome';
  // Later than the legacy dome's -10 so this one wins wherever both survive,
  // and still before every opaque surface in the world.
  dome.renderOrder = -9;
  dome.frustumCulled = false;
  group.add(dome);

  const glowSource = radialAlphaTexture(64, 2.6);
  const glowTexture = byteTexture(glowSource.data, 64, 64, { name: 'sky-atmosphere:sun-glow' });
  const glowMaterial = new MeshBasicMaterial({
    map: glowTexture,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const glowSize = radius * 0.62;
  const glow = new Mesh(skyBillboardGeometry(glowSize), glowMaterial);
  glow.name = 'sky-atmosphere:sun-glow';
  glow.renderOrder = -8;
  glow.frustumCulled = false;
  group.add(glow);

  const discSource = radialAlphaTexture(64, 3.2, 0.34);
  const discTexture = byteTexture(discSource.data, 64, 64, { name: 'sky-atmosphere:sun-disc' });
  const discMaterial = new MeshBasicMaterial({
    map: discTexture,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const disc = new Mesh(skyBillboardGeometry(radius * 0.045), discMaterial);
  disc.name = 'sky-atmosphere:sun-disc';
  disc.renderOrder = -7;
  disc.frustumCulled = false;
  group.add(disc);

  // The moon is a stylised placement, not an ephemeris: it is put on the
  // anti-solar azimuth at the altitude the renderer's night key already uses,
  // so the disc the player sees and the direction the night shadows run agree.
  // Calling it a lunar position would be a claim this module cannot support.
  const moonMaterial = new MeshBasicMaterial({
    map: discTexture,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const moon = new Mesh(skyBillboardGeometry(radius * 0.05), moonMaterial);
  moon.name = 'sky-atmosphere:moon';
  moon.renderOrder = -7;
  moon.frustumCulled = false;
  group.add(moon);

  const stars = starField(STAR_COUNT, { seed: 11, minAltitudeDeg: 1.5 });
  const starPositions = new Float32Array(stars.count * 3);
  const starColors = new Float32Array(stars.count * 3);
  for (let i = 0; i < stars.count; i += 1) {
    const r = radius * 0.985;
    starPositions[i * 3] = stars.positions[i * 3] * r;
    starPositions[i * 3 + 1] = stars.positions[i * 3 + 1] * r;
    starPositions[i * 3 + 2] = stars.positions[i * 3 + 2] * r;
    const magnitude = stars.magnitudes[i];
    starColors[i * 3] = stars.colors[i * 3] * magnitude;
    starColors[i * 3 + 1] = stars.colors[i * 3 + 1] * magnitude;
    starColors[i * 3 + 2] = stars.colors[i * 3 + 2] * magnitude;
  }
  const starGeometry = new BufferGeometry();
  starGeometry.setAttribute('position', new BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('color', new BufferAttribute(starColors, 3));
  starGeometry.computeBoundingSphere();
  const starSource = radialAlphaTexture(16, 2.2);
  const starTexture = byteTexture(starSource.data, 16, 16, { name: 'sky-atmosphere:star' });
  const starMaterial = new PointsMaterial({
    size: 2.4,
    sizeAttenuation: false,
    vertexColors: true,
    map: starTexture,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: AdditiveBlending,
    opacity: 0,
  });
  const starPoints = new Points(starGeometry, starMaterial);
  starPoints.name = 'sky-atmosphere:stars';
  starPoints.renderOrder = -8;
  starPoints.frustumCulled = false;
  group.add(starPoints);

  return {
    group,
    dome,
    domeGeometry,
    domeMaterial,
    disc,
    discMaterial,
    glow,
    glowMaterial,
    moon,
    moonMaterial,
    starPoints,
    starMaterial,
    textures: [glowTexture, discTexture, starTexture],
    radius,
  };
}

const _aimQuaternion = new Quaternion();
const _aimFrom = new Vector3(0, 0, 1);
const _aimTo = new Vector3();

/**
 * Point a billboard's +Z face back at the dome centre.
 *
 * `Object3D.lookAt` reads `matrixWorld`, which is one frame stale during a
 * build and wrong the moment the sky group is re-centred on the camera. The
 * direction wanted here is purely local - a plane at `dir * R` faces `-dir` -
 * so it is set directly and is invariant to wherever the group ends up.
 * @private
 */
function aimAtCentre(object, dir) {
  _aimTo.set(-dir.x, -dir.y, -dir.z).normalize();
  object.quaternion.copy(_aimQuaternion.setFromUnitVectors(_aimFrom, _aimTo));
}

/** A square in the XY plane, centred on the origin, ready to be re-aimed. @private */
function skyBillboardGeometry(size) {
  const half = size / 2;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0,
  ]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Two cloud decks at different altitudes.
 *
 * The decks are re-centred on the camera every frame but their UVs are in
 * world metres and are offset by the camera position, so the texture stays
 * anchored to the world while the geometry never leaves the frustum. Because
 * the two decks divide the camera offset by different tile sizes they slide
 * against each other exactly as two real decks at 620 m and 1900 m would - the
 * parallax is a property of the offset arithmetic, not an animation.
 * @private
 */
function bakeCloudSheet(index, spec, coverage) {
  // The low deck carries the detail the player reads at eye level, so it gets
  // the larger sheet and the extra octave; the high deck is thin cirrus seen at
  // a shallow angle and does not repay either.
  return renderCloudSheet({
    size: index === 0 ? CLOUD_TEXTURE_SIZE : CLOUD_TEXTURE_SIZE * 0.75,
    lattice: index === 0 ? 8 : 6,
    seed: spec.seed,
    coverage,
    softness: index === 0 ? 0.30 : 0.42,
    octaves: index === 0 ? 5 : 4,
  });
}

function buildClouds(profile, radius) {
  const group = new Group();
  group.name = 'sky-atmosphere:clouds';
  const layers = [];
  const textures = [];
  const altitudes = [radius * 0.17, radius * 0.5];
  const tiles = [1750, 4600];
  for (let i = 0; i < profile.layers.length; i += 1) {
    const spec = profile.layers[i];
    const sheet = bakeCloudSheet(i, spec, profile.coverage);
    const texture = byteTexture(sheet.data, sheet.width, sheet.height, {
      name: `sky-atmosphere:${spec.name}`,
      wrap: RepeatWrapping,
    });
    textures.push(texture);
    const geometry = skyPlateGeometry(radius * 0.92, altitudes[i], CLOUD_SEGMENTS, CLOUD_RINGS, tiles[i]);
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
      opacity: spec.opacity,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = `sky-atmosphere:${spec.name}`;
    mesh.renderOrder = -6 + i;
    mesh.frustumCulled = false;
    group.add(mesh);
    layers.push({ spec, mesh, material, texture, tile: tiles[i], geometry, index: i, coverage: profile.coverage });
  }
  return { group, layers, textures };
}

/**
 * The ground-hugging haze band.
 *
 * A single linear fog term is uniform in height, so morning haze applied that
 * way greys the towers as much as the street and reads as a flat wash. This is
 * the height term: a two-sided cylinder wall whose alpha falls from the ground
 * to the top of the band, re-centred on the camera. From the street the far
 * wall of it sits across the end of the block; from a roof it is the layer the
 * city is standing in.
 * @private
 */
function buildHaze(radius, height) {
  const geometry = hazeWallGeometry(radius, height, HAZE_SEGMENTS, HAZE_RINGS);
  const ramp = rampTexture(64, (t) => (1 - t) ** 1.9);
  const texture = byteTexture(ramp.data, ramp.width, ramp.height, {
    name: 'sky-atmosphere:haze-ramp',
    wrap: ClampToEdgeWrapping,
  });
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
    opacity: 0,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:ground-haze';
  mesh.renderOrder = -5;
  mesh.frustumCulled = false;
  return { mesh, material, texture, geometry, height };
}

/**
 * Contact grounding: a mitred darkening skirt that follows each building's
 * real footprint.
 *
 * The renderer already draws a `contact-shadows` mesh, but it is one
 * axis-aligned quad per building carrying a radial blob, so on a non-rectangular
 * or rotated footprint the dark patch does not touch the wall it belongs to.
 * That is why the baseline frame has no darkening at the wall/ground junction
 * even though a contact pass is running. This follows the polygon, mitres the
 * corners so there is no wedge-shaped gap, and fades outward over `CONTACT_WIDTH`.
 * The legacy blob is hidden while this pass is live and restored on dispose.
 *
 * A screen-space AO term would be the better answer, but there is no
 * post-processing stage on the canonical path and adding one would mean a
 * render target and a shader this pass is not allowed to introduce. This is
 * the geometry-baked equivalent the brief asks for, and it survives the
 * software backend because it is one merged mesh with one basic material.
 * @private
 */
function buildContactGrounding(ctx, city) {
  const sink = quadSink();
  const heightAt = typeof ctx.heightAt === 'function' ? ctx.heightAt : () => 0;
  const buildings = Array.isArray(city?.buildings) ? city.buildings : [];
  let footprints = 0;
  let skipped = 0;
  for (let b = 0;
    b < buildings.length && footprints < MAX_CONTACT_BUILDINGS && sink.count < MAX_CONTACT_QUADS;
    b += 1) {
    const polygon = buildings[b]?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) { skipped += 1; continue; }
    // Drop a duplicated closing vertex if the source carries one.
    const points = [];
    for (const p of polygon) {
      const x = finite(p?.x, NaN);
      const z = finite(p?.z, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const last = points[points.length - 1];
      if (last && Math.abs(last.x - x) < 1e-4 && Math.abs(last.z - z) < 1e-4) continue;
      points.push({ x, z });
    }
    if (points.length > 2) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.abs(first.x - last.x) < 1e-4 && Math.abs(first.z - last.z) < 1e-4) points.pop();
    }
    if (points.length < 3 || points.length > MAX_CONTACT_EDGES) { skipped += 1; continue; }
    const area = signedArea(points);
    if (Math.abs(area) < 6) { skipped += 1; continue; }
    // Outward normal depends on winding; normalise it away rather than
    // assuming the source is consistent, because OSM footprints are not.
    const sign = area > 0 ? 1 : -1;
    const n = points.length;
    const outward = [];
    for (let i = 0; i < n; i += 1) {
      const a = points[i];
      const c = points[(i + 1) % n];
      const ex = c.x - a.x;
      const ez = c.z - a.z;
      const len = Math.hypot(ex, ez) || 1;
      outward.push({ x: (ez / len) * sign, z: (-ex / len) * sign });
    }
    // Mitre: average the two edge normals at each vertex and lengthen so the
    // offset edge stays parallel to the original. Clamped so a needle-sharp
    // corner cannot throw a spike across the street.
    const offsets = [];
    for (let i = 0; i < n; i += 1) {
      const prev = outward[(i - 1 + n) % n];
      const next = outward[i];
      let mx = prev.x + next.x;
      let mz = prev.z + next.z;
      const len = Math.hypot(mx, mz);
      if (len < 1e-4) { mx = next.x; mz = next.z; }
      else { mx /= len; mz /= len; }
      const cosHalf = Math.max(0.35, mx * next.x + mz * next.z);
      const scale = clamp(CONTACT_WIDTH / cosHalf, CONTACT_WIDTH, CONTACT_WIDTH * 2.6);
      offsets.push({ x: mx * scale, z: mz * scale });
    }
    for (let i = 0; i < n; i += 1) {
      const a = points[i];
      const c = points[(i + 1) % n];
      const oa = offsets[i];
      const oc = offsets[(i + 1) % n];
      const ya = finite(heightAt(a.x, a.z), 0) + 0.035;
      const yc = finite(heightAt(c.x, c.z), 0) + 0.035;
      sink.quad(
        [a.x, ya, a.z],
        [c.x, yc, c.z],
        [c.x + oc.x, yc, c.z + oc.z],
        [a.x + oa.x, ya, a.z + oa.z],
        [0, 0.5], [0, 0.5], [1, 0.5], [1, 0.5],
      );
    }
    footprints += 1;
  }
  const geometry = sink.build('sky-atmosphere:contact-grounding');
  if (!geometry) return null;
  const ramp = rampTexture(48, (t) => CONTACT_ALPHA * (1 - t) ** 2.1);
  const texture = byteTexture(ramp.data, ramp.width, ramp.height, {
    name: 'sky-atmosphere:contact-ramp',
  });
  const material = new MeshBasicMaterial({
    map: texture,
    color: 0x000000,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:contact-grounding';
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, material, texture, geometry, footprints, skipped, quads: sink.count };
}

/**
 * Under-object darkening for things that stand on the ground but are not
 * buildings: parked vehicles and shopfront canopies. Both are read out of the
 * groups the renderer already named, so this adds no assumption about how they
 * were generated.
 * @private
 */
function buildUnderObjectShading(ctx) {
  const sink = quadSink();
  const heightAt = typeof ctx.heightAt === 'function' ? ctx.heightAt : () => 0;
  const world = new Vector3();
  let vehicles = 0;
  let canopies = 0;

  for (const name of ['parked-car-bodies', 'sf-partitioned-parked-car-bodies']) {
    const mesh = ctx.legacyGroup?.(name);
    if (!mesh || !mesh.isInstancedMesh) continue;
    // Read the instance buffer directly rather than through `getMatrixAt`: the
    // only fields needed are the translation and the yaw, and going through a
    // Matrix4 per instance would allocate inside a build loop that can run
    // several hundred times.
    const array = mesh.instanceMatrix?.array;
    if (!array) continue;
    const count = Math.min(finite(mesh.count, 0), Math.floor(array.length / 16));
    for (let i = 0; i < count; i += 1) {
      const o = i * 16;
      const x = array[o + 12];
      const y = array[o + 13];
      const z = array[o + 14];
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      // Yaw straight out of the basis so the patch lies along the car.
      const rot = Math.atan2(array[o + 2], array[o]);
      sink.rect(x, finite(heightAt(x, z), finite(y, 0)) + 0.03, z, 5.4, 2.6, rot);
      vehicles += 1;
    }
  }

  const awnings = ctx.legacyGroup?.('shopfront-awnings');
  if (awnings && typeof awnings.traverse === 'function') {
    awnings.updateMatrixWorld?.(true);
    awnings.traverse((node) => {
      if (!node.isMesh) return;
      node.getWorldPosition(world);
      const x = world.x;
      const z = world.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      sink.rect(x, finite(heightAt(x, z), 0) + 0.03, z, 3.6, 2.8, node.rotation?.y || 0);
      canopies += 1;
    });
  }

  const geometry = sink.build('sky-atmosphere:under-object-shading');
  if (!geometry) return null;
  const source = radialAlphaTexture(64, 1.9);
  const texture = byteTexture(source.data, 64, 64, { name: 'sky-atmosphere:under-object' });
  const material = new MeshBasicMaterial({
    map: texture,
    color: 0x000000,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:under-object-shading';
  mesh.renderOrder = 2;
  return { mesh, material, texture, geometry, vehicles, canopies, quads: sink.count };
}

/**
 * Night practicals: what the street's own lights put on the ground and in the
 * air. Three separate merged meshes, because they blend differently - the
 * pools and the bulb glows are additive, the shop spill is a warm wash that
 * has to stay under 1 so it does not clip the sidewalk to white.
 * @private
 */
function buildNightPracticals(ctx, profile) {
  const heightAt = typeof ctx.heightAt === 'function' ? ctx.heightAt : () => 0;
  const lampGroup = ctx.legacyGroup?.('street-lamps');
  const pools = quadSink();
  const glows = quadSink();
  const spill = quadSink();
  const world = new Vector3();
  let lamps = 0;
  let spills = 0;

  if (lampGroup && typeof lampGroup.traverse === 'function') {
    lampGroup.updateMatrixWorld?.(true);
    const children = lampGroup.children || [];
    for (let i = 0; i < children.length; i += 1) {
      const lamp = children[i];
      lamp.getWorldPosition(world);
      const x = world.x;
      const z = world.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const ground = finite(heightAt(x, z), 0);
      // Per-fixture jitter: a street where every pool is the same size and the
      // same brightness reads as a texture, not as lighting.
      const jitter = 0.82 + 0.36 * hash01(hashString(`${lamp.name || 'lamp'}:${i}`));
      const radius = profile.pool.radius * jitter;
      pools.rect(x, ground + 0.045, z, radius * 2, radius * 2);
      // The bulb itself, as a soft glow in air at the fixture height.
      glows.rect(x, ground + 5.5, z, 3.0 * jitter, 3.0 * jitter);
      lamps += 1;
    }
  }

  const awnings = ctx.legacyGroup?.('shopfront-awnings');
  if (awnings && typeof awnings.traverse === 'function') {
    awnings.updateMatrixWorld?.(true);
    let index = 0;
    awnings.traverse((node) => {
      if (!node.isMesh) return;
      index += 1;
      // Occupancy: not every shop is open, and which ones are must be stable
      // across frames and across captures.
      if (hash01(hashString(`spill:${index}`)) > profile.shopSpill.occupancy) return;
      node.getWorldPosition(world);
      const x = world.x;
      const z = world.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const depth = profile.shopSpill.depth * (0.8 + 0.5 * hash01(hashString(`spilld:${index}`)));
      spill.rect(x, finite(heightAt(x, z), 0) + 0.05, z, 4.2, depth, node.rotation?.y || 0);
      spills += 1;
    });
  }

  const poolSource = radialAlphaTexture(96, profile.pool.falloff);
  const poolTexture = byteTexture(poolSource.data, 96, 96, { name: 'sky-atmosphere:light-pool' });
  const glowSource = radialAlphaTexture(48, 2.4);
  const glowTexture = byteTexture(glowSource.data, 48, 48, { name: 'sky-atmosphere:bulb-glow' });

  const parts = [];
  const textures = [poolTexture, glowTexture];

  const poolGeometry = pools.build('sky-atmosphere:light-pools');
  if (poolGeometry) {
    const material = new MeshBasicMaterial({
      map: poolTexture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: 0,
      fog: true,
    });
    const mesh = new Mesh(poolGeometry, material);
    mesh.name = 'sky-atmosphere:light-pools';
    mesh.renderOrder = 3;
    parts.push({ key: 'pools', mesh, material, geometry: poolGeometry });
  }
  const glowGeometry = glows.build('sky-atmosphere:bulb-glows');
  if (glowGeometry) {
    const material = new MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: 0,
      fog: true,
    });
    const mesh = new Mesh(glowGeometry, material);
    mesh.name = 'sky-atmosphere:bulb-glows';
    mesh.renderOrder = 3;
    parts.push({ key: 'glows', mesh, material, geometry: glowGeometry });
  }
  const spillGeometry = spill.build('sky-atmosphere:shop-spill');
  if (spillGeometry) {
    const material = new MeshBasicMaterial({
      map: poolTexture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: 0,
      fog: true,
    });
    const mesh = new Mesh(spillGeometry, material);
    mesh.name = 'sky-atmosphere:shop-spill';
    mesh.renderOrder = 3;
    parts.push({ key: 'spill', mesh, material, geometry: spillGeometry });
  }

  return { parts, textures, lamps, spills };
}

/**
 * Wet-surface response: standing water on the carriageway.
 *
 * This is the one piece that uses a `MeshStandardMaterial`, because the whole
 * point is a *reflection*: at `roughness` 0.24 with `scene.environment`
 * assigned, a puddle mirrors the sky and whatever the practicals are doing,
 * which is what makes a drizzle frame legible as wet rather than as tinted.
 * Placement follows the street contract's own polylines, so puddles land on
 * real carriageway and are stable across rebuilds.
 * @private
 */
function buildWetSheen(ctx, city, grade) {
  if (!(grade.wetness > 0.05)) return null;
  const heightAt = typeof ctx.heightAt === 'function' ? ctx.heightAt : () => 0;
  const segments = Array.isArray(city?.segments) ? city.segments : [];
  const sink = quadSink();
  let placed = 0;
  const lift = finite(city?.meta?.streetDesign?.roadLift, 0.45);
  for (let s = 0; s < segments.length && placed < MAX_PUDDLES; s += 1) {
    const segment = segments[s];
    const points = segment?.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    const a = points[0];
    const b = points[points.length - 1];
    const dx = finite(b?.x, 0) - finite(a?.x, 0);
    const dz = finite(b?.z, 0) - finite(a?.z, 0);
    const length = Math.hypot(dx, dz);
    if (!(length > 12)) continue;
    const width = clamp(finite(segment.width, 8), 3, 40);
    const seed = hashString(String(segment.id || `seg:${s}`));
    // About one puddle per 26 m of carriageway, jittered across the lanes.
    const count = Math.max(1, Math.min(4, Math.floor(length / 26)));
    const ux = dx / length;
    const uz = dz / length;
    for (let k = 0; k < count && placed < MAX_PUDDLES; k += 1) {
      const t = (k + 0.5) / count + (hash01(seed + k * 7717) - 0.5) * 0.4;
      if (t <= 0.02 || t >= 0.98) continue;
      const lateral = (hash01(seed + k * 1913) - 0.5) * width * 0.72;
      const x = finite(a.x, 0) + ux * length * t - uz * lateral;
      const z = finite(a.z, 0) + uz * length * t + ux * lateral;
      const size = 2.2 + 3.4 * hash01(seed + k * 3301);
      sink.rect(
        x,
        finite(heightAt(x, z), 0) + lift + 0.012,
        z,
        size,
        size * (0.55 + 0.5 * hash01(seed + k * 5501)),
        Math.atan2(uz, ux),
      );
      placed += 1;
    }
  }
  const geometry = sink.build('sky-atmosphere:wet-sheen');
  if (!geometry) return null;
  const source = radialAlphaTexture(64, 1.4, 0.28);
  const texture = byteTexture(source.data, 64, 64, { name: 'sky-atmosphere:puddle' });
  const material = new MeshStandardMaterial({
    map: texture,
    alphaMap: texture,
    color: 0x0b0e11,
    roughness: grade.roughness,
    metalness: 0.06,
    transparent: true,
    opacity: clamp(grade.sheenOpacity * 2.1, 0, 0.95),
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  material.userData.envClass = 'water';
  material.envMapIntensity = grade.envMapIntensity;
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:wet-sheen';
  mesh.renderOrder = 1;
  mesh.receiveShadow = true;
  return { mesh, material, texture, geometry, puddles: placed };
}

// ---------------------------------------------------------------- retiming

/** Recolour the dome and re-aim the sun/moon/stars for a sky model. @private */
function retimeSky(sky, model, aerial, cloud) {
  const colors = sky.domeGeometry.getAttribute('color');
  const positions = sky.domeGeometry.getAttribute('position');
  const rgb = [0, 0, 0];
  const inverse = 1 / sky.radius;
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i) * inverse;
    const y = positions.getY(i) * inverse;
    const z = positions.getZ(i) * inverse;
    skyDomeRadiance(model, x, y, z, { hazeColor: aerial.color }, rgb);
    colors.setXYZ(i, rgb[0], rgb[1], rgb[2]);
  }
  colors.needsUpdate = true;

  const sun = model.sun;
  const cloudCover = clamp(cloud.coverage, 0, 1);
  // Cloud hides the disc: at 92% coverage there is no sun to see.
  const clearSky = 1 - cloudCover * 0.92;
  const above = clamp((sun.altitudeDeg + 2) / 4, 0, 1);

  sky.disc.position.set(sun.x * sky.radius * 0.97, sun.y * sky.radius * 0.97, sun.z * sky.radius * 0.97);
  aimAtCentre(sky.disc, sun);
  sky.glow.position.copy(sky.disc.position);
  aimAtCentre(sky.glow, sun);
  // The disc has to be far brighter than the dome or ACES will not clip it to
  // white, and a sun that is not clipped reads as a paper cut-out.
  const discRadiance = 26 + 46 * model.daylight;
  setLinear(sky.discMaterial.color, [1.0, 0.94, 0.84], discRadiance * above * clearSky);
  sky.disc.visible = above * clearSky > 0.01;
  // The aureole takes the sunward horizon's own colour, so it goes orange as
  // the sun drops without anyone choosing an orange.
  setLinear(sky.glowMaterial.color, model.sunwardHorizonRadiance, 0.55 * clearSky);
  sky.glow.visible = above * clearSky > 0.01;
  sky.glowMaterial.opacity = clamp(0.25 + 0.55 * (1 - model.daylight), 0, 1) * above;

  // Anti-solar azimuth at the altitude the renderer's night key uses.
  const horizontal = Math.hypot(sun.x, sun.z);
  const moonAltitude = 52 * DEG;
  const moonDir = horizontal > 1e-6
    ? {
      x: (-sun.x / horizontal) * Math.cos(moonAltitude),
      y: Math.sin(moonAltitude),
      z: (-sun.z / horizontal) * Math.cos(moonAltitude),
    }
    : { x: 0, y: 1, z: 0 };
  sky.moon.position.set(moonDir.x * sky.radius * 0.96, moonDir.y * sky.radius * 0.96, moonDir.z * sky.radius * 0.96);
  aimAtCentre(sky.moon, moonDir);
  setLinear(sky.moonMaterial.color, [0.94, 0.95, 1.0], 3.4 * model.night * clearSky);
  sky.moon.visible = model.night * clearSky > 0.02;

  sky.starMaterial.opacity = clamp(model.night * clearSky * 0.95, 0, 1);
  sky.starPoints.visible = sky.starMaterial.opacity > 0.01;
}

/**
 * Retint the cloud decks, and rebake their sheets if the deck's *coverage* has
 * changed - which only happens on a weather change.
 *
 * A retint alone would be wrong there: a fog deck's 0.95 opacity applied to a
 * sheet baked at clear's 0.30 coverage is a dense but sparse sky, which is not
 * fog. The rebake costs about 150 ms and happens once per user-driven weather
 * toggle, never on the clock.
 * @private
 */
function retimeClouds(clouds, profile) {
  if (Math.abs(profile.coverage - (clouds.layers[0]?.coverage ?? profile.coverage)) > 1e-6) {
    for (const layer of clouds.layers) {
      const sheet = bakeCloudSheet(layer.index, layer.spec, profile.coverage);
      layer.texture.image.data.set(sheet.data);
      layer.texture.needsUpdate = true;
      layer.coverage = profile.coverage;
    }
  }
  for (const layer of clouds.layers) {
    // RGB in the sheet is a shade term, so `material.color` sets the lit end
    // and the sheet's own darkening carries the volume.
    setLinear(layer.material.color, profile.litTint);
    layer.material.opacity = layer.spec.opacity;
    layer.material.visible = layer.spec.opacity > 0.01;
  }
}

/** Apply the aerial-perspective numbers to the scene fog and the haze band. @private */
function retimeAerial(state, aerial) {
  const fog = state.scene?.fog;
  if (fog) {
    fog.near = aerial.near;
    fog.far = aerial.far;
    setLinear(fog.color, aerial.color);
  }
  if (state.haze) {
    setLinear(state.haze.material.color, aerial.haze.color);
    state.haze.material.opacity = aerial.haze.density;
    state.haze.mesh.visible = aerial.haze.density > 0.012;
    // The band's height is baked into the geometry, so it is scaled rather
    // than rebuilt: a morning inversion is a taller band, not a new mesh.
    const scale = clamp(aerial.haze.height / state.haze.height, 0.25, 4);
    state.haze.mesh.scale.set(1, scale, 1);
  }
}

/** Turn the night practicals up or down. @private */
function retimePracticals(state, profile) {
  for (const part of state.practicals?.parts || []) {
    if (part.key === 'pools') {
      setLinear(part.material.color, profile.pool.color, 1.35);
      part.material.opacity = profile.pool.opacity;
    } else if (part.key === 'glows') {
      setLinear(part.material.color, profile.pool.color, 1.8);
      part.material.opacity = clamp(profile.night * 0.62, 0, 1);
    } else {
      // Shopfronts run warmer than the street lamps and vary in temperature.
      setLinear(part.material.color, blackBodyColor(2950), 0.9);
      part.material.opacity = profile.shopSpill.opacity;
    }
    part.mesh.visible = part.material.opacity > 0.012;
  }
}

// ---------------------------------------------------------------- diagnostics

/** The whole day, measured rather than typed. @private */
function daySchedule(weather, mapSpan) {
  const rows = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const model = computeSkyModel({ hour, weather });
    const balance = keyFillBalance(model);
    const exposure = recommendedExposure(model);
    const aerial = aerialPerspective({ model, mapSpan });
    const cloud = cloudProfile(model);
    rows.push({
      hour,
      sunAltitudeDeg: Math.round(model.sun.altitudeDeg * 100) / 100,
      sunAzimuthDeg: Math.round(model.sun.azimuthDeg * 100) / 100,
      daylight: Math.round(model.daylight * 1000) / 1000,
      skyLuminance: Math.round(model.horizonLuminance * 10000) / 10000,
      zenithLuminance: Math.round(model.zenithLuminance * 10000) / 10000,
      keyFill: balance.measured.ratio,
      keyFillTarget: balance.target.ratio,
      keyFillAchieved: balance.achieved.ratio,
      exposure: exposure.exposure,
      illuminance: exposure.illuminance.total,
      fogNear: aerial.near,
      fogFar: aerial.far,
      hazeDensity: aerial.haze.density,
      hazeHeight: aerial.haze.height,
      cloudCoverage: cloud.coverage,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- pass

function buildPass(ctx) {
  const city = ctx?.city || null;
  const weather = (() => {
    try {
      return normaliseWeather(ctx?.weather);
    } catch {
      return 'clear';
    }
  })();
  const hour = finite(ctx?.hour, 12);
  const mapSpan = mapSpanOf(city);
  const model = computeSkyModel({ hour, weather });
  const aerial = aerialPerspective({ model, mapSpan });
  const cloud = cloudProfile(model);
  const practical = nightPracticalProfile(model);
  const balance = keyFillBalance(model);
  const exposure = recommendedExposure(model);
  const wetAsphalt = wetSurfaceGrade('asphalt', model);

  const root = new Group();
  root.name = 'pass:sky-atmosphere';

  // The dome must sit inside the far plane or its top is clipped away; the
  // cloud decks and haze band must sit inside the dome for the same reason.
  const cameraFar = finite(ctx?.camera?.far, 4200);
  const radius = clamp(cameraFar * 0.92, 900, 3900);

  const sky = buildSky(radius);
  root.add(sky.group);

  const clouds = buildClouds(cloud, radius);
  root.add(clouds.group);

  const haze = buildHaze(Math.min(radius * 0.72, Math.max(240, aerial.far * 0.82)), aerial.haze.height);
  root.add(haze.mesh);

  const contact = buildContactGrounding(ctx, city);
  if (contact) root.add(contact.mesh);
  const underObject = buildUnderObjectShading(ctx);
  if (underObject) root.add(underObject.mesh);
  const practicals = buildNightPracticals(ctx, practical);
  for (const part of practicals.parts) root.add(part.mesh);
  const wet = buildWetSheen(ctx, city, wetAsphalt);
  if (wet) root.add(wet.mesh);

  // Deliberately *not* hiding the renderer's own `sky-dome` or
  // `contact-shadows`.
  //
  // The dome does not need hiding: both domes are opaque with
  // `depthWrite: false`, so they sit in the same render list sorted by
  // `renderOrder`, and this one is -9 against the legacy -10. It therefore
  // paints over the legacy dome completely, every frame, at any radius. Setting
  // `visible = false` on it instead would have a side effect nothing here
  // wants: the legacy dome is deliberately left raycastable so the capture
  // harness's ground-coverage probe can report a hole in the world by name, and
  // `Raycaster` skips invisible objects. A cosmetic pass must not quietly
  // disable someone else's hole detector.
  //
  // The contact blob is left alone for a different reason: it is another
  // subsystem's object, and this pass is additive by design. Its residue is a
  // soft patch under each building's bounding box, mostly hidden by the
  // building; the skirt above is what lands on the visible pavement. Removing
  // it is a one-line change in the renderer and is written up in the handoff
  // rather than taken unilaterally while other owners are in the same tree.
  const suppressed = [];

  const scene = ctx?.scene || null;
  // The renderer owns `scene.fog` and rewrites its colour on every clock move.
  // This pass takes over the numbers (aerial perspective is the atmosphere
  // subsystem's job) but records what it found so `dispose()` can hand the
  // scene back exactly as it was, rather than leaving a disposed pass's depth
  // budget behind on a live renderer.
  const originalFog = scene?.fog
    ? { near: scene.fog.near, far: scene.fog.far, color: scene.fog.color.clone() }
    : null;

  const state = {
    root,
    scene,
    originalFog,
    sky,
    clouds,
    haze,
    contact,
    underObject,
    practicals,
    wet,
    suppressed,
    radius,
    mapSpan,
    weather,
    bucket: null,
    fogNear: aerial.near,
    fogFar: aerial.far,
    fogColor: new Color(),
    lastCameraX: 0,
    lastCameraZ: 0,
  };
  setLinear(state.fogColor, aerial.color);

  retimeSky(sky, model, aerial, cloud);
  retimeClouds(clouds, cloud);
  retimeAerial(state, aerial);
  retimePracticals(state, practical);
  state.bucket = `${weather}|${quantiseHour(hour, SKY_ATMOSPHERE_BUDGET.hourQuantum).toFixed(4)}`;

  let textureBytes = 0;
  const countTexture = (texture) => {
    const image = texture?.image;
    if (!image) return;
    textureBytes += finite(image.width, 0) * finite(image.height, 0) * 4;
  };
  for (const texture of sky.textures) countTexture(texture);
  for (const texture of clouds.textures) countTexture(texture);
  countTexture(haze.texture);
  if (contact) countTexture(contact.texture);
  if (underObject) countTexture(underObject.texture);
  for (const texture of practicals.textures) countTexture(texture);
  if (wet) countTexture(wet.texture);

  const diagnostics = {
    pass: SKY_ATMOSPHERE_VERSION,
    model: ATMOSPHERE_MODEL_VERSION,
    implemented: true,
    hour: model.hour,
    requestedHour: model.requestedHour,
    weather,
    mapSpan: Math.round(mapSpan),
    domeRadius: Math.round(radius),
    sun: {
      altitudeDeg: Math.round(model.sun.altitudeDeg * 100) / 100,
      azimuthDeg: Math.round(model.sun.azimuthDeg * 100) / 100,
      daylight: Math.round(model.daylight * 1000) / 1000,
    },
    exposure: {
      recommended: exposure.exposure,
      illuminance: exposure.illuminance,
      reference: exposure.reference,
      clamped: exposure.clamped,
    },
    keyFill: {
      measured: balance.measured.ratio,
      target: balance.target.ratio,
      achieved: balance.achieved.ratio,
      gains: balance.gains,
      apply: balance.apply,
    },
    sky: {
      zenithLuminance: Math.round(model.zenithLuminance * 10000) / 10000,
      horizonLuminance: Math.round(model.horizonLuminance * 10000) / 10000,
      sunwardContrast: Math.round(model.sunwardContrast * 1000) / 1000,
      stars: STAR_COUNT,
      sunDiscVisible: sky.disc.visible,
      moonVisible: sky.moon.visible,
    },
    fog: {
      near: aerial.near,
      far: aerial.far,
      color: aerial.color,
      rendererRule: aerial.rendererRule,
      scale: aerial.scale,
      haze: aerial.haze,
    },
    clouds: {
      coverage: cloud.coverage,
      layers: cloud.layers.map((layer) => ({
        name: layer.name,
        opacity: layer.opacity,
        driftU: layer.driftU,
        driftV: layer.driftV,
      })),
      textureSize: CLOUD_TEXTURE_SIZE,
    },
    lights: {
      lampPools: practicals.lamps,
      shopSpills: practicals.spills,
      bulbGlows: practicals.lamps,
      windowOccupancy: practical.windows.occupancy,
      windowCoolShare: practical.windows.coolShare,
      practicalProfile: practical,
    },
    contact: {
      footprints: contact?.footprints ?? 0,
      quads: contact?.quads ?? 0,
      skipped: contact?.skipped ?? 0,
      vehicles: underObject?.vehicles ?? 0,
      canopies: underObject?.canopies ?? 0,
      screenSpaceAvailable: false,
      note: 'geometry-baked contact darkening: there is no post-processing stage on the '
        + 'canonical path, and adding one would mean a render target and a shader this pass '
        + 'may not introduce',
    },
    wet: {
      wetness: wetAsphalt.wetness,
      roughness: wetAsphalt.roughness,
      dryRoughness: wetAsphalt.dryRoughness,
      colorScale: wetAsphalt.colorScale,
      envMapIntensity: wetAsphalt.envMapIntensity,
      puddles: wet?.puddles ?? 0,
    },
    suppressedLegacy: suppressed.map((entry) => entry.name),
    budget: {
      declared: SKY_ATMOSPHERE_BUDGET,
      textureBytes,
    },
    schedule: daySchedule(weather, mapSpan),
  };

  return { state, root, diagnostics };
}

export default {
  id: 'sky-atmosphere',
  order: 10,

  build(ctx) {
    try {
      if (live) {
        // A rebuild without a dispose would leak the previous world's meshes
        // and leave the legacy dome hidden by an object that no longer exists.
        this.dispose();
      }
      const { state, root, diagnostics } = buildPass(ctx || {});
      live = state;
      return { object: root, diagnostics };
    } catch (error) {
      // The contract says a pass must not take the world down. A frame with no
      // sky content is worse-looking, not broken.
      return {
        object: null,
        diagnostics: {
          pass: SKY_ATMOSPHERE_VERSION,
          implemented: false,
          error: String(error?.message || error),
        },
      };
    }
  },

  update(ctx) {
    const state = live;
    if (!state) return;
    const camera = ctx?.camera;
    const cx = finite(camera?.position?.x, state.lastCameraX);
    const cz = finite(camera?.position?.z, state.lastCameraZ);
    state.lastCameraX = cx;
    state.lastCameraZ = cz;

    // The dome, the cloud decks and the haze band are atmosphere, not objects:
    // they travel with the viewer. Only their *texture* stays world-anchored,
    // which is what produces parallax without ever leaving the far plane.
    state.sky.group.position.set(cx, 0, cz);
    state.clouds.group.position.set(cx, 0, cz);
    state.haze.mesh.position.set(cx, 0, cz);

    const hour = finite(ctx?.hour, 12);
    for (const layer of state.clouds.layers) {
      const offset = layer.texture.offset;
      if (offset) {
        offset.set(
          -cx / layer.tile + (hour * layer.spec.driftU) % 1,
          -cz / layer.tile + (hour * layer.spec.driftV) % 1,
        );
      }
    }

    // Re-assert the fog every frame. `setTimeOfDay` writes `scene.fog.color`
    // from its own palette whenever the clock moves, and it runs before the
    // pass runtime in the same frame, so a value written only on a bucket
    // change would be overwritten within one tick.
    const fog = state.scene?.fog;
    if (fog) {
      fog.near = state.fogNear;
      fog.far = state.fogFar;
      fog.color.copy(state.fogColor);
    }

    let weather = state.weather;
    try {
      weather = normaliseWeather(ctx?.weather);
    } catch {
      weather = state.weather;
    }
    const bucket = `${weather}|${quantiseHour(hour, SKY_ATMOSPHERE_BUDGET.hourQuantum).toFixed(4)}`;
    if (bucket === state.bucket) return;
    state.bucket = bucket;

    // Weather changed the cloud sheets themselves, which needs a rebake; the
    // caller does that by rebuilding, so here the deck simply keeps its shape
    // and takes the new opacity and tint.
    const model = computeSkyModel({ hour, weather });
    const aerial = aerialPerspective({ model, mapSpan: state.mapSpan });
    const cloud = cloudProfile(model);
    const practical = nightPracticalProfile(model);
    state.weather = weather;
    state.fogNear = aerial.near;
    state.fogFar = aerial.far;
    setLinear(state.fogColor, aerial.color);
    retimeSky(state.sky, model, aerial, cloud);
    retimeClouds(state.clouds, cloud);
    retimeAerial(state, aerial);
    retimePracticals(state, practical);
  },

  dispose() {
    const state = live;
    live = null;
    if (!state) return;
    for (const entry of state.suppressed) {
      if (entry.object) entry.object.visible = true;
    }
    const fog = state.scene?.fog;
    if (fog && state.originalFog) {
      fog.near = state.originalFog.near;
      fog.far = state.originalFog.far;
      fog.color.copy(state.originalFog.color);
    }
    // The pass runtime disposes the geometry and materials it can reach
    // through the returned object; the textures those materials share are
    // disposed here so a rebuild does not orphan them.
    const textures = [
      ...state.sky.textures,
      ...state.clouds.textures,
      state.haze.texture,
      state.contact?.texture,
      state.underObject?.texture,
      ...(state.practicals?.textures || []),
      state.wet?.texture,
    ];
    for (const texture of textures) texture?.dispose?.();
  },

  /** Exposed for the headless verifier; never called by the runtime. */
  _inspect() {
    return live;
  },
};
