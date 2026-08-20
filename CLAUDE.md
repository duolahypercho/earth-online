# CLAUDE.md

Project rules for Claude Code and any other coding agent working in this repo.
Architecture, subsystem ownership, and verification rules live in
[AGENTS.md](AGENTS.md) — read that first for anything touching the runtime.
This file adds repo-wide policy that applies to *every* change.

## Reference policy (hard rule)

The visual bar for this project is "current-generation AAA open-world
presentation", defined only by the measurable rubric in
[Docs/VISUAL_QUALITY_GATE.md](Docs/VISUAL_QUALITY_GATE.md).

**Never name, describe, allude to, or embed third-party commercial products in
anything that can reach the remote.** This covers game titles, publishers,
studios, franchise names, product code names, and any recognizable abbreviation
of them.

Applies to, without exception:

- source, docs, comments, tests, fixtures, JSON/manifests, asset filenames;
- QA output, review records, scores, reports, and generated artifacts;
- commit messages, branch names, tags, PR titles and bodies, issue text.

Instead, write the neutral quality language: "AAA open-world quality",
"reference benchmark", "external visual reference", "the benchmark bar".

Third-party media is never committed, embedded, vendored, or used as a training
or comparison input inside the repo. Reviewers consult external reference
material privately, outside the working tree, and record only rubric
dimensions, scene categories, scores, and written justifications.

Before any commit, this must print nothing:

```bash
git diff --cached -U0 | grep -inE '<commercial-title-terms>'   # keep the term list local, never in-repo
```

Use the local, untracked checker instead of hardcoding a term list here:
`.claude/check-reference-policy.sh` (see `.claude/CLAUDE.local.md`).

## Local-only working material

Anything that names or holds external reference material stays **outside the
working tree** — never merely gitignored inside it when it can be avoided.

- Untracked local scratch: `.claude/`, `tmp/`, `sessions/`, `.qa-*`
- Off-repo reviewer material: keep it in a sibling directory outside this repo.

`.claude/` is gitignored and is the correct home for machine-specific notes,
environment paths, and reviewer term lists.

## Quality claims

- Do not claim a visual improvement from functional or integrity checks alone.
- Do not claim source correctness from a screenshot.
- Do not weaken a failing gate to make a candidate pass. Fix the behavior, or
  record the rejection.
- Automated image statistics (edge density, histogram, perceptual hash) are
  regression signals only. They cannot approve a quality bar.
