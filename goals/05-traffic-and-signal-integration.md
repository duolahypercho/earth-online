# Goal 05 - Traffic and signal integration for new districts

- Owner: Traffic-integration and traffic-light agents
- Status: not started

## Objective

Embed every new road and intersection from goals 03 and 04 into the existing
traffic, navigation, and signal systems.

## Requirements

- Lane data, spawn points, junction metadata, turn/priority rules, pedestrian
  crossings, and traffic-light positions for all new roads.
- Shared signal timing stays authoritative; new plans only add positions.
- Traffic never spawns into missing roads or disconnected lanes.
- NPC routing uses the merged graph, including diagonals and grade roads.

## Dependencies

Goals 03 and 04.

## Performance budget

Dense intersections must stay under budget during rapid traversal.

## Visual criteria

Lights and crossings visually correspond to geometry and behavior.

## Verification

- `npm run verify:city`, `verify:gauntlet`, and `verify:expansion` pass.
- Live soak passes with traffic active at new intersections.
