function glslColor(color) {
  return color.toArray().map((channel) => channel.toFixed(6)).join(', ');
}

function sourceTonePaletteGlsl(palette) {
  return palette.map((color, index) => {
    const tone = `vec3(${glslColor(color)})`;
    if (index === palette.length - 1) return tone;
    return `sfSourceTone < ${(index + 0.5).toFixed(1)} ? ${tone} : `;
  }).join('');
}

export function applySourceToneBuildingPresentation(material, { palette, policySha256 }) {
  if (!Array.isArray(palette) || palette.length !== 4) throw new Error('source-tone-v1 requires the reviewed four-tone palette');
  if (!/^sha256:[a-f0-9]{64}$/i.test(policySha256 || '')) throw new Error('source-tone-v1 requires a SHA-256 policy identity');
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
  float sfSourceTone = clamp(floor(vSfSourceTone + 0.5), 0.0, 3.0);
  vec3 sfBuildingTone = ${sourceTonePaletteGlsl(palette)};
  diffuseColor.rgb *= sfBuildingTone;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  vec3 sfDx = dFdx(vSfMapWorldPosition);
  vec3 sfDy = dFdy(vSfMapWorldPosition);
  vec3 sfWorldFaceNormal = normalize(cross(sfDx, sfDy));
  float sfRoofFacing = smoothstep(0.5, 0.9, abs(sfWorldFaceNormal.y));
  float sfFacadeFacing = abs(dot(normalize(sfWorldFaceNormal.xz + vec2(0.00001)), normalize(vec2(-0.79, 0.61))));
  float sfFacadeContrast = mix(0.52, 1.26, pow(sfFacadeFacing, 0.75));
  diffuseColor.rgb *= mix(sfFacadeContrast, 1.1232, sfRoofFacing);`);
  };
  material.customProgramCacheKey = () => `sf-map-building-source-tone-v1:${policySha256}`;
  material.needsUpdate = true;
}
