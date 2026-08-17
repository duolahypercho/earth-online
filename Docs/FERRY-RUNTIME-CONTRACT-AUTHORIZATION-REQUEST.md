# Ferry Runtime Contract Authorization Request

Status: pending explicit authorization

Updated: 2026-08-16

## Decision requested

Authorize a deterministic, bounded Ferry runtime-contract package derived from
the repository's existing byte-locked OpenStreetMap and USGS 3DEP inputs. This
request does not itself grant authorization and must not be imported by the
production runtime.

The requested package is limited to metric tile
`epsg26910-1441-10893` and the approved Ferry source window. It does not grant
citywide promotion.

## Inputs that would be bound

- OSM snapshot: `public/data/sf/SanFrancisco.osm.pbf`, SHA-256
  `dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae`.
- Horizontal geometry lock:
  `public/data/world/source-locks/sf-ferry-osm-horizontal-geometry-v1.lock.json`.
- Horizontal CRS operation:
  `public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json`.
- Provisional elevation authorization:
  `public/data/world/source-locks/sf-ferry-3dep-terrain-elevation-authorized-v1.lock.json`.
- Existing metric tile receipt and GLB for `epsg26910-1441-10893`.

The production authorization must record the exact byte hashes of every lock,
receipt, source raster, and generated sidecar. Path identity alone is not
sufficient.

## Measured approved-window source coverage

Run `npm run verify:ferry-osm-semantic-coverage` to audit the complete geometry
lock window. The deterministic verifier currently reports:

- 720 `highway=*` ways and 532 explicit pedestrian ways;
- 168 crossing nodes and 172 traffic-signal nodes;
- 72 kerb nodes and 105 public-transport/bus-stop nodes;
- 120 relevant route relations and 17 turn-restriction relations;
- explicit `oneway` semantics on 118 highway ways, `lanes` on 102, `maxspeed`
  on 72, `access` on 90, `surface` on 514, `sidewalk` on 108, and `cycleway`
  on 65.

This is sufficient to design a fail-closed graph for source-mapped streets,
footways, crossings, signal locations, and route membership. It is not
sufficient to claim exact lane placement, signal phases, continuous curbs, or
unknown widths and surfaces without separately authorized gameplay policy. The
verifier intentionally reports `playableContractReady: false` because source
presence is not runtime authorization.

## Exact-tile feasibility proof

Run `npm run verify:ferry-osm-contract-feasibility` to rebuild a read-only,
in-memory graph proof for tile `epsg26910-1441-10893`. The verifier reads only
the byte-validated OSM ways, ordered node references, tags, and EPSG:26910
coordinates used by the production tile builder. It does not read render
meshes, terrain, receipts as topology, or runtime state, and it writes no
artifact.

The current locked proof reports:

- 221 admitted highway ways: 46 vehicle and 175 pedestrian;
- a vehicle graph with 182 nodes, 260 directed edges, and one 182-node weak
  component;
- a pedestrian graph with 442 nodes, 481 source-connectivity edges, and six
  components sized 3, 4, 6, 7, 11, and 411 nodes;
- 35 explicit crossing ways, 41 shared pedestrian/vehicle source-node
  intersections, and 63 exact tile-boundary portals;
- unresolved source semantics on 13 vehicle ways for lanes, 16 for speed, 5
  for surface, and 6 for sidewalk; no unsupported explicit direction value.

The command pins those counts and the relevant source/lock hashes so an empty,
degraded, or source-drifted graph fails instead of appearing successful. Its
output remains `proofOnly: true`, `writesArtifacts: false`, and
`runtimePromotionReady: false`. Standalone signal nodes, turn-restriction
relations, terrain, vertical data, artifact generation, and runtime promotion
remain outside the proof.

## Requested source-neutral contract

The builder may emit only source-present semantics or explicitly authorized
deterministic gameplay policy. Each record must carry its source OSM IDs and a
derivation label.

1. Directed street centerlines from OSM highway ways, clipped in EPSG:26910.
2. Direction, access, lane count, speed, surface, cycleway, and transit tags
   where present in the locked source.
3. Explicit footway, pedestrian, path, steps, sidewalk, crossing, kerb,
   traffic-signal, public-transport, and bus-stop semantics where present.
4. Graph nodes with exact source-node identity or deterministic tile-boundary
   identity; no topology may be inferred from rendered triangles.
5. Deterministic spawn/recycle zones derived from valid graph boundaries and
   labelled as gameplay policy rather than geographic source truth.
6. A 385 by 385 Float32 provisional bare-earth height sidecar plus an explicit
   traversability classification sidecar, both hash-verified by the package
   receipt.
7. O(1) source-surface height queries using the builder's fixed southwest to
   northeast lattice diagonal. No runtime raycasting against render meshes.

## Requested provisional vertical use

Permit the bounded runtime to use the locked, source-declared elevations for
player, vehicle, and pedestrian grounding while retaining the exact status
`source-declared-navd88-unrealized` in receipts and diagnostics.

This permission must not be described as realized NAVD88, certified terrain,
survey grade, sub-metre truth, tidal truth, or a citywide vertical datum.
Rendered road lift, curb lift, and authored presentation offsets must be
separate labelled presentation values and may not alter the bare-earth source
samples.

## Fail-closed policy

- Missing lane counts, sidewalk positions, crossings, restrictions, or signals
  remain `unknown`; the builder may not silently invent source truth.
- Any default used for simulation or presentation must be individually named,
  deterministic, bounded, and explicitly authorized as gameplay policy.
- OSM's documented bidirectional default may apply when `oneway` is absent,
  but it must be recorded as an OSM-schema interpretation. Missing lane counts,
  speeds, widths, surfaces, and sidewalk placement remain unknown unless a
  separately named fallback policy is authorized.
- Relations and turn restrictions that the builder cannot assemble must be
  reported as unsupported; they may not be ignored while claiming coverage.
- Preview artifacts and preview-only Boolean locks remain production-ineligible.
- Source GLB positions, indices, origin, scale, and receipt identity remain
  immutable.

## Required promotion evidence

Authorization alone is insufficient for runtime promotion. A candidate package
must also prove:

- byte-identical rebuilds from the locked inputs;
- exact EPSG:26910 origin subtraction once and one unit per metre;
- complete source-ID and tag ledgers for admitted features;
- zero unresolved graph references and zero successor endpoint gaps;
- source-tag coverage counts for every semantic family;
- exact height-lattice dimensions, finite samples, diagonal policy, and hashes;
- explicit traversability roles for every playable sample;
- no preview-artifact imports and no render-mesh topology inference;
- stable renderer, canvas, scene, world root, clock, and animation-loop identity;
- matched walk/drive/day/dusk QA with no clipping, errors, or resource growth.

## Current blocker

The existing horizontal lock authorizes OSM geometry as an input but requires a
separately validated package for runtime promotion. The current terrain lock
explicitly prohibits runtime integration, and the source-tone authorization
records `gameplayChanged: false`. Therefore no production code may consume the
proposed contract until an authorization explicitly grants the bounded runtime
and provisional-grounding uses above.
