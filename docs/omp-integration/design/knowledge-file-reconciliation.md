---
name: knowledge-file-reconciliation
description: Design proposal for reconciling concurrent edits to .mex knowledge files. Covers the frontmatter parse-state contract, the merge story, whether mex sync becomes conflict-aware, a post-write invariant guard, and the issue split for implementation.
last_updated: 2026-08-04
---

# Reconciling concurrent edits to `.mex` knowledge files

Design proposal for [issue #8](https://github.com/thekorsen/mex/issues/8). **This is a proposal. It changes no code.**

Status: proposed, not accepted. Every code change described here is a described change, not a landed one.

This document was reviewed by an independent oracle review while in draft. That review reordered the sequence in §4, added the post-write invariant guard (§5), and hardened the frontmatter contract in §2. Both are attributed at §11. Two of its points are argued against, in §5.4 and §7.1.

---

## 1. The one contract to get right, stated first

**Do not implement this as "make `null` an error."** That phrasing is the single most likely way this proposal gets implemented wrong, so it is the first normative statement in the document.

`extractFrontmatter` returns `null` for **two structurally different situations**, and the current test suite deliberately asserts that both do (`test/markdown.test.ts:73-75` "returns null for no frontmatter"; `:77-82` "returns null for invalid YAML"):

- **absent** — there is no `yaml` node in the parsed tree. A legitimate, common, permanently-supported state. Four of the eleven files in this repo's own scaffold are in it (`SETUP.md`, `SYNC.md`, `patterns/README.md`, `patterns/INDEX.md`; measured via `parseFrontmatter`).
- **invalid** — a `yaml` node exists but `YAML.parse` threw. Never legitimate.

An implementer told "null becomes an error" will either error on body-only Markdown (a false-positive flood that will get the change reverted) or, seeing that risk, keep the nullable wrapper and preserve the silence this ticket exists to remove.

### The normative contract

Introduce an **internal** discriminated parse result. Minimum states:

```
type FrontmatterParseResult =
  | { kind: "absent" }                                      // no yaml node — silent, forever
  | { kind: "valid"; frontmatter: ScaffoldFrontmatter }      // parsed to an object (incl. empty)
  | { kind: "invalid-syntax"; error: string; line: number }  // yaml node present, YAML.parse threw
  | { kind: "invalid-shape"; error: string; line: number }   // parsed, but not a mapping
  | { kind: "unreadable"; error: string };                   // file I/O failed — NOT a YAML fault
```

Rules, each with its verified justification:

1. **`absent` never emits an issue.** Not now, not behind a flag.
2. **Only `invalid-syntax` and `invalid-shape` emit the new error.** These are the states that are never correct.
3. **`unreadable` is not a YAML fault.** `src/drift/frontmatter.ts:9-14` currently collapses a read failure into the same `null` as a parse failure. Reporting "invalid YAML" for a permissions error would be a false claim.
4. **An empty document is `valid`, not invalid.** Verified: `---\n---` yields one `yaml` node and `YAML.parse` returns `null` without throwing. That is empty metadata, not broken metadata — and note this is a *third* current source of `null`, distinct from the two the tests name.
5. **A scalar or sequence is `invalid-shape`.** Verified: `---\njust a string\n---` parses successfully to the string `"just a string"`. Today that flows onward as if it were a frontmatter object; `frontmatter?.edges` is `undefined`, so it silently checks nothing. It is malformed and should say so, but it is a *different* fault than a syntax error and deserves a distinct message.
6. **The public nullable reader does not change.** `parseFrontmatter` is exported from `src/index.ts:32` under the compatibility contract declared at `src/index.ts:1-11`. It stays `ScaffoldFrontmatter | null` with today's exact behavior, implemented as a thin wrapper over the result (`kind === "valid" ? frontmatter : null`). The new information is additive and internal. `test/markdown.test.ts:73-82` continues to pass **unmodified** — which is the correct outcome, since those assertions describe the public contract, not the bug.

Everything in §4 step 1 is an application of this contract.

---

## 2. Problem statement

`.mex/` is git-tracked Markdown. Two developers editing the same file get whatever git gives them: a 3-way merge for prose and, on conflict, conflict markers. That part works and this proposal does not try to improve it.

The problem is narrower and worse: **mex's health signal for a knowledge file is gated on that file's frontmatter parsing, and a parse failure is indistinguishable from having no frontmatter.** Every frontmatter-derived check then returns clean, so the file reports as healthy while it is corrupt.

### 2.1 Which checks go dark

`runDriftCheck` calls `parseFrontmatter` once per file (`src/drift/index.ts:110`) and feeds that one value to three consumers:

| Consumer | Call site | Behavior when `null` |
|---|---|---|
| `checkEdges` — `DEAD_EDGE` | `src/drift/index.ts:111` | `if (!frontmatter?.edges) return []` (`src/drift/checkers/edges.ts:13`) — zero issues |
| `checkStaleness` — the `last_updated` signal | `src/drift/index.ts:115-121` | `opts.lastUpdated` undefined → `daysSinceFrontmatterDate` returns `null` (`src/drift/checkers/staleness.ts:122`); the git-history signals at `staleness.ts:77-88` still fire, so staleness is *degraded*, not fully dark |
| grounding checker #12 | `src/drift/index.ts:127-133` | iterates `frontmatter?.grounds_to ?? []` (`src/drift/checkers/grounding.ts:31`) — zero `grounds_to` issues; inline `mex://` anchors still checked (`grounding.ts:60-83`) |

A fourth consumer decides whether the graph runtime loads at all: `hasGroundings` (`src/drift/index.ts:71-75`). If the only grounded file in a scaffold has broken frontmatter and no inline anchors, `groundingRuntime` is never constructed (`:78`) and checker #12 runs **for no file at all**.

`src/heartbeat.ts:66-77` has the same blindness for its staleness display, via its own separate `parseFrontmatter` call at `:68`.

### 2.2 One realistic scenario, end to end

Two sessions on one repo, both doing exactly what mex tells them to do.

1. Base `.mex/context/architecture.md` carries the shipped placeholder `last_updated: [YYYY-MM-DD]` (`templates/context/architecture.md:18`, byte-identical at `.mex/context/architecture.md:18`) at the **bottom** of the frontmatter block.
2. **Dev A** runs `mex sync`. The brief says "Update `last_updated` in the YAML frontmatter of every file you change" (`templates/SYNC.md:57`). The agent inserts `last_updated: 2026-08-04` near the **top**, beside `name:`. Nothing forbids this — the instruction names the field, not its position.
3. **Dev B**, on a branch, runs `mex graph ground`, reaching `writeGroundings` (`src/graph/runtime.ts:234`). That re-serializes the whole block with `YAML.stringify` (`src/markdown.ts:56`) in object-insertion order, so `last_updated` lands somewhere else than A put it.
4. `git merge`. The two insertions sit in different hunks with unrelated context, so **git merges cleanly — exit 0, no conflict markers.** The result has `last_updated` twice.
5. `YAML.parse` throws `YAMLParseError: Map keys must be unique`. `extractFrontmatter` catches it and returns `null` (`src/markdown.ts:26-28`).
6. `mex check` prints `drift score 100/100`, exit 0.

Step 6 is the failure. Measured on a fixture: with valid frontmatter carrying one genuinely dead edge target, `mex check --json` → `score 90`, one `DEAD_EDGE` error. Add a single duplicate `last_updated` key — the exact clean-merge outcome above — and the same tree reports `score 100`, `issues: []`. **A corruption raised the score by 10 and erased a real error.**

Two points deserve emphasis:

- **No conflict marker was ever involved.** Remediation built only on scanning for `<<<<<<<` misses this entirely. Duplicate-key corruption is what a *successful* merge produces.
- **Both writers followed the documented rules.** Not misbehavior — two correct writers with no agreement about key order.

### 2.3 The conflict-marker variant, and what a damaged delimiter does

When the edits overlap enough to conflict inside the block, git leaves markers between the `---` fences. Verified by fixture and by direct parser inspection:

| Input | `yaml` nodes | `YAML.parse` | Classification |
|---|---|---|---|
| Conflict inside an intact block | 1 | throws `Implicit keys need to be on a single line` | **`invalid-syntax`** → reported |
| Conflict damage destroys the closing `---` | **0** | n/a | **`absent`** → silent |
| Conflict wraps the delimiters themselves | **0** | n/a | **`absent`** → silent |
| Body-only Markdown (legitimate) | 0 | n/a | `absent` → silent, correctly |

This settles as **verified** what the oracle review raised as `[INFERENCE]`: a conflict that eats the closing delimiter yields **no `yaml` node**, and is therefore indistinguishable from legitimate body-only Markdown by frontmatter classification alone.

**This is load-bearing for the design.** The frontmatter contract in §1 cannot catch the damaged-delimiter case *even in principle* — the evidence is gone by the time the parser runs. That case is covered only by the independent conflict-marker scan (§6). The two mechanisms are complementary and **neither substitutes for the other**: §2.2's clean merge has no markers and needs §1; a destroyed delimiter has no `yaml` node and needs §6. Any acceptance test set must cover both, plus ordinary body-only Markdown to prove the false-positive floor holds.

### 2.4 Corrupt, then silently truncated

The corrupt state is not merely invisible — it is *destructive on next write*. `writeGroundings` computes `extractFrontmatter(content) ?? {}` (`src/markdown.ts:54`) and serializes that object over the original block's byte range (`:56-61`). With unparseable input the base is `{}`, so the emitted block contains **only** `grounds_to`.

Verified against a faithful re-implementation of `src/markdown.ts:17-64`: a conflicted block containing `name`, `edges`, `last_updated`, and `owner` came back as four lines of `grounds_to` and nothing else. `name`, `description`, `triggers`, `edges` — gone, in the same pass that `templates/SYNC.md:49-52` promises "must survive every sync". The Markdown body is untouched, which makes the loss easy to miss in review.

The ordering is: corrupt → invisible → silently truncated by the next automated write.

---

## 3. Failure-mode inventory

`vs. git` separates mechanisms that are **worse than baseline git** (git surfaced or preserved something; mex loses it) from those that are **the same as baseline git** (git's normal behavior, which we get no credit for solving).

| # | Failure mode | Evidence | Observable symptom | Severity | vs. git |
|---|---|---|---|---|---|
| 1 | `absent` and `invalid` frontmatter are one `null` | `src/markdown.ts:23-31`, `src/drift/frontmatter.ts:9-14`, `test/markdown.test.ts:73-82` | `DEAD_EDGE`, the `last_updated` signal, and all `grounds_to` checks silently return zero issues; score can *rise* | **critical** | **worse** — git merged cleanly and told the truth; mex converts corruption into a perfect score |
| 2 | A cleanly-merged duplicate key triggers #1 with no marker anywhere | `src/markdown.ts:25`; writers `src/graph/runtime.ts:159`, `:234` | `mex check` → `100/100` on a corrupt file; fixture: `90` → `100` after corruption | **critical** | **worse** — no marker to scan for |
| 3 | Next automated write truncates frontmatter to `grounds_to` only | `src/markdown.ts:54` (`?? {}`) + `:56-61` | `name`/`description`/`triggers`/`edges` vanish; body survives so review misses it | **critical** | **worse** — git preserved both sides |
| 4 | Conflict damage to a delimiter yields no `yaml` node → classified `absent` | verified parser behavior (§2.3) | Corruption is invisible to frontmatter classification *by construction* | **critical** | **worse** |
| 5 | One corrupt grounded file disables checker #12 for the whole scaffold | `src/drift/index.ts:71-75`, `:78`, `:127` | Scaffold-wide grounding coverage → zero from one bad file | high | worse |
| 6 | Full YAML re-serialization loses key order, comments, quoting | `src/markdown.ts:56`; fixture: a `# comment` dropped, `"2026-08-04"` → `2026-08-04` | Frontmatter diffs exceed the semantic change → independent edits collide more often; **direct cause of #2** | high | **worse** — conflict surface mex creates for itself |
| 7 | `persistMovedGroundings` mutates tracked Markdown during *detection* | `src/sync/index.ts:104-121`, writing at `src/graph/runtime.ts:145,159` | Plain `mex sync` writes tracked files **before** any report; a user who then picks `3) Exit` (`:221-223`) has already been modified | **high** | worse — a report must not write |
| 8 | A **second** tracked-Markdown writer after the agent session | `captureGroundingBaselines` globs all scaffold Markdown (`src/graph/runtime.ts:83-91`); `refreshGroundingBaselines` writes at `:234`; invoked at `src/sync/index.ts:250` | Whole-file `writeGroundings` output lands after the session, so #6 still bites after #7 is fixed | high | worse |
| 9 | Whole-file `writeFileSync`, no locking, last-writer-wins | `src/graph/runtime.ts:159`, `:234` | Two concurrent processes: one file's work lost, no warning | medium | ~same (git absent for uncommitted work) but avoidable |
| 10 | "Surgical edits" / "PRESERVE YAML frontmatter" / "NEVER delete existing decisions" is prose aimed at a model | `templates/SYNC.md:47-55`; duplicated at `sync.sh:182-190` and again at `sync.sh:266-273` | Nothing in `src/` validates it; violations look identical to compliance | medium | n/a — an absent constraint |
| 11 | The LLM receives the entire file in a fenced block | `src/sync/brief-builder.ts:112-120` | Structurally invites the whole-file rewrite `templates/SYNC.md:47` forbids in prose | medium | n/a |
| 12 | `mex sync` has no notion of a dirty or conflicted tree | no `porcelain`/`status`/`isClean`/`checkIsRepo` anywhere in `src/` (grep: no matches); `src/git.ts` exposes only `log` (`:13-50`) and `diff` (`:53-63`) | Runs happily mid-merge on a tree with live markers, then hands it to an LLM | **high** | worse — last-writer-wins over unresolved state |
| 13 | Prose-body conflict in a knowledge file | fixture: `git merge` → `CONFLICT (content)`, exit 1, markers at body lines; frontmatter still parses | Developer resolves by hand | low | **same** — git's job, git does it, adequate |
| 14 | No author dimension in the event journal | `EventEntry` (`src/events.ts:13-35`): `timestamp`, `kind`, `message`, `files`, `cwd`, optional `trace`/`source`/`status`; `source` is free-form provenance (`:25-29`), `cwd` a path (`:78`) | Cannot attribute a decision | low | ~same |
| 15 | Nothing in drift or sync reads the journal | `readEvents` consumers: `src/doctor.ts:18`, `src/tui.ts:69`, `src/events.ts:90`, `packages/mex-mcp/src/tools/log.ts:48`, `timeline.ts:39`. Grep `writeFileSync|appendFileSync|readEvents|eventLogPath` under `src/drift/`: **no matches** | The one append-safe structure is display-only | low | n/a |

For completeness on ticket item 6: the only `merge`/`conflict`-shaped code in `src/` is `mergeIntoConfig`, a shallow `Object.assign` over `config.json` (`src/config.ts:238-252`), and `CROSS_FILE_CONFLICT`, which compares dependency **version claims** across scaffold files (`src/drift/checkers/cross-file.ts:9-33`). Neither is a merge mechanism for knowledge files. Remaining `ON CONFLICT` hits are SQLite upserts (`src/graph/fingerprint-store.ts:33`, `:95`; `src/graph/db/store.ts:155`). No 3-way merge, no per-block ID, no vector clock, no lock.

### 3.1 What the inventory says

Rows 1-6 are one root cause: **frontmatter is parsed leniently and written destructively.** Rows 7-9 and 12 are a second: **writes happen at moments that are not safe to write.** Row 13 — the case people picture when they hear "concurrent edits" — is the one row where current behavior is already correct.

That inverts the intuitive priority. The valuable work is not a merge algorithm. It is honest diagnostics plus write discipline.

---

## 4. Proposals, in recommended order

The draft of this document ordered these as: loud frontmatter → minimal-diff writes → detection-must-not-write. **That order was wrong and has been corrected** to: loud frontmatter → detection purity *with* the preflight → minimal-diff writes.

**Why the corrected order, defended.** The reason is not aesthetic. Minimal-diff serialization (former step 2) is *churn reduction*: it makes future conflicts rarer. Detection purity plus the preflight (now step 2) is *damage prevention*: it stops mex writing tracked Markdown at moments the user has not consented to and the tree is not safe for. Verified: plain writer-mode `mex sync` calls `persistMovedGroundings` at `src/sync/index.ts:113` — **before** `runDriftCheck` at `:122` and before any output — and that reaches a whole-file `writeFileSync` at `src/graph/runtime.ts:145,159`. A user who runs `mex sync`, reads the report, and chooses `3) Exit` (`:221-223`) has already had tracked files rewritten. Minimal-diff writes make that rewrite *tidier*; they do not remove it. A tidier unrequested write to a conflicted file is still an unrequested write to a conflicted file.

There is a second, decisive reason, which is row 8: `captureGroundingBaselines` (`src/sync/index.ts:250` → `src/graph/runtime.ts:83-91`, `:234`) is a **separate** whole-file writer that runs *after* the agent session. Fixing detection purity does not touch it. So minimal-diff writes remain genuinely necessary — they are simply not the most urgent thing, because the urgent thing is that writes are happening at unsafe moments at all.

Step 1 stays first: it is the smallest change, and it is the only one that fixes a case where the tool reports the *opposite* of the truth.

**Steps 4 and 5 are gated on 1-3 proving out** — specifically on step 1 producing real error reports in real repos, which is evidence nobody has yet.

### Step 1 — Make present-but-invalid frontmatter a hard error

**The highest value-per-line change in the milestone.** Roughly a dozen lines of production code, and it converts critical rows 1, 2, and 5 from silent to reported. Nothing else here has that ratio, because nothing else fixes a case where the tool actively certifies corruption. `100/100` on a corrupt file is worse than having no tool.

**Mechanism.** Implement the contract in §1. Diff shape, described not applied:

- `src/markdown.ts` — add `parseFrontmatterResult(content): FrontmatterParseResult`, populating `invalid-syntax` from the `error.message` currently discarded at `:26-28` and the line from the `yaml` node's `position.start.line` (already available; `writeGroundings` uses the same positions at `:58-59`). Keep `extractFrontmatter` as a wrapper so `extractGroundings` (`:36`) and `writeGroundings` (`:54`) are untouched.
- `src/drift/frontmatter.ts` — add a sibling file-level reader that distinguishes the read failure (`:12-14`) as `unreadable` rather than collapsing it into the parse failure.
- `src/types.ts:104-123` — one additive `IssueCode`: `INVALID_FRONTMATTER`. It belongs with the filesystem/lexical codes, above the grounding block at `:118`.
- `src/drift/index.ts:110` — call the result-returning reader once; on `invalid-syntax` / `invalid-shape` push
  ```
  { code: "INVALID_FRONTMATTER", severity: "error", file: source, line: <yaml node start line>,
    message: `YAML frontmatter could not be parsed: ${error}` }
  ```
  and pass `null` onward to the three existing consumers so their behavior is unchanged. **The corrupt file is still not checked for edges or grounding — it is now merely *loudly* not checked.** That is the entire claim. Attempting to check a file whose metadata is unparseable would mean guessing at the metadata.
- `src/drift/index.ts:71-75` — `hasGroundings` should treat `invalid` as "cannot tell", not "no groundings", so one broken file stops disabling checker #12 scaffold-wide (row 5).
- `src/heartbeat.ts:66-77` — **recommendation: heartbeat stays best-effort and is not changed.** It is a staleness *display* with a separate `parseFrontmatter` call at `:68`; `mex check` now reports the corruption authoritatively, and duplicating the error in heartbeat would double-report one fault in two commands. State this choice explicitly in the PR so it reads as a decision rather than an oversight.

**Severity: `error`, immediately. Not warning-first.** A warning costs 3 points (`src/drift/scoring.ts:3-7`) and leaves the tree looking green, which preserves exactly the falsely-healthy signal this ticket exists to kill. It would also leave `mex check --fix` inert, since that path triggers only when an error exists (`src/cli.ts:158-159`). The state is never acceptable and is machine-detectable with zero ambiguity; it should be an error on day one.

**Blast radius of the new error — all verified:**

| Effect | Evidence |
|---|---|
| Deducts 10 points per occurrence | `src/drift/scoring.ts:3-15` |
| `mex check` exits 1 | `src/cli.ts:158`, `:165` |
| `mex doctor` sets a failing exit code | `src/doctor.ts:15`, `:33` |
| `mex check --fix` enters `runSync` whenever **any** error exists | `src/cli.ts:158-162` |
| The file becomes a `mex sync` target | `src/sync/index.ts:138-146` (a file with an error pulls in its warnings too), `:157` |
| `IssueCode`, `DriftIssue`, `runDriftCheck` are public API | `src/index.ts:27-31`, `:58-63`; `src/types.ts:104-133`; contract declared `src/index.ts:1-11` |

Note the interaction between rows 3 and 4 of that table: a corrupt file now makes `mex check --fix` route into `runSync`, which is a **writer**. Without step 2 landed, that means `--fix` on a corrupt file reaches `persistMovedGroundings` and `writeGroundings`, i.e. row 3's truncation. **Step 1 therefore slightly increases the chance of hitting row 3 before step 2 lands.** This is the strongest argument for landing step 2 promptly after step 1, and it is worth saying out loud in step 1's PR rather than discovering it in the field.

**What breaks — honestly.**

1. **Nothing for frontmatter-less files.** `absent` is silent by construction (§1 rule 1). This is the regression risk that matters and the contract forecloses it.
2. **Nothing in the public API.** `parseFrontmatter` keeps its signature and behavior (§1 rule 6). `test/markdown.test.ts:73-82` passes unmodified.
3. **Repos with already-corrupt frontmatter newly fail.** A tree that scored `100` may score `90` with no edit, and `mex check` / `mex doctor` start exiting non-zero. This is the intended migration cost and release notes must say so plainly. Do not soften it into a warning.
4. **Downstream exhaustive TypeScript switches over `IssueCode` can break.** An added union member is a breaking change for any consumer with an exhaustive `switch` returning `never`. `[INFERENCE]` — depends on external consumers' type patterns, which are not observable from this repo. What would settle it: `COMPATIBILITY.md`'s stated policy on additive union members, plus whether any published consumer exists (`mex-mcp` v0.1.0 is unpublished, `"mex-agent": "file:../.."`). Internal consumers do not switch on codes: `packages/mex-mcp/src/tools/check.ts:30` serializes the whole report.
5. **Test fixtures with malformed frontmatter would need updating.** `[INFERENCE]`, unresolved — surveying `test/**` is outside this lane's file scope and I ran no gates. Settled by grepping `test/**` for fixtures whose frontmatter does not parse. Note `test/markdown.test.ts:77-82` is specifically *not* such a case, since it asserts the unchanged public wrapper.
6. **A file being hand-authored mid-edit can transiently error.** Accurate, and it clears when the YAML is valid.

**Recovery.** The message names file, line, and the YAML parser's own error — `Map keys must be unique at line 21, column 1` is precise enough to fix by hand. **No auto-fix is proposed**: repairing a duplicate key means choosing which value is correct, a semantic decision the tool cannot make (§8).

**Acceptance tests must cover** — the minimum set, given §2.3: conflict inside a recognized YAML block (→ error), a conflict that destroys the closing delimiter (→ `absent`, silent, and therefore caught only by §6's marker scan — the test asserts the division of labor), ordinary body-only Markdown (→ silent), empty frontmatter document (→ `valid`), scalar frontmatter (→ `invalid-shape`), and an unreadable file (→ not reported as invalid YAML).

### Step 2 — Detection must not write, and writer-mode sync must preflight

**Land these together.** They are one invariant — *mex does not write tracked Markdown until it is safe and requested* — and splitting them ships half of it.

**Finding on `--dry-run`, as asked.** `--dry-run` **does not** reach the write. `src/sync/index.ts:109` guards the `persistMovedGroundings` call with `if (!opts.dryRun)`, and the dry-run path returns at `:176-184` after printing the brief, before any tool is invoked. So "sync writes during dry-run" is **not** a bug in the current tree. It is a plain-`mex sync` concern only.

What *is* real: on the plain path `mex sync` writes tracked Markdown at `src/graph/runtime.ts:159` (via `:113`) **before** `runDriftCheck` (`:122`) and before any output. And the invariant is held by a single call-site condition, not by structure — `mex check --fix` reaches `runSync(config, {})` with no `dryRun` (`src/cli.ts:161`), so it takes the writing path.

**Mechanism — detection purity.**

- Split `persistMovedGroundings` (`src/graph/runtime.ts:117-162`) into a pure `detectMovedGroundings(...) → MovedRepair[]` and an `applyMovedGroundings(repairs)` that writes. Detection loses its `writeFileSync`; only apply has it. The invariant becomes structural rather than conditional.
- In `runSync`, detect before the report; apply only after the user has committed to a fixing path — not on `3) Exit` (`:221-223`), not in `prompts` mode (`:231-236`, also a report-and-exit path).
- Report pending rebinds in the drift output, so the user sees them before they happen.

**Mechanism — the preflight.** Fully specified in §6.

**Cost.** One function split plus a small result type, plus the preflight. No behavior change for a user who proceeds on a clean tree. `--dry-run` unaffected.

**What it does NOT solve.** Two processes racing on one worktree still last-writer-wins. And it does **not** cover row 8: `captureGroundingBaselines` at `src/sync/index.ts:250` is a separate writer that runs after the agent session. That is step 3's and step 4's territory.

### Step 3 — Minimal-diff frontmatter writes

**Gated on nothing** — independent of steps 1-2, can land in parallel. Sequenced third because it reduces future churn rather than preventing present damage (§4 preamble).

**Mechanism.** Replace the parse → mutate object → `YAML.stringify` round-trip at `src/markdown.ts:54-56` with `yaml`'s document API:

```
const doc = YAML.parseDocument(yamlNode.value);
doc.set("grounds_to", doc.createNode(groundings));
const block = `---\n${String(doc).trimEnd()}\n---`;
```

`yaml` is already a direct dependency pinned `^2.7.0` (`package.json:76`), resolved at 2.8.3. Verified locally: `parseDocument` → `set` → `String(doc)` preserves an interleaved `# comment` and keeps `last_updated: "2026-08-04"` quoted. **No new dependency.**

**What it removes.** Row 6, and with it the *mechanism* of row 2 — §2.2's duplicate key exists only because one writer relocates `last_updated` while the other preserves position. With positional writes, two edits either touch the same line (git conflicts, correctly) or they do not (git merges, correctly). Frontmatter then conflicts when the *semantic* change conflicts, which is the property we want. It also covers the row-8 writer, which step 2 does not reach.

**Cost.** A different `yaml` API, roughly the same line count. One real subtlety: `parseDocument` on malformed input populates `doc.errors` rather than throwing, so the implementation must decide what to do. **Recommendation: throw when `doc.errors.length > 0`.** Today that path silently truncates (row 3); throwing surfaces it and pairs naturally with step 1. This changes `writeGroundings` from infallible-looking to throwing on corrupt input, so callers need to handle it — `src/graph/runtime.ts:145` and `:234`, both of which sit inside a `try`/`catch` at their `mex sync` call site (`src/sync/index.ts:112-119`). Note that catch currently swallows silently (`:114-116`), so step 1's error report is what makes the failure visible rather than merely silent-and-skipped.

**What it does NOT solve.** Nothing about the body. Nothing about concurrent whole-file writes (row 9). It shrinks the conflict surface; it does not reconcile a conflict.

### Step 4 — Preimage + post-write invariant guard

**Gated on steps 1-3.** New in this revision, from the oracle review, which judged it the best small mechanism for the problem the draft only diagnosed: row 10, "surgical edits" as unenforced prose. That judgment is accepted.

**Frame it precisely.** This **enforces acceptance of safe output**. It is *not* atomic prevention — the edit is made by an external CLI in the project root (`src/sync/index.ts:24-40`) and mex cannot intercept it. It is *not* a reconciliation engine. It is a gate that refuses to bless a session whose output violated a stated invariant.

**Mechanism.**

1. **Snapshot before** the external session: content of candidate `.mex` Markdown, plus each file's parsed top-level frontmatter keys, plus canonical `### ` decision headings for files following the decision-log convention (`templates/context/decisions.md:36-53`: `## Decision Log`, `###` entries, a mutable `**Status:**` line).
2. **Validate immediately after** the session and — **crucially — before `captureGroundingBaselines`** (`src/sync/index.ts:250`). Veto success if any target has: conflict markers, invalid frontmatter (step 1's classifier, reused), a removed pre-existing top-level frontmatter key, a removed existing decision heading, or an unexpected edit to a non-target `.mex` file.
3. **Allow** `**Status:**` changes and new decision entries — those are the documented supersede workflow (`templates/context/decisions.md:32-34`, `templates/SYNC.md:53-55`). Require an explicit destructive override for deliberate removal.
4. **On failure**: exit non-zero, **do not capture baselines**, and **leave the working diff in place for review — do not auto-restore.** Auto-restoring would be a second whole-file write over content mex did not author, which is the clobber risk this document exists to reduce. The user has git; a diff they can inspect is more useful than a silent revert.
5. A final, narrower check after baseline capture may allow only capture's documented grounding/fingerprint effects.

**Why the ordering in point 2 is the whole point.** `captureGroundingBaselines` writes the local baseline (`src/graph/runtime.ts:227`, `:234`). A validator that ran only at the end would let a bad edit update the baseline first — after which the corrupted content *is* the baseline, and the drift signal that would have caught it is gone. Validate before capture or do not bother.

**Cost.** The largest item in this proposal: a snapshot model, an invariant set, and an override flag. Genuinely warrants its own design pass, which is why it is issue E in §10 and not bundled with A-D.

**What it does NOT solve.** It cannot prevent the bad write, only refuse to accept it. It cannot judge whether *reworded* prose is faithful — only whether named structures survived. A session that rewrites every paragraph while preserving all keys and headings passes.

**Two alternatives explicitly rejected** (oracle-ranked, and I agree):

- **Diff-size / line-count limits.** Measures churn, not preservation. Valid changes can be large; a one-line deletion of a decision heading is destructive and tiny. Both false-positive and trivially false-negative.
- **Section-scoped briefs as the enforcement mechanism.** A narrower prompt cannot stop an agent editing elsewhere, and many issue types carry `line: null` (`src/types.ts:125-133`; e.g. `DEAD_EDGE` at `src/drift/checkers/edges.ts:28`, `STALE_FILE` at `staleness.ts:115`) so there is often no section to scope to. Useful for focus later; not enforcement.

### Step 5 — Per-section anchors / per-block IDs

**Recommendation: do not build this now.** §7.2.

---

## 5. What about an author dimension on the event journal?

**Recommendation: drop it from this ticket.** The draft said "defer"; the oracle review argued for a harder position, and on the evidence the harder position is right.

`.mex/events/decisions.jsonl` is the only structure in the tree that already survives concurrent writes: `appendFileSync` of one JSON object per line (`src/events.ts:85`) means two writers append two lines; git handles append-only files far better than structured YAML; and `readEvents` skips unparseable lines (`src/events.ts:143-145`) so a torn line degrades one entry rather than the file. It is genuinely well suited to multi-writer use.

It carries no identity. `EventEntry` (`src/events.ts:13-35`) is `timestamp`, `kind`, `message`, `files`, `cwd`, plus optional `trace`, `source`, `status`. `source` is documented free-form provenance — "meeting", "manual", "agent" (`:25-29`) — not an author. `cwd` is a repo-relative path (`:78`). Confirmed: no author field.

Adding one is trivial: one optional field, one line in `appendEvent` (`:80-82` pattern), one guarded read in `readEvents` (`:138-140` pattern). That is not the question.

**Nothing in the drift or sync pipeline reads the journal at all.** Verified: grep for `writeFileSync|appendFileSync|readEvents|eventLogPath` under `src/drift/` returns **no matches**. Neither `src/drift/index.ts:1-21` nor `src/sync/index.ts:1-10` imports an event reader. Every `readEvents` consumer is display-only: `src/doctor.ts:18`, `src/tui.ts:69`, `src/events.ts:90` (`mex timeline`), `packages/mex-mcp/src/tools/log.ts:48`, `timeline.ts:39`.

State it plainly:

> **An append-only journal without a consumer that makes a resolution decision is provenance, not reconciliation.**

Adding `author` would record attribution while selecting, merging, and protecting nothing. It also commits the record format permanently and forces a guess about identity source — git `user.email`? `$USER`? an omp session id? — each with different privacy properties, in a codebase whose feedback module goes out of its way to never touch user-identifying data (`src/feedback/index.ts:4-8`). **Do not add a field nobody consumes.**

**What would justify reopening it.** A designed reader that makes a decision — most plausibly a check flagging when two authors independently logged decisions touching the same `files` entry within a window. That check does not exist. **Design the reader first; the field lands in the same PR.** If the reader is never designed, that is the correct signal the field was never needed.

**What dropping it does NOT solve.** Attribution stays impossible; `mex timeline` in a team repo stays an undifferentiated stream. Accepted: git already attributes commits, and knowledge files are committed.

---

## 6. Should `mex sync` become conflict-aware?

**Yes — for writer mode, refuse by default.** Ships with step 2.

The case is strongest for `mex sync` because it is the destructive command: it writes tracked Markdown before reporting (row 7), hands an entire file to an LLM (`src/sync/brief-builder.ts:112-120`), and writes again afterward (row 8). Running it on a tree with unresolved markers means an LLM rewriting a merge artifact, with `templates/SYNC.md:47`'s "surgical edits" rule enforced by nothing.

Nothing exists to build on: no `porcelain`, `status`, `isClean`, or `checkIsRepo` anywhere in `src/` (grep: no matches). `src/git.ts` exposes only `log` (`:13-50`) and `diff` (`:53-63`). `simple-git` is already a dependency (`src/git.ts:1`).

### Where

**At the very start of `runSync`, before `persistMovedGroundings`** (`src/sync/index.ts:109-121`), so nothing is written on the refusal path. Not after the drift check — by then the write has happened.

### Both signals, because neither is sufficient

**1. `git status --porcelain=v1 --untracked-files=all -- .mex`.** Catches unmerged *index* states without relying on file text — a file can be in conflict in the index while its working copy looks ordinary. Pin `--porcelain=v1` explicitly so the format is stable. Scope to `.mex` only: a dirty `src/` is normal and irrelevant.

**2. A stateful canonical conflict-marker scan.** Catches marker *text* in an otherwise ordinary modified file, and — per §2.3 — is the **only** mechanism that can see a conflict that destroyed a frontmatter delimiter, because that case leaves no `yaml` node for step 1 to classify.

Require a coherent sequence: `^<<<<<<< ` … `^=======$` … `^>>>>>>> `, tracking state across lines. **A bare `=======` must not trigger on its own** — verified: remark parses `Architecture Overview` followed by `=======` as a setext `heading` of depth 1, so a standalone row of equals signs is valid Markdown that means "H1". This repo's own `.mex/` and `templates/` happen to contain none (grep: no matches), but a knowledge file written by a human who prefers setext headings is entirely legitimate and must not be flagged. This upgrades the oracle's `[INFERENCE]` on marker false positives to **verified**, with a named cause.

### Policy

| State | Default | `--allow-dirty` |
|---|---|---|
| Unmerged index entry in `.mex` | **refuse** | **never bypassed** |
| Canonical conflict markers in a `.mex` file | **refuse** | **never bypassed** |
| Ordinary dirty (` M`, `??`) in `.mex` | **refuse** | bypassed, printing affected paths |

`--allow-dirty` bypasses only non-unmerged states and must print the affected `.mex` paths. **There is no `--allow-conflicts` flag** — a file with live `<<<<<<<` is not a safe LLM input, and the correct action is `git checkout --ours/--theirs` or a manual resolve.

`--dry-run` stays **read-only**: it reports the unsafe state and exits rather than refusing outright, since it already skips persistence (`src/sync/index.ts:107-121`) and returns before invoking a tool (`:176-184`). That makes it the natural inspection tool when the guard fires.

`mex check` should **not** refuse — it writes nothing. Reporting the unsafe state there as `info` severity (1 point, `src/drift/scoring.ts:6`) is cheap and useful.

**Non-git directories.** Verified: `mex check` runs fine in a directory that is not a git repo (`drift score 100/100`, exit 0), so a hard git prerequisite would be a real compatibility change. Degrade to marker-scan-only when git is unavailable, and say so explicitly rather than implying dirty-state protection that is not there. This settles the oracle's `[INFERENCE]` on git availability: mex does support non-git directories today.

### The too-strict failure mode

Refusing ordinary dirtiness by default **will** block a developer mid-rebase with intentional `.mex` edits. **That refusal is correct**, and this is a change from my draft, which proposed treating plain dirtiness as a warning. The oracle's argument wins on evidence: the external agent (`src/sync/index.ts:244`) and the two grounding writers (`src/graph/runtime.ts:159`, `:234`) all rewrite whole files, so uncommitted work in `.mex` is exactly what gets clobbered. A warning that is printed and ignored provides no protection at the moment protection matters.

The remedies are cheap and all preserve the user's work: resolve, stash, or commit; run `mex sync --dry-run` to inspect; or pass `--allow-dirty` having consciously accepted the risk. Note also that `git rebase` in progress with no `.mex` changes is **not** blocked — the check is scoped to `.mex`, so an unrelated rebase is not a `.mex` problem.

The residual risk is real and worth naming: a default-refuse guard trains users to reach for `--allow-dirty` reflexively, which erodes the signal. Mitigate by printing the specific paths and the specific reason, so the flag is a considered response to named files rather than a habit.

---

## 7. Explicitly rejected

### 7.1 A CRDT (or OT) for the knowledge files

The artifacts are git-tracked, human-reviewed Markdown whose readability *is* the product; the edit rate is low (a wiki updated on `mex sync`, not a shared cursor); and git already provides 3-way merge for prose, which the fixture confirms works correctly. CRDT/OT machinery imposes a permanent tax to buy convergence for that low-rate case: either the file gains embedded metadata — destroying the plain-Markdown property that makes it reviewable and hand-editable — or the metadata lives in a sidecar that must itself be merged, versioned, and kept consistent with a file humans can edit outside the tool, reintroducing the divergence CRDTs exist to prevent. Every tool touching `.mex/` (`mex`, the MCP server, editors, agents) would have to speak the format. And the problem has not been shown to occur: no measurement of body-conflict frequency exists (§7.2), while every failure that *is* measured is frontmatter parsing and serialization, needing no convergence algorithm. Automatic convergence is also the wrong *goal*: when two developers assert different architectures, the correct outcome is a human deciding, not a merge function silently picking a winner. Rejected as a solution in search of a problem, at an effectively irreversible format cost.

### 7.2 Per-block IDs — rejected now, with the measurement named

**The idea.** Give each semantic block a stable ID (`<!-- mex:block:a3f8 -->` or a heading attribute) so writes can target a block and merges can reconcile per block.

**What it would cost.**

1. **A new ID convention in every knowledge file.** `.mex/` is human-reviewed Markdown; readability is a feature, and IDs tax it on every read.
2. **Generation must honor it.** `mex setup` and `mex sync` are LLM-driven, and the tree's current mechanism for making an LLM respect structure is prose in a prompt (`templates/SYNC.md:47-55`) — which row 10 exists because nothing enforces. A second, stricter convention enforced the same way predictably fails the same way. Real enforcement means a validator: more new code than steps 1-3 combined.
3. **Migration for existing scaffolds.** Every populated `.mex/` needs IDs backfilled by an agent, non-deterministically, on prose it may also reword.
4. **IDs are durable metadata that can itself be copied, duplicated, lost in rewrites, or conflict.** They need validation plus rename/split/join semantics before they improve anything. Note the shape: that is the frontmatter-corruption problem of §2 re-created at block level. Building it before step 1 lands would ship a second silent-corruption surface while the first is open.
5. **A new failure class: the orphaned block** — IDs matching nothing, duplicated after a merge, on blocks that were split or joined.

**What it buys over steps 1-4.** For frontmatter, nothing — steps 1 and 3 address that directly and far more cheaply. For prose bodies it would convert some git-marked conflicts into automatic merges. That is row 13 only, rated **low**, because git already handles it adequately: `git merge` correctly reported `CONFLICT (content)` on a body conflict in the fixture, and resolving a two-paragraph prose conflict is a normal, cheap operation. There is also no consumer that could use a block ID today — the sync brief still embeds the complete file verbatim (`src/sync/brief-builder.ts:112-120`), so there is no patch-application layer to benefit.

**The missing measurement — and note what it is not.** The naive version ("how often do two people edit the same file?") measures the wrong thing: same-file co-edits are common and mostly merge fine. The honest measurement is **actual conflict resolutions**:

> **Evidence that would change this answer:** for repos with ≥2 active wiki authors — how often does git genuinely *fail* to merge `.mex/**/*.md`; when it fails, is the conflict in disjoint semantic sections or truly overlapping prose; **would a stable block ID have changed the outcome**; and how often does `mex sync` produce a broad rewrite rather than a targeted edit? Git history alone is insufficient: it misses rebases and locally-resolved conflicts, which never appear as merge commits. The cheap version is a time-boxed history/PR review plus a short maintainer conflict diary. This deserves its own issue (§10 issue G).

Steps 1-3 are strictly cheaper and address every row rated critical. Do those, then measure.

### 7.3 Smaller rejections

- **File locking.** Fights git's model (concurrency is across clones and branches, not processes on one filesystem), breaks offline work, cannot span a fork, leaves stale locks after a crash — and would not touch the critical rows: §2.2's corruption came from a clean merge of two committed branches, which no lock can see.
- **Per-author sections** (`## Architecture (alice)` / `(bob)`). Fragments the knowledge the wiki exists to consolidate. The file is the unit of comprehension — `ROUTER.md` routes an agent to one file expecting one coherent answer, and N per-author variants force reconciliation at read time, every time, forever. Converts a rare merge cost into a permanent comprehension cost.
- **Vector clocks.** Causality metadata git's DAG already provides more accurately; it would have to be embedded in or beside files and kept honest across hand edits, and no proposed check consumes causality.
- **Widening an existing checker to catch corruption indirectly.** Not viable as a substitute for step 1: path claims are filtered to `ROUTER.md` only (`src/drift/index.ts:140`, a deliberate false-positive guard for upstream issue #79) and fenced blocks emit only `kind: "command"` claims (`src/drift/claims.ts:83-102`). Frontmatter corruption is a parse-level fact and must be reported at parse time.
- **Auto-repairing broken frontmatter.** Resolving a duplicate key means choosing which value is right — a semantic decision. Guessing (last-wins, newest-date-wins) would silently discard a real edit, recreating exactly the bug class this proposal closes.
- **Warning severity for `INVALID_FRONTMATTER`.** Preserves a falsely green health signal and leaves `--fix` inert (`src/cli.ts:158-159`). §4 step 1.

---

## 8. What this proposal does NOT solve

- **Two developers asserting genuinely different architectures.** A semantic disagreement, resolvable only by a human. No mechanism here helps and none should try.
- **Prose-body conflicts.** Left to git (row 13).
- **The concurrent-write race itself.** Step 2 removes surprising writes and §6 refuses unsafe ones, but two `mex` processes racing on one worktree still last-writer-wins at `src/graph/runtime.ts:159`/`:234`. Judged rarer than the frontmatter failures and much harder to fix well. Note the graph DB is *already* safe here — `busy_timeout` first, WAL, per-connection `foreign_keys`, applied on every open (`src/graph/db/database.ts:24-30`). It is the Markdown writes that are unguarded.
- **Corruption that destroys a frontmatter delimiter, at parse time.** Structurally impossible for step 1 to see (§2.3); covered only by §6's marker scan. If a delimiter is destroyed *and* the markers are cleaned up by hand, nothing detects it.
- **The whole-file brief.** `src/sync/brief-builder.ts:112-120` still hands the LLM the entire file, still structurally inviting the rewrite `templates/SYNC.md:47` forbids. A `mex sync` redesign; out of scope.
- **Whether reworded prose is faithful.** Step 4 checks that named structures survived, not that meaning did.
- **Anything about graph baselines.** `graph.db` is gitignored (`.gitignore:21`), so grounding baselines do not travel between clones. Issue #5's territory.
- **Recovering already-corrupt files.** Step 1 reports; the human repairs. No auto-fix, deliberately.
- **Attribution.** Dropped (§5).

---

## 9. Adjacent work — referenced, not depended on

Nothing in §4 requires any of the following, and no step assumes their outcome.

**Issue #7 — no CI path; `mex sync` needs a TTY.** A loud `INVALID_FRONTMATTER` is exactly what a PR gate should surface: deterministic, no LLM, and headless — `mex check --json` needs no TTY (only `runSync`'s `askUser` at `src/sync/index.ts:14-22` does), and it is already consumed programmatically at `packages/mex-mcp/src/tools/check.ts:30`. If #7 ships a gate, step 1 makes it catch §2.2's clean-merge corruption **at PR time**: after the merge that created it, before it reaches anyone else. A nice composition, not a dependency — step 1 is worth landing with no CI at all, since `mex check` runs locally and from the post-commit hook (`src/watch.ts:100`). Conversely, §6's refusal behavior is a **constraint** on #7's design: a CI gate must call `mex check`, never writer-mode `mex sync`, which now refuses on a dirty tree by design and requires a TTY regardless.

**Issue #5 — shareable grounding baselines** (and #6, mtime vs `content_hash`). This changes what "concurrent edit" *means* for grounding. Today baselines live only in the gitignored `graph.db`, so grounding drift is a single-clone concept. If baselines become shareable they become a **new concurrently-edited artifact**, and this document's questions apply to them: how are two baselines merged, and does a corrupt baseline fail loudly? The guidance transfers directly — whatever format #5 picks should be append-safe or minimal-diff (§4 step 3's principle) and must not swallow its own parse errors (§1's principle). Recommend #5's design reference this document on both points. Not a dependency in either direction.

---

## 10. Sequencing and the issue split

**One implementable contract, stated up front, before any follow-on issue:**

> An internal `FrontmatterParseResult` with at minimum `absent` | `valid` | `invalid-syntax` | `invalid-shape` | `unreadable` states (§1), plus a writer-mode `mex sync` preflight/postflight order in which the safety guard runs **before any `persistMovedGroundings`** and output validation runs **before any `captureGroundingBaselines`** (§4 steps 2 and 4).

Everything below implements some part of that contract.

| # | Proposed issue | Scope (one line) | Depends on | Size |
|---|---|---|---|---|
| A | Present-but-invalid frontmatter must be an `error`-severity drift issue | Internal `FrontmatterParseResult`; add `INVALID_FRONTMATTER`; report only present-but-invalid; keep the public nullable `parseFrontmatter` unchanged; stop one bad file disabling checker #12 | — | S |
| B | `mex sync` detection must not write | Split `persistMovedGroundings` into detect + apply; write only after the user commits to a fixing path; report pending rebinds | — | S–M |
| C | Writer-mode `mex sync` refuses unsafe `.mex/` state | Guard at the top of `runSync`; `git status --porcelain=v1 --untracked-files=all -- .mex` + stateful canonical marker scan; refuse unmerged and dirty; `--allow-dirty` for non-unmerged only; no `--allow-conflicts`; `--dry-run` reports read-only | B (refusal must precede any write) | M |
| D | Minimal-diff frontmatter writes | `writeGroundings` via `YAML.parseDocument`/`set`/`String`; preserve key order, comments, quoting; throw on `doc.errors` instead of truncating | — (composes with A) | S |
| E | Preimage + post-write invariant guard for `mex sync` | Snapshot before the session; validate before `captureGroundingBaselines`; veto on markers, invalid frontmatter, removed frontmatter keys, removed decision headings, unexpected `.mex` edits; non-zero, no baseline capture, leave the diff | A, B, D | L — needs its own design pass |
| F | Author identity on the event journal | Add `author` to `EventEntry` **together with** a consumer that makes a resolution decision | a named reader design; **dropped from this ticket** | M |
| G | Measure `.mex` conflict resolutions | Time-boxed history/PR review + maintainer conflict diary: how often git genuinely fails to merge `.mex/**/*.md`, whether conflicts are disjoint sections or overlapping prose, whether a block ID would have changed the outcome | — | S — research, no code |
| H | Per-block IDs for knowledge files | **Not proposed.** Revisit only on G's evidence | G | XL |

**Order: A, then B+C together, then D. A, B+C, and D are independently landable** — each is releasable alone and none requires another to be correct.

Recommended sequence and why: **A first** (smallest change, largest correctness gain, and it makes every later change observable — with A landed, a regression in frontmatter handling is a reported error instead of a silent `100/100`). **B+C as one unit** (§4 step 2: they are one invariant and shipping half of it ships an unenforced guard). **D promptly after A**, because A routes corrupt files into `mex check --fix` → `runSync` → the writers, which is row 3's truncation path (§4 step 1 blast radius).

**G is worth opening now** even though H is not: it is cheap, needs no code, and it is the only thing that can retire the per-block-ID question rather than leaving it to be re-litigated. E should be opened only after A/B/C/D land. F should not be opened until a reader is designed.

---

## 11. Review and attribution

An independent oracle review of this document's draft, commissioned in parallel, produced four material changes, all folded in:

1. **Reordered the sequence** — minimal-diff writes moved from second to third, behind detection purity plus the preflight, on the verified ground that a tidier unrequested write is still an unrequested write (§4 preamble). **Accepted**; the defense in §4 is my own.
2. **Hardened the frontmatter contract** — the draft said "make parse failure an error", which under-specifies the fix in the one way most likely to break it. §1 is now the first normative section, and the discriminated-result spec with the preserved public reader comes from that review. **Accepted, and the strongest single correction to the draft.** I extended it with `invalid-shape` and the empty-document case after verifying both against the parser.
3. **Added step 4, the preimage + post-write invariant guard** (§4), including the load-bearing ordering constraint that validation must precede `captureGroundingBaselines`. **Accepted** — the draft diagnosed row 10 and proposed nothing for it.
4. **Surfaced row 8**, the second tracked-Markdown writer (`captureGroundingBaselines` → `refreshGroundingBaselines`), which the draft missed. **Accepted**; it is why minimal-diff writes remain necessary rather than being subsumed by detection purity.

Where I **changed position** in response: §6 now refuses ordinary dirty `.mex` by default. The draft treated plain dirtiness as a warning. The counter-argument wins on evidence — three separate whole-file writers mean uncommitted `.mex` work is exactly what gets clobbered, and a printed-and-ignored warning protects nothing.

Where I **disagree or go further:**

- **§5, the event author field: I go further than the review's "defer" and recommend dropping it from this ticket outright**, with the framing stated as a rule ("provenance, not reconciliation"). Deferring invites re-litigation; a stated rule with a named unblocking condition — a designed consumer — does not.
- **§6, the marker false-positive question:** the review flagged a bare `=======` as `[INFERENCE]`. I upgraded it to **verified** with a named cause (remark parses a row of equals signs as a setext H1) rather than leaving it as a judgment call.
- **§2.3, the damaged-delimiter case:** the review flagged as `[INFERENCE]` that conflict damage might remove the closing delimiter and yield no `yaml` node. **Verified true**, and I promoted it from a testing footnote to a structural finding (row 4) and a limit stated in §8, because it means §1 and §6 are genuinely complementary rather than redundant — which changes how the two must be scoped and tested.
- **§4 step 4 point 4, auto-restore:** I make "do not auto-restore" an explicit design rule with its reason (a restore is itself a whole-file write over content mex did not author), rather than a preference.
- **§4 step 1, heartbeat:** the review asked whether heartbeat consumes the richer diagnostic. I recommend it does **not**, to avoid double-reporting one fault in two commands — a call the review left open.

---

## 12. Verification status

Every fixture run used a throwaway `mktemp -d` scaffold copied from this repo's `.mex/`, with `MEX_TELEMETRY=0`. **No gates were run** (no build, no test suite, no linter, no install) and **no file in this repository was modified** to produce them. Scratch scripts were deleted after use.

| Claim | How established |
|---|---|
| Clean `git merge` of two branches produces a duplicate `last_updated` with no conflict markers | executed — `git merge` exit 0, `grep -c '<<<<<<<'` → 0 |
| `parseFrontmatter` returns `null` on that merged file | executed via `dist/index.js` |
| `mex check` reports `100/100` on the corrupt tree | executed — `check --json` → `{"score":100,"issues":[]}`, exit 0 |
| Corruption *raises* the score: `90` (real `DEAD_EDGE`) → `100` after one duplicate key | executed — two fixture trees, same dead edge, `check --json` |
| Conflict markers inside an intact YAML block → `null` and `100/100` | executed |
| Conflict damage destroying the closing delimiter → **zero** `yaml` nodes (indistinguishable from body-only) | executed — parser inspection |
| Conflict wrapping the delimiters → zero `yaml` nodes | executed |
| `---\n---` (empty document) → one `yaml` node, `YAML.parse` returns `null` without throwing | executed |
| Scalar frontmatter parses successfully to a string and flows on unchecked | executed |
| A prose-body conflict is reported by git and leaves frontmatter parseable | executed — `CONFLICT (content)`, exit 1, `parseFrontmatter` ok |
| `writeGroundings` on unparseable frontmatter emits only `grounds_to`, dropping `name`/`edges`/etc. | executed against a faithful re-implementation of `src/markdown.ts:17-64` (the real symbol is not in the `dist` public surface) |
| `YAML.stringify` round-trip drops comments and unquotes dates | executed, same method |
| `YAML.parseDocument`/`set`/`String` preserves comments and quoting on `yaml` 2.8.3 | executed |
| A row of `=======` is parsed by remark as a setext `heading` depth 1 | executed |
| No setext `=======` underlines exist in this repo's `.mex/` or `templates/` today | executed grep — no matches |
| Four of eleven scaffold files legitimately have no frontmatter | executed via `parseFrontmatter` over the glob |
| `mex check` runs successfully outside a git repository | executed — `drift score 100/100`, exit 0, in a non-git temp dir |
| `test/markdown.test.ts:73-82` asserts `null` for both no-frontmatter and invalid YAML | read-only |
| `parseFrontmatter` is a public compatibility-contract export | read-only — `src/index.ts:32`, contract at `:1-11` |
| `--dry-run` does not reach `persistMovedGroundings` | read-only — `src/sync/index.ts:109` guard, `:176-184` early return |
| `mex check` exits 1 on any error; `mex doctor` sets exit code 1 | read-only — `src/cli.ts:158`,`:165`; `src/doctor.ts:33` |
| No `porcelain`/`status`/`isClean`/`checkIsRepo` in `src/` | executed grep — no matches |
| Nothing under `src/drift/` reads the event journal | executed grep — no matches |
| Every other `path:line` in this document | read-only |
| Whether downstream exhaustive `IssueCode` switches exist | **`[INFERENCE]`, unresolved** — not observable from this repo. Settled by `COMPATIBILITY.md`'s additive-union policy plus whether any published external consumer exists |
| Which `test/**` fixtures need updating for step 1 | **`[INFERENCE]`, unresolved** — outside this lane's file scope. Settled by grepping `test/**` for fixtures with unparseable frontmatter |
