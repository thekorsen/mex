# Issue #17 — Document and test the Tier 0 zero-code omp integration

- **Issue:** https://github.com/thekorsen/mex/issues/17
- **Milestone:** Tier 0 — works today, zero code
- **Branch:** `omp/docs`
- **Status:** ready for review
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

A usable omp integration already exists without patching mex — the `mex-mcp` stdio server plus an `@`-import bridge from `.omp/AGENTS.md` into `.mex/AGENTS.md` — but nothing writes it down, so every new session rediscovers it. Write a quickstart a stranger can follow verbatim on a clean machine, add a protocol-level regression test that pins the MCP handshake and tool advertisement, and state the integration's holes precisely enough that nobody builds on a capability that is not there.

## Acceptance criteria

Verbatim from `FLEET-TICKETS/17.md:56-60`:

- [x] A user following the doc verbatim on a clean machine gets a working `mex_check` call from omp.
- [x] The limitations section is accurate and complete — no claimed capability that is not verified.
- [x] The stdio test runs in `npm test` without requiring omp to be installed.

Third criterion caveat: the test's *logic* was verified by executing an exact-logic mirror script against the live server (see Commands run). `npx vitest run` itself is a gate the orchestrator runs — I did not run it, per lane constraints.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| Server identifies as `mex-mcp` 0.1.0, protocol `2024-11-05`, `capabilities.tools.listChanged: true` | raw stdio `initialize` | executed |
| Exactly 5 tools advertised today | `tools/list` → `mex_check, mex_log, mex_timeline, mex_heartbeat, mex_read_file` | executed |
| `mex_check` → `{score, issues[], filesChecked, timestamp}`; score `94`, 2 × `UNDOCUMENTED_SCRIPT` warnings (`eval`, `eval:e2e`) | `tools/call mex_check`, exit 0, empty stderr | executed |
| Every tool takes optional `projectRoot`, defaulting to `process.cwd()` | `check.ts:10-16`, `log.ts:10-13`, `timeline.ts:10-13`, `heartbeat.ts:10-13`, `read-file.ts:12-15` (all under `packages/mex-mcp/src/tools/`) | read-only + schema confirmed by `tools/list` |
| `file` is the only required parameter on the whole surface | `packages/mex-mcp/src/tools/read-file.ts:16-19`; `tools/list` → `required: ["file"]` | executed |
| `mex_log` write requires both `kind` and `summary`, else returns an `error` payload as a *successful* response | `packages/mex-mcp/src/tools/log.ts:37-44` | read-only |
| `mex_timeline` sorts newest-first *then* truncates to `limit` | `packages/mex-mcp/src/tools/timeline.ts:45-47` | read-only |
| `mex_read_file` is sandboxed by an explicit prefix check on the resolved path | `packages/mex-mcp/src/tools/read-file.ts:35-43` | read-only |
| All five tools swallow `findConfig` failure into `{error, projectRoot}` content rather than an MCP protocol error | e.g. `packages/mex-mcp/src/tools/check.ts:18-29` | read-only |
| `mex-agent` workspace link exists and resolves; 14 exports | `node -e 'await import("mex-agent")'` → `ok, exports: 14` | executed |
| Node ≥ 22.5 is a hard requirement (`node:sqlite` `DatabaseSync`) | `src/graph/db/sqlite.ts:59-60`; `package.json#engines` = `{"node":">=22.5"}` | executed (`node -e` on package.json) |
| Ran under Node v26.0.0, omp v17.2.4 | `node -v`, `omp --help` | executed |
| `mex_sync` deliberately deferred | `CHANGELOG.md:48` — **line number confirmed correct**, ticket text was right | read-only |
| `mex-mcp` unpublished, local build only | `CHANGELOG.md:54`; `packages/mex-mcp/package.json` dep `"mex-agent": "file:../.."` | executed (`node -e` on the package.json) |
| `mex sync` is TTY-bound: readline over stdin/stdout, then two blocking prompts | `src/sync/index.ts:14-22` (readline), `:203` (mode choice), `:303-305` ("Run another cycle?") | read-only |
| Graph CLI subcommands are `query`, `scope`, `get`, `ground` — none exposed over MCP | `node dist/cli.js graph --help` | executed |
| `@` imports resolve from the **importing file's** directory, not cwd | `omp://context-files.md:147` | read-only (quote verified) |
| A missing `@` target leaves the literal token in place — **silent** failure | `omp://context-files.md:154`, restated `:236` | read-only (quote verified) |
| `.omp/` must be non-empty or the walk-up skips it | `omp://context-files.md:32`, `:215` | read-only (quote verified) |
| `native` = priority 100, nearest non-empty `.omp/AGENTS.md` wins; farther ancestors not also loaded | `omp://context-files.md:25`, `:31`, `:61`, `:112` | read-only (quote verified) |
| Imports recurse 5 hops; cycles skipped; tokens in fences/code spans not expanded | `omp://context-files.md:149`, `:152`, `:153` | read-only (quote verified) |
| `${VAR}` / `${VAR:-default}` expansion applies to `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, `oauth`; unresolved placeholders stay literal | `omp://mcp-config.md`, "Discovery-time `${...}` expansion" | read-only — `read omp://mcp-config.md` resolved, so **not** an `[INFERENCE]` |
| `.omp/mcp.json` is keyed to the working directory, not the profile — applies under every profile | `omp://mcp-config.md`, "Profiles" | read-only (quote verified) |
| `stdio` requires `command`; `type` defaults to `stdio`; `args`/`env`/`cwd` optional; names match `^[a-zA-Z0-9_.-]{1,100}$` | `omp://mcp-config.md`, "`stdio` transport" + "File shape" | read-only |
| Neither `.omp/mcp.json` nor `.omp/AGENTS.md` is written by `mex setup` | `SCAFFOLD_FILES` `src/setup/index.ts:33-45`; `TOOL_CONFIGS` `:52-59` | read-only (per shared context, re-checked against the cited ranges) |
| `describe.skipIf` exists in vitest 3 | `node_modules/@vitest/runner/dist/tasks.d-CkscK4of.d.ts:428` | read-only |
| Test files are outside `tsc --noEmit`'s scope | `tsconfig.json:16` — `"include": ["src"]` | read-only |
| Vitest already forces `MEX_TELEMETRY=0` for all tests | `vitest.config.ts:15-17` | read-only |

### Anchor-bridge form: `@../.mex/AGENTS.md`, not `@.mex/AGENTS.md`

The ticket text (`FLEET-TICKETS/17.md:38`) says `@.mex/AGENTS.md`. **That is wrong.** Canary probe (run by the orchestrator, result relayed over hub) put both forms in one `.omp/AGENTS.md` with a real `.mex/AGENTS.md` as a sibling of `.omp/`, then ran `omp -p --no-tools`:

- form B (`@../.mex/AGENTS.md`) expanded and delivered `TOKEN_PARENT_FORM_WORKS`.
- form A (`@.mex/AGENTS.md`) came back as **literal text**, nothing inlined.
- Control: creating `.omp/.mex/AGENTS.md` made form A expand — to `.omp/.mex/`, pinning the resolution base.

Mechanism is exactly `omp://context-files.md:147` (resolution relative to the importing file) plus `:154` (missing target → token left in place, no error). This also matches the pre-existing ledger entry `AGENT-ONBOARDING.md:129`. The doc documents form B and calls the silent-failure mode out as a trap.

## Commands run

```
$ export MEX_TELEMETRY=0
$ printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node packages/mex-mcp/dist/index.js
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"mex-mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
{"result":{"tools":[ … 5 tool descriptors with full JSON Schemas … ]},"jsonrpc":"2.0","id":2}
# rc 0, stderr empty
```

`tools/call mex_check` in the same style returned, decoded from the text content block:

```json
{
  "score": 94,
  "issues": [
    {"code":"UNDOCUMENTED_SCRIPT","severity":"warning","file":"package.json","line":null,
     "message":"Script \"eval\" exists in package.json but is not mentioned in any scaffold file"},
    {"code":"UNDOCUMENTED_SCRIPT","severity":"warning","file":"package.json","line":null,
     "message":"Script \"eval:e2e\" exists in package.json but is not mentioned in any scaffold file"}
  ],
  "filesChecked": 12,
  "timestamp": "2026-08-04T21:39:44.065Z"
}
```

Workspace link and environment:

```
$ node --input-type=module -e 'const m = await import("mex-agent"); console.log("ok, exports:", Object.keys(m).length)'
ok, exports: 14

$ node -v
v26.0.0
$ omp --help | head -1
omp v17.2.4
$ node -e 'const p=require("./package.json");console.log("engines",JSON.stringify(p.engines))'
engines {"node":">=22.5"}
```

Graph surface (to substantiate "no graph over MCP; you must shell out"):

```
$ node dist/cli.js graph --help
Commands:
  query [options] <relation> <target>  Query graph structure: who-calls, what-calls, or where-defined
  scope [options] <task...>            Retrieve a compact code neighborhood for a task as JSONL
  get [options] <id...>                Expand source for specific node ids as JSONL
  ground [options]                     Retro-ground an existing pre-0.7 scaffold using the code graph
```

### Test logic verified without running the gate

I may not run `vitest`. To avoid shipping an unexercised test, I extracted the test's RPC driver and **every assertion** into `/tmp/mirror.mjs` — same `spawn` args, same newline-framing parser, same `Promise.withResolvers` settle path, same watchdog, same `existsSync` guard — and ran it under Node 26 from the repo root:

```
$ node /tmp/mirror.mjs
T1 serverInfo.name: mex-mcp | version type: string | protoVer: true | tools cap: true
T2 isArray: true | names: mex_check,mex_log,mex_timeline,mex_heartbeat,mex_read_file
    mex_check desc: true schemaType: object hasProjectRoot: true
    mex_log desc: true schemaType: object hasProjectRoot: true
    mex_timeline desc: true schemaType: object hasProjectRoot: true
    mex_heartbeat desc: true schemaType: object hasProjectRoot: true
    mex_read_file desc: true schemaType: object hasProjectRoot: true
   mex_read_file.required: ["file"]
T3 contentType: text | score: number 94 | issues: true | filesChecked: number
T4 existsSync(SERVER): true | absent-path guard: true
ALL OK
# rc 0
```

Every predicate the test asserts holds against the live server. What the mirror does **not** cover: vitest's own harness wiring (`describe.skipIf` dispatch, `expect.arrayContaining` / `toMatchObject` matcher semantics, `afterEach` reaping). Those need `npx vitest run test/mex-mcp-stdio.test.ts` — orchestrator's gate.

---

## Decisions

### Decision: should `mex setup` offer to write `.omp/mcp.json`?

**Recommendation only — out of lane.** This overlaps issue #2 ("Add `.omp` as a tool target in `mex setup`"), which owns the implementation. I did not touch `src/setup/`.

- **Options considered:**
  1. **Do nothing.** Users hand-write `.omp/mcp.json` forever, in every checkout, from the quickstart.
  2. **Write it unconditionally** when `.omp` is a selected tool target, with the resolved absolute path baked in.
  3. **Write it only when the local `mex-mcp` build is present**, using a `${VAR}` placeholder rather than a literal absolute path, and never overwrite an existing file.
  4. **Write `.omp/AGENTS.md` (the anchor bridge) but not `.omp/mcp.json`.**
- **Chosen (recommended to #2):** option **4 now**, option **3 later** and only behind an explicit opt-in.
- **Why:**
  - `mex setup`'s existing contract is copying *scaffold prose* into `.mex/` (`SCAFFOLD_FILES`, `src/setup/index.ts:33-45`) and *anchor files* to root destinations (`TOOL_CONFIGS`, `:52-59`). `.omp/AGENTS.md` is exactly an anchor file and fits `TOOL_CONFIGS` with no new concept. `.omp/mcp.json` is a different thing: executable process configuration.
  - `.omp/mcp.json` names a `command` that omp will **spawn**. `omp://mcp-config.md` says as much: *"Committed MCP definitions are trusted input — the same already applies to `stdio` entries, which run arbitrary commands."* A scaffolding tool silently generating a file that causes another tool to execute a local binary is a materially larger claim on the user's trust than copying Markdown, and it deserves an explicit prompt rather than a side effect of `mex setup`.
  - It cannot be written **correctly** today anyway. `mex-mcp` is unpublished (`"mex-agent": "file:../.."`, `CHANGELOG.md:54`) and `packages/mex-mcp/dist/` is a gitignored artifact, so for any user who installed `mex` from npm there is **no path to point at**. `mex setup` would emit a config referencing a file that does not exist on their disk. That is worse than no file: omp fails at spawn time, not at config load.
  - Even for a from-source user, the correct value is machine-local. `.omp/mcp.json` is project-scoped and profile-independent (`omp://mcp-config.md`, "Profiles"), so a generated absolute path gets committed and is wrong for every collaborator. `${VAR}` fixes portability but shifts the burden to an env var each collaborator must set — a prompt-worthy tradeoff, not a default.
- **What this rules out:** treating `.omp/mcp.json` as just another `TOOL_CONFIGS` row. It needs a real precondition (a resolvable server path) and a real prompt.
- **Revisit if:** `mex-mcp` is published to npm. Then `"command": "npx", "args": ["-y", "mex-mcp"]` is portable, machine-independent, and safe to generate — at which point option 3 collapses into a trivially correct default and the argument above evaporates. That publication is the actual unblocker; sequence it before #2 tries to generate MCP config.

### Decision: subset (`arrayContaining`) over exact-set tool assertion

- **Options considered:** (1) `expect(names.sort()).toEqual(TOOLS_TODAY.sort())` — pins the surface exactly. (2) `expect(names).toEqual(expect.arrayContaining(TOOLS_TODAY))` — pins that today's five survive.
- **Chosen:** (2).
- **Why:** a sibling lane is concurrently registering four more tools (graph retrieval, issue #10). An exact-set assertion in *this* file would fail on their branch at merge, for a change that breaks nothing — the test would be a merge tripwire rather than a contract. The durable contract is "the handshake works and today's tools are still advertised". Removing a tool is a real breaking change and still fails; adding one does not.
- **What this rules out:** this test will not catch an accidentally-registered tool. Acceptable — that is a review concern, not a protocol regression.
- **Revisit if:** the tool surface is ever declared frozen.

### Decision: `describe.skipIf(!existsSync(SERVER))` rather than failing

- **Options considered:** (1) fail loudly when `packages/mex-mcp/dist/index.js` is missing. (2) skip the suite with the reason in a comment. (3) build the server from the test.
- **Chosen:** (2).
- **Why:** `packages/mex-mcp/dist/` is a gitignored build artifact and `npm run build` at the root does **not** build the workspace — `npm run build --workspace mex-mcp` is a separate step (`AGENT-ONBOARDING.md:173`). So `npm test` on a clean checkout after only the root build legitimately has nothing to drive. Option 1 makes the suite red for a missing optional artifact, which trains people to ignore red. Option 3 makes a unit-test run invoke a bundler — slow, and it would race the very sibling lanes editing that package.
- **What this rules out:** CI will silently skip this test unless CI runs the workspace build. That is the real cost, and the mitigation belongs in CI config (issue #7 territory), not here.
- **Revisit if:** a CI pipeline lands — then assert the artifact exists as a *pipeline* step and let the test stay skip-guarded for local runs.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Documenting `@.mex/AGENTS.md`, as the ticket text says (`FLEET-TICKETS/17.md:38`) | Wrong. `@` paths resolve from the importing file's directory (`omp://context-files.md:147`), so from `.omp/AGENTS.md` it means `.omp/.mex/AGENTS.md`. The canary probe showed form A arriving as literal text with nothing inlined. Worse, it fails **silently** (`:154`), so a doc shipping this form would look correct in a transcript and deliver nothing. Documented `@../.mex/AGENTS.md` instead, and promoted the silence to a named trap. |
| Trusting the ticket's own two path forms rather than waiting for the probe | The ticket said `@.mex/…`, the lane assignment said `@../.mex/…`. Both cannot be right and a quickstart must be copy-pasteable, so guessing was not an option. Blocked on the orchestrator's canary and wrote the doc's other sections first. |
| `import { type ChildProcessWithoutNullStreams }` plus non-null stdio typing in the first draft of the test | Combined with `: any` on the JSON-RPC payloads it tripped `ts-no-any`, and `type Child = ReturnType<typeof spawn>` tripped `ts-no-return-type`. Replaced with narrow local response interfaces, an `asResponse` type guard over `unknown`, and the concrete `ChildProcess` type that `node:child_process` already exports. |
| `new Promise((resolve, reject) => …)` for the RPC driver | Tripped `ts-promise-with-resolvers`. Rewrote with `Promise.withResolvers()`, which also flattened the `settle()` helper out of the executor closure. Runtime-verified on Node 26 via the mirror script; note `tsconfig.json:16` is `"include": ["src"]`, so `tsc --noEmit` never typechecks `test/` and the ES2022 `lib` setting cannot produce a `withResolvers` typing complaint here. |
| Framing the tool table as "the five tools" / "the MCP surface" | Would contradict the sibling lane adding graph tools. Reframed as "the tools available today", with an explicit "this list grows" and an instruction to re-run `tools/list` against your own build. No sentence in the doc names an unlanded tool or implies graph retrieval exists over MCP. |
| Asserting `score === 94` in the test | The score is drift, not a constant — it moves the moment anyone edits `.mex/` prose or adds an undocumented npm script. Two `UNDOCUMENTED_SCRIPT` warnings are the *current* cause. Asserting the value would make an unrelated doc edit fail an MCP protocol test. Asserted shape (`score` is a number, `issues` an array, `filesChecked` a number) instead. |
| Reading the drift score straight off `--help`-style paraphrase instead of the wire | Early instinct was to describe the `mex_check` payload from `check --json`. The MCP path wraps the report as a JSON *string* inside a text content block (`packages/mex-mcp/src/tools/check.ts:31`), which is a materially different shape for a client to parse. Documented and asserted the wrapped form. |
| Running `npx vitest run test/mex-mcp-stdio.test.ts` to prove the test | Forbidden by lane constraints — it races sibling agents editing the same worktree. Substituted the exact-logic mirror script (see Commands run) so the test is not shipped unexercised, and flagged precisely which parts remain unproven (vitest matcher/hook wiring). |
| Verifying the graph-CLI claim from `AGENT-ONBOARDING.md` alone | The ledger records `GRAPH_UNAVAILABLE` from subdirs (`:119`) but not the current subcommand list, and I would be asserting command names a stranger will type. Ran `graph --help` and cited the real four subcommands. |

---

## Changes made

| File | Change |
|---|---|
| `docs/omp-integration/tier0/README.md` | NEW. The Tier 0 quickstart: prerequisites, three-command build, the workspace-link trap plus the one-liner that actually proves the server runs, the raw-stdio probe with pasted transcripts, the exact `.omp/mcp.json` with absolute-path / profile-scope / `${VAR}` facts, the `omp -p` verification, a 5-tool table framed as today's surface, the anchor bridge with the `@../` form and the silent-failure trap, and a fully cited limitations section. |
| `test/mex-mcp-stdio.test.ts` | NEW. Protocol-level stdio test — see below. |
| `docs/omp-integration/notes/17-tier0-zero-code-omp-integration.md` | NEW. This note. |

Deliberately **not** changed: `docs/omp-integration/README.md` (does not link the new directory — outside this lane; see Follow-ups), `AGENT-ONBOARDING.md`, `src/**`, `packages/**`, `templates/**`.

Placement note: the ticket text (`FLEET-TICKETS/17.md:52`) says `docs/omp-integration/TIER-0-QUICKSTART.md`; the lane assignment says the `tier0/` directory. Followed the assignment. Kept it a single `README.md` — splitting a quickstart across files defeats the point of being copy-pasteable top to bottom.

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/mex-mcp-stdio.test.ts` › "completes the initialize handshake and identifies itself" | The built server speaks MCP over stdio and identifies itself: `serverInfo.name === "mex-mcp"`, a string `version`, a `protocolVersion`, and a `tools` capability. This is what breaks if the transport, entrypoint, or the `mex-agent` runtime link regresses. |
| `test/mex-mcp-stdio.test.ts` › "advertises today's tool set with usable input schemas" | Today's five tools are still advertised (subset check), each with a description, an object input schema, an accepted `projectRoot`, and `mex_read_file` still requiring `file`. Defends the agent-facing contract, not the tool count. |
| `test/mex-mcp-stdio.test.ts` › "returns a drift report shape from mex_check" | An end-to-end `tools/call` round trip returns a text content block whose JSON has `score` (number), `issues` (array), `filesChecked` (number). Shape only — never the value. |

Conventions followed from `test/tool-config-templates.test.ts:1-13`: named `node:*` imports, named vitest imports, repo-root-relative paths (no `__dirname`), an array of resources drained in `afterEach`, and the second `expect` argument as the assertion label.

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (raw-stdio probe + assertion mirror, output pasted above)
- [ ] `npm test` passes — **not run: gate, orchestrator owns it.** Test logic exercised via the mirror script; vitest harness wiring unproven.
- [ ] `npm run build` passes — **not run: gate.** `dist/` and `packages/mex-mcp/dist/` were pre-built by the orchestrator; I rebuilt nothing.
- [x] `mex check` did not regress — `mex_check` over MCP returned `94` with the same two `UNDOCUMENTED_SCRIPT` warnings as the pinned baseline. Changes are docs + one new test file; nothing in `.mex/` was touched.
- [x] Docs updated where behavior changed — no behavior changed; this ticket *is* the doc.
- [ ] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2 — **not done: that file is out of lane.** Two items belong there; filed under Follow-ups.
- [x] Worktrees / scratch dirs cleaned up — only `/tmp/probe.json` and `/tmp/mirror.mjs`, outside the repo.

No `[INFERENCE]` labels remain in the shipped doc. Both candidates resolved: `omp://mcp-config.md` read successfully, so the `${VAR}` expansion and field-name claims are cited quotes; the anchor-bridge path form was settled by the canary probe.

## Follow-ups

Adjacent breakage found but deliberately not fixed here.

- [ ] `FLEET-TICKETS/17.md:38` documents the wrong anchor-import form (`@.mex/AGENTS.md`). Correct it in the issue so the next reader does not re-derive it.
- [ ] `docs/omp-integration/README.md` does not link `tier0/`. Out of lane (forbidden file) — orchestrator or a follow-up should add the link, or the quickstart is undiscoverable.
- [ ] Promote into `AGENT-ONBOARDING.md` §4.2 (out of lane): (a) the `@`-import resolution base is the *importing file's* directory and a missing target fails **silently** — `omp://context-files.md:147,154`; (b) a green `npm run build --workspace mex-mcp` does not prove the server runs, because tsup does not resolve runtime deps — the `mex-agent` workspace link is a separate precondition.
- [ ] Publishing `mex-mcp` to npm is the actual unblocker for generating `.omp/mcp.json` in `mex setup` (issue #2). Worth its own issue: today there is no portable `command`/`args` pair to generate for an npm-installed user.
- [ ] CI will skip `test/mex-mcp-stdio.test.ts` unless the pipeline runs `npm run build --workspace mex-mcp`. Belongs to the CI ticket (#7).

## Handoff

Ticket is complete as scoped. The one thing a fresh session must not redo: the anchor-bridge path form is settled — `@../.mex/AGENTS.md`, canary-verified, ticket text is wrong. Next concrete action is the orchestrator's gates (`npm run build`, `npm test`, `mex check`); expect `test/mex-mcp-stdio.test.ts` to run (not skip) in this worktree since `packages/mex-mcp/dist/index.js` is present.
