# San Francisco / Golden Hour — development plan

## Where we are now

The project is a playable low-poly city simulator with a small but complete
game loop. The current build already includes:

- a deterministic San Francisco-inspired street district with textured
  buildings, hills, waterfront dressing, bridges, signage, street furniture,
  collision-safe camera movement, and six enterable interior variants;
- live traffic with signal phases, vehicle spacing, braking lights, turn
  indicators, buses, taxis, delivery trucks, SUVs, and a hero sports car;
- live pedestrians with walking, working, crossing, separation, schedules,
  role/activity mixes, and streamed representatives outside the authored core;
- a 384 m sector streamer covering 837 sectors / about 122 km² of coarse city
  state, with near-detail sectors, proxy rings, handoffs, enterable streamed
  portals, and bounded actor pools;
- clear, coastal fog, and Pacific drizzle weather with wet pavement, puddles,
  runoff, fog grading, sky changes, and cached shadow refreshes;
- the replayable **Waterfront Loop** shift: six objectives, real interiors,
  score, timer, progress feedback, and an in-world objective beacon;
- adaptive, balanced, and cinematic render profiles with tuned tone mapping,
  SSAO, SMAA, bloom, fog, shadow atlases, and performance telemetry.

## How far we want to take it

The target is a calm, detail-rich **living city sandbox**, not an empty tech
demo and not a full-scale AAA open-world clone. The bar is that a player can
drop in for five minutes, discover something, complete a small route, and keep
roaming because the city feels legible and alive.

### Phase 1 — City readability and repeatable play

This is the immediate next milestone:

- ship the live district map and route layer;
- add named districts, points of interest, and route-aware wayfinding;
- add more short shifts that use the existing traffic, interiors, landmarks,
  and pedestrian schedules;
- make the UI explain what is happening without hiding the scene;
- keep desktop and touch controls, a stable 60 FPS target, and a clean beauty
  mode as non-negotiable quality gates.

### Phase 2 — Expand the walkable city

- turn more streamed sectors into authored destinations rather than only
  background massing;
- add a second waterfront band, a denser downtown grid, Chinatown/North Beach
  streets, and a hill route with readable grades and sightlines;
- add more landmark interiors and exterior transitions;
- grow the vehicle catalog with streetcars, service vans, motorcycles, and
  distinctive color/role mixes;
- add block-level street dressing: bus stops, loading zones, construction,
  deliveries, curbside pickup, parks, and small storefront interactions.

### Phase 3 — Make the simulation feel socially alive

- give pedestrians and vehicles schedules that change by district and time of
  day instead of only changing counts;
- add small city events: ferry arrivals, traffic incidents, street work,
  market setup, school release, fog banks, and parade/civic moments;
- add a lightweight day/night clock, ambient audio hooks, and persistent route
  completion so the city remembers the player's shift;
- add accessibility options for motion, contrast, text scale, and input mapping.

### Phase 4 — Content depth and polish

- add a route editor for custom walks and photo spots;
- add more interior micro-scenes and a compact save/profile layer;
- add richer camera/photo tools and curated beauty locations;
- profile GPU/CPU budgets on representative hardware, then tune geometry,
  texture streaming, shadows, and post-processing per device tier;
- package a polished public demo build with screenshots, a short trailer, and
  contributor-friendly documentation.

## Quality bar

Every feature should earn its place by improving one of three things:

1. **Believability** — the city behaves like a place with people, rules, and
   routines.
2. **Readability** — the player understands where to go and why without a wall
   of UI.
3. **Feel** — movement, lighting, shadow contact, weather transitions, and
   small interactions feel deliberate.

We should stop expanding a system when it adds complexity without making the
city more believable, readable, or fun. The public repository should always
build from a clean checkout and keep the verification gates green.
