# AAA NPC Animation + Behavior Tree Orchestration

Status: ACTIVE — do not stop until every NPC role has a BT and locomotion reads AAA-smooth frame-by-frame.

## Goal

Every NPC (core heroes, background pool, streamed district agents, player avatar) must:

1. Run a **specific behavior tree** (not a flat 4-state timer FSM alone).
2. Animate with **AAA-smooth locomotion**: heel-strike, weight transfer, gait blend, no skating, clean idle↔walk↔work↔cross transitions.
3. Pass **frame-by-frame visual QA** at street distance (8–35 m) until critic approval.

Civilian Mixamo robot/soldier GLBs remain **rejected**. Improve the procedural rig + BT layer until a licensed civilian pack exists.

## Roles that each need a dedicated tree

| Role | Tree focus |
| --- | --- |
| `commuter` | Navigate sidewalk → WaitSignal → Cross → ArriveOffice pause → Resume |
| `courier` | DeliverRoute → ApproachDoor → HandoffGesture → Resume |
| `barista` | StationWork (pour/serve) → CounterIdle → ShortWalk → Resume |
| `worker` | ToolWork → RestWeightShift → ResumeWalk |
| `tourist` | SightseeGaze → PhotoGesture → ViewpointIdle → Wander |
| `cleaner` | SweepWork → Relocate → SweepWork |
| `phone` | PhoneIdle → GlanceAround → SlowWalk |
| `streamed:*` | District activity tables mapped onto the same BT primitives |

## Architecture

```
src/npc-behavior-tree.js     # lightweight BT runtime (Status, Sequence, Selector, Parallel, Condition, Action, Wait, Blackboard)
src/npc-trees.js             # per-role tree factories bound to actor blackboard
src/npc-animation-layers.js  # layered pose additives (idle sway, gestures, weather hunch) composable with gait
src/pedestrians.js           # sim + hero/bg animate; BT tick replaces ad-hoc state transitions
src/streamed-agents.js       # mid/far LOD gait + BT-lite for streamed pool
src/player.js                # shared hero gait polish parity
```

Simulation remains authoritative for position/heading. BT decides **intent** (walk / idle / work / cross / socialize / weather react). Animation layers realize intent.

## File ownership (avoid thrash)

| Agent | Owns |
| --- | --- |
| BT Engine | `src/npc-behavior-tree.js`, `src/npc-trees.js` |
| Locomotion | `src/pedestrians.js` (`animate`, gait helpers only — re-read before write) |
| Streamed | `src/streamed-agents.js` (ped placement/gait/update only) |
| Anim Layers | `src/npc-animation-layers.js`, light `src/player.js` gait |
| Integration | Wire BT into `pedestrians.js` update + `main.js` if needed (after BT + locomotion land) |
| Visual QA | `scripts/qa-npc-animation.mjs`, capture artifacts under `tmp/npc-anim-qa/` |

## Acceptance (must all pass)

- [ ] Every JOB id and streamed role has a named BT root in `npc-trees.js`
- [ ] Core pool ticks BT each frame; schedules feed blackboard, not hard-coded `if` chains for role choice
- [ ] Walk cycle: visible heel plant, contralateral arm swing, pelvis shift, no foot skating on flat ground
- [ ] Idle/work: continuous micro-motion (weight shift, breath, gaze) — never frozen mannequin
- [ ] Transitions: gaitBlend / layer fades, no limb pops when stopping at curb or starting walk
- [ ] Streamed peds: limb **rotation** gait (not Z-offset sticks only)
- [ ] Frame-by-frame QA: ≥12 fixed camera frames across walk/idle/work/cross; critic score ≥ 8/10
- [ ] Verify scripts green: city-sim, streamed-agents, online avatar walk
- [ ] No mixer/GLTF civilian regression; no xbot/soldier promotion

## Shared progress board

Update `Docs/NPC_ANIM_SHARED_NOTES.md` after each agent wave.
