# Ferry 3DEP 2×2 parent engineering preview

`build-ferry-3dep-2x2-parent-preview.mjs` reads one native, integer EPSG:26910
window from the byte-locked USGS GeoTIFF with `geotiff-window-reader-v1`. It
uses the committed generic WGS 84-to-EPSG:26910 lock to project the committed
Ferry 2×2 coverage request, then takes an outward-rounded window with a one
native-pixel geometric guard. The result is a raw little-endian float32 sample
buffer and its deterministic JSON receipt at:

`public/data/world/preview-artifacts/sf-ferry-3dep-2x2-parent-v1/`

Before every build and no-write rebuild, the builder streams and hashes the
entire raw TIFF and requires it to equal the source-lock SHA-256. It then uses
the bounded window reader for the actual sample extraction. The receipt keeps
those two operations distinct, recording the verified raw hash plus exact
compressed source-tile indices and byte count, affine, native window,
nodata/min/max, and four child views. The output is explicitly serialized with
`Buffer.writeFloatLE` per sample, so it does not alias host-endian
`Float32Array` storage. Child views are index windows into the single parent
buffer rather than copied rasters; the receipt hashes every shared child
boundary after asserting byte identity.

Run:

```sh
node scripts/world-tiles/build-ferry-3dep-2x2-parent-preview.mjs
node scripts/world-tiles/verify-ferry-3dep-2x2-parent-preview.mjs
```

The verifier performs a no-write rebuild from the bounded source read and
requires byte-identical parent and receipt outputs. This is strictly an
engineering-preview artifact: it is not a terrain manifest, has no runtime
placement, makes no sub-metre horizontal claim (the locked operation is 4 m),
and leaves vertical datum/geoid/NAVD88 reconciliation unresolved.
