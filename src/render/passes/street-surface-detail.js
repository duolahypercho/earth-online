// street-surface-detail — presentation pass.
//
// Owner: Terrain/streets
// Goal:  Road-surface truth: crossings, stop bars, drainage, wear, curb ramps.
//
// Contract: see src/render/pass-registry.js. Build from the city contract in
// `ctx`; never mutate simulation state, never create a renderer or loop.
//
// Status: stub. Returns no content until the owning task implements it.

export default {
  id: 'street-surface-detail',
  order: 30,
  build() {
    return { object: null, diagnostics: { implemented: false } };
  },
};
