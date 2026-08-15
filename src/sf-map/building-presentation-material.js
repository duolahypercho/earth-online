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

function boundaryDistanceGlsl(boundaryMask) {
  const [originX, originZ] = boundaryMask.sceneTileOriginMetres.map((value) => value.toFixed(6));
  const tileSize = boundaryMask.tileSizeMetres.toFixed(6);
  const sides = {
    west: `vSfMapWorldPosition.x - ${originX}`,
    south: `vSfMapWorldPosition.z - ${originZ}`,
    east: `${tileSize} - (vSfMapWorldPosition.x - ${originX})`,
    north: `${tileSize} - (vSfMapWorldPosition.z - ${originZ})`,
  };
  return boundaryMask.sides
    .map((side) => `max(0.0, ${sides[side]})`)
    .reduce((closest, distance) => (closest === null ? distance : `min(${closest}, ${distance})`), null);
}

// Canonical QA/runtime surface response. Both palette sources deliberately
// share world coordinates and derivative normals, so a boundary substitutes
// only its palette without accidentally changing illumination response.
export function applyCanonicalWorldSpaceBuildingPresentation(material, {
  palette,
  paletteMode,
  policySha256,
  legacyGridCellMetres = SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1.legacyGridCellMetres,
  boundaryMask,
} = {}) {
  if (!Array.isArray(palette) || palette.length !== 4) throw new Error('SF building presentation requires the reviewed four-tone palette');
  if (!['legacy-grid-v1', 'source-tone-v1'].includes(paletteMode)) throw new Error('SF building presentation palette mode is not recognized');
  if (!Number.isFinite(legacyGridCellMetres) || legacyGridCellMetres <= 0) throw new Error('SF building legacy grid cell metres are invalid');
  if (paletteMode === 'source-tone-v1' && !/^sha256:[a-f0-9]{64}$/i.test(policySha256 || '')) throw new Error('source-tone-v1 requires a SHA-256 policy identity');
  if (paletteMode === 'legacy-grid-v1' && boundaryMask !== undefined) throw new Error('legacy-grid-v1 does not accept a source-tone boundary mask');
  const normalizedBoundaryMask = paletteMode === 'source-tone-v1' ? normalizeBoundaryMask(boundaryMask, palette) : null;
  const sourceToneAttribute = paletteMode === 'source-tone-v1';
  const sourceToneGlsl = sourceToneAttribute ? `
  float sfSourceTone = clamp(floor(vSfSourceTone + 0.5), 0.0, 3.0);
  vec3 sfSourceToneColor = ${paletteGlsl(palette, 'sfSourceTone')};` : '';
  const gridToneGlsl = legacyGridToneGlsl(normalizedBoundaryMask ? normalizedBoundaryMask.legacyPalette : palette, normalizedBoundaryMask ? normalizedBoundaryMask.legacyGridCellMetres : legacyGridCellMetres);
  const boundaryGlsl = normalizedBoundaryMask ? `
  float sfBoundaryDistance = ${boundaryDistanceGlsl(normalizedBoundaryMask)};
  float sfBoundaryLegacyWeight = 1.0 - smoothstep(${normalizedBoundaryMask.exactMatchBandMetres.toFixed(6)}, ${normalizedBoundaryMask.blendBandMetres.toFixed(6)}, sfBoundaryDistance);` : '';
  const buildingTone = sourceToneAttribute ? (normalizedBoundaryMask ? 'mix(sfSourceToneColor, sfLegacyGridTone, sfBoundaryLegacyWeight)' : 'sfSourceToneColor') : 'sfLegacyGridTone';
  material.color.setHex(0xffffff);
  material.roughness = 0.9;
  material.metalness = 0;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `${sourceToneAttribute ? 'attribute float _sf_source_tone_v1;\n' : ''}${sourceToneAttribute ? 'varying float vSfSourceTone;\n' : ''}varying vec3 vSfMapWorldPosition;\n${shader.vertexShader}`
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vec4 sfMapWorldPosition = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    sfMapWorldPosition = batchingMatrix * sfMapWorldPosition;
  #endif
  #ifdef USE_INSTANCING
    sfMapWorldPosition = instanceMatrix * sfMapWorldPosition;
  #endif
  sfMapWorldPosition = modelMatrix * sfMapWorldPosition;
  vSfMapWorldPosition = sfMapWorldPosition.xyz;${sourceToneAttribute ? '\n  vSfSourceTone = _sf_source_tone_v1;' : ''}`);
    shader.fragmentShader = `${sourceToneAttribute ? 'varying float vSfSourceTone;\n' : ''}varying vec3 vSfMapWorldPosition;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
  ${sourceToneGlsl}
  ${gridToneGlsl}
  ${boundaryGlsl}
  diffuseColor.rgb *= ${buildingTone};`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  vec3 sfDx = dFdx(vSfMapWorldPosition);
  vec3 sfDy = dFdy(vSfMapWorldPosition);
  vec3 sfWorldFaceNormal = normalize(cross(sfDx, sfDy));
  float sfRoofFacing = smoothstep(0.5, 0.9, abs(sfWorldFaceNormal.y));
  float sfFacadeFacing = abs(dot(normalize(sfWorldFaceNormal.xz + vec2(0.00001)), normalize(vec2(-0.79, 0.61))));
  float sfFacadeContrast = mix(0.52, 1.26, pow(sfFacadeFacing, 0.75));
  float sfCanonicalSurfaceResponse = mix(sfFacadeContrast, 1.1232, sfRoofFacing);
  diffuseColor.rgb *= sfCanonicalSurfaceResponse;`);
  };
  const boundaryKey = normalizedBoundaryMask
    ? `:${normalizedBoundaryMask.id}:${normalizedBoundaryMask.sceneTileOriginMetres.join(',')}:${normalizedBoundaryMask.sides.join(',')}:${normalizedBoundaryMask.tileSizeMetres}:${normalizedBoundaryMask.exactMatchBandMetres}:${normalizedBoundaryMask.blendBandMetres}:${normalizedBoundaryMask.legacyGridCellMetres}:${paletteIdentity(normalizedBoundaryMask.legacyPalette)}`
    : '';
  material.customProgramCacheKey = () => (sourceToneAttribute
    ? `sf-map-building-source-tone-v1:${policySha256}:${paletteIdentity(palette)}:${legacyGridCellMetres}${boundaryKey}`
    : `sf-map-building-world-surface-v1:${paletteMode}:${paletteIdentity(palette)}:${legacyGridCellMetres}${boundaryKey}`);
  material.needsUpdate = true;
}

export function applyLegacyGridBuildingPresentation(material, { palette, legacyGridCellMetres } = {}) {
  applyCanonicalWorldSpaceBuildingPresentation(material, { palette, paletteMode: 'legacy-grid-v1', legacyGridCellMetres });
}

export function applySourceToneBuildingPresentation(material, { palette, policySha256, boundaryMask } = {}) {
  applyCanonicalWorldSpaceBuildingPresentation(material, { palette, paletteMode: 'source-tone-v1', policySha256, boundaryMask });
}
