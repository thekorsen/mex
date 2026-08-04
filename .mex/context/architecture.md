---
name: architecture
description: How the major pieces of this project connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
# Broad overview: keep this empty unless a claim depends on a few specific symbols.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }
grounds_to: []
last_updated: "2026-08-04"
---

# Architecture

mex is two halves that share a directory and a CLI, and are otherwise independent.
Citation convention in this wiki: path:line references are written as plain text, never
inside backticks — a backticked path:line is parsed as a path claim and fails existence
checking (src/drift/checkers/path.ts:113-164).

Read broad, ground tight. Architecture grounds sparsely; when a claim genuinely
depends on one specific symbol, anchor that symbol inline:

```markdown
[`someFunction()`](mex://function:<tier-1-id>)
```

## System Overview

**Wiki half — mechanical, zero AI tokens until the last step:**

`mex check` → runDriftCheck (src/drift/index.ts:67) walks the .mex/ scaffold Markdown →
each checker under src/drift/checkers/ (13 of them) emits typed issues →
src/drift/scoring.ts folds them into a 0-100 score → src/reporter.ts prints text or,
with `--json`, the machine contract (src/reporter.ts:23-27,80-86). No model is called.
The drifted file list then feeds `mex sync` → src/sync/brief-builder.ts assembles a
brief naming only the drifted files → src/sync/index.ts spawns an external agent CLI
through cross-spawn (src/sync/index.ts:2,45-48) → the agent edits the scaffold → the
GROW contract makes it write state, decisions, and patterns back into that same
scaffold, which is what the next `mex check` reads. Git closes the loop: a
`STALE_FILE` clears only when the file genuinely changes in a commit
(commitsSinceLastChange, src/git.ts).

**Graph half — fully deterministic, no model at any point:**

`mex graph` → src/graph/runtime.ts decides what to re-parse (size pre-filter, mtime
short-circuit, then `content_hash` as the authority for content equality —
src/graph/runtime.ts:99,134-141, hash written at src/graph/engine-impl.ts:205) →
src/graph/extraction/ loads a tree-sitter WASM grammar and walks the tree →
src/graph/resolution/ binds call sites to definitions → nodes and edges land in SQLite
under the frozen schema in src/graph/schema.sql → retrieval serves `graph scope`,
`graph get`, `graph query`, and `impact` (src/graph/scope.ts,
src/graph/traversal/traversal.ts), exposed both on the CLI (src/graph/cli-graph.ts)
and, as of wave 1, over MCP (packages/mex-mcp/src/tools/graph.ts).

Node identity is content-independent so a node survives an edit:
id = kind + ":" + sha256(filePath:kind:name) truncated to 32 hex chars, from the
RELATIVE path (src/graph/extraction/node-id.ts:35-39). Telling *changed* from *moved*
is a separate Tier-2 concern: a K=64 MinHash over normalized AST tokens plus
caller/callee neighbours, LSH-banded into 32 bands (src/graph/fingerprint.ts:2,64-67,
src/graph/reconcile-engine.ts).

## Key Components

- **src/drift/** — the whole check surface. runDriftCheck (src/drift/index.ts:67) fans
  out to the checkers directory; staleness.ts is the only one with a real git
  dependency (upstream merge-base, src/drift/checkers/staleness.ts:98-112),
  script-coverage.ts does a plain substring match over concatenated scaffold text, and
  omp-artifacts.ts validates the generated .omp/ projections. Depends on src/git.ts and
  src/config.ts; depends on no model and no network.
- **src/graph/** — extraction (src/graph/extraction/, per-language files under
  src/graph/extraction/languages/), resolution (src/graph/resolution/ plus
  src/graph/resolution/frameworks/), change detection (src/graph/runtime.ts), move
  detection (src/graph/reconcile-engine.ts with src/graph/fingerprint.ts), and the
  store (src/graph/db/sqlite.ts over the frozen `schema.sql`). Depends on
  web-tree-sitter plus the 5 vendored grammars in src/graph/wasm/, and on the built-in
  `node:sqlite`.
- **src/config.ts** — root resolution and per-checkout identity. resolveHooksDir
  (src/config.ts:340) is why `watch` works inside a git worktree; `checkout_id` is
  derived as sha256(gitDir ?? projectRoot) truncated to 32 chars (src/config.ts:357),
  while `scaffold_id` stays a random UUID v4 never derived from path, repo, or git
  (src/types.ts:56-60). Nearly every command calls into this first.
- **src/git.ts** — the ONLY git surface in the codebase; wraps simple-git. Owns
  upstream resolution (src/git.ts:83) and merge-base (src/git.ts:196). If you need
  git, extend this file rather than shelling out elsewhere.
- **src/setup/** — `mex setup` scaffold generation and per-tool artifact writing.
  src/setup/index.ts:60 maps menu option 7 to omp; writeOmpArtifacts
  (src/setup/index.ts:643) installs the .omp/AGENTS.md anchor bridge plus RULES.md and
  the rules, skills, and commands directories (src/setup/index.ts:75-79) from
  `templates/omp/`. Depends on `templates/` being shipped.
- **src/sync/** — brief-builder.ts (what the model is allowed to see) and index.ts
  (which CLI to spawn, resolved through AI_TOOLS at src/types.ts:14-22). This is the
  only component in the project that talks to an LLM.
- **packages/mex-mcp** — a separate npm workspace shipping a stdio MCP server that
  registers 9 tools (packages/mex-mcp/src/index.ts:20-28): `mex_check`, `mex_log`,
  `mex_timeline`, `mex_heartbeat`, `mex_read_file`, and the wave-1 graph four
  `mex_graph_scope`, `mex_graph_get`, `mex_graph_query`, `mex_impact`. Depends on the
  root package through a file:../.. workspace link and consumes the public API only.

**Public boundary:** src/index.ts is the only public surface — exactly 20 exports
(DEFAULT_HEARTBEAT_PATTERNS, DEFAULT_RETRIEVAL_OPTIONS, DEFAULT_SCAFFOLD_PATTERNS,
DEFAULT_STALENESS_THRESHOLDS, EVENT_KINDS, appendEvent, checkHeartbeat, createConfig,
eventLogPath, findConfig, getScaffoldIdentity, parseFrontmatter, readEvents,
runDriftCheck, runGraphGet, runGraphQuery, runGraphScope, runHeartbeat, runImpact).
src/cli.ts, src/setup/, src/sync/, src/graph/, and src/tui.ts are explicitly NOT
public — see `COMPATIBILITY.md`.

## External Dependencies

- `node:sqlite` DatabaseSync — the graph store, constructed at
  src/graph/db/sqlite.ts:59-60. Built into Node, not an npm package; this is the reason
  the engines floor is Node >= 22.5 (package.json:49-51). There is no better-sqlite3
  fallback and no native build step.
- tree-sitter WASM grammars — 5 vendored .wasm files in src/graph/wasm/ (typescript,
  tsx, javascript, python, rust), loaded through web-tree-sitter. They are NOT bundled
  by tsup; scripts/copy-graph-assets.mjs copies them plus `schema.sql` into dist/ after
  every build. Skipping that step ships a CLI that cannot parse anything.
- simple-git — all git I/O, reached exclusively through src/git.ts. Never call it
  directly from a checker or a command.
- The MCP SDK (@modelcontextprotocol/sdk) plus zod — used only inside
  packages/mex-mcp. The root package depends on neither.
- The yaml package — frontmatter parsing for every scaffold file, surfaced publicly as
  parseFrontmatter from src/index.ts.
- External agent CLIs — `mex sync` spawns whichever of claude, opencode, codex, or
  `omp -p` is present (AI_TOOLS at src/types.ts:14-22; spawn at src/sync/index.ts:48).
  Availability is probed, never assumed; absence degrades the command rather than
  crashing it.

## What Does NOT Exist Here

- No server, daemon, or hosted service. mex is a CLI (the `mex` bin maps to
  dist/cli.js, package.json:18-20) plus one stdio MCP server. There is no HTTP
  listener, no port, and no auth layer.
- No shared graph. The graph database under .mex/ is gitignored (.gitignore:21), so it
  is a per-clone local artifact rebuilt by `mex graph`. Do not design anything that
  assumes two checkouts see the same graph, and do not commit it.
- No extraction for Go, Java, C#, Ruby, PHP, or C/C++. Only TS, TSX, JS, JSX, Python,
  and Rust have grammars (src/graph/wasm/, src/graph/extraction/languages/); the .mts,
  .cts, .mjs, and .cjs extensions are partial. Everything else is skipped silently and
  is never fatal — an unsupported file must not fail a graph build.
- No framework resolver except Express. src/graph/resolution/frameworks/ contains
  express.ts and nothing else. Route and handler inference for any other framework does
  not exist.
- No `mex_sync` over MCP. The MCP server is read-and-check only, 9 tools
  (packages/mex-mcp/src/index.ts:20-28); spawning an agent stays a human-invoked CLI
  action.
- No reconciliation model for concurrent scaffold edits. Two agents editing the same
  .mex/ file race, last write wins, and nothing detects it. The design work lives in
  docs/omp-integration/design/knowledge-file-reconciliation.md and is not implemented.
