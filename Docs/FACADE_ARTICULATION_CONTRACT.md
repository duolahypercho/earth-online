# Facade articulation contract

Owner: Terrain/buildings (`src/world/buildings/facade-depth.js`) and Rendering
(`src/render/passes/facade-articulation.js`).

This records the two contracts the articulation pass depends on and that other
subsystems must not break silently. It is not a design document; the reasoning
lives in the module headers.

Verified by `node scripts/verify/verify-facade-articulation.mjs`.

## 1. The pass owns the visible wall

The building shell is a flat extruded prism carrying a tiled canvas texture:
one 128 px tile every 12 m x 4.6 m, with three to six painted window rows per
tile. Those painted "windows" are a metric wallpaper with no relation to the
building's storeys. Real openings laid over them produce two disagreeing grids.

The pass therefore **clads**: it emits a contiguous partition of every visible
wall and stands it proud of the shell, so the painted grid is covered rather
than competed with.

Consequences other subsystems must respect:

- **Everything the pass emits is outside the shell wall.** The shell is opaque
  and is still drawn; anything placed behind it is invisible. The depth stack,
  measured outward from the shell wall at `d = 0`:

  | plane | depth | what it is |
  | --- | --- | --- |
  | `d = 0` | — | the shell wall (structure) |
  | `d = 0.018` | 18 mm | backing plane (crack backstop, not part of the partition) |
  | `d = 0.030` | 30 mm | glass |
  | `d = 0.060 – 0.080` | +30–50 mm | frame face |
  | `d = 0.160 – 0.280` | +100–200 mm | the clad wall face |
  | up to `d = 0.45` | + projection | sills, cornices, fascias |

  The pane sits 30 mm off the shell rather than 12 mm because at a grazing view
  up a 100 m wall a 12 mm separation is inside one pixel's depth span, and the
  shell's painted grid wins those pixels.

  The window **reveal** is the recess from the clad wall face down to the frame
  face: 0.10–0.20 m. The brief's band is 0.10–0.25 m; the upper bound is 0.20 m
  here because the whole build-up must fit inside the 0.45 m projection
  allowance alongside a projecting cornice.

- **Buildings gain up to 0.26 m of facade depth per face.** That is additive
  presentation geometry inside a declared allowance. It does not move, rescale,
  re-origin or re-index the source shell, and `city.buildings` is never mutated.

- **Party walls are left to the shell.** Each edge is probed 0.50 m outward at
  seven points against neighbouring footprints; an edge with five or more
  buried samples is a party wall and the pass builds nothing on it, because the
  next building is standing where its cornice would go and a near-coplanar
  panel laid over the shell loses the depth test at a grazing view. The
  majority rule matters: a single-hit rule blanked whole tower frontages whose
  far corner happened to touch the next footprint (931 edges on the real slice,
  now 812). An edge that only partly abuts a neighbour keeps its cladding, and
  that cladding reaches into the neighbour's own mass where they overlap — the
  verifier measures that excess against the allowance rather than claiming it
  is zero. Real OSM footprints already overlap each other by up to 1.4 m, so
  the baseline for that measurement is the shell wall, not the neighbour.

- **Authored elevations are never clad over.** The pass reads
  `userData.kind === 'buildings-hero-textured'` off the renderer's merged hero
  meshes and takes their `buildingIds` as a preserve list; those frontages get
  the silhouette rung's roofline and base course only. **If the renderer stops
  publishing `buildingIds` on that mesh, hand-authored facades get clad over.**

- **The pass supersedes the legacy additive relief.** On build it hides every
  mesh with `userData.kind === 'buildings-facade-relief'` and restores them on
  dispose, because that layer emits a cornice and glazing bands on exactly the
  same lines and would z-fight. The permanent fix is at the renderer's call
  site; until then the takeover is reversible and is reported as
  `diagnostics.supersededLegacyMeshes`.

## 2. LOD rings and budget

LOD is by distance from the pass's centre, in four rings. Radii, populations
and per-building triangle caps are in `FACADE_ARTICULATION_RINGS`.

| ring | radius | max buildings | base cap | coverage gain | what it builds |
| --- | --- | --- | --- | --- | --- |
| near | 85 m | 26 | 6000 | x7.5 | reveals, frame rings, mullions, sills, lintels, drip recesses, full storefront |
| mid | 200 m | 72 | 2300 | x6 | reveals, pane, sill; no joinery |
| far | 420 m | 300 | 820 | - | clad, one recessed glazing band per storey, continuous bay piers |
| silhouette | - | 900 | 48 | - | cornice and plinth only; shell texture kept |

**Per-window geometry stops at 200 m.** Beyond 420 m nothing is clad, so there
is no colour step at the cut.

**The radius is measured to the nearest point of the footprint**, not to the
centroid - `nearestFootprintDistance`. The centroid is the wrong question: a
200 m block's centroid is 100 m from the wall you are standing against. On the
round 2 street card an eleven-storey frontage 61 m from the eye, filling most
of the right-hand half of the frame, had its centroid at 87 m and was therefore
built at the mid ring's rung.

The base cap is scaled by the greater of the building's wall area (against a
1200 m2 reference) and its edge count (against four), up to the ring's
`capScale` - see `articulationTriangleCap`. Scene ceiling is 330,000 triangles
and 48 draw calls.

### 2a. Screen coverage sizes the budget

Distance alone cannot answer *does this elevation need windows*. A 160 m tower
carries 23,000 m2 of wall - twenty times the reference - so the wall-area term
clamps at `capScale` and the cap lands on 14,400 triangles whether that tower
is four metres from the eye or three hundred. Fourteen thousand triangles over
fifty storeys buys four glazed storeys and forty-six flat glazing bands, and
that is the uniform grid the round 2 review rejected.

`articulationScreenCoverage(building, focus)` returns the share of a reference
frame the elevation would fill if the camera turned to face it. The reference
frame is fixed - `FACADE_ARTICULATION_SCREEN`, 47 deg vertical, 16:9, eye at
2.4 m, the gate's own street card - and deliberately independent of the live
view direction and field of view, because the player turns on the spot sixty
times a second and a rebuild costs a few hundred milliseconds.

Coverage drives three things:

- the per-building triangle cap, through the ring's `coverageGain`;
- whether every storey is glazed individually or banded, through the ring's
  `glazeCoverage` threshold. `ART_DETAIL_LADDER`'s `openStoreys` is now a
  **floor**, not a ceiling: the ladder removes joinery with distance, it does
  not remove windows. A rung that swaps a window for a band moves the
  elevation's lines, and the pass's own rule is that approaching a building
  deepens the same lines rather than moving them;
- which edges carry joinery: the faces that turn toward the focus. A face
  turned away is still fully clad and still banded - the verifier samples one
  and requires 99.9% coverage - it only loses joinery, and the triangles that
  were being spent on the back of a block now pay for the front of it. The
  shopfront is exempt and follows the longest frontages instead, because it is
  the part the player walks around the corner of.

### 2b. Degrade order

The coverage bonus is given up **before** any ring is demoted
(`COVERAGE_CUT_STEPS` = 0.5, 0.2, 0). Cutting the bonus takes triangles off the
two or three buildings holding the most of them and leaves the rest of the city
where it was; demoting a ring changes what every building in it is made of.
Once the bonus is gone the old uniform outside-in ring demotion takes over -
shrink every ring's population to 60%, then far to silhouette, mid to far,
near to mid. Every step still moves a whole ring, so a budget cut can never
leave one facade detailed and its neighbour at the same distance bare.
`diagnostics.budget.coverageCuts` and `.demotions` report both.

### 2c. Measured

On the real 700-building San Francisco slice from the street capture pose:
**317,378 triangles, 20 draw calls, 0 coverage cuts, 0 demotions, 700/700
buildings articulated, 695 unique facade signatures.** Draw calls stayed at 20
because glass, joinery and interior fittings share one material each instead of
one per wall class.

The verifier holds every eye the quality gate has captured from - nine poses
from the round 1 and round 2 capture manifests - to two measurements:

- at least 97% of the frame-filling facade area is clad, and at least 75% of it
  is in a ring that carries openings or bay rhythm (section 18);
- at least 85% of the **elevation area the frame is actually made of** carries
  individual openings rather than one flat glazing band per storey (section
  21). This is weighted by projected screen area, taken only over faces that
  turn toward the eye, and each pose is reported against a control with the
  screen-coverage term switched off.

Measured, worst pose first: 88% (control 41%), 89% (30%), 92% (21%), 93% (64%),
94% (94%), 96% (36%), 98% (61%), 98% (54%), 98% (61%). A sweep of 48 eyes along
the real street network stays inside the budget with no ring demoted.

The pass reports `diagnostics.glazedStoreys`, `.bandedStoreys`,
`.glazedStoreyShare` and `.maxCoverage`, because a clad ring whose storeys are
all bands is indistinguishable from a clad ring whose storeys are all windows
in every other diagnostic the pass publishes.

## 3. The LOD centre must follow the camera

`ctx.focus` is the renderer's *build* focus: sampled once, when the city is
built. The player then walks away from it — on the current capture set the
street pose stands roughly 600 m from it. A ring centred there is centred on
nobody.

The pass takes the build focus as its starting centre and re-centres on the
live camera in `update()` once it has moved past a threshold: 25 m for the
near/mid `detail` zone, 90 m for the `far`/silhouette `bulk` zone. One zone per
threshold crossing. In the steady state `update()` is two distance checks and a
return, with no allocation. Rebuild cost is reported as
`diagnostics.lastRefreshMs` (150–500 ms on the real slice).

**A caller that pins the camera without stepping the pass runtime will capture
the build-focus rings**, not the camera's.


## 4. Glass is a dielectric, and the lit bucket follows the clock

Glass panes are `metalness 0`, `roughness 0.07`, colour white, with the pane's
own colour carried in vertex colour. That is not a style preference:

- A metallic material has no diffuse term and tints its specular by the base
  colour, so a dark "glass" colour at `metalness 0.3` renders black. Round 1
  shipped exactly that and every window was a black hole.
- At `metalness 0` the environment reflection is Fresnel-weighted: ~4% at
  normal incidence rising toward 100% at grazing. That is the view-angle
  response, and it comes from the BRDF rather than from a shader.

Behind the reflection, each opening draws a deterministic interior: a vertical
sky-to-room ramp baked into the pane's vertex colour, plus real opaque geometry
in the glazing cavity — a blind across the top, a curtain down one side, or
neither. Shopfront glazing is a separate treatment: a bright ceiling-to-back
ramp, a counter or shelf at waist height, and a lit valance. **No transparency
is introduced into the canonical path**; the interior is a ramp plus geometry.

Panes are bucketed into `glass` and `glass-lit`. The pass drives
`glass-lit.emissiveIntensity` from `ctx.hour` / `ctx.day`, quantised to 1/20 so
a frame that does not cross a step writes nothing. **This is what puts lit
windows back on the night card**: the shell's own emissive night texture is
behind the cladding and can no longer be seen, so without the lit bucket a clad
building goes completely dark after sunset.

## 5. An elevation varies against itself

Storeys are assigned registers — `ground`, `mezzanine`, `typical`, `mechanical`,
`crown` — which change proportion and rhythm, not just decoration. The crown is
pinned to the topmost storey that can still carry glazing (a 118 m tower's cap
is 6.4 m deep and would otherwise swallow it) and is reserved out of the
opening budget rather than competing with it. A plant floor appears above ten
storeys as a recessed louvre band. Weathering scales with height so the same
detail is dirtier lower down. One bay in six storeys is blanked.

Cap members scale with the building: cap depth is 2.1 m at 14 m, 3.9 m at 49 m,
6.4 m at 118 m. A fixed 0.6 m cornice is two pixels on a tower at 200 m, which
is why round 1 showed tall buildings terminating flat against the sky.

## 6. What the round 2 capture measured, and what it does not settle

Both articulation findings in the round 2 review are one defect. Measured on
`.qa-round2/01-street-day.png` with `scripts/qa/measure-frame-v1.mjs`, on the
right-hand frontage the reviewer called a uniform grid:

| region | mean luma | Otsu separation |
| --- | --- | --- |
| the nine banded storeys (x 1030-1560, y 30-270) | 58.4 | 11.0 |
| one spandrel on its own (x 1140-1400, y 95-125) | 57.9 | 9.1 |
| the two storeys that do carry individual openings (y 300-395) | 54.7 | 17.8 |
| the storefront band (y 400-470) | 70.4 | 33.9 |

One surface, one distance, one light angle: separation tracks whether the
storey carries openings. The banded shaft measures flatter than that capture's
unshadowed footway; the two glazed rows on the same wall measure 62% higher.

On `.qa-round2/03-canyon-golden.png` the near facade at x 980-1450, y 60-500
measures 13.4 separation with 44% near-black, and x 1000-1200, y 100-300
measures 9.6 - one population. The brick plinth directly under it, at x
1150-1500, y 700-780, resolves individual brick courses sharply in the same
frame, so that facade is missing horizontal geometry, not texture resolution:
what is left at a 4.5 m grazing view of a banded shaft is vertical bay piers
and glazing stripes and nothing to break them.

**What the fix above does not show.** Every number in section 2c is geometric
and comes from `node scripts/verify/verify-facade-articulation.mjs`. It proves
what is built and what it costs. It cannot prove the wall now reads, and it is
not a claim that it does. The observable pass condition for the next capture is
the frame measurement, on the same regions: the banded-shaft separation should
move toward the 17.8 the glazed rows already measure, and the near facade in the
canyon card should stop being one population. Neither is settled until a
capture is measured.
