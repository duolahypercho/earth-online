# SFMOMA Generated Landmark V1

This folder contains the visual reference and repeatable renders for a
procedural Three.js landmark reconstruction.

- `reference.png` is an AI-generated, isolated architectural concept used as
  the visual reference.
- `render-front.png`, `render-orbit.png`, and `render-rear.png` are WebGPU
  captures of the same module from three viewpoints.
- The runtime factory is
  `src/citygen/landmarks/sfmoma-generated-v1.js`.
- Structural and WebGPU preview checks live in
  `scripts/verify-sfmoma-generated-landmark.mjs` and
  `scripts/qa-sfmoma-generated-landmark.mjs`.

The asset is a render-only approximation derived from one image. Hidden
elevations are inferred. It does not replace an authoritative footprint,
surveyed dimensions, collision geometry, or map provenance.
