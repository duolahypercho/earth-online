# Shadow resolution contract

Owner: `src/render/shadow-casters.js`, `src/render/sun-shadow-cascade.js`.
Verified by `scripts/verify/verify-shadow-casters.mjs` and
`scripts/verify/verify-sun-shadow-cascade.mjs` (plain node, no browser).

This records the numeric relationship between the fitted sun shadow camera and
what the frame can actually show, so a later change has to argue with
arithmetic rather than with taste. It is an internal engineering contract; it
makes no claim about any external product.

## The one identity everything follows from

`computeSunShadowCamera` fits a square orthographic box around the bounding
sphere of the view-frustum slice, so

```
texelWorldSize = 2 * radius / (mapSize - 2),   radius ≈ k(fov, aspect) * shadowDistance
```

Density and reach are therefore inversely coupled at a fixed `mapSize`, and
density depends on the **pose**, not on the scene. Nothing in the fit reads
building height, district, or any other world geometry.

## What a texel size buys

Three quantities are functions of `texelWorldSize` alone and are computed, not
asserted, by `casterBracket()` and `contactShadowLeakMetres()`:

| quantity | formula | meaning |
| --- | --- | --- |
| caster floor | `MIN_THICKNESS_TEXELS * w` | thinnest object the PCF kernel can resolve |
| banding floor | `normalBiasTexels * w` | thinnest object the bias does not flip through |
| contact leak | `(n·sin(alt) + d) / sin(alt)` | metres of shadow erased where an object meets the ground |

An object casts a correct shadow only when it clears **both** floors. That is
why the shopfront awning exclusion was never a property of the awning: at
19.2 cm texels the bias is larger than the 0.14 m plate; at 6.5 cm texels the
same plate is a legitimate caster.

## Measured, at the eight capture poses of `.qa-round1`

Shipped fit, `mapSize 2048` over `shadowDistance 220 m`:

| pose fov | texels/m | texel | axial reach | reference objects casting | contact erased |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 47° (6 cards) | 5.207 | 19.21 cm | 394–535 m | 5 of 11 | 0.37–0.44 m |
| 58° (canyon)  | 4.113 | 24.31 cm | 543 m | 3 of 11 | n/a, sun below horizon |

Sign posts, bollards, vehicle wheels and awnings cannot cast at any captured
pose. At 58° neither can a pedestrian torso or a tree trunk.

## Acceptance floors

1. **Torso floor.** `texelWorldSize <= 0.35 / MIN_THICKNESS_TEXELS = 23.3 cm`
   at every captured pose, so a person casts.
2. **Street-furniture floor.** `texelWorldSize <= 0.15 / MIN_THICKNESS_TEXELS
   = 10.0 cm`, so a bollard, a wheel and a sign post base cast.
3. **Reach floor.** at least 180 m of contiguous view depth inside the shadow
   volume, so the cut-off stays within about one degree of the horizon on a
   level street at eye height.
4. **Bracket clearance.** the caster floor must have non-zero clearance to the
   thickest object it rejects and to the thinnest it admits.
5. **Contact is out of scope for the shadow map.** The leak shrinks only
   linearly with the texel; at 6.5 cm it is still 0.13 m. Foot and wheel
   contact must come from geometry (a contact blob or a baked footprint), and
   the shadow map must not be resized in an attempt to deliver it.

`4096` over `150 m` meets 1–4 at every captured pose: 12.1–15.3 texels/m,
6.5–8.3 cm texels, 269–370 m of reach, 8 of 11 reference objects casting. It
costs 4× the shadow-map depth fragments of the shipped fit and remains **one**
shadow pass, one caster traversal and one directional light.

## Why there is no cascade

A cascaded shadow map needs a per-fragment choice of cascade, which lives in
the lighting shader. The canonical path may not take a `ShaderMaterial` or
`onBeforeCompile` dependency (`AGENTS.md`), so that choice is unavailable.

The shader-free substitute — N collinear directional lights sharing the key in
fractions `f_i` — **sums** instead of choosing. A shadow that only cascade `i`
resolves is rendered at `f_i` of its density, so `1 - f_i` of the sun leaks
through it. The best worst case for N cascades is `1 - 1/N`: 50 % leak for two,
67 % for three, against a 5 % budget. `assessCascadeRig()` computes this and
returns `viable: false`; `verify-sun-shadow-cascade.mjs` asserts it.

A single cascade is the only rig on this renderer with no leak. When the
canonical path gains a TSL shadow node that can select a cascade per fragment,
`planSunShadowCascades()` already produces the split, and its continuity
(no gap, no overlap, exactly one authoritative cascade per view depth) is
already verified.

## Caster admission at build time

`applyShadowCasterPolicy` runs once per world build and can only ever take
casting away. Two consequences are load-bearing:

- Anything measured as degenerate at build time is dark for the life of the
  world. `measureShadowCaster` therefore measures an `InstancedMesh` or
  `BatchedMesh` from its **source geometry**, never from its instance union,
  because a batch that is written per frame has `count === 0` while the world
  is being built.
- The policy's only input is `texelWorldSize`. It must be handed the value from
  a real fit for the current camera, not a fallback constant, or the floor it
  applies belongs to a different field of view than the one being drawn.

## Antialiasing

`PORTABLE_SAMPLE_COUNTS` is `{1, 4}`. WebGPU guarantees no other sample count,
so any plan above 4× MSAA diverges between the WebGPU path and the WebGL2
fallback and is not admissible. Shadow-edge stair-stepping is a shadow-map
resolution artifact and is not addressed by MSAA at any sample count; it is
addressed by the texel floors above.
