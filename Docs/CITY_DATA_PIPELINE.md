# San Francisco city-data ingestion pipeline

Status: proposed production pipeline

Runtime target: Three.js r180, WebGL2

Geographic scope: City and County of San Francisco plus a low-detail Bay/horizon buffer

## Non-negotiable source policy

The shipped city must be reproducible from sources whose redistribution and
attribution requirements are recorded. Every downloaded snapshot gets a source
URL, retrieval time, upstream revision/date, license identifier, license URL,
SHA-256 digest, and any required attribution text.

Do **not** scrape, download, trace, photogrammetrically reconstruct, or train
from Google Maps, Google Earth, Street View, or their screenshots/tiles. Google
may be used by a human as a visual reference only where the applicable
[Google Maps/Google Earth Additional Terms](https://www.google.com/help/terms_maps/)
and [Google Maps Platform Terms](https://cloud.google.com/maps-platform/terms)
permit it. Do not place Google-derived coordinates, geometry, imagery, textures,
or cached screenshots in the asset pipeline.

Do not assume that a government website makes every linked item public domain.
The per-dataset metadata and any third-party credit must be checked at each
refresh.

## Approved primary sources

### City geometry and semantics: DataSF

The following portal records currently identify their data as
[Open Data Commons PDDL 1.0](https://opendatacommons.org/licenses/pddl/1-0/).
PDDL permits copying, modification, and distribution of the database. Preserve
the City attribution and portal metadata even where attribution is not a strict
PDDL condition; it provides provenance and avoids implying City endorsement.

| Use | Dataset | Important fields/notes |
| --- | --- | --- |
| Building massing | [Building Footprints (`ynuv-fyni`)](https://data.sfgov.org/d/ynuv-fyni) | Footprints plus 2010/LiDAR-derived ground and height statistics. Prefer `hgt_median_m`; record that the footprint source and some heights are historical. `p2010_z*` values are NAVD88 feet; `gnd_*_m`/`hgt_*_m` are metres. |
| Street graph base | [Streets – Active and Retired (`3psu-pn9h`)](https://data.sfgov.org/d/3psu-pn9h) | Daily-refreshed centerlines with stable Centerline Network Number (CNN), active status, and class code. Filter retired/private/paper streets deliberately rather than implicitly. |
| Sidewalk envelope | [Sidewalk Widths (2014) (`4g86-grxu`)](https://data.sfgov.org/d/4g86-grxu) | Useful for procedural sidewalk and curb offsets, but stale and incomplete. Negative/zero widths need an explicit fallback. |
| Signals | [Traffic Signals (`ybh5-27n2`)](https://data.sfgov.org/d/ybh5-27n2) | Signal/beacon inventory maintained by SFMTA; currently described as quarterly. It is not a phase/timing-plan feed. |
| Street vegetation | [Street Tree List (`tkzw-k3nq`)](https://data.sfgov.org/d/tkzw-k3nq) | Species, planting date, location, and caretaker data. Treat missing/old records as absence of knowledge, not proof of an empty planting bay. |
| Shore mask | [SF Shoreline and Islands (`rgcx-5tix`)](https://data.sfgov.org/d/rgcx-5tix) | Authoritative city/county shoreline mask for clipping land tiles; review its November 2023 format note on refresh. |
| Parcel/land-use joins | [Parcels – Active and Retired (`acdm-wktn`)](https://data.sfgov.org/d/acdm-wktn), [San Francisco Land Use (`c5ge-t6pj`)](https://data.sfgov.org/d/c5ge-t6pj) | Use for stable joins and procedural building archetypes. Never expose owner/person fields in runtime assets. Confirm the current record-level license when refreshing; the land-use record is presently marked CC0/PDD. |
| District grouping | [Analysis Neighborhoods (`p5b7-5n3h`)](https://data.sfgov.org/d/p5b7-5n3h) | Human-facing district labels only. Runtime streaming tiles remain a regular metric grid so district boundaries do not create load seams. |
| Terrain cross-check | [Elevation Contours (`rnbg-2qxw`)](https://data.sfgov.org/d/rnbg-2qxw) | Validation/reference layer, not the primary terrain surface. |

Use the portal metadata endpoint
`https://data.sfgov.org/api/views/<dataset-id>` as part of every refresh. For
large geospatial records, prefer the portal's bulk GeoJSON/geospatial export
over unbounded `$offset` pagination. Archive the original response before
normalization. Never make the game client depend directly on Socrata.

### Terrain: USGS 3DEP

Use the [USGS National Map Downloader](https://apps.nationalmap.gov/downloader/)
to obtain the best available 3DEP DEM covering the city and the immediate
Marin/Oakland horizon buffer. Select a consistent product/resolution for the
entire build; do not mosaic arbitrary zoom levels at runtime.

USGS-authored data are generally public domain in the United States, but USGS
pages can contain separately credited material. Follow the
[USGS copyrights and credits policy](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits),
retain product metadata, credit “U.S. Geological Survey,” and preserve the
USGS no-warranty/no-endorsement context. Do not use the USGS logo as an
endorsement badge.

### Shoreline, Bay elevation, and weather: NOAA

- Use the [NOAA Digital Coast Data Access Viewer](https://coast.noaa.gov/dataviewer/)
  for available coastal LiDAR/elevation coverage and source metadata.
- Cross-check shoreline vintages with the
  [NOAA National Shoreline Data Explorer](https://nsde.ngs.noaa.gov/).
- Use the [NOAA Coastal Relief Model](https://www.ncei.noaa.gov/products/coastal-relief-model)
  only for distant bathymetric/horizon shaping; its resolution is not suitable
  for near-shore collision.
- Use the [National Weather Service API](https://www.weather.gov/documentation/services-web-api)
  for optional live observations/forecast state. Cache on a server with a
  descriptive `User-Agent`; never put an upstream secret in client code.

NOAA products are generally not copyrighted, but third-party material may be.
Keep per-product metadata and follow the [NOAA disclaimer](https://www.noaa.gov/disclaimer).
Credit NOAA/NCEI/NGS or NWS as appropriate and do not imply endorsement.

### Roads, POIs, access, and turn restrictions: OpenStreetMap

OSM can fill semantics not present in the City centerline layer: lanes, access,
one-way state, turn restrictions, crossings, addresses, selected POIs, and
some transit infrastructure. Download a versioned Northern California extract
from [Geofabrik](https://download.geofabrik.de/north-america/us/california/norcal.html)
and spatially clip it offline. Do not bulk-load through the public Overpass API.

OpenStreetMap data are licensed under
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Display
“© OpenStreetMap contributors” with a link to
[openstreetmap.org/copyright](https://www.openstreetmap.org/copyright), and
follow the [OSMF attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines).
If an OSM-derived database is publicly distributed or used to produce a
substantial extract, satisfy the ODbL share-alike/source-offer obligations.

Keep OSM-derived tables in a separately versioned `osm-derived` artifact. Do
not silently merge them into a purportedly PDDL-only City database. The
rendered game can consume both layers; a merged routable graph must be treated
as ODbL unless legal review establishes otherwise.

### Transit schedules and live vehicles

- Static Muni schedule/route geometry: [SFMTA GTFS page](https://www.sfmta.com/reports/gtfs-transit-data)
  and its [current GTFS ZIP](https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip).
- Regional/Muni GTFS-Realtime: [511 SF Bay Open Transit Data](https://511.org/open-data/transit).
  It provides trip updates, vehicle positions, and alerts, requires an API
  token, and currently documents a default rate limit of 60 requests per hour.

The SFMTA download page does not itself state a general redistribution license.
The 511 portal requires acceptance of its current Data Agreement/terms.
Therefore, archive feed metadata and use transit data only after the current
terms have been reviewed. Keep 511 tokens server-side. For an offline shipped
simulation, derive anonymized schedules and route patterns from a dated,
approved snapshot; for “live” mode, proxy and cache the feed rather than
redistributing the raw service.

### Photographic reference

Use self-shot photography or per-file-cleared imagery. Wikimedia Commons may
be used only after recording each file's author, source URL, exact license,
attribution, and share-alike requirements. A category-wide assumption is not
enough. Do not turn reference photos into facade textures unless the license
permits derivative and commercial use.

## Reproducible ingestion stages

1. **Acquire and lock.** Download into an immutable, date-stamped raw snapshot.
   Generate `source.json` and SHA-256 for every file. Abort if metadata has no
   recognized license or has changed since the previous approved snapshot.
2. **Normalize.** Convert vectors to GeoPackage/GeoParquet and rasters to
   tiled GeoTIFF/COG. Preserve source identifiers (`sf16_bldgid`, CNN, OSM
   IDs, GTFS IDs) and source timestamps.
3. **Project.** Use EPSG:26910 (NAD83 / UTM zone 10N, metres) for offline
   geometry. Convert to a local floating origin centered near
   `37.7749, -122.4194` for WebGL. Never render raw longitude/latitude.
4. **Reconcile vertical datums.** Record horizontal CRS, vertical datum, unit,
   and geoid model per source. Convert terrain/building elevations to one
   declared runtime datum (recommended NAVD88 metres) before creating meshes.
   Treat Bay water level as a separately documented tidal datum/animation
   offset, not as an unexplained `y = 0`.
5. **Build terrain and shore.** Hydrologically/visually clean the DEM, clip land
   with the City shoreline, create a separate Bay surface, and generate
   watertight terrain skirts. Do not flatten San Francisco grades to simplify
   driving.
6. **Build structures.** Repair footprint topology, calculate height from
   approved height fields, extrude, and tag confidence. Use archetype fallback
   heights only when no measured height survives validation. Landmark models
   remain authored assets with their own source/license manifest.
7. **Build mobility graphs.** Snap City CNN endpoints within a small,
   documented tolerance; add OSM one-way/access/turn semantics; derive lanes
   from road class/width only when the source lacks them. Keep pedestrian,
   cycling, transit, and vehicle graphs distinct but cross-linked at legal
   transfer nodes.
8. **Build props and ecology.** Join signals and trees spatially, preserving
   species/confidence/source date. Procedural objects must be seeded by stable
   source IDs so a rebuild does not visibly reshuffle the city.
9. **Tile and optimize.** Cut all layers on the same 384 m EPSG:26910 grid,
   with a 16 m build buffer and deterministic ownership at tile borders.
   Generate GLB visual meshes, compact binary navigation/traffic graphs,
   simplified collision meshes, and three LODs. Quantize positions relative
   to each tile origin to avoid float jitter.
10. **Validate, publish, and attribute.** Run the checks below, write a
    versioned manifest, and publish only immutable hashed files. Generate the
    in-game credits page from source metadata rather than maintaining a second
    hand-written attribution list.

Suggested repository layout:

```text
Data/
  raw/<source>/<snapshot-date>/source.json
  normalized/pddl-city/
  normalized/osm-derived/
  build/<pipeline-version>/
public/data/city/
  manifest.v1.json
  attribution.json
  tiles/<tile-id>/<content-hash>/
```

Raw source data should normally remain outside the production web bundle.

## Streaming manifest contract

The manifest is the only city index read by the client. District names are
metadata; spatial loading uses regular tiles and distance/error budgets.

```json
{
  "schemaVersion": 1,
  "buildId": "sf-2026-08-01+pipeline.1",
  "generatedAt": "2026-08-01T00:00:00Z",
  "sourceSnapshot": "sources.lock.json",
  "crs": {
    "offline": "EPSG:26910",
    "vertical": "NAVD88 metres",
    "runtimeOriginWgs84": [-122.4194, 37.7749, 0]
  },
  "attributionUrl": "/data/city/attribution.json",
  "tiles": [
    {
      "id": "utm10-551-4182",
      "districts": ["Mission", "SoMa"],
      "bboxMeters": [551000, 4182000, 551384, 4182384],
      "originMeters": [551192, 4182192, 0],
      "geometricErrorMeters": [24, 6, 1.5],
      "lod": [
        {
          "level": 0,
          "visual": "tiles/utm10-551-4182/abc123/lod0.glb",
          "bytes": 182440,
          "sha256": "..."
        }
      ],
      "graphs": {
        "vehicles": "tiles/utm10-551-4182/abc123/vehicles.bin",
        "pedestrians": "tiles/utm10-551-4182/abc123/pedestrians.bin",
        "transit": "tiles/utm10-551-4182/abc123/transit.bin"
      },
      "physics": "tiles/utm10-551-4182/abc123/collision.glb",
      "sources": ["datasf:ynuv-fyni", "datasf:3psu-pn9h", "osm:2026-07-31"]
    }
  ]
}
```

Runtime policy:

- Load terrain/shore and LOD0 first, then traffic graph, then buildings/props.
- Prioritize the camera velocity cone and the next route corridor, not only
  radial distance.
- Maintain an inner fully simulated radius, a larger visual-only radius, and a
  distant impostor/horizon radius.
- Keep a two-tile hysteresis band to avoid load/unload thrash.
- Enforce explicit CPU/GPU/texture budgets and evict least-recently-visible
  tiles. Never let streaming mutate authoritative graph IDs.
- Cross-tile agents hand off by stable portal/node ID. If the destination tile
  is unavailable, hold or reroute them; do not teleport visibly.

## Required validation gates

### Legal and provenance

- Every artifact traces to one or more locked source records and SHA-256 values.
- Every source has a recognized license, attribution string, retrieval date,
  and approval state.
- The generated credits contain City, USGS, NOAA, OSM, transit, and per-asset
  attribution where those sources are present.
- No Google URL, tile, screenshot, cache, coordinate trace, or derived asset is
  present in `Data/`, `public/`, build caches, or training/reference manifests.
- OSM-derived databases remain labeled ODbL and can be offered in the form
  required by the license.

### Geometry and geography

- CRS axis order, units, and runtime origin are asserted in automated tests.
- No NaN/Infinity, invalid rings, self-intersections, zero-area footprints,
  inverted normals, or degenerate triangles.
- Building footprint/terrain penetration is within 0.25 m for the 99th
  percentile; no building floats more than 0.15 m at an entrance sample.
- Cross-tile border vertices and road nodes agree within 1 cm.
- Shoreline is closed; no land triangles extend into the Bay beyond the
  selected shoreline tolerance.
- Height sanity checks flag buildings below 2.2 m, implausible height spikes,
  and datum/unit mistakes. Compare known landmarks against surveyed/reference
  heights as regression fixtures.

### Routing and simulation

- Every active drivable CNN segment has a valid direction, class, length, and
  connected endpoint or an explicitly classified dead end.
- One-way/access/turn restrictions survive tiling. Run graph reachability from
  every district and flag isolated components.
- Signal inventory joins report match/unmatched/ambiguous counts; no phase plan
  is invented and labeled as authoritative.
- Sidewalk graphs have crosswalk links, curb transitions, and no path through
  building footprints or deep water.
- GTFS shapes/stops remain within tolerance of the street/rail network and all
  trips reference valid routes, services, and stop sequences.

### Runtime and visual quality

- Automated fly-throughs detect missing tiles, visible cracks, LOD oscillation,
  floating props, z-fighting, and origin jitter.
- Test representative steep grades (Nob Hill), dense towers (Financial
  District), irregular waterfront (Embarcadero), low-rise grids (Sunset), and
  bridge approaches.
- Record cold-load, steady-state, and worst-case budgets: tile latency, draw
  calls, triangles, texture memory, JS heap, graph handoff latency, and frame
  time on the minimum supported WebGL2 device.
- Compare fixed camera fixtures to rights-cleared reference photography. Visual
  review does not replace positional/height validation.

## Prioritized backlog

1. **P0 — Source lock and legal gate:** implement `sources.lock.json`, metadata
   fetch, license allow-list, hashes, generated attribution, and the explicit
   Google-derived-data rejection check.
2. **P0 — Terrain/shore prototype:** ingest one USGS DEM plus DataSF shoreline,
   reconcile NAVD88 metres, and stream a 3 × 3 tile test across Nob Hill to the
   Embarcadero.
3. **P0 — Building tile prototype:** ingest `ynuv-fyni`, validate measured
   heights, emit deterministic LOD GLBs and simple collision, and quantify
   height/date confidence in runtime metadata.
4. **P0 — Authoritative traffic graph:** build CNN topology, add OSM access and
   turn restrictions in a clearly ODbL artifact, then prove cross-tile vehicle
   handoff on steep grades.
5. **P1 — Sidewalk/crossing graph:** combine sidewalk widths, street geometry,
   crossings, grades, and building entrances; test wheelchair/step constraints
   separately from general pedestrian routes.
6. **P1 — Transit:** approve current SFMTA/511 terms, snapshot GTFS, proxy
   GTFS-RT, and bind vehicles to route-constrained simulation rather than raw
   GPS interpolation.
7. **P1 — Signals and curb systems:** spatially join signal inventory, parking,
   stops, and loading zones; maintain authored/simulated timing plans as a
   separate non-authoritative layer.
8. **P1 — Vegetation and street furniture:** seed species-appropriate tree
   assets by stable tree IDs and add confidence-aware procedural infill.
9. **P2 — District art pass:** rights-clear photographic references and author
   reusable material/archetype libraries for distinct neighborhoods. Do not
   bake restricted reference imagery into textures.
10. **P2 — Live conditions:** add cached NWS weather and reviewed 511 feeds
    behind resilient server adapters, with deterministic offline fallbacks.
11. **P2 — Full-city performance certification:** run the validation suite,
    visual fixture comparisons, accessibility checks, and minimum-device frame
    budgets before calling the full-city build shippable.
