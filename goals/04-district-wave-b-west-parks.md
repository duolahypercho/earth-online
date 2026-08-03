# Goal 04 - District expansion wave B: west and parks

- Owner: District and environment agent
- Status: not started

## Objective

Add authored sectors for Golden Gate Park, Richmond, Inner Sunset, and Twin
Peaks with park/natural surfaces, ocean park edge, hill grades, and the
neighborhood scale of the western districts.

## Requirements

- Park sectors are not generic green boxes: tree lines, meadow/surface
  variation, path geometry, and landmark massing (park museum band, windmill
  edge, Sutro/Twin Peaks presence) must read from distance and on foot.
- West-side blocks follow the real slow street and alley character.
- Same enterability, road graph, traffic metadata, and signal rules as wave A.

## Dependencies

Goals 01, 02, and 03 integration patterns.

## Performance budget

16.67 ms application budget; park geometry must not spike draw calls.

## Visual criteria

The west end must not look like the downtown grid or a procedural suburb.

## Verification

- Expansion, performance, and city simulation gates pass with west stops.
- Visual critic compares park and hill sectors to references and approves.
