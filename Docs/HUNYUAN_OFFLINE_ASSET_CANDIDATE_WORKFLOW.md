# Hunyuan3D offline candidate quarantine

This repository does not run Hunyuan generation in the browser or in the game
runtime. A Hunyuan result is only a **non-authoritative asset candidate** until
a person approves it after source, licensing, geometry, visual, and performance
review. The scripts below intentionally do not have a public-output mode,
promotion command, runtime loader, or tile-manifest integration.

## Scope and current availability

Treat this as an intake contract, not a claim that an entire world-generation
pipeline is installed here. As of this workflow's 2026-08-10 review:

- [WorldClaw's project page](https://tencent-hunyuan.github.io/Hunyuan3D-WorldClaw/)
  describes the work, but no executable WorldClaw release is wired into this
  repository. It must remain an external, offline candidate source until an
  executable release and its terms are independently reviewed.
- [Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) is the
  candidate asset-family reference. Its upstream materials recommend a remote
  CUDA-capable environment for generation; this Three.js project neither
  installs nor invokes it. Record the exact model and checkpoint used.
- [HY-World 2.0](https://github.com/Tencent-Hunyuan/HY-World-2.0) is treated as
  future R&D for this product plan. Its research progress is not permission to
  replace surveyed geometry, add a runtime dependency, or publish its outputs.

The Hunyuan3D-2.1 Community License has territory, acceptable-use,
redistribution-notice, and output-responsibility terms. Intake records the
reviewed license and rights assertions; it does not decide that the assertions
are legally sufficient. See the upstream
[license](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE)
before any external generation or later approval.

## Intake

Provide a self-contained GLB and a separate provenance JSON file:

```bash
node scripts/world-assets/import-hunyuan3d-candidate.mjs \
  --glb /absolute/path/to/candidate.glb \
  --provenance /absolute/path/to/candidate.provenance.json
```

The default destination is `private/quarantine/hunyuan3d/`, deliberately
outside `public/`. The importer copies the pair under the GLB SHA-256 and emits
a normalized receipt. An existing identical candidate is an idempotent import.
The importer rejects a target inside `public/` and writes `review.status` as
`quarantined` with `promotionApproved: false`; no script in this workflow can
alter that state.

The provenance record must include this shape (extra fields are retained):

```json
{
  "schemaVersion": "hunyuan3d-candidate-v1",
  "candidateId": "sf-ferry-lamp-v1",
  "assetRole": "street-furniture",
  "geospatialAuthority": false,
  "content": { "sha256": "<sha256 of the GLB>" },
  "model": {
    "family": "Hunyuan3D-2.1",
    "name": "exact model name",
    "checkpoint": "exact checkpoint/revision",
    "sourceRepository": "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1"
  },
  "license": {
    "id": "Tencent Hunyuan 3D 2.1 Community License Agreement",
    "sourceUrl": "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE",
    "reviewedAt": "2026-08-10"
  },
  "rights": {
    "inputRights": "confirmed",
    "outputRights": "pending-human-review",
    "distributionAllowed": false
  },
  "input": { "digestSha256": "<sha256 of every generation input bundle>" },
  "prompt": "the exact generation prompt",
  "seed": 1234,
  "environment": {
    "generatorVersion": "exact version",
    "runtime": "remote CUDA worker",
    "operatingSystem": "Linux",
    "gpu": "recorded GPU",
    "cuda": "recorded CUDA version",
    "generatedAt": "2026-08-10T00:00:00.000Z"
  },
  "coordinate": { "upAxis": "+Y", "unit": "meters", "forwardAxis": "-Z" },
  "budgets": {
    "maxBytes": 10485760,
    "maxVertices": 50000,
    "maxTriangles": 100000,
    "maxImages": 4,
    "maxTextureDimension": 2048
  },
  "review": { "status": "quarantined", "promotionApproved": false }
}
```

The GLB must be an exact glTF 2.0 binary container with JSON and binary chunks,
fully self-contained (no `uri` field anywhere), valid declared buffer coverage,
and mesh/image counts under the supplied budgets. This is structural screening,
not a visual, collision, malware, or legal audit.

Only these roles are accepted: `facade-detail`, `facade-material-proxy`,
`street-furniture`, `vegetation-proxy`, and `non-authoritative-prop`. The
importer rejects roles such as roads, sidewalks, building footprints, elevation,
shoreline, navigation, collision, traffic, NPCs, water, or `public-runtime`.
Generated assets can never be authoritative for map geometry; OSM/surveyed
sources remain authoritative under the world-tile workflow.

## Verification

```bash
node scripts/world-assets/verify-hunyuan3d-candidate.mjs
```

This writes its generated minimal triangle GLB and all temporary intake data to
an OS temporary directory. It proves a valid quarantined import and rejects
digest mismatch, an external URI, an authoritative role, geospatial authority,
an invalid coordinate declaration, a promoted review state, and a triangle
budget breach. It does not download a model or create an actual candidate.

After this gate passes, a real external candidate still requires human rights
approval and production review before any separate, deliberately designed
promotion process could be proposed.
