# Visual quality gate: round log

Scores are the weighted total from `scripts/qa/score-quality-cards-v1.mjs`,
awarded by independent reviewers against `Docs/VISUAL_QUALITY_GATE.md`.
Approval is >= 82 with no failed gate. **Every round so far is REJECT.**

| Round | Capture | Reviewer | Score | Cards | Note |
|---|---|---|---:|---|---|
| r1 | `.qa-round1` | critic-a | 24.8 | 8 | first scored round |
| r1 | `.qa-round1` | critic-b | 29.6 | 8 | measured scale from the manifest |
| r2 | `.qa-round2` | critic-c | 27.2 | 5 | 2 cards refused by the harness |
| r3 | `.qa-round3` | critic-d | 30.8 | 5 | found the baked sun-independent decal |
| r5 | `.qa-round5` | critic-e | 36.0 | 4 | first round with the night-key fix |

## What each round changed

- **r1** Facade cladding replaced painted windows; street construction and
  furniture derived from the street contract; crowd put on the pavement with
  closed joints; sky, exposure and key/fill rebuilt on measured illuminance.
- **r2** Glass made dielectric with interiors; vehicles given a real catalogue;
  instanced casters admitted to the shadow map; capture harness stopped
  producing false evidence.
- **r3** Streetscape built around the city rather than the startup camera;
  footways paved; trees given real canopies; curb raised to 0.150 m.
- **r4** Vehicle glazing moved outside the bodywork; vehicle materials graded;
  the delivered lit/shadow ratio measured properly for the first time.
- **r5** The below-horizon sun switched off; light pools laid on the paved
  cross-section; sun-following contact shadows for objects the shadow map
  refuses; the walk cycle stopped folding figures forward.

## Findings that cost more than one round

Recorded because each was believed, acted on, and wrong.

1. **"There are no sun shadows."** Held for three rounds by three reviewers and
   the integrator. There were shadows. A single Otsu separation over one region
   cannot distinguish a flat surface from a region lying entirely inside one
   lighting zone.
2. **"Key-on over key-off is the lit/shadow ratio."** It is `1 + key/fill` -
   how much of a pixel's light is sun. Use `measure-frame-v1.mjs --ratio`,
   which classifies pixels by whether the key reaches them.
3. **"The dark band is a cast shadow."** It sat at the same pixel in an 11:00
   card and a 21:30 card. Inverting the display transform showed key and fill
   scaled by exactly 0.50 - an alpha-0.5 black quad.
4. **"The run-level shadow block describes this card."** It is read once at
   boot. It reported a 23.2 degree sun for a card whose sun is at 43.3.
5. **"The pass built what the report says."** A pass's triangle count is a
   build-time snapshot. Two passes had their LOD rings centred ~1450 m from
   every capture pose and emitted almost nothing where the camera stood.
6. **Key-off twins are not time-locked.** Anything that moves between the two
   exposures shows a double silhouette in the delta, so the instrument is only
   valid for static geometry until the simulation is frozen across the pair.

## Instruments

- `scripts/qa/capture-quality-cards-v1.mjs` - the eight scene cards. Refuses to
  write a frame for a failed pose, refuses to capture a procedural fallback,
  records per-card shadow and light state, and can shoot a key-off twin
  (`SF_QA_KEYOFF=1`).
- `scripts/qa/measure-frame-v1.mjs` - luma statistics, `--diff` for what the key
  contributed and where, `--ratio` for the delivered lit-to-shadow ratio.
- `?qaPasses=off` / `?qaPasses=-street-furniture` - bisect the presentation
  layers without rebuilding.
- `SF_QA_WINDOW=x,z,radius` - build a smaller world for fast diagnosis.
