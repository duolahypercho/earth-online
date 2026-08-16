function glslColor(color) {
  return color.toArray().map((channel) => channel.toFixed(6)).join(', ');
}

function paletteGlsl(palette, selector, { hash = false } = {}) {
  return palette.map((color, index) => {
    const tone = `vec3(${glslColor(color)})`;
    if (index === palette.length - 1) return tone;
    const threshold = hash ? ((index + 1) / palette.length).toFixed(2) : (index + 0.5).toFixed(1);
    return `${selector} < ${threshold} ? ${tone} : `;
  }).join('');
}

function paletteIdentity(palette) {
  return palette.map((color) => color.getHexString()).join('-');
}

const LEGACY_BUILDING_PALETTE_ID_V1 = 'c7ad8a-aa765c-77858c-8b6456';
const LEGACY_BUILDING_GRID_METRES_V1 = 62;

function legacyBuildingPaletteGlsl(palette) {
  return palette.map((color, index) => {
    const tone = `vec3(${glslColor(color)})`;
    if (index === palette.length - 1) return tone;
    return `sfToneHash < ${((index + 1) / palette.length).toFixed(2)} ? ${tone} : `;
  }).join('');
}

export const SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1 = Object.freeze({
  id: 'source-tone-legacy-grid-boundary-mask-v1',
  tileSizeMetres: 384,
  exactMatchBandMetres: 4,
  blendBandMetres: 16,
  legacyGridCellMetres: 62,
});

function legacyGridToneGlsl(palette, cellMetres, name = 'sfLegacyGridTone') {
  return `
  vec2 sfLegacyGridCell = floor(vSfMapWorldPosition.xz / ${cellMetres.toFixed(1)});
  float sfLegacyGridHash = fract(sin(dot(sfLegacyGridCell, vec2(127.1, 311.7))) * 43758.5453123);
  vec3 ${name} = ${paletteGlsl(palette, 'sfLegacyGridHash', { hash: true })};`;
}

function legacySurfaceResponseGlsl() {
  // Keep this string aligned with the original live legacy presentation. It
  // intentionally uses Three's material normal rather than a derivative
  // normal, so the edge substitution can be pixel-identical to production.
  return `
  // This is normal-driven material response, not fabricated facade detail:
  // roofs remain readable against vertical walls before the real shadow pass.
  float sfRoofFacing = smoothstep(0.16, 0.84, abs(normal.y));
  diffuseColor.rgb *= mix(0.72, 1.08, sfRoofFacing);`;
}

function sourceSurfaceResponseGlsl() {
  return `
  vec3 sfDx = dFdx(vSfMapWorldPosition);
  vec3 sfDy = dFdy(vSfMapWorldPosition);
  vec3 sfWorldFaceNormal = normalize(cross(sfDx, sfDy));
  float sfSourceRoofFacing = smoothstep(0.5, 0.9, abs(sfWorldFaceNormal.y));
  float sfFacadeFacing = abs(dot(normalize(sfWorldFaceNormal.xz + vec2(0.00001)), normalize(vec2(-0.79, 0.61))));
  float sfFacadeContrast = mix(0.52, 1.26, pow(sfFacadeFacing, 0.75));
  float sfSourceSurfaceResponse = mix(sfFacadeContrast, 1.1232, sfSourceRoofFacing);`;
}

function legacySurfaceResponseValueGlsl() {
  return `
  float sfLegacyRoofFacing = smoothstep(0.16, 0.84, abs(normal.y));
  float sfLegacySurfaceResponse = mix(0.72, 1.08, sfLegacyRoofFacing);`;
}

/**
 * The exact current production legacy building material. Keep the generated
 * shader injection and cache key stable: the map's 803 production tiles still
 * use this renderer-side presentation without a manifest or GLB change.
 */
export function applyLegacyBuildingPresentation(material, { palette, paletteWorldCellMetres } = {}) {
  if (!Array.isArray(palette) || palette.length !== 4) throw new Error('SF building presentation requires the reviewed four-tone palette');
  if (paletteIdentity(palette) !== LEGACY_BUILDING_PALETTE_ID_V1 || paletteWorldCellMetres !== LEGACY_BUILDING_GRID_METRES_V1) throw new Error('SF building legacy presentation inputs do not match the fixed v1 shader cache identity');
  material.color.setHex(0xffffff);
  material.roughness = 0.9;
  material.metalness = 0;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying vec3 vSfMapWorldPosition;\n${shader.vertexShader}`
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  // Three only declares worldPosition when a built-in feature needs it.
  // The palette needs it for every building material, including unshadowed
  // Plan frames, so retain the identical transform under its own identifier.
  vec4 sfMapWorldPosition = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    sfMapWorldPosition = batchingMatrix * sfMapWorldPosition;
  #endif
  #ifdef USE_INSTANCING
    sfMapWorldPosition = instanceMatrix * sfMapWorldPosition;
  #endif
  sfMapWorldPosition = modelMatrix * sfMapWorldPosition;
  vSfMapWorldPosition = sfMapWorldPosition.xyz;`);
    shader.fragmentShader = `varying vec3 vSfMapWorldPosition;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
  // World-coordinate cells keep palette choice deterministic across tile
  // seams while leaving all source positions and geometry untouched.
  vec2 sfToneCell = floor(vSfMapWorldPosition.xz / ${paletteWorldCellMetres.toFixed(1)});
  float sfToneHash = fract(sin(dot(sfToneCell, vec2(127.1, 311.7))) * 43758.5453123);
  vec3 sfBuildingTone = ${legacyBuildingPaletteGlsl(palette)};
  diffuseColor.rgb *= sfBuildingTone;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${legacySurfaceResponseGlsl()}`);
  };
  material.customProgramCacheKey = () => 'sf-map-building-palette-v1';
  material.needsUpdate = true;
}

function normalizeBoundaryMask(boundaryMask, palette) {
  if (boundaryMask === undefined) return null;
  const base = SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1;
  if (!boundaryMask || boundaryMask.id !== base.id) throw new Error('source-tone-v1 boundary mask identity is not recognized');
  const tileSizeMetres = boundaryMask.tileSizeMetres ?? base.tileSizeMetres;
  const exactMatchBandMetres = boundaryMask.exactMatchBandMetres ?? base.exactMatchBandMetres;
  const blendBandMetres = boundaryMask.blendBandMetres ?? base.blendBandMetres;
  const legacyGridCellMetres = boundaryMask.legacyGridCellMetres ?? base.legacyGridCellMetres;
  const sceneTileOriginMetres = boundaryMask.sceneTileOriginMetres;
  const sides = [...new Set(boundaryMask.sides ?? [])].sort();
  if (!Array.isArray(sceneTileOriginMetres) || sceneTileOriginMetres.length !== 2 || !sceneTileOriginMetres.every(Number.isFinite)) throw new Error('source-tone-v1 boundary mask requires a finite scene tile x/z origin');
  if (!sides.length || !sides.every((side) => ['west', 'south', 'east', 'north'].includes(side))) throw new Error('source-tone-v1 boundary mask requires one or more cardinal tile sides');
  if (![tileSizeMetres, exactMatchBandMetres, blendBandMetres, legacyGridCellMetres].every(Number.isFinite) || tileSizeMetres <= 0 || exactMatchBandMetres < 0 || blendBandMetres <= exactMatchBandMetres || legacyGridCellMetres <= 0) throw new Error('source-tone-v1 boundary mask metres are invalid');
  if (!Array.isArray(boundaryMask.legacyPalette) || boundaryMask.legacyPalette.length !== palette.length) throw new Error('source-tone-v1 boundary mask requires the reviewed legacy palette');
  return Object.freeze({ id: base.id, tileSizeMetres, exactMatchBandMetres, blendBandMetres, legacyGridCellMetres, sceneTileOriginMetres: [...sceneTileOriginMetres], sides, legacyPalette: boundaryMask.legacyPalette });
}

function boundarySideDistanceGlsl(boundaryMask, side) {
  const [originX, originZ] = boundaryMask.sceneTileOriginMetres.map((value) => value.toFixed(6));
  const tileSize = boundaryMask.tileSizeMetres.toFixed(6);
  const sides = {
    west: `vSfMapWorldPosition.x - ${originX}`,
    south: `vSfMapWorldPosition.z - ${originZ}`,
    east: `${tileSize} - (vSfMapWorldPosition.x - ${originX})`,
    north: `${tileSize} - (vSfMapWorldPosition.z - ${originZ})`,
  };
  return `max(0.0, ${sides[side]})`;
}

function boundaryDistanceGlsl(boundaryMask) {
  return boundaryMask.sides
    .map((side) => boundarySideDistanceGlsl(boundaryMask, side))
    .reduce((closest, distance) => (closest === null ? distance : `min(${closest}, ${distance})`), null);
}

export function applySourceToneBuildingPresentation(material, {
  palette,
  policySha256,
  legacyGridCellMetres = SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1.legacyGridCellMetres,
  boundaryMask,
  qaExactBoundaryMask = false,
} = {}) {
  if (!Array.isArray(palette) || palette.length !== 4) throw new Error('SF building presentation requires the reviewed four-tone palette');
  if (!Number.isFinite(legacyGridCellMetres) || legacyGridCellMetres <= 0) throw new Error('SF building legacy grid cell metres are invalid');
  if (!/^sha256:[a-f0-9]{64}$/i.test(policySha256 || '')) throw new Error('source-tone-v1 requires a SHA-256 policy identity');
  const normalizedBoundaryMask = normalizeBoundaryMask(boundaryMask, palette);
  if (qaExactBoundaryMask && !normalizedBoundaryMask) throw new Error('source-tone-v1 QA boundary mask requires a boundary policy');
  if (normalizedBoundaryMask) {
    // Preserve the live legacy program verbatim at the mixed-mode edge. The
    // source presentation is expressed as a ratio over that exact shader, so
    // the zero-weight band multiplies both tone and surface response by 1.
    // This is stricter than reimplementing an algebraically equivalent legacy
    // branch, whose extra shader expressions can still perturb raster output.
    applyLegacyBuildingPresentation(material, {
      palette: normalizedBoundaryMask.legacyPalette,
      paletteWorldCellMetres: normalizedBoundaryMask.legacyGridCellMetres,
    });
    const compileLegacy = material.onBeforeCompile;
    const boundaryDistance = boundaryDistanceGlsl(normalizedBoundaryMask);
    material.onBeforeCompile = (shader) => {
      compileLegacy(shader);
      if (qaExactBoundaryMask) {
        shader.uniforms.sfQaExactBoundaryMask = { value: 0 };
        material.userData.sfQaExactBoundaryMaskUniform = shader.uniforms.sfQaExactBoundaryMask;
        material.userData.sfQaExactBoundaryMaskSides = Object.fromEntries(normalizedBoundaryMask.sides.map((side, index) => [side, index + 1]));
      }
      shader.vertexShader = `attribute float _sf_source_tone_v1;\nvarying float vSfSourceTone;\n${shader.vertexShader}`
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vSfSourceTone = _sf_source_tone_v1;`);
      shader.fragmentShader = `varying float vSfSourceTone;\n${shader.fragmentShader}`
        .replace('#include <color_fragment>', `#include <color_fragment>
  float sfSourceTone = clamp(floor(vSfSourceTone + 0.5), 0.0, 3.0);
  vec3 sfSourceToneColor = ${paletteGlsl(palette, 'sfSourceTone')};
  ${legacyGridToneGlsl(normalizedBoundaryMask.legacyPalette, normalizedBoundaryMask.legacyGridCellMetres, 'sfBoundaryLegacyTone')}
  float sfBoundaryDistance = ${boundaryDistance};
  float sfBoundarySourceWeight = sfBoundaryDistance <= ${normalizedBoundaryMask.exactMatchBandMetres.toFixed(6)}
    ? 0.0
    : smoothstep(${normalizedBoundaryMask.exactMatchBandMetres.toFixed(6)}, ${normalizedBoundaryMask.blendBandMetres.toFixed(6)}, sfBoundaryDistance);
  diffuseColor.rgb *= mix(vec3(1.0), sfSourceToneColor / max(sfBoundaryLegacyTone, vec3(0.000001)), sfBoundarySourceWeight);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  ${legacySurfaceResponseValueGlsl()}
  ${sourceSurfaceResponseGlsl()}
  diffuseColor.rgb *= mix(vec3(1.0), vec3(sfSourceSurfaceResponse / max(sfLegacySurfaceResponse, 0.000001)), sfBoundarySourceWeight);`);
      if (qaExactBoundaryMask) {
        const qaSideDistance = normalizedBoundaryMask.sides
          .map((side, index) => ({ threshold: index + 1.5, distance: boundarySideDistanceGlsl(normalizedBoundaryMask, side) }))
          .reduceRight((expression, entry) => `sfQaExactBoundaryMask < ${entry.threshold.toFixed(1)} ? ${entry.distance} : (${expression})`, boundarySideDistanceGlsl(normalizedBoundaryMask, normalizedBoundaryMask.sides.at(-1)));
        shader.fragmentShader = `uniform float sfQaExactBoundaryMask;\n${shader.fragmentShader}`
        .replace('#include <opaque_fragment>', `float sfQaBoundarySideDistance = ${qaSideDistance};
  #include <opaque_fragment>`)
        .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
  if (sfQaExactBoundaryMask > 0.5) gl_FragColor = sfQaBoundarySideDistance <= ${normalizedBoundaryMask.exactMatchBandMetres.toFixed(6)}
    ? vec4(1.0, 0.0, 0.0, 1.0)
    : vec4(0.0, 0.0, 1.0, 1.0);`);
      }
    };
    const boundaryKey = `:${normalizedBoundaryMask.id}:${normalizedBoundaryMask.sceneTileOriginMetres.join(',')}:${normalizedBoundaryMask.sides.join(',')}:${normalizedBoundaryMask.tileSizeMetres}:${normalizedBoundaryMask.exactMatchBandMetres}:${normalizedBoundaryMask.blendBandMetres}:${normalizedBoundaryMask.legacyGridCellMetres}:${paletteIdentity(normalizedBoundaryMask.legacyPalette)}`;
    material.customProgramCacheKey = () => `sf-map-building-source-tone-v1:${policySha256}:${paletteIdentity(palette)}:${legacyGridCellMetres}${boundaryKey}${qaExactBoundaryMask ? ':qa-exact-boundary-mask' : ''}`;
    material.needsUpdate = true;
    return;
  }
  const sourceToneGlsl = `
  float sfSourceTone = clamp(floor(vSfSourceTone + 0.5), 0.0, 3.0);
  vec3 sfSourceToneColor = ${paletteGlsl(palette, 'sfSourceTone')};`;
  material.color.setHex(0xffffff);
  material.roughness = 0.9;
  material.metalness = 0;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float _sf_source_tone_v1;\nvarying float vSfSourceTone;\nvarying vec3 vSfMapWorldPosition;\n${shader.vertexShader}`
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vec4 sfMapWorldPosition = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    sfMapWorldPosition = batchingMatrix * sfMapWorldPosition;
  #endif
  #ifdef USE_INSTANCING
    sfMapWorldPosition = instanceMatrix * sfMapWorldPosition;
  #endif
  sfMapWorldPosition = modelMatrix * sfMapWorldPosition;
  vSfMapWorldPosition = sfMapWorldPosition.xyz;
  vSfSourceTone = _sf_source_tone_v1;`);
    shader.fragmentShader = `varying float vSfSourceTone;\nvarying vec3 vSfMapWorldPosition;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
  ${sourceToneGlsl}
  diffuseColor.rgb *= sfSourceToneColor;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${sourceSurfaceResponseGlsl()}
  diffuseColor.rgb *= sfSourceSurfaceResponse;`);
  };
  material.customProgramCacheKey = () => `sf-map-building-source-tone-v1:${policySha256}:${paletteIdentity(palette)}:${legacyGridCellMetres}`;
  material.needsUpdate = true;
}

export function applyLegacyGridBuildingPresentation(material, { palette, legacyGridCellMetres } = {}) {
  applyLegacyBuildingPresentation(material, { palette, paletteWorldCellMetres: legacyGridCellMetres });
}
