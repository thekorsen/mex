---
name: add-drift-checker
description: Add a new checker to mex check. Covers the checker signature, wiring it into runDriftCheck, extending the IssueCode union, choosing severity against the CI gate, and the false-positive traps that make a checker worse than nothing.
triggers:
  - "drift checker"
  - "new checker"
  - "IssueCode"
  - "mex check"
  - "DriftIssue"
  - "severity"
edges:
  - target: "context/conventions.md"
    condition: "when verifying the checker signature, degradation pattern, and verify gates"
  - target: "context/decisions.md"
    condition: "when choosing severity, since error severity fails the CI gate"
grounds_to: []
last_updated: "2026-08-04"
---

# Add a drift checker

## Context

A checker answers one question about whether the wiki still matches reality. Read these
first:

- src/drift/index.ts:118-203 — the only place checkers are invoked. Note the two groups:
  per-file checkers inside the file loop, and whole-scaffold checkers after it.
- src/drift/checkers/omp-artifacts.ts — the newest worked example, and the best one to copy:
  it shows the absent-input guard, a file-relative resolution rule, and a comment explaining
  why the checker has to exist at all.
- src/drift/checkers/script-coverage.ts — the simplest whole-scaffold checker.
- src/types.ts:116-149 — the `IssueCode` union and the `DriftIssue` shape.

Every issue carries `code`, `severity`, `file`, `line`, and `message`; `line` is `number | null`
and `claim` is optional and internal (src/types.ts:141-149). `file` is a repo-relative
posix path.

## Steps

1. Create src/drift/checkers/<name>.ts exporting one `check<Subject>` that returns
   `DriftIssue[]` (or a `Promise<DriftIssue[]>` if it needs git). Take the narrowest inputs
   that do the job — most checkers need only `projectRoot`, or the scaffold file list.
2. Append the new code to the `IssueCode` union in src/types.ts with a trailing comment
   naming the emitting file and the severity, matching src/types.ts:130-133.
3. **Choose severity deliberately.** Error means `mex check` exits 1
   (src/cli.ts:163,177) and fails the CI gate. Ask: does this condition break the loop
   silently? A silent break is an error; cosmetic or recoverable drift is a warning.
4. Wire it into `runDriftCheck` in src/drift/index.ts. Per-file checks go inside the file
   loop; whole-scaffold checks go after it, next to the other structural checkers
   (src/drift/index.ts:179-203). Push its count into `checkerIssueCounts` so `--verbose`
   accounts for it.
5. Add a remediation string for the new code in src/reporter.ts — the console reporter
   prints it under the issue (src/reporter.ts:53-54,145-149). A code with no remediation
   tells the user what broke but not what to do.
6. Add a test in test/checkers.test.ts: build a temp fixture, call the checker directly,
   assert the code and severity. Follow the temp-dir convention already in that file
   (test/checkers.test.ts:32-40).

## Gotchas

- **Never throw.** A crashed check is indistinguishable from an accurate wiki to a CI gate.
  Wrap every read and return `[]` or skip the file
  (src/drift/checkers/broken-link.ts:18-23).
- **Return `[]` immediately when the input is absent.** Most repos will not have whatever
  you are checking, and they must pay nothing (src/drift/checkers/omp-artifacts.ts:34-36).
- **A false positive is worse than no checker.** Path claims are deliberately routed only
  from ROUTER.md because backticks in other scaffold files hold non-path content
  (src/drift/index.ts:159-162). If your checker scans prose, expect the same class of
  problem and scope it before shipping.
- Two signals about the same underlying condition should collapse into one issue at the
  higher severity, not cost the score twice — see how staleness folds its signals
  (src/drift/checkers/staleness.ts:76-79,146-162).
- Skip fenced code blocks and inline code when scanning prose for real references, or every
  example in the docs becomes an issue (src/drift/checkers/broken-link.ts:32-38).
- Resolve paths against both the project root and the scaffold root. A scaffold may be
  deployed under `.mex/` or *be* the repo, and both must work
  (src/drift/checkers/path.ts:119-132).
- Spawning a subprocess per file is a performance bug. Repo-level facts get resolved once
  per run, before the file loop (src/drift/index.ts:112-115).
- New codes are additive by contract and consumers must not exhaustively switch on `code`
  (COMPATIBILITY.md:251-252). Adding one is fine; changing an existing code's meaning or
  severity is a breaking change.

## Verify

Set `MEX_TELEMETRY=0` first, then the four gates:

```bash
npm run typecheck
npm run build
npx vitest run
node dist/cli.js check --quiet
```

Plus, specific to this task type:

- [ ] The checker is reached from `runDriftCheck` — confirmed by `--verbose`, which lists
      per-checker issue counts.
- [ ] Run it against this repo. Every issue it reports is a real problem; zero false
      positives on the existing scaffold.
- [ ] Severity was chosen on purpose. If it is an error, an error is genuinely warranted,
      because CI now fails on it.
- [ ] The new code appears in the `IssueCode` union with a comment naming its emitter, and
      has a remediation string in the reporter.
- [ ] The checker returns `[]` — not a throw — for a missing input, an unreadable file, and
      a repo with no scaffold.
- [ ] The test asserts the observable contract (code, severity, and which file is flagged),
      not the checker's internals.

## Debug

- Checker never fires — it is not wired into `runDriftCheck`, or an early absent-input guard
  is returning `[]` first. `--verbose` shows the per-checker counts.
- Typecheck fails on the issue literal — the code was not added to the `IssueCode` union.
- Issues appear against paths that exist — you are resolving against only one of the project
  root and scaffold root, or a `:line` suffix is being treated as part of the path.
- `mex check` suddenly exits 1 across the repo — a new checker was given error severity and
  is firing on prose. Confirm each hit is real before adjusting anything else; never widen a
  threshold to quiet it.
- Score moved more than expected — one condition is emitting several issues instead of one
  folded issue.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
