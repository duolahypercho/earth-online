// Self-check for src/render/detail-maps.js
//
// Runs headless under plain node: no browser, no DOM, no new dependency.
// Exits non-zero on the first failed assertion.
//
//   npm run verify:detail-maps
//
// What it proves:
//   1. the registry is complete and physically scaled
//   2. every field is deterministic for a seed and varies with the seed
//   3. every channel stays inside [0,1] and is finite
//   4. every field is EXACTLY periodic in u and v (bit-identical at the seam)
//   5. the baked grid and the encoded images carry that seam continuity
//   6. the normal encoding is metre-based and produces valid unit vectors
//   7. each class actually contains the structure its name claims
//   8. the grime profile is monotonic and deterministic
//   9. textures are NoColorSpace / RepeatWrapping / mipmapped and cached
//  10. the canvas and DataTexture paths agree on orientation

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import * as dm from '../../src/render/detail-maps.js';

const root = resolve(import.meta.dirname, '../..');
const MODULE_PATH = resolve(root, 'src/render/detail-maps.js');
const SEED = 'sf-detail-v1';
const RES = 128;

let checks = 0;
const failures = [];

function assert(condition, message) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL ${message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function near(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

function fieldStats(array) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let finite = true;
  for (let i = 0; i < array.length; i += 1) {
    const value = array[i];
    if (!Number.isFinite(value)) finite = false;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return { min, max, mean: sum / array.length, finite };
}

/**
 * Adjacent-texel steps inside the grid compared with the steps across the wrap
 * seam, as both a maximum and a mean. On a genuinely periodic field the seam
 * pair is just another adjacent pair, so neither statistic should stand out.
 */
function seamVersusInterior(array, width, height) {
  let interiorX = 0;
  let seamX = 0;
  let interiorY = 0;
  let seamY = 0;
  let interiorSumX = 0;
  let seamSumX = 0;
  let interiorSumY = 0;
  let seamSumY = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width - 1; x += 1) {
      const d = Math.abs(array[row + x + 1] - array[row + x]);
      interiorSumX += d;
      if (d > interiorX) interiorX = d;
    }
    const d = Math.abs(array[row] - array[row + width - 1]);
    seamSumX += d;
    if (d > seamX) seamX = d;
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height - 1; y += 1) {
      const d = Math.abs(array[(y + 1) * width + x] - array[y * width + x]);
      interiorSumY += d;
      if (d > interiorY) interiorY = d;
    }
    const d = Math.abs(array[x] - array[(height - 1) * width + x]);
    seamSumY += d;
    if (d > seamY) seamY = d;
  }
  return {
    interiorX,
    seamX,
    interiorY,
    seamY,
    meanInteriorX: interiorSumX / (height * (width - 1)),
    meanSeamX: seamSumX / height,
    meanInteriorY: interiorSumY / (width * (height - 1)),
    meanSeamY: seamSumY / width,
  };
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
section('1. registry');
// ---------------------------------------------------------------------------

const REQUIRED_CLASSES = [
  'brick', 'stucco', 'painted-concrete', 'glass-curtain',
  'asphalt', 'sidewalk-concrete', 'dirty-metal',
];
for (const className of REQUIRED_CLASSES) {
  assert(dm.SURFACE_CLASSES.includes(className), `surface class "${className}" is registered`);
}
assert(dm.listSurfaceClasses().length === dm.SURFACE_CLASSES.length, 'listSurfaceClasses copies the registry');

for (const className of dm.SURFACE_CLASSES) {
  const def = dm.getSurfaceDef(className);
  assert(
    def.metresPerRepeat.x > 0 && def.metresPerRepeat.y > 0
      && def.metresPerRepeat.x <= 8 && def.metresPerRepeat.y <= 8,
    `${className}: metres-per-repeat is a plausible real-world tile (${def.metresPerRepeat.x} x ${def.metresPerRepeat.y} m)`,
  );
  assert(
    def.heightScaleMetres > 0 && def.heightScaleMetres < 0.20,
    `${className}: relief amplitude is a plausible millimetre-scale value (${def.heightScaleMetres} m)`,
  );
  assert(def.normalExaggeration >= 1, `${className}: normal exaggeration is declared`);
}

let threwOnUnknown = false;
try {
  dm.getSurfaceDef('not-a-surface');
} catch {
  threwOnUnknown = true;
}
assert(threwOnUnknown, 'an unknown surface class throws instead of silently returning nothing');

// ---------------------------------------------------------------------------
section('2. determinism');
// ---------------------------------------------------------------------------

for (const className of dm.SURFACE_CLASSES) {
  const a = dm.buildSurfaceField(className, { seed: SEED, resolution: RES });
  const b = dm.buildSurfaceField(className, { seed: SEED, resolution: RES });
  const c = dm.buildSurfaceField(className, { seed: 'other-seed', resolution: RES });
  assert(
    sameBytes(a.heightField, b.heightField)
      && sameBytes(a.roughnessField, b.roughnessField)
      && sameBytes(a.aoField, b.aoField)
      && sameBytes(a.metalnessField, b.metalnessField),
    `${className}: same seed produces a bit-identical field`,
  );
  assert(!sameBytes(a.heightField, c.heightField), `${className}: a different seed produces a different field`);
}

const imagesA = dm.buildDetailImages('brick', { seed: SEED, resolution: RES });
const imagesB = dm.buildDetailImages('brick', { seed: SEED, resolution: RES });
assert(sameBytes(imagesA.normal.data, imagesB.normal.data), 'encoded normal bytes are deterministic');
assert(sameBytes(imagesA.orm.data, imagesB.orm.data), 'encoded ORM bytes are deterministic');

const source = readFileSync(MODULE_PATH, 'utf8');
// Strip comments first: the module's own header promises it avoids these, and
// a naive scan would match that promise instead of real code.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert(!/Math\.random\s*\(/.test(code), 'the module never calls Math.random()');
assert(!/Date\.now\s*\(/.test(code), 'the module never calls Date.now()');
assert(/Math\.random/.test(source), 'the determinism scan is looking at the real module source');

// ---------------------------------------------------------------------------
section('3. value range');
// ---------------------------------------------------------------------------

for (const className of dm.SURFACE_CLASSES) {
  const images = dm.buildDetailImages(className, { seed: SEED, resolution: RES });
  const field = images.field;
  for (const [name, array] of [
    ['height', field.heightField],
    ['roughness', field.roughnessField],
    ['ao', field.aoField],
    ['metalness', field.metalnessField],
    ['occlusion', images.occlusion],
  ]) {
    const stats = fieldStats(array);
    assert(
      stats.finite && stats.min >= 0 && stats.max <= 1,
      `${className}: ${name} stays finite inside [0,1] (${stats.min.toFixed(3)} .. ${stats.max.toFixed(3)})`,
    );
  }
  const heightStats = fieldStats(field.heightField);
  assert(
    heightStats.max - heightStats.min > 0.05,
    `${className}: the height field actually varies (range ${(heightStats.max - heightStats.min).toFixed(3)})`,
  );
}

// ---------------------------------------------------------------------------
section('4. exact tileability of the continuous field');
// ---------------------------------------------------------------------------

const CHANNELS = ['height', 'roughness', 'ao', 'metalness'];
for (const className of dm.SURFACE_CLASSES) {
  let worstU = 0;
  let worstV = 0;
  for (let i = 0; i <= 64; i += 1) {
    const t = i / 64;
    const left = dm.sampleSurfaceField(className, 0, t, { seed: SEED });
    const right = dm.sampleSurfaceField(className, 1, t, { seed: SEED });
    const bottom = dm.sampleSurfaceField(className, t, 0, { seed: SEED });
    const top = dm.sampleSurfaceField(className, t, 1, { seed: SEED });
    for (const channel of CHANNELS) {
      worstU = Math.max(worstU, Math.abs(left[channel] - right[channel]));
      worstV = Math.max(worstV, Math.abs(bottom[channel] - top[channel]));
    }
  }
  assert(worstU === 0, `${className}: field at u=0 is bit-identical to u=1 (max delta ${worstU})`);
  assert(worstV === 0, `${className}: field at v=0 is bit-identical to v=1 (max delta ${worstV})`);
}

// ---------------------------------------------------------------------------
section('5. seam continuity of the baked grid and encoded images');
// ---------------------------------------------------------------------------

for (const className of dm.SURFACE_CLASSES) {
  const images = dm.buildDetailImages(className, { seed: SEED, resolution: RES });
  const field = images.field;
  const height = seamVersusInterior(field.heightField, field.width, field.height);
  assert(
    height.seamX <= height.interiorX && height.seamY <= height.interiorY,
    `${className}: height wrap step is no worse than the worst interior step `
      + `(x ${height.seamX.toFixed(4)} <= ${height.interiorX.toFixed(4)}, `
      + `y ${height.seamY.toFixed(4)} <= ${height.interiorY.toFixed(4)})`,
  );
  // The maximum alone is a weak test: a constant offset across the seam can
  // hide under one sharp interior feature. The mean step across the seam has
  // to look ordinary too.
  const ratioX = height.meanSeamX / height.meanInteriorX;
  const ratioY = height.meanSeamY / height.meanInteriorY;
  assert(
    ratioX < 3 && ratioY < 3,
    `${className}: the average wrap step is ordinary, not a discontinuity `
      + `(x ${ratioX.toFixed(2)}x, y ${ratioY.toFixed(2)}x the interior mean)`,
  );

}

// A sharp feature may sit exactly on the tile seam by design (a form joint at
// u=0, a mullion at u=0), which makes "is the seam step larger than any
// interior step" the wrong question for the encoded images. Wrap correctness
// is instead proved exactly: rolling the field and then encoding must equal
// encoding and then rolling. An encoder that clamped at the border instead of
// wrapping would break this identity.
function rollField(field, shiftX, shiftY) {
  const { width, height } = field;
  const rolled = { ...field };
  for (const key of ['heightField', 'roughnessField', 'aoField', 'metalnessField']) {
    const source = field[key];
    const target = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      const sourceRow = ((y - shiftY) % height + height) % height * width;
      const targetRow = y * width;
      for (let x = 0; x < width; x += 1) {
        target[targetRow + x] = source[sourceRow + (((x - shiftX) % width + width) % width)];
      }
    }
    rolled[key] = target;
  }
  return rolled;
}

function rollImage(image, shiftX, shiftY) {
  const { width, height, data } = image;
  const target = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = ((y - shiftY) % height + height) % height * width;
    const targetRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = (sourceRow + (((x - shiftX) % width + width) % width)) * 4;
      const targetIndex = (targetRow + x) * 4;
      for (let c = 0; c < 4; c += 1) target[targetIndex + c] = data[sourceIndex + c];
    }
  }
  return { width, height, data: target };
}

for (const className of dm.SURFACE_CLASSES) {
  const field = dm.buildSurfaceField(className, { seed: SEED, resolution: RES });
  const shiftX = RES / 2;
  const shiftY = RES / 4;
  const rolled = rollField(field, shiftX, shiftY);

  const normalRolledThenEncoded = dm.encodeNormalRGBA(rolled);
  const normalEncodedThenRolled = rollImage(dm.encodeNormalRGBA(field), shiftX, shiftY);
  assert(
    sameBytes(normalRolledThenEncoded.data, normalEncodedThenRolled.data),
    `${className}: the normal encoder wraps exactly (rolling commutes with encoding)`,
  );

  const ormRolledThenEncoded = dm.encodeOrmRGBA(rolled);
  const ormEncodedThenRolled = rollImage(dm.encodeOrmRGBA(field), shiftX, shiftY);
  assert(
    sameBytes(ormRolledThenEncoded.data, ormEncodedThenRolled.data),
    `${className}: the ORM encoder and its cavity blur wrap exactly`,
  );
}

// ---------------------------------------------------------------------------
section('6. normal encoding');
// ---------------------------------------------------------------------------

// Run at a higher resolution than the rest of the checks: the finest classes
// (brushed metal) are deliberately detailed near the texel limit, so a 128
// tile under-resolves their slope.
const NORMAL_RES = 256;
for (const className of dm.SURFACE_CLASSES) {
  const field = dm.buildSurfaceField(className, { seed: SEED, resolution: NORMAL_RES });
  const normal = dm.encodeNormalRGBA(field);
  let worstLength = 0;
  let facingUp = true;
  let alphaOpaque = true;
  let tangentSum = 0;
  const texels = normal.width * normal.height;
  for (let i = 0; i < normal.data.length; i += 4) {
    const nx = (normal.data[i] / 255) * 2 - 1;
    const ny = (normal.data[i + 1] / 255) * 2 - 1;
    const nz = (normal.data[i + 2] / 255) * 2 - 1;
    if (nz <= 0) facingUp = false;
    if (normal.data[i + 3] !== 255) alphaOpaque = false;
    worstLength = Math.max(worstLength, Math.abs(Math.hypot(nx, ny, nz) - 1));
    tangentSum += Math.hypot(nx, ny) / Math.max(1e-6, nz);
  }
  assert(worstLength < 0.02, `${className}: every encoded normal is unit length (worst error ${worstLength.toFixed(4)})`);
  assert(facingUp, `${className}: every encoded normal points out of the surface (z > 0)`);
  assert(alphaOpaque, `${className}: the normal map alpha channel is fully opaque`);

  const meanSlopeDegrees = Math.atan(tangentSum / texels) * 180 / Math.PI;
  assert(
    meanSlopeDegrees > 1.5 && meanSlopeDegrees < 30,
    `${className}: mean surface slope is visible but sane (${meanSlopeDegrees.toFixed(2)} deg)`,
  );
}

// The encoder works in metres: doubling the relief amplitude must double the
// slope. A naive per-texel difference would not scale this way.
{
  const field = dm.buildSurfaceField('stucco', { seed: SEED, resolution: RES });
  const meanTangent = (strength) => {
    const image = dm.encodeNormalRGBA(field, { normalStrength: strength });
    let sum = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      const nx = (image.data[i] / 255) * 2 - 1;
      const ny = (image.data[i + 1] / 255) * 2 - 1;
      const nz = (image.data[i + 2] / 255) * 2 - 1;
      sum += Math.hypot(nx, ny) / Math.max(1e-6, nz);
    }
    return sum / (image.width * image.height);
  };
  const ratio = meanTangent(8) / meanTangent(4);
  assert(
    near(ratio, 2, 0.1),
    `stucco: doubling the relief amplitude doubles the encoded slope (ratio ${ratio.toFixed(3)})`,
  );
}

// The green channel must follow the OpenGL convention three.js expects.
{
  const field = dm.buildSurfaceField('brick', { seed: SEED, resolution: RES });
  const normal = dm.encodeNormalRGBA(field);
  const flipped = dm.encodeNormalRGBA(field, { flipGreen: true });
  let mirrored = true;
  for (let i = 1; i < normal.data.length; i += 4) {
    if (Math.abs((normal.data[i] - 128) + (flipped.data[i] - 128)) > 1) { mirrored = false; break; }
  }
  assert(mirrored, 'flipGreen mirrors the green channel (OpenGL vs DirectX convention is selectable)');
}

// ---------------------------------------------------------------------------
section('7. each class contains the structure its name claims');
// ---------------------------------------------------------------------------

const at = (className, u, v) => dm.sampleSurfaceField(className, u, v, { seed: SEED });
const brickDef = dm.getSurfaceDef('brick');

{
  // A course boundary is mortar; the middle of a course is brick face.
  const mortar = at('brick', 0.55, 0).height;
  const face = at('brick', 0.55, 0.5 / brickDef.courses).height;
  assert(face - mortar > 0.3, `brick: raked mortar course sits below the brick face (${mortar.toFixed(3)} vs ${face.toFixed(3)})`);
  const headJoint = at('brick', 0, 0.5 / brickDef.courses).height;
  assert(face - headJoint > 0.3, `brick: vertical head joint sits below the brick face (${headJoint.toFixed(3)} vs ${face.toFixed(3)})`);
  assert(brickDef.courses * 0.075 === brickDef.metresPerRepeat.y, 'brick: 32 courses of 75 mm fill the 2.4 m tile exactly');
  assert(brickDef.bricksPerCourse * 0.24 === brickDef.metresPerRepeat.x, 'brick: 10 bricks of 240 mm fill the 2.4 m tile exactly');
}

{
  const mullion = at('glass-curtain', 1 / 3, 0.5);
  const pane = at('glass-curtain', 1 / 6, 1 / 6);
  assert(mullion.height - pane.height > 0.4, `glass-curtain: the mullion stands proud of the glazing (${pane.height.toFixed(3)} -> ${mullion.height.toFixed(3)})`);
  assert(pane.roughness < 0.15, `glass-curtain: glazing is glossy (roughness ${pane.roughness.toFixed(3)})`);
  assert(mullion.roughness > 0.25, `glass-curtain: the aluminium mullion is not glossy (roughness ${mullion.roughness.toFixed(3)})`);
  assert(mullion.metalness > 0.5 && pane.metalness < 0.05, 'glass-curtain: the mullion is metal and the glazing is not');
}

{
  const score = at('sidewalk-concrete', 0.5, 0.25).height;
  const slab = at('sidewalk-concrete', 0.25, 0.25).height;
  assert(slab - score > 0.3, `sidewalk-concrete: score line is cut into the slab (${score.toFixed(3)} vs ${slab.toFixed(3)})`);
  const def = dm.getSurfaceDef('sidewalk-concrete');
  assert(def.metresPerRepeat.x / def.scoreLinesPerTile === 1.5, 'sidewalk-concrete: score lines land every 1.5 m');
}

{
  const joint = at('painted-concrete', 0, 0.25).height;
  const panel = at('painted-concrete', 0.5, 0.25).height;
  assert(panel - joint > 0.3, `painted-concrete: form joint is recessed (${joint.toFixed(3)} vs ${panel.toFixed(3)})`);
}

{
  const field = dm.buildSurfaceField('asphalt', { seed: SEED, resolution: RES });
  const roughness = fieldStats(field.roughnessField);
  const metalness = fieldStats(field.metalnessField);
  assert(roughness.mean > 0.8, `asphalt: reads as a rough dielectric (mean roughness ${roughness.mean.toFixed(3)})`);
  assert(metalness.max === 0, 'asphalt: is never metallic');
}

{
  const field = dm.buildSurfaceField('stucco', { seed: SEED, resolution: RES });
  assert(fieldStats(field.roughnessField).mean > 0.8, 'stucco: reads as a rough dielectric');
  assert(fieldStats(field.metalnessField).max === 0, 'stucco: is never metallic');
}

{
  const field = dm.buildSurfaceField('dirty-metal', { seed: SEED, resolution: RES });
  const metalness = fieldStats(field.metalnessField);
  assert(metalness.mean > 0.5, `dirty-metal: is mostly metallic (mean ${metalness.mean.toFixed(3)})`);
  assert(metalness.max > 0.8, 'dirty-metal: has clean metal');
  assert(metalness.min < 0.4, 'dirty-metal: has corroded, non-metallic patches');
}

// ---------------------------------------------------------------------------
section('8. weathering');
// ---------------------------------------------------------------------------

{
  let monotonic = true;
  let inRange = true;
  let previous = Infinity;
  for (let metres = 0; metres <= 40; metres += 0.1) {
    const grime = dm.grimeAmount(metres);
    if (grime > previous + 1e-12) monotonic = false;
    if (!(grime >= 0 && grime <= 1)) inRange = false;
    previous = grime;
  }
  assert(monotonic, 'grime never increases with height above the facade base');
  assert(inRange, 'grime stays inside [0,1]');
  assert(
    dm.grimeAmount(0) - dm.grimeAmount(20) > 0.5,
    `a facade base is far dirtier than its top (${dm.grimeAmount(0).toFixed(3)} vs ${dm.grimeAmount(20).toFixed(3)})`,
  );
  assert(
    dm.grimeAmount(3, { falloffMetres: 14 }) > dm.grimeAmount(3, { falloffMetres: 4 }),
    'a longer falloff carries grime further up the wall',
  );

  let periodic = true;
  for (let i = 0; i <= 32; i += 1) {
    const metres = i * 0.7;
    if (dm.sampleGrimeField(0, metres) !== dm.sampleGrimeField(1, metres)) periodic = false;
  }
  assert(periodic, 'the grime drip field is bit-identical at u=0 and u=1, so facades still tile horizontally');

  assert(dm.grimeAlbedoScale(1) < 1 && dm.grimeAlbedoScale(0) === 1, 'grime darkens albedo at the base and leaves a clean top untouched');
  assert(dm.grimeRoughness(0.3, 1) > 0.3 && dm.grimeRoughness(0.3, 0) === 0.3, 'grime raises roughness and never lowers it');
  assert(dm.grimeRoughness(1, 1) <= 1, 'grime-boosted roughness never exceeds 1');
  assert(
    dm.grimeVertexColorScale(0) < dm.grimeVertexColorScale(20),
    'the vertex-colour helper darkens the base more than the top',
  );

  const g1 = dm.buildGrimeImageRGBA({ seed: 7, width: 16, height: 32, wallHeightMetres: 18 });
  const g2 = dm.buildGrimeImageRGBA({ seed: 7, width: 16, height: 32, wallHeightMetres: 18 });
  assert(sameBytes(g1.data, g2.data), 'the grime ramp image is deterministic');
  const topRow = g1.data[0];
  const bottomRow = g1.data[(g1.height - 1) * g1.width * 4];
  assert(bottomRow > topRow, `the grime ramp is dirtiest on its last row, i.e. the wall base (${topRow} -> ${bottomRow})`);

  // Multiplying grime into an albedo image must darken the base, not the top.
  const albedo = { width: 4, height: 8, data: new Uint8ClampedArray(4 * 8 * 4).fill(200) };
  dm.applyGrimeToAlbedoImage(albedo, { wallHeightMetres: 18 });
  assert(
    albedo.data[(7 * 4) * 4] < albedo.data[0] && albedo.data[0] <= 200,
    `applyGrimeToAlbedoImage darkens the wall base more than its top (${albedo.data[0]} -> ${albedo.data[(7 * 4) * 4]})`,
  );

  const orm = { width: 4, height: 8, data: new Uint8ClampedArray(4 * 8 * 4).fill(120) };
  dm.applyGrimeToOrmImage(orm, { wallHeightMetres: 18 });
  assert(
    orm.data[(7 * 4) * 4 + 1] > orm.data[1] && orm.data[0] === 120,
    'applyGrimeToOrmImage raises only the roughness channel, and only near the base',
  );
}

// ---------------------------------------------------------------------------
section('9. textures, colour space and caching');
// ---------------------------------------------------------------------------

assert(!dm.hasCanvasSupport(), 'no canvas exists under plain node, so the DataTexture fallback is what runs here');
assert(!/SRGBColorSpace/.test(source), 'the module never mentions SRGBColorSpace: these maps are data, not colour');

dm.clearDetailMapCache();
{
  const bundle = dm.getDetailMaps('brick', { seed: SEED, resolution: RES });
  const again = dm.getDetailMaps('brick', { seed: SEED, resolution: RES });
  assert(bundle === again, 'a repeated request returns the very same bundle, so textures are generated once and shared');
  assert(bundle.normalMap === again.normalMap, 'the shared bundle hands back the same normal texture object');
  assert(dm.detailMapCacheStats().bundles === 1, 'the cache holds exactly one bundle after two identical requests');

  dm.getDetailMaps('brick', { seed: 'a-different-seed', resolution: RES });
  assert(dm.detailMapCacheStats().bundles === 2, 'a different seed is cached separately');

  for (const [name, texture] of [['normal', bundle.normalMap], ['ORM', bundle.ormMap]]) {
    assert(texture.colorSpace === THREE.NoColorSpace, `${name} map is NoColorSpace (never sRGB)`);
    assert(
      texture.wrapS === THREE.RepeatWrapping && texture.wrapT === THREE.RepeatWrapping,
      `${name} map repeats in both axes`,
    );
    assert(texture.generateMipmaps === true, `${name} map generates mipmaps (no grazing-angle shimmer)`);
    assert(texture.minFilter === THREE.LinearMipmapLinearFilter, `${name} map filters trilinearly`);
    assert(texture.anisotropy === dm.DETAIL_TEXTURE_DEFAULTS.anisotropy, `${name} map carries the declared anisotropy`);
    assert(texture.channel === 0, `${name} map reads UV channel 0, so no second UV set is required`);
  }
  assert(bundle.roughnessMap === bundle.ormMap && bundle.aoMap === bundle.ormMap && bundle.metalnessMap === bundle.ormMap,
    'AO, roughness and metalness share one packed ORM texture');
  assert(bundle.normalMap.isDataTexture === true, 'the headless path produced a DataTexture');
  assert(bundle.normalMap.flipY === false, 'the DataTexture path disables flipY because its rows are pre-flipped');
  assert(bundle.normalScale.x === 1 && bundle.normalScale.y === 1, 'normalScale is a clean 1.0 dial (exaggeration is already baked)');

  const expected = dm.getSurfaceDef('brick').metresPerRepeat;
  assert(
    bundle.metresPerRepeat.x === expected.x && bundle.uvScalePerMetre.x === 1 / expected.x,
    'the bundle publishes both the metres-per-repeat and the repeats-per-metre convention',
  );
}

{
  const repeat = dm.repeatForSurface('brick', 12, 9);
  assert(repeat.x === 5 && repeat.y === 3.75, `a 12 x 9 m brick wall repeats 5 x 3.75 times (got ${repeat.x} x ${repeat.y})`);
  const scale = dm.uvScalePerMetre('sidewalk-concrete');
  assert(near(scale.x, 1 / 3, 1e-12), 'sidewalk UVs baked in metres scale by 1/3 per metre');
}

{
  const material = new THREE.MeshStandardMaterial();
  const bundle = dm.applyDetailMaps(material, 'brick', { seed: SEED, resolution: RES, widthMetres: 12, heightMetres: 9 });
  assert(material.normalMap && material.roughnessMap && material.aoMap && material.metalnessMap,
    'applyDetailMaps fills the normal, roughness, AO and metalness slots');
  assert(material.normalMapType === THREE.TangentSpaceNormalMap, 'applyDetailMaps declares a tangent-space normal map');
  assert(material.roughness === 1 && material.metalness === 1,
    'applyDetailMaps neutralises the scalar factors so the packed map values survive the multiply');
  assert(
    material.normalMap.repeat.x === 5 && material.normalMap.repeat.y === 3.75,
    'applyDetailMaps sets the repeat from the real-world surface size',
  );
  assert(bundle.normalMap.repeat.x === 1, 'the shared base texture keeps repeat 1 and is never mutated by a caller');
  assert(material.normalMap.source === bundle.normalMap.source,
    'the repeat variant shares the base texture source, so the pixels upload once');
  const material2 = new THREE.MeshStandardMaterial();
  dm.applyDetailMaps(material2, 'brick', { seed: SEED, resolution: RES, widthMetres: 12, heightMetres: 9 });
  assert(material2.normalMap === material.normalMap, 'an identical repeat reuses the cached variant instead of cloning again');

  const material3 = new THREE.MeshStandardMaterial();
  dm.applyDetailMaps(material3, 'brick', { seed: SEED, resolution: RES, uvsAreMetres: true });
  assert(
    near(material3.normalMap.repeat.x, 1 / 2.4, 1e-12),
    'UVs already baked in metres get the repeats-per-metre scale instead',
  );
}

// ---------------------------------------------------------------------------
section('10. the canvas path agrees with the DataTexture path');
// ---------------------------------------------------------------------------

{
  // Tiny stub standing in for OffscreenCanvas. No dependency, no DOM.
  class StubCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.imageData = null;
    }

    getContext() {
      const canvas = this;
      return {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (image) => { canvas.imageData = image; },
      };
    }
  }

  assert(dm.hasCanvasSupport() === false, 'canvas support is absent before the stub is installed');
  globalThis.OffscreenCanvas = StubCanvas;
  try {
    assert(dm.hasCanvasSupport() === true, 'canvas support is detected once a canvas constructor exists');
    const images = dm.buildDetailImages('brick', { seed: SEED, resolution: RES });
    const canvasTexture = dm.createDetailTexture(images.normal, { preferCanvas: true });
    const dataTexture = dm.createDetailTexture(images.normal, { preferCanvas: false });

    assert(canvasTexture.isCanvasTexture === true, 'a canvas produces a THREE.CanvasTexture');
    assert(canvasTexture.colorSpace === THREE.NoColorSpace, 'the CanvasTexture is NoColorSpace too');
    assert(canvasTexture.flipY === true, 'the CanvasTexture keeps flipY, so canvas row 0 lands at v=1');
    assert(
      sameBytes(canvasTexture.image.imageData.data, images.normal.data),
      'the canvas receives the encoded image top row first',
    );

    const rowBytes = images.normal.width * 4;
    const lastRow = images.normal.data.subarray((images.normal.height - 1) * rowBytes, images.normal.height * rowBytes);
    const dataFirstRow = dataTexture.image.data.subarray(0, rowBytes);
    assert(
      sameBytes(lastRow, dataFirstRow),
      'the DataTexture pre-flips its rows, so both paths sample identically for the same UV',
    );
    canvasTexture.dispose();
    dataTexture.dispose();
  } finally {
    delete globalThis.OffscreenCanvas;
  }
  assert(dm.hasCanvasSupport() === false, 'canvas detection is re-evaluated per call, never cached at import');
}

// ---------------------------------------------------------------------------
section('11. cache disposal');
// ---------------------------------------------------------------------------

{
  dm.getGrimeTexture({ seed: 3, width: 8, height: 16 });
  const before = dm.detailMapCacheStats();
  assert(before.bundles > 0, `bundles are cached before disposal (${before.bundles})`);
  dm.disposeAllDetailMaps();
  const after = dm.detailMapCacheStats();
  assert(after.bundles === 0 && after.textures === 0 && after.variants === 0, 'disposeAllDetailMaps frees every cached texture');
  const rebuilt = dm.getDetailMaps('brick', { seed: SEED, resolution: RES });
  assert(rebuilt.normalMap.image.data.length === RES * RES * 4, 'the cache rebuilds correctly after disposal');
  dm.disposeAllDetailMaps();
}

// ---------------------------------------------------------------------------
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log('\nFailed:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
