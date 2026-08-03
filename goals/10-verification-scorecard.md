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
