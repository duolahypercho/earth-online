# World plugins

Every runtime extension lives in exactly one `plugins/<plugin-id>/` directory
and is registered once in `plugins/manifest.json` and `src/plugins/registry.js`.

Each plugin must provide:

- `index.js`, the production module consumed by the canonical `/` runtime;
- `verify.html`, an isolated browser page that exercises that same registered
  module; and
- a unique plugin ID, `worldId: "sf"`, owning subsystem, and kind.

Verification pages may create temporary scene objects through the plugin API,
but plugins may not create a renderer, animation loop, world root, or second
map application. Run `npm run verify:plugins` before committing a plugin.

Do not add a new player-facing HTML entrypoint for a feature. Add the feature
to the canonical world first, then use its `verify.html` for isolated QA.
