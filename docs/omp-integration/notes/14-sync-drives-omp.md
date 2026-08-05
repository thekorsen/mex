# Issue #14 — Teach `mex sync` and `mex graph ground` to drive omp as the agent CLI

- **Issue:** https://github.com/thekorsen/mex/issues/14
- **Milestone:** Tier 1 — native omp surfaces
- **Branch:** `omp/syncomp`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

`mex sync` repairs drift by shelling out to a coding-agent CLI with the whole brief as one
command-line argument. Make `omp` a real driver for that path, and fix the thing that would break it
first: a brief carrying whole file contents can exceed the operating system's argument limit, which
today surfaces as a bare "session failed" with no diagnosis.

## Acceptance criteria

Verbatim from the issue:

- [x] `mex sync` on a repo configured with `omp` launches omp with the brief and completes.
- [x] A brief larger than the platform argument limit does not silently truncate or fail — verified
      with a deliberately oversized brief.
- [x] Spawn failure is reported as failure, and the drift score is re-checked afterward as it is for
      other tools.
- [x] `mex graph ground` works the same way.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| `AI_TOOLS.omp` already exists — `{ name: "oh-my-pi", cli: "omp", promptFlag: ["-p"] }` | `src/types.ts:21` | read-only |
| Spawn is one shared function; both sync and ground go through it | `src/sync/index.ts:40-57`; ground closure `src/graph/cli-ground.ts:138` | read-only |
| Only two production callsites | `src/sync/index.ts:281` (sync), `src/graph/cli-ground.ts:138` (ground) | read-only |
| A single argv string dies at **1,045,930 bytes** on this machine, environ 2,009 B, `ARG_MAX` 1,048,576 | binary search with `cross-spawn`, below | **executed** |
| `cross-spawn` surfaces the limit as `result.error.code === "E2BIG"`, `status: null` | 1.1 MB brief through the real pre-fix code path, below | **executed** |
| So the pre-fix failure mode was `runToolInteractive` → `false` → `"✗ <tool> session failed"`, cause unreported | `src/sync/index.ts:55` maps any `error` to `false`; `:284` prints the generic line | read-only + executed |
| Linux caps a **single** argv string at 131,072 B (`MAX_ARG_STRLEN`, 32 pages) independent of `ARG_MAX` | kernel constant; not reachable from this darwin host | `[INFERENCE]` — settled by running the oversize test on Linux |
| Windows caps the whole command line at 32,767 chars | documented platform limit; `cross-spawn` already exists here for Windows reasons (`src/sync/index.ts:45-47`) | `[INFERENCE]` — settled by running on Windows |
| `omp -p` writes files with stdin closed and **no** `--auto-approve` | probe, below: created `probe-out.txt`, exit 0, 17.9 s | **executed** |
| Because `tools.approvalMode` defaults to `yolo` | `omp://settings.md:477-488`; mode table `omp://approval-mode.md:15-23` | read-only (harness docs) |
| `omp -p` can **never block** on an approval prompt — it throws instead | installed v17.2.4 `src/extensibility/extensions/wrapper.ts:260-302`: when the resolved policy is `prompt` and `!this.runner.hasUI()` it throws `Tool … requires approval but no interactive UI available` before reaching `uiContext.select`. Sole approval gate per `src/sdk.ts:2558-2563,2664-2669`. Print mode has no UI: `omp://bash-tool-runtime.md:271-273` | read-only (omp source) |
| A stricter `approvalMode` therefore makes omp **fail closed**, exit 0, having changed nothing | probe with `--config` forcing `always-ask`: "Blocked … every write-capable path refused", `EXIT=0`, file absent | **executed** |
| `omp -p` does **not** reliably read a piped prompt from stdin | `src/main.ts:191-203` `readPipedInput()` runs only when `process.stdin.isTTY === false`; under this runtime it was `undefined`, and `printf … \| omp -p --no-tools` produced no model turn, exit 0 | **executed** + read-only |
| `@/abs/path` inlines a file's contents even when `--cwd` points elsewhere | `src/cli/file-processor.ts:35-38,55-67`, `src/tools/path-utils.ts:510-522`; probe recognized the marker | **executed** + read-only |
| omp reads a brief out of `os.tmpdir()` while cwd is a different repo | probe, below: brief in `/var/folders/…/mex-brief-*/`, cwd `/tmp/omp-cwd-test`, wrote the requested file | **executed** |
| Exact OMP argv form `-p --max-time=1m --no-tools @/abs/prompt.md` expands the file and completes | live probe returned only `OMP_ATFILE_MAXTIME_OK`, exit 0, in 4.00 s | **executed** |
| The brief has no size cap anywhere | whole target file inlined `src/sync/brief-builder.ts:88-94,117-120`; full `getGitDiff` `:100-107,129-134` and `src/git.ts:312-329`; whole grounding node bodies `:138-139,154-156` and `src/graph/runtime.ts:307-309` | read-only |
| `mex graph ground`'s prompt is static (~3.1 KB), so it never approaches the limit | `src/graph/cli-ground.ts:22-78`, no interpolation | read-only |
| The tool-picker fallback advertised a hardcoded CLI list that omitted omp | was `src/sync/index.ts:247` | read-only |

## Commands run

Real output, not a summary. `MEX_TELEMETRY=0` throughout.

### The argument limit, measured

```
$ getconf ARG_MAX
1048576

$ node probe.mjs          # binary search on a single argv string via cross-spawn
environ bytes: 2009
first failing arg length: 1045930 { err: 'E2BIG', status: null }
largest ok: 1045929 { err: null, status: 0 }
```

`1048576 - 1045930 - 2009 = 637` bytes of argv/exec-path overhead.

### The pre-fix failure mode, reproduced

A 1,100,057-byte brief through the exact call the old code made:

```
$ node -e 'cs.sync("omp",["-p",brief],{cwd:"/tmp/omp-probe",stdio:"ignore",timeout:60000})'
brief bytes: 1100057
error: E2BIG status: null
```

`error` set + `status: null` is precisely what `src/sync/index.ts:55` folds into `false`. The user saw
`✗ oh-my-pi session failed` and had no way to learn it was an OS limit.

### omp writes unattended with stdin closed and no `--auto-approve`

```
$ omp -p "Read the repair brief at /tmp/omp-brief-probe.md and carry out every instruction in it." < /dev/null
Working...
Done.
- `/tmp/omp-probe/probe-out.txt` — 18 bytes, single line `PROBE_TEMPFILE_OK`
real 0m17.893s
=== exit: 0 ===
--- probe-out.txt:
PROBE_TEMPFILE_OK
```

### omp reads a brief from `os.tmpdir()` with an unrelated cwd

```
os.tmpdir(): /var/folders/ml/nn7b78mj0w54kc5xw8r9668h0000gn/T
brief at: /var/folders/ml/nn7b78mj0w54kc5xw8r9668h0000gn/T/mex-brief-YucRSA/brief.md
$ node -e '… cs.sync("omp",["-p",pointerPrompt],{cwd:"/tmp/omp-cwd-test", …})'
Working...
Done. `/tmp/omp-cwd-test/tmpdir-probe.txt` contains exactly `TMPDIR_BRIEF_OK` …
error: null status: 0
--- tmpdir-probe.txt:
TMPDIR_BRIEF_OK
```

### Exact `--max-time` + `@file` argv form

```
$ omp -p --max-time=1m --no-tools @/tmp/mex-issue14-argv/prompt.md
Working...
OMP_ATFILE_MAXTIME_OK
```

Exit 0 in 4.00 s. The response could only come from the file because the argv carried no other
message and tools were disabled.

Full live `mex sync` transcript is in [Verification](#verification).

---

## Decisions

Written before implementation, per the onboarding rules.

### Decision 1: how an oversized brief reaches the agent

- **Options considered:**
  1. **Keep the positional argv and accept the ceiling.** Rejected: measured to fail at 1,045,930
     bytes while briefs inline whole files without a cap (`src/sync/brief-builder.ts:117-120`).
  2. **Pipe the brief on stdin.** Rejected: the executed pipe probe produced no model turn, and
     replacing inherited stdio would weaken interactive-session behavior.
  3. **Always spill.** Rejected: small briefs already work positionally and should not incur file
     delivery.
  4. **Chunk across turns.** Rejected: sync has no continuation protocol, and partial file context
     is unsafe.
  5. **Spill only beyond a conservative platform budget.** Chosen.
- **Chosen:** `deliverBrief()` keeps small briefs positional and writes oversized briefs whole to
  `mkdtempSync(tmpdir(), "mex-brief-")/brief.md`. `runToolInteractive()` uses OMP's native
  `@<absolute-path>` initial-message expansion when the selected metadata object is
  `AI_TOOLS.omp`; other tools receive a short pointer prompt (`src/sync/index.ts:45-57`).
- **Why:** the common path is unchanged; no brief is truncated; OMP receives the file content in
  its initial message without a read tool call. The actual argv probe
  `omp -p --max-time=1m --no-tools @/tmp/mex-issue14-argv/prompt.md` returned the marker from the
  file in 4.00 s. The executable and prompt prefix still come only from `AI_TOOLS.omp`
  (`src/types.ts:21`); production code contains no duplicate `"omp"` or `"-p"` literal.
- **What this rules out:** stdin delivery, truncation, chunking, and unconditional spill.
- **Revisit if:** `AiToolMeta` grows an explicit prompt-file capability; then move the identity
  check into metadata rather than adding another agent-specific branch.

### Decision 2: `--auto-approve`

- **Options considered:**
  1. Pass `--auto-approve` (or `--approval-mode=yolo`) whenever the tool is omp.
  2. Pass nothing; rely on omp's default.
  3. Add a mex flag letting the user choose.
- **Chosen:** option 2 — mex passes **no** approval flag.
- **Why:** three reasons, in order of weight. (a) The lane contract says spawn metadata comes from
  `AI_TOOLS.omp` and forbids hardcoding omp specifics a second time; `--auto-approve` is exactly
  such a specific, and `src/types.ts` is not mine to extend. (b) It is unnecessary: omp's
  `tools.approvalMode` already defaults to `yolo` (`omp://settings.md:477-488`), and the probe above
  confirms omp edits files unattended with stdin closed and no flag. (c) It is the safer default —
  mex would otherwise hand a subprocess blanket write permission on the user's repo *and override a
  stricter policy the user deliberately configured*, silently, which the ticket explicitly warns
  against.
- **What this rules out:** guaranteed repair for a user who has set `approvalMode: always-ask` or a
  per-tool `prompt` policy. That user's omp run **fails closed** — `wrapper.ts:260-302` throws
  rather than prompting — and exits 0 having changed nothing. mex handles this honestly rather than
  silently: the post-run drift re-check (`src/sync/index.ts:308-353`) reports `+0` and the remaining
  issues, so the user sees that nothing was repaired.
- **Revisit if:** users report confusing no-op syncs often enough that a mex-level
  `--auto-approve`/`--yolo` passthrough earns its keep, ideally as generic per-tool metadata rather
  than an omp branch.

### Decision 3: `--max-time` versus mex's 15-minute spawn timeout

- **Options considered:**
  1. Give OMP an inner deadline shorter than mex's process timeout.
  2. Keep only the outer `cross-spawn` timeout.
- **Chosen:** option 1. OMP receives `--max-time=14m`, derived from
  `INTERACTIVE_AI_TIMEOUT_MS`; `cross-spawn` retains the 15-minute outer timeout
  (`src/sync/index.ts:13,52-55,65`).
- **Why:** the one-minute gap lets OMP stop its session before mex kills the process. The value
  cannot drift independently because it is calculated from the existing constant. The exact flag
  form was executed together with print mode and an `@file` prompt:
  `omp -p --max-time=1m --no-tools @/tmp/mex-issue14-argv/prompt.md` returned
  `OMP_ATFILE_MAXTIME_OK` and exited normally in 4.00 s.
- **What this rules out:** equal inner/outer deadlines, which race, and a longer OMP budget that mex
  can never honor.
- **Revisit if:** `AiToolMeta` gains timeout metadata; move the capability there while preserving
  the shorter-inner/longer-outer invariant.

### Decision 4: keep `spillPath` out of the repo

Briefs spill to `os.tmpdir()`, never to `.mex/` or the project root. A brief embeds whole file
contents and unstaged diffs; writing it under the repo risks committing it and would trip mex's own
scaffold checkers. `os.tmpdir()` is verified reachable by omp with an unrelated cwd, so there is no
reason to prefer a repo-local path.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Pipe the brief to `omp -p` on stdin | omp reads piped stdin only when `process.stdin.isTTY === false` (`src/main.ts:191-203`); under this runtime it was `undefined`, and `printf 'prompt' \| omp -p --no-tools` produced **no model turn** and exit 0. Silently ignoring the prompt is the worst possible failure. It also collides with `stdio: "inherit"`, which the watched interactive session requires. |
| `printf … \| omp -p --no-tools --mode json` to check for a model turn | Emitted only `{"type":"session",…}` and exited 0 — confirming the prompt was dropped, not merely unprinted. |
| Force approval on with `--config` forcing `always-ask` and expect a *block* | omp does not block in print mode — it **denies**: "Blocked … every write-capable path refused", exit 0, file absent. Good for the non-interactive promise, but it means a stricter user policy produces a silent no-op, which is why Decision 2 documents it instead of papering over it. |
| Raise `INTERACTIVE_AI_TIMEOUT_MS` after the first live run took ~18 s per turn | Unnecessary; the real repair fit well inside 15 minutes. Left alone — an unmotivated timeout change is a behavior change other lanes did not ask for. |
| Add `briefFile`/`timeoutFlag` fields to `AiToolMeta` | `src/types.ts` is read-only for this lane. The implementation instead recognizes the existing `AI_TOOLS.omp` metadata object, while still deriving its executable and prompt prefix from that metadata. A capability field remains the cleaner future shape. |
| `getconf ARG_MAX` at runtime to size the budget | Costs a subprocess spawn on every sync, is absent on Windows, and reports the *total* limit while the binding constraint on Linux is the per-argument `MAX_ARG_STRLEN`. A per-platform constant table minus the measured environ size is deterministic, testable, and cheaper. |
| Truncating an oversized brief to fit | Explicitly forbidden by the acceptance criteria, and rightly: a truncated brief ends mid-file and invites the agent to "repair" a file it cannot see the end of. |

---

## Changes made

| File | Change |
|---|---|
| `src/sync/brief-delivery.ts` | **New.** `briefArgvBudget()` (per-platform argv budget, minus measured environ), `deliverBrief()` (inline under budget; spill whole brief to a temp file + pointer prompt over budget), `BriefDelivery.cleanup()`. |
| `src/sync/index.ts` | `runToolInteractive` routes briefs through `deliverBrief`, uses `AI_TOOLS.omp` metadata plus `--max-time=14m` and native `@file` delivery for oversized OMP briefs, cleans up in `finally`, and reports spawn causes. Tool-picker fallback text now derives from `AI_TOOLS`. |
| `src/graph/cli-ground.ts` | **No change.** Verified rather than assumed: `configuredAgent` (`:133-138`) already selects any configured tool whose `AI_TOOLS[...].cli` is on `PATH` — omp included, since `src/types.ts:21` exists — and delegates to the same `runToolInteractive`, so ground inherits both omp support and the oversize fix. A zero-line diff is the correct diff; `test/sync-brief-delivery.test.ts` pins it. |
| `src/types.ts` | **No change** (read-only for this lane, as instructed). |
| `docs/omp-integration/notes/14-sync-drives-omp.md` | This note. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/sync-brief-delivery.test.ts` → "budget" | The argv budget is positive, shrinks as environ grows, and is per-platform — the thing that decides inline vs spill. |
| → "passes a brief that fits as a positional argument" | No regression for the common path: a small brief still lands in argv verbatim, so existing tools behave exactly as before. |
| → "spills an oversized brief to a file instead of argv" | The acceptance criterion: argv carries a path, not the brief. |
| → "writes the oversized brief whole, byte for byte" | **No silent truncation** — the file content equals the original brief exactly. |
| → "removes the spill directory afterwards" | The temp file is not leaked. |
| → "removes the spill directory even when the spawn fails" | Cleanup is in `finally`, not the happy path. |
| → "reports a spawn error as failure" | Preserves the existing careful `error`-is-not-success behavior (`src/sync/index.ts:53-55`) through the new code path. |
| → "an oversized brief no longer fails with E2BIG through the real spawn" | End-to-end against a real binary: the pre-fix reproduction now succeeds. |
| → "OMP metadata with an inner timeout and an @file" | Pins the measured `promptFlag + --max-time=14m + @spillPath` argv shape without duplicating the CLI or print flag literals. |
| → "`mex graph ground` reaches omp through the same delivery path" | Pins the zero-diff claim for `src/graph/cli-ground.ts` so a future refactor cannot silently drop ground's omp support. |

---

## Verification

- [x] `npm run typecheck`
- [x] `npm run typecheck --workspace mex-mcp`
- [x] `npm run build`
- [x] `npx vitest run` — 467 passed, 4 skipped
- [x] `node dist/cli.js check --quiet` — 100/100
- [x] Non-TTY and explicit `--non-interactive` tests pass in `test/sync.test.ts`
- [x] Scratch dirs cleaned up

### Live run — real `mex sync`, real omp, real repair

Scratch git repo: `.mex/config.json` had `aiTools: ["omp"]`; `package.json` contained an
undocumented `issue14-live-repair` script. Before sync:

```
Drift score: 97/100 — 0 errors, 1 warnings, 0 info
⚠ UNDOCUMENTED_SCRIPT Script "issue14-live-repair" exists in package.json but is not mentioned
```

PTY transcript from the built CLI:

```
$ node dist/cli.js sync --warnings
Running drift check...
Found 1 issues (score: 97/100)

1 file(s) need attention:
  package.json — 0 errors, 1 warnings

1) Interactive — oh-my-pi fixes with you watching (default)
Choice [1-3] (default: 1): 1

Sending all 1 file(s) to oh-my-pi in one session...
Working...
Updated `package.json`:
- Removed the undocumented `issue14-live-repair` script.
- Removed the now-empty `scripts` section.
- Verified `package.json` parses successfully and the script is absent.

Drift score: 97 → 100/100 (+3)
✓ Perfect score. All issues resolved.
```

The repaired `package.json` was read back and a separate
`node dist/cli.js check --quiet` returned `mex: drift score 100/100`. This establishes that the
configured OMP process received the generated brief, acted on its exact issue, returned, and let
mex perform the post-run drift check.

## Follow-ups

Adjacent things found and deliberately not fixed here.

- [ ] Move OMP's prompt-file and timeout capabilities into `AiToolMeta` when `src/types.ts`
      ownership permits. The current bounded branch recognizes the existing `AI_TOOLS.omp` object;
      metadata would make that capability declarative.
- [ ] The brief has **no size budget at all** (`src/sync/brief-builder.ts:117-120`, unbounded
      `getGitDiff`). Delivery no longer breaks, but a brief can still exceed the agent's context
      window, which is a quieter failure. Wants per-target budgeting *with an explicit notice* in the
      brief builder — a separate ticket, not a delivery concern.
- [ ] Could a brief be replaced by tool calls? Partly, and this is signal for #16 rather than work
      here: the `mcp` lane's `mex_graph_scope/get/query` + `mex_impact` already let an agent pull
      graph facts itself, and an omp extension could expose drift issues directly, cutting whole-file
      inlining down to *pointers* plus a repair instruction. That would make brief size a non-issue
      structurally instead of by budget. It does not remove the need for a spawn path: something must
      still start the agent.

## Handoff

Finished. OMP's executable and prompt prefix come only from `AI_TOOLS.omp`; oversized briefs use
its verified `@file` expansion, and its derived 14-minute inner deadline precedes mex's 15-minute
outer timeout (`src/sync/index.ts:41-68`). Print mode cannot block on approval: strict policies fail
closed, and the post-run drift check exposes a no-op.
