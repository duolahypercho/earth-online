# CityGen — arbitrary low-poly map generator

Status: **in progress — critic gate passing 100/100 including real SF slice**

## Items

1. **Arbitrary map generator** — deterministic procedural cities via seeded
   street grid, blocks, parcels, buildings, districts, sidewalks, traffic
   roads, signals. Styles: SF-style, gridiron, garden. `src/citygen/core.js`
2. **Real map support** — OSM import for San Francisco and any city from
   OpenStreetMap (Nominatim geocode + Overpass), converted into the same
   metadata model. Public Overpass mirrors are currently flaky, so failures
   fall back to procedural with a visible status. `src/citygen/osm.js`
   A guaranteed offline real SF path loads the repo's prebuilt OSM data and
   adapts it into the CityGen model (`src/citygen/sf-data.js`).
3. **Rich metadata** — every block, building, street, road segment, one-way
   direction, lane count, sidewalk width, signal phase, and intersection is
   inspectable at runtime and included in `window.__CITYGEN__.getCity()`.
4. **AAA stylized look** — low-poly pastel materials, procedural facade
   textures, soft fog, warm directional light, contact shadows, bay bridge,
   water, lamps, day/night emissive windows, traffic, pedestrians.
   `src/citygen/renderer.js`
5. **Runtime experience** — orbit/walk modes, WASD, click inspector,
   minimap, seeded regenerate, style presets, real-map dialog.
6. **Visual QA loop** — `npm run qa:citygen` captures hero/street/aerial/
   night frames and validates metadata; `npm run qa:citygen-critic` scores
   them against the real SF reference. Iterate until the critic and pixel
   metrics pass the polish bar.

## Definition of done

- City generator produces San Francisco-flavored and generic cities.
- Real OSM import either succeeds or fails cleanly to procedural.
- Inspector proves building/street/signal metadata is present.
- Traffic and walk modes run without console errors.
- QA frames are non-blank, varied, colorful, and score well.

## Latest gate

`npm run qa:citygen` + `npm run qa:citygen-harsh`

- Result: **PASS 100/100**
- Hero: non-blank, 6 hues, high edge density
- Street: saturated (50), strong structure, 6 hues
- Aerial: dense skyline, 7 hues
- Night: lit windows, neon, lamps, traffic, 6 hues
- Metadata: 279 buildings / 81 blocks / 20 streets / 5 one-way / 14 signals
- Real SF slice: 700 buildings / 235 blocks / 2833 streets / 469 one-way /
  22 signals, real street names (e.g. 6th Street), rendered and captured
  through the same stylized pipeline.
- Scale gate: generated streets average 13.9 m curb-to-curb and buildings
  average 17.1 m tall, so full-size cars and pedestrians no longer dominate
  the street.

Note: the EffectComposer pipeline collapses to a single draw call in this
runtime on Three r180, so the renderer currently uses the direct
WebGLRenderer path (ACES tone mapping + shadows + emissives still apply).
