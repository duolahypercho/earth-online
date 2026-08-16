# Ferry Building hero visual audit — round 2

**Audit date:** 2026-08-10

**Audited build:** `d75fb68` (`Texture and align Ferry Building facade`)

**Launch:** `realmap.html?place=ferry-building&mode=walk`

**Gate:** [`Docs/GTA_VISUAL_QUALITY_GATE.md`](GTA_VISUAL_QUALITY_GATE.md)

**Independent verdict:** **REJECT — 29.6/100**

This is a pixel-level visual judgment. Passing module checks, stable camera
diagnostics, source alignment, entity counts, and frame rate do not count as
visual parity evidence.

## Capture manifest

Fresh captures were made from a local Vite server at 1280×720 CSS pixels with
DPR 2, producing 2560×1440 PNGs. Playwright Chromium used the Metal ANGLE path.
HUDless captures used the same default walk camera and launch pose; only weather
or time of day changed.

| Evidence | Local path | SHA-256 |
|---|---|---|
| Default gameplay frame | `.qa-ferry-final-audit-latest-gameplay.png` | `7028c4503462c456f530a21909156037702aa37403fa066d0a56df2f533c2d53` |
| Clear day, HUDless | `.qa-ferry-final-audit-latest-day-clean.png` | `6f90f8a852315fd86972cd8c77cc66e0f41d813345efbcabd59d28df51346a35` |
| Clear night, HUDless | `.qa-ferry-final-audit-latest-night-clean.png` | `29f28e0bfa70437c82234ae0fc9640ff136b3a96ce084a504518c3feffdaa176` |
| Drizzle day, HUDless | `.qa-ferry-final-audit-latest-drizzle-clean.png` | `855989f377c6662be5a0c225d750ed5a2aa739be0d4cb0032c0e685363aa42e2` |

The private unbranded comparison sheet is
`.qa-ferry-final-private-blind-ab.html`; its capture is
`.qa-ferry-final-private-blind-ab-latest.png` (SHA-256
`f9fb5c3c352e6e9c904dd43f15445a0d648114829bc7c3f3fca60dca882f5da4`).
It uses only ignored local reference files and the fresh Earth frames. Neither
the sheet nor any reference image is committed.

## Rubric score

Scores are integer 0–5 ratings multiplied by the committed gate weights.

| Dimension | Rating | Weighted | Finding |
|---|---:|---:|---|
| Street and road realism | 1/5 | 3.6/18 | A nearly featureless plaza slab dominates. The distant road reads as thin bands; curb, drainage, marking, and material hierarchy do not survive the hero composition. |
| Architecture and materials | 2/5 | 7.2/18 | The new sandstone texture and aligned arcade/window rhythm make the landmark recognizable, but identical repeated bays, flat dark openings, simple tower/clock geometry, and minimal roof or construction depth remain prototype-level. |
| Lighting and atmosphere | 1/5 | 2.8/14 | Daylight is flat and weakly grounded. The night frame is almost uniformly dark and has no convincing storefront, street, vehicle, or facade-light hierarchy. |
| Water and weather | 1/5 | 2.0/10 | Water is not legible in the hero view. Drizzle is primarily screen-space streaks; no convincing wet roughness, reflections, puddling, runoff, or shoreline contact is visible. |
| Character grounding | 2/5 | 4.0/10 | The character is planted and the camera is stable, but the model is visibly primitive, has weak contact/shadow response, and no walk/stop/curb evidence was captured. |
| NPC and traffic life | 1/5 | 2.0/10 | Diagnostics report 50 pedestrians and 36 vehicles, yet the frame reads empty. Visible vehicles and people are tiny primitive silhouettes with no readable behavior. |
| Composition and place identity | 2/5 | 3.2/8 | The centered clock tower provides a Ferry Building cue, but the vast empty foreground and blank facade erase human scale and recognizable Embarcadero character. |
| Technical integrity | 2/5 | 4.8/12 | The launch is stable with no page errors or camera/building collision, but the fresh night frame contains a giant clipped foreground NPC/name bubble and the required movement/tile-boundary integrity evidence is missing. |
| **Total** |  | **29.6/100** | **Reject; 52.4 points below the approval threshold.** |

Every dimension misses its gate. Architecture, lighting, road realism, weather,
and life are visibly placeholder/prototype quality rather than current AAA
production quality.

## Private A/B result

The unbranded sheet contains four randomized pairs: landmark composition,
character/environment, urban depth/activity, and night lighting/street life.
The comparison frame was decisively stronger in **4/4** pairs. This is a useful
one-reviewer direction check, not the five-reviewer locked protocol required for
approval. The large quality gap was recognizable without labels in every pair.

## Automatic rejection conditions present

- Placeholder building masses and primitive traffic dominate or define the hero
  view.
- The fresh night frame has a giant clipped foreground NPC/name bubble, a
  critical hero-composition obstruction.
- The night scene lacks shaped local lighting and material response.
- The required eight-card set is incomplete: only one standing composition was
  recaptured under three conditions.
- No standing/walking/stopping curb sequence and no 30-second tile-boundary
  traversal clip were supplied.
- No five-reviewer randomized, locked scoring round exists.
- No second consecutive passing independent round exists.

These conditions make approval impossible regardless of aggregate score.

## Performance context, not visual evidence

The final audited build sampled 83 FPS / 12.05 ms with zero page errors, 497.7
average draw calls/frame, and 118,765 average triangles/frame. This clears the
nominal 60 FPS target on this machine, but performance does not change the
visual verdict.

## Highest-impact next fixes

1. **Advance the landmark from repeated kit to authored facade.** Keep the new
   aligned bays, then add real opening depth, distinct arcades/storefronts,
   cornices, roof volumes, clock/tower detail, glazing, weathering, and
   self-shadowing so it no longer reads as one repeated module.
2. **Author the plaza-to-Embarcadero ground slice.** Replace the empty tan plane
   with correctly scaled paving, curb and lane hierarchy, drainage, crossings,
   street furniture, planting beds, material variation, wet-response breakup,
   and a composition that exposes those features at human height.
3. **Deliver a lit human-scale life pass.** Replace the hero, nearby NPC, and
   vehicle primitives with production assets; stage readable crossings and
   curb behavior; add contact shadows plus storefront, street, vehicle, and
   facade practicals that make both day and night frames spatially legible.

After those changes, recapture all eight mandatory cards and the traversal clip
before requesting another AAA-level audit.
