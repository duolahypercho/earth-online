# San Francisco Performance Baseline

Captured 2026-08-02 on `main` against the live Vite preview at
`http://localhost:5173/`. Build: Three.js 0.180.0, Vite 6.1.0, Node v22.23.1.
No game source was edited and no commit was created; this document is the only
new repo file.

## Methodology And Hardware

Host hardware:

- macOS 15.7.3, Apple M4 with 10-core integrated GPU, Metal 3
- 16 GB RAM, 2560x1440 main display at 60 Hz
- Google Chrome 150.0.7871.187, launched by Playwright in headless mode
- Renderer: WebGL2 through ANGLE `metal` at a 1280x720 headless viewport

Measurements came from the game's own telemetry, not a separate profiler:

- `window.__SF_SIM__.getPerformanceSnapshot()`: frame cadence, application frame
  work, p99, 1% low (defined as 1000 / p99 ms), draw calls, triangles, renderer
  geometry/texture counts, Chrome JS heap, render quality, streaming stats
- `getFrameProfile()` and `streaming.getFrameProfile()`: per-stage timing with
  `?sf-profile=1`
- `traffic.getDiagnostics()`: intersection queue and turning load
- `streaming.stats`: sector focus, population readiness, handoffs, coarse
  population

Gates run:

- `node scripts/profile-frame.mjs` (clean JSON capture; two identical runs)
- `SF_QA_URL=http://localhost:5173/ npm run --silent verify:performance`
- `SF_QA_URL=http://localhost:5173/ npm run --silent verify:live-soak`

The gate JSON was kept outside the repo in `/tmp/sf-perf-baseline/`. A separate
read-only Playwright probe using the same browser, viewport, and ANGLE settings
measured settle wall-clock time, a smooth QA corridor tour, a dense Financial
District signal, and the building-entry transition because the shipped gates do
not emit those numbers.

## Gate Status

| Gate | Result |
| --- | --- |
| `profile:frame` | PASS, no page or console errors |
| `verify:performance` | PASS: application budget met at every stop |
| `verify:live-soak` | PASS: no failures, warnings, or runtime errors |

## Loading To Playable

Measured from right after browser launch through boot overlay dismissal:

- `verify:performance`: 1,200 ms to launch-ready, 143 ms launch-to-playable,
  1,343 ms total
- Detail probe: 1,382 ms to launch-ready, 97 ms launch-to-playable, 1,479 ms
  total

## Per-District Stop Table

Per-stop application telemetry below comes from `verify:performance`, which
resets the telemetry window before each stop, so each row is isolated. Settle
time is wall clock from `setRoamPose` until the focus sector matches,
`populationPendingDetailed === 0`, and authored enterable buildings are present
(core exempt from the enterable check).

| Stop | App p99 ms | App max ms | App 1% low FPS | Presented p99 ms | Presented 1% low FPS | Draw calls | Triangles | GPU geom/tex | JS MB | Settle s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| core / waterfront | 8.1 | 8.1 | 123.5 | 17.7 | 56.5 | 605 | 426,202 | 288/281 | 278 | 0.0 |
| Civic Center / SoMa | 6.2 | 12.9 | 161.3 | 17.7 | 56.5 | 86 | 645,188 | 303/281 | 270 | 3.9 |
| Financial District | 4.4 | 12.3 | 227.3 | 17.6 | 56.8 | 68 | 740,024 | 306/283 | 234 | 6.6 |
| North Beach / Telegraph Hill | 5.7 | 14.7 | 175.4 | 17.8 | 56.2 | 62 | 432,532 | 313/284 | 223 | 6.7 |
| Pacific Heights | 5.6 | 13.1 | 178.6 | 17.7 | 56.5 | 106 | 438,452 | 325/285 | 214 | 6.6 |
| Presidio Heights / Presidio | 4.6 | 13.7 | 217.4 | 17.7 | 56.5 | 73 | 439,760 | 325/286 | 218 | 6.5 |
| Mission District | 6.2 | 13.2 | 161.3 | 17.7 | 56.5 | 89 | 749,980 | 365/338 | 223 | 6.9 |
| Mission Bay | 5.2 | 13.3 | 192.3 | 17.7 | 56.5 | 83 | 427,366 | 367/339 | 208 | 6.8 |
| Outer Sunset | 6.6 | 14.0 | 151.5 | 17.6 | 56.8 | 268 | 440,782 | 396/343 | 230 | 6.7 |

The core stop renders one protected detail sector with no enterable buildings;
every expansion stop settles with 4 detail sectors, 23 proxy sectors, and
102-143 enterable buildings. The core is also the draw-call outlier (605), with
Outer Sunset next at 268.

## Streaming And Settle Time

The core was already settled on boot. The first expansion teleport
(Civic Center / SoMa) took about 3.9 s; every later distant teleport settled in
6.5-6.9 s. All stops drained the bounded population queue within the gate's
30 s readiness timeout.

One-time settlement stage maxima from `profile:frame` (isolated per stop):

| Stop | Population queue max ms | Streaming stage max ms | Reconcile max ms |
| --- | --- | --- | --- |
| Civic Center / SoMa | 12.5 | 12.6 | 0.4 |
| Financial District | 13.5 | 13.5 | 0.3 |
| North Beach | 12.5 | 12.7 | 0.2 |
| Pacific Heights | 13.6 | 13.7 | 0.2 |
| Presidio | 13.9 | 14.0 | 0.3 |
| Mission District | 12.0 | 12.0 | 0.2 |
| Mission Bay | 12.8 | 13.0 | 0.4 |
| Outer Sunset | 11.8 | 12.1 | 0.3 |

Settlement is dominated by the population queue and stays one-frame only;
steady-state application p99 after settle is 4.4-8.1 ms.

## Worst Traversal Spike

- Official per-stop teleports (`verify:performance`): worst isolated
  application frame 14.7 ms at North Beach; every stop stayed under the
  16.67 ms application frame budget.
- `profile:frame` cumulative telemetry windows (telemetry was not reset between
  its stops) recorded one-frame application hitches of 16.0 ms at
  Civic Center / SoMa and 17.0 ms at Presidio during first settlement. These
  are edge-of-budget one-frame events; the isolated gate run measured those
  stops at 12.9 ms and 13.7 ms.
- The same cumulative run recorded a 250 ms presented-cadence hitch during
  core boot before the first expansion stop. The isolated gate run's presented
  max was 17.8 ms after boot.
- A fast QA corridor tour (4 sector handoffs in 1.6 s) kept streaming stages
  under 4 ms, but produced a one-frame camera-stage hitch of about 144-160 ms
  at tour completion when the QA public corridor is torn down. This is a
  QA-harness corridor toggle, not normal gameplay streaming.

## Dense Intersection Cost

Financial District probe parked at `x=1600, z=0` for 5 s with the nearby signal
red:

- Application p99 5.2 ms, application max 14.0 ms
- 7 vehicles queued at sample time, cumulative max queued 13, 7 turning,
  30 moving, 39 active traffic
- 44 draw calls, 317,740 triangles, 221 MB JS heap

Across the per-stop probe, cumulative `traffic.maxQueued` reached 13 at several
stops and turning peaked at 12 in the Mission District. No dense-signal sample
approached the application budget.

## Building Entry Cost

Entry probe used the first authored Civic Center / SoMa volume
(`1:0:authored-building:0`, "Muni Transfer", transit variant 06):

- Entry transition application p99 / max: 66.6 ms / 66.6 ms
- Presented p99 / max: 66.7 ms / 66.7 ms
- Render stage max: 65.8 ms
- Interior state confirmed active with 2 collision boxes after the transition

The entry transition is a deliberate interior scene transition, so it is
outside the steady-state 16.67 ms gate, but 66.6 ms is the number to compare
future entry work against.

## Budget Misses And Measurement Limits

- Application budget: no misses. `hardBudgetMet` and
  `applicationHardBudgetMet` were true at all 9 stops.
- Presented cadence diagnostic: missed at all stops because headless Chrome
  presented at p99 17.6-17.8 ms (56-57 FPS). The gate explicitly treats this as
  a browser/display diagnostic, not an application budget failure.
- One-frame settle edge: profile-frame observed a 17.0 ms application frame at
  Presidio in its cumulative-window run. This is worth watching but did not
  fail the isolated gate.
- Building entry: 66.6 ms one-frame transition.
- QA corridor tour completion: 145-160 ms one-frame camera hitch.
- Not measured: true GPU VRAM bytes. `renderer.info.memory` exposes only
  geometry/texture counts and is flagged `rendererInfoOnly` in the snapshot.
- Not measured: display-level frame pacing beyond Chrome headless cadence.
  TARGET HARDWARE profiling is still required for final GPU/display
  certification.
- Not measured: SwiftShader software run. The default macOS `metal` backend was
  used by all gates as the scripts intend.

## Numbers To Compare Against

Use these as the milestone baseline:

- Loading to playable: 1,343-1,479 ms from browser launch
- Application p99: 4.4-8.1 ms across all stops
- Worst isolated application frame: 14.7 ms (North Beach)
- Presented p99: 17.6-17.8 ms; presented 1% low 56.2-56.8 FPS on headless
  60 Hz Chrome
- Draw calls: 62-605
- Triangles: 426,202-749,980
- JS heap: 208-278 MB used
- GPU resources: 288-397 geometries, 281-343 textures
- Settle: 3 ms core, 3.9 s first expansion, 6.5-6.9 s later distant stops
- Dense-signal application p99: 5.2 ms, max 14.0 ms
- Building entry transition: 66.6 ms

## Summary

Gate status: `profile:frame` PASS, `verify:performance` PASS,
`verify:live-soak` PASS. Worst application frame was 14.7 ms at North Beach
(one edge case of 17.0 ms appeared in the profile-frame cumulative window),
worst presented 1% low was 56.2 FPS (headless cadence diagnostic), draw calls
ranged 62-605, and JS memory ranged 208-278 MB. The application-owned frame
budget is currently met with no real gate miss.
