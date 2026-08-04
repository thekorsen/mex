# Issue #9 — Staleness has no upstream awareness: `getGitDiff` is hardcoded to `HEAD~5..HEAD`

- **Issue:** https://github.com/thekorsen/mex/issues/9
- **Milestone:** Multi-developer reconciliation
- **Branch:** `omp/staleness`
- **Status:** in progress
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

mex's staleness checker is the only part of the tool that can see *other people's* work, and
it is looking at the wrong thing. It asks "how far is this page from `HEAD~5`", a window with
no meaning on a shared repo — five commits is one developer's afternoon or the whole team's
week. Teach it to measure against a real branch point (merge-base with a tracked upstream),
degrade honestly when there is no upstream, and settle what a "commit" even counts as when
the repo has merge commits — because until that is pinned, the shipped 50/200 thresholds mean
different things to a squash-merge team and a merge-commit team.

## Acceptance criteria

Verbatim from the issue:

- [ ] Staleness reflects the delta against a meaningful base, not the last 5 commits.
- [ ] Documented behavior when no upstream is configured or refs are stale.
- [ ] The per-file full-log scan is either eliminated or measured and justified.
- [ ] A test asserting merge-commit handling matches documented intent.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| `getGitDiff` hardcodes a 5-commit window | `src/git.ts:59` — `git.diff(["HEAD~5","HEAD","--",...paths])` | read-only (ledger §4.2) |
| `totalCommits` is computed and never used | `src/git.ts:42` | read-only (ledger §4.2) |
| `commitsSinceLastChange` loads the FULL repo log once per knowledge file | `src/git.ts:41` inside a function called per file from `src/drift/index.ts:115` | read-only |
| `--follow` is a **no-op for a `-1` lookup** — corrects my own earlier claim | probe: rename `a.md`→`b.md`→`c.md`, query `-1` with and without `--follow` → **identical sha** both ways (a rename commit touches the new path, so it is found regardless). Differs only for full-history walks: 5 commits vs 1 | **executed** |
| Therefore the `git log -1 --follow` + `rev-list --count` rewrite is behaviour-preserving | both old (`log({file, maxCount:1})`) and new code do `-1` lookups, so no history is lost by the refactor. `--follow` is retained anyway: it is free, and documents the intent | **executed** |
| **simple-git's default `log()` INCLUDES merge commits** | probe: `log().all.length` = 200 = `git rev-list --count HEAD`; all 24 merge shas from `git log --merges` found in `log().all` | **executed** — resolves §4.3 |
| **`git.log({ file })` compiles to `git log --follow <pathspec>`** | `node_modules/simple-git/dist/cjs/index.js`, the `filterString(opt.file)` branch pushes `"--follow"` | **executed** (source read of the installed dep + behavioural confirmation) |
| `--follow` is load-bearing, not incidental | `git log --follow -- .mex/ROUTER.md` = 11 commits; `git log -- .mex/ROUTER.md` = 1. `--name-status` shows 4 renames: `scaffold/HANDOVER.md`→`HANDOVER.md`→`ROUTER.md`→`.mex/ROUTER.md` | **executed** |
| The four counting modes disagree materially | `.mex/ROUTER.md`: today's `findIndex`=36, `rev-list --count`=36, `--no-merges`=32, `--first-parent`=6 | **executed** |
| Today's count is list-position, not reachability | `findIndex` over a flat date-ordered `log().all`; `rev-list` walks the DAG. Equal here (36) but conceptually different | **executed** |
| Full-log cost scales with total history; `rev-list` with distance | 3001-commit repo, 12 files, above a 25.3 ms/spawn floor: full `log()` **29.4 ms/file**; `rev-list --count` **4.0 ms** at distance 100, **16.3 ms** at distance 3000 | **executed** |
| `StalenessThresholds` cannot gain fields in this lane | declared `src/types.ts:25-34` (anchors lane owns), rebuilt field-by-field `src/config.ts:151-156` (worktree lane owns) | read-only |
| This worktree has no upstream branch | `git rev-parse --abbrev-ref --symbolic-full-name '@{u}'` → `fatal: no upstream configured for branch 'omp/staleness'`; but `origin/HEAD` → `origin/main` resolves | **executed** |

### Edge-case behaviour, measured

Probed in throwaway repos under `/tmp/mex-probe.*` (all cleaned up):

| State | What git actually does | Required degradation |
|---|---|---|
| zero commits (`git init` only) | `rev-parse HEAD`, `rev-list --count HEAD`, `log -1 -- <file>` **all** exit fatal | `source:"local"`, `ref:null`, counts null |
| 1 commit, no remote | `@{u}` fatal; `origin/HEAD` fatal; `<sha>..HEAD` → `0`; never-committed file → empty sha | `source:"local"` + `note` |
| shallow clone `--depth 1` (CI default) | `--is-shallow-repository` → `true`; `@{u}` → `origin/main`; `merge-base` still resolves; `--follow` history truncated to 1 | counts returned but `shallow:true`, flagged as lower bounds |
| detached HEAD | `rev-parse --abbrev-ref HEAD` prints literal `"HEAD"`; `@{u}` fatal; `merge-base HEAD origin/main` works | fall through ladder to `remote-head` |
| knowledge file never committed | `git log -1 --format=%H -- <file>` → empty stdout, **exit 0** | null, no issue |

## Commands run

```
$ node -e "require('./node_modules/simple-git/package.json').version"
3.36.0

$ git rev-list --count HEAD ; git rev-list --count --no-merges HEAD ; git log --oneline --merges | wc -l
200
176
24

# PROBE 1 — the §4.3 question, settled
simple-git log().all.length      = 200
git rev-list --count HEAD        = 200
merge commits in history         = 24
merge commits present in log()   = 24
=> default log() INCLUDES merges = true

# PROBE 2 — log({file}) is --follow
$ git log --follow --format=%h -- .mex/ROUTER.md | wc -l
11
$ git log --format=%h -- .mex/ROUTER.md | wc -l
1
$ git log --follow --name-status --format=%h -- .mex/ROUTER.md | grep ^R
R100    ROUTER.md       .mex/ROUTER.md
R089    HANDOVER.md     ROUTER.md
R100    scaffold/HANDOVER.md    HANDOVER.md
R100    HANDOVER.md     scaffold/HANDOVER.md

# PROBE 3 — counting modes disagree
file                               curIdx all noMrg 1stP
.mex/ROUTER.md                         36  36    32    6
.mex/AGENTS.md                         36  36    32    6
.mex/context/architecture.md           28  28    24    6

# PROBE 4 — cost, isolating git work from process-spawn floor
repo: 3001 commits, 12 knowledge files
spawn floor (12 trivial spawns)      304ms  -> ~25.3ms/spawn
12x full log() parse (3001 commits)  656ms  ->  29.4ms/file above floor
12x rev-list --count (distance 3000) 500ms  ->  16.3ms/file above floor
12x rev-list --count (distance 100)  352ms  ->   4.0ms/file above floor

$ MEX_TELEMETRY=0 node dist/cli.js check --quiet     # baseline, before changes
mex: drift score 94/100 (2 warnings)
```

---

## Decisions

### Decision: merge commits do NOT count toward staleness thresholds

This is the §4.3 inference the ticket required me to settle. It is settled empirically:
**simple-git's default `log()` includes merge commits** (24/24 merge shas present;
`all.length` == `rev-list --count HEAD` == 200). So today's thresholds silently count merges.

- **Options considered:**
  1. **Count everything (`--all`, status quo).** Simplest, zero migration. But a merge commit
     is a second recording of work its own constituent commits already represent, so a
     merge-flow team crosses 50/200 faster than a rebase-flow team for *identical* authored
     work. Measured here: 36 vs 32 on `.mex/ROUTER.md` — 12% inflation on a repo that is only
     12% merges, and unbounded on a heavy PR-merge repo.
  2. **Count only mainline integration events (`--first-parent`).** Appealing framing: "how
     many PRs landed since this page was written". Measured 6 vs 36 — a *different scale*
     entirely, so the shipped 50/200 defaults would need retuning, and it collapses to
     near-zero on rebase-flow repos that have no merge commits at all. Rejected.
  3. **Count authored commits only (`--no-merges`).** Chosen.
- **Chosen:** `--no-merges` is the default. Mode is explicit and overridable via
  `CommitCountMode = "all" | "no-merges"`, exported and pinned by a test.
- **Why:** it makes "50 commits" mean "50 units of authored change" on every workflow, which
  is the only reading under which a shared threshold is meaningful. It also stays on the same
  *scale* as today's behaviour (32 vs 36), so the shipped 50/200 defaults keep their meaning
  and no user's config silently changes severity. A threshold that means different things on a
  rebase-flow repo versus a merge-flow repo is a bug even when no line of code is wrong.
- **What this rules out:** the "how many PRs landed" framing (that is `--first-parent`, and it
  needs its own thresholds — a follow-up, not this ticket). Also rules out treating a squashed
  merge as one unit: a squash *is* a single non-merge commit and counts as 1, which is correct
  under this reading.
- **Revisit if:** a team wants PR-count semantics; then add `"first-parent"` to
  `CommitCountMode` **with its own threshold pair**, never reusing 50/200.

### Decision: never run `git fetch` from a check command

- **Options considered:**
  1. `git fetch` before comparing, so "what landed upstream" is actually current.
  2. Operate only on already-local refs, and say when they may be stale.
- **Chosen:** (2). `resolveComparisonBase` performs **no network I/O**.
- **Why:** `mex check` is run in loops, in pre-commit paths, by agents, and in CI. A network
  call there is a hang risk, an auth-prompt risk, and an offline failure — to make a *warning*
  marginally fresher. The `ComparisonBase.note` field carries the honesty instead.
- **What this rules out:** mex ever reporting "3 commits landed upstream 5 minutes ago"
  without the user having fetched. Correct trade: the number is a floor, and says so.
- **Revisit if:** an explicit `mex check --fetch` opt-in is requested.

### Decision: `getGitDiff` diffs `<base>`, not `<base>..HEAD`

Found by smoke-testing the finished code on this worktree, not by a test — worth recording
because the whole suite was green while the function returned nothing useful.

- **Symptom:** `getGitDiff(["src/git.ts"])` returned **0 bytes** for a file with 304 lines of
  uncommitted changes. The old `HEAD~5..HEAD` was equally blind, so this is a latent bug the
  ticket inherited rather than one it introduced.
- **Cause:** a two-dot range compares two *commits*. Uncommitted work is invisible to it.
- **Options considered:**
  1. `<mergeBase>..HEAD` — committed history only.
  2. `<mergeBase>` (no range) — base vs the **working tree**.
- **Chosen:** (2). Verified: 0 lines vs 304 lines for the same file.
- **Why:** `getGitDiff`'s only consumer is the `mex sync` brief
  (`src/sync/brief-builder.ts:106`), which shows an agent what changed about the paths a
  knowledge page claims. Work in progress is *exactly* what that agent must see; a page is
  usually resynced **before** the work is committed. Committed-only would make the brief
  arrive empty in the common case.
- **What this rules out:** using `getGitDiff` as a pure "what landed upstream" query. That
  question is answered by `ComparisonBase.behind`, which is commit-based and unaffected.
- **Revisit if:** a caller needs committed-only history; add an explicit option rather than
  changing this default.

### Decision: `ComparisonBase.ref` is a short ref name

- **Symptom:** the first working version reported `refs/remotes/origin/main`, which would have
  reached users inside `STALE_FILE` messages.
- **Chosen:** `git rev-parse --abbrev-ref` instead of `--symbolic-full-name`, giving
  `origin/main`.
- **Why:** verified that `--abbrev-ref` still exits **non-zero** on an unresolvable ref
  (`does/not/exist` → exit 128), so the graceful-degradation ladder is unaffected. Purely a
  legibility win with no behavioural cost.

### Decision: the comparison-base fallback ladder

- **Options considered:** hardcode `origin/main`; require config; or a precedence ladder.
- **Chosen:** ladder, most specific first — explicit ref → branch `@{upstream}` →
  `origin/HEAD` (else the sole remote's HEAD) → `local` (no upstream, `ref:null`).
- **Why:** `@{upstream}` is what the user's own git already believes; hardcoding `origin/main`
  is wrong on a fork (this repo has both `origin` and `upstream` remotes) and on `master`
  repos. The `local` rung exists so a fresh `git init` project reports "no upstream" rather
  than fabricating a base. Verified necessary: this very worktree has **no** `@{u}` but does
  resolve `origin/HEAD`, so rung 3 is the one that fires here.
- **What this rules out:** silently comparing against an unrelated default branch.

### Decision: new tunables do NOT go into `StalenessThresholds`

- **Chosen:** `CommitCountMode` / `STALENESS_COMMIT_COUNT_MODE` are separate exports; the new
  checker inputs arrive through the existing optional `opts` object.
- **Why:** two hard constraints. `StalenessThresholds` is declared in `src/types.ts:25-34`
  (owned by a sibling lane this wave) and reconstructed **field-by-field** in
  `src/config.ts:151-156` (another sibling lane), so a new field would be silently dropped by
  the config loader *and* collide on merge. And `DEFAULT_STALENESS_THRESHOLDS` is public API
  (`src/index.ts:33`) asserted at `test/public-api.test.ts:101-106`.
- **What this rules out:** setting the count mode from `.mex/config.json` in this ticket. It is
  a one-line addition in `loadStalenessThresholds` once that file is free — noted as a follow-up.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Use `--first-parent` as the counting mode — "commits since" really means "PRs landed since" | Measured 6 vs 36 on `.mex/ROUTER.md`. A *different scale*, so shipped 50/200 defaults become meaningless, and on a rebase-flow repo with zero merges every count collapses toward the linear history anyway. Right idea, wrong ticket: it needs its own thresholds. |
| Replace `git.log({ file })` with plain `git log -- <file>` while eliminating the full scan | `log({file})` secretly compiles to `git log --follow`, and `.mex/ROUTER.md` has 4 renames, so for a **full-history** walk this drops 11 commits to 1. Found only by reading the installed simple-git source. **Refined by a later probe:** `--follow` is a *no-op for a `-1` lookup* (a rename commit touches the new path, so it is found either way), which is what makes the final `git log -1 --follow` + `rev-list --count` rewrite provably behaviour-preserving. `--follow` is kept regardless: free, and it documents the intent. |
| Add `countMerges` / `upstreamRef` to `StalenessThresholds` | Owned by two sibling lanes (`src/types.ts`, `src/config.ts`) and the config loader rebuilds the struct field-by-field, so a new field is dropped on load. Would also merge-collide. |
| Add a new issue code (e.g. `STALE_UPSTREAM`) for the code-drift signal | A parallel CI lane is building a PR gate on this checker's error-vs-warning severity. A new code changes their gate silently. Folded into the existing single `STALE_FILE` issue instead — which also preserves the deliberate "one condition costs the score once" behaviour at `src/drift/checkers/staleness.ts:60-67`. |
| Wire the new `claimedPaths`/`base` signal directly into the `checkStaleness` call in `src/drift/index.ts` | That file is owned by the anchors lane this wave (it is gaining a checker registration line). Capability ships fully tested but inert at the production callsite; activating it is a 3-line change once that file is free. Recorded as a follow-up rather than a merge conflict. |
| Judge the full-log scan by wall-clock speedup alone | First measurement showed only 1.19x on this repo and 1.3x on a 3001-commit repo — misleadingly weak, because ~25 ms/spawn of process cost dominates both sides. Isolating the spawn floor showed the real difference: 29.4 ms/file that grows with **total history** versus 4.0 ms that grows only with **distance**. The complexity change is the finding, not the raw ratio. |
| `git worktree add` to reproduce detached HEAD | Lane rules forbid creating worktrees (the parent manages them). `git clone file://… && git checkout --detach` reproduces the same state — literal `"HEAD"` from `--abbrev-ref`, fatal `@{u}` — without touching worktree state. |
| Trust a green test suite as proof `getGitDiff` worked | All 388 tests passed while `getGitDiff` returned **0 bytes** for a file with 304 lines of uncommitted changes. Only smoke-testing the real function on the real worktree exposed it. Two-dot `<base>..HEAD` cannot see the working tree, and `mex sync`'s brief is *built* to show uncommitted work. Tests now pin it (`test/git-upstream.test.ts`, "includes uncommitted work"), verified by mutation. |
| Report `ComparisonBase.ref` straight from `--symbolic-full-name` | Yields `refs/remotes/origin/main`, which would leak into user-facing `STALE_FILE` messages. `--abbrev-ref` gives `origin/main` and — verified — still exits non-zero on an unresolvable ref, so the degradation ladder is unaffected. |

---

## Changes made

| File | Change |
|---|---|
| `src/git.ts` | Added `CommitCountMode`, `DEFAULT_COMMIT_COUNT_MODE`, `ComparisonBase`, `resolveComparisonBase`, `commitsTouchingPaths`. Reworked `commitsSinceLastChange` to `git log -1 --follow` + `rev-list --count` (kills the full-repo-log scan **and** the dead `totalCommits`). Rewrote `getGitDiff` to diff `<mergeBase>` (working-tree-inclusive) instead of `HEAD~5..HEAD`. Refs resolved with `--abbrev-ref` for legibility. `getGit` (lines 3-10) untouched — byte-identical, verified. |
| `src/drift/checkers/staleness.ts` | Added `STALENESS_COMMIT_COUNT_MODE`; threads the count mode into `commitsSinceLastChange`; new optional upstream code-drift signal (`claimedPaths` + `base`), inert unless both are supplied. Still at most one `STALE_FILE` per file. |
| `test/staleness.test.ts` | Extended by 12 tests: mode default pinned, mode threaded through, upstream signal inert/active boundaries, combined-signal collapse, shallow lower-bound wording, null degradation. |
| `test/git-upstream.test.ts` | **New**, 9 real-git integration tests: five edge cases, merge-mode arithmetic, rename survival, working-tree diff, ref legibility. |
| `test/checkers.test.ts` | Two lines added to its `vi.mock("../src/git.js")` factory. **Not in my owned list** — but my new import broke it (`vi.mock` replaces the whole module, so a partial factory leaves new symbols undefined). Flagged to parent. |
| `docs/omp-integration/AGENT-ONBOARDING.md` | §4.3 merge-commit inference struck and promoted; six new §4.1 execution-verified rows; §4.2 staleness line rewritten to post-#9 line numbers. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `STALENESS_COMMIT_COUNT_MODE === "no-merges"` | The documented intent from the decision above. Stops a silent change to what "50 commits" means. |
| mode threaded into `commitsSinceLastChange`; `"all"` override reaches the git layer | The default is actually applied, not merely declared. |
| upstream signal inert without `claimedPaths` **and** `base.mergeBase` | The production callsite's behaviour is unchanged today. Catches an accidentally-active signal. |
| `all - noMerges === 1` on a repo with a real `--no-ff` merge, and default == `no-merges` | Merge-commit handling — the ticket's explicit requirement. **Mutation-verified twice:** flipping the default to `"all"` fails it, and dropping `--no-merges` from the `rev-list` args fails it. |
| `commitsSinceLastChange` still returns a real number after a `git mv` | The file's identity survives a rename. Guards against returning `null`, not an off-by-one (`--follow` is a no-op for `-1`). |
| zero-commit / no-remote / shallow / detached-HEAD all degrade without throwing | "unknown staleness" is acceptable; a stack trace is not. |
| `getGitDiff` on a repo with <5 commits returns without throwing | The user-visible bug: `HEAD~5` is fatal on a young repo. |
| `getGitDiff` includes **uncommitted** work | The `mex sync` brief must show work in progress. **Mutation-verified:** restoring `<base>..HEAD` fails it. Caught a real bug a green suite had missed. |
| `ComparisonBase.ref` is `origin/main`, never `refs/remotes/...` | The ref reaches users in `STALE_FILE` messages. **Mutation-verified:** reverting to `--symbolic-full-name` fails it. |

---

## Verification

- [x] Acceptance criteria all met — all four, see below
- [x] Ran the actual thing (`node dist/cli.js check --quiet` → `94/100`, plus a live
      `resolveComparisonBase`/`getGitDiff` smoke run on this worktree; output in the report)
- [x] `npx vitest run` → **390 passed (38 files)**, up from 336
- [x] `npm run build` → success; `npx tsc --noEmit` → exit 0
- [x] `mex check` did not regress from `94/100 (2 warnings)` — identical, same two
      `UNDOCUMENTED_SCRIPT` warnings
- [x] Docs updated — ledger §4.1/§4.2/§4.3; no `COMPATIBILITY.md`/`README.md` change needed
      (no public-API surface changed: `src/index.ts` untouched, `DEFAULT_STALENESS_THRESHOLDS`
      shape identical)
- [x] `[INFERENCE]` resolved and promoted to `AGENT-ONBOARDING.md` §4.1
- [x] Scratch dirs cleaned up (`/tmp/mex-probe.*`, `/tmp/mex-rn.*`, `/tmp/mex-f2.*`); no git
      worktree ever created

### Acceptance criteria, each with its evidence

1. **"Staleness reflects the delta against a meaningful base, not the last 5 commits."**
   `resolveComparisonBase` resolves `origin/main` with `mergeBase ee88f14` on this worktree;
   `getGitDiff` no longer contains `HEAD~5` (verified `grep -c 'HEAD~5' src/git.ts` → 0).
2. **"Documented behavior when no upstream is configured or refs are stale."**
   `ComparisonBase.source` (`explicit`/`tracking`/`remote-head`/`local`) plus `note` and
   `shallow`. Never fetches, so refs may be stale *by design* — `note` says so. Five edge
   cases pinned in `test/git-upstream.test.ts`.
3. **"The per-file full-log scan is either eliminated or measured and justified."**
   **Eliminated.** Measured before/after: full `log()` 29.4 ms/file scaling with total
   history → `rev-list --count` 4.0 ms/file scaling with distance only.
4. **"A test asserting merge-commit handling matches documented intent."**
   `test/git-upstream.test.ts` "counts merge commits only in all mode and defaults to
   no-merges", mutation-verified in both directions.

## Follow-ups

Adjacent work deliberately **not** done here, to avoid colliding with sibling lanes:

- [ ] Activate the code-drift signal at the production callsite: pass `claimedPaths` (from the
      file's grounding/claims) and a once-per-run `base` from `src/drift/index.ts:115-121`.
      Blocked only by that file being owned by the anchors lane this wave. Resolving the base
      **once per run** rather than per file is the right shape — it is repo-level, not file-level.
- [ ] Expose the count mode in `.mex/config.json` via `loadStalenessThresholds`
      (`src/config.ts:128-172`) once that file is free. One field + one default.
- [ ] Consider a `"first-parent"` mode with its own PR-count thresholds (see decision above).
- [ ] `mex impact` already joins `_mex_grounded_source` (`src/graph/cli-agent.ts:497-503`);
      that mapping is a better source of `claimedPaths` than frontmatter claims, but it lives
      in `src/graph/**` (graph lane).
- [ ] `daysSinceLastChange` and `commitsSinceLastChange` each spawn their own `git log` for the
      same file — one call could serve both. ~25 ms/file/run; not worth a collision this wave.

## Handoff

Nothing outstanding for this ticket. The one thing a fresh session must not rediscover:
**`simple-git`'s `log({ file })` is `git log --follow`**, and `.mex/ROUTER.md` has four renames
behind it, so any "simplification" that drops `--follow` silently loses ten of its eleven
commits of history.
