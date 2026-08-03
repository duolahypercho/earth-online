# Goal 03 - District expansion wave A: dense northeast

- Owner: District and environment agent
- Status: in progress

## Objective

Add authored sectors covering Chinatown, Nob Hill, Russian Hill, Marina, and
the SoMa/Embarcadero transition using the goal 02 geography reference, in the
existing low-poly style and schema.

## Requirements

- Extend `EXPANSION_SECTORS`/overlays in `src/sf-expansion.js` with correct
  grid lines, diagonals, grades, palettes, styles, landmarks, and waterfronts.
- Extend `src/streaming.js` district profiles, waterfront descriptors, and
  grade functions only as needed for these sectors.
- Every building stays enterable with an entrance, walkable interior shell,
  street return path, and district archetype metadata.
- Road network for each sector remains connected to the merged graph.
- No generic grid: Chinatown density, Nob Hill grades, Marina flat frontage,
  and SoMa block scale must be distinguishable.

## Dependencies

Goals 01 and 02.

## Performance budget

Same 16.67 ms application budget. Authored detail must not increase active
detail-sector cost; use the existing 36-building budget and streaming proxies.

## Visual criteria

District signatures must pass harsh visual review against real references and
the current build. No obvious procedural repetition inside a block face.

## Verification

- `npm run verify:expansion` updated to cover the new count and passes.
- `npm run verify:performance` passes all stops including the new districts.
- Every new sector exposes >= 2 interior archetypes and resolvable portals.
- Integration agent confirms traffic lanes, signals, and spawns for new roads.
