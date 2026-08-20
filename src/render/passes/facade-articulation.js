// facade-articulation — presentation pass.
//
// Owner: Terrain/buildings
// Goal:  Constructed facade depth: window reveals, frames, sills, cornices, storefront bands.
//
// Contract: see src/render/pass-registry.js. Build from the city contract in
// `ctx`; never mutate simulation state, never create a renderer or loop.
//
// Status: stub. Returns no content until the owning task implements it.

export default {
  id: 'facade-articulation',
  order: 20,
  build() {
    return { object: null, diagnostics: { implemented: false } };
  },
};
