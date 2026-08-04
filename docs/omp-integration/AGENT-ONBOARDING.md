---
name: omp-integration-onboarding
description: Mandatory first read for any agent session working an omp-integration issue in thekorsen/mex. Carries harness facts, the verified-vs-inferred evidence ledger, environment setup, and the definition of done.
last_updated: 2026-08-04
---

# Working omp-integration tickets

You are in a **fork**: `thekorsen/mex`, forked from `mex-memory/mex`. The fork exists to adapt mex — a repo-local living wiki plus deterministic code graph, originally built for Claude Code — to run under the **oh-my-pi (`omp`)** agent harness.

Read this file completely before touching code. It exists so you do not re-derive facts that already cost a full investigation, and so you do not act on a claim that was never verified.

---

## 1. Ground rules

1. **One issue per session.** Every issue is self-contained: problem, evidence, scope, acceptance. Work the ticket in front of you. If you discover adjacent breakage, file a new issue; do not silently widen scope.
2. **Distinguish verified from inferred.** §4 is the ledger. Anything not in it, you verify yourself before relying on it. Mark unverified reasoning `[INFERENCE]` in your notes and in PR descriptions. Several tickets exist *because* the original code expressed an assumption nobody checked.
3. **Keep a working note.** `docs/omp-integration/notes/<issue-number>-<slug>.md`, from `notes/TEMPLATE.md`. It is how the next session picks up your thread — including the paths you ruled out, which is usually the expensive half.
4. **Do not edit `.mex/` to make a check pass.** `mex check` measures whether the wiki matches reality. If it reports drift, either reality changed (update the wiki) or the checker is wrong (fix the checker and say why). Editing prose to silence a checker destroys the tool's only signal.
5. **`upstream` is read-only.** Push to `origin` (the fork). Never push to `upstream`. Keep changes rebasable — upstream is an active project and we may want to contribute back.
6. **Cite `path:line`.** Every structural claim in a note, PR, or issue comment names a file and line. "Somewhere in the graph code" is not a finding.

---

## 2. What mex is, in one screen

`mex-agent` v0.7.0. Binary `mex`. Node ≥ 22.5 (hard requirement: it uses the built-in `node:sqlite` `DatabaseSync`, `src/graph/db/sqlite.ts:60`).

**Half one — the living wiki.** `.mex/` of structured Markdown, committed to git:

```
.mex/
├── config.json     # the only machine-written file: aiTools[], staleness{}, watch{}, heartbeat{}, scaffold_id/name
├── AGENTS.md       # the anchor. Budgeted "under 150 tokens". Points at ROUTER.md.
├── ROUTER.md       # the router. Current Project State + Routing Table + Behavioural Contract (CONTEXT→BUILD→VERIFY→DEBUG→GROW)
├── SETUP.md        # runbook (currently references scripts npm installs don't ship — issue #19)
├── SYNC.md         # resync runbook + the "surgical edits" prompt rules
├── context/        # architecture.md stack.md conventions.md decisions.md setup.md
├── patterns/       # README.md (authoring spec) + INDEX.md (lookup table) + pattern files
├── events/decisions.jsonl   # append-only journal, created lazily by `mex log`
└── graph.db        # SQLite code graph — GITIGNORED (.gitignore:21)
```

**Half two — the code graph.** Tree-sitter WASM → SQLite. TS/TSX/JS/JSX/Python/Rust supported; `.mts/.cts/.mjs/.cjs` partial; everything else (including Go) skipped, never fatal. Express is the only framework resolver.

Node identity is **Tier-1, content-independent**: `id = kind + ':' + sha256(filePath:kind:name)[0:32]`, derived from the **relative** path (`src/graph/node-id.ts:29-38`, documented `src/graph/schema.sql:52-56`). Tier-2 is a K=64 MinHash fingerprint over normalized AST tokens plus caller/callee neighbours, LSH over 32 bands — that is what distinguishes *changed* from *moved* when an id disappears.

**The loop.** `mex check` (12 mechanical checkers, zero AI tokens) → `mex sync` (hands an LLM only the drifted files) → agent works → GROW contract writes state/decisions/patterns back.

**Grounding** binds prose to code. Frontmatter `grounds_to: [{node, fingerprint}]` plus inline `` [`fn()`](mex://function:<id>) `` anchors. Checker #12 emits `GROUNDING_DRIFT` (body changed), `GROUNDING_GONE` (deleted), `GROUNDING_AMBIGUOUS` (uncertain move).

### The public API boundary — respect it

`src/index.ts` exports **only**: `findConfig`, `createConfig`, `getScaffoldIdentity`, `appendEvent`/`readEvents`/`eventLogPath`/`EVENT_KINDS`, `runDriftCheck`/`DEFAULT_SCAFFOLD_PATTERNS`, `parseFrontmatter`, `DEFAULT_STALENESS_THRESHOLDS`, `checkHeartbeat`/`runHeartbeat`/`DEFAULT_HEARTBEAT_PATTERNS`, plus — since issue #10 — the four graph retrieval operations `runGraphScope`/`runGraphGet`/`runGraphQuery`/`runImpact` and `DEFAULT_OPTIONS` re-exported as `DEFAULT_RETRIEVAL_OPTIONS` (`src/index.ts:37-52`), plus types.

`src/cli.ts`, `src/setup/`, `src/sync/`, `src/graph/`, `src/tui.ts` are **explicitly not public** (`COMPATIBILITY.md`). Issue #10 made the call: promote a narrow, operation-named retrieval surface and accept the compat obligation, rather than reach into internals. The boundary is written down at `COMPATIBILITY.md` §"Graph retrieval" — the four operations, `AgentCommandDeps.write`, the `AgentOptions` field names, the record `type` values, and `schemaVersion` are public; everything that *produces* those records under `src/graph/**` is not. The surface names operations, not implementations, which is why `COMPATIBILITY.md:145`'s "`LanguageExtractor`/`FrameworkResolver` are not public" is still true.

Also note `COMPATIBILITY.md:173-181` declares the CLI surface "best-effort, not contract-bound" — which is why issue #7 must carve out an explicit stable contract for anything CI depends on.

---

## 3. What omp is, and which surfaces matter

`omp` v17.2.4. Nine extension surfaces. Full detail lives in the harness's own docs, readable via the `read` tool at `omp://<doc>`:

| Surface | On disk | Key harness doc |
|---|---|---|
| Context files | `.omp/AGENTS.md` (native, priority 100), `@path` imports | `omp://context-files.md` |
| Sticky rules | `.omp/RULES.md` → forced `alwaysApply`, re-attached near the current turn | `omp://context-files.md` |
| Rulebook rules | `.omp/rules/*.md` with `description`; body on demand via `rule://<name>` | `omp://rulebook-matching-pipeline.md` |
| Skills | `.omp/skills/<name>/SKILL.md`, `description` **required** | `omp://skills.md` |
| Slash commands | `.omp/commands/*.md`, `$1`/`$ARGUMENTS` templating | `omp://slash-command-internals.md` |
| MCP servers | `.omp/mcp.json` (project), `~/.omp/agent/mcp.json` (user) | `omp://mcp-config.md` |
| Extension modules | `.omp/extensions/*.ts`, or npm pkg with `package.json#omp.extensions` | `omp://extensions.md`, `omp://extension-loading.md` |
| Task agents | `.omp/agents/*.md` | `omp://task-agent-discovery.md` |
| Marketplace | `.omp-plugin/marketplace.json` | `omp://marketplace.md` |

### Discovery precedence — memorize this

`native` (100) > `claude` (80) > `agents`/`codex` (70) > `gemini` (60) > `opencode` (55) > `github` (30) > `agents-md` (10).

Dedup is **first-wins by name**. Native always wins. That is why generated mex artifacts must be `mex-`-prefixed: a bare `router` rule would collide with a user's own.

### The three facts that shape the whole port

1. **omp reads `.claude/CLAUDE.md`, not root `CLAUDE.md`.** mex installs the latter. The primary Claude Code integration is invisible to omp. (Issue #1.)
2. **`.cursorrules` and `.windsurfrules` are not omp rule providers at all.** Only `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, and `.clinerules` are. Two more mex anchors that do nothing under omp.
3. **omp's rulebook is a structural match for `ROUTER.md`.** Rules with a `description` appear in the prompt as name+description; bodies are fetched on demand via `rule://`. That *is* anchor → router → page, implemented by the harness. (Issue #13.)

### Claude Code compatibility, precisely

| Claude Code artifact | omp support |
|---|---|
| `.claude/CLAUDE.md` | ✅ `claude` provider, priority 80 |
| root `CLAUDE.md` | ❌ not discovered |
| `.claude/commands/**/*.md` | ✅ recursive, plus `foo:bar` namespace aliases |
| `.claude/skills/*/SKILL.md` | ✅ priority 80, `description` optional here |
| `.claude/agents/*.md` | ❌ **deliberately skipped** — different frontmatter contract |
| `.claude/` MCP config | ✅ discovered |
| Claude JSON hooks (`PreToolUse` etc.) | ❌ zero matches across all 122 omp docs. omp hooks are JS/TS factories only. |
| `.claude-plugin/marketplace.json` | ✅ read as a fallback when `.omp-plugin/` is absent |

---

## 4. Evidence ledger

### 4.1 Verified by execution

Every line below was run in this working tree. Reproduce before doubting.

| Claim | Command | Result |
|---|---|---|
| Repo builds | `npm ci && npm run build` | success; `dist/cli.js` 315.92 KB |
| Drift check works | `node dist/cli.js check --quiet` | `mex: drift score 94/100 (2 warnings)`, exit 0 |
| Error gate works | append a bogus path + script to `.mex/ROUTER.md`, re-check | `74/100 — 2 errors`, **exit 1** |
| Graph builds | `node dist/cli.js graph` | `1831 nodes, 2839 edges across 152 files in 6814ms` |
| Retrieval works from root | `graph scope "drift check"` | JSONL `meta` + `fact` records |
| Retrieval from a subdir — **issue #3, now FIXED** | `cd src && graph scope "drift check"` | was `{"code":"GRAPH_UNAVAILABLE"}`; now JSONL `meta` + `fact`. Same for `graph query`, `graph get`, `impact`, and at deeper nesting (`src/graph/db`). |
| Missing scaffold still degrades cleanly | git repo with no `.mex/`, from a subdir: `graph scope "anything"` | `{"code":"GRAPH_UNAVAILABLE"}`, **exit 0** — envelope, not a stack trace |
| Change detection is content-based — **issue #6, now FIXED** | in-sync `graph.db`, churn all 155 mtimes, time `loadGroundingRuntime` | **13,996 ms → 65-70 ms**; 155 files reported changed → 7 |
| Node ids are path-portable | build graph in main + worktree, compare | `function:659730e0b4508b577c51042b3227fbfb` — **identical** |
| Worktree `.git` is a file | `stat -f '%HT' <wt>/.git` | `regular file`, contains `gitdir: …/worktrees/<name>` |
| mex works in a worktree | `cd <wt> && mex check` | `94/100`, 12 files checked |
| Worktree starts with no graph | `ls <wt>/.mex/graph.db` | `No such file` — anchors present, baselines absent — **issue #5** |
| **`mex watch` breaks in a worktree** | `cd <wt> && mex watch` | `ENOTDIR: … '<wt>/.git/hooks/post-commit'` — **issue #4** |
| MCP server works | raw stdio: initialize → tools/list → tools/call | `mex-mcp 0.1.0`; 5 tools; `mex_check` → score 94 |
| MCP works **from omp** | `.omp/mcp.json` + `omp -p "call mex_check…"` | omp returned `94` |
| **omp ignores root `CLAUDE.md`** | canary token, `omp -p --no-tools` | `NONE` — **issue #1** |
| Native anchor wins | add `.claude/CLAUDE.md` + root `AGENTS.md` + `.omp/AGENTS.md` | only `CANARY_OMP_AGENTS` reported |
| `@` import bridges to `.mex/` | `.omp/AGENTS.md` = `@../.mex/AGENTS.md` | `CANARY_MEX_AGENTS` reported |
| omp finds a mex skill | `.omp/skills/mex-wiki/SKILL.md` | agent ran `read skill://mex-wiki`, returned canary |
| omp finds a mex command | `.omp/commands/mex-check.md` | `/mex-check` resolved |
| mex writes no `.gitignore` | fresh scratch repo | none created — **issue #12** |
| `sync --dry-run` is headless | stdin closed | prints brief, exit 0 |
| `check --json` shape | `--json` | `{score, issues, filesChecked, timestamp}` — **no** top-level `errors`/`warnings` counts |
| **`simple-git`'s default `log()` INCLUDES merge commits** (issue #9; was §4.3) | `log().all` vs `git log --merges` on this repo | all 24 merge shas present; `all.length` = 200 = `git rev-list --count HEAD`. So the 50/200 thresholds counted merges until #9 set `--no-merges` as the default |
| **`git.log({ file })` compiles to `git log --follow <pathspec>`** (issue #9) | read the `filterString(opt.file)` branch in the installed `simple-git` 3.36.0, then compared output | `--follow` is rename-following. `.mex/ROUTER.md` has **4 renames** behind it, so `git log --follow` yields 11 commits where plain `git log --` yields 1. **Never drop `--follow` from a full-history walk of a knowledge file.** |
| `--follow` is a **no-op for a `-1` lookup** (issue #9) | probe repo: rename, then query with and without `--follow` | Identical sha both ways — a rename commit touches the new path, so it is found regardless. This is why #9's `git log -1 --follow` + `rev-list --count` rewrite is behaviour-preserving |
| Commit-count semantics differ per mode (issue #9) | `.mex/ROUTER.md`, 4 modes | pre-#9 `findIndex`=36, `rev-list --count`=36, `--no-merges`=32, `--first-parent`=6. `--first-parent` is a **different scale** and would need its own thresholds |
| Per-file full-log scan cost (issue #9) | 3001-commit synthetic repo, 12 files, ~25.3 ms/spawn floor | full `log()` **29.4 ms/file** and scales with **total history**; `git rev-list --count` **4.0 ms** at distance 100 / 16.3 ms at 3000, scaling with **distance only** |
| Staleness degrades, never throws (issue #9) | zero-commit repo; 1 commit no remote; `--depth 1` clone; detached HEAD; uncommitted file | zero commits makes `rev-parse HEAD`, `rev-list --count HEAD`, and `log -1 -- <file>` **all** fatal; detached HEAD prints the literal `"HEAD"` from `--abbrev-ref` and `@{u}` is fatal; shallow clone reports `--is-shallow-repository` = `true` so counts are lower bounds. All covered in `test/git-upstream.test.ts` |
| **Upstream drift must be counted toward the upstream ref, not `HEAD`** (issue #9) | two real repos: clone 60 commits behind, all 60 touching the claimed file; `mex check` from the clone | `<mergeBase>..HEAD` = **0** (our own commits; `HEAD == mergeBase` when we have committed nothing) vs `<mergeBase>..origin/main` = **60**. The `..HEAD` form is silent *exactly* when the signal should fire. `mex check` now reports `60 commits on origin/main touch code this file claims`, escalating to `error` past 200 with **exit 1** |
| The staleness upstream signal fires end to end (issue #9) | `.mex` page claiming `src/app.ts`; 60 then 210 upstream commits touching it | 60 → 2 warnings, score 94; 210 → 2 errors, score 80, exit 1; after syncing (0 behind) the upstream signal goes silent while the distinct commits-since-last-update signal remains; with the remote removed, no signal and no throw |

### 4.2 Verified by source reading (cite these directly)

- **Root resolution** is 10 lines, hard-coded, no override: `src/config.ts:54-101`. `existsSync(resolve(current, ".git"))` at `:95` — **true for a `.git` file**, which is what makes a worktree its own project root. `findScaffoldRoot` (`:307-310`) is a single `existsSync` at `<projectRoot>/.mex` — **no walk-up for `.mex`**.
- **Duplicate implementation** at `src/setup/index.ts:68-76` — argument-less, falls back to `process.cwd()` instead of `null`. Any root-resolution change must touch both.
- **`git rev-parse --git-dir` / `--git-common-dir` / `--show-toplevel` appear nowhere** in `src/` or `packages/`. Only `update.sh:108,117`, for self-update version hashes.
- **Env vars are exactly four:** `MEX_HOME` (relocates `~/.mex` only, never the repo store), `MEX_DEV`, `MEX_TELEMETRY`, `DO_NOT_TRACK`. **No XDG support anywhere.**
- **Grounding drift needs a local baseline:** `src/drift/checkers/grounding.ts:36-39` — `if (baselineSource && current.bodyHash !== baselineSource.bodyHash)`. `baselineSource` comes from `_mex_grounded_source` inside the gitignored `graph.db`.
- **The baseline skip:** `src/graph/runtime.ts:214-224` — `updateFingerprints: false` (default for setup and `graph ground`, `:91`) **skips** the baseline when the committed fingerprint differs. `mex sync` passes `true` (`src/sync/index.ts:250`), rewriting the committed fingerprint.
- **mtime change detection — FIXED (issue #6, lane `graph`).** Was `src/graph/runtime.ts:108-109` comparing `size` and `mtimeMs` only. Now `files.content_hash` is the authority: `findChangedSourceFiles` (`src/graph/runtime.ts:102-130`) delegates to a single `hasFileChanged` (`:132-145`) — size mismatch → changed; matching mtime → unchanged with no read; size match + mtime moved → `sha256(readFileSync(...))` vs `row.content_hash`. Stored `modified_at` is deliberately never refreshed, so this stays a pure read path. **Measured:** fresh-clone case (all mtimes churned, content identical) on the real incremental path `loadGroundingRuntime → findChangedSourceFiles → graph.sync` went **13,996 ms → 65-70 ms**; detection alone costs 7.8 ms vs 0.55 ms. A `graph.db` is now portable across checkouts of the same content — the property issue #5 needs.
- **`mex check` does not exercise graph change detection on this repo.** `runDriftCheck` loads the grounding runtime only when a scaffold file carries `grounds_to` frontmatter or an inline `mex://` anchor (`src/drift/index.ts:71-78`); this repo's `.mex/` has neither. Timing `check` to measure anything in `src/graph/runtime.ts` therefore shows a false null result — drive `loadGroundingRuntime` directly instead.
- **Graph read commands resolve the project root — FIXED (issue #3, lane `graph`).** `graph query|scope|get` and `impact` no longer pass `process.cwd()`; they call `resolveGraphRoot(explicitRoot?)` (`src/graph/cli-agent.ts:456-463`), which returns `findConfig().projectRoot` and **degrades to `process.cwd()` on throw** so the `GRAPH_UNAVAILABLE` JSONL envelope still fires instead of a stack trace (`src/graph/cli-agent.ts:469`). All four now work from any subdirectory depth.
- **`--root` on a `graph` subcommand is a dead flag.** The parent `graph` command declares `--root` (`src/cli.ts:206`), and commander resolves a parent-known flag even when it trails a subcommand name — so a duplicate declaration on `query`/`scope`/`get` shows up in `--help` and is never populated (`options.root === undefined` while `graphCommand.opts().root` holds the value). Read-side subcommands must use `graphCommand.opts().root`. Top-level `impact` has no parent and keeps its own flag. Verified by executing both flag positions against the built CLI.
- **Staleness signals** (rewritten by issue #9): `src/drift/checkers/staleness.ts:11-16` thresholds (30/90 days, 50/200 commits); `src/git.ts` now carries `CommitCountMode`/`DEFAULT_COMMIT_COUNT_MODE` (`:12-16`), `ComparisonBase` (`:22-37`), and `resolveComparisonBase` (`:142`), which walks explicit ref → `@{upstream}` → `origin/HEAD` → sole remote HEAD → `local` and **never** touches the network. `commitsSinceLastChange` (`:240`) is the one genuinely multi-author signal; it now does `git log -1 --follow` + `git rev-list --count`, so the old full-repo-log scan and the dead `totalCommits` are both gone. `getGitDiff` (`:304`) diffs `<mergeBase>` — deliberately **not** `<mergeBase>..HEAD`, so uncommitted work is included for the `mex sync` brief. The pre-#9 state was: `:13-29` days-since, `:32-49` commits-since, `:42` dead `totalCommits`, `:53-63` `getGitDiff` hardcoded `HEAD~5..HEAD`.
- **Whole-file overwrite:** `src/graph/runtime.ts:159` and `:234`. "Surgical edits" is prose in `templates/SYNC.md:45-53`, enforced by nothing.
- **Frontmatter parse failure is silent:** `src/markdown.ts:24-31` returns `null` on error → staleness/edges/grounding go dark for that file.
- **Process-global state:** `src/drift/index.ts:23-24` (nudge flags), `src/git.ts:3-10` (SimpleGit singleton), `src/global-config.ts:129` (`isDevRepo()` walks up from `process.cwd()`). The first two are **fixed** by issue #11 — nudges are now a `Set<string>` keyed on `projectRoot` (`src/drift/index.ts:23-29`, checks at `:86-96`) and git handles a `Map<string, SimpleGit>` (`src/git.ts:3-18`, no callsite changed). The third stands: `isDevRepo()` still reads `process.cwd()`, and its sole caller is the telemetry gate at `src/telemetry/index.ts:57`.
- **`mex-mcp` can only reach `mex-agent` through `dist/index.js`** — the dependency is `"mex-agent": "file:../.."` (`packages/mex-mcp/package.json:22`), the `exports` map publishes only `.` → `./dist/index.js` plus `./package.json` (`package.json:11-17`), and tsup emits exactly two bundles, `dist/cli.js` and `dist/index.js` (`tsup.config.ts:8-34`). **There is no `dist/graph/*` on disk**, so "import internals from a workspace sibling" fails at module resolution, not merely at policy. This is what forced issue #10's public-API decision.
- **⚠️ stdout is the JSON-RPC channel in `mex-mcp`.** The four retrieval functions are synchronous, return `void`, and stream JSONL through `deps.write`, which **defaults to `console.log`** (`src/graph/cli-agent.ts:23-26,38`). Any MCP tool that calls them without passing a capturing `write` interleaves records into the protocol stream and corrupts the session — the client sees malformed frames, not a mex error. Current tools pass one (`packages/mex-mcp/src/tools/graph.ts:43-46,78,107,140,174`). Note also `runGraphQuery` takes `(relation, target, rootDir, …)` — relation **first**, unlike the other three (`src/graph/cli-agent.ts:122-126`).
- **Exit codes:** `src/cli.ts:165` `process.exit(1)` on any error-severity issue; `src/doctor.ts:33` `process.exitCode = 1`.
- **TTY-bound paths:** `src/sync/index.ts:14-22,205,302`; `sync.sh:156`; `src/tui.ts:53`; `src/graph/cli-ground.ts:121-122`.
- **Anchors are byte-identical:** 5 of 6 `templates/.tool-configs/` files; asserted by `test/tool-config-templates.test.ts:33-40`.

### 4.3 Explicitly NOT verified — verify before relying on

- ~~**[INFERENCE]** Whether `simple-git`'s default `log()` includes merge commits.~~ **RESOLVED by issue #9 — promoted to §4.1.**
- **[INFERENCE]** Whether the dangling `.mex/sync.sh` references are pre-npm residue or an intentional legacy path (issue #19).
- **[INFERENCE]** Whether gitignoring `graph.db` is upstream policy or this repo's choice. `COMPATIBILITY.md:156-159` calls it "generated … internal mex data", consistent with ignoring, but no team policy is stated (issue #5).
- **Doc conflict in the harness:** `omp://marketplace.md` states marketplace installs load `omp.extensions` via symlink + `omp-plugins.lock.json`; other omp docs are less explicit. Verify empirically before depending on marketplace distribution (issue #16).
- `evaluate/` and `visualize.sh` (55 KB, embedded Python viewer on port 4444) were not read.
- Whether `mex init`'s five sub-scanners behave as the orchestrator implies — only `src/scanner/index.ts` was read.
- `origin` / `upstream` in `ScaffoldIdentity` (`src/types.ts:58-61`) are loaded and persisted but **no writer ever sets them non-null**. Purpose unknown (issue #18).

---

## 5. Environment setup

```bash
# Node 22.5+ required (node:sqlite)
node --version

npm ci
npm run build                       # tsup + copy-graph-assets (schema.sql + 5 wasm grammars → dist/)
npm run build --workspace mex-mcp   # only if working the MCP server

export MEX_TELEMETRY=0              # always, in every session
node dist/cli.js check
node dist/cli.js graph              # ~7s here; needed before any grounding work
```

`MEX_TELEMETRY=0` is not optional courtesy. Telemetry fires from a `preAction` hook on **every** command (`src/cli.ts:55-72`); an agent loop would otherwise emit hundreds of events. `DO_NOT_TRACK=1` works too.

`dist/`, `node_modules/`, and `.mex/graph.db*` are gitignored. Do not commit them.

### Reproducing the worktree failures

```bash
git worktree add /tmp/mex-wt HEAD --detach
cd /tmp/mex-wt
stat -f '%HT' .git                                  # regular file
node <repo>/dist/cli.js check                       # works
node <repo>/dist/cli.js watch                       # ENOTDIR
cd - && git worktree remove --force /tmp/mex-wt && git worktree prune
```

**Always clean up worktrees.** A stale worktree makes later `git worktree` operations confusing for the next session.

### Driving omp for verification

```bash
omp -p --model <model> "your prompt"     # non-interactive
omp -p --no-tools "…"                    # context-injection probes: no tool access, so the
                                         # model can only report what was *injected*
```

The canary-token technique is the reliable way to test context injection: put a unique token in a candidate file, ask omp with `--no-tools` to report which tokens it can see. Without `--no-tools` the agent may simply *read the file* and report a false positive. This is how issue #1 was established.

---

## 6. Issue map

| # | Title | Milestone | Notes |
|---|---|---|---|
| 1 | omp never loads the root `CLAUDE.md` anchor | Tier 1 | **blocker** · design decision first |
| 2 | Add `.omp` as a tool target in `mex setup` | Tier 1 | good first slice · gated on #1's shape |
| 3 | Graph commands fail from any subdirectory | Correctness | good first slice · clean repro |
| 4 | `mex watch` ENOTDIR in a worktree | Correctness | design decision: shared vs per-worktree hook |
| 5 | Fresh clone has anchors but no baselines | Multi-dev | **blocker** · the silent failure |
| 6 | mtime change detection vs existing `content_hash` | Multi-dev | good first slice · unblocks #5 |
| 7 | No CI path; sync needs a TTY | Multi-dev | **blocker** for team use |
| 8 | No reconciliation model for concurrent edits | Multi-dev | design proposal, not code |
| 9 | Staleness has no upstream awareness | Multi-dev | |
| 10 | Graph retrieval over MCP | Tier 1 | highest agent value · public-API decision |
| 11 | `mex-mcp` process-global state leaks | Correctness | do before/with #10 |
| 12 | mex never writes a `.gitignore` rule | Correctness | good first slice |
| 13 | Map `ROUTER.md` onto omp's rulebook | Tier 1 | design decision: static vs live projection |
| 14 | Teach `mex sync` to drive omp | Tier 1 | risk: brief size vs `ARG_MAX` |
| 15 | Ship a mex skill + slash commands | Tier 1 | good first slice · already proven to work |
| 16 | The omp extension module | Tier 2 | **do not start before Tier 1** |
| 17 | Document + test Tier 0 | Tier 0 | good first slice · start here |
| 18 | Two checkouts share one `scaffold_id` | Correctness | identity model |
| 19 | Shipped `SETUP.md` references non-existent scripts | Correctness | good first slice · wastes every agent's turn |

### Suggested order

**Start here if you want value fastest:** #17 (document what already works) → #3, #12, #19 (clean bounded bugs) → #2, #15 (native surfaces) → #1, #13 (the two design decisions that unblock everything else) → #10, #11, #14 → #6 → #5, #7 → #8, #9, #18 → #16.

**Dependencies that actually bind:**
- #2 needs #1's decision (anchor shape).
- #16 needs #10 (or an equivalent programmatic retrieval path) and #13's decision.
- #5's "shareable baselines" direction becomes practical only after #6.
- #10 should land with or after #11.

---

## 7. Definition of done

A ticket is done when **all** of these hold:

1. **The acceptance criteria in the issue are met.** All of them. A plausible subset is failure.
2. **You ran the thing.** Not a test that mocks it — the actual command, with its actual output pasted into the PR. For omp-facing work that means a live `omp -p` session. For graph work, a real `mex graph` on this repo.
3. **A test defends the behavior**, if the change introduces a new observable contract. Match existing conventions (`vitest`, `test/*.test.ts`). Do not add tests that assert source text or incidental defaults.
4. **`npm test` and `npm run build` pass.** Run them once, at the end.
5. **`mex check` did not regress.** Baseline is `94/100 (2 warnings)` on this repo. If your change legitimately alters the score, say so and why.
6. **The working note is complete** — including dead ends. The next session needs to know what you ruled out.
7. **Docs updated** where behavior changed: `COMPATIBILITY.md` for API surface, `README.md` for user-facing commands, this file for new verified facts or newly resolved inferences.
8. **Inferences are labeled.** If you could not verify something, say `[INFERENCE]` and state what would settle it.

### Anti-patterns that will get a PR rejected

- Editing `.mex/` prose to make a checker pass instead of fixing the underlying mismatch.
- Silencing a warning rather than addressing its cause.
- Widening a `MISSING_PATH` allowlist rather than fixing the path.
- Committing `graph.db`, `dist/`, or `node_modules/`.
- Claiming verification you did not perform. If you did not run it, do not say you ran it.
- Closing a `design-decision` ticket by implementing an unstated guess. Write the decision down first.
- Adding a second convention beside an existing one. Reuse the pattern already in the file.

---

## 8. Repo orientation

```
src/
├── cli.ts                    # commander surface; every command + flag
├── config.ts                 # findConfig — root resolution (:54-101)
├── global-config.ts          # ~/.mex, MEX_HOME, isDevRepo
├── types.ts                  # AiTool union (:5), AI_TOOLS (:14-21), IssueCode, Grounding
├── index.ts                  # THE public API — nothing else is public
├── markdown.ts               # frontmatter parse/write (silent-failure site at :24-31)
├── git.ts                    # the only git surface; SimpleGit singleton at :3-10
├── watch.ts                  # post-commit hook install (worktree break at :37)
├── heartbeat.ts              # last_updated staleness; agent-memory cleanup
├── events.ts                 # append-only decisions.jsonl
├── setup/                    # mex setup + the agent population prompts
├── sync/                     # runSync + brief-builder (spawns the agent CLI)
├── drift/                    # runDriftCheck + 12 checkers/
├── graph/                    # engine, extraction (tree-sitter), resolution, runtime,
│                             #   reconcile-engine (MinHash), cli-agent (JSONL envelopes),
│                             #   schema.sql, wasm/ (5 vendored grammars)
├── scanner/                  # mex init repo scan
└── tui.ts                    # Ink dashboard (TTY-gated)

packages/mex-mcp/             # stdio MCP server, 5 tools, workspace-linked to mex-agent
templates/                    # everything mex setup copies into .mex/
docs/omp-integration/         # ← you are here
```

### Useful reading paths by ticket type

- **Anchor / context work** → `templates/.tool-configs/*`, `src/setup/index.ts:52-59,377-384,437-442`, then `omp://context-files.md`.
- **Graph / grounding** → `src/graph/runtime.ts`, `src/drift/checkers/grounding.ts`, `src/graph/schema.sql`, `test/graph-migration.test.ts`.
- **CI / headless** → `src/cli.ts:120-175`, `src/reporter.ts:68-71`, `src/sync/index.ts:14-22`, `.github/workflows/ci.yml`.
- **MCP** → `packages/mex-mcp/src/index.ts`, `packages/mex-mcp/src/tools/*`, then `omp://mcp-config.md`.
- **Extension module** → `omp://extensions.md` and `omp://extension-loading.md` **first**, then `src/index.ts` for what you can legally call.

---

## 9. Git workflow

```bash
git remote -v
# origin    https://github.com/thekorsen/mex.git     ← push here
# upstream  https://github.com/mex-memory/mex        ← read-only

git switch -c omp/<issue-number>-<slug>
# work, commit in logical units
git push -u origin omp/<issue-number>-<slug>
```

Reference the issue in the PR body (`Closes #N`). Keep commits focused — one logical change each — so the branch stays rebasable onto upstream.

If you need upstream's latest: `git fetch upstream && git rebase upstream/main`. Never push to `upstream`.
