# Goal 06 - Visibility, streaming, and performance milestones

- Owner: Visibility and performance agents
- Status: not started

## Objective

Keep the enlarged map at 60 FPS: only visible/relevant content rendered,
stable streaming, and no traversal or entry spikes.

## Requirements

- Verify frustum culling, LOD/proxy rings, sector chunking, instancing,
  batching, and atlas usage on the new sectors.
- Measure FPS, frame time, 1% low, draw calls, triangles, GPU/JS memory,
  loading, streaming, rapid traversal, dense intersections, and entry cost.
- Distant/off-screen content must not consume render or simulation budget.

## Dependencies

Goals 03-05.

## Performance budget

Application frame work <= 16.67 ms, no major spikes during any stress test.

## Visual criteria

Streaming transitions must not pop visibly at gameplay speed.

## Verification

- `npm run verify:performance` and `npm run verify:live-soak` pass.
- `scripts/profile-frame.mjs` numbers recorded per milestone.
