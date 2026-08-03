# Goal 02 - Verified San Francisco geography reference

- Owner: SF geography agent (grok-4.5)
- Status: complete

## Objective

Produce `Docs/SF_GEOGRAPHY_REFERENCE.md` that translates real San Francisco
geography into the game's local meter grid for the next expansion sectors.

## Requirements

- Document the game coordinate convention: +X east, +Z north, sector centers
  at 384 m grid multiples, existing sectors listed in
  `src/sf-expansion.js`.
- For each new sector, define: district name and boundaries, street grid
  offsets (local x/z line positions), real street names, road widths,
  intersection types, block density, grades/elevation, waterfront edges,
  landmarks with local positions, building footprint archetypes, and visual
  character notes.
- Use public geographic sources only (OSM/ODbL, DataSF, USGS, NOAA, SFMTA).
- No proprietary 3D assets or copied geometry.

## Dependencies

Goal 01. Implementations depend on this document.

## Performance budget

Document only. Any data that implies more than 36 detailed buildings per
authored sector must say how the visibility system should budget it.

## Visual criteria

Street names, grades, waterfronts, and landmarks must match the reference city
closely enough that a San Francisco native can identify each district.

## Verification

- Doc exists and covers every planned sector.
- Data is cross-checked against at least two public sources where practical.
- Orchestrator accepts before district implementation starts.

Result (2026-08-02): `Docs/SF_GEOGRAPHY_REFERENCE.md` delivered with 10
footprint-valid sector tables, connectors, grades, waterfronts, and landmarks.
Sector corrections: Marina `0:5`, Golden Gate Park `-5:0`, Richmond `-5:1`.
