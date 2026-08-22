// The canonical route's image pipeline.
//
// Until this module existed, `CityRenderer.renderFrame()` was a bare
// `renderer.render(scene, camera)`: the radiometric half of the stack (solar
// model, PMREM'd sky IBL, measured key/fill balance, illuminance-driven
// exposure) was complete, and the image half was absent. There was no ambient
// occlusion, no contact darkening, no resolve-time anti-aliasing, and the only
// colour grade in the build sat on the canvas as a CSS `filter` - outside
// colour management and invisible to every pixel readback we have taken.
//
// This is that missing stage, built entirely from three's first-party TSL node
// post-processing. It introduces no `ShaderMaterial` and no `onBeforeCompile`
// dependency, which AGENTS.md forbids on the canonical path.
//
// Graph, in order:
//
//   pass(scene, camera)                 scene -> HDR, working colour space
//     MRT { output, normal }            (only while AO is on)
//     samples = renderer.samples        MSAA is preserved, see MSAA note below
//        |
//   ao(depth, normal, camera)           GTAO, half resolution, metric radius
//        |  .mul into colour            sky is excluded by construction
//        |
//   renderOutput(colour)                ACES tone map + exposure + sRGB encode
//        |                              (reads the renderer's own settings)
//   grade(saturation, contrast, ...)    display-referred, was the CSS filter
//        |
//   smaa() | fxaa() | none              resolve-time AA, sRGB input
//        |
//   canvas
//
// MSAA NOTE. The round-3 audit recorded "antialias: true is producing no
// resolve in the delivered frame". Measured against the delivered frames, that
// is not what the pixels say: on strict silhouettes (six flat pixels either
// side of a >70 luma step) 68.1% of edges in 01-street-day carry an
// intermediate pixel, 79.9% in 05-wet-street, and the intermediate values
// cluster in three modes rather than forming a continuum - the signature of a
// 4-sample box resolve pushed through ACES and an sRGB encode. The hard
// remainder is what an axis-aligned edge landing on a pixel boundary looks
// like under 4x MSAA, and a city of boxes has a lot of those. So MSAA is live
// and is deliberately kept: `pass()` inherits `renderer.samples`. The AA node
// here is what MSAA cannot do - the axis-aligned hard steps, and shading and
// specular aliasing, which coverage sampling never touches.
//
// GRADE NOTE. The CSS filter it replaces was `saturate(1.16) contrast(1.04)
// brightness(1.01)`. CSS `contrast(k)` is a straight line pivoted on 0.5:
// `out = k*x + 0.5*(1-k)`, so at k = 1.04 everything below 0.0192 display
// (4.9/255) is clipped to black. The lighting solver's own black floor is
// BLACK_FLOOR_STEPS = 2.5/255 = 0.0098 display, which that line maps to
// -0.0098 - the CSS grade was destroying exactly the toe the rig computes.
// The contrast here is instead a power S-curve pivoted on 0.5, which has the
// same mid slope, maps 0 to 0 and 1 to 1 exactly, and leaves the floor intact:
// 0.0098 display comes out at 0.0084 rather than at 0.
//
// COST. Every stage is individually switchable at runtime so a capture round
// can attribute its cost, and so a round can still be delivered if one stage
// proves unaffordable on the software rasterizer. See `setAmbientOcclusion`,
// `setAntialias`, `setSceneSamples` and `setEnabled`.

import { PostProcessing } from 'three/webgpu';
import {
  pass, mrt, output, normalView,
  uniform, float, vec3, vec4,
  mix, dot, pow, step, clamp, renderOutput,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

export const POST_CHAIN_VERSION = 'post-chain-v1';

/** Anti-aliasing modes this chain will build. */
export const AA_MODES = Object.freeze(['smaa', 'fxaa', 'none']);

/**
 * `traa` is deliberately not in `AA_MODES`.
 *
 * TRAA accumulates over a jittered sub-pixel sequence and needs several
 * consecutive frames at a fixed pose to converge. The capture harness renders
 * between one and four frames per card and steps the simulation between them,
 * so a TRAA frame would be delivered mid-sequence, still carrying its own
 * jitter offset and whatever ghosting the last camera move left behind. It
 * also wants a velocity buffer, which means a third MRT attachment on a
 * backend where the second one is already the largest new cost in this file.
 * If a round ever renders a long settled burst at one pose, revisit it.
 */
export const AA_MODES_REJECTED = Object.freeze({ traa: 'unstable under pinned-pose capture stepping' });

export const POST_CHAIN_DEFAULTS = Object.freeze({
  enabled: true,
  antialias: 'smaa',
  ao: Object.freeze({
    enabled: true,
    /** Half resolution. The AO buffer is upsampled bilinearly on composite. */
    resolutionScale: 0.5,
    /** Metres. Runtime scale is exactly 1 unit per metre (AGENTS.md). */
    radius: 1.2,
    /** Metres of view-space depth a sample may differ by and still occlude. */
    thickness: 1.2,
    distanceExponent: 1.0,
    distanceFallOff: 1.0,
    scale: 1.0,
    /** 12 -> 3 slices x 4 steps x 2 directions = 24 depth fetches per AO pixel. */
    samples: 12,
    /** 0 = AO fully off in the composite, 1 = full strength. */
    intensity: 0.9,
    /**
     * 'mrt'   - normals come from a second colour attachment on the scene pass.
     * 'depth' - normals are reconstructed from depth in the AO shader.
     * 'depth' removes the extra attachment (the largest new per-frame cost on
     * a software rasterizer) at the price of faceted normals on curved
     * surfaces. It is the documented fallback if MRT proves unaffordable.
     */
    normalSource: 'mrt',
  }),
  grade: Object.freeze({
    saturation: 1.16,
    contrast: 1.04,
    brightness: 1.01,
  }),
  /**
   * MSAA sample count for the scene pass. `null` inherits `renderer.samples`,
   * which is what the pre-post-chain path used, so the default preserves the
   * delivered frame's existing coverage AA exactly.
   */
  sceneSamples: null,
});

/** CSS `saturate()` uses these luminance coefficients, not Rec.709's. */
const CSS_SATURATE_LUMA = Object.freeze([0.213, 0.715, 0.072]);

function pickAaMode(requested) {
  const mode = typeof requested === 'string' ? requested.toLowerCase() : '';
  if (AA_MODES.includes(mode)) return mode;
  return POST_CHAIN_DEFAULTS.antialias;
}

/**
 * What the backend will admit about its own MSAA, recorded once so the
 * question stops being inferred from pixels.
 */
function readMsaaCapability(renderer) {
  const report = {
    rendererSamples: Number(renderer?.samples) || 0,
    backend: renderer?.backend?.isWebGPUBackend === true
      ? 'webgpu'
      : renderer?.backend?.isWebGLBackend === true ? 'webgl2-fallback' : 'unknown',
    contextAntialias: null,
    maxSamples: null,
  };
  try {
    const gl = renderer?.backend?.gl;
    if (gl && typeof gl.getContextAttributes === 'function') {
      report.contextAntialias = gl.getContextAttributes()?.antialias ?? null;
      report.maxSamples = gl.getParameter(gl.MAX_SAMPLES) ?? null;
    }
  } catch (error) {
    report.error = String(error?.message || error);
  }
  return report;
}

/**
 * Build the canonical image pipeline.
 *
 * @param {Object} renderer - the one `WebGPURenderer` (WebGL2 fallback included)
 * @param {Object} scene - the one scene root
 * @param {Object} camera - the one camera
 * @param {Object} [options] - see `POST_CHAIN_DEFAULTS`
 * @returns {Object} the chain handle; `render()` replaces `renderer.render()`
 */
export function createPostChain(renderer, scene, camera, options = {}) {
  const settings = {
    enabled: options.enabled !== false,
    antialias: pickAaMode(options.antialias ?? POST_CHAIN_DEFAULTS.antialias),
    sceneSamples: options.sceneSamples ?? POST_CHAIN_DEFAULTS.sceneSamples,
    ao: { ...POST_CHAIN_DEFAULTS.ao, ...(options.ao || {}) },
    grade: { ...POST_CHAIN_DEFAULTS.grade, ...(options.grade || {}) },
  };

  // Uniforms, so a value change never recompiles the output shader. Only a
  // topology change (AO on/off, AA mode) does, and each of those is a
  // deliberate, attributable act.
  const saturation = uniform(settings.grade.saturation);
  const contrast = uniform(settings.grade.contrast);
  const brightness = uniform(settings.grade.brightness);
  const aoIntensity = uniform(settings.ao.intensity);

  const scenePass = pass(scene, camera, settings.sceneSamples == null
    ? undefined
    : { samples: settings.sceneSamples });
  const sceneColour = scenePass.getTextureNode('output');
  const sceneDepth = scenePass.getTextureNode('depth');

  const postProcessing = new PostProcessing(renderer);
  // The grade and the AA both need display-referred input, so this chain owns
  // its own `renderOutput` rather than letting PostProcessing append one.
  postProcessing.outputColorTransform = false;

  const state = {
    aoNode: null,
    aoNormalSource: null,
    aaNode: null,
    aaMode: 'none',
    rebuilds: 0,
    frames: 0,
    lastRenderMs: 0,
    failure: null,
  };

  /** Display-referred grade. Same order CSS applied: saturate, contrast, brightness. */
  function gradeDisplayReferred(colourNode) {
    const rgb = colourNode.rgb;
    const luma = dot(rgb, vec3(...CSS_SATURATE_LUMA));
    const saturated = clamp(mix(vec3(luma), rgb, saturation), 0.0, 1.0);
    // Power S-curve pivoted on 0.5: mid slope is `contrast`, 0 -> 0, 1 -> 1.
    const exponent = vec3(contrast);
    const toe = pow(saturated.mul(2.0), exponent).mul(0.5);
    const shoulder = pow(saturated.oneMinus().mul(2.0), exponent).mul(0.5).oneMinus();
    const contrasted = mix(toe, shoulder, step(vec3(0.5), saturated));
    return vec4(clamp(contrasted.mul(brightness), 0.0, 1.0), colourNode.a);
  }

  function buildAoNode() {
    const useMrt = settings.ao.normalSource !== 'depth';
    // MRT costs a second colour attachment on the scene pass; only ask for it
    // while AO is actually consuming it.
    scenePass.setMRT(useMrt ? mrt({ output, normal: normalView }) : null);
    const normalNode = useMrt ? scenePass.getTextureNode('normal') : null;
    const node = ao(sceneDepth, normalNode, camera);
    node.resolutionScale = settings.ao.resolutionScale;
    node.radius.value = settings.ao.radius;
    node.thickness.value = settings.ao.thickness;
    node.distanceExponent.value = settings.ao.distanceExponent;
    node.distanceFallOff.value = settings.ao.distanceFallOff;
    node.scale.value = settings.ao.scale;
    node.samples.value = settings.ao.samples;
    state.aoNormalSource = useMrt ? 'mrt' : 'depth';
    return node;
  }

  function buildAaNode(colourNode) {
    if (settings.antialias === 'fxaa') return fxaa(colourNode);
    if (settings.antialias === 'smaa') {
      // SMAA decodes its area/search tables from inline data URIs through
      // `Image`, which does not exist off a document. Fall back rather than
      // throw, and say so in the diagnostics.
      if (typeof Image === 'undefined') {
        settings.antialias = 'fxaa';
        state.failure = 'smaa unavailable without Image; fell back to fxaa';
        return fxaa(colourNode);
      }
      return smaa(colourNode);
    }
    return null;
  }

  function rebuild() {
    if (settings.ao.enabled) {
      if (state.aoNode === null || state.aoNormalSource !== (settings.ao.normalSource === 'depth' ? 'depth' : 'mrt')) {
        if (state.aoNode) state.aoNode.dispose();
        state.aoNode = buildAoNode();
      }
    } else {
      if (state.aoNode) state.aoNode.dispose();
      state.aoNode = null;
      state.aoNormalSource = null;
      scenePass.setMRT(null);
    }

    // AO is a multiply on scene-referred colour, before tone mapping, which is
    // where an occlusion term physically belongs. GTAO clears its target to
    // white and discards at depth >= 1, and the sky dome is drawn with
    // `depthWrite: false`, so sky pixels keep depth 1 and come out of the AO
    // buffer at exactly 1.0 - the sky is excluded by construction, not by a
    // mask that has to be maintained.
    let node = sceneColour;
    if (state.aoNode) {
      const occlusion = mix(float(1.0), state.aoNode.getTextureNode().r, aoIntensity);
      node = vec4(sceneColour.rgb.mul(occlusion), sceneColour.a);
    }

    // Tone map + exposure + sRGB encode, read from the renderer's own settings
    // through the post-processing context. Everything after this line is
    // display-referred.
    node = renderOutput(node);
    node = gradeDisplayReferred(node);

    if (state.aaNode && typeof state.aaNode.dispose === 'function') state.aaNode.dispose();
    state.aaNode = buildAaNode(node);
    state.aaMode = state.aaNode ? settings.antialias : 'none';
    if (state.aaNode) node = state.aaNode;

    postProcessing.outputNode = node;
    postProcessing.needsUpdate = true;
    state.rebuilds += 1;
  }

  rebuild();

  const msaa = readMsaaCapability(renderer);

  const chain = {
    version: POST_CHAIN_VERSION,
    postProcessing,
    scenePass,

    /** Replaces `renderer.render(scene, camera)` on the canonical path. */
    render() {
      const started = typeof performance !== 'undefined' ? performance.now() : 0;
      postProcessing.render();
      state.frames += 1;
      state.lastRenderMs = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
    },

    async renderAsync() {
      await postProcessing.renderAsync();
      state.frames += 1;
    },

    /** Whole-chain bypass. `false` puts the caller back on the bare render. */
    setEnabled(value) {
      settings.enabled = value !== false;
      return settings.enabled;
    },
    get enabled() { return settings.enabled; },

    /**
     * `true` / `false`, or a partial override of `POST_CHAIN_DEFAULTS.ao`.
     * Toggling `enabled` or `normalSource` rebuilds the graph, which costs one
     * shader compile on the next drawn frame. Everything else is a uniform.
     */
    setAmbientOcclusion(value) {
      const patch = typeof value === 'boolean' ? { enabled: value } : (value || {});
      const before = { enabled: settings.ao.enabled, normalSource: settings.ao.normalSource };
      settings.ao = { ...settings.ao, ...patch };
      aoIntensity.value = settings.ao.intensity;
      if (state.aoNode) {
        state.aoNode.resolutionScale = settings.ao.resolutionScale;
        state.aoNode.radius.value = settings.ao.radius;
        state.aoNode.thickness.value = settings.ao.thickness;
        state.aoNode.distanceExponent.value = settings.ao.distanceExponent;
        state.aoNode.distanceFallOff.value = settings.ao.distanceFallOff;
        state.aoNode.scale.value = settings.ao.scale;
        state.aoNode.samples.value = settings.ao.samples;
      }
      if (before.enabled !== settings.ao.enabled || before.normalSource !== settings.ao.normalSource) rebuild();
      return { ...settings.ao };
    },

    /** 'smaa' | 'fxaa' | 'none'. Rebuilds the graph. */
    setAntialias(mode) {
      const next = pickAaMode(mode);
      if (next === settings.antialias) return settings.antialias;
      settings.antialias = next;
      rebuild();
      return state.aaMode;
    },

    /**
     * MSAA sample count on the scene pass. `null` inherits `renderer.samples`.
     * This is the coverage AA the pre-post-chain path already paid for; it is
     * exposed so a round can measure what 4x MSAA costs on this backend now
     * that a resolve-time AA pass exists to replace it.
     */
    setSceneSamples(value) {
      const next = value == null ? null : Math.max(0, Math.round(Number(value) || 0));
      settings.sceneSamples = next;
      const resolved = next == null ? (Number(renderer?.samples) || 0) : next;
      if (scenePass.options) scenePass.options.samples = next == null ? undefined : next;
      if (scenePass.renderTarget) scenePass.renderTarget.samples = resolved;
      return resolved;
    },

    /** Partial override of `POST_CHAIN_DEFAULTS.grade`. Uniforms only, no rebuild. */
    setGrade(value) {
      const patch = value === false
        ? { saturation: 1, contrast: 1, brightness: 1 }
        : value === true ? { ...POST_CHAIN_DEFAULTS.grade } : (value || {});
      settings.grade = { ...settings.grade, ...patch };
      saturation.value = settings.grade.saturation;
      contrast.value = settings.grade.contrast;
      brightness.value = settings.grade.brightness;
      return { ...settings.grade };
    },

    diagnostics() {
      return {
        version: POST_CHAIN_VERSION,
        enabled: settings.enabled,
        // The order the graph actually runs in, so a review record does not
        // have to take the prose above on trust.
        order: [
          'pass(scene,camera)',
          ...(state.aoNode ? [`ao(${state.aoNormalSource})`, 'ao.mul(colour)'] : []),
          'renderOutput',
          'grade',
          ...(state.aaMode !== 'none' ? [state.aaMode] : []),
        ],
        ao: state.aoNode ? { ...settings.ao, normalSource: state.aoNormalSource } : { enabled: false },
        antialias: state.aaMode,
        antialiasReady: chain.antialiasReady(),
        grade: { ...settings.grade, model: 'css-saturate + pivot-0.5 power S-curve + gain' },
        sceneSamples: settings.sceneSamples == null ? (Number(renderer?.samples) || 0) : settings.sceneSamples,
        msaa,
        rebuilds: state.rebuilds,
        frames: state.frames,
        lastRenderMs: Math.round(state.lastRenderMs * 10) / 10,
        failure: state.failure,
      };
    },

    /**
     * SMAA's lookup tables decode asynchronously from data URIs. A frame drawn
     * before they land would carry wrong blend weights, so a capture round
     * should record this rather than assume it.
     */
    antialiasReady() {
      if (state.aaMode !== 'smaa') return true;
      const node = state.aaNode;
      const area = node?._areaTexture?.image;
      const search = node?._searchTexture?.image;
      if (!area || !search) return null;
      return Boolean(area.complete && search.complete);
    },

    dispose() {
      if (state.aoNode) state.aoNode.dispose();
      if (state.aaNode && typeof state.aaNode.dispose === 'function') state.aaNode.dispose();
      if (typeof scenePass.dispose === 'function') scenePass.dispose();
      postProcessing.dispose();
      state.aoNode = null;
      state.aaNode = null;
    },
  };

  return chain;
}
