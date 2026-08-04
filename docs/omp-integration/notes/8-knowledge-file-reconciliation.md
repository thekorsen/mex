# Issue #8 — No reconciliation model for concurrent edits to .mex knowledge files

- **Issue:** https://github.com/thekorsen/mex/issues/8
- **Milestone:** Multi-developer reconciliation
- **Branch:** `omp/docs`
- **Status:** ready for review
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

Decide — in writing, with no code — what mex's story is when two people or two agent sessions edit the same `.mex` knowledge file: whether we lean on git plus conventions or build structure, whether unparseable frontmatter becomes a hard error, and whether `mex sync` refuses to run on a conflicted tree. Then split the implementation into issues someone else can pick up.

Deliverable: [`../design/knowledge-file-reconciliation.md`](../design/knowledge-file-reconciliation.md).

## Acceptance criteria

Copied from the issue's `## Acceptance` verbatim, as a checklist.

- [x] What the knowledge-file merge story is (git-native + conventions, per-block IDs, append-only journals, or per-author sections). → design §4, §7; Decision 1 below
- [x] Whether frontmatter parse failure becomes a hard error (strongly recommended) and what breaks if it does. → design §1, §4 step 1; Decision 2 below
- [x] Whether `mex sync` becomes conflict-aware (refuses to run on a dirty/conflicted `.mex/`). → design §6; Decision 3 below
- [x] Then split implementation into separate issues. → design §10 (issues A–H)
- [x] Do not close this by implementing a partial guess. → zero code changes; two docs written, nothing else touched

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| `extractFrontmatter` returns `null` for **three** distinct states, not two: no `yaml` node, `YAML.parse` threw, and an empty document that parses to `null` | `src/markdown.ts:20-31` | executed (parser inspection) |
| The test suite **deliberately asserts** `null` for both no-frontmatter and invalid YAML, so "null → error" would change a documented contract | `test/markdown.test.ts:73-75`, `:77-82` | read-only |
| `parseFrontmatter` is a public compatibility-contract export, so its signature must not change | `src/index.ts:32`, contract declared `src/index.ts:1-11` | read-only |
| `parseFrontmatter` adds a **fourth** meaning to `null` — file I/O failure — by wrapping the read in its own swallowing catch | `src/drift/frontmatter.ts:9-14` | read-only |
| Three checks consume the one `null`: `DEAD_EDGE` returns zero issues; the `last_updated` staleness signal drops (git-history signals still fire, so staleness is degraded not dark); `grounds_to` grounding returns zero (inline `mex://` anchors still checked) | `src/drift/index.ts:110-133`; `src/drift/checkers/edges.ts:13`; `src/drift/checkers/staleness.ts:77-88`, `:122`; `src/drift/checkers/grounding.ts:31`, `:60-83` | read-only |
| One corrupt grounded file can disable checker #12 **scaffold-wide**, because `hasGroundings` gates whether the runtime is constructed at all | `src/drift/index.ts:71-75`, `:78`, `:127` | read-only |
| A clean `git merge` (exit 0, zero conflict markers) produces a duplicate `last_updated` key when one writer relocates the field and the other preserves position | fixture: `git merge` exit 0, `grep -c '<<<<<<<'` → 0 | executed |
| **Corruption raises the drift score.** Same fixture tree with one real dead edge: valid frontmatter → `score 90`, one `DEAD_EDGE`. Add one duplicate key → `score 100`, `issues: []` | `mex check --json` on two fixture trees | executed |
| Conflict markers *inside* an intact YAML block → `YAML.parse` throws → `null` → `mex check` reports `100/100`, exit 0 | fixture + parser inspection | executed |
| Conflict damage that destroys the closing `---` yields **zero `yaml` nodes**, making it indistinguishable from legitimate body-only Markdown. Settles an oracle `[INFERENCE]`. Structural consequence: the frontmatter contract cannot catch this case even in principle | parser inspection (3 delimiter-damage variants) | executed |
| `writeGroundings` on unparseable frontmatter emits **only** `grounds_to` — `name`, `description`, `triggers`, `edges` are silently destroyed, in the same pass `templates/SYNC.md:49-52` promises they survive | `src/markdown.ts:54` (`?? {}`) + `:56-61`; executed against a faithful re-implementation of `src/markdown.ts:17-64` | executed |
| `YAML.stringify` round-trip drops interleaved comments and unquotes `"2026-08-04"` → `2026-08-04` | `src/markdown.ts:56`; executed | executed |
| `YAML.parseDocument`/`set`/`String(doc)` preserves comments **and** quoting on the already-pinned `yaml` 2.8.3 — no new dependency | `package.json:76`; executed | executed |
| Plain writer-mode `mex sync` writes tracked Markdown **before** its first drift report and before any output; a user who then picks `3) Exit` has already been modified | `src/sync/index.ts:109-121` → `src/graph/runtime.ts:145,159`; report at `:122`; exit branch at `:221-223` | read-only |
| `--dry-run` does **not** reach that write — guarded at `:109`, returns at `:176-184` before invoking a tool. So "sync writes during dry-run" is **not** a real bug; it is a plain-`sync` concern only | `src/sync/index.ts:109`, `:176-184` | read-only |
| The no-write invariant is held by one call-site condition, not by structure — `mex check --fix` calls `runSync(config, {})` with no `dryRun`, taking the writing path | `src/cli.ts:159-162` | read-only |
| A **second** tracked-Markdown writer runs *after* the agent session: `captureGroundingBaselines` globs all scaffold Markdown and `refreshGroundingBaselines` whole-file writes. Detection purity does not touch it | `src/sync/index.ts:250` → `src/graph/runtime.ts:83-91`, `:234` | read-only |
| Blast radius of a new error: 10 points; `mex check` exit 1; `mex doctor` exit 1; `mex check --fix` enters `runSync` on **any** error; `IssueCode`/`DriftIssue`/`runDriftCheck` are public | `src/drift/scoring.ts:3-15`; `src/cli.ts:158`,`:165`; `src/doctor.ts:15`,`:33`; `src/cli.ts:158-162`; `src/index.ts:27-31`,`:58-63`; `src/types.ts:104-133` | read-only |
| Interaction worth naming: step A routes corrupt files into `--fix` → `runSync` → the writers, i.e. into the truncation path. So A slightly increases exposure to that bug until D lands | `src/cli.ts:158-162` + `src/markdown.ts:54` | read-only |
| Four of eleven scaffold files legitimately have **no** frontmatter — the false-positive floor any hard error must respect | executed via `parseFrontmatter` over the scaffold glob | executed |
| A bare row of `=======` is parsed by remark as a **setext H1**, so a naive marker scan would false-positive on valid Markdown. Upgrades an oracle `[INFERENCE]` to verified with a named cause | executed (remark parse → `heading` depth 1); grep: no such lines in `.mex`/`templates` today | executed |
| `mex check` runs fine **outside** a git repo, so a hard git prerequisite would be a real compatibility change; the guard must degrade to marker-scan-only | executed in a non-git temp dir → `100/100`, exit 0 | executed |
| No `porcelain`/`status`/`isClean`/`checkIsRepo` anywhere in `src/`; `src/git.ts` exposes only `log` and `diff`. `simple-git` is already a dependency | executed grep (no matches); `src/git.ts:1`, `:13-50`, `:53-63` | executed |
| `EventEntry` has no author field. `source` is documented free-form provenance ("meeting"/"manual"/"agent"); `cwd` is a repo-relative path | `src/events.ts:13-35`, `:25-29`, `:78` | read-only |
| **Nothing** under `src/drift/` reads the event journal. All five `readEvents` consumers are display-only | executed grep (no matches); `src/doctor.ts:18`, `src/tui.ts:69`, `src/events.ts:90`, `packages/mex-mcp/src/tools/log.ts:48`, `timeline.ts:39` | executed |
| The only `merge`/`conflict`-shaped code in `src/` is `mergeIntoConfig` (shallow `Object.assign` over `config.json`) and `CROSS_FILE_CONFLICT` (compares dependency **version claims**). Neither is a knowledge-file merge. Remaining hits are SQLite upserts | `src/config.ts:238-252`; `src/drift/checkers/cross-file.ts:9-33`; `src/graph/fingerprint-store.ts:33`,`:95`; `src/graph/db/store.ts:155` | executed grep |
| The graph DB **is** already concurrency-hardened (`busy_timeout` first, WAL, per-connection `foreign_keys`) — it is only the Markdown writes that are unguarded | `src/graph/db/database.ts:24-30` | read-only |
| "Surgical edits" / "PRESERVE YAML frontmatter" / "NEVER delete existing decisions" is prose aimed at a model, duplicated **twice more** in `sync.sh` | `templates/SYNC.md:47-55`; `sync.sh:182-190`, `:266-273` | read-only |
| The surgical-edit rules survived the sibling lane's `templates/SYNC.md` rewrite at the line numbers cited above | `templates/SYNC.md:47-55` re-grepped after their edit | executed |
| The decision-log convention is structurally recognizable only for template-following files: `## Decision Log`, `###` entries, a mutable `**Status:**` line. Guidance, not schema | `templates/context/decisions.md:36-53` | read-only |
| The sync brief embeds the entire current file in a fenced block, structurally inviting the whole-file rewrite the prose forbids | `src/sync/brief-builder.ts:112-120` | read-only |
| Many issue types carry `line: null`, so section-scoped briefs often have no section to scope to | `src/types.ts:125-133`; `src/drift/checkers/edges.ts:28`; `src/drift/checkers/staleness.ts:115` | read-only |
| The in-product nudge says "mex is building team features"; no design for them exists in the tree | `src/feedback/index.ts:19-20` | read-only |
| `graph.db` is gitignored, so grounding baselines never travel between clones — the #5 boundary | `.gitignore:21` | read-only |
| Whether downstream exhaustive `IssueCode` switches exist | not observable from this repo | **`[INFERENCE]`** — settled by `COMPATIBILITY.md`'s additive-union policy + whether a published external consumer exists |
| Which `test/**` fixtures would need updating for step A | outside this lane's file scope; ran no gates | **`[INFERENCE]`** — settled by grepping `test/**` for fixtures with unparseable frontmatter |

## Commands run

All with `MEX_TELEMETRY=0`. Every fixture was a throwaway `mktemp -d` copy of this repo's `.mex/`; **no repository file was modified** to produce any of this, and **no gate was run**.

```bash
# ── The sharpest result: corruption RAISES the score ──
# Two identical fixture trees, both with one genuinely dead edge target.
# Tree A: valid frontmatter. Tree B: identical + one duplicate `last_updated`
# (exactly what the clean merge below produces).
$ node dist/cli.js check --json          # in tree A
 score 90 issues 1
    error DEAD_EDGE .mex/context/architecture.md | Frontmatter edge target does not exist: context/DOES-NOT-EXIST.md

$ node dist/cli.js check --json          # in tree B
 score 100 issues 0

# ── A CLEAN merge produces that corruption. No conflict marker anywhere. ──
$ git merge dev-a -m merge
Auto-merging .mex/context/architecture.md
Merge made by the 'ort' strategy.
MERGE_EXIT=0
$ grep -c '<<<<<<<\|=======\|>>>>>>>' .mex/context/architecture.md
0
$ node -e '... parseFrontmatter(mergedFile) ...'
parseFrontmatter => NULL (all frontmatter checks now dark)
$ node dist/cli.js check --quiet
mex: drift score 100/100
EXIT=0
$ node -e '... YAML.parse(block) ...'
THREW: YAMLParseError: Map keys must be unique at line 21, column 1

# ── Conflict markers INSIDE frontmatter: same silence ──
$ node dist/cli.js check --quiet
mex: drift score 100/100
EXIT=0
# ...with `<<<<<<< HEAD` / `>>>>>>> fa` sitting between the --- fences.

# ── The delimiter-damage finding (settles an oracle [INFERENCE]) ──
$ node ./scratch.mjs      # remark + YAML, faithful to src/markdown.ts:17-31
conflict inside intact block       yamlNodes=1  parse=THREW (Implicit keys need to be on a single line)
closing delimiter destroyed        yamlNodes=0  parse=null
conflict wraps the delimiters      yamlNodes=0  parse=null
body-only markdown (legit)         yamlNodes=0  parse=null
empty frontmatter document         yamlNodes=1  parse=null
scalar frontmatter (shape)         yamlNodes=1  parse="just a string"

# ── writeGroundings destroys the rest of the block ──
# Input block had: name, edges, last_updated, owner (+ conflict markers).
$ node ./scratch.mjs
extractFrontmatter(conflicted) => null
=== writeGroundings(conflicted, [1 grounding]) ===
---
grounds_to:
  - node: function:abc
    fingerprint: mh:64:dead
---

# Architecture
body prose survives

# ── YAML.stringify churn vs parseDocument ──
# stringify: dropped the `# comment`, unquoted "2026-08-04" -> 2026-08-04
# parseDocument/set/String: preserved BOTH. yaml 2.8.3, already a dependency.

# ── The setext false positive (settles a second oracle [INFERENCE]) ──
$ node -e '...remark.parse("Architecture Overview\n=======\n")...'
node type: heading depth: 1
# => a bare `=======` is a valid setext H1. Marker scan MUST be stateful.

# ── Non-git compatibility ──
$ git rev-parse --is-inside-work-tree
fatal: not a git repository
$ node dist/cli.js check --quiet
mex: drift score 100/100
EXIT=0

# ── Prose-body conflict: git behaves correctly (the "same as baseline" row) ──
$ git merge pa -m merge
CONFLICT (content): Merge conflict in .mex/context/architecture.md
MERGE_EXIT=1
$ node -e '... parseFrontmatter ...'
ok, keys=name,description,triggers,edges,grounds_to,last_updated

# ── Absence proofs ──
$ grep -rn 'porcelain|\.status\(|isClean|revparse|checkIsRepo' src/
No matches found
$ grep -rn 'writeFileSync|appendFileSync|readEvents|eventLogPath' src/drift/
No matches found

# ── Gates: NOT RUN (orchestrator owns them) ──
$ npm run build     # NOT RUN
$ npm test          # NOT RUN
```

---

## Decisions

### Decision 1: The knowledge-file merge story is git-native plus enforced conventions

- **Options considered:**
  1. **Git-native + conventions + safety rails.** Keep plain Markdown, keep git's 3-way merge, and invest in honest diagnostics, write discipline, and a post-write invariant guard.
  2. **Per-block IDs.** Give each semantic block a stable ID so writes target blocks and merges reconcile per block.
  3. **Append-only journals as the merge mechanism.** Make `decisions.jsonl` load-bearing and derive knowledge state from the journal.
  4. **Per-author sections.** `## Architecture (alice)` / `(bob)`, reconciled at read time.
  5. **CRDT/OT.** Real convergence machinery.
- **Chosen:** Option 1.
- **Why:** The evidence inverted the intuitive priority. The failure people imagine — a prose-body conflict — is the one case that already works: git reported `CONFLICT (content)`, exit 1, and left frontmatter parseable. **Every measured failure is frontmatter parsing or serialization**, and the sharpest of them needs no merge algorithm at all: a *clean* merge (exit 0, zero markers) produced a duplicate YAML key that took a fixture from `score 90` with a real error to `score 100` with none. Option 2 costs an ID convention in every human-read file, LLM-enforced generation (which row 10 proves does not work when enforced by prose), a migration, plus rename/split/join semantics — to improve only the row that already works, with no consumer able to use a block ID today since the brief still embeds whole files (`src/sync/brief-builder.ts:112-120`). Option 3 is not a merge mechanism: nothing in `src/drift/` reads the journal (verified grep, no matches). Option 4 fragments the knowledge the wiki exists to consolidate — the file is the unit of comprehension, and `ROUTER.md` routes an agent to one file expecting one coherent answer. Option 5 imposes a permanent, effectively irreversible format tax for convergence in a low-edit-rate, human-reviewed corpus, and its goal is wrong anyway: when two developers assert different architectures the correct outcome is a human deciding, not a merge function silently picking.
- **What this rules out:** No 3-way merge implementation, no block IDs, no per-author namespacing, no CRDT, no locking. Prose-body conflicts stay a human's job. Concurrent *uncommitted* work in one worktree stays last-writer-wins.
- **Revisit if:** Measured `.mex` conflict **resolutions** (not raw co-edits) show git genuinely failing often, on disjoint semantic sections, where a stable block ID would have changed the outcome. That measurement does not exist and is proposed as its own issue (design §10, issue G). Note git history alone is insufficient — it misses rebases and locally-resolved conflicts.

### Decision 2: Present-but-invalid frontmatter becomes a hard `error` — but `null` does **not**

- **Options considered:**
  1. Leave it silent.
  2. `warning` severity first, `error` in a later release.
  3. **`error` immediately, scoped to *present-but-invalid*, via an internal discriminated parse result; the public nullable reader is unchanged.**
  4. `error` on any `null` return.
- **Chosen:** Option 3.
- **Why `error` and not `warning`:** A warning costs 3 points (`src/drift/scoring.ts:3-7`) versus 10 for an error, so the tree still looks green — which preserves precisely the falsely-healthy signal this ticket exists to destroy. It would also leave `mex check --fix` inert, since that path fires only when an error exists (`src/cli.ts:158-159`). The state is never legitimate and is machine-detectable with zero ambiguity. Reporting `100/100` on a corrupt file is worse than having no tool: it is a tool that certifies the corruption.
- **Why NOT option 4 — this is the load-bearing half of the decision:** `null` currently means at least four different things — no `yaml` node, `YAML.parse` threw, an empty document that parses to `null`, and file I/O failure (`src/markdown.ts:20-31`, `src/drift/frontmatter.ts:9-14`). `test/markdown.test.ts:73-82` **deliberately asserts** that the first two are identical, and `parseFrontmatter` is a public compatibility-contract export (`src/index.ts:32`, contract at `:1-11`). Option 4 would either start erroring on legitimately body-only Markdown — four of eleven files in this repo's own scaffold — or, seeing that, keep the nullable wrapper and preserve the silence. Both are failures. The fix is an internal `FrontmatterParseResult` (`absent` | `valid` | `invalid-syntax` | `invalid-shape` | `unreadable`) that reports **only** present-but-invalid, treats an empty document as valid-empty, never classifies an I/O error as a YAML fault, and leaves the public reader byte-for-byte unchanged so those tests pass unmodified.
- **What breaks, honestly:** Repos with already-corrupt frontmatter newly fail `mex check` and `mex doctor` (exit 1) — the intended migration cost, and it must be in release notes rather than softened. A downstream exhaustive TypeScript `switch` over `IssueCode` can break on an additive member (`[INFERENCE]`, external consumers not observable here). Test fixtures with malformed frontmatter may need updating (`[INFERENCE]`, out of this lane's scope). And a real interaction: step A routes corrupt files into `--fix` → `runSync` → the whole-file writers, i.e. into the truncation path — which is why minimal-diff writes should land promptly after.
- **What this rules out:** No auto-repair. Choosing which duplicate key value is correct is a semantic decision the tool cannot make; guessing would silently discard a real edit, recreating this exact bug class. Heartbeat stays best-effort and does not consume the richer diagnostic, to avoid double-reporting one fault in two commands.
- **Also ruled out by evidence, not choice:** this cannot catch conflict damage that destroys a frontmatter delimiter — verified to yield **zero** `yaml` nodes, indistinguishable from body-only Markdown. That case is covered only by the marker scan in Decision 3. The two mechanisms are complementary, and acceptance tests must cover recognized-YAML conflicts, broken delimiters, **and** ordinary body-only Markdown.
- **Revisit if:** The false-positive rate on `absent` turns out nonzero in the field — which would mean the classifier is wrong, not that the severity is.

### Decision 3: `mex sync` becomes conflict-aware and refuses by default in writer mode

- **Options considered:**
  1. No guard.
  2. Warn only.
  3. Conflict-marker scan only.
  4. `git status` only.
  5. **Both signals; refuse unmerged *and* ordinary-dirty by default; `--allow-dirty` for non-unmerged only; no `--allow-conflicts`; `--dry-run` stays read-only and reports.**
- **Chosen:** Option 5, running at the **very start** of `runSync`, before `persistMovedGroundings`.
- **Why both signals:** Neither is sufficient, and the reason is now verified rather than assumed. `git status --porcelain=v1 --untracked-files=all -- .mex` catches unmerged *index* states without relying on file text. The marker scan catches marker text in an otherwise ordinary modified file — and is the **only** mechanism that can see a conflict which destroyed a frontmatter delimiter, since that leaves no `yaml` node for Decision 2 to classify. Conversely the marker scan cannot see the clean-merge duplicate-key case, which has no markers at all. The scan must be **stateful**, requiring a coherent `<<<<<<<`/separator/`>>>>>>>` sequence: a bare `=======` is a valid setext H1 (verified — remark yields `heading` depth 1), so a naive scan would flag legitimate Markdown. Git must be optional: `mex check` runs fine outside a repo (verified), so degrade to marker-scan-only and say so rather than implying protection that is not there.
- **Why refuse ordinary dirtiness, not warn — I changed position here:** My draft treated plain dirtiness as a warning to avoid being user-hostile. The oracle review argued refusal, and it wins on evidence: three separate whole-file writers touch `.mex` Markdown during a sync — `persistMovedGroundings` (`src/graph/runtime.ts:159`), the external agent CLI (`src/sync/index.ts:244`), and `captureGroundingBaselines`/`refreshGroundingBaselines` (`:250` → `runtime.ts:234`). Uncommitted `.mex` work is *precisely* what gets clobbered, and a warning that is printed and ignored protects nothing.
- **Why no `--allow-conflicts`:** A file with live `<<<<<<<` is not a safe LLM input under any flag. The correct action is `git checkout --ours/--theirs` or a manual resolve. `--allow-dirty` bypasses only non-unmerged states and must print the affected paths.
- **What this rules out:** `mex check` does **not** refuse — it writes nothing; reporting the unsafe state there as `info` is enough. `--dry-run` does not refuse either; it reports and exits, making it the natural inspection tool when the guard fires.
- **Accepted failure mode:** A developer mid-rebase with intentional `.mex` edits is blocked. That is correct, and the remedies all preserve their work: resolve/stash/commit, inspect with `--dry-run`, or consciously pass `--allow-dirty`. An unrelated rebase with no `.mex` changes is not blocked, because the check is scoped to `.mex`. Residual risk worth naming: default-refuse trains reflexive `--allow-dirty` use, so the message must print specific paths and a specific reason.
- **Revisit if:** Telemetry or reports show `--allow-dirty` being used routinely rather than exceptionally — that would mean the default is mis-tuned, not that the guard is wrong.

### Decision 4: Sequence detection-purity ahead of minimal-diff writes

- **Options considered:**
  1. Loud frontmatter → minimal-diff writes → detection purity (my original draft order).
  2. **Loud frontmatter → detection purity + preflight together → minimal-diff writes.**
- **Chosen:** Option 2. This reverses my draft, on the oracle review's argument, which I verified and accept.
- **Why:** The two are different kinds of fix. Minimal-diff serialization is *churn reduction* — it makes future conflicts rarer. Detection purity plus the preflight is *damage prevention* — it stops mex writing tracked Markdown at moments the user has not consented to. Plain writer-mode `mex sync` writes at `src/graph/runtime.ts:145,159` via `src/sync/index.ts:113`, **before** the drift check at `:122` and before any output; a user who then picks `3) Exit` (`:221-223`) has already been modified. Minimal-diff writes make that write *tidier* — a tidier unrequested write to a conflicted file is still an unrequested write to a conflicted file. Detection purity and the preflight ship together because they are one invariant; shipping half of it ships an unenforced guard.
- **Why minimal-diff writes still matter, third rather than dropped:** `captureGroundingBaselines` is a **second** whole-file writer that runs *after* the agent session (`src/sync/index.ts:250` → `src/graph/runtime.ts:83-91`, `:234`). Detection purity does not touch it. So churn reduction remains genuinely necessary — it is simply not the most urgent thing.
- **What this rules out:** Treating minimal-diff serialization as a substitute for write discipline.
- **Revisit if:** Detection purity turns out to be materially harder than the function split it appears to be, in which case the cheap churn win is worth taking first.

### Decision 5: Drop the event `author` field from this ticket

- **Options considered:**
  1. Add `author` to `EventEntry` now.
  2. Defer with a note.
  3. **Drop from this ticket, with a stated rule and a named unblocking condition.**
- **Chosen:** Option 3. My draft said "defer"; the oracle review argued harder, and the harder position is right.
- **Why:** `decisions.jsonl` genuinely is the one structure in the tree that survives concurrent writes — one JSON object per line via `appendFileSync` (`src/events.ts:85`), unparseable lines skipped (`:143-145`). And it has no author field: `source` is documented free-form provenance (`:25-29`), `cwd` is a path (`:78`). Adding one is trivial. But **nothing in the drift or sync pipeline reads the journal at all** (verified grep under `src/drift/`: no matches; all five consumers are display-only). The rule: **an append-only journal without a consumer that makes a resolution decision is provenance, not reconciliation.** Adding `author` would record attribution while selecting, merging, and protecting nothing, while permanently committing the record format and forcing a guess at identity source (git email? `$USER`? session id?) — each with different privacy properties, in a codebase whose feedback module deliberately never touches identifying data (`src/feedback/index.ts:4-8`).
- **Why "drop" beats "defer":** Deferring invites re-litigation every milestone. A stated rule with a named unblocking condition does not.
- **What this rules out:** Attribution stays impossible; `mex timeline` in a team repo stays undifferentiated. Accepted — git already attributes commits, and knowledge files are committed.
- **Revisit if:** Someone designs the consumer. Most plausible: a check flagging two authors independently logging decisions touching the same `files` entry within a window. Design the reader first; the field lands in the same PR.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Reusing `MISSING_PATH` or any existing checker to detect frontmatter corruption indirectly | Path claims are filtered to `ROUTER.md` only (`src/drift/index.ts:140`, a deliberate false-positive guard for upstream #79) and fenced blocks emit only `kind:"command"` claims (`src/drift/claims.ts:83-102`). Corruption is a parse-level fact; no claim-level checker can see it. Abandoned before writing it up. |
| Specifying the fix as "make `extractFrontmatter`'s `null` an error" — **my own draft's framing** | Would break the four scaffold files that legitimately have no frontmatter, and would change a public contract two tests deliberately pin (`test/markdown.test.ts:73-82`, `src/index.ts:32`). Replaced with the discriminated result in §1. This was the draft's most dangerous imprecision. |
| Ordering minimal-diff writes ahead of detection purity — **my own draft's order** | A tidier unrequested write is still an unrequested write. Verified that plain `mex sync` writes before its first report (`src/sync/index.ts:113` vs `:122`), so serialization hygiene does not remove the surprise mutation. Reversed in Decision 4. |
| Treating ordinary dirty `.mex` as a warning rather than a refusal — **my own draft's position** | Three separate whole-file writers run during a sync, so uncommitted work is exactly what gets clobbered; a printed-and-ignored warning protects nothing. Reversed in Decision 3. |
| Assuming a warning-severity rollout would be the safe first step for `INVALID_FRONTMATTER` | 3 points vs 10 leaves the tree green (`src/drift/scoring.ts:3-7`) and leaves `--fix` inert (`src/cli.ts:158-159`) — it preserves the exact false-health signal being fixed. Explicitly rejected. |
| Auto-repairing duplicate YAML keys | Requires choosing which value is correct — a semantic decision. Any heuristic (last-wins, newest-date-wins) silently discards a real edit, recreating this bug class. Rejected in design §7.3. |
| Auto-restoring the preimage when the post-write guard vetoes a session | The restore is itself a whole-file write over content mex did not author — a second clobber. Leaving the diff for review is strictly safer and the user has git. Made an explicit design rule instead. |
| A final-only (post-baseline-capture) output validator | `captureGroundingBaselines` writes the baseline (`src/graph/runtime.ts:227`,`:234`), so a bad edit would update the baseline *first*, destroying the very drift signal that would have caught it. Validation must precede capture — this ordering is the whole point of design §4 step 4. |
| Diff-size / line-count limits as the surgical-edit enforcement | Measures churn, not preservation. Large valid changes false-positive; a one-line deletion of a decision heading is destructive and tiny. Both directions fail. |
| Section-scoped sync briefs as the enforcement mechanism | A narrower prompt cannot stop an agent editing elsewhere, and many issues carry `line: null` (`src/types.ts:125-133`) so there is often no section to scope to. Useful for focus later; never enforcement. |
| A naive conflict-marker scan matching a bare `=======` | Verified false positive: remark parses a row of equals signs as a setext H1 (`heading` depth 1). Forced the stateful-sequence requirement in Decision 3. |
| Hoping the frontmatter contract alone would cover conflict-damaged files | Verified that destroying the closing `---` yields **zero** `yaml` nodes — indistinguishable from legitimate body-only Markdown. No parse-time classifier can catch it; it needs the independent marker scan. This is why both mechanisms exist. |
| Reading `writeGroundings` behavior from the built `dist/` public surface | Not exported (`src/index.ts` re-exports only the documented contract), so `import { writeGroundings } from "./dist/index.js"` fails. Had to re-implement `src/markdown.ts:17-64` faithfully in a scratch script (run inside the repo so `node_modules` resolves, then deleted). |
| Trying to demonstrate the bug by hand-corrupting a file | Weak evidence — a reviewer can dismiss it as "nobody would write that". Building the **two-branch clean git merge** instead is what made the finding undeniable: both writers behaved correctly, git succeeded, and the corruption appeared anyway. |
| Looking for prior art on team features in the tree, prompted by the in-product nudge | `src/feedback/index.ts:19-20` says "mex is building team features" but there is no design, schema, or partial implementation anywhere in `src/`. Nothing to build on or stay compatible with. |

---

## Changes made

| File | Change |
|---|---|
| `docs/omp-integration/design/knowledge-file-reconciliation.md` | **New.** The design proposal: frontmatter parse-state contract stated first (§1), problem statement with the verified silent-health walkthrough (§2), 15-row failure-mode inventory separating worse-than-git from same-as-git (§3), five sequenced proposals (§4), the event-journal decision (§5), sync conflict-awareness spec (§6), rejections including CRDT and per-block IDs (§7), what it does not solve (§8), adjacent-work references to #7 and #5 (§9), the up-front contract plus an eight-issue split (§10), review attribution and where I disagree (§11), verification ledger (§12). |
| `docs/omp-integration/notes/8-knowledge-file-reconciliation.md` | **New.** This note. |

**Zero code changes.** No file under `src/`, `templates/`, `test/`, `packages/`, or any onboarding doc was modified. Verified by scope: the only two `write` calls in this session targeted the two paths above. The small frontmatter fix is *specified* in design §1 and §4 step 1, including its diff shape, and deliberately **not implemented** — a `design-decision` ticket is not closed by implementing an unstated guess.

## Tests added or changed

None — this is a design ticket and the lane is doc-only. The proposal specifies the acceptance-test set the implementing PR must carry (design §4 step 1, and §10's up-front contract):

| Test the implementer must write | What contract it defends |
|---|---|
| Conflict markers inside a recognized YAML block → `INVALID_FRONTMATTER` error | Present-but-invalid frontmatter is loud, not silent |
| Conflict damage destroying the closing delimiter → **no** issue from the classifier | Honest scoping: this case is the marker scan's job, not the classifier's (verified: zero `yaml` nodes) |
| Ordinary body-only Markdown → no issue | The false-positive floor; four of eleven scaffold files depend on it |
| `---\n---` empty document → treated as valid-empty | An empty block is not a broken block |
| Scalar/sequence frontmatter → `invalid-shape`, distinct message | A parseable non-mapping is malformed but not a syntax error |
| Unreadable file → not reported as invalid YAML | An I/O error is not a YAML fault |
| `parseFrontmatter` still returns `null` for both no-frontmatter and invalid YAML | The public compatibility contract (`test/markdown.test.ts:73-82` must pass unmodified) |
| Detection emits no write | `mex sync` reports before it mutates |
| Dirty vs unmerged `.mex` → correct refusal tier; `--allow-dirty` bypasses only non-unmerged | The guard's policy table |
| A bare `=======` line does not trigger the marker scan | Setext H1 is valid Markdown |
| Baseline capture is skipped after failed output validation | Validation must precede capture, or the bad edit becomes the baseline |

---

## Verification

- [x] Acceptance criteria all met — all four items in the issue's `## Acceptance`, mapped to sections above
- [x] Ran the actual thing — the proposal's factual claims were established by executing `mex check` against purpose-built git fixtures; output pasted above
- [ ] `npm test` passes — **NOT RUN.** Gate owned by the orchestrator; running it would race sibling agents in this shared worktree
- [ ] `npm run build` passes — **NOT RUN**, same reason (and `dist/` was already built by the orchestrator)
- [ ] `mex check` did not regress from `94/100` — **NOT RUN in this worktree.** No source file was changed, so no regression is possible from this lane; the two new files are under `docs/`, outside `DEFAULT_SCAFFOLD_PATTERNS`. Orchestrator to confirm
- [x] Docs updated where behavior changed — no behavior changed; the docs *are* the deliverable
- [x] Any `[INFERENCE]` I resolved was promoted — two oracle `[INFERENCE]`s were resolved to verified here (delimiter damage yields no `yaml` node; a bare `=======` is a setext H1) and are recorded in the Findings table and design §11. **Promotion into `AGENT-ONBOARDING.md` §4.2 is the orchestrator's to make — this lane is forbidden to edit that file.**
- [x] Worktrees / scratch dirs cleaned up — all fixtures were under `/tmp` via `mktemp -d`; the three scratch `.mjs` files were created in the repo root only because `node_modules` resolution requires it, and each was deleted in the same command that ran it. No untracked scratch file remains in the worktree

## Follow-ups

The proposed issue split (design §10). None of these were started here.

- [ ] **A** — Present-but-invalid frontmatter must be an `error`-severity drift issue. Internal `FrontmatterParseResult`; `INVALID_FRONTMATTER`; public nullable reader unchanged. No deps. **S.** Land first
- [ ] **B** — `mex sync` detection must not write. Split `persistMovedGroundings` into detect + apply. No deps. **S–M**
- [ ] **C** — Writer-mode `mex sync` refuses unsafe `.mex/`. Both signals, refuse unmerged + dirty, `--allow-dirty` for non-unmerged only, no `--allow-conflicts`. Depends on B. **M.** Ship with B
- [ ] **D** — Minimal-diff frontmatter writes via `YAML.parseDocument`. No deps; composes with A. **S.** Land promptly after A, since A routes corrupt files into the writer path
- [ ] **E** — Preimage + post-write invariant guard for `mex sync`. Depends on A, B, D. **L — needs its own design pass.** Do not open until A–D land
- [ ] **F** — Author identity on the event journal. **Blocked on a designed consumer**; do not open until one exists
- [ ] **G** — Measure actual `.mex` conflict resolutions (time-boxed history/PR review + maintainer conflict diary). No deps. **S, research only.** Worth opening now — it is the only thing that can retire the per-block-ID question instead of leaving it to be re-litigated
- [ ] **H** — Per-block IDs. **Not proposed.** Revisit only on G's evidence
- [ ] Adjacent, not this ticket: the surgical-edit rules are duplicated in three places (`templates/SYNC.md:47-55`, `sync.sh:182-190`, `sync.sh:266-273`) and can drift apart independently
- [ ] Adjacent, not this ticket: recommend issue #5's shareable-baseline format be append-safe or minimal-diff and never swallow its own parse errors — the same two principles as A and D, applied to a new concurrently-edited artifact
- [ ] Adjacent, not this ticket: a CI gate (#7) must call `mex check`, never writer-mode `mex sync`, which after C refuses on a dirty tree by design and needs a TTY regardless

## Handoff

The ticket is complete as a design deliverable: both files are written, all four acceptance items are answered, and the implementation is split into issues A–H with dependencies and sizes.

What a fresh session should know:

1. **The strongest single fact is the score inversion.** A clean `git merge` (exit 0, zero conflict markers) produced a duplicate `last_updated` key that moved a fixture from `score 90` with a real `DEAD_EDGE` to `score 100` with no issues. If anyone doubts the priority ordering, reproduce that — it takes two branches and about a minute.
2. **Do not let issue A be implemented as "null → error."** That is the documented trap (design §1, Decision 2, Dead ends). It would break the four legitimately frontmatter-less scaffold files and change a public contract two tests deliberately pin. Point the implementer at design §1 before they open an editor.
3. **The classifier and the marker scan are not redundant.** Verified: delimiter damage yields zero `yaml` nodes, so A cannot see it; and the clean-merge duplicate key has no markers, so C cannot see it. Anyone proposing to drop one should read design §2.3 first.
4. **Orchestrator actions outstanding:** run the repo gates; confirm `mex check` still reports `94/100`; and decide whether to promote the two resolved `[INFERENCE]`s (delimiter damage → no `yaml` node; bare `=======` → setext H1) into `AGENT-ONBOARDING.md` §4.2, which this lane was forbidden to edit.
