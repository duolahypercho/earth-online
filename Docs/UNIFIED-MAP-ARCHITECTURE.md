# Unified Map Architecture

Status: active migration plan

## Product decision

Earth Online is one game and one map.

- The canonical URL is `/`.
- The canonical renderer is Three.js `WebGPURenderer`, with Three's WebGL2 fallback only when WebGPU is unavailable.
- The canonical default world is the rich local San Francisco OSM dataset.
- Authoritative EPSG:26910 metric tiles are a source-accuracy layer inside the same app, not a second product.
- Procedural generation is a tool for remixing or expanding the world, not a separate homepage.
- RealMap presentation, traffic, pedestrians, vehicles, and gameplay must be ported into the canonical runtime. They must not keep their own long-lived app shells.

## Current transition state

| Route | Current role | Destination |
| --- | --- | --- |
| `/` | Canonical WebGPU game and map | Keep |
| `/citygen.html` | Temporary compatibility route using the same runtime | Remove after links/tests use `/` |
| `/sf-map.html` | Legacy metric-tile viewer | Extract loader/contracts, then remove |
| `/realmap.html` | Legacy hero/life presentation | Extract reusable systems, then remove |
| legacy `src/main.js` app | Old gameplay scene | Port gameplay systems, then remove as an entrypoint |

No new HTML map or game entrypoint may be added during the migration.

## Target file structure

```text
index.html                         # the only game/map document

src/
  app/
    main.js                        # composition root only
    bootstrap.js                   # renderer + world + simulation startup
    runtime-state.js               # the single mutable application state

  world/
    world-runtime.js               # owns active world mode and scene root
    coordinates.js                 # EPSG:26910 -> local world conversion
    map/
      map-service.js               # one public map API
      osm-map-source.js            # rich local/live OSM data
      metric-tile-source.js        # receipt/hash-verified production tiles
      procedural-map-source.js     # remix/expansion source
      map-contract.js              # source-neutral world data contract
    terrain/
      terrain-system.js
    buildings/
      building-system.js
      building-presentation.js
    streets/
      street-network.js
      street-renderer.js
      signals.js

  render/
    renderer.js                    # Three.js WebGPURenderer ownership
    lighting.js
    materials.js
    atmosphere.js
    camera.js

  simulation/
    simulation-clock.js
    traffic/
      traffic-graph.js
      traffic-simulation.js
      vehicle-presentation.js
    pedestrians/
      pedestrian-simulation.js
      pedestrian-presentation.js
    life/
      schedules.js
      roles.js

  player/
    player-controller.js
    vehicle-controller.js
    interaction-controller.js

  gameplay/
    economy.js
    jobs.js
    inventory.js
    consequences.js
    persistence.js
    multiplayer.js

  ui/
    hud.js
    map-panel.js
    inspector.js
    menus.js
    styles.css

  shared/
    math.js
    deterministic-random.js
    disposal.js
    assertions.js

public/data/world/
  source-locks/                    # immutable source authorizations
  production-artifacts/           # runtime-approved map artifacts
  preview-artifacts/              # proof-only, never loaded by production

scripts/
  build/                           # deterministic production builders
  verify/                          # static and data-contract verification
  qa/                              # browser/runtime/visual checks
  migration/                       # temporary one-time migration checks
```

Folders may be introduced incrementally. Do not perform a mass rename. Move one verified subsystem per commit.

## Dependency direction

```text
app
 ├─ world ──> render
 ├─ simulation ──> world contracts
 ├─ player ──> world + simulation contracts
 ├─ gameplay ──> player + simulation contracts
 └─ ui ──> read-only runtime diagnostics + explicit commands
```

Rules:

1. Map sources return the same source-neutral map contract.
2. Render code may read world data; it may not mutate source data.
3. Traffic owns vehicle movement. Rendering only mirrors traffic state.
4. Pedestrian simulation owns pedestrian movement. Presentation only mirrors it.
5. Gameplay may issue commands; it may not reach into renderer internals.
6. UI reads diagnostics and sends commands; it never becomes a second state store.
7. Source locks and production artifacts are immutable inputs. Preview artifacts cannot be promoted by importing them at runtime.

## Canonical contracts

### Coordinates

- Authoritative horizontal CRS: EPSG:26910 metres.
- Runtime unit: exactly 1 unit = 1 metre.
- Metric tiles retain their source origin in receipts.
- The runtime subtracts the active anchor origin exactly once.
- Vertical status remains provisional wherever the source receipt says it is provisional.
- Rendering may not silently rescale, exaggerate, or reproject source geometry.

### World state

There is one `WorldRuntime` and one active scene root. Switching sources must:

1. load and verify the candidate without mutating the visible world;
2. dispose the prior root and resources;
3. install one new root;
4. reset collision, traffic, pedestrians, minimap, inspector, and diagnostics;
5. preserve renderer, camera controls, clock, player identity, and UI shell.

### Rendering

- One Three.js renderer instance per page.
- WebGPU is initialized before the game loop begins.
- Use `renderer.setAnimationLoop`, not a second `requestAnimationFrame` loop.
- No subsystem creates its own renderer, canvas, tone mapping, or lighting rig.
- Material changes must not mutate GLB positions, indices, source origins, or scale.
- Source/presentation modes must be explicit. Missing presentation data fails closed; it is not guessed.

### Streets and traffic

- Streets provide immutable geometry, lane, direction, speed, sidewalk, and signal metadata.
- The traffic graph is derived once from the active street contract.
- Traffic simulation is fixed-step and deterministic from seed + world state.
- Vehicles never infer road topology from rendered meshes.
- Signals are simulation state consumed by traffic and presentation.

### Pedestrians and life

- Pedestrians bind to source-valid sidewalk/footway paths where those exist.
- Roles and props are presentation metadata, not claims about real people.
- Movement, source path, speed, and identity are deterministic.
- Avatar props may not change path coordinates, collision, or gameplay outcomes.

## Migration sequence

Each numbered item must be a separate visible, verified, pushed milestone.

1. **WebGPU foundation** — complete.
2. **Canonical `/` route** — complete.
3. **Metric-tile loader inside the main app** — complete for the bounded Ferry slice.
4. **Real SF as default** — make the rich local OSM map the boot scene; keep procedural generation as a tool.
5. **World source API** — move OSM, metric, and procedural switching behind one `map-service` contract.
6. **Street and traffic convergence** — select one traffic graph/simulation and port the best vehicle presentation.
7. **Pedestrian/life convergence** — port RealMap staged life and role cues into the same simulation.
8. **Gameplay convergence** — attach the existing player/economy/jobs/consequences systems to the unified world.
9. **Presentation convergence** — reuse the strongest building, water, lighting, and atmosphere systems in WebGPU.
10. **Retire duplicate routes** — delete legacy app shells only after their replacement gates pass on `/`.

## Ownership matrix

| Subsystem | Owns | Must not edit |
| --- | --- | --- |
| Integration | `src/app`, root HTML, composition | source artifacts without a source task |
| Map data | map sources, `public/data/world`, world-tile builders | renderer, gameplay, UI styling |
| Renderer | `src/render`, materials, lighting, camera | source coordinates, traffic rules |
| Streets | street contract, lanes, signals, street meshes | building source artifacts, economy |
| Traffic | traffic graph, vehicle simulation | map builder, UI, pedestrian paths |
| Pedestrians/life | paths, schedules, avatar presentation | street topology, player gameplay |
| Player/gameplay | controllers, jobs, economy, persistence | source geometry, rendering policy |
| UI | HUD, inspector, menus, accessibility | simulation truth, map artifacts |
| QA | scripts and evidence only | production behavior unless assigned a fix |

An agent receives one row (or a narrower set of files) per task. Cross-row changes require the integration owner to approve and perform the final composition.

## Plugin and tool routing

Plugins assist a subsystem; they never own architecture or source truth.

| Plugin/tool | Allowed use | Forbidden use |
| --- | --- | --- |
| In-app browser / Computer Use | run the canonical `/` app, inspect screenshots, interactions, console | editing source through DevTools, accepting a visual without repeatable QA |
| Image generation | texture concepts, decals, UI art, bounded character props | map geometry, terrain truth, OSM/DataSF claims, direct edits to source-locked artifacts |
| Figma (if installed) | HUD/menu/component design handoff | world state or gameplay implementation |
| Sentry (if installed) | production error/performance telemetry | gameplay analytics or source authorization |
| PostHog (if installed) | opt-in product interaction analytics | simulation state, personal/location source truth |
| Supabase/Neon (if installed) | accounts, multiplayer persistence, durable player data | authoritative map artifact storage or geometry mutation |
| Cloudflare/Vercel (if installed) | hosting/CDN/deployment | changing build outputs or runtime contracts to hide failures |
| GitHub tooling | scoped commits, CI, draft PR, review | force push, unrelated formatting, unreviewed mass merges |
| Gauntlet/visual critics | matched A/B review after a working implementation | generating parallel apps, maps, or branches |

If a plugin is not installed, the subsystem must still work locally without it.

## Required gates

Every production milestone runs the narrowest applicable checks plus:

```bash
npm run build
npm run verify:citygen-simulation
npm run qa:citygen
node scripts/qa-citygen-critic-harsh.mjs
git diff --check
```

Metric-map changes also run:

```bash
npm run verify:sf-map-streaming
npm run qa:citygen-metric
```

Before deleting a legacy entrypoint, add a same-URL test proving its required behavior now works on `/`.

## Definition of done

The merge is complete when:

- `/` is the only player-facing map/game route;
- real SF boots by default in Three.js WebGPU;
- procedural remix and authoritative metric data are sources inside the same world;
- traffic, pedestrians, vehicles, gameplay, and UI share one clock and runtime state;
- legacy `citygen`, `sf-map`, and `realmap` app shells are no longer built;
- default, street, aerial, night, walk, drive, map switch, unload/reload, and save/import QA pass from `/`;
- the main visual is independently accepted at normal scale.
