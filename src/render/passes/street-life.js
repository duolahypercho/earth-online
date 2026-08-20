// street-life — presentation pass.
//
// Owner: Pedestrians/life
// Goal:  Static and animated life dressing that supports the crowd simulation.
//
// Contract: see src/render/pass-registry.js. Build from the city contract in
// `ctx`; never mutate simulation state, never create a renderer or loop.
//
// Status: stub. Returns no content until the owning task implements it.

export default {
  id: 'street-life',
  order: 50,
  build() {
    return { object: null, diagnostics: { implemented: false } };
  },
};
