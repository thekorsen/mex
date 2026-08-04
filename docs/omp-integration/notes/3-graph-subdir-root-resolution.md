# Issue #3 — graph subdir root resolution

- **Issue:** https://github.com/thekorsen/mex/issues/3
- **Milestone:** Correctness
- **Branch:** `omp/graph`
- **Status:** ready for review
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

Make the read-side graph commands resolve the project root the same way the rest of the CLI does, so they keep working from any subdirectory, while still degrading to the existing `GRAPH_UNAVAILABLE` JSONL envelope when no scaffolded graph exists.

## Acceptance criteria

- [x] `mex graph scope|get|query` and `mex impact` succeed from any subdirectory of a repo with a built graph.
- [x] A missing graph still yields `{"type":"error","code":"GRAPH_UNAVAILABLE",...}` on stdout, not a thrown stack trace.
- [x] `mex graph --root <dir>` behavior is unchanged.
- [x] A regression test that runs a graph command with `process.cwd()` set to a subdirectory.

---

## Findings

What you learned about the code. Every structural claim carries `path:line`.

| Finding | Evidence | Verified? |
|---|---|---|
| `findConfig()` already resolves the project root by walking upward for `.git` and then requiring a scaffold at that root; the bug is not in config resolution itself. | `src/config.ts:54-101` | read-only |
| `findConfig()` throws when no scaffold is found, specifically at the missing-`.mex/` branch. | `src/config.ts:73-81` | read-only |
| The graph read path emits a machine-readable `GRAPH_UNAVAILABLE` envelope when `.mex/graph.db` is absent under the supplied root. | `src/graph/cli-agent.ts:464-470` | read-only |
| The graph build command already treats `--root` as an override and otherwise indexes `process.cwd()`. | `src/cli.ts:199-207`, `src/graph/cli-graph.ts:24-29` | read-only |
| Before this change, the four broken read-side handlers passed `process.cwd()` directly into the agent graph commands. | `src/cli.ts:214-276` | read-only |
| The raw CLI options bag is normalized by `resolveOptions()`, which only reads `detail`, `maxNodes`, `maxOutputTokens`, `maxSourceLines`, `depth`, and `fingerprint`; an extra `root` key is ignored. | `src/graph/agent-protocol.ts:36-50` | read-only |
| Existing tests in this area use temp roots, `roots[]` cleanup in `afterEach`, real graph builds via `createGraphEngine({ rootDir: root })`, and `process.chdir()` with `finally` restore. | `test/graph-migration.test.ts:13-22`, `test/graph-migration.test.ts:48-50`, `test/graph-migration.test.ts:64-66`, `test/graph-cli-agent.test.ts:119-145` | read-only |
| **`--root` cannot be declared on a `graph` subcommand.** The parent `graph` command already declares `--root` (`src/cli.ts:206`). Commander resolves a parent-known flag even when it trails a subcommand name, so a duplicate `--root` on `query`/`scope`/`get` is parsed into the PARENT's option store and the subcommand's own copy is never populated. `impact` is top-level and has no such parent, so its own flag works. | probe against the built CLI: `graph scope alpha --root <dir>` gave `scope opts.root = undefined` while `parent graph opts.root = "<dir>"` | **executed** |

## Commands run

Actual commands and actual output. This is the proof, not a summary of the proof.

```text
$ export MEX_TELEMETRY=0 && node dist/cli.js graph
Code graph built: 1831 nodes, 2839 edges across 152 files in 7876ms → .mex/graph.db

# BEFORE — all four commands from a subdirectory
$ cd src && node ../dist/cli.js graph scope "drift check"
{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run `mex graph` first."}
$ node ../dist/cli.js impact findConfig
{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run `mex graph` first."}
$ node ../dist/cli.js graph query who-calls findConfig
{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run `mex graph` first."}
$ node ../dist/cli.js graph get "function:659730e0b4508b577c51042b3227fbfb"
{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run `mex graph` first."}

# AFTER — same four commands, same subdirectory
$ cd src && node ../dist/cli.js graph scope "drift check" | head -2
{"type":"meta","schemaVersion":1,"command":"graph scope","task":"drift check","detail":"minimal","maxNodes":10,"maxOutputTokens":1500}
{"type":"fact","id":"constant:73994b5d639c2dc5e729001737644345",...,"selectionReasons":["exact-name-match"]}
$ node ../dist/cli.js graph query who-calls findConfig | head -2
{"type":"meta","schemaVersion":1,"command":"graph query who-calls",...}
{"type":"result","relation":"who-calls","target":"function:5496c34532d23ce2f6033e83fced2acd",...}
$ node ../dist/cli.js impact findConfig | head -2
{"type":"meta","schemaVersion":1,"command":"impact",...}
{"type":"target","targetType":"symbol","value":"findConfig"}
$ node ../dist/cli.js graph get constant:73994b5d639c2dc5e729001737644345 | head -2
{"type":"meta","schemaVersion":1,"command":"graph get","detail":"source","maxNodes":1,"maxOutputTokens":1500}
{"type":"source","filePath":"test/setup-grounding-e2e.test.ts","ranges":[{"startLine":100,...}]}

# AFTER — deeper nesting still resolves
$ cd src/graph/db && node ../../../dist/cli.js graph scope "drift check" | head -1
{"type":"meta","schemaVersion":1,"command":"graph scope","task":"drift check",...}

# AFTER — a git repo with NO scaffold, from a subdirectory: envelope, not a stack trace
$ cd /tmp/mex-noscaffold/sub && node <repo>/dist/cli.js graph scope "anything"; echo "exit=$?"
{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run `mex graph` first."}
exit=0

# --root, read side, from an unrelated cwd — both flag positions
$ cd /tmp && node <repo>/dist/cli.js graph scope alpha --root /tmp/mex-rootflag | head -2
{"type":"meta","schemaVersion":1,"command":"graph scope","task":"alpha",...}
{"type":"fact","id":"function:bbf11b362b77f67c68572d3f972929b1","name":"alpha","filePath":"src/a.ts",...}
$ node <repo>/dist/cli.js graph --root /tmp/mex-rootflag scope alpha | head -1
{"type":"meta","schemaVersion":1,"command":"graph scope","task":"alpha",...}
$ node <repo>/dist/cli.js impact alpha --root /tmp/mex-rootflag | head -2
{"type":"meta","schemaVersion":1,"command":"impact",...}
{"type":"target","targetType":"symbol","value":"alpha"}

# --root, BUILD side: unchanged
$ node <repo>/dist/cli.js graph --root /tmp/mex-rootflag
Code graph built: 2 nodes, 1 edges across 1 files in 63ms → .mex/graph.db

$ npx vitest run                       # whole suite
Test Files  39 passed (39)
     Tests  377 passed (377)

$ node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)   # exit 0, baseline held
```

---

## Decisions

For `design-decision` tickets this section is the deliverable and must be written **before** implementation.

### Decision: a symmetric read-side `--root`, declared once on the parent `graph` command

- **Options considered:**
  1. Resolve the root implicitly from `findConfig()` only, with no read-side flag.
  2. Declare `--root <dir>` on each of `graph query`, `graph scope`, `graph get`, and `impact`, and read `options.root`.
  3. Reuse the `--root` the parent `graph` command already declares (`src/cli.ts:206`), read via `graphCommand.opts().root`, and keep the top-level `impact` flag on `impact` itself.
- **Chosen:** Option 3.
- **Why:** `mex graph --root <dir>` writes `<dir>/.mex/graph.db` (`src/graph/cli-graph.ts:24-29`), so without a read-side override a graph deliberately built elsewhere cannot be queried without also changing cwd — that is the case for the flag. Option 2 is what a naive reading suggests and it **silently does not work**: commander resolves a parent-known flag even when it trails a subcommand name, so `graph scope … --root <dir>` populates the parent's option store and leaves the subcommand's own `--root` `undefined` (measured — see Findings). A duplicate declaration is therefore a dead flag that appears in `--help` and never fires. `impact` is a top-level command with no such parent, so it keeps its own flag. The forwarded raw options bag tolerates the extra `root` key either way because `resolveOptions()` ignores unknown keys (`src/graph/agent-protocol.ts:36-50`).
- **What this rules out:** A read path that can only consume the cwd-resolved root; and per-subcommand `--root` declarations under `graph`, which cannot work while the parent declares the same flag.
- **Revisit if:** The parent `graph` command ever drops `--root`, or commander changes parent/child option precedence — then each subcommand would need its own declaration. `test/graph-subdir.test.ts` fails loudly if either happens.

---

## Dead ends

**Do not skip this.** What you tried that did not work is the most valuable thing in this file — it is what stops the next session from spending the same hours.

| Approach | Why it failed |
|---|---|
| Fix the bug inside `findConfig()` | Wrong layer and off-limits for this slice. `findConfig()` already walks up to the project root and throws correctly when the scaffold is missing (`src/config.ts:54-101`). The bug was that these four handlers bypassed it and passed `process.cwd()` directly (`src/cli.ts:214-276`). |
| Declare `--root <dir>` on `graph query` / `graph scope` / `graph get` themselves | **Compiles, appears in `--help`, and silently never fires.** The parent `graph` command already declares `--root` (`src/cli.ts:206`), and commander resolves a parent-known flag even when it trails the subcommand name — so the value lands in the parent's option store and the subcommand's `options.root` stays `undefined`. Measured directly: `graph scope alpha --root <dir>` → `scope opts.root = undefined`, `parent graph opts.root = "<dir>"`. The read side now reads `graphCommand.opts().root`. `impact` is unaffected because it is a top-level command. This cost a real debugging pass and is the least obvious thing in the ticket. |
| Change the duplicate root-resolution helper in `src/setup/index.ts` too | Deliberately left alone because it is another lane's file and out of this ticket's target set. The duplicate implementation at `src/setup/index.ts:68-76` was noted but not edited. |

---

## Changes made

| File | Change |
|---|---|
| `src/graph/cli-agent.ts` | Added `findConfig` import plus exported `resolveGraphRoot(explicitRoot?)` with a doc comment citing the subdir-resolution path, the missing-scaffold throw path, the existing `GRAPH_UNAVAILABLE` envelope, and the `mex graph --root` override semantics. |
| `src/cli.ts` | Updated only the `graph query`, `graph scope`, `graph get`, and `impact` handlers: each now resolves via `resolveGraphRoot(...)` instead of `process.cwd()`. The three `graph` subcommands read the parent's existing `--root` (`graphCommand.opts().root`); `impact` declares its own `--root` because it is top-level. Added a comment at `src/cli.ts:203-206` explaining why the flag is declared once on the parent. |
| `test/graph-subdir.test.ts` | Added regression coverage for subdirectory success, missing-scaffold envelope degradation, and explicit-root override behavior using real temp repos and real graph builds. |
| `docs/omp-integration/notes/3-graph-subdir-root-resolution.md` | Recorded findings, decisions, dead ends, and verification constraints for issue #3. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/graph-subdir.test.ts` — `runs graph scope from a subdirectory when a scaffolded repo root exists` | A read-side graph command succeeds from `src/` because root resolution finds the scaffolded project root instead of binding reads to the subdirectory cwd. |
| `test/graph-subdir.test.ts` — `keeps the graph-unavailable envelope when no scaffold exists` | Missing scaffold lookup does not throw through the command path; it degrades to the existing `{ type: "error", code: "GRAPH_UNAVAILABLE" }` envelope. |
| `test/graph-subdir.test.ts` — `lets an explicit root override cwd` | An explicit root keeps the same override semantics as `mex graph --root`, even when cwd is elsewhere. |
| `test/graph-subdir.test.ts` — `routes --root through the real CLI wiring for both flag positions` | `--root` actually reaches the read side through real commander parsing, for `graph scope … --root`, `graph --root … scope`, and `impact … --root`. A direct `resolveGraphRoot()` call cannot cover this — the dead-flag bug lived entirely in the parsing layer. |

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (output pasted above)
- [x] `npx vitest run` passes — 39 files, 377 tests
- [x] `npm run build` passes (plus `npx tsc --noEmit` clean)
- [x] `mex check` did not regress: `94/100 (2 warnings)`, exit 0
- [x] Docs updated where behavior changed
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2
- [x] Worktrees / scratch dirs cleaned up (`/tmp/mex-noscaffold`, `/tmp/mex-rootflag`, probe scripts removed; no git worktrees created)

Notes:
- The `[INFERENCE]` that the regression test fails pre-fix is **resolved by execution**: reintroducing the dead subcommand `--root` plus `options.root` on `scope` and re-running the file gives
  `× routes --root through the real CLI wiring for both flag positions → expected true to be false`, 1 failed | 3 passed. Restoring the fix returns 4 passed.
- Verification was run by the lane orchestrator, which owns gates for this lane; the implementing subagent ran none by design.

## Follow-ups

Adjacent breakage found but deliberately not fixed here. File these as issues; do not silently widen scope.

- [ ] Consolidate the duplicate argument-less root-resolution logic in `src/setup/index.ts:68-76` once the owning lane is free, so setup and graph reads do not drift again.

## Handoff

Done. #3 is landed, gated, and committed on `omp/graph`. Nothing outstanding.

One note for whoever picks up the anchors lane: this lane's findings **do** bear on the duplicate root resolution at `src/setup/index.ts:68-76`. That copy takes no argument and falls back to `process.cwd()` instead of `null`, so it has the same subdirectory blind spot this ticket just fixed on the graph side — but it was deliberately not touched (not this lane's file). `resolveGraphRoot` (`src/graph/cli-agent.ts:456`) is the shape that works: try `findConfig()`, degrade rather than throw.
