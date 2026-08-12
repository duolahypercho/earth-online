# San Francisco Map Platform Goal

Status: active project direction (2026-08-12)

## Goal

Build a visually exceptional, explorable, low-poly 3D model of the entire city
of San Francisco at 1:1 metric scale. Use real San Francisco as the geographic
authority, an AAA open-world city game as the city-specific reference, recent AAA open-world cities as
references for density and coherence, and
[`StarKnightt/night-street`](https://github.com/StarKnightt/night-street) as a
reference for procedural Three.js street construction, materials, atmosphere,
and measurement-led visual verification.

One Three.js world unit equals one real metre in every production artifact.
Stylization may simplify topology, materials, facade detail, and prop density;
it may not rescale, flatten, widen, straighten, relocate, or vertically
exaggerate authoritative geography. “1:1” means metric scale and fidelity to
the documented source accuracy. It is not a survey-grade accuracy claim. Scale,
absolute source/transform accuracy, and generated-mesh deviation are recorded
as separate quantities; a sub-metre mesh tolerance never upgrades a source or
coordinate operation whose documented absolute accuracy is several metres.

Keep the original ambition of a convincing living open world, but focus the
work on the city platform:

- accurate terrain, coastline, districts, streets, intersections, transit,
  landmarks, buildings, and useful interiors;
- deterministic, seamless streaming with district and street-level LODs;
- lighting, weather, water, vegetation, materials, and recognizable SF art
  direction;
- traffic that follows lane connectivity, turn restrictions, right of way,
  signals, transit routes, parking, and congestion rules;
- pedestrians with coherent appearances, navigation, crowd avoidance,
  schedules, destinations, and daily routines;
- authoring, provenance, validation, and performance tooling capable of
  producing and maintaining the whole city.

## Explicitly out of scope

Do not add missions, combat, weapons, wanted systems, progression, economy,
player abilities, minigames, or other gameplay systems unless this direction
is explicitly changed later. Existing gameplay code may remain as a legacy
visual and integration test surface, but it is not an active product goal and
must not drive map architecture.

## Architecture direction

No single maintained Three.js package provides the whole stack. Keep Three.js
as the real-time presentation layer and compose specialized systems around it:

1. **Geospatial source and build pipeline**
   - Overture Maps and OpenStreetMap for buildings, roads, paths, places, and
     restrictions.
   - USGS 3DEP and approved City of San Francisco data for terrain, shoreline,
     transit, and authoritative local features.
   - Offline projection, validation, simplification, mesh generation, and LOD
     baking. Browser code must not ingest or mesh the full raw city at runtime.

2. **City streaming and visual construction**
   - The production view remains a native Three.js scene. MapLibre GL JS and
     PMTiles may support preprocessing, QA, overview data, or debugging, but
     must not introduce a second runtime coordinate or camera authority.
   - An offline tile baker converts locked real-world geometry into compact,
     merged visual meshes. It applies procedural materials and reusable
     construction rules inspired by `night-street` without repeating that
     project's single-street runtime generation cost for every SF block.
   - Three.js renders project-owned terrain, buildings, landmark meshes,
     streets, furniture, weather, vehicles, pedestrians, and atmosphere.
   - Use `3d-tiles-renderer` only where arbitrary tiled 3D meshes materially
     outperform vector extrusion; do not create a second city-wide coordinate
     or streaming authority.

3. **Road rules and traffic**
   - Build a versioned lane graph from the same locked map snapshot used by the
     rendered roads.
   - Use Eclipse SUMO/netconvert to validate lane connections, junction
     priority, signals, legal turns, and reference traffic scenarios.
   - Bridge compact nearby vehicle and signal state to the browser. Three.js
     interpolates and renders state; it does not become the traffic authority.
   - A lightweight worker may provide presentation-mode traffic when a SUMO
     service is unavailable, but it must consume the same lane graph and pass
     the same legality tests.

4. **Pedestrian life**
   - Use `recast-navigation-js`/Detour for nearby navigation and crowd
     avoidance on streamed walkable tiles.
   - Keep schedules and daily-life selection as small, deterministic,
     project-owned data and logic rather than adopting an abandoned behavior
     framework.
   - Use a coherent low-poly GLB character kit for nearby people and instanced
     simplified silhouettes for distant crowds. Character licenses and source
     provenance are part of the build contract.

## Scale model

The entire city exists as data, not as simultaneously rendered or fully
simulated objects.

- **Near ring:** street-quality geometry, collision, animated traffic, and
  full pedestrians.
- **District ring:** simplified geometry and aggregate traffic/crowd state.
- **City ring:** map tiles, skyline, scheduled state, and metadata only.

Moving the camera promotes and demotes entities between rings using stable
feature IDs. Visible transitions must be deterministic and must not duplicate,
teleport, or lose traffic/pedestrian state.

## Acceptance

Every published tile must prove:

- locked source URLs, dates, licenses, attribution, and content hashes;
- terrain, shoreline, road, sidewalk, building, and transit alignment;
- seamless geometry, navigation, traffic, and identity handoff at tile edges;
- recognizable SF district character at street and skyline scales;
- rule-correct traffic and grounded, non-clipping pedestrians;
- deterministic unload/reload with bounded resources;
- Apple Metal application p99 frame time at or below 16.67 ms in the declared
  density scenario, with zero console, page, network, or request failures.

Visual reviews compare matched cameras against rights-cleared real SF imagery,
an AAA open-world city game, and recent AAA open-world city presentation. Reference games guide density,
composition, and atmosphere; real-world data remains the geographic authority.

## First milestones

1. Freeze the city coordinate system, source snapshot, attribution manifest,
   tile schema, LOD budgets, and machine-checked 1:1 scale contract.
2. Produce one end-to-end PMTiles/terrain prototype for the whole peninsula
   plus one hero street tile using the same stable feature IDs.
3. Generate and validate the SF lane graph with SUMO, then render a nearby
   traffic cohort from compact authoritative state.
4. Generate tiled pedestrian navmeshes and prove one scheduled resident can
   cross tile boundaries without identity, path, or grounding loss.
5. Expand hero-quality district coverage while preserving whole-city streaming
   and the performance budget.
