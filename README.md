# Earth Online

A living 3D map of San Francisco, built to grow beyond one city.

> **Current direction:** develop the entire SF map platform, not new gameplay.
> The active scope is real geography, streamed city detail, road-rule traffic,
> and believable pedestrian life. Existing missions, combat, driving, and
> multiplayer remain useful prototype surfaces but are not being expanded.
> See [`Docs/SF_MAP_PLATFORM_GOAL.md`](./Docs/SF_MAP_PLATFORM_GOAL.md).

We start in **San Francisco**, then grow outward:

**SF → California → United States → North America**

Everyone is welcome to add their own towns.

- **About page:** [earth-online/about.html](https://duolahypercho.github.io/earth-online/about.html) · source: [`about.html`](./about.html)
- **Play San Francisco:** [earth-online](https://duolahypercho.github.io/earth-online/)

## Vision

Earth Online is a low-poly, real-time city world built from deterministic
geometry, procedural materials, and real map data. The current objective is a
coherent model of the full city of San Francisco: terrain, streets, districts,
buildings, transit, weather, streamed sectors, rule-correct traffic, and
pedestrians with believable appearances and daily routines.

The long road is simple:

1. **San Francisco** — build and validate the complete city map
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
