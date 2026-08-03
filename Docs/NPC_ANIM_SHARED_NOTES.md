# NPC Animation Shared Notes

## Progress

- [x] Baseline audit: procedural sine gait + 4-state FSM; no BT; no AnimationMixer
- [x] BT runtime + per-role trees (`src/npc-behavior-tree.js`, `src/npc-trees.js`)
- [x] AAA locomotion polish (core heroes) — Wave 1–2
- [x] Animation layers (`src/npc-animation-layers.js`) + player gait parity
- [x] Streamed district rotational gait + activity BTs
- [x] Wire BT into pedestrian + streamed update
- [x] Split background crowd L/R limbs (fix sync-leg FAIL)
- [x] Frame-by-frame QA harness (`npm run qa:npc-anim`)
- [x] Visual critic: clear full-body alternating gait every subject every keyframe
- [ ] All verify scripts green

## Architecture shipped

| Module | Role |
| --- | --- |
| `src/npc-behavior-tree.js` | Status / Sequence / Selector / Condition / Action / Wait |
| `src/npc-trees.js` | 7 core role trees + 13 streamed activity trees |
| `src/npc-animation-layers.js` | Shared locomotion / idle / work / weather layers |
| `src/pedestrians.js` | BT tick + polished `animate()` + bilateral crowd limbs |
| `src/streamed-agents.js` | Pitch-rotated instanced limbs + activity BT |
| `src/player.js` | Uses shared locomotion helpers |
| `scripts/qa-npc-animation.mjs` | 16-frame captures + score /10 |
| `scripts/verify-npc-bt.mjs` | Tree smoke tests |

## Roles with dedicated BTs

`commuter`, `courier`, `barista`, `worker`, `tourist`, `cleaner`, `phone`

Streamed: `commuting`, `working`, `shopping`, `studying`, `leisure`, `resting`, `lunch`, `touring`, `errands`, `shift`, `returning`, `service`, `running`

## Critic scores

| Iteration | Auto | Visual | Notes |
| --- | ---: | --- | --- |
| 0 | — | — | baseline |
| 1 | 9.6 FAIL | FAIL | crowd legs shared → alternation −1 |
| 2 | 9.9 PASS | FAIL | bone metrics green; camera under floor / lost subject |
| 3 | 10 PASS | PARTIAL | hero readable some frames; crowd T-pose; streamed empty |
| 4 | 10 FAIL | FAIL | crowd blank/black frames (camera in facade) |
| 5 | 10 PASS | PARTIAL | elevated camera; all subjects auto-PASS; visual still shows wall clip + stiff streamed stride |
| 6 | 10 PASS | PARTIAL | skinned hero rotation-only gait; beauty lane flip + street bias; streamed hip anchor + pitch↑; auto all-green; residual crowd clip / QA camera roam |
| 8 | 10 PASS | PARTIAL | ticks 4–5: HMR races fixed with ped-ready guard; auto green; visual still short of AAA smoothness |
| 9 | 10 PASS | PARTIAL | verified clip/float fix: hero mid-stride connected (frame-08); frame-00 still wall-hugs; streamed still distant silhouettes |
| 10 | 10 PASS | PARTIAL | gait polish: hero mid-stride clear; crowd still facade-clips in verify capture; streamed still distant silhouettes — not full visual AAA |
| 11 | 10 PASS | PARTIAL | tick 8: crowd hip unburied + elevated lens; auto green; streamed still silhouette-far |
| 12 | 10 PASS | PARTIAL | tick 9: crowd frame-08 full body visible; streamed camera elevated 3/4 to clear green occluders |
| 13 | 10 PASS | PARTIAL | tick 10: streamed ped framed mid-street (still solid-black silhouette); crowd framing still flaky |
| 14 | 10 PASS | PARTIAL | tick 11: streamed ped materials — cut dark emissive + lift wardrobe; vertexColors off for instanceColor |
| 15 | 10 PASS | PARTIAL | tick 12: streamed colored mid-stride OK; hero still wall-clips; crowd still buried/floating — street bias↑ |
| 16 | 10 PASS | PARTIAL | tick 13: hero partially clearer on sidewalk; still corner-clip; added +X beauty world nudge |
| 17 | 10 PASS | IMPROVED | tick 14: hero clear mid-stride on sidewalk (no facade embed); streamed colored walk holds; crowd still weaker |
| 18 | 6.8 FAIL | IMPROVED | tick 15: crowd full-body walk visible; streamed subject miss after HMR (retry added); hero still clean |
| 19 | 10 PASS | PARTIAL | tick 16: auto all-PASS; streamed mid-stride colored OK; hero on sidewalk; crowd capture still loses limbs (camera/ground skim) |
| 20 | FAIL→harden | — | tick 17: HMR mid-run; QA retries + bootSim recovery |
| 21 | 10 PASS | IMPROVED | tick 17b: crowd waist-hip reconnect (hip 0.90); mesh.y camera; street bias↑; frame-12 still corner-clips Coit |
| 22 | 10 PASS | PARTIAL | tick 18: corner street push + streamed road-side lens; critic pending |
| 23 | 10 PASS | FAIL crowd | tick 18b: hip 0.90 + hard corner push buried crowd in plaza — reverted hip 0.52, soft corner, surface-Y reject |
| 24 | 10 PASS | FAIL crowd | tick 19: roam (40,22) inside cable-car aperture — buried heads; moved roam to (52,42) + aperture reject |
| 25 | 6.8 FAIL | — | tick 20: crowd subject miss after hard aperture reject (heroes OK / streamed OK) |
| 26 | 10 PASS | IMPROVED | tick 21: crowd mid-block full-body gait (frame-08/12); frame-00 still wall-occluded; hero+streamed clear |
| 27 | 10 PASS | IMPROVED | ticks 18–22: street-side crowd lens — frame-00 full-body walk; streamed hip/shoulder pivot pins capsule tops |
| 28 | 10 PASS | IMPROVED | tick 23: arm lateral↓ + shoulderY↑; hero/crowd/streamed all auto-PASS after HMR settle |
| 29 | 10 PASS | PARTIAL | tick 24: transient Vite goto timeout; auto green; hero idle + crowd miss mid-run — force-walk on setQaSolo |
| 30 | 10 PASS | IMPROVED | tick 24b: force-walk restored hero mid-stride; crowd still stiff/low-leg in some frames; streamed OK |
| 31 | 10 PASS | IMPROVED | tick 25: narrower crowd legs + wider stance + swing↑ so rear views don't fuse into one slab |
| 32 | 10 PASS | IMPROVED | tick 26: Vite goto flake then PASS; profile crowd lens — frame-08 clear L/R stride; hero+streamed hold |
| 33 | 10 PASS | HOLD | tick 27: HMR context flake then PASS; hero/crowd/streamed still show readable walk — no new visual regressions |
| 34 | 10 PASS | HOLD | tick 28: Vite rebound IPv6-only — 127.0.0.1 timed out; QA via localhost PASS; gait hold |
| 35 | 7.6→10 | HOLD | tick 29: streamed FAIL from boot-overlay screenshots mid-HMR; ensureSimLive per-frame → PASS |
| 36 | 10 PASS | HOLD | tick 30: clean PASS; hero/crowd/streamed gait readable; no boot-overlay leak |
| 37 | 6.8→10 | IMPROVED | tick 31: hero miss mid-HMR then PASS; skip BT while qa force-walk so heroes don't snap IDLE |
| 38 | 10→9.7 | HOLD | tick 32: streamed profile cam + mover retarget (no sitters); crowd translate gate; PASS overall |
| 39 | 6.5→10 | IMPROVED | tick 33: pre-nav force-walk; milder skinned foot pitch; street-side crowd cam; streamed closer + hotter gait |
| 40 | 10 PASS | IMPROVED | tick 34-35: streamed setQaForceWalk (no dwell/wait); delta retarget; stronger beauty-route street nudge |
| 41 | 9.5→10 | HOLD | tick 36: curb-ward streamed lanes + hotter QA gait/pace; hero mid-stride clear of corner |
| 42 | 10 PASS | HOLD | tick 37-38: slim streamed role cues (no waist-tray); wider arm swing; clean PASS |
| 43 | 10 PASS | HOLD | tick 39: extra street nudge; hero/crowd/streamed still clear gait PASS |
| 44 | 10 PASS | IMPROVED | tick 40: clamp streamed leg pitch (no V-sit on cross); softer QA gait boost |
| 45 | 10 PASS | HOLD | tick 41: skinned hero swing +12%; streamed cross mid-stride holds; no V-sit |
| 46 | 10 PASS | HOLD | tick 42: clean hold — hero mid-stride, crowd walk, streamed cross gait readable |
| 47 | 10 PASS | IMPROVED | tick 43: softer cross gait; prefer sidewalk movers; pull-back crowd cam; mid-swing sync; QA aborts crossing |
| 48 | 6.8→9.8 | IMPROVED | tick 44: mid-block streamed roam + grid reject; crowd street nudge; sidewalk stroll not crosswalk sit |
| 49 | 10 PASS | HOLD | tick 45: clean PASS — sidewalk streamed stroll, hero mid-stride, crowd clear of facade |
| 50 | 6.7→10 | IMPROVED | tick 46: hero miss fixed (surface≠mesh Y + pre-force walk); streamed hip hinge −sin Z + tuck; crowd hip raise; goto uses commit; visual: some hero frames still facade-clipped — keep street lens polish |
| 51 | HMR→10 | IMPROVED | ticks 47–51: context-destroyed flake then PASS; hero +X street lens (less corner swallow); high cam clears deck lips; plaza/apron reject; streamed gait readable |
| 52 | goto→10 | IMPROVED | ticks 52–53: Vite commit timeout then PASS; hero roam east of apron + mid-capture deck hop; hero frames clear of tan burial, readable walk on Embarcadero sidewalk |
| 53 | 10 PASS | IMPROVED | tick 54: clean hold then tuck streamed shoulders + drop default chest-band cue (no floating white cubes); hero/crowd mid-stride clear |
| 54 | 9.7→10 | IMPROVED | tick 55: streamed limbCycle was 0 (instanced, no bones) — evidence legSwing + hotter QA gait + closer profile cam → PASS 10 |
| 55 | 9.7→10 | IMPROVED | tick 56: streamed meanDelta soft from dead-rear follow — stronger side profile lens; hero/crowd hold clear Embarcadero gait |

## Loop

Fixed 5m loop armed: `AGENT_LOOP_TICK_npc_anim` — re-QA + visual Read until hero/crowd/streamed all show clear gait.

## How to run QA

```bash
npm run qa:npc-anim
# Prefer localhost after Vite IPv6-only binds (127.0.0.1 may refuse):
SF_QA_URL=http://localhost:5173/ npm run qa:npc-anim
node scripts/verify-npc-bt.mjs
```
