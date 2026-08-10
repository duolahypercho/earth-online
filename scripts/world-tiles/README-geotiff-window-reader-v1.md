# GeoTIFF window reader v1

`geotiff-window-reader-v1.mjs` is a dependency-free Node reader for only the
locked classic little-endian, 512×512-tiled float32 LZW/ Predictor=3 DEM layout.
It reads TIFF metadata plus only compressed tile byte ranges intersecting a
native pixel window. It does not select geographic coverage or perform CRS or
vertical-datum conversion.

`openGeoTiffWindowReader()` owns one file descriptor. The caller owns the
returned reader and must call its idempotent `close()` after all outstanding
`readWindow()` promises settle; methods must not be started after closing.
Concurrent window reads are supported. Each window result's `bytesRead` is the
sum of that call's compressed tile ranges, while `reader.readStats` is a shared
cumulative total whose values may advance as concurrent reads complete.

The affine methods use PixelIsArea corner coordinates: integer column/row
values map pixel grid corners, so the center of pixel `(column, row)` is mapped
with `(column + 0.5, row + 0.5)`. `modelToPixel()` returns the inverse corner
coordinate and may therefore return fractional values.

Run fixtures with `node scripts/world-tiles/verify-geotiff-window-reader-v1.mjs`.
With the ignored locked raw GeoTIFF present, append `--verify-raw` to verify a
fixed native pixel window, float values/hash, and bounded range-read count.
