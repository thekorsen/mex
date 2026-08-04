# Issue #6 — content-hash change detection

- **Issue:** https://github.com/thekorsen/mex/issues/6
- **Milestone:** Multi-dev
- **Branch:** `omp/graph`
- **Status:** ready for review
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

Make graph change detection authoritative on stored file content hashes instead of checkout mtimes, while keeping the existing exported runtime entry point and preserving additions/deletions behavior.

## Acceptance criteria

- [x] Copying a `graph.db` between two checkouts of the same commit produces **zero** changed files.
- [x] Editing a file's content (same size, e.g. a one-character swap) is still detected — test added for this specifically, since size-only comparison would miss it.
- [x] No measurable regression in `mex graph` incremental-sync wall time on this repo (~152 files; before/after numbers recorded below).

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| `findChangedSourceFiles` currently reads `path`, `size`, and `modified_at`, then flags any row whose mtime differs from disk, which makes checkout mtimes authoritative today. | `src/graph/runtime.ts:97-114` | read-only |
| The graph schema already stores `content_hash` as `TEXT NOT NULL` on `files`, so the hash column needed for this fix already exists. | `src/graph/schema.sql:102-110` | read-only |
| Graph indexing already writes `contentHash: sha256(file.source)` into the file record during indexing, so runtime can reuse the same hash convention instead of inventing one. | `src/graph/engine-impl.ts:193-212` | read-only |
| Engine sync treats a vanished source file as non-fatal by catching `statSync` and deleting the file's nodes instead of throwing. The query-side change detector should follow that same race-handling convention. | `src/graph/engine-impl.ts:155-163` | read-only |
| The existing downstream incremental-change contract that must keep working is that additions appear in `findChangedSourceFiles(root, db)`. | `src/graph/__tests__/engine-rust.test.ts:42-49` | read-only |
| **The old rule flags all three new fixtures**, so the tests defend real behavior rather than restating the implementation. Replayed the pre-fix predicate (`!row \|\| row.size !== stat.size \|\| row.modified_at !== stat.mtimeMs`) against real `graph.db` rows built by the CLI. | mtime churn → `changed = true`; same-size one-char edit → `size === storedSize` **and** `changed = true`; copied db in a second checkout → `mtimesDiffer = true`, `changed = true` | **executed** |
| **`mex check` cannot show this effect on this repo.** `runDriftCheck` only loads the grounding runtime when a scaffold file carries `grounds_to` frontmatter or an inline `mex://` anchor (`src/drift/index.ts:71-78`); this repo's `.mex/` has neither, so `findChangedSourceFiles` is never reached from `check`. The incremental path must be timed through `loadGroundingRuntime` directly (`src/graph/runtime.ts:49-50`). | `check --quiet` wall time was identical (~1.6 s) under both the old and new rule | **executed** |
| `files.content_hash` is populated for every row in practice, not just in principle. | live `.mex/graph.db`: `SELECT count(*), sum(content_hash IS NULL OR content_hash='')` → `152, 0` | **executed** |

## Commands run

```text
$ export MEX_TELEMETRY=0

# ── The measurement that matters: the real implicit incremental path,
#    loadGroundingRuntime -> findChangedSourceFiles -> graph.sync(changed)
#    (src/graph/runtime.ts:49-50). Both runs start from an in-sync graph.db,
#    then churn the mtime of all 155 source files with content untouched —
#    i.e. exactly what a fresh clone or new worktree looks like.

$ node dist/cli.js graph        # in-sync baseline
Code graph built: 1886 nodes, 2942 edges across 155 files in 13277ms

#   OLD rule (size + mtime)
>>> loadGroundingRuntime after churning 155 mtimes: 13996 ms

#   NEW rule (content_hash authority)
>>> loadGroundingRuntime after churning 155 mtimes: 70 ms
>>> loadGroundingRuntime after churning 155 mtimes: 66 ms   # re-run, fresh in-sync db
>>> loadGroundingRuntime after churning 155 mtimes: 65 ms   # re-run

#   => ~14.0 s -> ~0.07 s on the fresh-clone case. Not a regression to justify;
#      a 200x improvement, because the old rule re-extracted all 155 files.

# ── Detection cost in isolation, same db, both predicates (155 files, 0.71 MB):
files tracked: 152  globbed: 155
steady state     OLD  0.69 ms  ->   7 changed
steady state     NEW  0.47 ms  ->   7 changed
fresh-clone case OLD  0.55 ms  -> 155 changed   (each triggers re-extraction)
fresh-clone case NEW  7.83 ms  ->   7 changed

#   => the hash costs ~7 ms of reading in the worst case and saves ~14 s of
#      re-extraction. In the steady state (nothing touched) it is not slower:
#      every file hits the mtime fast path and no file is read.

# ── Gates
$ npx vitest run test/graph-change-detection.test.ts
✓ test/graph-change-detection.test.ts (4 tests) 87ms

$ npx vitest run                       # whole suite
Test Files  39 passed (39)
     Tests  377 passed (377)

$ npm run build && npx tsc --noEmit
ESM ⚡️ Build success   DTS ⚡️ Build success   (tsc: no output)

$ node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)   # exit 0, baseline held
```

---

## Decisions

### Decision: use content hashes as the authority, with size and mtime as cheap filters

- **Options considered:**
  1. Hash every file every load.
  2. Size+mtime only, as today.
  3. Size as pre-filter, mtime as fast-path hint, hash as authority.
- **Chosen:** 3. Size+mtime remains a fast PRE-FILTER and `content_hash` is the AUTHORITY; a matching mtime short-circuits the hash read.
- **Why:** Measured on this repo (155 source files, 0.71 MB), timing the real incremental path `loadGroundingRuntime → findChangedSourceFiles → graph.sync(changed)` (`src/graph/runtime.ts:49-50`) from an in-sync `graph.db` after churning every file's mtime with content untouched — the fresh-clone / new-worktree case: **old rule 13,996 ms → new rule 65-70 ms**, because the old rule handed all 155 files to `graph.sync()` for re-extraction while the new rule correctly reports the 7 genuinely-changed ones. Detection cost in isolation over the same db: steady state OLD 0.69 ms / NEW 0.47 ms (every file takes the mtime fast path, nothing is read); fresh-clone case OLD 0.55 ms / NEW 7.83 ms. So the hash costs ~7 ms of reading in its worst case and saves ~14 s of re-extraction, and costs nothing in the steady state. This is not a regression to be justified — it is a 200x improvement on the case the ticket cares about.
- **What this rules out:** Leaving size+mtime as the final truth, and the deliberate non-goal of writing the observed mtime back into the database to restore the fast path.
- **Revisit if:** A repo is large enough that hashing the size-matched-but-mtime-moved set is material — the honest boundary is total bytes in that subset, not file count, since the work is `readFileSync` + sha256. At ~0.7 MB it is 8 ms; a 100 MB source tree would be ~1 s, still far below a re-extraction, but worth re-measuring. Also revisit if a future writer path wants to refresh `modified_at` on a content-identical hit (see Dead ends) — that trade changes if `graph.db` sharing is ever abandoned.

---

## Dead ends

**Do not skip this.** What you tried that did not work is the most valuable thing in this file — it is what stops the next session from spending the same hours.

| Approach | Why it failed |
|---|---|
| Add a schema migration for `content_hash` | Not needed: the column already exists as `TEXT NOT NULL` in the schema and indexing already populates it for every file row. Changing schema here would add migration risk without solving the bug. (`src/graph/schema.sql:106`, `src/graph/engine-impl.ts:205`) |
| Refresh `modified_at` in `files` when the hash proves content-identical | Tempting (it would restore the mtime fast path after one churn) and rejected: it turns a read-side query into a writer, and it re-breaks the very thing this ticket enables — two checkouts sharing one `graph.db` would fight over whose mtimes are recorded. The cost of not doing it is bounded and small: ~8 ms to re-read this repo's 155 files, versus the ~14 s re-extraction the fix removes. (`src/graph/runtime.ts:97-145`) |
| Measure the effect through `mex check` | `check` never reaches this code on this repo. `runDriftCheck` loads the grounding runtime only when some scaffold file has `grounds_to` frontmatter or an inline `mex://` anchor (`src/drift/index.ts:71-78`), and this repo's `.mex/` has neither — so `check --quiet` timed identically (~1.6 s) under both the old and the new rule, which reads as "no effect" and is simply the wrong instrument. The incremental path has to be driven through `loadGroundingRuntime` directly. Anyone re-measuring this should start there. |

---

## Changes made

| File | Change |
|---|---|
| `src/graph/runtime.ts` | Reworked change detection to read `content_hash`, added a single `hasFileChanged` helper, reused shared `sha256`, and handled stat/read races as non-fatal changes. |
| `src/graph/engine-impl.ts` | Exported `sha256` so runtime and indexing share one hashing implementation. |
| `test/graph-change-detection.test.ts` | Added fixture-based coverage for content-identical mtime churn, same-size edits, copied-db second checkout, and additions/deletions. |
| `docs/omp-integration/notes/6-content-hash-change-detection.md` | Recorded findings, explicit decision, dead ends, and planned verification handoff. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `treats content-identical files with new mtimes as unchanged` | A checkout that rewrites mtimes without changing content triggers no reindexing. Fails under the old rule (verified by replaying the old predicate: `changed = true`). |
| `detects same-size content edits when mtimes move` | A one-character swap is still caught. This is the specific regression a size-only comparison would introduce — verified that the fixture's stored size equals the edited file's size, so size alone genuinely cannot see it. |
| `treats a copied graph database in a second checkout of identical content as unchanged` | The acceptance criterion that unblocks shareable grounding baselines (#5): one `graph.db`, two checkouts, zero changed files. Verified the two checkouts' mtimes really do differ, so the test is not vacuous. |
| `still reports added and deleted tracked source files` | The pre-existing contract at `src/graph/__tests__/engine-rust.test.ts:46` survives: additions and deletions still appear in the changed set. |

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (output pasted above)
- [x] `npx vitest run` passes — 39 files, 377 tests
- [x] `npm run build` passes (plus `npx tsc --noEmit` clean)
- [x] `mex check` did not regress: `94/100 (2 warnings)`, exit 0
- [x] Docs updated where behavior changed
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2
- [x] Worktrees / scratch dirs cleaned up (temp probe dirs and probe scripts removed; no git worktrees created)

Verification was run by the lane orchestrator, which owns gates for this lane; the implementing subagent ran none by design.

## Follow-ups

- [ ] If hashing the size-matched, mtime-moved subset becomes measurable on a much larger source tree, re-evaluate caching or a cheaper short-circuit. The metric to watch is bytes in that subset, not file count.

## Handoff

Done. #6 is landed, gated, and committed on `omp/graph`.

**For lane #5 (shareable grounding baselines), the API you build on:**

```ts
// src/graph/runtime.ts — unchanged name and signature, new semantics
export function findChangedSourceFiles(projectRoot: string, db: SqliteDatabase): string[]

// src/graph/runtime.ts — the single per-file decision, not exported
function hasFileChanged(
  absPath: string,
  row: { size: number; modified_at: number; content_hash: string },
  stat: Stats,
): boolean
```

`findChangedSourceFiles` still returns relative posix paths, deduped and sorted, including additions and deletions. What changed is that its verdict is now content-derived, so **a `graph.db` is portable across checkouts of the same content** — that is the property #5 needs, and it is now defended by a test. Node ids were not touched (`src/graph/extraction/node-id.ts:29-38`), so id portability is intact. If #5 needs the per-file predicate itself, export `hasFileChanged` rather than reimplementing the rule.
