# Goal 09 - Online life-sim layer

- Owner: Orchestration agent (player, driving, networking, voice, life-sim)
- Status: active

## Objective

Turn the roaming city study into a playable stylized life-sim: a visible player
avatar that walks the city, enterable cars with lane-aware driving, local
multiplayer state sync, WebRTC voice with 3D spatial audio, and a small
A stylized life-sim needs layer with cash, a day clock, and resident chats.

## Requirements

- Player avatar follows the roam target with a walk cycle, name tag, and soft
  grounding shadow; third-person camera at person scale.
- `E` near a parked or slow vehicle enters it; `W/S` throttle and brake, `A/D`
  steer through the same intersections and lane curves as AI traffic; `E` or
  `Esc` exits.
- WebSocket relay (`server/multiplayer-server.mjs`) keeps a shared roster,
  relays transforms at 14 Hz, relays chat, and signals WebRTC voice.
- Remote clients render peers as avatars; remote drivers reuse the
  deterministic local traffic vehicle by index, with a procedural fallback car.
- Voice mode (`V` or HUD button) uses the microphone, peer connections through
  the relay, and HRTF panners positioned at each remote avatar.
- Life sim: energy/hunger/social/fun, cash, day clock, resting, driving fun,
  talking to residents, and eating at the Ferry Building market hall.
- Polish pass 2: richer avatar wardrobe, drive speed/heading panel, procedural
  engine/wind audio, voice-activity indicator, dynamic remote name tags, and
  `T` eating at the market hall.
- Polish pass 3: avatar grounded to terrain, live remote-player map markers,
  `F` work shifts, street-level real SF reference, reproducible visual-critic
  metrics, and tuned beauty grade.
- Polish pass 4: the life clock now drives a 05:00-22:00 sky/sun/exposure/grade
  arc, with time-phase labels in the life HUD and a QA `setTimeOfDay(hour)`
  hook verified in the online gate.
- Polish pass 5: full night lighting for authored and streamed districts,
  warm window/lamp/beacon ramps, a player-following street fill light, a real
  San Francisco night reference, and night side-by-side composites.
- Polish pass 6: local player and remote peers now use the shared hero rig
  (skinned body, detailed face, wardrobe atlas) instead of the simple box
  avatar, with shared-resource-safe disposal.
- Polish pass 7: a standalone blind A/B verdict harness
  (`npm run qa:blind-ab` -> `.qa-blind-ab.html`) so the real-vs-game judgment
  can be made and recorded by a human without model vision.
- Polish pass 8: authored pedestrian schedules follow the life clock
  (`setDayHour`), clock speed matches streamed schedules, and a realmap build
  blocker was fixed.
- Polish pass 9: fixed the last failing verification gate
  (`verify:streamed-agents`) by freeing crosswalk crowding, replacing infinite
  tableau dwells with seeded short pauses, and guaranteeing an Outer Sunset
  beachgoer.
- Polish pass 10: added a `X` rest recovery action and a
  requirement-by-requirement verification scorecard
  (`goals/10-verification-scorecard.md`).
- Polish pass 11: fixed one-way voice chat. The online gate now proves
  bidirectional remote audio (`hasRemoteAudio: true` on both clients).
- Polish pass 12: closed the headless cadence caveat; `verify:performance` is
  fully green including presented cadence, and the side-by-side/blind-A/B
  artifacts were regenerated.

## Verification

- `npm run build` green.
- `npm run verify:city`, `verify:streaming`, `verify:physics` green.
- `npm run verify:online` green: two browser clients see each other, walk,
  enter a parked car, drive, see the remote driver, exchange chat, eat at the
  market hall, and exchange real WebRTC audio with no console errors.
- `scripts/qa-visual-probe.mjs` confirms non-blank frames, on-screen avatar and
  car, HUD panel placement, and healthy draw-call/triangle counts.
- `scripts/qa-visual-compare.py` and `npm run qa:visual-critic` measure frames
  against real San Francisco references (histogram overlap, LAB distance,
  perceptual hash).
- Night references and composites: `public/data/reference-sf-night.jpg`,
  `.qa-visual-critic-night.json`, `.qa-side-by-side-night.png`,
  `.qa-side-by-side-night-facade.png`.
- Human verdict: `.qa-blind-ab.html` embeds five shuffled real-vs-game pairs,
  records choices locally, and reveals which side is real.
- Side-by-side composites generated against a real San Francisco photo in
  `.qa-side-by-side-driving.png` and `.qa-side-by-side-walking.png`.

## Known residuals

- Voice currently requires both players to enable voice mode, and renegotiation
  is now exercised when a peer enables voice after a connection exists.
- The "which looks better" AAA verdict remains a human judgment; the automated
  critic now covers motion, framing, HUD placement, WebRTC audio, life actions,
  non-blank frames, draw-call health, composite generation, and quantitative
  frame similarity against two real San Francisco references.
- The streamed-agent gate is green after pass 9.
- `X` rest recovers energy and advances the life clock, verified end-to-end.
- Human blind A/B verdict is the only remaining requirement step.
