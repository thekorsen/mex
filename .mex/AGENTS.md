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

## Scaffold Growth
After every task: if no pattern exists for the task type you just completed, create one. If a pattern or context file is now out of date, update it. The scaffold grows from real work, not just setup. See the GROW step in `ROUTER.md` for details.

## Navigation
At the start of every session, read `ROUTER.md` before doing anything else.
For full project context, patterns, and task guidance — everything is there.
