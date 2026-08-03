# Goal 08 - Integration QA and ship

- Owner: Integration and QA agent
- Status: not started

## Objective

Prove the expanded map still works with traffic, NPCs, vehicles, signals,
collisions, building entry, save/load, camera, UI, and the existing map, then
ship the milestone.

## Requirements

- All verifiers pass from a clean build: city, gauntlet, streaming, streamed
  agents, road grade markings, expansion, performance, live soak, physics.
- Save/load round trip includes the new sectors.
- UI district map and route cues cover new districts.
- Orchestrator commits the milestone.

## Dependencies

Goals 03-07.

## Performance budget

All stress tests at or below 16.67 ms application budget.

## Visual criteria

The final build passes the critic with no open critical findings.

## Verification

- `npm run build` and the full verify suite pass.
- QA screenshots and baseline comparison recorded.
