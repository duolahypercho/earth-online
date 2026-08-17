# Earth Online San Francisco Hero Campaign

Updated: 2026-08-16

## Scope and invariant

The first representative hero block is the 60–100 metre Ferry Plaza frontage
and Market Street approach. It must ship through canonical `/` with the existing
single WebGPU renderer, canvas, scene, world root, runtime state, clock, and
animation loop. Legacy RealMap modules are migration inputs only.

The production-authorized metric core is currently limited to tile
`epsg26910-1441-10893`. Its horizontal CRS is EPSG:26910 at one unit per metre.
Its vertical state remains `source-declared-navd88-unrealized`; no certified
vertical claim is permitted.

## Visual references

Runtime reference: `.qa-ferry-final-audit-latest-day-clean.png`

- [Day hero target](visual-targets/ferry-hero-day-target.png)
- [Dusk hero target](visual-targets/ferry-hero-dusk-target.png)
- [Close entry target](visual-targets/ferry-storefront-target.png)
- [Living-street target](visual-targets/ferry-living-street-target.png)

The targets are implementation direction, not geographic evidence. Source
geometry, receipts, and simulation contracts remain authoritative.

## Consolidated baseline

### Canonical runtime

- Entry: `/` -> `src/citygen/main.js` -> one `CityRenderer` and one
  `renderer.setAnimationLoop`.
- Default world: local Market/SoMa OSM-derived preview slice, 700 buildings,
  2,833 street records, 22 signals, 48 pedestrians, WebGPU.
- Metric switch before source-scope correction: 10 of 803 manifest tiles, 587
  buildings, 2,521 road ways, no canonical traffic, collision, blocks, signals,
  or pedestrian paths.
- Latest canonical CityGen hero counters recorded by the existing verifier:
  476 draws, 449,146 triangles, 401 geometries, 258 textures. Those counters
  describe Market/Kearny, not the one-tile Ferry metric core.
- Canonical frame-time, GPU-time, byte-memory, cold-load, streaming-time, and
  genuine soak telemetry do not yet exist. Legacy WebGL baselines are not valid
  evidence for `/`.

### Visual baseline score

| Category | Score / 10 | Primary failure |
| --- | ---: | --- |
| San Francisco identity | 6 | Landmark recognizable, surrounding street language generic |
| Building silhouette/proportions | 4 | Hall and tower read, but hierarchy and tower articulation are weak |
| Facade depth | 2 | Openings read as flat dark panels |
| Material credibility | 2 | Broad flat colors; little normal/roughness/AO response |
| Street/sidewalk construction | 2 | Large undifferentiated planes, weak curb/gutter/utility layering |
| Prop density/placement | 3 | Sparse and repetitive plaza furniture |
| Lighting/grounding | 2 | Weak local contact and indirect-light appearance |
| Traffic appearance/behavior | 2 | Metric core has no traffic; preview traffic graph is invalid |
| Pedestrian appearance/behavior | 3 | Preview actors move, but crossings/destinations are decorative |
| Repetition control | 2 | Facade bays and trees repeat mechanically |
| LOD/streaming stability | 4 | Detail partition exists, but building/material LOD does not |
| Performance | 5 | Resource counts exist; current frame-time evidence is missing |

Overall visual baseline: 3.1 / 10. Behavior baseline: 2.5 / 10. This is a
failing baseline, not an accepted hero milestone.

### Simulation baseline

- `buildTrafficGraph` currently assigns predecessor edges as `outgoing`.
  The live default slice showed 1,668 invalid successor links and a maximum
  endpoint jump of 1,031.43 metres.
- Signals have duplicated clocks and no opposing movement groups.
- Pedestrians use isolated shuttle paths; source footways, crossings,
  destinations, schedules, and signal consumption are absent.
- Muni, bicycles, and most parked cars are presentation cues rather than full
  simulation entities.

## Target-derived implementation specification

### Geometry modules

1. Source-aligned Ferry Building presentation rooted on OSM way `558731934` or
   the corresponding authorized metric feature. Keep the source footprint and
   collision volume authoritative.
2. Batched terminal-hall facade: 18–24 bays per long face, recessed arched
   glazing, jamb/header/sill returns, pilasters, stringcourses, cornices,
   plinth, entrance canopies, clock tiers, bezel, and roof silhouette.
3. Source-neutral street kit: asphalt, rail/track slots where source-backed,
   curb, gutter, ADA ramp, sidewalk/plaza pavers, drainage, utility plates,
   crosswalk and stop-line presentation.
4. Bounded furniture kit: historic lamps, signal/parking poles, bollards,
   benches, planters, bike racks, trash cans, newspaper boxes, and transit
   furniture. Prefer instancing or merged role batches.

### Facade grammar

- Near (0–45 m): full recesses, masonry returns, mullions, entrance interiors,
  plinth and cornice relief.
- Mid (45–120 m): retain silhouette, arches, pilasters, cornices, and emissive
  window grouping; collapse small divisions.
- Far (>120 m): source shell plus baked/atlas response; no submitted near-detail
  triangles.
- Vary window/interior response in deterministic groups, not per-frame noise.
- No invented storefront brand or landmark ornament may override source truth.

### Material families

- Sandstone: the locally provenanced Poly Haven CC0 albedo/normal/ORM set.
- Bronze/dark metal: scalar material plus shared detail response; no new
  unprovenanced texture.
- Glass: bounded roughness/transmission approximation with environment response,
  not mirror-like reflection.
- Ground: procedural or newly receipted asphalt, curb concrete, pavers, painted
  markings, metal utility covers, and restrained wear. Existing unreceipted
  Market ground textures are not production candidates.

### Street life and simulation requirements

- Traffic graph successors must share the current edge endpoint within 0.25 m.
- Lane offsets derive from segment direction, not ID prefixes.
- Signals are simulation-owned, share one fixed-step clock, define movement
  groups and stop-line endpoints, and are mirrored by rendering.
- Hero block supports moving traffic, one source-valid Muni route cue, legal
  parking/loading presentation, and bicycle entities only on valid contracts.
- Pedestrians walk connected sidewalks, wait at curb queues, cross only during
  a valid phase, and reach deterministic destinations. Target active population
  is 18–30 in the hero envelope, not a cinematic crowd.

### Lighting

- Day: soft sky fill, camera-local sun shadow coverage, grounded contacts, and
  restrained facade/window reflection.
- Dusk: warm entry/window emissive response and a camera-local practical-light
  pool. Reuse the existing pooled-light strategy; do not add a second lighting
  rig or persistent light per fixture.
- Preserve one 2K sun shadow map for the first slice. Any resolution increase
  requires matched performance evidence.

### Budget

Establish a fresh one-tile Ferry baseline before accepting presentation work.
Until then, the candidate delta limits are:

- no more than +25 submitted draw calls;
- no more than +75,000 submitted triangles at the near hero pose;
- no submitted near-detail triangle increase at the aerial pose;
- no more than +16 resident geometries and +8 resident textures;
- no more than 64 MiB estimated new mipmapped texture residency;
- no more than 12 MiB compressed hero payload;
- application-frame p99 target <=12 ms, hard budget 16.67 ms, candidate delta
  <=2 ms;
- cold playable <=2 seconds and <=250 ms regression;
- post-traversal hero readiness <=2 seconds with <=8 ms admission work in any
  one frame;
- no resource growth after a second traversal lap and no app/page/console
  errors.

## District coverage matrix

| District family | Foundation | District kit | Hero content | Status |
| --- | --- | --- | --- | --- |
| Ferry Building / Embarcadero | One authorized tile | Legacy kit available | Target campaign active | Active |
| Market Street | Preview OSM slice | Six-building atlas, provenance incomplete | Market/Kearny pass exists | Blocked on provenance/source policy |
| Downtown / Financial District | Preview/manifest geometry | Generic only | None canonical | Pending |
| Chinatown | Preview/manifest geometry | Legacy profile only | None | Pending |
| North Beach | Preview/manifest geometry | Legacy profile only | None | Pending |
| Mission District | Preview/manifest geometry | Legacy profile only | None | Pending |
| SoMa | Preview OSM slice | Generic only | SFMoMA preview work | Pending |
| Civic Center | Preview/manifest geometry | Legacy profile only | None | Pending |
| Victorian residential | Preview/manifest geometry | Legacy profile only | None | Pending |
| Sunset / Richmond | Preview/manifest geometry | Legacy profile only | None | Pending |
| Waterfront / piers | Ferry source locks | Legacy Ferry kit | Ferry active | Partial |
| Industrial southeast | Preview/manifest geometry | Legacy profile only | None | Pending |
| Parks / hills / coast | Coverage incomplete | None canonical | None | Blocked on terrain authorization |
| Landmark-specific zones | Mixed | Ferry and SFMoMA candidates | Ferry active | Partial |

## Milestone ledger

Completed:

- Six independent read-only discovery audits.
- Canonical and Ferry migration baseline captures.
- Day, dusk, close-entry, and living-street targets.
- Initial visual/simulation/performance/source gap analysis and budgets.
- Canonical Metric SF constrained to the one authorized Ferry tile; browser
  evidence reports 24 buildings, 221 road ways, and `1 / 803 metric tiles`.

Active:

- Capture a fresh one-tile baseline and lock its counters.
- Correct the canonical traffic successor topology and add a rejecting gate.

Blocked:

- Citywide production rollout: no citywide OSM horizontal authorization.
- Certified terrain: current canonical elevation source lock prohibits runtime
  use; Ferry vertical data is provisional.
- Production use of current Market/ground/interior textures: provenance missing.

Next:

1. Correct traffic successor topology and add a rejecting continuity gate.
2. Establish the playable Ferry street/collision contract without importing a
   legacy renderer or loop.
3. Port the source-aligned Ferry facade module to the canonical building
   subsystem, then verify day/dusk matched captures.
4. Add connected sidewalk/crossing behavior and simulation-owned signals.
5. Commission independent visual, authenticity, gameplay, simulation,
   performance, and blind A/B judgment.

Known risks:

- The exact authorized metric tile is currently geometry-only in canonical `/`.
- The richer Ferry modules remain coupled to legacy RealMap and require
  source-neutral extraction.
- Existing automated visual gates can pass colorful/edge-dense but materially
  flat images; matched human/perceptual review remains required.
