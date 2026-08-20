# Open-source accelerators: survey and decision record

**Date:** 2026-08-20
**Scope:** read-only survey. Nothing here has been installed. `package.json`
dependencies are unchanged (`three@0.180.0`, `ws`).
**Question answered:** which existing open-source work would move
[Docs/VISUAL_QUALITY_GATE.md](VISUAL_QUALITY_GATE.md) scores fastest, at what
licence and architectural cost.

Round 1 scored 44.80/100 (REJECT). The dimensions with the most unclaimed
weight are character grounding (1/5, weight 10), NPC and traffic life (2/5,
weight 10), technical integrity (2/5, weight 12) and water/weather (1/5,
weight 10). Vehicle and character physics effectively do not exist.

Scoring arithmetic used throughout: one rubric point on a dimension is worth
`weight / 5` final points. So +1 on character grounding = +2.0, +1 on technical
integrity = +2.4, +1 on street realism = +3.6.

---

## 1. The four hard constraints that filter the field

These are measured against the tree, not assumed. Most of the popular
three.js ecosystem fails one of them, so they come first.

### 1.1 The canonical renderer is `WebGPURenderer`, running its WebGL2 backend

`src/citygen/renderer.js:2` imports `WebGPURenderer` from `three/webgpu`;
`src/citygen/renderer.js:1759` constructs it. On the capture machine
`requestAdapter()` returns null, so it falls back to `WebGLBackend`.

**Consequence: `ShaderMaterial` is not usable at all.** Under the node
pipeline, materials are converted by `NodeLibrary.fromMaterial()`
(`node_modules/three/src/renderers/common/nodes/NodeLibrary.js:50`), which
returns `null` for any type it has no node equivalent for. `NodeBuilder.build()`
(`node_modules/three/src/nodes/core/NodeBuilder.js:2776`) then logs
`NodeMaterial: Material "ShaderMaterial" is not compatible.` and substitutes a
blank `NodeMaterial`. The object renders as untextured garbage — it does not
throw, it silently degrades.

This is independent of AGENTS.md. Even if the "no new `ShaderMaterial`" rule
were lifted, `ShaderMaterial` would still not work on this renderer.

**Everything that is therefore out, regardless of merit:**

| Package / module | Why it cannot work here |
|---|---|
| `postprocessing` (pmndrs, Zlib) | `EffectComposer` requires a `WebGLRenderer` instance and every pass is a `ShaderMaterial`. Not a "degraded" path — it does not run. |
| `n8ao` (CC0-1.0 code) | Peer-depends on `postprocessing` + `WebGLRenderer`. Same wall. |
| `three/addons/objects/Water.js`, `Water2.js` | `ShaderMaterial`. Confirmed at `node_modules/three/examples/jsm/objects/Water.js:8`. |
| `three/addons/objects/Reflector.js`, `Refractor.js`, `Sky.js` | `ShaderMaterial`. |
| `three-custom-shader-material` | Its entire purpose is patching `ShaderMaterial`/`onBeforeCompile`; also peer-depends on React. |

The node-material equivalents that three 0.180 *does* ship — `WaterMesh.js`,
`Water2Mesh.js`, `SkyMesh.js` — are TSL (`node_modules/three/examples/jsm/objects/WaterMesh.js:8`
imports from `three/tsl`). AGENTS.md actively prefers TSL, but this round's
brief excludes TSL, so they are parked as a *later* option, not a candidate now.

### 1.2 One renderer, one canvas, one loop, one scene root

The loop is `state.renderer.renderer.setAnimationLoop(loop)` at
`src/citygen/main.js:2211`; the loop calls `CityRenderer.update(delta, {...})`
(`src/citygen/renderer.js:7617`) then `CityRenderer.renderFrame()` (`:7655`).

Any physics or navigation library must therefore be a **module with a
`step(delta)` that the existing loop calls once** — never a library that owns
its own RAF. All the physics/nav candidates below satisfy this (they are all
"call `world.step()` yourself" designs). Libraries that bring their own entity
manager and update cadence (Yuka) fight the `AGENTS.md` simulation contract
directly, because the repo already has an authoritative sim and a single clock.

Sequencing note for the Fix phase: `renderer.js` and `main.js` are not editable
by the subsystem agents, and those are the only two files where a `step()` call
can land. So every candidate below must be delivered as a **self-contained
module plus a one-line wiring diff owned by the integration owner**, or it
cannot ship at all this round.

### 1.3 Determinism

`AGENTS.md` requires a fixed step and a seeded, repeatable simulation, and the
repo's verification culture is "a `scripts/verify/*.mjs` that fails loudly".

- **Rapier** documents full cross-platform determinism for the wasm build given
  identical construction order, and exposes `world.createSnapshot()` returning a
  byte array — a hashable state suitable for exactly the kind of verifier this
  repo already writes. It also warns that `Math.sin`/`Math.cos` are not
  cross-platform deterministic, which matters because the repo uses them in
  seeded generators.
- **Recast/Detour** navmesh generation is deterministic for identical input
  geometry and config; `Crowd.update(dt, ...)` is deterministic at fixed `dt`.
- **cannon-es** makes no determinism claim and is unmaintained.

### 1.4 Licence

The repo has **no `LICENSE` file** and `package.json` is `"private": true` with
no `license` field — treat it as all-rights-reserved. `vite.config.js` has a
`GITHUB_PAGES` base, so **the build is distributed**, which means attribution
obligations are live, not theoretical.

| Licence | Verdict for this repo | Obligation if it ships |
|---|---|---|
| MIT / ISC / BSD | Compatible | Reproduce copyright + licence text in a notices file |
| Apache-2.0 (Rapier) | Compatible | Reproduce licence, retain any `NOTICE`, patent grant with a termination-on-litigation clause. Fine here; must be recorded. |
| Zlib (`postprocessing`) | Compatible in principle | Moot — technically incompatible per §1.1 |
| CC0-1.0 (assets) | Compatible, no obligation | None. Attribution appreciated, not required. |
| CC-BY | Compatible | Attribution required per-asset |
| GPL / AGPL | **Not compatible** with a proprietary distributed build | — |
| "Free for research / non-commercial" (most academic mocap corpora) | **Not compatible** | — |

**Action regardless of which candidates land:** the repo currently ships
Poly Haven CC0 textures with an exemplary
`public/assets/polyhaven-sandstone-blocks-08.provenance.json`, but the vendored
character and vehicle GLBs under `public/assets/` have **no provenance record**.
They came from the three.js example asset set, whose models are individually
licensed and are not uniformly CC0 — at least one character pair originates from
a proprietary rigging service's sample library, and
[Docs/NPC_AAA_ANIMATION_ORCHESTRATION.md](NPC_AAA_ANIMATION_ORCHESTRATION.md)
already records those as rejected for civilians. Add a provenance JSON per
binary asset, or replace them with CC0 equivalents (§6), before any capture is
presented as shippable.

---

## 2. Tier 0 — already paid for, zero new dependencies

Read this section before any `npm install` argument. Two of the three blocking
artifacts need no third-party code at all.

### 2.1 The missing shadows are a wiring gap, not a missing library

`src/render/environment-ibl.js` already exports `computeSunShadowCamera()`
(line 1821), `applySunShadowFit()` (line 2055), `SHADOW_FIT_DEFAULTS` (1732) and
`SHADOW_TEXEL_DENSITY_RANGE` (1762). A repo-wide grep finds **zero call sites
outside that file**. Meanwhile `src/citygen/renderer.js:1910-1919` hardcodes:

```
mapSize 2048x2048, near 10, far 1000, left/right/top/bottom ±420
```

That is an 840 m box across 2048 texels = **0.41 m per shadow texel**, against a
documented healthy band of 2.5–12 texels per metre — roughly 1/10th to 1/30th of
the density the module itself considers acceptable. `near = 10` also clips
everything closer than 10 m from the light's near plane. The diagnosis in the
task brief ("frustum not fitted to the visible area") is confirmed by the code,
and the fix is calling a function that already passed `npm run verify:environment-ibl`.

**Cost: one call in `CityRenderer.setTimeOfDay` (`renderer.js:7515`) or
`update` (`:7617`). Value: lighting (weight 14) and technical integrity (weight
12) both gated at ≥4.0 and both currently failing partly on this.** No package
on this list has a better ratio. It is not in the owned-files set for this
round, so it needs an integration-owner task.

### 2.2 Skeletal animation needs no new package either

`three@0.180.0` already ships everything a skinned crowd needs:

- `THREE.AnimationMixer`, `AnimationClip`, `AnimationAction` in core. **Grep
  finds zero uses of `AnimationMixer` anywhere in `src/`.** The repo animates
  every character by writing bone rotations by hand
  (`src/npc-animation-layers.js`, `src/pedestrians.js:1785 createHeroSkeleton`).
- `node_modules/three/examples/jsm/utils/SkeletonUtils.js` exports `retarget`,
  `retargetClip` and `clone` (line 486) — this is the retargeting story. A CC0
  clip set authored on one humanoid rig can be retargeted onto the project rig
  offline in a `scripts/` step and baked to glTF.
- `node_modules/three/examples/jsm/libs/meshopt_decoder.module.js` is already
  present, so meshopt-compressed geometry can be loaded at runtime without
  adding `meshoptimizer` as a runtime dependency.

The gap for character grounding is therefore **animation data and a mixer/LOD
policy, not a library**. See §6.

### 2.3 What a library genuinely cannot replace

Artifact 1 (the sidewalk hole) is a coverage bug in `buildStreetSurfaceV2()`
(`src/world/streets/street-surface-v2.js:1803`, called from
`CityRenderer.buildRoadNetwork` at `renderer.js:4107`). No package fixes it.
But §4.1 describes the package that turns "did we leave a hole" into an
automated verifier so it cannot silently return.

---

## 3. Physics

### 3.1 `@dimforge/rapier3d-compat` — recommended

| Field | Value |
|---|---|
| What it does | Rust rigid-body/collision engine compiled to wasm. Rigid bodies, trimesh/heightfield/convex colliders, joints, CCD, plus two purpose-built controllers: `KinematicCharacterController` and `DynamicRayCastVehicleController`. |
| npm | `@dimforge/rapier3d-compat@0.20.0`, published 2026-08-08 |
| Licence | **Apache-2.0** (verified in the published `package.json` and bundled `LICENSE`) |
| Size (measured from the tarball) | `rapier_wasm3d_bg.wasm` 2,021,200 B; `dist/rapier.mjs` 2,857,590 B (that JS **contains the same wasm inlined as base64**, so shipped weight is ~2.0 MB wasm + ~0.9 MB glue, not the sum). Tarball 3.2 MB, unpacked 10.2 MB incl. `.d.ts` and sourcemaps. |
| Non-compat variant | `@dimforge/rapier3d@0.20.0`, same licence, same 2.0 MB wasm as a **separate file** (964 KB tarball). Smaller shipped bytes, but it is a wasm-bindgen *bundler* target: Vite needs `vite-plugin-wasm` + top-level-await to consume it. `-compat` needs only `await RAPIER.init()` and works with the stock Vite config. |
| SIMD variant | `@dimforge/rapier3d-simd-compat@0.20.0` exists (2.4 MB wasm). Not worth the capability-detection branch yet. |
| WebGL2/no-WebGPU | **Fully unaffected.** Pure CPU/wasm, zero renderer contact, zero materials. |
| Maintenance | Excellent. 13 releases in the last 12 months, repo pushed 2026-08-16, 5.6k stars, 47 open issues. |
| Determinism | Documented cross-platform deterministic for the wasm build; `world.createSnapshot()` gives hashable state. |
| Threads / headers | Single-threaded. No `SharedArrayBuffer`, so **no COOP/COEP headers needed** — which matters because GitHub Pages cannot set them. |

**Vehicle controller — verified API surface** (`dist/control/ray_cast_vehicle_controller.d.ts`):
`new DynamicRayCastVehicleController(chassis, broadPhase, narrowPhase, bodies, colliders)`,
then `addWheel(chassisConnectionCs, directionCs, axleCs, suspensionRestLength, radius)`,
per-wheel `setWheelSuspensionStiffness / setWheelSuspensionCompression /
setWheelSuspensionRelaxation / setWheelMaxSuspensionTravel /
setWheelMaxSuspensionForce`, `setWheelEngineForce`, `setWheelBrake`,
`setWheelSteering`, and `updateVehicle(dt, filterFlags, filterGroups,
filterPredicate)` plus `currentVehicleSpeed()`. This is the classic raycast-
vehicle model (a rigid chassis on four suspension rays), which is exactly what
the rubric's vehicle expectations need and is *far* cheaper than four wheel
bodies with real contacts.

**Character controller** (`dist/control/character_controller.d.ts`) has
`enableAutostep(maxHeight, minWidth, includeDynamicBodies)`,
`enableSnapToGround(distance)`, `setMaxSlopeClimbAngle`,
`setMinSlopeSlideAngle`, `computeColliderMovement(...)`, `computedMovement()`
and `computedGrounded()`. `computedGrounded()` plus autostep is the direct
mechanical answer to the rubric's "correct foot contact, slope/curb response,
no skating/clipping".

**Integration sketch against this codebase**

1. New owned module `src/simulation/physics/rapier-world.js` exporting
   `createPhysicsWorld({ fixedStep = 1/60, gravity })`, `stepPhysics(world, delta)`
   with a fixed-step accumulator, and `disposePhysicsWorld(world)`. It imports
   nothing from `three/webgpu` and constructs no scene object.
2. **Static colliders come from the street contract, not from meshes.** Feed
   `buildStreetSurfaceData(city)` (`src/world/streets/street-surface-v2.js:1702`)
   into `ColliderDesc.trimesh(vertices, indices)` for the roadway/sidewalk
   layers named in `STREET_SURFACE_V2_MESH_GROUPS` (`:117`), and building
   footprints from `city.buildings` into `ColliderDesc.cuboid`. This respects
   the `AGENTS.md` rule that simulation must not reverse-engineer geometry from
   rendered meshes, and it means the collider set is rebuilt in the same place
   the street surface is.
3. Player: replace the ad-hoc grounding in `src/player.js` with a
   `KinematicCharacterController` whose `computedGrounded()` drives the
   `gaitBlendTarget` argument already accepted by `updateLocomotionPhase()`
   (`src/npc-animation-layers.js:36`). Foot contact stops being a guess.
4. Vehicles: the player car only. `TrafficSim` (`src/citygen/traffic.js:69`)
   keeps its deterministic scripted agents — putting 36+ ambient cars on a
   solver buys no rubric points and costs the frame budget.
5. Wiring: one `stepPhysics(world, delta)` call inside
   `CityRenderer.update` (`renderer.js:7617`) before `traffic.update(delta)`.
   Integration-owner diff.
6. Verifier: `scripts/verify/verify-physics-determinism.mjs` — build the world
   twice from the same seed, run 600 fixed steps, assert equal SHA-256 of
   `world.createSnapshot()`. Node-only, no browser, no capture.

**Risks, stated plainly.** (a) ~2.9 MB of new shipped payload; it must be
dynamically imported so it is not in the first paint path. (b) Apache-2.0
requires a notices file the repo does not yet have. (c) Rapier's determinism
guarantee is void if construction order varies — so collider creation must be
driven off a sorted, seeded iteration, not `Map`/`Set` insertion order.
(d) It does not fix a single pixel on its own; it fixes *contact*, which is
scored under character grounding and technical integrity.

### 3.2 `cannon-es` — not recommended

| Field | Value |
|---|---|
| npm | `cannon-es@0.20.0`, published **2022-08-12** |
| Licence | MIT (compatible) |
| Size | 774 KB unpacked, pure JS, no wasm — genuinely the lightest option |
| WebGL2 | Fine, pure CPU |
| Maintenance | **Repo last pushed 2024-01-06; zero npm releases in ~4 years; 58 open issues.** |

It has a `RaycastVehicle` with the same conceptual model as Rapier's. If the
2 MB wasm were unacceptable this would be the fallback. It is not recommended
because it is dormant, materially slower per body than the wasm engines, makes
no determinism claim, and its trimesh support (`Trimesh` vs `Heightfield`) is
the weakest part of the library — and trimesh streets are precisely the use
case here.

### 3.3 `jolt-physics` — strong engine, wrong shape for this repo right now

| Field | Value |
|---|---|
| npm | `jolt-physics@1.1.0`, published 2026-07-11 |
| Licence | MIT (verified in the bundled `LICENSE`) |
| Size (measured) | `jolt-physics.wasm.wasm` 2,021,569 B + Emscripten glue `jolt-physics.wasm.js` 964,712 B; the base64-inlined `wasm-compat` build is 3,222,495 B. Package unpacked **46.4 MB** (it ships debug, asm.js, single- and multi-thread builds). |
| WebGL2 | Unaffected, pure CPU |
| Maintenance | Healthy: 7 releases in 12 months, pushed 2026-07-20, only 2 open issues |
| Vehicle | Best-in-class: `VehicleConstraint` with `WheeledVehicleController`, real engine/transmission/differential model, plus tracked and motorcycle controllers |

Why not now: the multithreaded build — its main advantage — needs
`SharedArrayBuffer`, therefore COOP/COEP headers, which the current Vite dev
server and GitHub Pages deployment do not set. Single-threaded, it is roughly
peer to Rapier for this workload while presenting a much larger, Emscripten-
embind API (`Jolt.Vec3` handles you must `destroy()` manually) that is easy to
leak from JS. Rapier's JS bindings are hand-written and idiomatic. Revisit if
vehicle handling feel becomes a scored dimension in its own right.

---

## 4. Spatial queries and navigation

### 4.1 `three-mesh-bvh` — recommended, highest ratio on this list

| Field | Value |
|---|---|
| What it does | Builds a bounding volume hierarchy over `BufferGeometry` (and, as of recent versions, over whole scene hierarchies) and patches `Mesh.prototype.raycast` for orders-of-magnitude faster raycasts, plus shapecasts, closest-point queries and geometry generation helpers. |
| npm | `three-mesh-bvh@0.9.14`, published 2026-08-01 |
| Licence | MIT |
| Size | 290,630 B ESM build; tree-shakeable — the CPU raycast subset used here is a small fraction of that. **No wasm.** |
| Peer | `three >= 0.159.0` — satisfied by 0.180.0 |
| WebGL2/no-WebGPU | **Compatible.** The parts recommended here (`MeshBVH`, `ObjectBVH`, `computeBoundsTree`, `acceleratedRaycast`) are pure CPU JS and never touch a material. The package *also* exports GLSL helpers (`BVHShaderGLSL`) and a `./webgpu` entry — **do not import those**; the GLSL path is `ShaderMaterial`-shaped and hits §1.1. |
| Maintenance | Excellent: 13 releases in 12 months, pushed 2026-08-10, 3.4k stars |

**Why it is the best ratio.** It attacks technical integrity (weight 12, the
single heaviest failing dimension) from two directions, and it also runs in Node
without a browser — meaning it can back verifiers, which is how this repo
actually gates work.

`src/core/ObjectBVH.js` builds a BVH over a whole scene root, with each leaf an
`Object3D` **or one instance of an `InstancedMesh`/`BatchedMesh`**. That is
precisely the structure needed for the artifact-1 class of bug.

**Integration sketch**

1. New owned module `src/render/scene-bvh.js`:
   - `buildSceneBvh(root)` → `new ObjectBVH(root, { includeInstances: true })`
   - `raycastFirst(bvh, origin, direction, maxDistance)` with
     `raycaster.firstHitOnly = true`
   - `disposeSceneBvh(bvh)`
2. **Coverage verifier — this is the payoff.** New
   `scripts/verify/verify-street-surface-coverage.mjs`: run
   `buildStreetSurfaceData(city)` headless, build a BVH over the resulting
   roadway/sidewalk triangles, then cast a downward ray from `y = +50` on a
   deterministic grid across every block polygon and over every recorded QA
   camera pose's screen footprint. Fail if any sample inside a street or
   sidewalk band returns no hit within tolerance. The measured artifact — a ray
   at screen (0.53, 0.66) passing through pavement and travelling 1,189.81 m to
   a distant `opacity: 0.05` plane — becomes a **deterministic Node assertion
   that runs in seconds**, instead of something discovered by eye in a 60-second
   software-rendered frame. That is the difference between fixing this hole and
   stopping holes.
3. Grounding and camera: `src/player.js` and the hero camera currently create
   ad-hoc `THREE.Raycaster`s (`src/citygen/main.js:1311`,
   `src/realmap/hero-camera.js:89`, `src/realmap/main.js:9049`). Route foot
   placement and camera-collision probes through the shared BVH so per-frame
   grounding queries stay affordable across 1,189 meshes.
4. Also worth pointing the BVH at the second half of the diagnosis: the unnamed
   `MeshBasicMaterial`, `transparent`, `opacity: 0.05` plane 1.2 km out that the
   ray terminated on. A verifier that asserts every mesh under `city-root` has a
   name and a declared purpose would have flagged it. Naming is free; the BVH
   makes auditing it cheap.

**Risks.** Small: build time for a large BVH is non-trivial (build it once per
city load, not per frame), memory is roughly proportional to triangle count, and
the BVH must be rebuilt or invalidated when streaming swaps tiles. None of these
conflict with any `AGENTS.md` rule.

### 4.2 `recast-navigation` — recommended (third), the real answer for NPC life

| Field | Value |
|---|---|
| What it does | wasm port of Recast (voxel navmesh generation from arbitrary triangle soup) and Detour (path queries, `Crowd` with local steering and obstacle avoidance, off-mesh links, tile cache with dynamic obstacles). |
| npm | `recast-navigation@0.43.1` (umbrella, published 2026-02-04); `@recast-navigation/core@0.43.1` and `@recast-navigation/three@0.43.1` (both 2026-04-07) |
| Licence | **MIT** for the JS bindings (verified in `@recast-navigation/wasm`'s bundled `LICENSE`, © Isaac Mason). Upstream Recast/Detour itself is Zlib. Both permissive, both compatible. |
| Size (measured) | `recast-navigation.wasm.wasm` **338,824 B**. The default export is the `wasm-compat` build — `recast-navigation.wasm-compat.js` at 1,011,280 B with the wasm inlined as base64, so **no separate file fetch and no Vite wasm plugin needed**. `@recast-navigation/core` 250 KB unpacked, `/three` 81 KB, `/generators` 78 KB. |
| Peer | `three: 0.x.x` — no upper bound, fine with 0.180.0 |
| WebGL2/no-WebGPU | **Compatible.** Generation and queries are pure wasm/CPU. The `three` sub-package's `NavMeshHelper` / `CrowdHelper` / `DebugDrawer` are debug visualisers built from ordinary `Mesh`es — safe, but they are debug-only and should never enter the canonical path. |
| Maintenance | Good: 4 releases in 12 months, repo pushed 2026-07-06, 425 stars, 34 open issues |

**Navmesh generation from the existing geometry is the part that matters, and
it is a one-liner.** `@recast-navigation/three` exports
`getPositionsAndIndices(meshes) → [Float32Array, Uint32Array]` and
`threeToSoloNavMesh(meshes, config)` / `threeToTiledNavMesh(meshes, config)` /
`threeToTileCache(meshes, config)`. The repo already produces exactly the input
these want.

**Integration sketch**

1. Offline, not at runtime. New `scripts/world/build-sf-navmesh-v1.mjs`:
   take the sidewalk and crossing layers from `buildStreetSurfaceData(city)`
   (`street-surface-v2.js:1702`) plus building footprint prisms as obstacles,
   call `threeToTiledNavMesh` with an agent radius of 0.35 m / height 1.8 m /
   max climb 0.25 m (a curb) / max slope 30°, and write the tile bytes plus a
   provenance JSON beside the existing world artifacts. Baking offline keeps
   the runtime deterministic and keeps a 1 MB wasm out of first paint.
2. Runtime: `src/simulation/pedestrians/navmesh-runtime.js` loads the baked
   tiles via `NavMesh` + `NavMeshQuery`, and drives a `Crowd` at fixed `dt`.
   `CrowdAgent` exposes `requestMoveTarget`, `position()`, `velocity()`,
   `desiredVelocity()`, `corners()` and `state()`.
3. Presentation stays exactly as it is. `TrafficSim` keeps ownership of identity
   and schedule; the crowd supplies position and heading, which are written
   through the existing `writePedestrianInstance(batch, index, pedestrian)`
   (`src/citygen/actors.js:557`) — no new draw calls, no new scene nodes.
4. Verifier: `scripts/verify/verify-navmesh-determinism.mjs` — same seed, same
   baked navmesh, 1,200 fixed crowd steps, assert identical agent position
   hashes across two runs.

**Risks.** (a) `Crowd` is a second thing that moves agents; the
`AGENTS.md` rule that presentation cannot write simulation truth means the crowd
must be *inside* the sim layer, not called from the renderer. (b) Baked navmesh
tiles become new artifacts that need the repo's provenance/lock treatment.
(c) Honest scoping: the rubric's NPC-life gate asks for "purposeful navigation,
crossings, reaction, **animation variety**, no obvious loops". Recast fixes the
first three. It does not add a single frame of animation — which is why it ranks
below the animation work, not above it.

### 4.3 `three-pathfinding` — viable fallback, not the primary

| Field | Value |
|---|---|
| npm | `three-pathfinding@1.3.0`, published 2024-05-17 |
| Licence | MIT |
| Size | 368 KB unpacked, pure JS, no wasm |
| Peer | `three: 0.x.x` |
| Maintenance | Repo pushed 2026-07-08 but no npm release in ~2 years. 7 open issues. Effectively feature-complete/dormant. |
| API | `Pathfinding.createZone(geometry, tolerance)` (static, line 26), `findPath(start, target, zoneID, groupID)` (106), `getGroup` (159), `clampStep` (212) |

**The disqualifier is stated in its own API:** `createZone` takes a
`BufferGeometry` that *is already a navmesh*. It has no generator. Someone or
something must author the walkable surface first — which is the expensive half
of the problem, and exactly what Recast automates from geometry this repo
already has. `clampStep` (projecting a desired movement back onto the navmesh)
is genuinely nice for grounding, and if the 1 MB wasm payload were ruled out,
this plus a hand-built sidewalk navmesh derived from
`STREET_SURFACE_V2_MESH_GROUPS` would be the fallback. It also has no crowd/
local-avoidance layer, so agents will interpenetrate without extra work.

### 4.4 `yuka` — not recommended

| Field | Value |
|---|---|
| npm | `yuka@0.7.8`, published **2022-09-17** |
| Licence | MIT |
| Size | 1.03 MB unpacked, pure JS |
| Maintenance | Repo pushed 2026-07-23, but no npm release in ~4 years. 1.4k stars, 6 open issues. |

Yuka is a full game-AI toolkit: `EntityManager`, `Vehicle`, steering behaviours,
state machines, goal-driven agents, fuzzy logic, a `NavMesh` with a graph, and
its own `Time` class. That completeness is the problem here. It expects to own
entities and to be ticked as `entityManager.update(delta)`, which duplicates
`TrafficSim`, `src/lifesim.js` and `src/npc-behavior-tree.js`, and it would
become a second state store — the specific thing `AGENTS.md` prohibits. Its
navmesh also has to be loaded from an authored file; like §4.3, no generator.
Adopting steering *ideas* from it costs nothing; adopting the runtime is a
regression in architecture.

---

## 5. Performance and technical integrity

### 5.1 `THREE.BatchedMesh` (built in) — has a specific trap on this machine

`BatchedMesh` exists in 0.180 (`node_modules/three/src/objects/BatchedMesh.js:182`)
and is the natural next step past the 20+ `InstancedMesh` batches in
`renderer.js`, because it allows *different geometries* in one draw call.

**Trap, measured:** `node_modules/three/src/renderers/webgl-fallback/WebGLBackend.js:1090`
reads

```js
} else if ( ! this.hasFeature( 'WEBGL_multi_draw' ) ) {
    warnOnce( 'THREE.WebGLRenderer: WEBGL_multi_draw not supported.' );
}
```

— i.e. on a WebGL2 backend without `WEBGL_multi_draw`, a `BatchedMesh` issues
**no draw call at all and only warns once**. Silent disappearance, not a visible
error. Before any `BatchedMesh` work, add a capability probe to the QA harness
that records `renderer.backend.hasFeature('WEBGL_multi_draw')` in the capture
manifest, on both the software-rendering box and the real capture target. If it
is absent on the capture machine, `BatchedMesh` is off the table this round and
`InstancedMesh` per-geometry stays.

### 5.2 `meshoptimizer` — recommended for offline LOD only

| Field | Value |
|---|---|
| npm | `meshoptimizer@1.2.0`, published 2026-06-30 |
| Licence | MIT |
| Size (measured) | `meshopt_simplifier.js` 55,177 B; `meshopt_encoder.js` 24,348 B; `meshopt_decoder.mjs` 29,059 B. Tiny — inlined wasm in each. |
| WebGL2 | Irrelevant, it is a geometry tool |
| Maintenance | Excellent: 8 releases in 12 months, pushed 2026-08-08, 8.2k stars, 9 open issues |

`MeshoptSimplifier.simplify()` produces the LOD chain the repo has **zero** of
today — a grep for `new THREE.LOD` across `src/` returns nothing, while the
rubric explicitly penalises "LOD popping" under technical integrity and 1,189
meshes are drawn at once. Use it in `scripts/` as a **devDependency** to bake
LOD1/LOD2 index buffers into the world artifacts; the runtime then only needs
`THREE.LOD` (core) and the already-vendored
`examples/jsm/libs/meshopt_decoder.module.js`. Note that a *good* LOD policy is
authored work; the library only gives you decimated indices, and a naive chain
will make popping worse, not better. Pair it with hysteresis distances mirroring
the ones `facade-depth.js` already computes
(`FACADE_DEPTH_LOD_DISTANCES`, `facadeDepthLodForDistance`, line 521) so
buildings do not use two unrelated LOD schemes.

### 5.3 `@gltf-transform/core` + `/functions` — useful, with a repo-specific caveat

| Field | Value |
|---|---|
| npm | `4.4.2`, published 2026-07-25 |
| Licence | MIT |
| Size | 976 KB / 896 KB unpacked; **Node-side only**, never shipped |
| Maintenance | Good: 7 releases in 12 months, pushed 2026-08-04, 92 open issues |

Right tool for deduplicating, resizing textures in, meshopt-compressing and
auditing the vendored GLBs, and for baking retargeted animation clips (§6) into
a single shared-skeleton GLB. **Caveat that must not be skipped:**
`AGENTS.md` declares files under `public/data/world/source-locks/` and
production GLBs immutable, and forbids rendering-side changes to GLB positions,
indices, origins or scale. So gltf-transform may be used to produce *new,
receipted* artifacts through an authorised deterministic rebuild — never to
rewrite an existing locked one in place.

### 5.4 GPU instancing for crowds — the honest limitation

There is no library fix for this, and it is worth writing down before someone
tries: **three.js cannot skin an `InstancedMesh` or a `BatchedMesh`.** Skeletal
animation requires one `SkinnedMesh` per character. The standard workarounds are
vertex-animation textures or instanced bone textures, and **both require a
custom shader** — which §1.1 rules out entirely under `WebGPURenderer`, and
which `AGENTS.md` separately forbids. The workable policy for this renderer is:

- **Near band (0–25 m, ~10–20 characters):** real `SkinnedMesh` + `AnimationMixer`,
  `SkeletonUtils.clone()` off one shared source, seeded per-character time
  offsets. This is what earns the character-grounding points; the rubric scores
  the eye-level card, not the crowd 80 m away.
- **Mid/far band:** keep the existing instanced part-batches in
  `src/citygen/actors.js` driven by `writePedestrianInstance`, with the
  procedural gait from `npc-animation-layers.js`.
- Cross-fade between bands at a distance where the silhouette swap is under a
  few pixels — `facadeDetailTierMetrics()` in `facade-depth.js:455` already
  implements exactly this pixels-per-metre reasoning and should be reused rather
  than re-derived.

### 5.5 `three-nebula` — not recommended now

| Field | Value |
|---|---|
| npm | `three-nebula@12.1.0`, published 2026-08-09 |
| Licence | MIT |
| Size | 1.5 MB unpacked |
| Maintenance | Active: 8 releases in 12 months, pushed 2026-08-18 |
| WebGPU status | v12.1.0 added an optional `three-nebula/webgpu` `GPURenderer` built on `SpriteNodeMaterial` — i.e. **TSL**, which this round's brief excludes. The CPU `SpriteRenderer`/`MeshRenderer` paths use ordinary materials and do work under `WebGPURenderer`. |

Credit where due: this is the rare particle library that has actually done the
node-material port. But rain in this scene is one instanced quad field plus a
wetness response, both of which the repo can do with an `InstancedMesh` and the
existing clock. Adding a second particle-update system and 1.5 MB to get that
is a poor trade. Revisit only if several distinct FX systems are needed at once.

---

## 6. Character animation assets

This is where the character-grounding score of 1/5 actually gets fixed, and
§2.2 established that no npm package is required — three ships the mixer and the
retargeter. What is missing is **clips**.

| Source | Licence | Verified | What it gives |
|---|---|---|---|
| **Quaternius — Universal Animation Library** | **CC0-1.0**, no attribution required | Distributed as FBX / glTF / OBJ with a Blender source file containing the rig; 120+ clips on one universal humanoid rig, explicitly authored for retargeting | Idle, walk, run, turn, sit, talk, carry, phone — i.e. the exact vocabulary `Docs/NPC_AAA_ANIMATION_ORCHESTRATION.md` lists per role |
| Quaternius — Universal Animation Library **2** | 130+ clips; **caution: only ~60–70% of pack 2 is free**, the remainder is paid | | Prefer pack 1 unless a specific clip is missing, and record which files came from which pack |
| Quaternius — Universal Base Characters | CC0-1.0 | | Bodies matching the same rig, so retargeting is near-free |
| **Kenney** (e.g. City Kit, 50 models) | **CC0** (confirmed on the asset page) | | Street props, low-poly vehicles, blocky characters. Style-matched to nothing in this repo — use for props, not heroes. |
| **Poly Haven** | CC0-1.0 | Already vendored with provenance in this repo | PBR textures, HDRIs, models |
| **ambientCG** | CC0-1.0 (per their published licence docs) | | PBR textures including wet asphalt, puddles, water normals — see §7 |
| CMU Graphics Lab Motion Capture Database (+ the cgspeed BVH conversion) | "no licence fee / free for all uses"; predates modern SPDX conventions | | 2,500+ raw human motions. **Verify current terms before shipping** — it is not a formal CC0 grant, and the repo should record the terms text as it stood on the download date, the way the Poly Haven provenance JSON does. |
| Academic mocap corpora (AMASS and similar) | **Research / non-commercial only** | | **Licence-incompatible.** Do not use. |
| Proprietary web auto-rigging services | Account-bound licence, redistribution of the raw files restricted | | **Excluded on licence grounds.** This is also already the recorded position for the two vendored character GLBs. |

**Integration sketch**

1. Offline `scripts/world-assets/build-civilian-locomotion-v1.mjs`:
   load the CC0 clip set, use `SkeletonUtils.retargetClip(target, source, clip,
   options)` onto the project's humanoid bone naming, and write **one** GLB
   containing one skeleton, one mesh set and N `AnimationClip`s. Record a
   provenance JSON alongside it, following the exact schema of
   `public/assets/polyhaven-sandstone-blocks-08.provenance.json` (source URL,
   sha256 per input, generator path + hash, licence string).
2. Runtime `src/simulation/pedestrians/skinned-hero-pool.js`: a fixed pool of
   `SkeletonUtils.clone()`d characters, each with an `AnimationMixer`, each
   seeded with `mulberry32(seed)` (`src/citygen/core.js:43`) for phase offset
   and clip choice so the "no obvious loops" clause is satisfiable and the
   result stays deterministic. Advance every mixer from the single `delta` the
   canonical loop already passes into `CityRenderer.update`. **No `Date.now()`,
   no `performance.now()` inside the pool.**
3. `Docs/NPC_AAA_ANIMATION_ORCHESTRATION.md` already defines the behaviour-tree
   intents; the mixer consumes intent and emits pose. `npc-animation-layers.js`
   stays for the mid/far instanced band and for additive layers (gaze, weather
   hunch) on top of the skinned band.

**Risk.** Draw calls: N skinned characters is N draw calls plus N shadow-caster
draws, against 1,189 meshes / 297 casters today. Cap the near band and measure.
`AGENTS.md` requires render-only work to preserve draw/triangle budgets unless a
new budget is explicitly defined and verified — so this needs a stated budget
before it lands, not after.

---

## 7. Water and weather

**Blunt finding: there is no compatible third-party water for this renderer
under this round's rules.** Everything usable is either `ShaderMaterial`
(dead per §1.1) or TSL (excluded by this round's brief):

| Option | Status |
|---|---|
| `three/addons/objects/Water.js`, `Water2.js` | `ShaderMaterial` → silently renders as a blank `NodeMaterial`. Unusable. |
| `three/addons/objects/Reflector.js` | `ShaderMaterial`. Unusable. |
| `three/addons/objects/WaterMesh.js`, `Water2Mesh.js` | TSL/`MeshLambertNodeMaterial` + `reflector()`. **This is the correct long-term target** and is what `AGENTS.md` prefers. Excluded only by this round's no-TSL constraint. Note `reflector()` adds a full extra scene pass — legal (it is not a second renderer or loop) but expensive, and effectively unmeasurable on a box taking 30–65 s per frame. |
| Any standalone GPU ocean library | All are `ShaderMaterial`-based. Unusable. |

**What is actually available this round, with no new dependency:**

Today the water is a `MeshStandardMaterial` plane
(`renderer.js:2779, 2794`) bobbed as a whole by
`this.water.position.y = 0.45 + Math.sin(phaseClock * 0.6) * 0.05`
(`renderer.js:7645`) — a rigid plane moving up and down, which is why the
dimension scores 1/5. Without any shader:

1. Switch to `MeshPhysicalMaterial` and let the live IBL do the reflection work.
   `scene.environment` is already populated by `createEnvironmentRig`
   (`renderer.js:1951`), and `envMapIntensityFor(materialClass, model)`
   (`environment-ibl.js:1333`) already knows how to weight it per material class.
2. Two **CC0 water normal maps** (ambientCG or Poly Haven) on `normalMap` and
   `clearcoatNormalMap`, with their `texture.offset` advanced at different
   speeds and angles per frame from the existing clock. Two scrolling normal
   layers at different scales is the classic cheap ocean and needs **zero**
   shader code — only `offset`/`repeat` writes, which are plain uniforms.
3. Shoreline contact: a short vertex-coloured foam band generated where the
   water polygon meets the terrain contour that `buildTerrainContours`
   (`renderer.js:2599`) already computes. Geometry, not shader.
4. Rain and wetness: `src/render/detail-maps.js` already owns
   `applyDetailMaps(material, className, options)` (line 1271) and roughness
   packing (`encodeOrmRGBA`, `grimeRoughness`). Wetness is a **roughness/normal
   swap plus a darkened albedo multiplier**, which that module can express today
   — and `environment-ibl.js` already models `drizzle` as one of its three
   `WEATHER_KINDS` (line 114) with a matching `weatherProfile()` (line 666). The
   pieces are in the tree, unconnected.
5. Falling rain: one `InstancedMesh` of stretched quads around the camera,
   seeded, advanced by `delta`. Not a library.

Recommendation: score water/weather with in-repo work now, and open a **separate
TSL migration task** for `WaterMesh`/`Water2Mesh`, since `AGENTS.md` explicitly
prefers node materials and that is where a 4/5 on this dimension eventually
comes from.

---

## 8. Ranking

Effort is a rough engineering estimate for one agent working inside the
ownership boundaries, including the verifier the repo will demand. "Points" is
the realistic weighted-rubric gain, not the theoretical ceiling.

| # | Candidate | Dimensions moved | Est. points | Est. effort | Ratio | Verdict |
|---|---|---|---:|---|---|---|
| — | **Tier 0:** wire `applySunShadowFit` (already in-repo) | Lighting, technical integrity | +3 to +5 | 0.5 d | very high | Do first, no dependency |
| 1 | `three-mesh-bvh` | Technical integrity, character grounding | +3 to +5 | 1–2 d | high | **Adopt** |
| 2 | CC0 locomotion set + three's `AnimationMixer`/`SkeletonUtils` | Character grounding, NPC life | +4 to +6 | 4–6 d | high | **Adopt** (assets, not a package) |
| 3 | `@dimforge/rapier3d-compat` | Character grounding, technical integrity, vehicles | +3 to +5 | 4–6 d | medium-high | **Adopt** |
| 4 | `recast-navigation` | NPC and traffic life | +2 to +4 | 4–6 d | medium | Adopt next round |
| 5 | `meshoptimizer` (devDependency) | Technical integrity (LOD popping) | +1 to +2 | 2–3 d | medium | Adopt with an authored LOD policy |
| 6 | In-repo water/wetness (§7), no new dependency | Water and weather | +2 to +4 | 3–5 d | medium | Do it; no library exists that fits |
| 7 | `@gltf-transform/*` (devDependency) | Enabler for #2 and #5 | indirect | 1 d | medium | Adopt when #2 lands |
| 8 | `three-pathfinding` | NPC life | +1 to +2 | 3–4 d | low | Fallback only if wasm is rejected |
| 9 | `THREE.BatchedMesh` | Technical integrity | 0 to +2 | 2 d | low | **Probe `WEBGL_multi_draw` first** |
| 10 | `jolt-physics` | Vehicles | +1 to +3 | 8+ d | low | Revisit later |
| 11 | `three-nebula` | Weather | +0 to +1 | 2 d | low | Not now |
| 12 | `cannon-es` | Physics | — | — | — | **Reject:** dormant since 2024 |
| 13 | `yuka` | NPC life | — | — | — | **Reject:** second state store, fights AGENTS.md |
| 14 | `postprocessing`, `n8ao`, `Water.js`/`Reflector.js`, `three-custom-shader-material` | — | — | — | — | **Reject:** `ShaderMaterial`, does not run on this renderer |

### Top 3, with the reasoning stated

**1. `three-mesh-bvh` (MIT, 0.9.14, no wasm, CPU-only).** Highest ratio of
anything requiring an install. It is renderer-agnostic, so it cannot break the
one-renderer rule; it runs in Node, so it can back a verifier; and `ObjectBVH`
turns the exact bug that is blocking this round — a hole in sidewalk coverage,
found by a human staring at a 60-second software-rendered frame — into a
deterministic assertion that runs in seconds. It buys technical-integrity points
directly and makes the grounding work in #2 and #3 affordable. It is also the
smallest thing to back out if it disappoints.

**2. CC0 locomotion clips + three's built-in `AnimationMixer` and
`SkeletonUtils` (zero new npm dependencies).** Character grounding is 1/5 on a
weight of 10 with a gate of ≥4.0 — the largest single block of unclaimed points
on the board, and a dimension the rubric can *automatically reject* on
("characters visibly float, skate, clip"). The reason it is 1/5 is that every
character in the tree is hand-posed bone rotations on box limbs
(`src/citygen/actors.js`, `src/npc-animation-layers.js`) and `AnimationMixer`
appears nowhere in `src/`. Real captured locomotion under a CC0-1.0 grant, with
no attribution obligation and no runtime dependency, is the highest-value change
available and it adds nothing to the dependency tree. Ranked below #1 only
because it is a larger, more authored piece of work.

**3. `@dimforge/rapier3d-compat` (Apache-2.0, 0.20.0, ~2.9 MB shipped).**
Animation without contact still skates. Rapier's `KinematicCharacterController`
gives `computedGrounded()`, autostep for curbs and slope response — the literal
wording of the grounding gate — and `DynamicRayCastVehicleController` gives a
real suspension model for the player vehicle, a subsystem the brief describes as
barely existing. Chosen over the alternatives on maintenance (13 releases in 12
months vs. cannon-es's four dormant years), on packaging (`-compat` needs no
Vite wasm plugin, single-threaded so no COOP/COEP headers GitHub Pages cannot
set), and on the one thing this repo values most: documented cross-platform
determinism plus `world.createSnapshot()`, which makes a hash-equality verifier
trivial to write.

`recast-navigation` is deliberately fourth despite being the best pure-navigation
option available. NPC life scores 2/5 mostly on animation sameness and density,
not on path topology — the existing `TrafficSim` already routes agents along
plausible sidewalk paths. Recast raises the ceiling on that dimension, but only
after #2 has raised the floor. Doing it first would spend a week on navigation
quality that the current animation cannot show off.

---

## 9. Risks called out plainly

- **`ShaderMaterial` is a hard wall, not a preference.** Under `WebGPURenderer`
  it logs an error and renders a blank material. Any proposal built on
  `postprocessing`, `Water.js`, `Reflector.js` or a custom-shader wrapper should
  be rejected on sight, however good the demo video is.
- **`BatchedMesh` can silently draw nothing** on a WebGL2 backend without
  `WEBGL_multi_draw`. Probe the capability and record it in the capture manifest
  before building on it.
- **Yuka would become a second state store** and duplicates `TrafficSim`,
  `src/lifesim.js` and `src/npc-behavior-tree.js`. That is an `AGENTS.md`
  violation, not a taste call.
- **Rapier is Apache-2.0, not MIT.** Compatible with a proprietary distributed
  build, but it carries attribution and patent-clause obligations, and the repo
  has no `THIRD_PARTY_NOTICES` file today. Create one with the first adoption.
- **The vendored GLBs under `public/assets/` have no provenance records**, and
  at least one pair originates from a proprietary rigging service's samples.
  Either record provenance per file or replace them with CC0 assets before any
  frame containing them is presented as shippable.
- **Universal Animation Library 2 is only partly free** (~60–70%). Pack 1 is
  fully CC0. Record which pack each clip came from.
- **The CMU mocap terms are not a formal SPDX grant.** Widely used commercially,
  but capture the terms text on the download date rather than asserting "CC0".
- **Academic mocap corpora are research-only.** Licence-incompatible. Do not use
  them even for a throwaway test, because test assets have a way of shipping.
- **wasm payload.** Rapier ~2.0 MB + Recast ~0.34 MB. Both must be dynamically
  imported behind the existing loading HUD, never in the first-paint path.
- **Determinism is fragile across all three engines.** Rapier's guarantee is
  void if construction order varies, so collider and agent creation must iterate
  a sorted, seeded list — not `Map`/`Set` insertion order and not
  `Object.keys()` on a dynamically built object.
- **None of these fix artifact 1.** The sidewalk hole is a coverage bug inside
  `buildStreetSurfaceV2()`. #1 makes it detectable and prevents its return; it
  does not close the gap.
- **Fix-phase ownership.** Every runtime candidate needs one `step(delta)` call
  inside `CityRenderer.update` or the `main.js` loop — both currently
  un-editable. Land each as a self-contained module first, and batch the wiring
  into a single integration-owner diff, or none of it ships.

---

## 10. Action table

| Action | Package / source | Version | Licence | Owner subsystem | New runtime bytes | Blocking risk to clear first |
|---|---|---|---|---|---|---|
| Wire the existing sun shadow fit | none (`src/render/environment-ibl.js`) | in-repo | — | Integration | 0 | `renderer.js` is not editable in the Fix phase |
| Add scene BVH + street-coverage verifier | `three-mesh-bvh` | 0.9.14 | MIT | Rendering / QA | ~0 shipped if verifier-only; ≤290 KB if runtime | Never import its GLSL or `./webgpu` entries |
| Bake CC0 locomotion, add skinned near-band | Quaternius Universal Animation Library (+ three `AnimationMixer`, `SkeletonUtils`) | pack 1 | CC0-1.0 | Pedestrians/life | one shared GLB | Define and verify a new draw-call budget |
| Character + player-vehicle physics | `@dimforge/rapier3d-compat` | 0.20.0 | Apache-2.0 | Player / Simulation | ~2.9 MB, dynamic import | Create `THIRD_PARTY_NOTICES`; seed construction order |
| Bake navmesh, drive crowd | `recast-navigation` (`/core`, `/three`, `/generators`) | 0.43.1 | MIT (Recast upstream Zlib) | Pedestrians/life | ~1.0 MB, dynamic import | Crowd must live in the sim layer, not the renderer |
| Bake LOD chains | `meshoptimizer` | 1.2.0 | MIT | QA/tooling | 0 (devDependency) | Author the LOD policy; reuse `facade-depth` distances |
| Asset pipeline for the two above | `@gltf-transform/core` + `/functions` | 4.4.2 | MIT | QA/tooling | 0 (devDependency) | Must not rewrite locked production GLBs in place |
| Water normals + wetness response | ambientCG / Poly Haven CC0 textures + existing `detail-maps.js` | — | CC0-1.0 | Rendering | 2 texture sets | No shader; `offset`/`repeat` writes only |
| Later: node-material water | `three/addons/objects/WaterMesh.js` | in-repo (three 0.180) | MIT | Rendering | 0 | Needs a TSL migration task; `reflector()` costs a full extra pass |
| Do not adopt | `postprocessing`, `n8ao`, `Water.js`, `Reflector.js`, `three-custom-shader-material`, `cannon-es`, `yuka` | — | — | — | — | `ShaderMaterial` incompatibility, dormancy, or architecture conflict |
