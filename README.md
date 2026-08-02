# San Francisco / Golden Hour

A low-poly, real-time San Francisco-inspired city simulator with a playable
waterfront shift. Explore a living district with traffic signals, pedestrians,
enterable interiors, changing Pacific weather, streamed city sectors, and a
calibrated shadow/render pipeline.

## Play

```bash
npm install
npm run dev
```

Open the local Vite URL, click **Enter the city**, and follow the amber beacon
through **The Waterfront Loop**:

- Reach the Embarcadero Welcome Center.
- Ask Mara for the waterfront route.
- Mark the Bay route on the tactile model.
- Open the map archive.
- Finish at the Ferry Building.
- Take the route to Coit Tower.

Desktop controls: `W A S D` move, drag to orbit, `E` enter/interact, `Esc` exit
an interior, `M` open the live district map, `R` cycle clear/fog/drizzle
weather, `C` toggle cinematic render quality, and `H` hide the HUD for a clean
beauty frame.

## Verify

```bash
npm run build
npm run verify:city
npm run verify:streaming
npm run verify:streamed-agents
```

The project is intentionally dependency-light: Three.js and Vite power the
runtime, while the city is authored from deterministic low-poly geometry,
procedural materials, and a small set of local atlases.
