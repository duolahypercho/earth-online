# SFMOMA Source-Honest Landmark Reference V2

`reference.png` is a generated architectural concept for a procedural
Three.js reconstruction of the San Francisco Museum of Modern Art. It is
visual-design evidence only. It is not a photograph, survey, BIM model, map
source, or dimensionally authoritative record.

The concept deliberately corrects the rejected v1 direction by emphasizing
the recognizable Mario Botta Third Street composition: stepped red-brick
masses, a centered cylindrical black-and-white banded turret and oculus, a
dark stone base, and a contiguous pale rippled Snøhetta expansion volume.

## Provenance

- Generated image: `reference.png`
- Pixel dimensions: `1536 × 1024`
- SHA-256: `a5fc2bf43c65fc5ac065b1f8a7b5f0f27101e2339653cd4d20521f695460b4e6`
- Generation route: Codex `imagegen`, stylized-concept mode
- Generated on: 2026-08-16

Architectural identity was checked against official project descriptions:

- https://www.sfmoma.org/about/our-expansion-2016/architecture/
- https://www.sfmoma.org/press/release/sfmoma-architecture-and-building-information/
- https://www.snohetta.com/projects/san-francisco-museum-of-modern-art

These sources support the high-level architectural vocabulary only. They do
not make the generated image dimensionally exact.

## Exact generation prompt

```text
Use case: stylized-concept
Asset type: single-image reference for a procedural Three.js real-time landmark reconstruction
Primary request: Create a source-honest architectural concept reference of the San Francisco Museum of Modern Art at 151 Third Street, emphasizing the recognizable Mario Botta Third Street facade rather than inventing a new museum.
Scene/backdrop: isolated building on a neutral cool-gray studio cyclorama, no surrounding buildings, no street furniture, no people, no cars, no dramatic halo.
Subject: broad stepped red-brick facade mass with deep rectangular entrance, dark granite lower base, and the iconic centered cylindrical turret/oculus assembly with clearly alternating horizontal black-and-white stone bands; include a restrained glimpse of the later Snøhetta expansion behind as one contiguous pale-white rippled facade volume, not floating boxes.
Style/medium: high-end physically based architectural visualization suitable as a modeling reference, realistic scale and construction, crisp but not oversharpened.
Composition/framing: landscape 3:2, front three-quarter street-level view, entire building visible with 8% breathing room, verticals straight, camera roughly 35mm, no cropping, facade fills most of frame.
Lighting/mood: neutral overcast daylight plus soft contact shadows, materials readable without cinematic color grading.
Color palette: real red brick, charcoal/black granite, white stone bands, cool blue-gray glass, pale off-white rippled expansion.
Materials/textures: readable brick module and mortar depth, stone band segmentation, glass mullions and interior depth, white rippled FRP panel relief, grounded entrance and facade intersections.
Constraints: preserve architectural continuity and believable gravity; all volumes attached and grounded; the cylindrical banded turret must be the dominant identity feature; no text, no logos, no signage, no watermark.
Avoid: red chimney, corrugated red tower, stacked floating white boxes, fantasy museum forms, fisheye, aerial view, nighttime, bloom, background glow, streetscape clutter.
```

## Runtime authority rule

Any eventual world integration must preserve the canonical OSM building
polygon, height, collision, terrain contact, portal registry, and building ID
as source truth. The generated model may be used only as a presentation LOD
inside that contract. Hidden elevations and small construction details remain
explicit approximations until independently sourced.
