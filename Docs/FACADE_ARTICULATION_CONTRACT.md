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
  | `d = 0.012` | 12 mm | glass |
  | `d = 0.042 – 0.062` | +30–50 mm | frame face |
  | `d = 0.142 – 0.262` | +100–200 mm | the clad wall face |
  | up to `d = 0.45` | + projection | sills, cornices, fascias |

  The window **reveal** is the recess from the clad wall face down to the frame
  face: 0.10–0.20 m. The brief's band is 0.10–0.25 m; the upper bound is 0.20 m
  here because the whole build-up must fit inside the 0.45 m projection
  allowance alongside a projecting cornice.

- **Buildings gain up to 0.26 m of facade depth per face.** That is additive
  presentation geometry inside a declared allowance. It does not move, rescale,
  re-origin or re-index the source shell, and `city.buildings` is never mutated.

- **Party walls are built flush.** Each edge is probed 0.50 m outward against
  neighbouring footprints; an edge that hits one is built as a single panel at
  the 12 mm pane plane, because the next building is standing where its cornice
  would go. Nothing else crosses a footprint boundary.

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
| near | 78 m | 22 | 6000 | reveals, frame rings, mullions, sills, lintels, drip recesses, full storefront |
| mid | 175 m | 56 | 2000 | reveals, pane, sill; no joinery |
| far | 380 m | 180 | 640 | clad, one recessed glazing band per storey |
| silhouette | — | 900 | 48 | cornice and plinth only; shell texture kept |

**Per-window geometry stops at 175 m.** Beyond 380 m nothing is clad, so there
is no colour step at the cut.

The base cap is scaled by the greater of the building's wall area (against a
1200 m² reference) and its edge count (against four), up to the ring's
`capScale` — see `articulationTriangleCap`. Scene ceiling is 330,000 triangles
and 48 draw calls, enforced by uniform outside-in ring demotion: shrink every
ring's population to 60%, then far → silhouette, mid → far, near → mid. Every
step moves a whole ring, so a budget cut can never leave one facade detailed
and its neighbour at the same distance bare.

Measured on the real 700-building San Francisco slice from the street capture
pose: **181,236 triangles, 29 draw calls, 0 demotions, 700/700 buildings
articulated, 697 unique facade signatures.**

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
