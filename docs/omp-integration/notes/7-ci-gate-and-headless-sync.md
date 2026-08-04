# Issue #7 — No CI path: mex check never gates a PR, and mex sync cannot run headless

- **Issue:** https://github.com/thekorsen/mex/issues/7
- **Milestone:** Multi-developer reconciliation
- **Branch:** `omp/ci`
- **Status:** ready for review
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

Make knowledge drift fail a pull request without anyone remembering to run `mex check`, and give
`mex sync` a path that never waits on a human. That needs three things the repo did not have: a
workflow that actually invokes the checker on PRs, a `--json` document a gate can read without
re-deriving severity itself, and a sync mode that emits its repair brief and returns instead of
sitting on stdin.

## Acceptance criteria

From `FLEET-TICKETS/07.md` "## Acceptance" (verbatim):

- [x] A PR that introduces knowledge drift fails CI with a readable message naming the affected files.
- [x] A PR that does not introduce drift passes.
- [x] No CI step requires a TTY.
- [x] The machine-readable contract CI depends on is documented and version-committed.

From `FLEET-TICKETS/07.md` "## Scope" (verbatim):

- [x] 1. A workflow that runs `mex check --json` on PRs and fails on `error`-severity issues.
- [x] 2. A stable, documented machine contract for whatever CI consumes — either add `errors`/`warnings` counts to the `--json` payload or document that consumers must group by severity, and lift that specific surface out of the "best-effort" disclaimer.
- [x] 3. A non-interactive sync mode (`--yes` / `--non-interactive`) that either performs repairs unattended or emits the brief for a bot to hand to an agent, and never blocks on stdin.
- [x] 4. Decide whether CI **reports** drift or **repairs** it (bot commit / PR suggestion). These are different products with different blast radii; the ticket should not be closed on an unstated choice.

**Outstanding, and why these boxes are a claim about local behavior rather than about GitHub:**
the two PR-level criteria are checked on the strength of the local step-by-step equivalent of the
workflow (drift injected → exit 1 with per-file detail; drift restored → exit 0), not on an observed
GitHub Actions run — `act` is not installed on this machine, so the workflow YAML was never executed
in a container (see Dead ends). The first end-to-end confirmation happens when the orchestrator
opens the PR. Scope item 3 is satisfied as "emits the brief", not "performs repairs unattended";
that fork was decided deliberately (Decision 2, Dead ends row 2), not left unfinished.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| `check --json` emitted only `{score, issues, filesChecked, timestamp}` — no top-level severity counts, so every consumer had to reduce `issues` by `severity` itself | `src/reporter.ts:67-70` (before the change) | read-only |
| `check` exits `1` on any error-severity issue | `src/cli.ts:172` (after the change; was `:165`, the line the ticket and `AGENT-ONBOARDING.md:149` cite) | executed |
| An operational failure — no git repo — exited `1` with **empty stdout** and the reason on stderr, which a gate cannot distinguish from real drift; it would read "no scaffold" as "wiki is accurate". Now exits `2` | `src/cli.ts:179`; reproduced in a non-git temp dir (transcript below) | executed |
| The feedback nudge writes to **stderr** and is TTY-gated, so it never pollutes `--json` stdout | `src/feedback/index.ts:102` (TTY gate), `:127-134` (stderr writes) | read-only |
| Telemetry fires from a commander `preAction` hook on **every** command, not just opt-in ones — which is why any workflow or script must set `MEX_TELEMETRY=0` / `DO_NOT_TRACK=1` | `src/cli.ts:55-73` | read-only |
| TTY-bound paths: `askUser` in `src/sync/index.ts`, used at both the mode prompt and the continue prompt; plus `sync.sh:156`, `src/tui.ts:53`, `src/graph/cli-ground.ts:121-122` | `AGENT-ONBOARDING.md:150` ledger row; `src/sync/index.ts:14-22,205,302` per that row | read-only |
| **NEWLY DISCOVERED IN THIS LANE — headless `mex sync` did not block, it silently exited `0` with error-severity drift unrepaired.** `askUser` built a promise from `rl.question`, whose callback never fires on stdin EOF; readline emitted `close`, the promise stayed pending forever, the event loop drained with nothing left to do, and Node exited `0`. With 2 injected errors and stdin `< /dev/null`, sync printed the tool-choice prompt `Which one should we use? [1-1] (default: 1):` and exited `0`. A silent success on unrepaired drift is strictly worse than blocking: a blocked job is visibly stuck, whereas this makes CI go **green** on a repo whose wiki is wrong. `askUser` now rejects loudly on EOF | `src/sync/index.ts` `askUser`; reproduced by execution (transcript below) | executed |
| `counts` is always fully populated with all three severities including zeros, so a consumer can read `.counts.error` with no null check | `countBySeverity` in `src/reporter.ts`; severities are exactly `"error" \| "warning" \| "info"` (`src/types.ts:102`) | executed |
| Each `issues[]` entry is `{ code, severity, file, line, message, claim? }` — `file` is what makes the failure message name the affected files | `src/types.ts:125-133` | read-only |
| `COMPATIBILITY.md:134-142` declares the CLI surface "best-effort, not contract-bound", so scripting CI against these flags was unsupported *by policy* until the carve-out | `COMPATIBILITY.md:134-142` | read-only |
| The local drift trigger is a git `post-commit` hook in `.git/hooks`, untracked by construction, so a teammate who never runs `mex watch` gets zero automatic signal — that is the gap CI closes | `src/watch.ts:37` | read-only |

## Commands run

All executed in this worktree with `MEX_TELEMETRY=0` exported.

```
$ export MEX_TELEMETRY=0 && npm run build && node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)          # exit 0

# with a bogus path + an undocumented script appended to .mex/ROUTER.md:
$ node dist/cli.js check --quiet
mex: drift score 74/100 (2 errors, 2 warnings)   # exit 1
$ node dist/cli.js check --quiet                 # after restoring ROUTER.md
mex: drift score 94/100 (2 warnings)             # exit 0

# in a temp dir that is not a git repo:
$ node <repo>/dist/cli.js check --json           # exit 1 BEFORE the change, 2 after
(stdout empty)
No git repository found. Initialize one first: git init      # stderr

# headless sync BEFORE the fix, with 2 injected errors:
$ timeout 10 node dist/cli.js sync < /dev/null
...
Which one should we use? [1-1] (default: 1): EXIT=0     # silent success, drift unrepaired

# the new --json document, after the change:
$ node dist/cli.js check --json | jq '{score, counts, contractVersion, filesChecked}'
{ "score": 94, "counts": { "error": 0, "warning": 2, "info": 0 },
  "contractVersion": 1, "filesChecked": 12 }
```

The 2 baseline warnings are both `UNDOCUMENTED_SCRIPT` on `package.json`, for the `eval` and
`eval:e2e` scripts. They are pre-existing and were deliberately left alone (see Dead ends).

`act` was **not available on this machine** — `which act` found nothing, and no network install was
attempted — so `.github/workflows/mex-drift.yml` was never executed inside a container. The local
equivalent is the command sequence above, which is exactly what the workflow steps run: build, then
`check --json`, then branch on error-severity count / exit code.

---

## Decisions

### Decision: Add `counts` + `contractVersion` to `--json`, additively

- **Options considered:**
  1. Add top-level severity counts and a contract version to the `--json` payload.
  2. Leave the payload alone and document "group `issues` by `severity` yourself".
- **Chosen:** Add both, strictly additively. The original four field names — `score`, `issues`,
  `filesChecked`, `timestamp` — are untouched, because other lanes and the parent's verification
  scripts already parse that shape.
- **Why:** A gate's only question is "should this build fail". Forcing every consumer to write a jq
  severity reduction puts the same logic in every consumer, where it can differ — one gets
  `severity == "error"` right and the next one greps. `counts` is always fully populated with zeros,
  so `.counts.error` needs no null check and no `// empty` default. `contractVersion` gives consumers
  something to assert on other than the package version, which moves for unrelated reasons.
- **What this rules out:** Renaming or removing any of the four original fields without a major bump.
- **Revisit if:** A consumer needs a breakdown the two counters cannot express (per-file, per-code);
  add another additive field, do not repurpose `counts`.

### Decision: CI reports drift, it does not repair it

- **Options considered:**
  1. Report only — a red check with per-file detail, a human fixes it.
  2. Repair — a bot commit or PR suggestion produced by an unattended `mex sync`.
- **Chosen:** REPORT ONLY.
- **Why:** Repair means a workflow with write permission mutating the committed wiki, which is a
  different product with a much larger blast radius. And `mex sync`'s repair path is an LLM rewriting
  prose — `--dry-run` / non-interactive only emits the brief — so an unattended bot commit would push
  unreviewed generated prose to main. A red check with per-file detail gives the human the signal
  without the risk.
- **What this rules out:** Auto-fix PRs, for now.
- **Revisit if:** A repair path becomes deterministic (non-LLM), or the team explicitly wants a
  bot-authored PR that a human still reviews.

### Decision: New exit code `2` for operational failure

- **Options considered:**
  1. Add exit code `2`, meaning "mex could not complete the check at all".
  2. Keep everything non-zero as `1`.
- **Chosen:** Add `2`, keeping `0` and `1` meaning exactly what they mean today — `0` clean or
  warnings/info only, `1` at least one error-severity issue.
- **Why:** `1` with empty stdout was ambiguous: a gate cannot tell "mex could not run" from "the wiki
  is wrong", and the failure mode is silent and in the wrong direction — a missing scaffold or a
  missing git repo would read as a clean wiki. Any consumer that treats non-zero as failure is
  unaffected by the addition.
- **What this rules out:** Reusing `2` for a drift sub-category later.
- **Revisit if:** A consumer needs finer-grained operational classes — then prefer a field in the
  JSON document, not more exit codes.

### Decision: How much of the CLI to lift out of "best-effort" in `COMPATIBILITY.md`

- **Options considered:**
  1. Promise the minimum CI actually consumes.
  2. Promise the broader CLI surface — commands, flags, human-readable output.
- **Chosen:** The minimum — only the `check --json` document shape and the `check` exit codes.
  Explicitly **not** `sync`'s output prose, and not any other command or flag.
- **Why:** A narrow promise the project can keep beats a broad one it cannot.
  `COMPATIBILITY.md:134-142` remains correct as the default for everything else; the carve-out is an
  exception with a version number attached, not a repeal.
- **What this rules out:** CI depending on human-readable output, or on `sync` brief text.
- **Revisit if:** A consumer files an issue needing more surface, per the existing promotion process.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Running `.github/workflows/mex-drift.yml` with `act` | Not installed on this machine — `which act` returned nothing — and no network install was attempted. Used the local step-by-step equivalent instead (the transcript above runs the same commands the workflow steps run), so the YAML itself is unexecuted until the first real PR. |
| Making headless `sync` actually *perform* repairs unattended | Rejected on the merits, not merely unfinished. The repair path spawns an interactive agent CLI (`runToolInteractive`, stdio inherited) and rewrites whole scaffold files, so "unattended repair" would mean an LLM committing prose with no reviewer. Non-interactive sync therefore emits the brief and returns. |
| Reducing `issues` by severity in the workflow's `jq` instead of adding `counts` | Works, but puts the severity logic in every consumer — the exact duplication `counts` removes. One consumer's reduction drifting from another's is a silent wrong answer. |
| Gating CI on the drift *score* (e.g. fail under 90) rather than on error-severity count | Rejected: the score is a weighted heuristic, so any threshold both fails on harmless warning accumulation and passes real errors that happen to score above the line. Severity is the actual signal; the score is a summary for humans. |
| Editing `.mex/ROUTER.md` to clear the 2 pre-existing `UNDOCUMENTED_SCRIPT` warnings (`eval`, `eval:e2e`) so the repo reads 100/100 | Explicitly forbidden and wrong on its own terms — editing the wiki to make the checker quiet silences the tool's only signal. The gate keys on error severity, so warnings never needed silencing to make CI green. |

---

## Changes made

| File | Change |
|---|---|
| `src/reporter.ts` | Added `CHECK_JSON_CONTRACT_VERSION` and `countBySeverity`; `reportJSON` now emits `counts` and `contractVersion`; `reportQuiet` / `printSummary` reuse the same helper instead of counting inline. |
| `src/cli.ts` | `check` exits `2` on operational failure (was a bare `1` with empty stdout); `sync` gains `--non-interactive`, passed through as `nonInteractive`. |
| `src/sync/index.ts` | `runSync` honours `nonInteractive`, auto-detected when stdin or stdout is not a TTY: prints the repair brief and returns without prompting. `askUser` now rejects loudly on stdin EOF instead of hanging forever. |
| `.github/workflows/mex-drift.yml` | New PR gate: runs `check --json` on `pull_request`, `push`, and `workflow_dispatch` and fails on error-severity issues. |
| `COMPATIBILITY.md` | New `## CI contract` carve-out lifting the `check --json` shape and `check` exit codes out of the best-effort disclaimer. |
| `test/verbose.test.ts`, `test/cli.test.ts`, `test/sync.test.ts` | Contract tests for the `--json` document, the exit codes, and non-interactive sync. |
| `docs/omp-integration/notes/7-ci-gate-and-headless-sync.md` | This note. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/verbose.test.ts` | `--json` stdout is a single parseable document carrying `counts` (all three severities, zeros included) and `contractVersion`; `verboseLog` appears only under `--verbose`, so it never corrupts machine output. |
| `test/cli.test.ts` | `check` exit codes: `0` clean or warnings/info only, `1` on at least one error-severity issue, `2` on operational failure. This is the gate's whole decision surface. |
| `test/sync.test.ts` | Non-interactive `sync` never prompts: it prints the repair brief and returns. Defends against the regression this lane found, where headless sync exited `0` with drift unrepaired. |

---

## Verification

- [x] Acceptance criteria all met — with the caveat recorded under Acceptance criteria: the two
  PR-level criteria rest on the local equivalent, not on an observed GitHub Actions run.
- [x] Ran the actual thing (output pasted above) — clean `94/100` exit 0, injected drift `74/100`
  exit 1, restored `94/100` exit 0, non-git dir exit 2 with empty stdout, and the new `--json`
  document read back through `jq`.
- [ ] `npm test` passes — **not run in this lane.** The orchestrator runs the final gates for the
  whole lane; per the lane constraints I skipped every build/test/lint gate.
- [ ] `npm run build` passes — **not run by me** as a gate. The build in the transcript above was the
  one the orchestrator ran to produce the `dist/cli.js` I exercised; the final verifying build is the
  orchestrator's.
- [ ] `mex check` did not regress from `94/100` — **not claimed as a gate result by me.** The score
  read `94/100` in the transcript above after restoring `.mex/ROUTER.md`, but the authoritative
  post-merge regression check is the orchestrator's.
- [x] Docs updated where behavior changed — `COMPATIBILITY.md` carve-out plus this note.
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2 — no `[INFERENCE]`
  from §4.3 was resolved here. One §4.1 row is now **stale** and needs the parent's correction; see
  Handoff. I did not edit `AGENT-ONBOARDING.md`, which the orchestrator owns.
- [x] Worktrees / scratch dirs cleaned up — the non-git temp dir used for the exit-`2` reproduction
  is gone; `.mex/ROUTER.md` was restored and re-verified at `94/100`.

## Follow-ups

- [ ] `mex_sync` is still not exposed over MCP, deliberately deferred until its return shape settles
  (`CHANGELOG.md:48`). The `nonInteractive` path added here is arguably the shape that makes it
  exposable, but wiring it is out of this lane.
- [ ] `sync.sh:156`, `src/tui.ts:53`, and `src/graph/cli-ground.ts:121-122` remain TTY-bound. None
  are in this lane's owned files, and no CI step touches them, so they were left alone.
- [ ] The `post-commit` hook installed by `mex watch` remains untracked by construction
  (`src/watch.ts:37`), so local drift triggering is still per-developer opt-in. CI closes the shared
  gap, not the local one.
- [ ] No scheduled/cron drift job was added — the workflow triggers on `pull_request`, `push`, and
  `workflow_dispatch` only. Staleness drift is time-based, so it can appear with no commit to gate;
  a cron run would catch that.

## Handoff

The lane is complete pending the orchestrator's final gates (`npm run build`, `npm test`, the
`94/100` regression check) and the commit — I ran none of those by design.

One ledger correction the parent must make, in a file this lane does not own:
`AGENT-ONBOARDING.md` §4.1's last row (`:134`) records the **old** `--json` shape —
`{score, issues, filesChecked, timestamp}` with "**no** top-level `errors`/`warnings` counts". That is
now wrong. It must be updated to the six-field shape: `{score, issues, filesChecked, timestamp,
counts, contractVersion}`, where `counts` carries all three severities including zeros. While there,
`§4.2:149`'s exit-code line cites `src/cli.ts:165` for `process.exit(1)`; that call is now at
`src/cli.ts:172`, and `2` for operational failure at `src/cli.ts:179` is a third code the line does
not mention.
