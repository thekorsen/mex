# Wave 2 — populating the `.mex/` wiki to match post-wave-1 reality

- **Lane:** `docs`
- **Branch:** `omp/docs`
- **Status:** done, with one cross-lane handoff open (see Handoff)
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

Wave 1 merged 7 lanes and 30+ commits of real code change without touching the
`.mex/` wiki, so `mex check` fell from 94/100 to 64/100 on 12 warnings. Make the
wiki describe what the code now does, without silencing the checker, moving a
threshold, or merely bumping `last_updated`.

## Acceptance criteria

- [x] All 10 `STALE_FILE` files updated with real prose describing current reality
- [x] Both `UNDOCUMENTED_SCRIPT` warnings fixed (`eval`, `eval:e2e` documented)
- [x] Zero warnings, or a written justification for each one left behind
- [x] No checker, threshold, allowlist, or severity touched
- [x] `npm run typecheck`, `npm run build`, `npx vitest run`, and `check` all run and pasted

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| The score drop was correct behavior, not a regression | 10 × `STALE_FILE` at 58/66 commits vs a 50 threshold, src/drift/checkers/staleness.ts:11-16 | executed — `check --json` |
| **This repo never populated its own wiki.** 8 of 10 flagged files still held shipped template annotation comments and a literal `[YYYY-MM-DD]` | `grep -c '<!--'` across the flagged set before the change | executed |
| A `STALE_FILE` clears only on a real commit — `commitsSinceLastChange` reads git history, so editing the working tree changes nothing until committed | src/drift/checkers/staleness.ts:97; src/git.ts | executed — score stayed 70 until commit, then 100 |
| Documenting `eval` alone would clear both script warnings: a colon variant is skipped when its base name appears in scaffold text | src/drift/checkers/script-coverage.ts, the `script.includes(":")` branch | read-only |
| The checker does a plain substring match over the concatenated text of all scaffold files | src/drift/checkers/script-coverage.ts | read-only |
| MCP now serves 9 tools, not 5 | raw stdio `initialize` → `tools/list`: the original 5 plus `mex_graph_scope`, `mex_graph_get`, `mex_graph_query`, `mex_impact` | executed |
| Public API grew to 20 exports, adding the four retrieval entry points plus `DEFAULT_RETRIEVAL_OPTIONS` | `import('./dist/index.js')` key dump | executed |

### The two traps this pass discovered

Both are recorded in the wiki itself (ROUTER.md house-style preamble, a Known
Issues bullet, and a Non-Negotiable in both anchors) so the next session does not
pay for them again.

**1. A backticked `path:line` citation is an error-severity landmine.**
`pathExists` never strips a `:line` suffix (src/drift/checkers/path.ts:113-164),
and claims are extracted from inline code spans, fenced blocks, and bold text
only (src/drift/claims.ts:49,83,105) — never plain prose. So `` `src/types.ts:5` ``
becomes a literal path claim, fails `existsSync`, and emits `MISSING_PATH` at
**error** severity (path.ts:36-40), which exits 1 (src/cli.ts:165) and fails the
CI drift gate. Path claims are routed to `checkPaths` for ROUTER.md alone
(src/drift/index.ts:162), so ROUTER.md is where this bites hardest. A first draft
produced **32 errors**, taking the score to 0.

House style is now: write `path:line` as plain text, never backticked. Backtick a
path only when it exists on disk and carries no line suffix — which also rules
out backticking `.omp/**` (written by `mex setup`, absent here), the gitignored
graph db, `.claude/CLAUDE.md`, globs, and slash-bearing extension lists.

**2. `**Bold**` under a stack/dependency heading becomes a dependency claim.**
`src/drift/claims.ts:105-110` treats bold text under any heading matching
`/key\s*libraries|core\s*technologies|dependencies|stack|tech/i` as a dependency
claim, producing 18 `DEPENDENCY_MISSING` warnings from bold library names. Fixed
by dropping the bold wrapper, **not** by renaming the headings — the headings are
the template's own authoring spec and a future reader needs them.

**3. Deleting an annotation comment can delete a required literal.**
`test/tool-config-templates.test.ts:19-24` asserts that all 10 context files
contain `` [`someFunction()`](mex://function:<tier-1-id>) `` *and* that
`findMexAnchors` returns `[]` for them. That literal shipped **inside** the
annotation block we were told to delete, so deleting the annotation broke the
assertion in three files. It must sit inside a fenced ```markdown block: in plain
prose mdast parses it as a real link and `findMexAnchors` returns a node id,
failing the "examples must stay inert" half. Caught by cross-lane review before
gates ran.

## Commands run

```
$ MEX_TELEMETRY=0 node dist/cli.js check --quiet      # before
mex: drift score 64/100 (12 warnings)

$ MEX_TELEMETRY=0 node dist/cli.js check --quiet      # mid-flight, backticked citations
mex: drift score 0/100 (32 errors, 28 warnings)

$ MEX_TELEMETRY=0 node dist/cli.js check --quiet      # after commit a177f91
mex: drift score 100/100
exit 0

$ MEX_TELEMETRY=0 node dist/cli.js check --json
score 100 | counts {"error":0,"warning":0,"info":0} | contractVersion 1 | filesChecked 14 | issues []

$ npm run typecheck      # exit 0
$ npm run build          # exit 0, dist/cli.js 334.67 KB
$ npx vitest run         # 458/460, 2 failures in test/sync.test.ts — see Handoff
```

---

## Decisions

### Decision: treat this as a population pass, not a date bump

- **Options considered:**
  1. Bump `last_updated` on the 10 files and move on.
  2. Fill the empty template slots with real prose describing post-wave-1 state.
- **Chosen:** 2.
- **Why:** Option 1 is the exact anti-pattern AGENT-ONBOARDING.md:20 forbids, and
  it would clear the warnings while leaving the wiki useless. The files were
  never populated at all, so there was no "existing prose to refresh" — the
  honest fix was to write it.
- **What this rules out:** A quick mechanical pass. This cost three parallel
  agents and a cross-lane convention ruling.
- **Revisit if:** never — a wiki that does not describe reality has no value.

### Decision: plain-text `path:line` citations as house style for all 10 files

- **Options considered:**
  1. Backtick citations everywhere; accept `MISSING_PATH` errors in ROUTER.md only.
  2. Backtick everywhere except ROUTER.md (the only file `checkPaths` sees).
  3. Plain text everywhere.
- **Chosen:** 3.
- **Why:** Option 1 fails the CI gate. Option 2 works today but depends on the
  ROUTER.md-only filter at src/drift/index.ts:162 staying in place, and requires
  every future author to remember which file is special. Option 3 is correct in
  every file regardless of routing, and loses nothing: plain text is just as
  precise and just as greppable.
- **What this rules out:** Clickable path links in editors that linkify only code
  spans.
- **Revisit if:** `checkPaths` learns to strip a `:line` suffix, which would make
  backticked citations safe and is arguably the better upstream fix.

### Decision: do not leave drift in place to keep `test/sync.test.ts` green

- **Options considered:** leave 1-2 warnings so the ambient precondition survives;
  or reach zero and hand the test defect to its owner.
- **Chosen:** reach zero.
- **Why:** Keeping drift solely to satisfy a test inverts the tool's purpose —
  `mex check` would stop meaning what it says. The instruction was zero warnings.
- **What this rules out:** A green full suite from this lane alone.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Backticking `path:line` citations for readability | 32 error-severity `MISSING_PATH` issues, score 0, CI gate red. `pathExists` never strips the suffix (src/drift/checkers/path.ts:113-164). |
| Bolding library names in stack.md / architecture.md | 18 `DEPENDENCY_MISSING` warnings — bold under a stack/dependency heading is a dependency claim (src/drift/claims.ts:105-110). |
| Renaming the stack.md headings to dodge the dependency regex | Rejected rather than failed: the headings are the template's authoring spec. Fixing the bold is the honest fix; dodging the checker is the anti-pattern. |
| Deleting annotation comments wholesale | Silently removed the `someFunction()` anchor literal that test/tool-config-templates.test.ts:22 requires, breaking three files. The literal has to be re-placed inside a ```markdown fence to stay inert. |
| Editing the working tree and expecting the score to move | `STALE_FILE` is computed from git history via `commitsSinceLastChange`; the score stayed at 70 until the commit landed, then went to 100. |
| Fixing the mex-mcp flake by shortening the drift check | Not viable — the test's value is exercising the real `mex_check` path. Gave it an explicit 20s timeout instead; vitest's 5s default was the actual defect. |

---

## Changes made

| File | Change |
|---|---|
| `.mex/AGENTS.md` | Populated identity + 5 real Non-Negotiables; kept inside the anchor token budget |
| `.mex/ROUTER.md` | Real three-subsection Current Project State (8 Working / 5 Not yet built / 5 Known issues), citation house-style preamble, one routing row for the omp-integration docs |
| `.mex/context/architecture.md` | Flow-first System Overview, 7 Key Components, 6 External Dependencies, 6 explicit non-boundaries |
| `.mex/context/stack.md` | 5 Core Technologies, 11 Key Libraries, 5 deliberate non-uses, version constraints |
| `.mex/context/setup.md` | Dev runbook; documents `eval` and `eval:e2e` with real flags and gate behavior; the `MEX_TELEMETRY=0` rationale; the mex-mcp workspace-link trap |
| `.mex/context/conventions.md` | Naming, structure, 5 correct/wrong patterns, runnable Verify Checklist naming the four gates |
| `.mex/context/decisions.md` | 10 decision entries in the file's own format, incl. the reconciliation model marked *Proposed — not accepted* |
| `.mex/patterns/README.md` | Surgical additions only (retrieval-before-authoring, verify-section spec); all three asserted literals preserved and inert |
| `.mex/patterns/INDEX.md` | No longer claims zero patterns; two registered rows |
| `.mex/patterns/add-mcp-tool.md` | **New.** Registrar shape, `{error, projectRoot}` envelope, stdio-stdout trap, `ERR_MODULE_NOT_FOUND` workspace-link gotcha |
| `.mex/patterns/add-drift-checker.md` | **New.** Signature, `runDriftCheck` wiring, `IssueCode` extension, severity choice against the CI gate |
| `CLAUDE.md` | Populated; adds a section stating omp does not read root `CLAUDE.md` and `.omp/AGENTS.md` is the reaching path |
| `test/mex-mcp-stdio.test.ts` | Explicit 20s timeout on the `mex_check` case — vitest's 5s default made it the one flaky test once the suite reached 460 |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/mex-mcp-stdio.test.ts` (timeout only) | Unchanged contract; removes a load-dependent flake. Passes in isolation and in the full suite across repeated runs. |

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (output pasted above)
- [x] `npm run typecheck` passes
- [x] `npm run build` passes
- [ ] `npx vitest run` — 458/460; 2 failures in `test/sync.test.ts`, a sibling lane's file, root-caused below
- [x] `mex check` — 100/100, 0 warnings, 0 errors, exit 0 (above the 94 baseline; explained)
- [x] Docs updated where behavior changed
- [x] Scratch dirs cleaned up; no git worktrees created

### Why the score is 100 and not 94

94/100 was the pre-wave-1 baseline, and it included the 2 `UNDOCUMENTED_SCRIPT`
warnings that were never fixed. Wave 2 fixed those as well as the 10 `STALE_FILE`
warnings, so the honest score is now 100 with an empty `issues` array.
`filesChecked` also rose from 12 to 14 because the two new pattern files match
the `patterns/*.md` scaffold glob.

## Follow-ups

- [ ] **`checkPaths` should strip a `:line` suffix** before `existsSync`. Citing
      `path:line` is the repo's own documented convention
      (AGENT-ONBOARDING.md:22), and the checker currently punishes it with an
      error. Would make backticked citations safe and remove a whole class of
      false positive. Not done here: `src/**` is out of this lane.
- [ ] `src/drift/checkers/tool-config-sync.ts:6` still describes these as "files
      that `setup.sh` may copy" — a stale comment encoding the pre-npm install
      model. Cosmetic, but it misleads.

## Handoff

**For the `ci` lane — `test/sync.test.ts` needs a fixture.**

`test/sync.test.ts:94-114` (two tests) run `mex sync --warnings` with
`cwd: repoRoot` (:76) — against the **live repo** — and assert stdout contains
`"emitting the repair brief"`. The comment at :95-96 states the dependency
outright: *"`--warnings` pulls the repo's warning-only drift into scope"*.

That precondition no longer holds. At 100/100 there is no drift, so sync
correctly prints `✓ No drift detected. Everything is in sync.` and exits 0
without emitting a brief, making the assertion unsatisfiable. Verified directly:

```
$ MEX_TELEMETRY=0 node dist/cli.js sync --non-interactive --warnings
Running drift check...
✓ No drift detected. Everything is in sync.
exit 0
```

The third test in that describe (:84-92, the deterministic-exit contract) still
passes — it does not depend on drift existing.

This is a latent test defect, not a regression: the tests couple to ambient repo
state instead of a fixture, and were masked while the repo carried the 10
`STALE_FILE` warnings. **Zero warnings and these two tests are mutually exclusive
by construction**, so the repo can be clean or the tests can pass, never both.

Recommended fix: build a temp-dir scaffold with seeded warning-level drift and
point `runSyncCli` at it via `cwd`, following the existing `mkdtempSync` +
`afterEach` convention (test/tool-config-templates.test.ts:8-13,52-62). That
defends the #7 headless-sync contract independently of the live repo's score,
which is what the test is actually for. Escalated to the parent, which routed it
here rather than having the `docs` lane edit another lane's file.
