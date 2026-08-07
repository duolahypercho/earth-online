# CityGen — arbitrary low-poly map generator

Status: **in progress — harsh critic passing 100/100 including dynamic
building authoring and real SF slice**

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
   The **Export** button downloads the full metadata model as a portable
   JSON file (schema version, bounds, counts, blocks, buildings, streets,
   segments, intersections, signals), proven for procedural, real SF, and
   arbitrary OSM maps. **Import** loads an exported JSON back into a CityGen
   session offline, preserving generator type and exact counts, so a map can
   be shipped as data when live OSM is unavailable.
4. **AAA stylized look** — low-poly pastel materials, procedural facade
   textures, soft fog, warm directional light, contact shadows, bay bridge,
   water, lamps, day/night emissive windows, traffic, pedestrians.
   `src/citygen/renderer.js`
5. **Runtime experience** — orbit/walk modes, WASD, click inspector,
   minimap, seeded regenerate, style presets, real-map dialog.
   Drive mode enters the nearest car with `E`, throttles/steers with WASD,
   follows the same one-way traffic graph and signal phases as AI traffic,
   and exits back to the player with `E`. The readout shows building, block,
   street, one-way, and signal counts; real OSM maps label their source
   instead of a procedural seed. A live day-cycle clock advances continuously,
   drives renderer lighting (Day/Night), and building sandbox actions pay cash
   and track blocks touched.
6. **Dynamic authoring** — Add mode places a new building on any buildable
   block with live footprint preview, right-of-way and overlap validation,
   and full metadata (block, district, street, address, type, facade,
   material, height, stories). Undo removes the last placed building and
   restores the exact previous city state. `src/citygen/core.js` exposes
   `planBuildingPlacement` / `proposeBuildingPlacement` /
   `removeBuildingById` as pure, testable operations.
7. **Visual QA loop** — `npm run qa:citygen` captures hero/street/aerial/
   night frames and validates metadata; `npm run qa:citygen-critic` scores
   them against the real SF reference; `npm run qa:citygen-harsh` gates
   color, structure, exposure, metadata, and the dynamic build/undo
   round-trip; `npm run qa:citygen-blind-ab` embeds shuffled real-vs-game
   pairs plus official Schedule I screenshot pairs for a human blind
   comparison; `npm run qa:citygen-blind-verdict` records an automated
   visual-richness verdict per pair; `npm run qa:citygen-schedule-critic`
   records the matching Schedule I visual metrics.

## Definition of done

- City generator produces San Francisco-flavored and generic cities.
- Real OSM import either succeeds or fails cleanly to procedural.
- Inspector proves building/street/signal metadata is present.
- Traffic and walk modes run without console errors.
- QA frames are non-blank, varied, colorful, and score well.

## Latest gate

`npm run qa:citygen` + `npm run qa:citygen-harsh`

- Result: **PASS 101.5/100**
- Hero: non-blank, saturation 71.6, edge density 0.393, 10 hues
- Street: saturation 74.4, edge density 0.246, 9 hues, avenue bunting
- Aerial: saturation 70.4, edge density 0.488, 9 hues
- Night: saturation 79.6, edge density 0.232, 10 hues
- Grade: saturated-but-soft low-poly palette, warmer key light, richer
  sky/ground/water, saturated facades and storefronts, crosswalks and stop
  bars at every intersection, sidewalk cones/signs, utility poles and
  sagging bunting wires, plus a stylized canvas color grade.
- Real SF slice: street-level camera now frames a dense named street
  (6th Street) instead of an open freeway segment, with avenue bunting and
  full building mass in view; shopfront awnings/signs resolve the nearest
  arbitrary OSM road so real-map street dressing follows road orientation.
  A furniture gate asserts the real slice is dressed with >=120 sidewalk
  props and >=60 parked cars; current QA: 900 props / 360 cars / 126 awnings
  / 2600 bunting flags. Real SF frame: saturation 65.5, edge density 0.327,
  8 hues with richer mural and storefront colors.
- Metadata: 279 buildings / 81 blocks / 20 streets / 5 one-way / 14 signals
- Dynamic build: places a metadata-rich building (block/street/type/facade/
  material/height), captures it on screen, then Undo restores 246 buildings
- Real SF dynamic build: through the SF Built-in UI, places a Shopfront on
  Brannan Street (block `sf-block-11`, address `559 Brannan Street`) with
  full metadata, then Undo restores the exact 700-building real map
- Real SF slice: 700 buildings / 235 blocks / 2833 streets / 469 one-way /
  22 signals, real street names (e.g. 6th Street), rendered and captured
  through the same stylized pipeline.
- Blind A/B: 9 shuffled pairs covering real San Francisco photos (including
  the real SF built-in street) and official
  Schedule I screenshots (street, night, street life) with local verdict JSON.
  The latest automated verdict is 5 GAME / 3 TIE / 0 REFERENCE across the
  eight recorded pairs (real SF skyline, street, night, built-in street, plus
  Schedule I street, night, street life, real SF street), so the generated
  city no longer loses a blind pair to either reference.
- Arbitrary map: `npm run verify:citygen-any-city` converts a Portland OSM
  fixture through the same importer used for San Francisco, proving street
  names, one-way directions, sidewalks, signals, type-aware materials, and
  dynamic add/undo all work for a non-SF city. The fixture now includes real
  `highway=traffic_signals` nodes, and the gate asserts those nodes wire onto
  10 signal-controlled traffic edges that alternate red/green.
- Simulation: `npm run verify:citygen-simulation` gates the traffic graph:
  one-way streets produce exactly one legal direction, two-way streets two,
  and every signal-controlled edge alternates red/green through a full phase
  cycle. Browser QA also asserts WebGL2 is active and walk physics moves the
  player under keyboard input; drive QA enters a vehicle, accelerates along
  the road graph, and records real displacement. Sidewalk pedestrians now
  follow road-side waypoints (26 procedural / 48 real-map) and QA asserts
  they exist and move.
- Sandbox clock/economy: QA asserts the clock advances, `setClock(21.5)` flips
  to Night, placing a building increases cash, and build stats track blocks.
- Scale gate: generated streets average 13.9 m curb-to-curb and buildings
  average 17.1 m tall, so full-size cars and pedestrians no longer dominate
  the street.

Note: the EffectComposer pipeline collapses to a single draw call in this
runtime on Three r180, so the renderer currently uses the direct
WebGLRenderer path (ACES tone mapping + shadows + emissives still apply).
Night QA drives a real persistent night state (`setDay(false)`), which
exposed and fixed a bug where the main loop was overwriting the captured
night hour back to day on the next frame.
