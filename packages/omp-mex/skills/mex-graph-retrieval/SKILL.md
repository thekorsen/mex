---
name: mex-graph-retrieval
description: Workflow for the in-process mex code-graph retrieval tools (mex_graph_scope, mex_graph_get, mex_graph_query, mex_impact). Use when you need to find code you cannot already name, look up where a symbol is defined, trace who-calls / what-calls, expand a graph node id to source, or measure the blast radius of changing a symbol or file before editing it.
---

# mex Graph Retrieval Workflow

These four tools query `.mex/graph.db` — a deterministic Tree-sitter/SQLite index of
symbols and their relationships. Each one runs mex's own retrieval as a short-lived
`node` subprocess and hands you the JSONL verbatim, so what you read below is the real
protocol, not a re-wrapping of it.

Two prerequisites, and both fail loudly rather than silently:

- **`.mex/graph.db` must exist.** It is gitignored and built locally: run `mex graph`
  once per checkout, and again after large refactors. Until then every one of these
  tools returns `{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run `mex graph`
  first."}` (`src/graph/cli-agent.ts:469-472`) — an **envelope, not an exception**, so a
  missing graph looks like a normal empty answer. If you see that code, stop querying
  and build the graph.
- **mex must be built** (`npm run build` in the mex project), because the tools invoke
  its `dist/cli.js`. If it is not, the tool says exactly that and names the command.

If you are issuing many retrievals in one session, note that each call pays ~340 ms of
process startup. Prefer two focused queries over five speculative ones — which is the
same discipline the budget section below asks for, for a different reason.

This skill is about the **graph**. For the `.mex/` prose wiki — which page to read, the
`mex check` / `mex sync` drift loop, the GROW step — use the `mex-wiki` skill instead.

## The order of operations

Retrieval is cheapest when you narrow before you expand. Do not start with `get`.

```
know the symbol name?  ──yes──▶ mex_graph_query (where-defined / who-calls / what-calls)
        │ no                                     │
        ▼                                        ▼
  mex_graph_scope("<task>")  ──▶ pick 1-3 node ids ──▶ mex_graph_get(ids)
                                                       │
                          about to edit one? ──────────▶ mex_impact(target)
```

1. **`mex_graph_scope`** — the entry point for anything you cannot already name. Give
   it the task in natural language; it returns a *scored neighborhood* of the most
   relevant symbols under a hard token budget: signatures, relationships, node ids,
   and the reasons each node was selected.
2. **Pick 1-3 node ids that genuinely matter.** Expanding everything scope returned
   defeats the point of scoping.
3. **`mex_graph_get`** — expand exactly those ids to source.
4. **`mex_graph_query`** — skip scope entirely when you already know the symbol. A
   structural question is far cheaper than a scored neighborhood.
5. **`mex_impact`** — run this *before* editing any symbol you found. It returns the
   defining nodes plus transitive callers, so you learn what you are about to break
   while it is still cheap to reconsider.

**Treat any source these tools return as ALREADY READ.** Re-opening the same file with
a file read buys nothing and costs the context twice.

## The tools

Every tool also accepts an optional `projectRoot` (absolute path to the project root;
defaults to the session cwd). Pass it only when you mean to query a *different*
checkout than the session's.

### `mex_graph_scope`

| Param | Type | Default | Meaning |
|---|---|---|---|
| `task` | string | required | Natural-language task to scope |
| `tokenBudget` | number | `1500` | Hard ceiling on returned JSONL tokens |
| `maxNodes` | number | `10` | Max nodes in the neighborhood |
| `detail` | `minimal`\|`standard`\|`source` | `minimal` | Facts / facts+edges / facts+source |
| `maxSourceLines` | number | `120` | With `detail: "source"`, source lines per node |

### `mex_graph_get`

| Param | Type | Default | Meaning |
|---|---|---|---|
| `ids` | string[] | required | Node ids from a prior scope/query/impact result |
| `maxOutputTokens` | number | `1500` | Hard ceiling on returned JSONL tokens |
| `maxSourceLines` | number | `120` | Source lines per requested node |

Note the naming seam: `get` takes `maxOutputTokens` while the other three take
`tokenBudget`. Both map to the same underlying budget field; the split mirrors the MCP
tool surface (`packages/mex-mcp/src/tools/graph.ts`) rather than inventing a third
spelling.

### `mex_graph_query`

| Param | Type | Default | Meaning |
|---|---|---|---|
| `relation` | `who-calls`\|`what-calls`\|`where-defined` | required | The structural question |
| `target` | string | required | Symbol name or node id |
| `tokenBudget` | number | `1500` | Hard ceiling on returned JSONL tokens |
| `maxNodes` | number | `10` | Max related nodes returned |
| `detail` | `minimal`\|`standard`\|`source` | `minimal` | Detail level |

`relation` is a closed set. Anything else returns
`{"type":"error","code":"INVALID_QUERY", ...}` (`src/graph/cli-agent.ts:132`) — again an
envelope, not a throw, so read the records rather than assuming success.

- `where-defined` — where is this symbol declared?
- `who-calls` — who calls into this symbol? (its callers; upstream)
- `what-calls` — what does this symbol call? (its callees; downstream)

### `mex_impact`

| Param | Type | Default | Meaning |
|---|---|---|---|
| `target` | string | required | Symbol name, node id, or file path |
| `tokenBudget` | number | `1500` | Hard ceiling on returned JSONL tokens |
| `maxNodes` | number | `10` | Max nodes returned |
| `depth` | number | `2` | Max reverse-call depth traversed |
| `detail` | `minimal`\|`standard`\|`source` | `minimal` | Detail level |

An ambiguous target returns `{"type":"error","code":"TARGET_AMBIGUOUS","candidates":[...]}`
(`src/graph/cli-agent.ts:51`) — pick a candidate id from that list and re-run rather
than guessing.

## Reading the output: JSONL, framed

Every result is newline-delimited JSON, framed by a `meta` record **first** and a
`summary` record **last**, with `fact` / `edge` / `source` data records between
(`src/graph/agent-protocol.ts:6-7`).

- **`meta`** — `command`, `task`, `detail`, `maxNodes`, `maxOutputTokens`. Echoes what
  the query actually ran with; check it if a result surprises you.
- **`fact`** — a symbol. From `scope` it also carries `score` and `selectionReasons`
  (`src/graph/cli-agent.ts:220`) — read the reasons, they tell you *why* the node was
  considered relevant and are the fastest way to judge whether the neighborhood is the
  right one.
- **`edge`** — a structural relationship (`kind`, `source`, `target`). Only at
  `detail: "standard"` or above.
- **`source`** — `filePath` plus line ranges of actual source. Only at
  `detail: "source"`, and only when it fits the budget.
- **`summary`** — `matchedNodes`, `returnedNodes`, `returnedEdges`,
  `estimatedOutputTokens`, `maxOutputTokens`, `truncated`, `suggestedNextCommands`
  (`src/graph/agent-protocol.ts:84-93`).

Always read `summary` before acting. `matchedNodes` greater than `returnedNodes` means
the graph knew about more than it sent you.

## Budget discipline: records are DROPPED, not truncated

The budget is enforced **while emitting**, not after
(`src/graph/agent-protocol.ts:9,101-107`). Each record is *reserved* before it is
written; a record that would push past the ceiling is **not written at all**. Nothing
is cut mid-record and no JSON line is ever malformed — but a whole fact can be
silently absent.

Consequences you must act on:

- **`truncated: true` means you are missing records, not reading clipped ones.** The
  most relevant nodes are emitted first, so what you got is the best of the set — but
  do not conclude "there are only N callers" from a truncated result.
- **Never re-run the same broad query hoping for more.** It is deterministic; you will
  get the identical dropped set. Instead: narrow the `task` string, lower `detail`,
  lower `maxNodes`, or follow `summary.suggestedNextCommands`.
- **Raising `tokenBudget` is the last resort, not the first.** Two focused calls beat
  one giant response — a bigger budget spends real context on nodes you did not ask a
  question about. Prefer `detail: "minimal"` to find the right node, then one
  `mex_graph_get` on that single id at `detail: "source"`.
- A trailing `summary` is always reserved (`FRAMING_RESERVE`,
  `src/graph/agent-protocol.ts:98`), so you will never lose the truncation signal
  itself, however tight the budget.

## When the graph is the wrong tool

Fall back to plain file reads only when the graph genuinely has nothing to say:
config files, generated output, non-indexed languages, or prose. If the graph looks
merely *stale* rather than empty, rebuild it with `mex graph` — do not start reading
the tree by hand.
