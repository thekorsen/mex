# Issue #16 — Build the omp extension module: routed context injection, graph tools, commands, supervised watching

- **Issue:** https://github.com/thekorsen/mex/issues/16
- **Milestone:** Tier 2 — omp extension module
- **Branch:** `omp/ext`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

> **Session history.** This lane took three sessions. The first built the package and was
> killed mid-flight by an expired credential; the parent preserved its work as an ungated
> `wip(ext)` commit with no working note, so its design rationale was lost. The second was
> respawned onto the wrong model and stopped on a provider limit after two audit
> subagents, landing nothing. This note is written by the third session: it reconstructs
> the inherited rationale from the code, then records what that session **changed and
> why** — which turned out to be the central design premise.

---

## Restated goal

Ship one omp extension module that owns the whole mex integration: pick which `.mex/` wiki
pages a turn actually needs and inject only those under a token budget, expose code graph
retrieval as first-class tools, add the `/mex-*` commands a Markdown prompt cannot
implement, and watch for drift on a supervised timer — packaged so installing it is one
step. Crucially it must own only what *no* declarative artifact can do, because mex
already ships working `.omp/` rules, skills and commands.

## Acceptance criteria

- [x] Extension loads in a live omp session; `session_start` confirms the mex scaffold was found.
- [x] Graph tools callable by the model, budget-enforced, with the JSONL envelope or a documented replacement.
- [x] Context injection demonstrably routed — a session working on task A does not receive task B's pages. Show a token-count comparison against dumping the whole wiki.
- [x] Background drift check runs on `ctx.setInterval` and is verified not to crash the session when it throws (test this deliberately by making it throw).
- [x] Packaged so `omp install <pkg>` (or `-e <path>`) is the entire install.

---

## The finding that reshaped the ticket

**omp runs on Bun. Bun has no `node:sqlite`. mex's code graph is `node:sqlite`
(`src/graph/db/sqlite.ts:60`). So the graph cannot be read in-process inside an omp
session — at all.**

This invalidated the inherited WIP's central premise: 480 lines of `tools.ts` calling
`runGraphScope`/`runGraphGet`/`runGraphQuery`/`runImpact` as direct function calls, headed
by a comment arguing that the whole point was to remove the subprocess `packages/mex-mcp`
needs. That argument is exactly backwards.

It was found by running the thing, not by reading it. The package typechecked clean and
its 63 unit tests passed against fakes, and neither could see this, because both run under
`node`. Only a live `omp -p` session exposes it.

Reproduction, three independent ways:

```
$ MEX_TELEMETRY=0 omp -p --no-tools -e ./.probe/v6.ts "say X"
V6_FULL: {"type":"error","code":"GRAPH_UNAVAILABLE","message":"mex code-graph requires
the built-in node:sqlite module (Node.js 22.5+).\nRun mex on Node 22.5 or newer.
Underlying error: ResolveMessage: No such built-in module: node:sqlite"}
V6_SQLITE_FAIL ResolveMessage: No such built-in module: node:sqlite
V6_DRIFT_SCORE 100 files 14          # <- non-graph mex API works fine in-process

$ bun -e 'try{await import("node:sqlite");console.log("A_OK")}catch(e){console.log("A_FAIL")}'
A_FAIL
$ bun -e 'const {createRequire}=await import("node:module");createRequire(import.meta.url)("node:sqlite")'
B_FAIL

$ node -e 'const s=require("node:sqlite"); console.log(Object.keys(s).join(","))'
DatabaseSync,StatementSync,Session,constants,backup
```

And the decisive contrast, both halves from *inside one* live omp session — same command,
two interpreters:

```
V7_EXECPATH /opt/homebrew/Cellar/bun/1.3.14/bin/bun
V7_STATUS 0 lines 1
V7_FIRST {"type":"error","code":"GRAPH_UNAVAILABLE","message":"mex code-graph requires the built-in node:sqlite module …
V7_NODE_STATUS 0 lines 5
V7_NODE_FIRST {"type":"meta","schemaVersion":1,"command":"graph scope","task":"drift check","detail":"minimal","maxNodes":3,…
```

`process.execPath` under omp is the Bun binary; `node` is separately on `PATH` (`v26.0.0`).
That asymmetry is the entire fix: retrieval spawns `node`, never `process.execPath`.

This is a harness-level constraint on *any* future in-process mex work under omp, not just
this ticket's. It belongs in the evidence ledger §4.1.

## The second blocker: a static `import` of `mex-agent` prevents the extension loading

Independent of SQLite, the inherited package could not load at all:

```
$ MEX_TELEMETRY=0 omp -p --no-tools -e ./packages/omp-mex "…"
Failed to load extension …/packages/omp-mex/src/index.ts: Failed to load extension:
Export named 'FOLDER' not found in module …/node_modules/@kwsites/file-exists/dist/index.js
```

`FOLDER` has nothing to do with mex. omp imports extension entries through
`loadLegacyPiModule()`, which installs a **scoped Bun `onLoad` hook** to rewrite legacy pi
specifiers (`omp://extension-loading.md` §"Module import and factory contract"). That hook
returns source text for the modules it sees, so transitive **CommonJS** dependencies get
re-parsed as ESM and their `exports.X = …` assignments stop being visible as named
exports. `mex-agent` → `simple-git` → `import { exists, FOLDER } from "@kwsites/file-exists"`
(`node_modules/simple-git/dist/esm/index.js:70`), which is CJS
(`node_modules/@kwsites/file-exists/dist/src/index.js:50` is `exports.FOLDER = 2`).

Confirmed as the mechanism, not a coincidence, by reproducing it **outside omp** with an
equivalent `Bun.plugin` `onLoad` hook — which fails identically one dependency deeper:

```
$ bun run /tmp/plugin-test.ts
WITH_PLUGIN_FAIL Export named 'createDeferred' not found in module …/@kwsites/promise-deferred@1.1.1/dist/index.js
```

Plain Bun with no hook installed imports the same module fine (`OK 19`). So the trigger is
the loader hook, and the fix is to import **after** load, from inside a handler:

| Import form | Result under omp |
|---|---|
| static `import { findConfig } from "mex-agent"` | **fails at load** |
| `await import("mex-agent")` in a handler (bare specifier) | **fails** — `FOLDER` |
| `await import(import.meta.resolve("mex-agent"))` in a handler | **works** — 19 exports |
| `await import("/abs/path/dist/index.js")` in a handler | works, but see below |
| `createRequire(import.meta.url)("mex-agent")` | fails — `Cannot find package` |

Both `_FAIL` rows were re-run to confirm determinism. The absolute-path form is a trap: it
works alone, but once anything in the same session imports a bare `"simple-git"` the
rewriting kicks in and the *absolute* import fails too (`V4_ABS_FAIL`, reproduced twice).
Only `import.meta.resolve` is reliable, which is what `mex.ts:loadMex()` uses.

`import.meta.resolve("mex-agent")` from inside the worktree gives
`file:///…/wt/ext/dist/index.js`. A probe placed in `/tmp` instead resolved to
`~/.bun/install/cache/mex-agent@0.7.0/dist/index.js` — Bun silently auto-installed the
**published** 0.7.0 from the registry, which lacks the four `runGraph*` exports #10 added.
That wasted a bisection pass; probes must live inside the worktree.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| Bun has no `node:sqlite`; the graph is unreadable in-process under omp | live session output above; `bun -e` ×2; `node -e` contrast | executed |
| `node` is on `PATH` inside an omp session; `process.execPath` is Bun | `V13_NODE_ON_PATH 0 v26.0.0`, `V13_EXECPATH …/bun` | executed |
| A static `import` of `mex-agent` fails at extension load | `Failed to load extension … 'FOLDER'` | executed |
| Cause is omp's scoped Bun `onLoad` hook breaking transitive CJS named exports | reproduced outside omp with `Bun.plugin`; `omp://extension-loading.md`; `simple-git/dist/esm/index.js:70` | executed + read |
| `import(import.meta.resolve(...))` inside a handler is the reliable form | probe matrix above | executed |
| Non-graph mex API works in-process under Bun | `V6_DRIFT_SCORE 100 files 14` | executed |
| `context` handlers may be async and ARE awaited; returned messages reach the provider | `V12_ASYNC_CTX_RAN` + `V12_BPR_HAS_ASYNC_CANARY true` | executed |
| Sibling `skills/` of an extension package ARE discovered | `V9_PROBE_CMDS skill:probe-skill` | executed |
| Sibling `commands/*.md` of an extension package are **NOT** registered | `V9_CMD_HAS_PROBE false`; full `V10_ALL_CMDS` list shows `skill:probe-skill` but no `probe-cmd` | executed |
| A bundled `mcp.json` / `.mcp.json` registers **no** MCP tools | `V11_MEX_MCP_TOOLS (none)`; model answered `NONE` | executed |
| `pi.registerTool` / `registerCommand` work; a live model called a registered tool | `probe-registered` in `V10_ALL_CMDS`; model returned `ZQ7TOOLFACT` | executed |
| Retrieval CLI exits **0** and writes its error envelope to stdout for ordinary failures | `GRAPH_UNAVAILABLE` and `NODE_NOT_FOUND` both at exit 0 | executed |
| Budget enforced while emitting; records dropped, not clipped | `--max-output-tokens 200` → `"returnedNodes":0,"truncated":true` | executed |
| `--root` must precede the `graph` subcommand; flags must precede `--` | see Decision 3 | executed |
| Root `tsconfig.json` has `include: ["src"]`, so **no test file is ever typechecked** | `tsconfig.json:22`; `.github/workflows/ci.yml:22-26` says the same | read |

### The gap that hid a real bug

The inherited WIP had a dropped import: `test/omp-ext-watch.test.ts` used
`resolveWatchIntervalMs` without importing it. Nothing caught it — `tsup` strips types
without checking them, and the root `tsconfig.json` includes only `src`, so **test files
are typechecked by nothing**. It surfaced only when `vitest` executed that line
(`ReferenceError: resolveWatchIntervalMs is not defined`). The parent had warned that a
dropped import already slipped through this exact gap once before in this project; it had
slipped through again, in the very commit handed to me. This is the concrete argument for
why `typecheck` is not optional and why `tsup` passing proves nothing.

---

## Decisions

### Decision 1: graph retrieval spawns `node`; `mex-mcp` is the documented high-volume channel

- **Options considered:**
  1. **In-process function calls.** What the WIP assumed. *Impossible* — no `node:sqlite` in Bun.
  2. **Port mex's storage layer to `bun:sqlite`.** Bun does ship `bun:sqlite`, but with a
     different API (`Database`, not `DatabaseSync`/`StatementSync`).
  3. **Drop the tools entirely**; declare `packages/mex-mcp` the retrieval channel and let
     the extension own only injection, commands and watching.
  4. **Subprocess-backed tools** — `spawnSync("node", [dist/cli.js, "graph", …])`, JSONL
     passed through verbatim.
  5. **Subprocess tools + documented MCP preference.** ← chosen, ruled by the parent.
- **Chosen:** 5.
- **Why:** the ticket asks for "the JSONL envelope **or a documented replacement**", and a
  subprocess satisfies it literally — same envelope, same budget enforcement, same schemas,
  because it is the same code. Keeping the tools in-registry means a consumer installs one
  unit with no MCP server to configure and no stdio channel to corrupt, and it keeps the
  shipped `mex-graph-retrieval` skill coherent (a skill documenting four tools that do not
  exist is worse than no skill). Documenting `mex-mcp` alongside is honest about the cost:
  one persistent server amortises startup across every call in a session; a per-call spawn
  does not.
  The ticket's Sequencing line — "an extension that shells out to the mex binary for every
  retrieval is strictly worse than the MCP server that already works" — was written before
  #10 landed, when MCP exposure was hypothetical. The parent confirmed it is **stale, not
  authoritative**: a ticket premise invalidated by evidence loses to the evidence.
- **Cost, measured, not estimated:** `node dist/cli.js graph scope "drift check"
  --max-nodes 5` = **~340 ms** (five consecutive runs: 0.35 / 0.34 / 0.34 / 0.33 / 0.34 s).
  The same operation in-process under `node` = **97 ms**. So the spawn costs ~240 ms,
  dominated by Node startup plus loading `dist/cli.js`. The comparison that matters is not
  against the in-process number — that number is unavailable under omp at any price — but
  against a full graph build (~7 s) or against the agent reading files by hand. Retrieval
  is not in a hot loop: a model issues a few calls per turn.
- **Why not 2 — rejected explicitly so nobody revisits it:** it would fork mex's storage
  layer across two incompatible SQLite APIs to serve one harness. mex is provider-neutral
  by design; that maintenance cost is permanent and unbounded, and the benefit is one
  harness's retrieval latency. This is precisely the kind of abstraction that looks clever
  and costs forever. **Do not do this.**
- **Why not 3:** the strongest YAGNI reading, and a real contender — but it deletes working
  tested code and strands the skill. Option 5 keeps the capability while telling the truth
  about when to prefer MCP.
- **What this rules out:** any claim that this extension removes a subprocess from the
  retrieval path. It does not, and cannot. `spawn.ts`'s header says so.
- **Revisit if:** Bun ships `node:sqlite` (then delete `spawn.ts` and call the four
  functions directly), or omp gains a Node-runtime extension host.

### Decision 2: `mex-agent` is loaded at runtime through `import.meta.resolve`, never statically

- **Options considered:**
  1. Static `import` — fails at load; the whole extension silently does nothing.
  2. Bundle the extension with tsup and `noExternal: [/.*/]` — **works**; produced a
     1.10 MB self-contained ESM bundle that loaded cleanly under omp (`BUNDLE_OK`).
  3. `createRequire(import.meta.url)("mex-agent")` — fails, `Cannot find package`.
  4. Runtime `import(import.meta.resolve("mex-agent"))` from inside a handler. ← chosen
- **Chosen:** 4, via a single `loadMex()` in `mex.ts` that caches the promise per process.
- **Why:** three lines, and it preserves the package's no-build-step property, which is a
  real feature — omp executes `.ts` directly and appends an `?mtime` cache-buster, so an
  edit takes effect with no rebuild. Option 2 works but reintroduces a build step, a 1.1 MB
  artifact, and a second bundler config to keep in sync with the root one, to solve a
  problem three lines solve.
- **What this rules out:** static type-checking against mex's real exports at the import
  site. `MexModule` in `mex.ts` is a hand-written structural mirror of the subset actually
  called, so a rename in `src/index.ts` would not be caught by `tsc` here. That is the same
  trade `omp-api.ts` already makes for the harness, for the same reason, and it is why
  acceptance for this package is a live session rather than a typecheck.
- **Note:** `MexModule` deliberately does **not** declare the four `runGraph*` functions,
  though they exist on the real module. Naming them would advertise a capability that
  cannot work under Bun and invite a future reader to "simplify" `spawn.ts` into a direct
  call.

### Decision 3: argv is built flags-first, then `--`, then positionals

Established by executing the built CLI, not inferred:

- `--root` must precede the `graph` **subcommand**: `graph --root <dir> scope …`. A `--root`
  declared on the subcommand is a dead flag (ledger §4.2, `src/cli.ts:206`). Top-level
  `impact` has no parent and takes its own `--root`.
- A model-supplied task string beginning with `-` is otherwise parsed as an option:
  `graph … scope "-oh no"` → `error: unknown option '-oh no'`.
- The naive fix is wrong in a way that is easy to miss. `scope -- "-oh no" --max-nodes 1`
  swallows the flags into the task text (`"task":"-oh no --max-nodes 1"`, `maxNodes:10`).
  Flags **before** `--` is the form that works: `scope --max-nodes 1 -- "-oh no"` →
  `"task":"-oh no"`, `maxNodes:1`.

Since the task string comes from the model, this is an injection-shaped hazard, not a
cosmetic one.

### Decision 4: what stays declarative (inherited, verified, kept)

The WIP's central YAGNI judgement was right and is preserved: omp dedups artifacts
**first-wins by name**, so shipping a code twin of anything `mex setup` already projects
into `.omp/` would add zero capability and create a silent load-order race. The extension
registers only what no Markdown file can do — a `context` handler, tools, a timer, and a
`tool_result` observer — and ships only artifacts no template claims. `DECLARATIVE_COMMANDS`
in `commands.ts` encodes the three command names deliberately *not* registered here, so the
decision is assertable from a test rather than a comment.

### Decision 5: marketplace distribution — and the packaging fact that actually mattered

Ledger §4.3 carried a standing conflict: `omp://marketplace.md` says marketplace installs
load `omp.extensions` via symlink + `omp-plugins.lock.json`, while
`omp://skills/authoring-extensions.md:84` says they do not. The WIP shipped a
`.omp-plugin/marketplace.json` plus an `[INFERENCE]` favouring the first reading.

I did not need to resolve that conflict, because this package does not depend on
marketplace distribution: the four install paths it documents — `-e`, `extensions:`,
`omp plugin link`, `omp plugin install <npm-spec>` — are unambiguously documented to load
`omp.extensions`, and `-e` is **verified working live**. The conflict stays open in §4.3.

What I did verify is the part that actually bears on packaging, and one half is bad news:

- sibling `skills/` **are** discovered from a loaded extension package (`skill:probe-skill`
  appeared in `pi.getCommands()`);
- sibling `commands/*.md` are **not** (`probe-cmd` absent from the full command list);
- a bundled `mcp.json`/`.mcp.json` registers **nothing**.

So `commands/mex-graph-impact.md` does **not** reach a session by riding along with the
extension, contrary to what the inherited README asserted. Rather than delete a good
prompt, `/mex-graph-impact` is now **registered by the extension itself**, which is both
verified to work and the only channel that does.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| In-process graph retrieval (the entire inherited `tools.ts` premise) | Bun has no `node:sqlite`. Not fixable in this lane, or worth fixing anywhere. |
| Porting mex storage to `bun:sqlite` | Different API (`Database` vs `DatabaseSync`); forks the storage layer across two SQLite surfaces to serve one harness. Rejected on the parent's ruling and on YAGNI. **Do not revisit.** |
| Static `import … from "mex-agent"` anywhere in `src/**` | Extension fails to LOAD: `Export named 'FOLDER' not found`. |
| `await import("mex-agent")` with a bare specifier, inside a handler | Same `FOLDER` failure — the specifier, not the timing, triggers the rewrite. |
| `await import("/abs/.../dist/index.js")` | Works *in isolation*; fails as soon as anything else in the session imports a bare CJS-backed specifier. A latent, order-dependent trap — worse than an outright failure. |
| `createRequire(import.meta.url)("mex-agent")` | `Cannot find package 'mex-agent'` under omp's loader. |
| Bundling the extension with tsup `noExternal: [/.*/]` | Actually **works** (1.10 MB, loaded fine). Rejected only because `loadMex()` is three lines and keeps the no-build-step property. Recorded because it is the fallback if `import.meta.resolve` ever breaks. |
| Running probe extensions from `/tmp` | Bun auto-installed the **published** `mex-agent@0.7.0` from its registry cache instead of resolving the worktree, so `runGraphScope` looked "missing" for the wrong reason. Probes must live inside the worktree. |
| Asking the model to echo "a 10-character marker" | The canary was 11 characters, so a *successful* injection was reported as `NONE`. Two false negatives were spent here. Canary probes must ask for a distinctive **prefix**, never a length. |
| Trusting `--no-tools` + a model's "NONE" as proof of absence | Not sufficient alone. `before_provider_request` is ground truth: it showed the canary present in the outgoing payload while the model's prose denied it. Instrument the wire, then corroborate with the model. |
| A bundled `mcp.json` as a distribution channel for the MCP server | Registers no tools. Consumers must configure `.omp/mcp.json` themselves. |
| Sibling `commands/*.md` as the channel for `/mex-graph-impact` | Not discovered from an extension package. Registered in code instead. |

---

## Changes made

| File | Change |
|---|---|
| `packages/omp-mex/src/mex.ts` | Rewritten. `loadMex()` runtime loader + `MexModule` structural mirror; `resolveScaffold` now async; dropped `captureJsonl` (in-process-only); header documents both Bun constraints. |
| `packages/omp-mex/src/spawn.ts` | **New.** Subprocess retrieval core: `resolveMexCli`, `runRetrievalCli`, `buildArgs`, `NODE_BIN`. Never throws; timeout + output caps; forces `MEX_TELEMETRY=0`. |
| `packages/omp-mex/src/tools.ts` | Four tools converted from in-process calls to a `node` subprocess; JSONL verbatim; new unbuilt-CLI and spawn-failure paths; header rationale corrected. |
| `packages/omp-mex/src/router.ts` | `buildWikiIndex` takes `parseFrontmatter` as an injected dependency (stays pure). Scoring, budget, tie-break and render output unchanged. |
| `packages/omp-mex/src/inject.ts` | `context` handler now async; awaits loader and resolver. All guards kept. |
| `packages/omp-mex/src/commands.ts` | Runtime-loads mex; async resolver; registers `/mex-graph-impact`. |
| `packages/omp-mex/src/watch.ts` | Runtime-loads mex; async `session_start`. Timer contract untouched. |
| `packages/omp-mex/src/nudge.ts` | Async resolver; still returns `undefined` always. |
| `packages/omp-mex/src/index.ts` | Resolver caches the promise per cwd; header rationale corrected. |
| `packages/omp-mex/package.json` | `typecheck` script (CI runs `--workspaces`, **not** `--if-present`). |
| `package-lock.json` | Regenerated with `npm install --package-lock-only`; records the new workspace only. |
| `test/omp-ext-watch.test.ts` | Restored the dropped `resolveWatchIntervalMs` import; adapted to async contracts. |
| `test/omp-ext-routing.test.ts`, `test/omp-ext-tools.test.ts` | Adapted to async resolver, injected `parseFrontmatter`, and the subprocess argv contract. |

**Root `package.json` needed no edit.** It already declares `workspaces: ["packages/*"]`
(`package.json:8-10`), which covers `packages/omp-mex` by glob. The package was invisible
to `npm query .workspace` only because `package-lock.json` had never been regenerated;
`npm install --package-lock-only` fixed that, and `npm ci --dry-run` accepts the result
(`add mex-omp 0.1.0`). The one-line allowance in the assignment was not needed.

## Follow-ups

- [ ] `.omp/mcp.json` is not projected by `mex setup`, so the MCP channel this package
      recommends for high-volume retrieval must be configured by hand. Worth a ticket.
- [ ] Bun's lack of `node:sqlite` blocks *any* future in-process graph work under omp.
      Worth stating in `COMPATIBILITY.md` as a runtime constraint, which this lane does not
      own.
