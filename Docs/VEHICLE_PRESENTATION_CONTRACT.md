# Vehicle presentation contract

Owner: Rendering / vehicles — `src/render/passes/vehicle-presentation.js` and
`src/vehicles/` (`vehicle-catalogue.js`, `vehicle-geometry.js`,
`vehicle-fleet.js`).

This records the contracts the vehicle pass depends on and that other
subsystems must not break silently. It is not a design document; the reasoning
lives in the module headers.

Verified by `node scripts/verify/verify-vehicle-presentation.mjs`
(768 assertions) and `node scripts/verify/verify-pass-registry.mjs`.

## 1. The pass owns every vehicle a reviewer can see

Two populations existed before this pass, and both were a flat box with a
smaller box on top:

- **parked** — `buildParkedCars` in `src/citygen/renderer.js` (520 slabs) and
  the kerb-stall layer in `src/render/passes/street-life.js` (72 slabs);
- **moving** — the batch built by `buildVehicleBatch` in `src/citygen/actors.js`
  and driven by `src/citygen/traffic.js`.

The pass replaces both from one catalogue. By default (`hideLegacy: true`) it
hides every mesh whose name matches `/parked-car|kerb-car/i` and the
simulation's own `vehicle-presentation-batch` group, and restores `visible` on
dispose. Because it therefore owns the kerb outright, its stall plan **ignores**
those layers rather than deduping against them; with `hideLegacy: false` the
behaviour inverts — it defers, dedupes against whatever is already parked
within `KERB.dedupeRadius = 3.0 m`, and hides nothing.

`visible` is the only property this pass writes on another subsystem's object.
It never writes a transform, a rig, an identity, a path, a speed or a count.

## 2. Grounding: the carriageway, never bare terrain

A vehicle's origin is the **tyre contact patch**: `y = 0` at the bottom of the
wheels, `+Z` is the nose, `+X` is the vehicle's left (matching the repo's
`atan2(tx, tz)` yaw convention).

The surface under it is the resolved cross-section the paved ribbon was swept
with, taken from `ctx.streetSurfaceOptions` when the renderer supplies it and
otherwise rebuilt from the renderer's own defaults:

| plane | height |
| --- | --- |
| terrain | `heightAt(x, z)` |
| carriageway datum | `+ roadLift` (0.45 m on the real map) |
| crown | `+ crossSlope * half` at the centreline, falling to the gutter lip |
| gutter invert | `- gutterDepth` at `|u| = half` |
| footway | curb top, 45 mm above the datum |

Every vehicle is fitted by a **least-squares plane through its four wheel
contact patches**, sampled on that cross-section, and is pitched and rolled onto
it. Measured residual, whole real-map slice: **worst 2.04 mm, mean 0.22 mm**,
against a stated tolerance of **10 mm** — on flat ground, on a 12% grade, and
across the gutter kink.

**If the renderer stops publishing `ctx.streetSurfaceOptions`, or changes
`roadLift` without publishing it, every vehicle sinks or floats by that
difference.**

## 3. Kerb geometry

| quantity | value | why |
| --- | --- | --- |
| kerb gap (flank to kerb line) | 0.18 – 0.62 m | legal parking is within ~0.3 m |
| running lane left clear | ≥ 3.0 m | one lane has to survive |
| both kerbs parked only when | `half ≥ 4.3 m` | a 6.4 m alley parks one side |
| junction daylighting | 6.5 m each end | no stall in the sight triangle |
| longitudinal gap between vehicles | 0.85 – 2.6 m | packed by real length, not a fixed pitch |
| parking skew | ± 0.025 rad | the line is not machine-perfect |

Stalls are packed by the **actual length of the class drawn for the stall**, and
the candidate set is narrowed to classes the carriageway can carry *before* the
draw, so a wide class never wastes a stall. Every rejection is counted by reason
in the diagnostics.

Overlap is tested as an oriented footprint (separating-axis test), not a radius,
against every other vehicle, against the kerb line (all four corners), and
against the city's building footprints. Measured on the real slice: **0
overlaps, 0 corners over the kerb, 0 in a footprint** out of 440 vehicles.

## 4. The catalogue

Ten classes, all dimensions in metres, all inside a declared plausible range for
their body class (`CLASS_DIMENSION_RANGE`):

| id | class | L | W | H | wheelbase | wheel r |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `compactHatch` | compact hatchback | 4.06 | 1.78 | 1.47 | 2.56 | 0.315 |
| `sedan` | mid-size sedan | 4.85 | 1.84 | 1.45 | 2.82 | 0.340 |
| `wagon` | estate wagon | 4.76 | 1.83 | 1.51 | 2.79 | 0.335 |
| `compactSuv` | small crossover SUV | 4.55 | 1.86 | 1.68 | 2.68 | 0.360 |
| `pickup` | full-size pickup | 5.89 | 2.03 | 1.93 | 3.68 | 0.390 |
| `deliveryVan` | panel delivery van | 5.53 | 2.03 | 2.55 | 3.45 | 0.375 |
| `boxTruck` | box truck | 7.62 | 2.44 | 3.35 | 4.32 | 0.460 |
| `cityBus` | transit city bus | 12.20 | 2.59 | 3.22 | 6.10 | 0.530 |
| `taxi` | licensed taxi sedan | 4.92 | 1.86 | 1.50 | 2.86 | 0.345 |
| `patrolSedan` | patrol sedan | 4.95 | 1.90 | 1.52 | 2.90 | 0.350 |

`width` excludes the mirrors, the way a manufacturer quotes it; `overallWidth`
adds `2 * mirrorReach`; `overallHeight` adds roof furniture (taxi sign, light
bar, transit roof pods). The verifier measures the built bounding box against
all three and holds length and height to **±50 mm**.

Naming is generic by policy (`CLAUDE.md`): no marque, model, operator or
product name appears anywhere in the catalogue, the geometry, the diagnostics or
the verifier.

## 5. Construction

A body is a **loft**: superellipse cross-sections swept along control stations
carrying `{ z, sill, top, half }`. Three things fall out of that:

- **Wheel arches are a real opening.** `sill` is raised locally around each axle
  by an ellipse whose crown is `2 * wheelRadius + 0.055` — one tyre *diameter*
  plus a suspension gap, not one radius — over a half-length of `1.55 *
  wheelRadius`. The wheel therefore stands in an arch instead of half-buried in
  a flank, and the underbody between the axles is a tunnel. The loft stays a
  closed manifold, so it shadows correctly.
- **The windscreen rake is not a special case.** The greenhouse is a second loft
  whose top falls to the belt line at the cowl and at the rear deck;
  interpolating between the cowl and the roof header *is* the rake (25–35° from
  horizontal on the cars).
- **Glazing follows the body, and stands PROUD of it.** The greenhouse section
  is analytic, so panes are projected onto it exactly and follow the
  tumblehome. One-box bodies (transit coach, panel van) carry a window *band*
  in the body side instead (`glazing.bandY`), because that is where their glass
  actually is.

  Round 2 shipped the panes inset 14–16 mm *into* the shell, on the reasoning
  that a window is a recess. The shell is opaque, so the entire catalogue
  rendered with no glass at all. The rules that replaced it:

  1. a pane stands `GLASS_PROUD = 34 mm` outside the shell (18 mm on a flat end
     face, which has no chord error to clear and must stay inside the declared
     length);
  2. proud *corners are not enough* — a flat quad between two proud corners
     still sank 23 mm into a sedan greenhouse, so a pane is a strip of rows
     that follows the surface;
  3. the windscreen and backlight are built from `greenhousePoint`, the exact
     inverse of the section the loft is swept on, and pushed out **radially
     within their own cross-section** (every section is star-shaped about its
     bottom-centre, so radial always leaves the shell — a finite-difference
     normal does not, at a patch edge);
  4. a screen starts only where the greenhouse has at least 140 mm of rise, or
     it degenerates into a pane lying on the boot lid;
  5. the box truck has no backlight: its cab's rear window faces the cargo box.

  Verified by ray-casting every glass triangle from outside: **96–100% of each
  class's glazing is in front of the bodywork** (was 17% before the fix).

Every class also carries: bumper valance and rocker panel, grille with a chrome
surround and a lower intake, mirrors on stalks, wipers, door shut lines, door
handles, belt moulding, exhaust, licence plate and plate recess, plus per-class
features — bed walls and a liner, panel ribs, wheel-arch cladding, roof rails,
an exhaust stack, a chassis skirt, transit doors and roof pods, a destination
sign, a taxi roof sign, a light bar and a push bar.

Wheels, lamps, plates and the ground contact patch are **not** body geometry.
One shared unit wheel (tyre + a rim built for each side), one shared unit lens,
one shared unit plate and one shared quad serve the whole city, scaled into
place by the instance matrix. That is what keeps the draw-call count flat, and
it is also what makes a wheel able to steer and spin and a lamp able to switch.

## 5a. The environment contract (round-2 regression)

**Every vehicle material must declare `userData.envClass`.** `CityRenderer`'s
`applyEnvironmentGrading` walks the city root once, buckets materials by that
field, and hands the prefiltered environment texture *only* to the ones it
found. A material without a class gets no `envMap` at all.

That is fatal here, because the shipped light rig delivers most of its fill
through the environment. Measured on the 11:00 clear card: sun 6.48, hemi 0.27,
ambient 0.06, `environmentIntensity` 0.80. Round 2 shipped without the
declaration and the night card measured **rgb (0,0,0) across a whole vehicle**,
while another vehicle of the same material in the same frame measured (60,58,58)
because a local point light happened to reach it — point lights do not need an
envMap, the environment does.

| material | class | night `envMapIntensity` |
| --- | --- | ---: |
| paint | `painted-metal` | 0.648 |
| glass, all four lamps | `facade-glass` | 1.021 |
| trim, rim | `chrome` | 0.900 |
| tyre | `asphalt` | 0.468 |
| plate | `painted-metal` | 0.648 |
| contact patch | *(deliberately none)* | — |

Rubber has no class of its own; `asphalt` is the closest response in the table
(dark, dry roughness 0.93 — exactly the tyre roughness — and a large wet gain).
The contact patch is an unlit `MeshBasicMaterial`: an envMap would break it.

Two consequences:

- **This pass must never write `roughness`, `color` or `envMapIntensity`.** The
  grader owns all three for a classified material and caches `dryRoughness` on
  first sight, so a second writer permanently poisons the wet grade. Verified
  dry-case no-op: `wetSurfaceGrade` returns `roughnessScale: 1, colorScale: 1`
  in clear weather, so the constructor values survive. What the pass still owns
  is the part no grader can know: **which lamps are lit**, and the opacity of
  the unlit contact patch.
- **The grader caches its buckets from ONE traverse.** The parked fleet exists
  during that traverse, but the mirrored-traffic fleet is built lazily when the
  simulation is first found, and a city with no kerb parking would have no mesh
  carrying these materials at all. `createMaterialAnchor` therefore adds one
  invisible zero-area `Mesh` to the pass group carrying every vehicle material
  in a material array, so all ten are reachable from the root at build time.

## 6. Materials

| material | response | tinted per instance |
| --- | --- | --- |
| `paint` | `MeshPhysicalMaterial`, clearcoat 0.85, roughness 0.34, metalness 0.18 | yes (`instanceColor`) |
| `glass` | roughness 0.055, clearcoat 1.0, opacity 0.86, envMapIntensity 1.9 | no |
| `trim` | roughness 0.38, metalness 0.62 — chrome and dark plastic by vertex colour | no |
| `tyre` | roughness 0.93, metalness 0 | no |
| `rim` | roughness 0.26, metalness 0.88 | yes |
| `plate` | retro-reflective, emissive ramps with night | no |
| `lamp{head,tail,brake,indicator}` | one emissive material each | no (state is the instance matrix) |
| `contact` | unlit soft blob, `depthWrite: false`, polygon-offset | no |

Paint colours are drawn from a weighted distribution that sums to 100 and is
roughly three-quarters achromatic, because a real kerb is white, black, grey and
silver. The verifier asserts the achromatic share stays between 45% and 92%.

## 7. Night and weather

The pass owns **no clock**. `ctx.hour` and `ctx.weather` are read every update
and mapped by `nightnessFor` / `wetnessFor`:

- head and tail lamps are `emissiveIntensity = 0` by day and 3.0 / 1.5 at
  night, ramping through civil twilight (17:30–19:30 and 05:00–07:00). The tail
  figure was 0.55 in round 2, which was not legible against unlit bodywork;
- brake and indicator lamps stay legible in daylight, because a lit brake light
  is; their **per-vehicle** state is the instance matrix collapsed to zero
  scale, so no per-vehicle material is needed;
- the plate gains a retro-reflective emissive at night;
- wet weather smooths the paint, the clear coat, the glass and the rubber and
  raises their environment response.

Parked vehicles are unlit, which is what a parked vehicle is. Mirrored traffic
carries lit head and tail lamps at night, brake lamps when it is slowing or
stopped, and indicators driven by its own yaw rate.

## 8. The traffic mirror

`src/citygen/traffic.js` owns identity, path, speed and collision. The pass
prefers `ctx.traffic` when the renderer supplies it (reading `traffic.cars[i].group`
and hiding `traffic.vehicleBatch.group`), and otherwise falls back to finding
`logical-vehicles-and-batched-presentation` in the scene. It reads the
`position` / `rotation.y` of every child carrying `userData.rig`, and derives
**presentation only** from the motion it observes:

- speed and yaw rate from the frame delta;
- steering angle from a bicycle model, `atan(yawRate * wheelbase / speed)`,
  clamped to ±0.62 rad;
- wheel spin integrated from distance travelled over the wheel radius;
- brake lamps when decelerating or stopped, indicators when |yaw rate| > 0.12;
- a small body roll into the corner.

Class, paint and wheel finish are assigned once per car from a hash of its rig
kind and uuid, so a car does not change colour while it drives.

**If `traffic.js` renames that group, stops parenting car groups under it, or
stops publishing `userData.rig`, the mirror silently falls back to nothing and
the simulation's own placeholder batch stays visible.** That is the safe
failure, and it is reported in `diagnostics.traffic.bound`.

## 9. Budget

Three distance rings from `ctx.focus`, plus a separate traffic allowance:

| ring | radius | lod | max vehicles | max triangles |
| --- | ---: | ---: | ---: | ---: |
| near | 55 m | 0 | 60 | 120 000 |
| mid | 110 m | 1 | 140 | 90 000 |
| far | 320 m | 2 | 360 | 80 000 |
| traffic mirror | — | 0 | 48 | 100 000 |

Total ceiling **400 000 triangles / 96 draw calls**, against the whole pass
layer's 3.2 M / 320. Vehicles get 12% of the layer budget because in a hero
street frame they are the nearest, most-looked-at objects in shot.

Level of detail is chosen by what resolves on a 1600×900 frame at 47°: a 1.8 m
car spans ~60 px at 55 m, ~30 px at 110 m, ~10 px at 320 m. Separate wheels,
door lines, mirrors and wipers stop paying past 55 m; a separate glazing draw
call stops paying past 110 m (the panes are baked into the trim buffer beyond
it); past 320 m a parked vehicle is not worth a triangle.

**Measured** on the stated real slice (SF centre `[1435, 993]`, radius 720 m,
1136 paved segments, 54 km of street): 440 vehicles, **158 072 triangles, 60
draw calls, 190–314 ms** build. The shipped round-2 capture recorded the pass at
180 426 triangles / 60 draw calls / 131 ms on the live runtime.

Glazing rows are level-of-detail aware: three rows near, one at mid, and no
glazing geometry at all past 110 m, where a vehicle is under 30 px wide.

Shadow policy: only the near ring's paint meshes cast, plus mid-ring vans,
trucks, buses and pickups — the bodies with enough bulk for the shadow map to
resolve. Wheels, glass, trim, lamps and plates never cast. The renderer's own
`applyShadowCasterPolicyPass` still gets the final word.

## 10. Diagnostics

`build` returns `{ object, diagnostics }`, where the diagnostics carry the
catalogue and pass versions, the resolved surface options and their source, the
count per class, the planned-vs-placed totals, the rejection histogram by
reason, the unique-appearance count, the per-ring vehicle/triangle records with
their caps, the grounding statistics (samples, worst and mean contact error,
tolerance, pass/fail), the traffic mirror state, the night/wet state, the
per-mesh instance and triangle cost, and the totals against the budget.
