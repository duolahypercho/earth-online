# Earth Online

A living open world you can walk, drive, and share.

We start in **San Francisco**, then grow outward:

**SF → California → United States → North America**

Everyone is welcome to add their own towns.

- **About page:** [earth-online/about.html](https://duolahypercho.github.io/earth-online/about.html) · source: [`about.html`](./about.html)
- **Play San Francisco:** [earth-online](https://duolahypercho.github.io/earth-online/)

## Vision

Earth Online is a low-poly, real-time city world built from deterministic geometry,
procedural materials, and real map data. The first playable district is San
Francisco — traffic, pedestrians, interiors, weather, streamed sectors, a
player avatar, drivable cars, local multiplayer, and voice chat.

The long road is simple:

1. **San Francisco** — live now
2. **California** — coast and inland cities in one continuous map
3. **United States** — towns and highways authored by many contributors
4. **North America** — one shared continent to explore

If you know a place, you can help put it on the map.

## Play locally

```bash
npm install
npm run dev
```

Open the Vite URL, click **Enter the city**, and follow the amber beacon through
**The Waterfront Loop**:

- Reach the Embarcadero Welcome Center
- Ask Mara for the waterfront route
- Mark the Bay route on the tactile model
- Open the map archive
- Finish at the Ferry Building
- Take the route to Coit Tower

Desktop controls: `W A S D` walk, drag to orbit, `E` enter / drive / talk,
`T` eat, `F` work, `X` rest, `V` voice chat, `Esc` exit, `M` map, `R` weather,
`C` quality, `H` hide HUD.

### Real Map Lab

Open `/realmap.html` to draw a boundary over real San Francisco and generate
that slice from OSM data: roads, sidewalks, buildings, signals, traffic, and
inspectable metadata. See `Docs/REAL_MAP_SANDBOX.md`.

This lab is also the seed for future towns — draw a place, generate it, then
bring it into the world.

Real Map alignment is enforced from one shared right-of-way contract: every
road, curb, sidewalk, junction pad, and building footprint reads the same OSM
centerline plus `streetDesign` section. The QA gate samples building facades
and fails on any facade that overlaps the road ROW (`getAlignmentDiagnostics`
on `window.__SF_REALMAP__`).

### CityGen Lab

Open `/citygen.html` for the low-poly arbitrary-city generator. It can produce
a seeded SF-style, gridiron, or garden city on demand, or attempt a real map
fetch from OpenStreetMap for any city. Every block, building, street, one-way
rule, lane, sidewalk, intersection, and signal is inspectable at runtime.
Add mode lets you click any buildable block to place a new building with live
footprint validation and full block/street/type/facade metadata; Undo restores
the previous city state. The **SF Built-in** option loads the repo's real San
Francisco OSM data as a playable district slice without depending on the
public Overpass service.

Visual QA runs `npm run qa:citygen` + `npm run qa:citygen-harsh` (currently
100/100). `npm run qa:citygen-blind-ab` builds a shuffled side-by-side page of
the latest CityGen frames against real San Francisco reference photos and
official Schedule I screenshots for a human blind comparison, and
`npm run qa:citygen-blind-verdict` records an automated per-pair verdict.
`npm run verify:citygen-any-city` proves the OSM importer also converts a
non-SF city (Portland fixture) with one-way, sidewalk, signal, and dynamic
add/undo metadata.

## Add your own town

Fork the repo, build a place that feels like home, and open a pull request.

Good starting points:

- Use the Real Map Lab workflow and real OSM geometry
- Match the low-poly, real-time look of the SF chapter
- Keep changes focused so others can review and merge them
- Tell us the town name, region, and what makes it yours

Small blocks count. Whole cities count. Quiet neighborhoods count.

## Multiplayer and voice

```bash
npm run net        # terminal 1: WebSocket relay on ws://localhost:8787
npm run dev        # terminal 2: the city
```

Or run both with `npm run dev:online`. Open two tabs (or two machines on the
same network). Players sync as named avatars; `V` enables microphone voice with
spatial audio.

## Verify

```bash
npm run build
npm run verify:city
npm run verify:streaming
npm run verify:streamed-agents
npm run verify:online
npm run qa:visual-probe
npm run qa:realmap
```

Built with Three.js and Vite. The day cycle moves from morning through golden
hour to night; weather, windows, lamps, and street fill light follow the clock.
