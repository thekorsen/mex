---
description: How to query this repo's code graph instead of grepping. Read when looking up a symbol or definition, asking who calls or what calls something, assessing the impact of a change, or exploring an unfamiliar area of the codebase.
---

<!-- mex-generated -->

# Code Graph Retrieval

The repo is indexed into `.mex/graph.db`. Prefer graph commands over grepping or reading files.

- Explore a task with `mex graph scope "<task>"` first — it returns a compact JSONL manifest (`meta`, `fact`s, `summary`).
- Treat any source the graph returns as ALREADY READ. Do not re-open those files.
- Pick 1-3 relevant node ids from the manifest and expand only those with `mex graph get <id> --detail source`.
- If you already know the symbol, skip scope: use `mex graph query <who-calls|what-calls|where-defined> <symbol>`, or `mex graph get <id>`.
- Before editing a symbol, run `mex impact <symbol|file>` to see affected callers and scaffold memory.
- If a result is `truncated`, do NOT repeat the broad query — narrow the task or use the summary's `suggestedNextCommands`. Scale through a few focused calls, never one giant response.
- During `mex sync`, adjudicate any AMBIGUOUS grounding; after repairs, ensure the refreshed grounding is re-emitted.

If the graph looks stale, run `mex sync` — do not fall back to reading the tree by hand.
