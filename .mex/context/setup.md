---
name: setup
description: Dev environment setup and commands. Load when setting up the project for the first time or when environment issues arise.
triggers:
  - "setup"
  - "install"
  - "environment"
  - "getting started"
  - "how do I run"
  - "local development"
edges:
  - target: context/stack.md
    condition: when specific technology versions or library details are needed
  - target: context/architecture.md
    condition: when understanding how components connect during setup
# Ground only setup behavior implemented by specific code symbols.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }
grounds_to: []
last_updated: "2026-08-04"
---

# Setup

This is the runbook for developing **mex itself**. It is not .mex/SETUP.md — that one
is the scaffold-population runbook for a project that has installed mex. Citation
convention: path:line references are plain text, never backticked, because a backticked
path:line is parsed as a path claim and fails existence checking
(src/drift/checkers/path.ts:113-164).

Commands and environment facts need no code grounding. For a concrete symbol, anchor
it inline:

```markdown
[`someFunction()`](mex://function:<tier-1-id>)
```

## Prerequisites

- Node.js >= 22.5 — a hard floor, declared at package.json:49-51 and required by the
  built-in `node:sqlite` DatabaseSync used at src/graph/db/sqlite.ts:59-60. On older
  Node the graph does not degrade gracefully; it fails.
- npm 10+, whatever ships with Node 22. This repo uses npm workspaces
  (package.json:8-10), so the packages directory is linked by npm. Do not substitute
  pnpm or yarn.
- git — not optional tooling. src/git.ts, via simple-git, is a load-bearing dependency
  of the staleness checker; `mex check` on a non-git directory cannot compute commit
  counts.
- Nothing else. No database server, no Docker, no native toolchain — SQLite is built
  into Node and the tree-sitter grammars are vendored WASM under src/graph/wasm/.

## First-time Setup

1. `npm install` — installs the root package and links the packages/mex-mcp workspace.
   Its file:../.. dependency on mex-agent is what puts a mex-agent link into
   node_modules; the MCP server does not run without it.
2. Export MEX_TELEMETRY=0 before running anything else. See
   [Environment Variables](#environment-variables) — this is noise control, not
   courtesy.
3. `npm run build` — runs tsup and then scripts/copy-graph-assets.mjs
   (package.json:53). The second half is mandatory: tsup bundles JS only, so
   `schema.sql` and the 5 grammar wasm files are copied into dist/ separately.
4. `npm run typecheck` — `tsc --noEmit` (package.json:59). Expected clean.
5. `npm test` — `vitest run` (package.json:55). Expected fully green.
6. `node dist/cli.js check` — runs mex's drift checker against mex's own scaffold. This
   is the fastest confirmation that the build actually works end to end.
7. `node dist/cli.js graph` — builds the graph database under .mex/ from this repo's own
   source. Only needed when working the graph half, or before running the eval harness.

## Environment Variables

There is no .env file and no strictly required variable — mex runs with an empty
environment.

- MEX_TELEMETRY (effectively required for development) — set it to 0. Telemetry is
  fired from a commander preAction hook (src/cli.ts:55-72), which means it fires on
  *every* command, not just on opt-in paths. An agent loop that runs check and graph
  repeatedly emits hundreds of events. Export it once per shell.
- DO_NOT_TRACK (optional, equivalent) — setting it to 1 has the same effect as
  MEX_TELEMETRY=0. Use whichever your environment already sets.
- NO_COLOR / FORCE_COLOR (optional) — honored by chalk. The TUI is separately TTY-gated
  and refuses to render when stdin or stdout is not a TTY (src/tui.ts:54), so piped
  output is already plain.

Nothing here is a secret, which is why this file is safe to commit.

## Common Commands

- `npm run build` — tsup followed by scripts/copy-graph-assets.mjs (package.json:53).
  Always both halves. Never run bare tsup and expect a working CLI.
- `npm run dev` — tsup in watch mode (package.json:54). Note it does NOT re-run the
  asset copy, so if you change src/graph/schema.sql or add a grammar you must run a
  full `npm run build`.
- `npm run typecheck` — `tsc --noEmit` (package.json:59). Faster than a build and
  catches most breakage.
- `npm test` — `vitest run` (package.json:55). Single file: `npx vitest run` followed by
  the test path. Watch mode: `npm run test:watch` (package.json:56).
- `npm run build --workspace mex-mcp` — only when working on the MCP server. Trap: this
  succeeds even when the server cannot actually run, because tsup does not resolve
  runtime dependencies. Without the mex-agent workspace link present under
  node_modules, the built entrypoint throws ERR_MODULE_NOT_FOUND at startup. A green
  MCP build is not evidence of a runnable MCP server — start it and send an initialize
  request.
- `node dist/cli.js check` — the drift checker. Add `--quiet` for the score line only,
  or `--json` for the machine contract, which carries a counts object with every
  severity present including zero, plus a contractVersion field
  (src/reporter.ts:23-27,80-86).
- `node dist/cli.js graph` — rebuilds the graph database. Then `graph scope`,
  `graph get`, `graph query`, and `impact` for retrieval.
- `npm run eval` — runs evaluate/index.mjs (package.json:57). The eval harness entry
  point: it runs the deterministic categories (retrieval efficiency plus search
  quality), writes results under the evaluate results directory, prints a summary, and
  applies the hard gates from evaluate/thresholds.json, exiting non-zero if any gate
  fails (evaluate/index.mjs:1-10). Flags: `--root` to evaluate a different subject repo
  (defaults to this one), `--no-rebuild` to reuse the existing graph database instead of
  rebuilding via `mex graph`, and `--no-gate` to report without failing.
- `npm run eval:e2e` — runs evaluate/agent-e2e.mjs (package.json:58). Category 3, the
  end-to-end agent eval: it runs each variant (minimal versus source) against the
  natural-language task fixtures and measures accumulated tokens across all tool calls,
  follow-up `graph get` calls, Read and Grep fallbacks, and rubric correctness — the
  metrics that decide the default `--detail` (evaluate/agent-e2e.mjs:1-16). It is
  model-agnostic: a deterministic scripted reference driver by default, or a real model
  via `--driver`. Flags: `--root`, `--driver`, `--rebuild`. Caveat when reading its
  correctness numbers — with the scripted driver readGrepFallbacks is always 0 by
  construction, so scripted output is an idealized token-cost baseline, not a
  correctness verdict (evaluate/agent-e2e.mjs:13-16).

The eval and eval:e2e scripts are maintainer-facing evaluation entry points, not part of
the normal build/test loop — do not wire them into a pre-commit or CI path expecting
them to behave like unit tests. Neither ships: package.json:21-27 lists only dist,
templates, LICENSE, README.md, and COMPATIBILITY.md, so the evaluate directory is
repo-only. Background reading lives in evaluate/README.md and evaluate/RESULTS.md.

A `npm run prepare` script also exists (package.json:60), but it is an npm lifecycle
hook that just calls the build; never invoke it by hand.

**Expected-green baseline**, so a future session can tell regression from drift. Four
gates: `npm run typecheck` clean, `npm test` fully green, `npm run build` succeeding
including the asset copy, and `node dist/cli.js check` reporting zero error-severity
issues (exit 0 — errors exit 1 at src/cli.ts:165). The pre-wave-1 check score was
94 out of 100; wave 1 changed real code without touching this wiki, which is exactly
what pushed 10 scaffold files past the 50-commit STALE_FILE warn threshold
(src/drift/checkers/staleness.ts:11-16). This wiki-population pass is what restores the
score. Confirm the current number by running check rather than trusting a number
written here.

## Common Issues

**ERR_MODULE_NOT_FOUND starting the MCP server after a green workspace build.** The
workspace built fine; the mex-agent link under node_modules is missing, because tsup
does not resolve runtime dependencies. Run `npm install` at the repo root to restore
the workspace link, then retry.

**Graph commands find nothing, or the CLI cannot parse any file.** The copied
`schema.sql` and the wasm grammars are absent from dist/ — you ran tsup, or
`npm run dev`, without the asset copy. Run the full `npm run build`;
scripts/copy-graph-assets.mjs prints how many grammar files it copied, and it should
say 5.

**Hundreds of telemetry events during an agent loop.** The preAction hook fires per
command (src/cli.ts:55-72). Export MEX_TELEMETRY=0, or DO_NOT_TRACK=1, in the shell
that drives the loop rather than only in the first command.

**`mex check` reports a pile of STALE_FILE warnings right after real code changes.**
This is correct behavior, not a bug. STALE_FILE counts commits since the file last
changed in git, so it clears only when the scaffold file genuinely changes in a commit
(commitsSinceLastChange in src/git.ts; thresholds are 50 warn and 200 error at
src/drift/checkers/staleness.ts:11-16). Fix it by writing real prose. Bumping
last_updated without editing prose is the documented anti-pattern
(docs/omp-integration/AGENT-ONBOARDING.md:20).

**A backticked path:line citation in a scaffold file produces a MISSING_PATH error.**
pathExists never strips the line suffix (src/drift/checkers/path.ts:113-164) and claims
are extracted from inline code spans, fenced blocks, and bold text only
(src/drift/claims.ts:49,83,105). Write citations as plain prose; backtick a path only
when it exists on disk with no line suffix.

**Never commit build or graph artifacts.** The dist and node_modules directories, the
graph database under .mex/, and the evaluate results directory are all gitignored
(.gitignore:7-8,21,24). If `git status` shows them, something wrote outside the ignore
rules — investigate rather than force-adding.
