# Earth walkable-tile workflow

This workflow lets the Three.js world expand from one walkable San Francisco
block to adjacent city tiles and, eventually, to any supported Earth location
without making distant generation alter nearby gameplay.

The initial Ferry contract is checked in at
`public/data/world/regions/sf-ferry-building-hero.region.json`, with four
regular tile manifests in `public/data/world/tiles/`. The current live runtime
hero bounds are `[2144, 1728, 2528, 2112]` and its 16 m buffer is
`[2128, 1712, 2544, 2128]`; both span the 2 x 2 grid set
`sf-local-5-4`, `sf-local-6-4`, `sf-local-5-5`, and `sf-local-6-5`.

Those four files are deliberately **metadata-only planned tiles**. They do
not mean that production terrain, collision, roads, buildings, portals, or a
neighbor handoff have been built or published. The live Three.js hero slice is
recorded separately so a runtime region is never mislabeled as a complete
regular tile.

## Coordinate and identity policy

- Every tile has a permanent WGS84 anchor at its regular-cell centre for global
  lookup.
- A city uses a regular 384 m local-metre grid with a 16 m build buffer.
- The existing SF preview data uses `sf-atlas-linear-v1`; it is an explicitly
  labeled preview frame. Production source geometry is rebuilt in EPSG:26910
  with NAVD88 metres before release.
- `sf-local-X-Y` uses zero-based grid indexes. The Ferry hero region crosses
  four cells (`5-4`, `6-4`, `5-5`, `6-5`); north/east/south/west neighbors are
  derivable, not guessed.
- The seed is SHA-256 of the manifest's immutable grid identity. It must seed
  procedural content by stable feature IDs, never by array iteration order.
- The lower lexical tile ID owns a shared edge. Both sides build from the same
  16 m buffered input window and must emit matching edge signatures.

This gives a location two identities: a global Earth key for routing and a
local tile key for efficient Three.js rendering. The runtime keeps player
relative positions near `(0, 0, 0)`; it never renders raw longitude/latitude.

## Build order

Run the offline contract gate first:

```bash
node scripts/world-tiles/verify-world-tile.mjs
node scripts/world-tiles/plan-world-tile-build.mjs
```

The verifier checks all checked-in tile manifests plus the Ferry region: the
full regular 2 x 2 coverage, no grid gaps, reciprocal in-region adjacency,
launch and 74 m clock-tower inclusion, deterministic seeds, and the explicit
not-published state. Pass a manifest path to validate one tile only. The plan
command prints all four deterministic tile plans by default, or one plan when
given a manifest path.

A worker may advance an individual tile from `planned` only after its source
locks record source URL, snapshot date, license approval, attribution, and
SHA-256 digest. The existing SF asset records current OSM and shoreline
provenance; a locked USGS 3DEP terrain source is intentionally still required.

Build workers must:

1. Clip locked sources to the buffered bounds and retain source feature IDs.
2. Construct terrain, shore, roads, sidewalks, buildings, and water in a
   reconciled metric/vertical frame.
3. Build collision, pedestrian and traffic graphs, and cross-tile portals.
4. Produce LOD 0 (walkable), LOD 1 (adjacent continuity), and LOD 2 (district)
   artifacts relative to the tile origin.
5. Publish content-hashed immutable outputs only after all QA checks pass.

AI-assisted art may improve non-authoritative appearance such as materials and
small props. It cannot replace authoritative elevation, shorelines, roads,
footprints, legal access tags, or traffic restrictions.

## Required publish gate

The manifest requires provenance, geometry/shoreline, street/sidewalk seam,
portal handoff, character grounding, NPC/traffic safety, weather/water/light,
fixed-camera visual, and performance checks. The specified checks are a
release contract, not a claim that current planned artifacts have passed them.

For the visual comparison, use rights-cleared photos and capture the same
camera pose, field of view, time-of-day/weather preset, and tile version. A
side-by-side image helps find facade, material, lighting, and density defects;
it does not override surveyed geometry or source restrictions.

## Expansion

First acquire/lock the four Ferry coverage cells and publish enough adjacent
cells to prove seam-free walking, traffic, NPC handoff, and deterministic
unload/reload. Then expand by adjacent regular cells. New cities receive their
own declared projected frame and source locks but keep the shared Earth key,
tile schema, buffered-edge rules, LOD contract, and QA gate. A global coverage
service can then mark cells as `source-only`, `planned`, `generated`,
`validated`, `hero-quality`, or `published` without requiring the whole planet
to be generated up front.
