# Issue #11 — `mex-mcp` has process-global state that leaks across `projectRoot`s

- **Issue:** https://github.com/thekorsen/mex/issues/11
- **Milestone:** Correctness — harness-independent bugs
- **Branch:** `omp/mcp` (this lane lands #11 with #10 — the issue map binds them: "#10 should land with or after #11", `docs/omp-integration/AGENT-ONBOARDING.md:243`)
- **Status:** ready for review
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

`packages/mex-mcp` is the only long-lived, multi-repo entry point in the codebase: one process, many `projectRoot`s arriving one call at a time. Three pieces of module-level state were keyed by *process* rather than by *project root*, so an answer depended on which repo happened to be asked first. Make the per-repo state actually per-repo, so N sequential MCP calls against N roots behave like N independent CLI invocations.

## Acceptance criteria

- [ ] Two sequential MCP calls against two different `projectRoot`s produce results identical to two independent CLI invocations — including nudges.
- [ ] A test exercising two project roots through the same in-process server instance.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| Drift nudge flags were two module-level booleans; now two `Set<string>` keyed by project root | `src/drift/index.ts:23-29` | read-only (post-fix source) |
| Both nudge gates now test `graphUpgradeNudgeShown.has(projectRoot)` / `graphMigrationNudgeShown.has(projectRoot)` and `.add(projectRoot)`; `projectRoot` is destructured from the config at `src/drift/index.ts:69` | `src/drift/index.ts:86-96` | read-only |
| Pre-fix consequence: in a long-lived server, repo A's first check set the flag and suppressed the "Run `mex graph`, then `mex graph ground`" nudge for **every other repo** for the process lifetime. That nudge is the only signal a repo has no graph, so repo B silently looked healthy | ticket text `FLEET-TICKETS/11.md:18`; nudge string `src/drift/index.ts:88-90` | read-only |
| `SimpleGit` singleton `let _git: SimpleGit \| null` replaced by `const gitByRoot = new Map<string, SimpleGit>()`; `getGit(cwd)` resolves `cwd ?? process.cwd()` and memoizes per resolved root | `src/git.ts:3-18` | read-only |
| The old bug was a **landmine, not a live bug**: pre-fix `getGit` rebuilt the handle *whenever* a `cwd` was passed (`if (!_git \|\| cwd)`), and every caller passes one, so all real call paths were safe **by accident** | pre-fix shape quoted at `FLEET-TICKETS/11.md:20-25`; the four callers are `src/git.ts:26,45,66,78` (pre-fix `:18,37,58,70`) | read-only |
| One no-arg `getGit()` anywhere would have pinned repo A's handle for repo B for the process lifetime — the accident was a single careless call away from cross-repo git answers | `src/git.ts:10-18`; the post-fix map removes the failure mode rather than relying on the rebuild-on-`cwd` accident | read-only |
| The fix needed **no callsite changes** — `getGit`'s signature is unchanged (`cwd?: string`) and both out-of-module consumers already thread a root: `daysSinceLastChange`/`commitsSinceLastChange` take `cwd` at `src/drift/checkers/staleness.ts:71,77-78`, fed `projectRoot` from `src/drift/index.ts:120-123`; `getGitDiff` is passed `projectRoot` at `src/sync/brief-builder.ts:106` | `src/git.ts:10`, `src/drift/checkers/staleness.ts:71,77-78`, `src/drift/index.ts:120-123`, `src/sync/brief-builder.ts:106` | read-only |
| `getLog` (`src/git.ts:74-79`) has no caller anywhere in `src/` or `packages/`, so it adds no further root-leak path | grep for `getLog` across `src/` and `packages/` matches only its definition | executed (grep) |
| **Residual, deliberately not fixed:** `isDevRepo()` still walks up from `process.cwd()` looking for the nearest `package.json` | `src/global-config.ts:124-129` — `let dir = process.cwd();` at `:129` | read-only |
| The residual's sole caller is step 3 of the telemetry enablement gate | `src/telemetry/index.ts:57` — `if (isDevRepo()) return { enabled: false, reason: "dev" };` | read-only |
| For a stdio server, `process.cwd()` is wherever the harness launched the process, which bears no relation to the `projectRoot` a given call targets — each tool resolves its own root per call | `src/global-config.ts:129`; per-call resolution e.g. `packages/mex-mcp/src/tools/check.ts:15-19` | `[INFERENCE]` on the user-visible effect — settled by launching `packages/mex-mcp/dist/index.js` from a non-mex cwd with `MEX_TELEMETRY` unset and reading back `telemetryStatus().reason` for a call whose `projectRoot` *is* the mex repo |
| The residual's impact is currently inert here: `MEX_TELEMETRY=0` short-circuits at step 2, before `isDevRepo()` is consulted | `src/telemetry/index.ts:52-54` precedes `:57`; `MEX_TELEMETRY=0` is mandatory per `docs/omp-integration/AGENT-ONBOARDING.md:177,182` | read-only |
| Ledger entry this ticket partially supersedes: "**Process-global state:** `src/drift/index.ts:23-24` (nudge flags), `src/git.ts:3-10` (SimpleGit singleton), `src/global-config.ts:129` (`isDevRepo()` walks up from `process.cwd()`)" — the first two are fixed, the third stands | `docs/omp-integration/AGENT-ONBOARDING.md:148` | read-only |

## Commands run

Proof that the isolation test actually catches the bug: the pre-fix code was
restored temporarily (module-level `let … = false` plus the `_git` singleton),
the test run, then the fix restored and `git status -- src/` confirmed clean.

```
$ npx vitest run test/mcp-project-isolation.test.ts     # against PRE-FIX code
 × nudges every project root, not just the first one checked
   → expected [] to have a length of 1 but got +0
 × still nudges a given root only once, so the fix is per-root and not a removed guard
   → expected [] to have a length of 1 but got +0
 ✓ keeps two roots' drift reports independent
 × hands each root its own handle and reuses one handle per root
   → expected Git2{ …(3) } to be Git2{ …(3) } // Object.is equality
 Tests  3 failed | 1 passed (4)

$ npx vitest run test/mcp-project-isolation.test.ts     # against the fix
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Lane gates, run once at the end:

```
$ npm run build && npm run build --workspace mex-mcp
ESM ⚡️ Build success in 76ms
DTS ⚡️ Build success in 1318ms
[copy-graph-assets] copied schema.sql + 5 grammar wasm file(s) to dist/
ESM ⚡️ Build success in 15ms

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

### Decision: key the per-repo state by project root rather than threading a request-scoped context

- **Options considered:**
  1. Replace each module-level flag/handle with a `Map`/`Set` keyed by the resolved project root.
  2. Introduce a request-scoped context object (one per MCP call / CLI invocation) and thread it through `runDriftCheck` into every checker, carrying the nudge state and the git handle.
  3. Reset the module-level state at the top of every `runDriftCheck` call.
- **Chosen:** (1) — `const graphUpgradeNudgeShown = new Set<string>()` / `graphMigrationNudgeShown = new Set<string>()` (`src/drift/index.ts:28-29`) and `const gitByRoot = new Map<string, SimpleGit>()` (`src/git.ts:8`).
- **Why:** Option (2) is the architecturally cleaner answer and also a wide refactor: the context has to reach `src/drift/checkers/**`, whose signatures a **sibling lane owns concurrently** in this fleet, and two writers over the same signatures is a guaranteed collision. The ticket's own scope note prices the keyed fix as "a two-line change" (`FLEET-TICKETS/11.md:36`). Keying is the boring option, it is provably sufficient for the stated failure mode, and it stays inside this lane's file budget. Option (3) is not semantics-preserving: the flag exists to make the nudge once-per-root, and a per-call reset would re-emit it on every call for the same root — trading a silence bug for a noise bug. `Set`-keying preserves the original once-only semantics, per root.
- **What this rules out:** It is still **process-lifetime memory that never evicts**. The two `Set`s and the `Map` grow one entry per distinct project root served and are never pruned, and a `SimpleGit` handle is not free. For a per-project MCP server the bound is 1; for an omp session using `--add-dir` it is a handful — small, so this is acceptable today. It also declines the cleaner seam: any future need for genuinely per-call state (cancellation, per-request logging, a request id in telemetry) will still want option (2), and this change does not move toward it.
- **Revisit if:** a server ever serves an unbounded or externally-chosen set of roots (a hosted/daemonized mex, or a harness passing arbitrary `projectRoot` strings) — then the maps need an LRU bound, or option (2). Also revisit once the sibling checker refactor lands, since the wide-context option gets much cheaper when those signatures are already being touched.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Threading a request-scoped context object through `runDriftCheck` → `src/drift/checkers/**` | Right design, wrong moment: a sibling fleet lane holds `src/drift/checkers/**` concurrently, so this lane cannot change those signatures without a merge collision. Deferred to the Decisions "revisit if". |
| Resetting the nudge flags at the start of each `runDriftCheck` | Not equivalent to the original behavior. The flags make the nudge once-per-*root*; a per-call reset makes it once-per-*call*, so a repeatedly-checked repo is nudged on every call. Swaps a silence bug for a noise bug. |
| Removing `getGit`'s no-arg overload entirely, as `FLEET-TICKETS/11.md:36` suggests | Considered, not taken. The premise is that "the compiler will find every caller" — but all four callers already pass `cwd` (`src/git.ts:26,45,66,78`), so the compiler finds nothing, and the signature change would break a function reachable from the git surface for zero behavioral gain. The `Map` closes the hole without touching the signature. |
| Fixing `isDevRepo()` in the same pass | `src/global-config.ts` is outside this lane's owned file set. Recorded as an explicit residual with its blast radius instead of silently widening scope — `docs/omp-integration/AGENT-ONBOARDING.md:17`. |

---

## Changes made

| File | Change |
|---|---|
| `src/drift/index.ts:23-29` | `let graphUpgradeNudgeShown = false` / `let graphMigrationNudgeShown = false` → `const … = new Set<string>()`, with a comment recording why (long-lived server, per-call `projectRoot`). |
| `src/drift/index.ts:86-96` | Both nudge gates keyed on `projectRoot` (`!shown.has(projectRoot)` → `shown.add(projectRoot)`). The nudge is now once-per-project-root rather than once-per-process. |
| `src/git.ts:3-18` | `let _git: SimpleGit \| null` singleton → `const gitByRoot = new Map<string, SimpleGit>()`; `getGit(cwd)` memoizes on the resolved root. Signature unchanged; no callsite changed. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/mcp-project-isolation.test.ts` | The #11 acceptance criterion, in one process: two temp project roots driven through `runDriftCheck` **both** receive the graph-upgrade nudge (a process-global boolean swallows root B's), a second check of root A does **not** re-nudge (per-root once-only, proving the flag was keyed rather than deleted), and `getGit(rootA) !== getGit(rootB)` while `getGit(rootA) === getGit(rootA)` — the per-root keying that replaced the `SimpleGit` singleton. |
| `test/mcp-graph-tools.test.ts` | Belongs to #10, but drives the same server over raw stdio; see [`10-graph-retrieval-over-mcp.md`](./10-graph-retrieval-over-mcp.md). |

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (output pasted above) — plus a raw-stdio drive of all 9 MCP tools
- [x] `npm test` passes — 380 passed (39 files)
- [x] `npm run build` passes — root and `mex-mcp` workspace
- [x] `mex check` did not regress from `94/100` — still `94/100 (2 warnings)`
- [x] Docs updated where behavior changed — `AGENT-ONBOARDING.md` §4.2 records the fixed/unfixed split
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2
- [x] Worktrees / scratch dirs cleaned up — no worktrees created; `/tmp` probes removed

## Follow-ups

- [ ] Have `isDevRepo()` take the resolved project root instead of reading `process.cwd()` (`src/global-config.ts:129`; sole caller `src/telemetry/index.ts:57`). Blast radius: telemetry enablement can flip based on the server's launch directory, independent of which repo a call targets — launched inside the mex dev repo it reports `reason: "dev"` for every repo it serves; launched elsewhere it does not. The fix is to thread the resolved project root in as a parameter and pass it from the one caller. Third bullet of `FLEET-TICKETS/11.md:27`, deferred here because the file is outside this lane's owned set. Currently inert under `MEX_TELEMETRY=0` (`src/telemetry/index.ts:52-54`) — `[INFERENCE]` on real-world impact, settled by the launch-from-foreign-cwd probe described in Findings.
- [ ] Bound or evict `gitByRoot` and the nudge `Set`s if mex ever serves an unbounded set of roots (Decisions → "Revisit if").
- [ ] The request-scoped-context refactor across `src/drift/checkers/**`, once the sibling lane's signature changes have landed.

## Handoff

Both owned fixes are applied and self-contained; nothing about #11 is half-done in this lane. The single open thread is the `isDevRepo()` residual, which is a deliberate scope boundary rather than an unfinished edit — the next session should file it as its own issue against `src/global-config.ts` + `src/telemetry/index.ts` instead of reopening this one. Gate output comes from the parent orchestrator, which runs the gates once for the whole lane.
