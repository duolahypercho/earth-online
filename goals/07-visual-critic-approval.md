# Goal 07 - Harsh visual critic approval

- Owner: Visual-quality critic agent
- Status: not started

## Objective

Compare the expanded map blind against real San Francisco references, the
previous build, and the external stylized-life-sim reference bar. Reject and reopen
any district that reads generic, inaccurate, repetitive, or unfinished.

## Requirements

- Screenshot every new district and compare side by side with references.
- Criticize realism, composition, scale, road accuracy, building variety,
  terrain, landmarks, lighting, density, transitions, and repetition.
- Every rejection must name the district, issue, and expected fix.

## Dependencies

Goals 03-06.

## Performance budget

None beyond the runtime it inspects.

## Visual criteria

No placeholder-looking blocks, seams, broken roads, or generic procedural
artifacts survive review.

## Verification

Critique doc includes per-district verdicts. Zero open critical or major
findings before the expansion is accepted.
