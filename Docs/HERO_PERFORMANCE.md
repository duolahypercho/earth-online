# Ferry Building hero performance

`src/realmap/hero-performance.js` is deliberately not wired into `main.js`.
It gives the hero launcher an opt-in, reversible performance profile while
shared city work continues.

## Intended integration

After the Ferry Building scene is visually correct, create the controller once
after renderer/sun construction:

```js
const heroPerformance = enableHeroPerformanceMode({ renderer, sun });
```

Call `heroPerformance.tick(performance.now())` once per render loop. Call
`tick(now, { forceShadows: true })` after a teleport, weather/time-of-day
change, or major building update. Call `dispose()` when leaving hero mode.

The profile preserves shadows, but refreshes their map at a short cadence,
caps DPR at 1.35, and leaves post-processing enabled. Reflection passes can
use `createCadencedUpdater()` at the profile's reflection cadence. LOD/culling
only changes objects explicitly marked with `userData.heroPerformance`, so no
OSM-derived landmark is hidden accidentally.

## Probe

With Vite running, execute:

```sh
node scripts/qa-hero-performance.mjs
```

It opens the real Ferry Building URL at 1280×720 DPR 2, counts real WebGL draw
submissions and triangles across 180 frames after a 1.8-second no-input
warmup, reports local OSM entity counts, and writes a screenshot to
`/tmp/ferry-hero-performance.png`. The performance gate uses raw consecutive
`requestAnimationFrame` deltas while the hero pose, lighting, and input remain
unchanged: p99 must be at most 33 ms and no sampled frame may reach 100 ms.
The app's lifetime telemetry is retained as diagnostic context, rather than
treated as this gate, because it legitimately includes boot and capture work.
It is a workload smoke test, not a visual-quality certificate: inspect the
saved frame before accepting AAA-grade presentation or city correctness.
