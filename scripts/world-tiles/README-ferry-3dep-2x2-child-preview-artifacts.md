# Ferry 3DEP 2×2 child engineering-preview artifacts

`build-ferry-3dep-2x2-child-preview-artifacts.mjs` is an offline derivation
from the checked-in 809×810 parent preview, not a second GeoTIFF reader. It
materializes the existing four named parent quadrant views (`northwest`,
`northeast`, `southwest`, and `southeast`) as float32-le buffers in three
rigorously edge-preserving representations. `lod0-native` is a native
PixelIsArea raster view. `lod1-decimate-2` and `lod2-decimate-4` are
phase-locked selected-sample lattice views, not 2 m/4 m coverage rasters.
When a child window does not end exactly on the LOD stride, its final source
sample is included. This retains final source samples, including the common
split at parent sample 404, and makes every adjoining edge byte-identical at
every LOD. It does not turn the selected samples into PixelIsArea outer edges.

The artifacts and a deterministic receipt live at:

`public/data/world/preview-artifacts/sf-ferry-3dep-2x2-children-v1/`

Each receipt entry records exact parent/raw/source-lock/horizontal-lock/
vertical-reference-lock hashes, the signed source EPSG:26910 PixelIsArea affine
(easting grows with source column; northing decreases with source row), area
edges, native pixel-center formula, source-pixel window, selected source-index
layout (including exact terminal stride), dimensions, byte count, SHA-256,
nodata/min/max statistics, and a concrete edge-byte hash proof. The child
files are copied directly from parent float32 sample bytes: they do not
interpolate, quantize, vertically convert, or infer a new horizontal reference.
The `-999999` float32 nodata sentinel is copied unchanged; NaN/Infinity,
substitution, averaging, and interpolation are prohibited. The vertical
reference lock is contextual limitation evidence only; it applies no
transformation.

Run:

```sh
node scripts/world-tiles/build-ferry-3dep-2x2-child-preview-artifacts.mjs
node scripts/world-tiles/verify-ferry-3dep-2x2-child-preview-artifacts.mjs
```

This is strictly an offline engineering preview of parent quadrants, not
canonical sf-local tiles or core/buffer tile inputs. It has no runtime
placement, manifest promotion, collision, navmesh, or water data. LOD1/2 must
not be rendered, interpolated, resampled, or consumed by runtime or manifests.
Elevation values remain unconverted source-native samples declared NAVD88
metres by the locked USGS product metadata. That declaration does not establish
a local Ferry tidal datum, water level, geoid solution, or surveying/safety
use. The parent receipt's `verticalDatumUnresolved: true` is retained: it means
there is no embedded vertical CRS, geoid, epoch, or local reconciliation, not
that the locked product XML lacks its NAVD88 declaration. Horizontal placement
remains the generic locked EPSG:26910 operation with
4 m accuracy; no realization, coordinate epoch, or sub-metre claim is made.
