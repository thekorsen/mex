---
name: decisions
description: Key architectural and technical decisions with reasoning. Load when making design choices or understanding why something is built a certain way.
triggers:
  - "why do we"
  - "why is it"
  - "decision"
  - "alternative"
  - "we chose"
edges:
  - target: context/architecture.md
    condition: when a decision relates to system structure
  - target: context/stack.md
    condition: when a decision relates to technology choice
# Decisions usually ground sparsely; add only symbols that implement the decision.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }
grounds_to: []
last_updated: "2026-08-04"
---

# Decisions

When a decision names its concrete implementation point, anchor that symbol; do not
anchor a vague concept:

```markdown
[`someFunction()`](mex://function:<tier-1-id>)
```

Citations below are plain text, not backticked — src/types.ts:5. A backticked path
becomes a claim and a `:line` suffix never resolves (src/drift/checkers/path.ts:113-164).

This file is append-mostly. When a decision changes, do NOT delete the old entry: mark it
superseded and add the new entry above it. The history is the event clock.

## Decision Log

### omp is a first-class AiTool target, not a Claude Code shim
**Date:** 2026-08-04
**Status:** Active
**Decision:** `"omp"` is a member of the `AiTool` union with its own entry in `AI_TOOLS`
and its own setup target, rather than being served by pointing omp at the Claude Code
artifacts.
**Reasoning:** omp discovers context natively and dedups first-wins by bare name, so it
needs artifacts in its own layout to be seen at all. It also has a real CLI with a
distinct prompt flag, which the Claude entry cannot express: `AI_TOOLS.omp` is
`{ name: "oh-my-pi", cli: "omp", promptFlag: ["-p"] }` (src/types.ts:14-22, union member at
src/types.ts:5) against Claude's empty `promptFlag` (src/types.ts:15). `mex setup` option
`"7"` writes the anchor bridge (src/setup/index.ts:60), and `writeOmpArtifacts`
(defined src/setup/index.ts:118, called for the omp target at src/setup/index.ts:643)
projects the sticky rules, rules, skills, and commands directories named at
src/setup/index.ts:74-80, copied from the templates/omp tree.
**Alternatives considered:** Reuse the `claude` target and let omp read the Claude files
(rejected — omp never reads root CLAUDE.md; see the entry below, so the artifacts would be
invisible). Emit a sixth verbatim copy of the anchor text into the omp layout (rejected —
five copies of the same prose already have to be kept identical by a checker; a bridge
keeps .mex/AGENTS.md the single source of truth, src/setup/index.ts:70-72).
**Consequences:** Nothing may rely on Claude Code compatibility paths under omp. Generated
omp artifact names are `mex-`-prefixed so first-wins dedup can never shadow a rule, skill,
or command the user wrote (src/setup/index.ts:66-68). The projections can now rot, which is
why the omp artifact checker exists — see the checker entry below.

### The anchor bridge imports `@../.mex/AGENTS.md`, resolved file-relative
**Date:** 2026-08-04
**Status:** Active
**Decision:** The omp anchor bridge contains the import `@../.mex/AGENTS.md`. The bare
form `@.mex/AGENTS.md` is prohibited.
**Reasoning:** omp resolves an `@` import relative to the **importing file's own
directory**, not the project root (omp://context-files.md:147,154, confirmed by canary
probe under `omp -p --no-tools`). The bridge lives one level down, so the bare form
resolves to a path under the omp directory that does not exist.
**Alternatives considered:** The bare project-root-relative form (rejected — it does not
resolve). An absolute path (rejected — not portable across checkouts).
**Consequences:** **This failure is silent.** An unresolvable `@` import is rendered as the
literal token with no warning, so a broken anchor means the entire mex wiki stops reaching
the agent while everything still looks fine. Nothing else in the system would notice
(src/drift/checkers/omp-artifacts.ts:24-28), which is precisely why `OMP_ANCHOR_BROKEN` is
an error and not a warning. Never "simplify" this path.

### Root CLAUDE.md cannot serve as the omp anchor
**Date:** 2026-08-04
**Status:** Active
**Decision:** The omp integration installs its own anchor bridge instead of relying on the
root CLAUDE.md this repo already ships.
**Reasoning:** omp's `claude` provider reads `.claude/CLAUDE.md` (discovery priority 80),
never a root CLAUDE.md. Under omp the root anchor is therefore invisible, no matter what it
contains.
**Alternatives considered:** Move the root CLAUDE.md into the `.claude/` directory
(rejected — it would break Claude Code, which reads it at the root, and mex supports both
harnesses at once). Ship both copies (rejected — a second copy of the anchor is a second
thing to keep in sync, and `checkToolConfigSync` only compares root configs).
**Consequences:** Two anchors coexist for two harnesses and both are projections of
.mex/AGENTS.md. As a side effect, root CLAUDE.md is currently the only root tool-config
present, so `checkToolConfigSync` short-circuits at fewer than two files and cross-config
divergence goes unchecked until a second root config appears
(src/drift/checkers/tool-config-sync.ts:21-24).

### Graph retrieval is public API, and is exposed over MCP
**Date:** 2026-08-04
**Status:** Active
**Decision:** `runGraphScope`, `runGraphGet`, `runGraphQuery`, `runImpact`, and
`DEFAULT_RETRIEVAL_OPTIONS` are exported from src/index.ts (src/index.ts:43-50), and the
MCP package registers them as four new tools for nine total: `mex_check`, `mex_log`,
`mex_timeline`, `mex_heartbeat`, `mex_read_file`, `mex_graph_scope`, `mex_graph_get`,
`mex_graph_query`, `mex_impact` (packages/mex-mcp/src/index.ts:20-28).
**Reasoning:** The MCP server is a separate package and can only reach the library through
its entry point. The exports map publishes `.` alone, and the build emits exactly two
bundles, so a deep import into the graph internals fails at module resolution — not merely
at policy. Compact, budgeted retrieval was judged worth a stable contract.
**Alternatives considered:** Deep-import the graph modules (rejected — unresolvable, and
explicitly not public per COMPATIBILITY.md:46-56). Add a subpath export for the graph tree
(rejected — it would make the whole engine public surface). Shell out to the CLI (rejected —
the CLI is best-effort and not contract-bound, COMPATIBILITY.md:173-181).
**Consequences:** The contract names **operations, not implementations**: the four
functions, `AgentCommandDeps.write`, the `AgentOptions` field names, the emitted record
`type` values, and `schemaVersion` are public; everything under the graph tree that
produces those records is not (COMPATIBILITY.md:98-129). Bumping `schemaVersion` is
breaking. Because `write` defaults to `console.log`, any host whose stdout carries a
protocol must inject its own sink — see packages/mex-mcp/src/tools/graph.ts:43-47.

### content_hash is the authority for change detection, not mtime
**Date:** 2026-08-04
**Status:** Active
**Decision:** `files.content_hash` decides whether a file's content changed. Size and mtime
are only fast paths in front of it (src/graph/schema.sql:106, populated from the source
text at src/graph/engine-impl.ts:205).
**Reasoning:** mtime is not a content signal. A checkout, rebase, or `touch` moves it
without changing bytes, and a shared graph database across checkouts made that
mis-detection routine. The cascade is deliberate: a differing size means changed without
reading the file, a matching mtime short-circuits the read, and a size-matched mtime change
falls back to hashing (src/graph/runtime.ts:134-141).
**Alternatives considered:** mtime alone (rejected — false positives on every checkout).
Hash every file every run (rejected as the *only* strategy — the pre-filters make the
common case free, though the full re-read costs only about 7 ms across this repo's 152
files, src/graph/runtime.ts:100).
**Consequences:** The read path stays a reader: a `modified_at` proven content-identical is
deliberately **not** refreshed, because writing there would break sharing one graph
database between checkouts (src/graph/runtime.ts:100). Do not "optimize" that into a write.

### Staleness counts upstream work via merge-base, excluding merge commits
**Date:** 2026-08-04
**Status:** Active
**Decision:** Staleness counts commits between the merge-base and the **upstream ref** that
are not on ours, and merge commits never count as authored work
(src/drift/checkers/staleness.ts:98-112 and :18-22; upstream resolution src/git.ts:83,
merge-base src/git.ts:196).
**Reasoning:** The question is "what landed upstream that my knowledge does not reflect?"
Counting to HEAD answers a different question and reports 0 for a checkout 60 commits
behind — exactly the case that matters (src/drift/checkers/staleness.ts:99-102). Excluding
merges means a merge-flow team and a rebase-flow team get the same number from the same
underlying work, instead of the merge team's score decaying from merge bookkeeping.
**Alternatives considered:** The previous hardcoded five-commit diff window (rejected —
a fixed window is blind to both a quiet week and a 200-commit backport). Counting to HEAD
(rejected — wrong direction, reports zero for the case of interest). Counting merges
(rejected — makes the signal depend on branching style rather than on work).
**Consequences:** With no upstream configured the upstream signal is simply absent and
degrades to a local base rather than erroring (src/git.ts:139-143, consumed at
src/git.ts:184-194). This branch is live in this very checkout: the current branch has no
upstream, so the upstream count is absent and the commit count is what is firing. The
commit-since-last-change and frontmatter-age signals still fire, and when several fire they
collapse into one issue at the highest severity so one condition costs the score once
(src/drift/checkers/staleness.ts:76-79,146-162).

### `check --json` is a versioned machine contract
**Date:** 2026-08-04
**Status:** Active
**Decision:** The `--json` document and the exit codes of `mex check` are contract-bound.
`counts` and `contractVersion` were added **additively**, leaving the original four fields
with their names and positions (src/reporter.ts:80-86); `contractVersion` is 1
(src/reporter.ts:21).
**Reasoning:** The CI gate has to depend on something stable, and the CLI as a whole is
declared best-effort (COMPATIBILITY.md:173-181). A narrow promise the project can keep
beats a broad one it cannot, so the carve-out is deliberately two things and no more
(COMPATIBILITY.md:187-201). `counts` exists so a gate does not have to reduce the issue
array by severity in jq just to answer "should this build fail?" — every severity key is
present including zero (src/reporter.ts:23-27).
**Alternatives considered:** Make the whole CLI contract-bound (rejected — unkeepable).
Have CI parse human output (rejected — all human text is explicitly not contract-bound).
Have consumers assert on the package version (rejected — `contractVersion` is the thing
that tracks shape).
**Consequences:** Exit codes are load-bearing: 0 clean or warnings only, 1 at least one
error-severity issue, 2 mex could not complete the check. 2 exists because an operational
failure used to exit 1 with empty stdout, which a gate cannot tell apart from real drift —
it would read "no scaffold" as "the wiki is accurate" (src/cli.ts:170-177). Consumers must
tolerate unknown keys and new `code` values, and must not exhaustively switch on `code`.
`contractVersion` bumps only on a breaking shape change (COMPATIBILITY.md:242-253).

### scaffold_id stays random; checkout_id is derived
**Date:** 2026-08-04
**Status:** Active
**Decision:** `scaffold_id` remains a random UUID v4, never derived from path, repo, or git
(src/types.ts:56-60). A separate `checkout_id` was added, derived as the first 32 hex
characters of the sha256 of the absolute git dir, falling back to the project root
(src/config.ts:353-362, type at src/types.ts:69-74). The dead `origin` and `upstream` fields
were dropped.
**Reasoning:** The two identities answer different questions. One scaffold equals one
project and must be shared by every clone and worktree, so it is persisted in the scaffold
config. Per-checkout signals need to be distinguishable without leaking repo identity, so
`checkout_id` is derived and never persisted — it therefore cannot be committed, and it
differs per worktree and per clone (src/types.ts:65-68).
**Alternatives considered:** Derive `scaffold_id` from the repo path or remote URL
(rejected — it would leak identity into anonymous telemetry, and a moved or renamed
directory would silently become a different project). Persist `checkout_id` (rejected — it
would get committed and then be wrong for everyone else).
**Consequences:** Durable identity is never derived from a path. A moved or renamed
checkout gets a new `checkout_id` by design (src/config.ts:350-351). The 32-hex-prefix
convention matches graph node ids.

### New drift checkers extend the IssueCode union rather than reusing a code
**Date:** 2026-08-04
**Status:** Active
**Decision:** The omp artifact checker ships as its own module emitting three new codes:
`OMP_ANCHOR_BROKEN` (error), `OMP_RULE_DRIFT` (warning), `OMP_RULE_ORPHAN` (warning), each
appended to the `IssueCode` union with a comment naming its emitter and severity
(src/types.ts:130-133; checker at src/drift/checkers/omp-artifacts.ts:33).
**Reasoning:** `IssueCode` is additive by contract and consumers are forbidden from
exhaustively switching on it (COMPATIBILITY.md:251-252), so a new condition gets a new code
instead of being folded into an existing one. Severity is the real decision: the broken
anchor is an error because it fails silently and takes the whole wiki offline, while a
drifted rule projection still leaves the agent correctly routed.
**Alternatives considered:** Reuse `TOOL_CONFIG_DRIFT` for all three (rejected — it would
make the remediation message wrong and the severities indistinguishable). Make the rule
codes errors too (rejected — a stale projected description does not break the loop, and an
error would fail CI on cosmetic drift).
**Consequences:** Error severity exits 1 and fails the gate (src/cli.ts:177), so promoting a
warning to an error is a CI-breaking change. The checker returns `[]` immediately when the
omp directory is absent, which is the overwhelming majority of repos
(src/drift/checkers/omp-artifacts.ts:34-36).

### Concurrent `.mex` edits have no reconciliation model
**Date:** 2026-08-04
**Status:** **Proposed — not accepted.** No code implements this.
**Decision:** Pending. A design proposal exists at
docs/omp-integration/design/knowledge-file-reconciliation.md and is explicitly proposed,
not accepted: every code change it describes is a described change, not a landed one.
**Reasoning for recording it as open:** Multiple agents editing the same scaffold
concurrently is now a routine workload, and there is no merge story, no conflict-aware
sync, and no post-write invariant guard. Recording the gap prevents a future session from
assuming one exists.
**Alternatives considered:** The proposal's own first normative statement is that this must
**not** be implemented as "make a `null` frontmatter parse an error" — that phrasing is the
most likely way to get it wrong, because a `null` covers two structurally different cases,
absent and invalid, and only the second is ever illegitimate
(docs/omp-integration/design/knowledge-file-reconciliation.md:17-26).
**Consequences:** Until this is accepted, treat concurrent scaffold edits as unguarded:
coordinate file ownership out of band. Do not cite this document as settled design.
