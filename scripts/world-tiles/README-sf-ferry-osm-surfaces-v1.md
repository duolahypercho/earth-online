# Ferry OSM surface preview artifact v1

`build-sf-ferry-osm-surfaces-v1.mjs` extracts a small, deterministic visual
surface record from the local `public/data/sf/SanFrancisco.osm.pbf` source. It
does not modify the OSM atlas, compact city asset, runtime, or any tile
manifest.

Build and verify it with:

```bash
node scripts/world-tiles/build-sf-ferry-osm-surfaces-v1.mjs
node scripts/world-tiles/verify-sf-ferry-osm-surfaces-v1.mjs
```

The checked-in outputs are:

- `public/data/world/preview-artifacts/sf-ferry-osm-surfaces-v1/sf-ferry-osm-surfaces-v1.json`
- `public/data/world/preview-artifacts/sf-ferry-osm-surfaces-v1/sf-ferry-osm-surfaces-v1.receipt.json`

The artifact preserves the ten explicitly requested area ways in request
order, plus relation `2642389`. It retains OSM source type and IDs, sorted
source tags, exact node order and WGS84 longitude/latitude coordinates, the
relation's ordered members, its outer ring, and its two inner-hole rings.
`sourceWays` also preserves the three relation member ways even when they are
not in the requested ten-way list.

`surfaceRecords` has the only rendering sequence supplied by this contract:
its `renderOrder` follows the ten requested ways and then the relation. The
artifact deliberately supplies no clipping, offset, z-order correction, or
overlap ownership inference. Consumers must not interpret this source order
as a collision, navigation, physics, or production rule.

`boundsWgs84`, `boundsLocalMetres`, and `areaSquareMetres` are computed with
the documented per-record spherical equirectangular frame. The formula and
Earth radius are serialized in `localFrameFormula`; these values are preview
measurements, not survey or precision-geodesy claims.

The builder hashes and byte-counts the raw PBF before extraction. The receipt
hashes the generated artifact. The verifier reparses the PBF, checks the raw
digest and exact source topology/tags/coordinates, checks the relation holes,
and requires a byte-identical deterministic rebuild.

## Rights and limits

Source data is © OpenStreetMap contributors and is available under the Open
Database License (ODbL). Retain the attribution and comply with applicable
ODbL share-alike obligations when using a derivative. This is explicitly a
preview-only visual-source artifact. It has no runtime or manifest placement,
and makes no claim for collision, navigation, production use, elevation,
physics, or legal/survey accuracy.
