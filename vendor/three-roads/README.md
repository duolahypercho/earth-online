# Vendored three-roads build

Prebuilt ESM bundles for the MIT-licensed
[vibe-stack/three-roads](https://github.com/vibe-stack/three-roads) toolkit,
used offline by `scripts/build-sf-atlas.mjs` to convert OSM road strokes into
lane-level road surface and marking meshes.

- `core.js` — road authoring, automatic junction resolution, and compilation.
- `mesher.js` — road surface, marking, and junction mesh generation.
- `cdt/` — constrained Delaunay triangulation implementation with its own
  third-party `NOTICE`.

The published npm tarballs currently fail to install because they contain
`workspace:*` dependency links, so these bundles were produced from the
upstream source at commit `HEAD` of this project's pinned clone and vendored
here. See `LICENSE` and `NOTICE`.
