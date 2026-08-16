# Earth Online Agent Rules

These rules apply to every coding agent, subagent, plugin-assisted task, and human-authored change in this repository. Read [Docs/UNIFIED-MAP-ARCHITECTURE.md](Docs/UNIFIED-MAP-ARCHITECTURE.md) before changing architecture.

## Product invariant: one game, one map

- `/` is the only canonical player-facing game and map.
- Use one Three.js `WebGPURenderer`, one canvas, one animation loop, one scene/world root, and one runtime state.
- Real San Francisco is the default world. Authoritative metric tiles and procedural generation are map sources inside that world, not separate games.
- Do not add another HTML entrypoint, renderer, canvas, animation loop, lighting rig, world store, or parallel map application.
- Existing `/citygen.html`, `/sf-map.html`, and `/realmap.html` routes are temporary migration inputs. Do not add features to their app shells. Extract required behavior into the canonical runtime, verify it on `/`, then retire the old shell.

If a request appears to require a second map or renderer, stop and propose how it fits the canonical runtime instead.

## Before editing

1. State the repo, branch, requested outcome, assumptions, and owned files.
2. Assign the task to exactly one subsystem below. Keep the patch inside that ownership boundary.
3. Inspect the current implementation and working tree. Preserve unrelated dirty files.
4. Define an observable pass condition before implementation.
5. Use the current branch unless the user explicitly requests another branch or worktree.

Cross-subsystem changes require an integration task. Do not let several agents independently edit the composition root.

## Subsystem ownership

| Subsystem | Canonical destination | Owns | Does not own |
| --- | --- | --- | --- |
| Integration | `src/app/`, `index.html` | composition, startup, active-world switching | source artifacts, simulation internals |
| Map | `src/world/map/`, `public/data/world/`, `scripts/world-tiles/` | OSM/metric/procedural sources, receipts, coordinates | rendering style, traffic behavior |
| Terrain/buildings/streets | `src/world/terrain/`, `src/world/buildings/`, `src/world/streets/` | source-neutral world geometry and metadata | renderer lifecycle, gameplay |
| Rendering | `src/render/` | WebGPU renderer, camera, light, atmosphere, materials | source coordinates, simulation truth |
| Traffic | `src/simulation/traffic/` | traffic graph, signals, deterministic vehicles | rendered-road topology inference, UI |
| Pedestrians/life | `src/simulation/pedestrians/`, `src/simulation/life/` | paths, schedules, roles, deterministic movement | street geometry, player logic |
| Player | `src/player/` | walking, driving, interaction controllers | map generation, economy |
| Gameplay | `src/gameplay/` | jobs, economy, inventory, consequences, persistence | renderer and map internals |
| UI | `src/ui/` | HUD, inspector, menus, accessible commands | duplicate state, simulation mutation |
| QA/tooling | `scripts/qa/`, `scripts/verify/`, temporary migration scripts | repeatable evidence and contract checks | hidden production behavior |

The destination tree is introduced incrementally. Until migration finishes, a task may touch the corresponding existing `src/citygen`, `src/realmap`, or `src/sf-map` file, but it must move behavior toward this ownership model and must not create another legacy dependency.

## Map and source integrity

- Authoritative horizontal CRS is EPSG:26910 metres; runtime scale is exactly 1 unit per metre.
- Subtract the active map origin exactly once.
- Verify receipt and authorization before parsing or displaying a production GLB.
- Preserve source-provided vertical status. Never turn provisional vertical data into a certified claim.
- Files in `public/data/world/source-locks/` and production artifacts are immutable unless the task explicitly owns a deterministic, authorized rebuild.
- Preview/proof artifacts must remain write-disabled and cannot be imported by production runtime.
- Rendering may not change GLB positions, indices, origins, scale, road topology, or simulation coordinates.

## WebGPU and rendering

- Initialize Three.js `WebGPURenderer` before startup and drive the app with `renderer.setAnimationLoop`.
- WebGL2 fallback is allowed only through Three's WebGPU renderer fallback path.
- A subsystem may add scene objects; it may not create a renderer or its own RAF loop.
- Prefer WebGPU-compatible Three materials and TSL/node materials for new production work. Do not introduce a new `ShaderMaterial` or `onBeforeCompile` dependency into the canonical path without a dedicated migration and fallback test.
- Renderer/material policy changes need a versioned cache/program identity and matched visual evidence.
- Render-only work must preserve draw/triangle budgets unless the task explicitly defines and verifies a new budget.

## Simulation contracts

- One clock drives traffic, pedestrians, vehicles, day/night, and gameplay.
- Simulation uses a fixed step and deterministic seed where repeatability matters.
- Traffic reads the street contract; it never reverse-engineers lanes from meshes.
- Presentation mirrors entity state and cannot write path, identity, speed, collision, economy, or gameplay state.
- UI reads diagnostics and issues explicit commands. It is not a second state store.
- Switching map source disposes the old root and resets collisions, traffic, pedestrians, inspector, and source-specific diagnostics without replacing the renderer, UI shell, player identity, or clock.

## Plugin routing

Plugins assist the owning subsystem; they never decide architecture or source truth.

| Plugin/tool | Route work to | Allowed | Never allowed |
| --- | --- | --- | --- |
| In-app Browser / Computer Use | QA | canonical `/` interaction, screenshots, console inspection | source edits through DevTools, visual approval without repeatable QA |
| Image generation | Rendering/UI/Pedestrian presentation | textures, decals, UI art, bounded props | terrain, roads, map geometry, provenance claims |
| Figma | UI | HUD/menu/component handoff | runtime state or gameplay implementation |
| Sentry | Integration/QA | errors and performance telemetry | source authorization or gameplay analytics |
| PostHog | UI/Product analytics | opt-in interaction analytics | map truth, personal/location data, simulation state |
| Supabase / Neon | Gameplay/Persistence | accounts, saves, multiplayer records | authoritative map artifacts or geometry mutation |
| Cloudflare / Vercel | Integration/Deployment | hosting, CDN, deploy checks | changing contracts to hide a failing build |
| GitHub tools | Integration | scoped commits, CI, draft PR and review | force-push, mass merge, unrelated cleanup |
| Gauntlet / visual critics | QA | matched A/B after a working implementation | parallel games, maps, branches, or speculative rewrites |

An unavailable plugin is never a blocker for local game functionality. Do not install a plugin unless the user explicitly asks or the task genuinely requires its external service.

## Change discipline

- Implement the smallest verified slice. Do not mass-move the target tree.
- One subsystem migration per commit. Avoid opportunistic refactors.
- Use `apply_patch` for edits. Do not delete files in bulk.
- Do not weaken a failing gate to make a candidate pass. Fix the behavior or record a rejection.
- After each visible, verified milestone: summarize the exact diff, commit it, and push to the current GitHub branch. Never force-push.
- A subagent gets explicit file ownership and must not stage, commit, merge, or revert other agents' work unless assigned.
- The integration owner alone resolves cross-subsystem composition and commits the combined result.

## Verification matrix

Always run the narrowest relevant checks and `git diff --check`.

| Change | Required checks |
| --- | --- |
| Any production code | `npm run build` |
| Canonical map/simulation | `npm run verify:citygen-simulation`, `npm run qa:citygen`, `npm run qa:citygen-harsh` |
| Metric tiles/loader | `npm run verify:sf-map-streaming`, `npm run qa:citygen-metric` |
| Traffic | traffic deterministic/unit verifier plus canonical browser smoke |
| Pedestrians/life | determinism, source/path checks, canonical browser smoke |
| Renderer/material | two matched fresh captures, normal-scale visual review, performance/integrity counters |
| Legacy route retirement | same behavior demonstrated on `/` before deleting the old route |
| Docs/rules only | links/paths reviewed, Markdown diff, `git diff --check` |

Do not claim a visual improvement from integrity checks alone. Do not claim source correctness from a screenshot.

## Completion report

Every non-trivial handoff uses:

```text
Assumption:
Changed:
Verified:
Remaining risk:
```

The merge is complete only when `/` contains the real-SF WebGPU world, source switching, traffic, pedestrians, player, gameplay, and UI under one runtime, and the temporary map/game shells have been removed after replacement QA passes.
