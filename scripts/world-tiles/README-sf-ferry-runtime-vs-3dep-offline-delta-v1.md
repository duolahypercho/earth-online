# Ferry runtime versus 3DEP offline delta diagnostic

`sf-ferry-runtime-vs-3dep-offline-delta-v1` is a deterministic, offline-only
diagnostic. It compares the current loaded-asset arithmetic in
`src/realmap/main.js` `elevationAt(x, z)` against the checked-in Ferry 3DEP
parent engineering-preview buffer. It does **not** change runtime terrain,
manifests, rendering, water, collision, or navigation.

The JSON and CSV live in:

`public/data/world/preview-artifacts/sf-ferry-runtime-vs-3dep-offline-delta-v1/`

The JSON holds every input SHA-256/length, all native interpolation evidence,
and the full contract. The CSV is a deliberately narrow row view for external
review: one row per named point or grid point, without hiding status fields in
nested JSON.

Run:

```sh
node scripts/world-tiles/build-sf-ferry-runtime-vs-3dep-offline-delta-v1.mjs
node scripts/world-tiles/verify-sf-ferry-runtime-vs-3dep-offline-delta-v1.mjs
```

The builder reads only checked-in inputs. It pins the runtime elevation JSON
and gzip, elevation builder, raw contour source, city snapshot/gzip, raw
DataSF shoreline, 3DEP source/horizontal/local-bridge/vertical-context locks,
region contract, and parent artifact/receipt. It asserts that both gzip inputs
decompress byte-identically to their raw JSON. It also chains the parent
receipt's actual raw-TIFF hash and raw-byte count back to the source lock. The
parent buffer is used directly; the raw GeoTIFF is not reopened.

Runtime comparison preserves the current behavior exactly: the 24.8948056459 m
grid, source builder's single 3×3 smoothing pass and 0.1 m output rounding,
the bilinear index interpolation, `grid[index] || 0` falsy handling, and OOB
zero-neighbour blending. The source never establishes whether its indexed
values physically represent contour-grid corners or cell centres, so the
runtime half-cell phase ambiguity remains a limitation rather than a hidden
alignment decision.

For 3DEP, local runtime `[x,z]` is bridged pointwise through the locked
local-to-WGS formula and locked generic EPSG:26910 operation. That operation
remains 4 m generic accuracy with no realization, epoch, survey, or sub-metre
claim. A 3DEP bilinear height is emitted only when all four PixelIsArea native
neighbours are finite and not `-999999`; otherwise its inspected height and
raw delta are null. PixelIsArea area edges are converted to interpolation
centres by `[+0.5 m east, -0.5 m north]`, explicitly independent from the
runtime grid phase.

The samples are source-derived named points (hero launch, clock tower, Ferry
Building centroid, all six `FERRY_BUILDING_STREETSCAPE_SOURCE.roadIds`
midpoints from the pinned hero-streetscape source, and the shoreline/Bay
points asserted by the pinned hero-shoreline verifier/classifier), a canonical
24 m grid over the whole planned
2×2 core `[1920,1536,2688,2304]` (33×33 points), and an inclusive 16 m grid
over the live hero core `[2144,1728,2528,2112]` (25×25 points). Every row
records both the elevation builder's exact `sf-city.json boundary[0]` predicate
at the sample point and the stricter test that all four 3DEP neighbour centres
are within that same ring. This deliberately does not substitute the all-rings
DataSF shoreline union used elsewhere by the hero code. Those predicates are
not collapsed near the shoreline. Summaries separate both boundary-0 land
predicates, query-point water-or-outside, and unavailable
3DEP/nodata-or-outside-parent records. Each of those summaries is emitted both
in aggregate and separately for `named`, `canonical-24m-2x2`, and `hero-16m`.

The optional reports are named `leastSquaresDescriptiveOnly`, one each for the
canonical 24 m and hero 16 m grids. Their populations are only records with
four finite/non-nodata 3DEP neighbours that all fall within the elevation
builder's `boundary[0]`. There is deliberately no aggregate or named-point
fit, because the grids overlap at different densities. A report is never
applied to either source, is not a vertical conversion, and cannot be used to
adjust terrain. The vertical context lock remains contextual: its station
reference is not a local Ferry tidal transfer. 3DEP here is bare earth, not
water, bathymetry, collision, navigation, or a production surface.
