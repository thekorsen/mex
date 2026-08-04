---
name: stack
description: Technology stack, library choices, and the reasoning behind them. Load when working with specific technologies or making decisions about libraries and tools.
triggers:
  - "library"
  - "package"
  - "dependency"
  - "which tool"
  - "technology"
edges:
  - target: context/decisions.md
    condition: when the reasoning behind a tech choice is needed
  - target: context/conventions.md
    condition: when understanding how to use a technology in this codebase
# Broad inventory: ground only claims embodied by a small number of symbols.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }
grounds_to: []
last_updated: "2026-08-04"
---

# Stack

Rationale here is one clause per item; deeper reasoning belongs in
context/decisions.md. Note the local prose rule: library names in this file are NOT
bold, because bold text under a headings matching key libraries / core technologies /
dependencies / stack becomes a dependency claim checked against package.json
(src/drift/claims.ts:9,105-143). Same reason path:line citations are plain text, never
backticked.

Grounding stays sparse here. For a concrete wrapper or adapter mention, anchor the
symbol inline:

```markdown
[`someFunction()`](mex://function:<tier-1-id>)
```

## Core Technologies

- TypeScript 5.7 — the only implementation language (package.json:85). Bundled by tsup
  for shipping and type-checked separately by `tsc --noEmit`.
- ESM only — the package declares type module (package.json:5) and its single export
  path is import, with no require condition (package.json:11-17). No CJS build exists.
- Node >= 22.5, a HARD floor rather than a recommendation (package.json:49-51). The
  graph store constructs DatabaseSync from the built-in `node:sqlite` module
  (src/graph/db/sqlite.ts:59-60); on older Node that import does not exist and there is
  no fallback driver.
- SQLite via `node:sqlite` — the code-graph store, under the frozen schema in
  src/graph/schema.sql; chosen because it needs zero native build.
- tree-sitter compiled to WASM, via web-tree-sitter ^0.25.10 (package.json:75) — all
  source extraction; WASM avoids per-platform native bindings.

## Key Libraries

- commander ^13 (not yargs, not hand-rolled argv) — the entire CLI surface is declared
  in src/cli.ts, including the telemetry preAction hook at src/cli.ts:55-72.
- simple-git ^3.27 — all git access, and only through src/git.ts; that file is the
  single git surface, which is why upstream resolution (src/git.ts:83) and merge-base
  (src/git.ts:196) live there instead of being re-implemented per checker.
- The yaml package ^2.7 — scaffold frontmatter parsing, surfaced as the public
  parseFrontmatter from src/index.ts. Do not hand-parse frontmatter.
- web-tree-sitter plus 5 vendored grammar WASMs — src/graph/wasm/ holds the typescript,
  tsx, javascript, python, and rust grammars; tree-sitter-wasms ^0.1.12 is a
  devDependency (package.json:83) used to source them, so runtime never downloads a
  grammar.
- cross-spawn ^7 (not `node:child_process` directly) — spawns external agent CLIs,
  because npm installs claude as claude.cmd on Windows and plain spawnSync throws
  ENOENT there (src/sync/index.ts:2,45-48).
- ink ^7 with react ^19 — the TUI in src/tui.ts, strictly TTY-gated: it bails when
  either stdin or stdout is not a TTY (src/tui.ts:54), so piped and CI invocations
  never try to render.
- vitest ^3 (not jest, not `node:test`) — the whole suite; run non-watch as
  `vitest run` (package.json:55).
- tsup ^8.4 (not tsc-emit, not a rollup config) — bundling. It bundles JS only, so the
  build script chains scripts/copy-graph-assets.mjs to copy `schema.sql` and the 5
  grammar wasm files into dist/ (package.json:53). A tsup-only build produces a CLI
  that cannot parse anything.
- posthog-node ^5 — telemetry only, fired from the CLI preAction hook
  (src/cli.ts:55-72), opt-out via MEX_TELEMETRY=0 or DO_NOT_TRACK=1.
- The MCP SDK ^1.12 with zod ^3 — confined to the packages/mex-mcp workspace, which
  depends on the root package through a file:../.. link. That package is unpublished:
  local build only, consuming the public API surface of src/index.ts.

## What We Deliberately Do NOT Use

- No better-sqlite3 and no native SQLite binding — `node:sqlite` is built in
  (src/graph/db/sqlite.ts:59-60), which is the entire reason the Node floor is 22.5.
  Adding a native driver would reintroduce a per-platform compile step.
- No native tree-sitter bindings — WASM grammars only, vendored under src/graph/wasm/.
  Same motivation: `npm install` must never compile C.
- No CJS build and no dual publish — ESM only (package.json:5,11-17). Do not add a
  require export condition.
- No LLM or model SDK as a dependency. mex never embeds a model client; `mex sync`
  spawns whatever agent CLI the user already has (AI_TOOLS at src/types.ts:14-22).
  Every drift checker is mechanical and token-free.
- No ORM or query builder for the graph — hand-written SQL against the frozen schema in
  src/graph/schema.sql.

## Version Constraints

- Node >= 22.5 is non-negotiable. DatabaseSync from `node:sqlite`
  (src/graph/db/sqlite.ts:59-60) is the hard gate; anything below fails at graph
  construction, not at install time. The @types/node dependency is pinned to ^22
  (package.json:80) to match.
- react ^19 with ink ^7 — the TUI is on the current major pair (package.json:67,69);
  ink 7 is ESM-only, consistent with this package being ESM-only.
- packages/mex-mcp is unpublished and version-coupled to this repo via a file:../..
  dependency. It is built and consumed locally, with no independent release train, so a
  public-API change in src/index.ts can break it in the same commit.
