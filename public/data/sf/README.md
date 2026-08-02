# Generated San Francisco data

The files in this directory are generated and git-ignored:

- `sf-atlas.json` — full OSM parse from `scripts/build-sf-atlas.mjs`.
- `sf-city.json` / `sf-city.json.gz` — compact sandbox asset from
  `scripts/build-realmap-assets.mjs`.
- `sf-shoreline.geojson` — DataSF Shoreline and Islands download.
- `SanFrancisco.osm.pbf` — optional bbbike OSM extract.

Regenerate with:

```bash
npm run build:realmap-assets
```

The compact asset embeds source URLs, licenses, attribution, and SHA-256
digests in `sf-city.json` under `meta.sources`.
