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

| ring | radius | max buildings | base cap | what it builds |
| --- | --- | --- | --- | --- |
| near | 85 m | 26 | 6000 | reveals, frame rings, mullions, sills, lintels, drip recesses, full storefront |
| mid | 200 m | 72 | 2300 | reveals, pane, sill; no joinery |
| far | 420 m | 300 | 820 | clad, one recessed glazing band per storey, continuous bay piers |
| silhouette | — | 900 | 48 | cornice and plinth only; shell texture kept |

**Per-window geometry stops at 200 m.** Beyond 420 m nothing is clad, so there
is no colour step at the cut.

The radii are set from the poses the quality gate actually captures, not from a
guess. Those poses are embedded in the verifier, which asserts that at least
97% of the frame-filling facade area is clad and at least 75% carries
individual openings or bay rhythm. Measured: 100/99, 100/94, 99/79 (the 58 deg
canyon card), 100/99, 100/99.

The base cap is scaled by the greater of the building's wall area (against a
1200 m² reference) and its edge count (against four), up to the ring's
`capScale` — see `articulationTriangleCap`. Scene ceiling is 330,000 triangles
and 48 draw calls, enforced by uniform outside-in ring demotion: shrink every
ring's population to 60%, then far → silhouette, mid → far, near → mid. Every
step moves a whole ring, so a budget cut can never leave one facade detailed
and its neighbour at the same distance bare.

Measured on the real 700-building San Francisco slice from the street capture
pose: **244,504 triangles, 20 draw calls, 0 demotions, 700/700 buildings
articulated, 695 unique facade signatures.** Draw calls fell from 29 despite
the extra geometry because glass, joinery and interior fittings share one
material each instead of one per wall class.

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
