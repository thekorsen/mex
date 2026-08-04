---
name: agents
description: Always-loaded project anchor. Read this first. Contains project identity, non-negotiables, commands, and pointer to ROUTER.md for full context.
last_updated: "2026-08-04"
---

# mex

## What This Is
mex keeps a repo-local living wiki (`.mex/`, structured Markdown committed to git) honest against a deterministic tree-sitter → SQLite code graph, so an agent starts from grounded project context instead of guessing; this fork adapts it to the oh-my-pi (`omp`) harness.

## Non-Negotiables
- Never edit `.mex/` prose just to make a checker pass — the checker is the only signal that the wiki still matches the code, so fix the drift or fix the code. Cite code as plain-text path:line; a backticked path becomes a checked claim (src/drift/checkers/path.ts:113-164).
- src/index.ts is the only public API surface (`COMPATIBILITY.md`). The CLI, setup, sync, graph and TUI modules are private. Adding an export is a deliberate, reviewed decision.
- Node >= 22.5 is hard, not advisory: the graph store uses the built-in `node:sqlite` `DatabaseSync` (src/graph/db/sqlite.ts:59, package.json:50).
- `export MEX_TELEMETRY=0` in agent sessions — a `preAction` hook fires on every command (src/cli.ts:55-72).
- Never commit build output, installed modules, or the graph database: dist/, node_modules/ and .mex/graph.db are gitignored (.gitignore:21).

## Commands
- Dev: `npm run dev`
- Test: `npm test`
- Typecheck: `npm run typecheck`
- Build: `npm run build`

## Reach Under omp
`omp` does not read this file. Its `claude` provider reads .claude/CLAUDE.md (priority 80) only, so under an `omp` session the root anchor is invisible. The reaching path is the native anchor `mex setup` option "7" writes (src/setup/index.ts:60): .omp/AGENTS.md, which imports the wiki anchor with an `@` reference. That reference resolves relative to the importing file's own directory, so it must point one level up at the .mex anchor; the bare form resolves inside .omp/ itself, does not exist, and fails silently leaving the literal token in the prompt. Keep this file and .mex/AGENTS.md saying the same thing — only the latter reaches both harnesses.

## After Every Task
After completing any task: update `.mex/ROUTER.md` project state and any `.mex/` files that are now out of date. If no pattern existed for the task you just completed, create one in `.mex/patterns/`.

## Navigation
At the start of every session, read `.mex/ROUTER.md` before doing anything else.
For full project context, patterns, and task guidance — everything is there.
