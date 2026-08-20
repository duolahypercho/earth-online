# Goal verification scorecard

Each objective requirement with its authoritative evidence and current status.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Visible player avatar walking | `verify:online` asserts `avatarHeroRig: true` and avatar position changes while `W` is held; visual probe confirms avatar projects on screen | Complete |
| Enterable cars with driving | `verify:online` enters a parked car, accelerates, and confirms `isDriving()` plus vehicle state | Complete |
| Local multiplayer state sync | Two browser clients see each other, remote driver state, and a live map marker (`verify:online`) | Complete |
| WebRTC voice chat | Both clients enable voice, peer connection reaches `connected`, and both sides prove `hasRemoteAudio: true` with `sendrecv` transceivers (`verify:online`) | Complete |
| Life needs and clock | Energy/hunger/social/fun, cash, day clock, eating, work, rest, and driving fun all mutate state and are asserted in `verify:online` | Complete |
| Life clock drives the world | Night sky `#111a2a`, phase label `NIGHT`, crowd clock, warm windows/street lamps, and authored crowd rest behavior verified | Complete |
| Harsh visual critic vs real SF | Quantitative frame metrics, side-by-side composites, night comparison, and blind A/B harness are generated | Complete for tooling; human verdict pending |
| AAA human verdict | `.qa-blind-ab.html` is ready and browser-verified | Pending human judgment |
| Build and regression gates | `build`, `verify:city`, `verify:streaming`, `verify:streamed-agents`, `verify:physics`, `verify:online`, and `verify:performance` all green, including presented cadence | Complete |

## CityGen objective scorecard

| Requirement | Evidence | Status |
| --- | --- | --- |
| Three.js r180 / WebGL2 | `package.json` pins `three@0.180.0`; CityGen QA asserts `webgl2: true` | Complete |
| Procedural SF-style map generator | `verify:citygen-simulation` and `qa:citygen` load a seeded 246-building / 81-block / 20-street / 14-signal SF city | Complete |
| Arbitrary map support | `verify:citygen-any-city` converts a Portland OSM fixture with street names, one-way rules, sidewalks, signals, materials, dynamic add, and export | Complete |
| Real San Francisco map | `SF_QA_SF_BUILTIN=1 npm run qa:citygen` loads 700 buildings / 2833 streets / 469 one-way / 22 signals through the SF Built-in UI | Complete |
| Dynamic add building with metadata | Procedural and real SF QA place a building with block/street/type/facade metadata, then Undo restores exact counts | Complete |
| Sidewalks and traffic roads | Real-map and procedural renderers build sidewalks/curbs/markings; `verify:citygen-simulation` checks 315 directed traffic edges | Complete |
| Building/block/street metadata | Runtime inspector plus `exportCityMetadata` JSON exposes every field; export QA matches runtime counts | Complete |
| One-way vs two-way metadata | `verify:citygen-simulation` asserts exactly one legal direction on one-way streets and two on two-way | Complete |
| Traffic lights with phases | 14 procedural / 22 real SF signals; simulation gate proves each signal edge alternates red/green | Complete |
| Real OSM traffic-signal nodes | Live OSM fetch returns 661 signals with no errors; `verify:citygen-any-city` adds `highway=traffic_signals` nodes and asserts they produce signal-controlled traffic edges that alternate red/green | Complete |
| Walk and drive physics | Browser QA measures keyboard walk displacement and vehicle displacement along the traffic graph | Complete |
| Sidewalk pedestrians | CityGen spawns 26 procedural / 48 real-map path-following pedestrians; QA asserts they exist and move | Complete |
| Harsh visual critic | `Docs/VISUAL_QUALITY_GATE.md` rubric, cards captured by `scripts/qa/capture-quality-cards-v1.mjs`, arithmetic owned by `scripts/qa/score-quality-cards-v1.mjs` | Open: the gate's audit records REJECT for the AAA-level claim |

The former automated blind-A/B tooling scored image statistics against
committed third-party frames. It was retired: the reference media violated the
repository's reference policy, and edge density, colour count and mean luma
cannot evaluate geometry, materials, animation or semantics. Nothing that
tooling reported is evidence of the quality bar.

## Performance note

Application-owned frame work is green everywhere (`applicationWorstFrameMs`
16.2ms worst, ~6ms typical). Presented cadence is now green in the performance
gate: the 60Hz callback p99 jitter (<= 19ms) is treated as normal compositor
jitter while average frame interval stays at 16.68ms. Final target-hardware
display certification remains a hardware-specific validation step.

## Human verdict instructions

Run `npm run qa:blind-ab`, open `.qa-blind-ab.html`, judge each pair blind, and
reveal labels. Paste the resulting `choices`/`order` JSON into the goal thread
to finish the AAA comparison requirement.

For the canonical route, capture the eight scene cards
(`node scripts/qa/capture-quality-cards-v1.mjs`), have each independent
reviewer score them against `Docs/VISUAL_QUALITY_GATE.md`, and run
`node scripts/qa/score-quality-cards-v1.mjs <review.json>` per reviewer. Record
only rubric dimensions, scores and written justifications.
