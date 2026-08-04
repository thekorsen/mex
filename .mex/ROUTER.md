---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: "2026-08-04"
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

House style for citations in the `.mex/` wiki: write a `path:line` reference as plain text, never inside backticks. `pathExists` never strips a `:line` suffix (src/drift/checkers/path.ts:113-164), and path claims are extracted from inline code spans, fenced blocks and bold text only (src/drift/claims.ts:49,83,105) — so plain prose stays precise while a backticked citation becomes a literal path claim and raises an error-severity MISSING_PATH. Backtick a path only when it exists on disk and carries no line suffix.

**Working:**
- `omp` is a first-class `AiTool` target (src/types.ts:5; `AI_TOOLS.omp` at src/types.ts:21). `mex setup` option "7" writes the .omp/AGENTS.md native anchor bridge (src/setup/index.ts:60), and `writeOmpArtifacts` (src/setup/index.ts:643) projects .omp/RULES.md, .omp/rules/, .omp/skills/ and .omp/commands/ from `templates/omp/`. Drift on those projections is checked by src/drift/checkers/omp-artifacts.ts, which emits `OMP_ANCHOR_BROKEN` (error), `OMP_RULE_DRIFT` and `OMP_RULE_ORPHAN` (warnings) — src/types.ts:131-133.
- Graph retrieval is exposed over MCP. The `mex-mcp` server registers 9 tools: `mex_check`, `mex_log`, `mex_timeline`, `mex_heartbeat`, `mex_read_file`, plus `mex_graph_scope`, `mex_graph_get`, `mex_graph_query` and `mex_impact` (packages/mex-mcp/src/tools/graph.ts). Process-global state is keyed by project root, so two checkouts served by one long-lived server do not share caches.
- The same four retrieval entry points are public API — `runGraphScope`, `runGraphGet`, `runGraphQuery`, `runImpact`, `DEFAULT_RETRIEVAL_OPTIONS` — bringing src/index.ts to 20 exports.
- Change detection is `content_hash`-authoritative: the `content_hash` column on `files` is the authority for content equality (src/graph/schema.sql:106, populated from a sha256 of the file source at src/graph/engine-impl.ts:205). Size is a cheap pre-filter, a matching mtime short-circuits the read, and a size-matched mtime change falls back to hashing (src/graph/runtime.ts:99,134-141).
- Staleness is upstream-aware. src/git.ts resolves the upstream ref (:83) and merge-base (:196); `checkStaleness` counts commits on the upstream ref that are not on ours, so a checkout 60 commits behind reports honestly (src/drift/checkers/staleness.ts:98-112). Merge commits are excluded from authored-work counts, so merge-flow and rebase-flow teams get the same signal (src/drift/checkers/staleness.ts:18-22).
- CI gates pull requests on error-severity drift (.github/workflows/mex-drift.yml). `check --json` is a versioned machine contract: the original four fields plus additive `counts` — one entry per severity, zero included — and `contractVersion`, currently 1 (src/reporter.ts:21,23-27).
- `watch` resolves the hooks directory through git instead of assuming a literal .git directory: `resolveHooksDir` in src/config.ts is used by `installHook` at src/watch.ts:63,68, and the installed hook body itself calls `git rev-parse --show-toplevel` (src/watch.ts:30). Worktrees no longer fail with `ENOTDIR`.
- Identity is two-part. `scaffold_id` stays a random UUID v4, never derived from path, repo or git (src/types.ts:56-60); `checkout_id` is derived — a truncated sha256 of the git dir, falling back to the project root (src/config.ts:357, src/types.ts:71) — so per-checkout signals are distinguishable without leaking repo identity.

**Not yet built:**
- `mex-mcp` is unpublished. It is a local build only and depends on the parent by path (packages/mex-mcp/package.json:22), so there is no install story for a consumer outside this repo.
- No `mex_sync` over MCP. `mex sync` has an interactive path that needs a TTY on both stdin and stdout (src/sync/index.ts:116-119); without one it degrades to non-interactive rather than prompting, so the guided loop is CLI-only.
- No grounding baselines ship with a clone. The graph database under .mex/ is gitignored (.gitignore:21), so a fresh checkout has wiki anchors but must run `mex graph` before any `grounds_to` entry can be validated. Every `grounds_to` in this scaffold is still empty.
- Graph language coverage is TS, TSX, JS, JSX, Python and Rust. The .mts, .cts, .mjs and .cjs variants are partial; everything else, Go included, is skipped — never fatal, but silently absent from the graph. Express is the only framework resolver.
- No reconciliation model for concurrent .mex edits by multiple agents. Design only — see docs/omp-integration/design/knowledge-file-reconciliation.md.

**Known issues:**
- Frontmatter parse failure is silent. `extractFrontmatter` swallows the YAML error and returns null (src/markdown.ts:23-29), so a malformed scaffold file is indistinguishable from one that has no frontmatter at all.
- A bracketed template placeholder left in `last_updated` disables the frontmatter-age signal entirely: `daysSinceFrontmatterDate` returns null for any value containing a square bracket (src/drift/checkers/staleness.ts:166). An unpopulated scaffold therefore under-reports its own staleness, and writing a real date is what activates the signal.
- `omp` does not read the root CLAUDE.md. Its `claude` provider reads .claude/CLAUDE.md only, so under `omp` the root anchor is invisible and .omp/AGENTS.md is the reaching path. Inside that file an `@` import resolves relative to the importing file's own directory, so the correct target is one level up at the .mex anchor; the bare form resolves inside .omp/ itself, does not exist, and fails silently leaving the literal token in the prompt.
- `checkToolConfigSync` short-circuits while the root CLAUDE.md is the only root tool-config present, since it needs at least two to compare. Cross-config divergence is unchecked until a second root config appears.
- Error-severity MISSING_PATH is routed to this file alone (src/drift/index.ts:162). Anyone editing ROUTER.md must keep path citations out of backticks and must never backtick a path absent from the checkout.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |
| Working on omp-harness integration | `docs/omp-integration/README.md` — per-issue notes live under its notes/ directory, designs under design/ |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After completing the task:
   - If no pattern exists for this task type, create one in `patterns/` using the format in `patterns/README.md`. Add it to `patterns/INDEX.md`. Flag it: "Created `patterns/<name>.md` from this session."
   - If a pattern exists but you deviated from it or discovered a new gotcha, update it with what you learned.
   - If any `context/` file is now out of date because of this work, update it surgically — do not rewrite entire files.
   - Update the "Current Project State" section above if the work was significant.
