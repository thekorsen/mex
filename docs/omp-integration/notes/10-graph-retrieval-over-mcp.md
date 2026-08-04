# Issue #10 — Expose graph retrieval (scope/get/query/impact) over the mex MCP server

- **Issue:** https://github.com/thekorsen/mex/issues/10
- **Milestone:** Tier 1 — native omp surfaces
- **Branch:** `omp/mcp` (lands with #11 — `docs/omp-integration/AGENT-ONBOARDING.md:243`: "#10 should land with or after #11")
- **Status:** ready for review
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

Compact retrieval — a scored symbol neighborhood under a hard token budget — is the highest-value thing mex offers an agent, and it was reachable only by shelling out to the CLI. Put the four retrieval operations behind MCP tools so an omp agent gets them as first-class, schema-validated tool calls; and, because `mex-mcp` can only reach `mex-agent` through its published entry point, make an explicit and documented decision about the public-API boundary instead of quietly reaching into internals.

## Acceptance criteria

- [ ] `mex_graph_scope`, `mex_graph_get`, `mex_graph_query`, `mex_impact` available over stdio, each accepting optional `projectRoot`.
- [ ] Token budgets are enforced and configurable per call.
- [ ] A missing graph returns a structured error, never a stack trace.
- [ ] The public-API decision is documented in `COMPATIBILITY.md`.
- [ ] A protocol-level test that drives the server over stdio (the pattern above works and needs no harness).

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| Four retrieval entry points, all exported from one module | `runImpact` `src/graph/cli-agent.ts:32`, `runGraphQuery` `:122`, `runGraphScope` `:194`, `runGraphGet` `:254` | read-only |
| All four are **synchronous and return `void`** — they *stream* JSONL by calling a `write` callback once per record, not by returning a value. Nothing to `await`, no accumulated result | signatures at `src/graph/cli-agent.ts:32-37,122,194,254`; `const write = deps.write ?? console.log` at `:38` | read-only |
| `runGraphQuery` takes `(relation, target, rootDir, deps, rawOptions)` — **relation first**, unlike the other three which take their subject first. Easy to transpose | `src/graph/cli-agent.ts:122-126` | read-only |
| The capture seam is `AgentCommandDeps = { open?, write? }` | `src/graph/cli-agent.ts:23-26` | read-only |
| **⚠️ stdout hazard — read this before editing any graph tool.** `write` defaults to `console.log` (`src/graph/cli-agent.ts:38`). On a stdio MCP server, stdout **is** the JSON-RPC 2.0 channel. A tool that calls a retrieval function without passing a capturing `write` will interleave JSONL records into the protocol stream and corrupt the session — the client sees malformed frames, not a mex error. Every tool therefore **must** pass `{ write }`; this is a correctness requirement, not a style preference. Current tools do: `packages/mex-mcp/src/tools/graph.ts:43-46` builds the capturing writer, and every call site passes it (`:78`, `:107`, `:140`, `:174`) | `src/graph/cli-agent.ts:38`; `packages/mex-mcp/src/tools/graph.ts:43-46,78,107,140,174` | read-only |
| Token budget is enforced **while emitting**, not by truncating afterward: `BudgetLedger` accounts mandatory framing via `frame()`, reserves each data record via `tryAdd()` (false once it would exceed `maxOutputTokens - reserve`), with `FRAMING_RESERVE = 140` tokens held back for the trailing `summary` | `src/graph/agent-protocol.ts:96-148` — `FRAMING_RESERVE` at `:98`, class at `:109`, `fits` at `:123-125`, `tryAdd` at `:128-135`, `droppedAny`/`overBudget` at `:137-143` | read-only |
| Defaults `{ detail: "minimal", maxNodes: 10, maxOutputTokens: 1500, maxSourceLines: 120, depth: 2, fingerprint: false }` | `src/graph/agent-protocol.ts:27-34` | read-only |
| `resolveOptions` coerces and clamps: non-finite or negative numerics fall back to the default, and `detail` accepts only `"standard"`/`"source"` (anything else → `"minimal"`). So a hostile or sloppy MCP argument cannot disable the budget | `src/graph/agent-protocol.ts:37-51` | read-only |
| `runGraphGet` force-overrides `detail: "source"` regardless of the caller's request — a `detail` argument on `mex_graph_get` would be a lie | `src/graph/cli-agent.ts:261` | read-only |
| A missing graph is **already** a structured error, so no tool needs a try/catch to avoid a stack trace: `openSession` emits `{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run \`mex graph\` first."}` when `<rootDir>/.mex/graph.db` is absent, and returns `null` so the command stops | `src/graph/cli-agent.ts:444-459` — `existsSync` at `:448`, emit at `:449` | read-only |
| Thrown errors from graph construction are funnelled into the same code by `unavailable()` | `src/graph/cli-agent.ts:511-517`, called from `:456` | read-only |
| `findConfig()` is the one thing a tool **must** still guard — it throws rather than returning a structured error, so root resolution has to be wrapped | `src/config.ts:54-90`; guarded at `packages/mex-mcp/src/tools/graph.ts:30-42`, matching the precedent in `packages/mex-mcp/src/tools/check.ts` | read-only |
| `relation` must be one of `"who-calls" \| "what-calls" \| "where-defined"`; anything else yields `{"type":"error","code":"INVALID_QUERY",…}` | `src/graph/cli-agent.ts:507-509` | read-only |
| Record stream shape: `meta` first (carrying `schemaVersion`), data records in the middle, `summary` last; `SCHEMA_VERSION = 1` | `src/graph/agent-protocol.ts:13`; `meta` emission `src/graph/cli-agent.ts:268,352` | read-only |
| `mex-mcp` depends on `mex-agent` as a workspace link, `"mex-agent": "file:../.."` | `packages/mex-mcp/package.json:22` | read-only |
| `mex-agent`'s `exports` map publishes **only** `.` → `./dist/index.js` (plus `./package.json`) — there is no subpath export at all | `package.json:11-17` | read-only |
| tsup emits exactly two bundles, `dist/cli.js` and `dist/index.js`. **There is no `dist/graph/*` on disk to import**, so a deep import fails at resolution, not just at policy | `tsup.config.ts:8-34` — `entry: { cli: "src/cli.ts" }` at `:10`, `entry: { index: "src/index.ts" }` at `:23` | read-only |
| The promoted surface now lives in `src/index.ts` with an inline comment recording the same rationale | `src/index.ts:37-52` | read-only |
| Existing tool conventions this lane matched: plain-object zod schema (not a wrapped `z.object`), `projectRoot: z.string().optional()`, `const root = projectRoot ?? process.cwd()`, guarded `findConfig`, single text content block | `packages/mex-mcp/src/tools/check.ts:5-34`, `packages/mex-mcp/src/tools/read-file.ts:7-61`; zod v3 per `packages/mex-mcp/package.json:23` | read-only |
| Registration convention: one `registerXTool(server)` call per tool in the server entry | `packages/mex-mcp/src/index.ts:20-28` | read-only |
| `mex_sync` was deferred in the 0.6.3 MCP release "until its structured return shape is settled" — the precedent for preferring an already-settled contract over a new one | `CHANGELOG.md:48` (verified: the line reads "`mex_sync` is deferred until its structured return shape is settled.") | executed (grep) |
| The `COMPATIBILITY.md` sentence the new material must not contradict: `LanguageExtractor`/`FrameworkResolver` "are source-level contribution seams, not part of the public npm API … intentionally not exported from `src/index.ts`" | `COMPATIBILITY.md:145` | read-only |
| The CLI surface is declared "**best-effort, not contract-bound**", with embedders told to consume the programmatic API rather than shell out | `COMPATIBILITY.md:173-181` | read-only |

## Commands run

### The public surface actually reaches `dist/`, and `mex-mcp` can resolve it

```
$ node -e "import('./dist/index.js')…"
runGraphScope=function runGraphGet=function runGraphQuery=function runImpact=function DEFAULT_RETRIEVAL_OPTIONS=object
{"detail":"minimal","maxNodes":10,"maxOutputTokens":1500,"maxSourceLines":120,"depth":2,"fingerprint":false}

$ cd packages/mex-mcp && node -e "import('mex-agent')…"
resolved: runGraphScope=function runGraphGet=function runGraphQuery=function runImpact=function DEFAULT_RETRIEVAL_OPTIONS=object
```

### Raw stdio drive of the built server — all 9 tools

`node packages/mex-mcp/dist/index.js` with `MEX_TELEMETRY=0`, hand-written
JSON-RPC 2.0 over newline-delimited stdin/stdout.

```
=== initialize ===
{"name":"mex-mcp","version":"0.1.0"}

=== tools/list ===
mex_check mex_graph_get mex_graph_query mex_graph_scope mex_heartbeat mex_impact mex_log mex_read_file mex_timeline
count=9

=== schemas of the 4 new tools ===
mex_graph_scope {"properties":["projectRoot","task","tokenBudget","maxNodes","detail","maxSourceLines"],"required":["task"]}
mex_graph_get   {"properties":["projectRoot","ids","maxOutputTokens","maxSourceLines"],"required":["ids"]}
mex_graph_query {"properties":["projectRoot","relation","target","tokenBudget","maxNodes","detail"],"required":["relation","target"]}
mex_impact      {"properties":["projectRoot","target","tokenBudget","maxNodes","depth","detail"],"required":["target"]}
```

The budget is honoured, and it truncates rather than overflowing — `tokenBudget:
400` returned 2 of 13 matched nodes:

```
=== mex_graph_scope (tokenBudget 400) ===
{"type":"meta","schemaVersion":1,"command":"graph scope","task":"drift check","detail":"minimal","maxNodes":10,"maxOutputTokens":400}
{"type":"fact","id":"constant:73994b5d639c2dc5e729001737644345","kind":"constant","name":"drift",…,"score":1,"selectionReasons":["exact-name-match"]}
record types: meta,fact,fact,summary
summary: {"type":"summary","matchedNodes":13,"returnedNodes":2,"returnedEdges":0,"maxOutputTokens":400,"truncated":true,…,"estimatedOutputTokens":325}

=== mex_graph_get ===
record types: meta,source,summary

=== mex_graph_query who-calls ===
record types: meta,result,result,result,result,result,result,result,result,result,result,summary

=== mex_graph_query invalid relation ===
isError=true rpcError=false
MCP error -32602: Input validation error: … "code": "invalid_enum_value", "options": ["who-calls","what-calls","where-defined"]

=== mex_impact ===
record types: meta,target,defines,caller,caller,caller,caller,summary
summary: {…,"matchedNodes":13,"returnedNodes":5,"maxOutputTokens":800,"truncated":true,"estimatedOutputTokens":688}

=== missing graph -> structured error ===   # .git + .mex/ROUTER.md, no graph.db
{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run `mex graph` first."}
has stack frame: false

=== stderr ===
(empty)
```

`stderr` empty and every stdout line parsed as JSON-RPC: the capturing `write`
is doing its job, nothing leaked onto the protocol channel.

### Live `omp` session, end to end

`.omp/mcp.json` registered the built server; `omp/17.2.4`. The harness exposes
the tool as `mcp__mex_graph_scope` (`mcp__<server>_<tool>`), and resolved the
bare MCP name without help.

```
$ omp -p --yolo --mode json "Call the MCP tool mex_graph_scope exactly once with
  projectRoot=…, task=\"drift check scoring\", tokenBudget=500. Then output the raw
  tool result verbatim and nothing else."

{"type":"meta","schemaVersion":1,"command":"graph scope","task":"drift check scoring","detail":"minimal","maxNodes":10,"maxOutputTokens":500}
{"type":"fact","id":"constant:73994b5d639c2dc5e729001737644345",…,"selectionReasons":["exact-name-match"]}
{"type":"fact","id":"file:src/drift/scoring.ts","kind":"file",…,"score":0.6,"selectionReasons":["semantic-match"]}
{"type":"summary","matchedNodes":13,"returnedNodes":3,"returnedEdges":0,"maxOutputTokens":500,"truncated":true,…,"estimatedOutputTokens":404}
```

And `mex_impact`, with the raw `tool_execution_end` event rather than the model's
prose — this is also what confirms the harness-side tool name:

```
$ omp -p --yolo --mode json "Call the MCP tool mex_impact …" | jq …
{"t":"tool_execution_start","name":"write","args":{"path":"xd://mcp__mex_impact",
 "content":"{\"projectRoot\":\"…\",\"target\":\"runDriftCheck\",\"tokenBudget\":600}"}}

{"content":[{"type":"text","text":"{\"type\":\"meta\",\"schemaVersion\":1,\"command\":\"impact\",\"detail\":\"minimal\",\"maxNodes\":10,\"maxOutputTokens\":600}
{\"type\":\"target\",\"targetType\":\"symbol\",\"value\":\"runDriftCheck\"}
{\"type\":\"defines\",\"id\":\"function:659730e0b4508b577c51042b3227fbfb\",…,\"filePath\":\"src/drift/index.ts\",\"lineStart\":65,\"lineEnd\":198,\"callerCount\":11,\"calleeCount\":18,…}
{\"type\":\"caller\",…"}]}
```

Note the `defines` record's node id `function:659730e0b4508b577c51042b3227fbfb`
is the same id the ledger records as path-portable across checkouts
(`docs/omp-integration/AGENT-ONBOARDING.md:120`).

### Lane gates, run once at the end

```
$ npm run build && npm run build --workspace mex-mcp
ESM ⚡️ Build success in 76ms
DTS ⚡️ Build success in 1318ms
[copy-graph-assets] copied schema.sql + 5 grammar wasm file(s) to dist/
ESM dist/index.js     13.59 KB          # mex-mcp, was 7.42 KB before the 4 tools

$ npx vitest run
 Test Files  39 passed (39)
      Tests  380 passed (380)

$ npx tsc --noEmit
(no output, exit 0)

$ MEX_TELEMETRY=0 node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)     # baseline, unchanged
```

---

## Decisions

### Decision: how `mex-mcp` reaches graph retrieval — promote a narrow public surface, or reach into internals, or shell out

- **Options considered:**
  1. **Promote a narrow, named graph-retrieval surface into `src/index.ts`** — the four operations plus the types needed to call them — and accept the resulting compatibility obligation.
  2. **Have `mex-mcp` import `src/graph/**` internals directly**, on the grounds that it is a workspace-linked sibling in the same repo rather than a third-party embedder.
  3. **Shell out to the `mex` CLI** from the server and parse its stdout, keeping the public API untouched.
- **Chosen:** (1). `src/index.ts:43-52` now exports `runGraphScope`, `runGraphGet`, `runGraphQuery`, `runImpact`, the type `AgentCommandDeps`, `DEFAULT_OPTIONS` aliased as `DEFAULT_RETRIEVAL_OPTIONS`, and the types `AgentOptions` and `DetailLevel`.
- **Why:** **The module graph forces it — this is not a preference.** `mex-mcp` is a separate package that reaches `mex-agent` only through the dependency `"mex-agent": "file:../.."` (`packages/mex-mcp/package.json:22`), and `mex-agent`'s `exports` map exposes exactly one entry point, `.` → `./dist/index.js` (`package.json:11-17`). Worse for option (2) than policy: tsup emits only `dist/cli.js` and `dist/index.js` (`tsup.config.ts:8-34`), so **no `dist/graph/*` file exists on disk at all**. Option (2) therefore cannot be implemented without *also* widening the `exports` map and adding graph entry points to the tsup config — at which point it *is* option (1), only with an unnamed, undocumented, larger surface and no stated boundary. There is no version of "reach into internals" that is cheaper than promoting a surface; there is only a version that is less honest about it.

  Option (3) was rejected on three counts: it reintroduces a process spawn per call (the 0.6.3 MCP release's stated advantage was "imports the `mex-agent` public API directly (no subprocess)", `CHANGELOG.md:48`); it converts typed, structured failures — `GRAPH_UNAVAILABLE` (`src/graph/cli-agent.ts:449`), `INVALID_QUERY` (`:507-509`), `TARGET_NOT_FOUND` (`:46`) — into exit codes and text to re-parse; and it would build the fork's highest-value integration path on a surface `COMPATIBILITY.md:173-181` explicitly declares "best-effort, not contract-bound". Depending on a surface whose own documentation disclaims stability is the wrong foundation for the thing we most want to be stable.
- **What this rules out:** The promoted names now carry a compatibility obligation under the semver policy at `COMPATIBILITY.md:60-81`, where renaming or removing a public export, or changing required parameters, is a **major** change. Concretely, what is now **IN** the contract:
  - the four operations `runGraphScope` / `runGraphGet` / `runGraphQuery` / `runImpact` and their parameter order (including `runGraphQuery`'s relation-first asymmetry, `src/graph/cli-agent.ts:122-126`);
  - `AgentCommandDeps.write` as the stream-capture seam (`src/graph/cli-agent.ts:23-26`) — the mechanism an embedder needs to use these off-process at all;
  - the `AgentOptions` field names (`src/graph/agent-protocol.ts:17-25`);
  - the emitted record `type` values (`meta`, `fact`, `edge`, `source`, `result`, `target`, `defines`, `caller`, `grounding`, `error`, `summary`) and the `schemaVersion` field, `SCHEMA_VERSION = 1` (`src/graph/agent-protocol.ts:13`).

  What remains explicitly **OUT**: everything else under `src/graph/**` — the engine, tree-sitter extraction, resolution, the MinHash reconcile engine, `schema.sql`, and the `LanguageExtractor` / `FrameworkResolver` seams that `COMPATIBILITY.md:145` already declares non-public. The export surface deliberately names **operations, not implementations**, which is what makes that line still true after this change: nothing that constructs or shapes a graph became public, only four ways to ask one a question.

  It also costs future freedom to change record shapes silently: a new required field in `fact` is now a contract change, not an internal refactor.
- **Revisit if:** upstream `mex-memory/mex` promotes its own graph surface under different names — this fork should then converge on upstream's names rather than keep a parallel vocabulary, since `docs/omp-integration/AGENT-ONBOARDING.md:21` requires changes stay rebasable onto upstream. Also revisit if `SCHEMA_VERSION` needs to move to 2, which under this decision becomes a documented breaking change rather than a quiet bump.

### Decision: name the exports after operations, and alias `DEFAULT_OPTIONS`

- **Options considered:**
  1. Export the operation functions under their existing names (`runGraphScope`, …) and re-export `DEFAULT_OPTIONS` under a qualified alias.
  2. Export a factory/engine-shaped surface (`createGraphEngine`, a session object) that callers drive themselves.
  3. Re-export `DEFAULT_OPTIONS` under its own bare name.
- **Chosen:** (1) — `runGraphScope` / `runGraphGet` / `runGraphQuery` / `runImpact`, and `DEFAULT_OPTIONS as DEFAULT_RETRIEVAL_OPTIONS` (`src/index.ts:43-50`).
- **Why:** Operation-named exports are what makes the "operations, not implementations" boundary above enforceable in practice. Exporting `createGraphEngine` (2) would publish the *shape of the graph subsystem* — sessions, lifetimes, `close()` semantics — and every internal refactor would then be a public change; it also drags `src/graph/**` internals into the contract precisely as this decision refuses to do. On (3): a bare `DEFAULT_OPTIONS` sitting in a package's public namespace says nothing about *what* it configures, and would collide conceptually with the config/drift/heartbeat defaults already exported beside it (`DEFAULT_SCAFFOLD_PATTERNS`, `DEFAULT_STALENESS_THRESHOLDS`, `DEFAULT_HEARTBEAT_PATTERNS`, `COMPATIBILITY.md:32-34`). `DEFAULT_RETRIEVAL_OPTIONS` matches that existing `DEFAULT_*`-with-a-domain convention.
- **What this rules out:** Embedders cannot hold a graph session open across several retrieval calls — each call opens and closes its own (`src/graph/cli-agent.ts:444-459`). For an MCP tool call that is the right granularity; for a hypothetical batch consumer it is repeated open cost.
- **Revisit if:** a caller genuinely needs many retrievals against one open session (a bulk grounding pass, a server-side index warm). That is a new, deliberately-designed export, not a widening of these four.

### Decision: return raw JSONL as one text content block

- **Options considered:**
  1. Return the JSONL stream verbatim as a single text content block.
  2. Define a structured JSON return shape for the MCP tools (parsed records, typed fields).
- **Chosen:** (1).
- **Why:** The JSONL envelope is already a contract agents know from the CLI, so one parser serves both paths and MCP adds no new vocabulary. Option (2) creates a **second contract to maintain** beside the CLI's, and there is direct precedent for treating that as a blocker rather than a nicety: `mex_sync` was left out of the 0.6.3 MCP release specifically "until its structured return shape is settled" (`CHANGELOG.md:48`). Shipping an unsettled second shape for the highest-traffic tools would repeat the mistake that deferral avoided.
- **What this rules out:** MCP clients get no schema for the *result* (only for the arguments), so a client that wants typed results parses JSONL itself. It also means the token budget the ledger enforces is the real ceiling on the content block — good — but that the block is opaque to any client-side result validation.
- **Revisit if:** a structured shape is settled for `mex_sync`; the same shape should then be considered for retrieval, once, for both surfaces together.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Import `src/graph/**` from `mex-mcp` as a workspace-linked sibling (option (b) in the ticket's framing) | **Physically impossible as stated.** `mex-mcp` reaches `mex-agent` only via `"mex-agent": "file:../.."` (`packages/mex-mcp/package.json:22`), the `exports` map publishes only `.` → `./dist/index.js` (`package.json:11-17`), and tsup emits only `dist/cli.js` + `dist/index.js` (`tsup.config.ts:8-34`) — there is no `dist/graph/*` file to resolve. Making it work requires widening the `exports` map *and* adding tsup entries, i.e. doing option (a) with a larger, unnamed surface. |
| Deep import `mex-agent/dist/graph/cli-agent.js` | Same resolution failure, and independently forbidden: `COMPATIBILITY.md:55-56` states deep imports are blocked by the `exports` field and "may break without notice". |
| Shell out to the `mex` CLI from the MCP server | A process spawn per tool call, undoing the 0.6.3 design point that the server "imports the `mex-agent` public API directly (no subprocess)" (`CHANGELOG.md:48`); typed error codes (`GRAPH_UNAVAILABLE` `src/graph/cli-agent.ts:449`, `INVALID_QUERY` `:507-509`, `TARGET_NOT_FOUND` `:46`) collapse into exit codes plus text; and `COMPATIBILITY.md:173-181` declares the CLI surface "best-effort, not contract-bound", so the fork's highest-value integration path would rest on explicitly non-contractual ground. |
| Define a structured JSON MCP return shape instead of raw JSONL | Creates a second contract to maintain beside the CLI's JSONL envelope. `CHANGELOG.md:48` records that `mex_sync` was deferred from the MCP server for exactly this reason — "`mex_sync` is deferred until its structured return shape is settled." (citation verified against the file). Not worth repeating for the four highest-traffic tools. |
| Let the retrieval functions write with their default `console.log` and capture process stdout | Would corrupt the JSON-RPC stream: on a stdio MCP server stdout *is* the protocol channel, and `write` defaults to `console.log` (`src/graph/cli-agent.ts:38`). The only correct route is passing an explicit capturing `write` per call (`packages/mex-mcp/src/tools/graph.ts:34`). |
| Wrap each retrieval call in try/catch to turn a missing graph into a friendly error | Unnecessary and misleading: the missing-graph path is already structural — `openSession` emits `GRAPH_UNAVAILABLE` and returns `null` (`src/graph/cli-agent.ts:444-459`), and thrown errors are funnelled to the same code by `unavailable()` (`:511-517`). The one place a guard *is* required is `findConfig()`, which throws (`src/config.ts:54-90`). |
| Expose a `detail` argument on `mex_graph_get` | `runGraphGet` force-overrides `detail: "source"` (`src/graph/cli-agent.ts:261`), so the argument would be accepted and silently ignored. |

---

## Changes made

| File | Change |
|---|---|
| `src/index.ts:37-52` | Promoted the graph-retrieval surface: `runGraphScope`, `runGraphGet`, `runGraphQuery`, `runImpact`, `type AgentCommandDeps`, `DEFAULT_OPTIONS as DEFAULT_RETRIEVAL_OPTIONS`, `type AgentOptions`, `type DetailLevel`, with an inline comment recording the `exports`-map rationale. |
| `packages/mex-mcp/src/tools/graph.ts` | New file: the four tools. `withGraphContent` (`:25-48`) resolves the root (`:29`), guards `findConfig` into a structured error (`:30-42`), and captures the JSONL stream instead of letting it reach stdout (`:43-46`). Tools at `:50`, `:84`, `:113`, `:146`; every retrieval call passes `{ write }` (`:78`, `:107`, `:140`, `:174`). |
| `packages/mex-mcp/src/index.ts:8-13,25-28` | Registered `registerGraphScopeTool`, `registerGraphGetTool`, `registerGraphQueryTool`, `registerImpactTool` beside the original five. |
| `COMPATIBILITY.md` | Documented the promoted exports and the precise boundary — the four operations plus the JSONL record contract and `schemaVersion` are public; `src/graph/**` internals are not — placed beside the existing `LanguageExtractor`/`FrameworkResolver` sentence (`COMPATIBILITY.md:145`) rather than as a duplicate section. Satisfies acceptance criterion 4. |
| `docs/omp-integration/AGENT-ONBOARDING.md` | §"The public API boundary" records the decision that was made (it previously said #10 "has to make a deliberate call") and lists the new exports; §4.2 gains the `exports`-map/tsup constraint and the `deps.write` stdout hazard as verified-by-source-reading facts. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/mcp-graph-tools.test.ts` | Protocol level: spawns `packages/mex-mcp/dist/index.js` and speaks raw stdio JSON-RPC 2.0 — acceptance criterion 5, no harness needed. Asserts the four graph tools are advertised alongside the original five (criterion 1), that each takes an **optional** `projectRoot` (criterion 1 and the cross-lane explicit-root contract), that `mex_graph_scope` advertises `tokenBudget` (criterion 2, configurable per call), and that a scaffold with no `graph.db` yields a structured `GRAPH_UNAVAILABLE` envelope rather than a stack trace (criterion 3). Self-skips when the gitignored `dist` build is absent. |
| `test/mcp-project-isolation.test.ts` | #11's cross-root isolation, which this ticket depends on; see [`11-mcp-process-global-state.md`](./11-mcp-process-global-state.md). |

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (output pasted above) — raw stdio drive of all 9 tools **and** a live `omp -p` session
- [x] `npm test` passes — 380 passed (39 files)
- [x] `npm run build` passes — root and `mex-mcp` workspace; `dist/index.js` 7.42 KB → 13.59 KB
- [x] `mex check` did not regress from `94/100` — still `94/100 (2 warnings)`
- [x] Docs updated where behavior changed — `COMPATIBILITY.md` public surface + graph-retrieval section, `AGENT-ONBOARDING.md` §4.2
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2
- [x] Worktrees / scratch dirs cleaned up — no worktrees created; `/tmp` probes and the scratch `.omp/mcp.json` removed

## Follow-ups

- [x] **Done in this lane, not deferred.** `test/public-api.test.ts` is the declared gate on the public surface (`COMPATIBILITY.md:42-44`: "Any change that breaks that test is a breaking change"), so leaving the promotion undefended there would have meant a public export no gate covers. It now asserts the four promoted functions and `DEFAULT_RETRIEVAL_OPTIONS` (bounded budget, `detail === "minimal"`). The three promoted types (`AgentCommandDeps`, `AgentOptions`, `DetailLevel`) are erased at runtime and remain guarded only by `tsc`; `AgentOptions` is exercised as a type annotation in that test so a removal breaks the typecheck.
- [ ] The graph tools have no path sandbox equivalent to `mex_read_file`'s `scaffoldRoot` containment (`packages/mex-mcp/src/tools/read-file.ts:35-41`, cited as precedent — at its pre-existing line numbers — by `FLEET-TICKETS/10.md:50`). Retrieval reads only `<projectRoot>/.mex/graph.db` and emits `filePath` values already recorded in that graph, so there is no new read primitive here — but the `projectRoot` argument itself is unconstrained, exactly as it is for the existing five tools. `[INFERENCE]` that this needs no further containment; settled by deciding whether `projectRoot` should be allowlisted server-wide, which is a question for all nine tools, not these four.
- [ ] Retrieval fails from any subdirectory (issue #3, `docs/omp-integration/AGENT-ONBOARDING.md:119`). MCP callers pass an absolute `projectRoot` so they dodge it, but the underlying resolution bug is untouched by this ticket.
- [ ] `CHANGELOG.md` needs an entry for the promoted exports (minor, "adding a new export", `COMPATIBILITY.md:66`) and the four new tools.

## Handoff

The decision this ticket exists to make is written above and is the deliverable; the implementation follows it and the boundary is recorded in `COMPATIBILITY.md`. The one thing a fresh session should not have to rediscover is in Findings and repeated here: **the retrieval functions default their `write` to `console.log`, and on a stdio MCP server stdout is the JSON-RPC channel** — any new graph tool must pass a capturing `write` or it will silently corrupt the protocol stream. Gate output and the `mex check` baseline come from the parent orchestrator, which runs the gates once for the whole lane.
