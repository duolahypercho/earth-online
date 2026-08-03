# Goal 01 - Baseline audit

- Owner: Orchestrator
- Status: complete

## Objective

Prove the existing map, architecture, and verification gates are green before
expanding, and record the baseline the critic will compare against.

## Requirements

- `npm run verify:expansion` passes for all 8 authored districts.
- `npm run verify:city` passes.
- `npm run build` passes.
- Performance traversal smoke runs against the live preview and records the
  current hard/application budget result.
- Visual and performance baselines are captured as docs and screenshots.

Result (2026-08-02): expansion, city, build, and performance gates all green.
Baseline captured in `Docs/PERFORMANCE_BASELINE.md`; worst application frame
14.7 ms, app p99 4.4-8.1 ms, all 9 stops under the 16.67 ms application budget.

## Dependencies

None. Everything else depends on this goal.

## Performance budget

Application-owned frame work <= 16.67 ms on the QA machine. Any existing miss
must be recorded, not hidden.

## Visual criteria

Baseline screenshots of every authored district are available for later blind
comparison.

## Verification

- `npm run verify:expansion`
- `npm run verify:city`
- `npm run build`
- `npm run verify:performance` (live preview)
- District screenshots via `npm run qa:district-visual`
