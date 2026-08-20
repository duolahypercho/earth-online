// street-furniture — presentation pass.
//
// Owner: Terrain/streets
// Goal:  City-wide sidewalk furniture and vegetation at human scale.
//
// Contract: see src/render/pass-registry.js. Build from the city contract in
// `ctx`; never mutate simulation state, never create a renderer or loop.
//
// Status: stub. Returns no content until the owning task implements it.

export default {
  id: 'street-furniture',
  order: 40,
  build() {
    return { object: null, diagnostics: { implemented: false } };
  },
};
