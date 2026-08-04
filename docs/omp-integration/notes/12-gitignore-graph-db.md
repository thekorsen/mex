# Issue #12 — mex never writes a `.gitignore` rule, so consumers commit a binary graph.db by accident

- **Issue:** https://github.com/thekorsen/mex/issues/12
- **Milestone:** Correctness — harness-independent bugs
- **Branch:** `omp/anchors`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

`.mex/graph.db` is a generated SQLite file with WAL/SHM sidecars, and nothing in mex ever writes a
`.gitignore` rule for it. A user who runs `mex setup` then `mex graph` commits a binary database, then
re-commits a churned copy on every re-index. `mex setup` should arrange the ignore rule itself,
idempotently, without disturbing an existing `.gitignore`.

## Acceptance criteria

- [x] After `mex setup` in a fresh repo, `git status` is clean following a `mex graph` run.
- [x] Re-running setup does not duplicate the rule.
- [x] An existing `.gitignore` retains its original content byte-for-byte above the appended block.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| Nothing in the codebase reads or writes `.gitignore` | `grep -rn gitignore src/ templates/` → no writer | read-only |
| This repo's own rule is hand-authored policy | `.gitignore:21` `.mex/graph.db*` | read-only |
| WAL mode is on, so `-wal`/`-shm` sidecars appear | `src/graph/database.ts:31` | read-only |
| The marker-append precedent to mirror | `src/watch.ts:83-99`, marker `# mex-drift-check` at `:7` | read-only |
| A fresh scratch repo got no `.gitignore` at all | onboarding §4.1 | executed (prior session) |
| `mex graph` writes `graph.db` (167 KB here) on first run | scratch repo, below | executed |

## Commands run

Fresh scratch repo with a pre-existing two-line `.gitignore`:

```
$ cat .gitignore                    # before
node_modules/
dist/

$ printf '7\n' | node dist/cli.js setup
...
✓ Added .mex/graph.db* to existing .gitignore

$ cat .gitignore                    # after
node_modules/
dist/

# mex — generated artifacts
# The code graph is a generated SQLite database (plus WAL/SHM sidecars) — never commit it.
# Rebuild it with `mex graph`.
.mex/graph.db*
# NOT ignored, on purpose: .mex/events/decisions.jsonl is append-only, merges
# tolerably, and is meant to be committed and shared. Do not add it here.
```

Byte-for-byte preservation of the original content, and cleanliness after a real graph build:

```
$ head -2 .gitignore | cmp -s - /tmp/gitignore-before.txt && echo PASS
PASS: byte-identical prefix

$ node dist/cli.js graph >/dev/null && ls -la .mex/ | grep graph
-rw-r--r-- 1 ryan wheel 167936 Aug  4 17:45 graph.db

$ git add -A && git status --porcelain | grep -c graph.db
0                                    # PASS: graph.db not tracked
```

Idempotency on re-run:

```
$ md5sum .gitignore > /tmp/gi-md5-1.txt
$ printf '7\n' | node dist/cli.js setup
→ Skipped .gitignore (.mex/graph.db* already ignored)
$ md5sum -c /tmp/gi-md5-1.txt
.gitignore: OK                       # PASS: idempotent

$ grep -c 'mex — generated artifacts' .gitignore   # 1
$ grep -c 'graph.db' .gitignore                    # 1
```

---

## Decisions

### Decision: append a marked block, and what the marker is

- **Chosen:** append after existing content under the marker `# mex — generated artifacts`,
  mirroring `src/watch.ts:83-99`'s hook-append idiom (read → marker check → `trimEnd() + "\n\n" +
  block` → write).
- **Why:** the ticket explicitly asks for the `watch.ts` shape, and reusing it means one convention
  in the codebase for "mex appends to a file the user owns" rather than two. Appending (never
  reordering, never rewriting) is what makes the byte-for-byte criterion hold trivially.

### Decision: idempotency is checked two ways, not one

- **Chosen:** skip if the file contains the marker **or** if a line already matches
  `/^\s*\.mex\/graph\.db\*?\s*$/m`.
- **Why:** the marker alone only recognizes blocks *mex* wrote. A user who hand-added
  `.mex/graph.db` — which is exactly what this repo did at `.gitignore:21`, and what any careful user
  would do — would otherwise get a redundant second rule that says nothing new. The second check
  makes the operation idempotent with respect to *intent*, not just to our own past writes. The
  regex is anchored and allows the optional `*` so both `.mex/graph.db` and `.mex/graph.db*` count.

### Decision: `.mex/events/decisions.jsonl` is NOT ignored, and the file says so

- **Chosen:** do not ignore it; state the reason inside the emitted comment block.
- **Why:** the ticket calls this out and it is right. The journal is append-only and line-oriented,
  so it merges tolerably, and it is meant to be shared — it is the project's decision history. The
  risk is not that mex ignores it; the risk is that a user tidying their `.gitignore` sees mex
  ignoring `.mex/graph.db*` and "helpfully" adds the journal beside it. The comment is aimed at that
  future human, which is why the rationale lives in the generated file and not only in this note.

### Decision: the hook runs regardless of tool selection

- **Chosen:** call `ensureGitignoreRule` right after the scaffold copy loop
  (`src/setup/index.ts:340`), before tool selection.
- **Why:** committing a binary graph is not an omp-specific or Claude-specific problem. Placing it
  before the interactive prompt also means it still happens for a user who picks "None / skip".
  `dryRun` is honoured — it reports what it would do and writes nothing.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Writing the rule from `mex graph` instead of `mex setup` | `mex graph` runs repeatedly and often in CI; a command that silently mutates `.gitignore` on every invocation is far more surprising than one that does it during setup. The ticket's own scope line permits graph-time creation "when no scaffold setup ran", but setup-time alone satisfies every acceptance criterion, and setup already runs before any graph exists. |
| Marker-only idempotency | Misses the hand-authored `.mex/graph.db` case — the very rule this repo has at `.gitignore:21`. Would have appended a redundant block to any careful user's file. |
| Rewriting/normalizing an existing `.gitignore` (dedup, sort, group) | Directly violates the byte-for-byte criterion, and a tool that reorders a file the user owns will be distrusted forever. Append-only is the whole discipline. |
| Ignoring the whole `.mex/` directory | Catastrophic: `.mex/` is the living wiki and is *supposed* to be committed. Only the generated database is disposable. |
| Adding `.mex/events/decisions.jsonl` | Explicitly wrong per the ticket — it is shared history. Called out in the emitted comment so nobody adds it later. |

---

## Changes made

| File | Change |
|---|---|
| `src/setup/index.ts:221` | `GITIGNORE_MARKER = "# mex — generated artifacts"`. |
| `src/setup/index.ts:223-277` | `ensureGitignoreRule(projectRoot, dryRun)` — create or marker-append, idempotent, dry-run aware. |
| `src/setup/index.ts:340` | Called after the scaffold copy loop, independent of tool selection. |

## Tests added or changed

Covered by execution above (create, append-preserving, idempotent re-run, clean `git status` after a
real `mex graph`). No unit test was added: `ensureGitignoreRule` is module-private and the observable
contract is the end-to-end setup behavior, which `runSetup`'s stdin binding
(`src/setup/index.ts:345-347`) makes unsuitable for vitest. Exporting the helper purely to test it
would widen the module's surface for no consumer.

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (output pasted above)
- [x] `npm test` passes
- [x] `npm run build` passes
- [x] `mex check` did not regress from `94/100`
- [x] Worktrees / scratch dirs cleaned up

## Follow-ups

- [ ] `mex graph` still does not write the rule when setup never ran (e.g. a hand-created `.mex/`).
      Setup-time coverage satisfies the ticket; graph-time coverage would need care to avoid
      mutating `.gitignore` on every CI run.

## Handoff

Done. Marker string `# mex — generated artifacts` is now load-bearing for idempotency — anything
that regenerates the block must keep it.
