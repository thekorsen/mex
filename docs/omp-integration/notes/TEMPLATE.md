# Issue #<N> — <title>

- **Issue:** https://github.com/thekorsen/mex/issues/<N>
- **Milestone:** <milestone>
- **Branch:** `omp/<N>-<slug>`
- **Status:** in progress | blocked | ready for review | done
- **Started:** YYYY-MM-DD
- **Last updated:** YYYY-MM-DD

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

One or two sentences, in your own words. If you cannot restate it without copying the issue, you have not read it closely enough yet.

## Acceptance criteria

Copy them from the issue verbatim, as a checklist. All of them. Do not paraphrase or drop any.

- [ ] …
- [ ] …

---

## Findings

What you learned about the code. Every structural claim carries `path:line`.

| Finding | Evidence | Verified? |
|---|---|---|
| | `src/foo.ts:120` | executed / read-only / `[INFERENCE]` |

## Commands run

Actual commands and actual output. This is the proof, not a summary of the proof.

```
$ MEX_TELEMETRY=0 node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)
```

---

## Decisions

For `design-decision` tickets this section is the deliverable and must be written **before** implementation.

### Decision: <what>

- **Options considered:**
  1. …
  2. …
- **Chosen:** …
- **Why:** …
- **What this rules out:** …
- **Revisit if:** …

---

## Dead ends

**Do not skip this.** What you tried that did not work is the most valuable thing in this file — it is what stops the next session from spending the same hours.

| Approach | Why it failed |
|---|---|
| | |

---

## Changes made

| File | Change |
|---|---|
| | |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| | |

---

## Verification

- [ ] Acceptance criteria all met
- [ ] Ran the actual thing (output pasted above)
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `mex check` did not regress from `94/100` (or the change is explained)
- [ ] Docs updated where behavior changed
- [ ] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2
- [ ] Worktrees / scratch dirs cleaned up

## Follow-ups

Adjacent breakage found but deliberately not fixed here. File these as issues; do not silently widen scope.

- [ ] …

## Handoff

If this ticket is not finished: exactly where you stopped, what the next concrete action is, and anything a fresh session would otherwise have to rediscover.
