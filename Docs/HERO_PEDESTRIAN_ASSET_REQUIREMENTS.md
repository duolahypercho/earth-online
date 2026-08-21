# Hero pedestrian asset acceptance contract

Status: bundled candidates rejected for civilian hero use; the rejected
binaries have been removed from the tree

## Bundled-asset gate result

Two skinned-character GLBs were formerly bundled under `public/assets/`. Both
were technically usable skinned characters, but neither was an acceptable visual
upgrade for near/midground San Francisco pedestrians. They were rejected as
civilian hero actors, no module ever imported them, and the binaries have since
been deleted. This record is retained so the same class of asset is not
re-adopted; the filenames are deliberately not carried forward.

| Rejected candidate | Technical inventory | Rejection reason |
| --- | --- | --- |
| A — exposed-joint mannequin | Two skinned meshes, 67-joint retargeting-service skeleton, approximately 28,374 vertices, seven clips (`agree`, `headShake`, `idle`, `run`, `sad_pose`, `sneak_pose`, `walk`). Bind-pose bounds are approximately 1.81 m high. | Mesh and material names identified bare joint/surface shells; the contrasting articulated body read as a robot/mannequin, not clothing over a human body. Recoloring cannot create civilian anatomy or clothing silhouette. |
| B — armored tactical figure | Body plus visor, 49-joint skin, approximately 7,434 vertices, four clips (`Idle`, `Run`, `TPose`, `Walk`). | The embedded diffuse texture and normal map depicted distressed armor, rigid plates, visor, tactical undersuit, and military/sci-fi equipment. Muted tinting would still read as an armored combatant. |

Both files contained usable locomotion clips, but animation quality cannot make
the wrong character design appropriate. Shipping either model as a commuter,
barista, tourist, cleaner, or courier would have reduced visual credibility
relative to the existing procedural civilian silhouettes. Do not re-import an
exposed-joint mannequin or an armored/tactical figure as a civilian actor.

A third unreferenced binary — a demo road-vehicle GLB whose filename was a
third-party automotive marque — was removed in the same pass. It was imported by
no module either, and its filename breached the reference policy in
[CLAUDE.md](../CLAUDE.md). Vehicles ship from `src/vehicles/`; do not reintroduce
a third-party-branded vehicle model.

## Required replacement license

Each source character pack must include a checked-in provenance record with:

- Author/vendor, canonical product or source URL, acquisition date, asset
  version, and SHA-256 of every source/download file.
- Exact license text or durable license snapshot.
- Explicit permission for commercial interactive use, modification, material
  and texture derivatives, animation retargeting, optimization, and
  redistribution as an embedded game asset.
- Clear attribution wording and placement if attribution is required.
- No editorial-only restriction, no prohibition on derivative works, no
  unresolved model-release issue for scanned people, and no requirement that
  downstream users receive editable source files unless the project has
  deliberately accepted that obligation.
- A source-offer/share-alike plan if the chosen license requires one. A store
  receipt alone is not a license record.

Preferred licenses are CC0, CC BY 4.0 with feasible attribution, or a commercial
asset license that expressly covers redistribution inside games. Do not source
geometry, textures, or clothing by tracing Google Street View or other
restricted imagery.

## Visual content requirements

The first accepted pack should provide 6–10 simultaneous hero pedestrians from
at least four genuinely different civilian silhouettes:

- Everyday contemporary clothing suitable for San Francisco: jacket, hoodie,
  sweater, shirt, trousers/jeans, skirt/dress where applicable, practical
  shoes, backpack/tote, and optional light workwear.
- No armor, tactical load-bearing gear, weapons, uniforms presented as generic
  civilians, sci-fi panels, exposed robot joints, or featureless mannequins.
- A balanced mix of apparent age, gender presentation, skin tone, hair
  silhouette, height, and body build without relying on caricature.
- At least eight muted clothing combinations. Color variation must be authored
  through material masks or swappable clothing materials, not a whole-body
  tint that recolors skin, eyes, and hair.
- Separate material slots or documented masks for skin, hair, upper garment,
  lower garment, shoes, and accessories.
- Faces, hands, hairlines, shoes, garment hems, and shoulder silhouettes must
  survive a 1080p fixed-camera review at 8–35 m.

The pack does not need photogrammetric faces. A coherent, realistic,
PBR-stylized civilian set is preferable to mixing incompatible scanned and
cartoon characters.

## Geometry and WebGL2 budget

Per hero actor:

| Tier | Target | Hard ceiling |
| --- | ---: | ---: |
| Near LOD, 8–20 m | 20k–35k rendered triangles | 45k triangles |
| Mid LOD, 20–45 m | 8k–15k rendered triangles | 20k triangles |
| Far handoff | Existing procedural actor/impostor | No skinned GLTF required |
| Bones | 55–75 deforming/animated bones | 90 bones |
| Skin weights | Four normalized influences per vertex | No more than four |
| Materials | 2–4 draw-call materials | Six materials |
| Textures | Shared 2k atlas set per clothing family | 4k only for a justified shared atlas |

Required PBR maps are sRGB base color plus linear normal and ORM
(occlusion/roughness/metalness). Use power-of-two dimensions, mipmaps, and
KTX2/Basis only after its transcoding path is proven on the minimum WebGL2
device. Alpha-blended hair cards require a sorting test; alpha-tested cards are
preferred where the cutout quality is adequate.

Deliver glTF 2.0 binary (`.glb`) with one character root, one humanoid skeleton,
no hidden source meshes, no cameras/lights, no non-finite transforms, and
metre-scale geometry. The bind-pose ground plane must be at the lowest shoe
contact, not the hips or scene origin.

## Scale and orientation contract

- glTF convention: +Y up; character forward axis declared in asset metadata and
  normalized by the loader.
- Bind-pose height after import must be measurable and non-zero.
- Each spawned actor receives a deterministic target height in the
  1.65–1.95 m range:

  `uniformScale = targetHeightMeters / bindPoseHeightMeters`

- Reject an asset if normalization creates implausible head, hand, or foot
  proportions. Do not use non-uniform body scaling to manufacture diversity.
- Recompute the post-scale bounding box and offset the root by
  `-bounds.min.y + groundClearance`, where `groundClearance` is 0–0.015 m.
- A contact shadow must be a soft foot-shaped oval, approximately
  0.32–0.46 m × 0.16–0.24 m, opacity 0.10–0.18, following the actor's actual
  ground height.

## Animation contract

Minimum in-place clips:

- relaxed idle, 4–10 seconds with no visible loop pop;
- walk, 0.9–1.3 seconds per cycle;
- brisk walk or crossing hurry;
- short stop/wait/look cycle;
- one neutral hand/phone or conversation gesture.

Optional occupation clips can be supplied later for cleaner, courier, barista,
and maintenance-worker vignettes.

All locomotion clips must:

- use the same skeleton and bind pose;
- be in-place or declare root-motion behavior explicitly;
- have stable root height and less than 2 cm unintended lateral/root drift per
  loop;
- show convincing heel/toe contact without skating, knee hyperextension, or
  shoe penetration;
- loop cleanly at 30 or 60 fps;
- avoid animation curves on unused mesh scale unless required;
- preserve clip names through GLB optimization.

## Runtime integration contract

Once a suitable pack is available, add `src/hero-pedestrians.js` rather than
replacing the crowd simulation:

```js
createHeroPedestrianTier({
  scene,
  proceduralPool,
  maxActors: 8,
  nearDistance: 8,
  farDistance: 45,
});
```

Implementation rules:

1. Load each source GLB once with `GLTFLoader`.
2. Clone skinned instances with `SkeletonUtils.clone`.
3. Clone only materials that receive per-character variation; share geometry,
   textures, skeleton-independent materials, and animation clips.
4. Create one `AnimationMixer` per visible hero and crossfade idle/walk/gesture
   states rather than restarting clips every frame.
5. Reuse the existing procedural simulation's position, heading, state, route,
   and occupation. The GLTF tier is a visual representation, not a second
   pedestrian simulation.
6. Hide the corresponding procedural body only after its GLTF clone, animation,
   normalized scale, and ground offset are ready. Restore it immediately on
   load failure or LOD eviction.
7. Restrict skinned replacements to 6–10 hero slots. Procedural actors remain
   the fallback and far LOD.
8. Never promote an actor inside 8 m of the camera or within the bottom 12% of
   the current screen. This prevents a newly loaded/cropped body from appearing
   in the foreground.
9. Use 3 m distance hysteresis and a minimum 1.5 second residency time to avoid
   LOD flicker.
10. Dispose only per-instance cloned materials/mixers. Do not dispose shared
    source geometry, textures, or clips while any hero clone exists.

The current `createPedestrianSystem()` exposes only `{ group, update,
getStats }`. Before integration, add a narrow read-only hero-slot interface
such as `getHeroVisualSlots()` returning stable actor IDs, transforms, state,
job, visibility, and procedural body references. Do not expose or duplicate the
entire private routing state.

## Acceptance checks

An asset pack is accepted only if all of these pass:

- License/provenance review and SHA-256 lock.
- All GLBs load without console, shader, skinning, or texture errors.
- Bind-pose and animated bounds are finite; target heights stay within
  1.65–1.95 m.
- Ten-minute simulation with eight GLTF heroes: no invalid transforms,
  detached meshes, mixer leaks, visible teleporting, foot penetration, or
  cropped foreground spawn.
- Repeated clear/fog/drizzle captures at fixed times show consistent PBR
  response and contact, with no glowing skin/clothes or white-out in fog.
- Blind visual comparison against the procedural hero tier shows a clear
  improvement in civilian silhouette, gait, ground contact, clothing, and face
  readability. “More polygons” alone is not a pass.
- Frame-time and memory budgets pass on the minimum supported WebGL2 device
  with the full traffic, weather, and pedestrian simulation active.
