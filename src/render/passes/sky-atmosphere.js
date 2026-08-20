// sky-atmosphere — presentation pass.
//
// Owner: Rendering (lighting/atmosphere)
// Goal:  Sky, cloud, aerial-perspective and exposure content that the rubric's lighting dimension needs.
//
// Contract: see src/render/pass-registry.js. Build from the city contract in
// `ctx`; never mutate simulation state, never create a renderer or loop.
//
// Status: stub. Returns no content until the owning task implements it.

export default {
  id: 'sky-atmosphere',
  order: 10,
  build() {
    return { object: null, diagnostics: { implemented: false } };
  },
};
