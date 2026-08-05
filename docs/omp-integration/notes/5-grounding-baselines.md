# Issue #5 — A fresh clone or worktree has grounding anchors but no baselines, so body-drift detection is silently dead

- **Issue:** https://github.com/thekorsen/mex/issues/5
- **Milestone:** Multi-developer reconciliation
- **Branch:** `omp/baselines`
- **Status:** complete
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

Grounding's anchors are committed but its baselines are not, so on any checkout that did not itself
run the grounding pass, `GROUNDING_DRIFT` cannot fire and `mex check` reports the wiki as clean.
Make body-drift detection survive a fresh clone — or, where it provably cannot, make the gap loud
instead of silent.

## Acceptance criteria

- [x] A developer who clones the repo and runs the documented setup sequence gets working
      `GROUNDING_DRIFT` detection, **or** an explicit, visible report that baselines are absent and
      how to obtain them.
- [x] The `updateFingerprints: false` skip path either repairs itself or surfaces a counted warning
      in `mex check` output (not just an optional `warn?.()` callback).
- [x] A test covering: capture baselines → simulate a second checkout without the DB baseline rows →
      assert the check output tells the truth about baseline availability.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| Body-drift needs a baseline, formerly available only from the gitignored DB | `src/drift/checkers/grounding.ts:43-56` now resolves a body-hash baseline before comparing; local rows come from `_mex_grounded_source` (`src/graph/fingerprint-store.ts:71-89`) inside `.mex/graph.db`, ignored at `.gitignore:21` | read-only |
| The `updateFingerprints: false` skip remains intentionally non-repairing but is no longer silent | `src/graph/runtime.ts:287-291` skips capturing current code when the committed fingerprint is stale; `src/drift/checkers/grounding.ts:120-126` emits the counted `GROUNDING_UNVERIFIABLE` warning when no truthful baseline is reachable | executed + tested |
| **This worktree reproduces the bug as-is: it has no `graph.db` at all** | `ls .mex/graph.db` → `No such file or directory`, while `.mex/` prose is fully present | executed |
| **A committed `fingerprint` is NOT a usable proxy for body drift — it fails in both directions** | probe below | executed |
| Fingerprints cover normalized AST **leaf kinds**, not spellings, by design | `src/graph/extraction/index.ts:52-56,64-77` — leaves are recorded as `node.type` | read-only |
| **`.gitignore:21` is upstream policy, not this fork's choice** — resolves ledger §4.3 | line introduced by upstream commit `9952db4` ("Compact, budgeted code-graph retrieval + eval harness (#105)", Daksh Jaitly, 2026-07-22), reachable from `upstream/main` and `upstream/code-graph-preview`; fork point is `9b69397` | executed |
| This repo scores 100/100 with grounding entirely inert — no `grounds_to` entry is non-empty and no `mex://` anchor parses | all 8 `grounds_to:` occurrences in `.mex/` are `[]`; the 7 `mex://` occurrences are literal `mex://function:<tier-1-id>` placeholders, which `findMexAnchors` does not yield (probe printed zero anchors across `.mex/**/*.md`) | executed |
| Score is unchanged by building the graph, for the same reason | `node dist/cli.js graph` then `check --json` → `100`, both before and after | executed |

### The probe that decided the design

Same function, four variants; compare stored `body_hash` and the serialized Tier-2 fingerprint
against the base:

```
PROBE base            bodyHashSame=true  fingerprintSame=true  tokens=98 nbrs=[]
PROBE literal-change  bodyHashSame=false fingerprintSame=true  tokens=98 nbrs=[]
PROBE structural      bodyHashSame=false fingerprintSame=false tokens=103 nbrs=[]
PROBE new-caller      bodyHashSame=true  fingerprintSame=false tokens=98 nbrs=["function:3fd66…"]
```

- `literal-change` is `subtotal >= 100 ? 0 : 12` → `>= 125 ? 0 : 15` — **exactly** the drift case
  asserted at `test/setup-grounding-e2e.test.ts:108-114`. The body changed; the fingerprint did not.
  A fingerprint-only checker would report that clean → **false negative**, the ticket's own failure mode.
- `new-caller` adds an unrelated caller elsewhere in the repo. The grounded body is byte-identical,
  but `neighbors` changed, so the fingerprint changed → **false positive**.

Fingerprints are deliberately rename- and spelling-insensitive (`src/graph/extraction/index.ts:52-56`)
and deliberately neighbourhood-sensitive (`src/graph/fingerprint.ts:37`). Both properties are correct
for their job — reconciling a *moved* node — and disqualifying for detecting a *changed body*.

---

## Decisions

### Decision: ship a committed baseline sidecar (`.mex/grounding.json`) **plus** a loud unverifiable signal

- **Options considered:**
  1. **(a) Commit a text-diffable baseline sidecar** carrying `{scaffoldFile, nodeId, bodyHash, fingerprint}`
     per grounded symbol. Survives clone, merges as text, no binary.
  2. **(b) Commit `graph.db`.** Binary, and the ignore rule is upstream's (finding above), so
     un-ignoring it forks from upstream policy for a file mex regenerates in ~9 s.
  3. **(c) Derive the baseline on demand from the committed `grounds_to` fingerprint,** making the
     sidecar unnecessary.
  4. **(d) Emit `GROUNDING_UNVERIFIABLE`** instead of silence when no baseline is reachable.
- **Chosen:** **(a) + (d)**. (a) is the real fix; (d) covers the residue (a) provably cannot.
- **Why:**
  - (c) is **disproved, not merely doubted** — see the probe. It is a false negative on precisely the
    literal-only edit the existing e2e test treats as the canonical drift case, and a false positive
    when an unrelated caller appears. Shipping it would leave the checker lying in both directions
    while looking fixed, which is strictly worse than today's honest-but-silent hole.
  - (b) is binary, un-mergeable, and now known to contradict upstream policy rather than local taste.
    Its only advantage over (a) — carrying old node bodies — is recoverable from git history, because
    the sidecar is itself committed (`git show <commit>:.mex/grounding.json`).
  - (a) works only because node ids are content-independent and path-derived
    (`src/graph/extraction/node-id.ts:29-38`) and `graph.db` is now content-addressed rather than
    mtime-addressed (issue #6, `src/graph/runtime.ts:112-160`). A baseline captured on one machine is
    therefore meaningful on another. Without #6 this option would not have been available.
  - (d) is near-free and is the half of the ticket that (a) cannot reach: a repo grounded before this
    feature shipped, or a node whose baseline was legitimately skipped, still has no truthful
    baseline. Reporting *"N grounded nodes have no baseline here — run X"* is the ticket's stated
    minimum bar and replaces the silence that is the actual bug.
- **Sub-decision — the sidecar does not carry node source text.** `bodyHash` is what the checker
  compares (`src/drift/checkers/grounding.ts:48-57`); `source` exists only to render an old-vs-new
  diff for `mex sync` (`src/graph/runtime.ts:314-329`). Committing bodies would duplicate the
  codebase into the wiki, churn on every regrounding, and conflict on every concurrent body change.
  The old body stays recoverable from the sidecar's own git history, so nothing is lost that matters.
  Consequence: in a checkout with a sidecar but no local capture, drift is **detected** exactly, and
  `groundingPromptContext` remains DB-only, so the sync brief omits the old-body row
  (`src/sync/brief-builder.ts:152`) rather than inventing one.
- **Sub-decision — the skip path is made visible, not self-repairing.** When a node's committed
  fingerprint disagrees with the graph, the truthful baseline is the body *as of grounding*, which is
  gone. Capturing the *current* body instead would assert that the prose matches code nobody checked
  — the silencing anti-pattern this repo rejects. So the skip keeps skipping and `GROUNDING_UNVERIFIABLE`
  makes it counted and visible in `mex check`. The ticket permits exactly this ("either repairs
  itself **or** surfaces a counted warning"); real repair remains an agent-authored prose pass
  (`updateFingerprints: true`).
- **Sub-decision — one aggregated issue per scaffold file,** not one per node. A 50-node wiki with no
  sidecar would otherwise cost 150 score points and bury every other signal. Severity is `warning`,
  not `error`: a missing baseline is a lost capability, not a false claim, and `error` would exit 1
  on every pre-sidecar repo (`src/cli.ts:165`).
- **What this rules out:** the fingerprint can never be treated as a body-drift oracle; `graph.db`
  stays gitignored and stays a pure derived artifact; the sidecar is not a place to store code.
- **Revisit if:** upstream starts committing `graph.db`, or the fingerprint gains a
  spelling-sensitive component (then (c) reopens).

---

## Dead ends

| Approach | Why it failed |
|---|---|
| **(c)** Derive body-drift from the committed `grounds_to` fingerprint and drop the sidecar entirely | Measured false in both directions. Literal-only edits leave the fingerprint bit-identical (missed drift); an unrelated new caller changes it while the body is untouched (phantom drift). Both are structural consequences of `src/graph/extraction/index.ts:52-56` and `src/graph/fingerprint.ts:37`, not tuning problems |
| Repair the skip path by capturing the current body as the baseline | Makes `mex check` go green by asserting prose matches code nobody verified — silences the signal instead of reporting it |
| Reuse `GroundedSource` for sidecar entries with `source: ""` | Would feed an empty "old body" into the sync diff (`src/graph/runtime.ts:320`), i.e. a fabricated diff. Added a `bodyHash`-only capability instead and left `src/graph/grounding.ts` untouched |
| Have the checker consult the sidecar directly | Splits baseline lookup across two layers. The runtime owns the lookup seam (`src/graph/runtime.ts:60-69`), so DB-first/sidecar-fallback resolution belongs there and the checker stays a pure consumer |
| Timing `mex check` on this repo to observe grounding behaviour | Grounding is inert here: every `grounds_to` is `[]` and all 7 `mex://` occurrences are `<tier-1-id>` placeholders that `findMexAnchors` does not return. Verified zero parsable anchors. Behavioural work must use a purpose-built fixture — consistent with ledger §4.2 |

---

## Changes made

| File | Change |
|---|---|
| `src/graph/grounding-sidecar.ts` | Defines the versioned, tolerant, deterministically sorted `.mex/grounding.json` read/write format; stores hashes and fingerprints, never source bodies. |
| `src/graph/runtime.ts` | Loads DB-first/sidecar-fallback baselines, mirrors successful captures and moved repairs into the sidecar, preserves truthful baselines on skips, and keeps prompt source DB-only. |
| `src/drift/checkers/grounding.ts` | Uses portable body-hash baselines for frontmatter and inline anchors; deduplicates drift per node and aggregates missing baselines into one `GROUNDING_UNVERIFIABLE` warning per file. |
| `src/graph/cli-ground.ts` | Tells operators to commit `.mex/grounding.json` after a successful capture. |
| `src/types.ts` | Adds the parent-authorized `GROUNDING_UNVERIFIABLE` issue code without repurposing existing codes. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/setup-grounding-e2e.test.ts` | Real graph capture writes a source-free sidecar; after local DB baseline rows are deleted, a literal-only body edit still emits `GROUNDING_DRIFT`; unchanged recapture is byte-stable. |
| `test/graph-grounding.test.ts` | DB and sidecar baseline drift, inline/frontmatter deduplication, and one counted unverifiable warning per file. |
| `test/graph-ground-cli.test.ts` | Automatic and manual capture paths preserve output behavior and successful capture gives the sidecar commit instruction. |

## Behavioral worktree proof

Purpose-built git fixture because this repository has no real grounded nodes. Checkout A captured and
committed the sidecar. Checkout B built its own gitignored `graph.db` and therefore had no local
`_mex_grounded_source` baseline rows. A literal-only body edit was committed in A, then B checked out
that commit and ran the built CLI:

```text
A$ node <lane>/dist/cli.js graph
Code graph built: 2 nodes, 1 edges across 1 files in 200ms → .mex/graph.db

A$ node <lane>/dist/cli.js graph ground
After the agent finishes retro-grounding, capture baselines now? [y/N] y
Captured 1 grounding baseline(s).
Wrote baselines to .mex/grounding.json; commit this file so other checkouts can verify grounding.

A$ git commit -m "capture grounding baseline"
[main (root-commit) a34fccc] capture grounding baseline
 create mode 100644 .mex/grounding.json

A$ git worktree add --detach <probe-wt> a34fccc194da360bb40f144d05059fe28688674a
Preparing worktree (detached HEAD a34fccc)
HEAD is now at a34fccc capture grounding baseline

B$ node <lane>/dist/cli.js graph
Code graph built: 2 nodes, 1 edges across 1 files in 38ms → .mex/graph.db

B$ node <lane>/dist/cli.js check --json
{
  "score": 100,
  "issues": [],
  "filesChecked": 2
}

A$ # replace `subtotal >= 100 ? 0 : 12` with `subtotal >= 125 ? 0 : 15`
A$ git commit -am "change grounded pricing body"
[main 80af5bd] change grounded pricing body
 1 file changed, 1 insertion(+), 1 deletion(-)

B$ git checkout --detach 80af5bddb2f19df2679fec7055f07b9a21b88137
Previous HEAD position was a34fccc capture grounding baseline
HEAD is now at 80af5bd change grounded pricing body

B$ node <lane>/dist/cli.js check --json
{
  "score": 97,
  "issues": [{
    "code": "GROUNDING_DRIFT",
    "severity": "warning",
    "file": ".mex/patterns/pricing.md",
    "line": null,
    "message": "Grounded node body changed: function:618371ffd6c26f9bbcc7f75bdeb54da2"
  }],
  "filesChecked": 2
}

A$ git worktree remove --force <probe-wt>
[exit 0]
A$ git worktree prune
[exit 0]
```

Both temporary checkout paths were removed after the run.

---


## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (transcript above)
- [x] `npx vitest run` passes — 455 passed, 4 skipped
- [x] `npm run typecheck` passes
- [x] `npm run typecheck --workspace mex-mcp` passes
- [x] `npm run build` passes
- [x] `node dist/cli.js check --quiet` remains 100/100
- [x] Working note records the design, dead ends, and behavioral proof
- [x] Worktrees / scratch dirs cleaned up

## Follow-ups

- [ ] `AGENT-ONBOARDING.md:35` calls `.mex/config.json` "the only machine-written file" — `.mex/grounding.json` makes that stale. Parent owns that file.
- [ ] `mex sync` cannot show an old-vs-new body diff in a checkout that never captured locally (by the sub-decision above). A future option is reading the old body from the sidecar's git history.

## Handoff

Parent-owned follow-up only: promote the resolved `graph.db` ignore-policy inference and update
`AGENT-ONBOARDING.md:35` to acknowledge `.mex/grounding.json` as a second machine-written file.
