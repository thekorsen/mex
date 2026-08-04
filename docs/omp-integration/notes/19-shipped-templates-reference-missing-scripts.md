# Issue #19 — shipped templates reference missing scripts

- **Issue:** https://github.com/thekorsen/mex/issues/19
- **Milestone:** Correctness — harness-independent bugs
- **Branch:** `omp/docs`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

Remove npm-broken `.mex/setup.sh` / `.mex/sync.sh` guidance from the shipped scaffold, then add a focused regression test that checks the Markdown files `mex setup` actually installs.

## Acceptance criteria

- [ ] No file shipped into a user's `.mex/` references a path that an npm install does not create.
- [ ] A test asserting every relative path referenced in `templates/**.md` either exists after a simulated `mex setup` or is explicitly allowlisted. `mex check`'s own `MISSING_PATH` checker (`src/drift/checkers/path.ts`) may already be able to catch this class of bug against a freshly set-up scaffold — check before writing something new.

---

## Findings

What you learned about the code. Every structural claim carries `path:line`.

| Finding | Evidence | Verified? |
|---|---|---|
| `templates/SETUP.md` and `.mex/SETUP.md` previously told users to run `.mex/setup.sh`; `templates/SYNC.md` and `.mex/SYNC.md` previously told users to run `.mex/sync.sh`. | `templates/SETUP.md:7-19`, `templates/SYNC.md:3-13`, `.mex/SETUP.md:7-19`, `.mex/SYNC.md:3-13` | read-only |
| The shipped scaffold includes only Markdown files plus `context/*` and `patterns/*`; it does not install any shell scripts into `.mex/`. | `src/setup/index.ts:33-45` | read-only |
| Tool configs are copied to root destinations, not into `.mex/.tool-configs/`. | `src/setup/index.ts:52-59` | read-only |
| The real CLI surface for this ticket is `mex setup`, `mex check --fix`, `mex sync --dry-run`, `mex sync --warnings`, and `mex watch`. | `src/cli.ts:104-107`, `src/cli.ts:120-129`, `src/cli.ts:342-345`, `src/cli.ts:379-382` | read-only |
| `mex sync` runs drift detection first and offers an interactive path that reads from stdin, while `--dry-run` prints the prompt and returns. | `src/sync/index.ts:14-22`, `src/sync/index.ts:101-123`, `src/sync/index.ts:175-184`, `src/sync/index.ts:186-205`, `src/sync/index.ts:298-305` | read-only |
| The stale `.mex/sync.sh` references are pre-npm residue, not an intentional legacy path: `247ff33` moved the scaffold into `.mex/` as a rename, and `09e12ef` copied that text into `templates/` while publishing only `dist`, `templates`, `LICENSE`, `README.md`, and `COMPATIBILITY.md`. | `templates/SETUP.md:7-19`, `templates/SYNC.md:3-13`, `package.json:files` [INFERENCE settled by shared git evidence: commits `247ff33`, `09e12ef`] | `[INFERENCE]` |
| This resolved inference should be promoted by the parent from AGENT-ONBOARDING §4.3 to §4.2; this lane must not edit that file. | `docs/omp-integration/AGENT-ONBOARDING.md` [INFERENCE based on ticket instructions and shared context] | `[INFERENCE]` |
| Reusing `MISSING_PATH` would miss this bug class because path claims are filtered to `ROUTER.md`, fenced blocks emit only command claims, and `.mex/` is stripped before checking against repo root. | `src/drift/index.ts:140`, `src/drift/claims.ts:83-102`, `src/drift/checkers/path.ts:119-131` | read-only |
| `update.sh` still models the pre-npm clone-into-`.mex/` world: `INFRA_FILES` includes the root shell scripts and top-level Markdown, and `INFRA_DIRS` includes `.tool-configs`, `src`, and `test`. | `update.sh:70-90` | read-only |
| `setup.sh` still prints `.mex/setup.sh` usage text, which matches the stale pre-npm layout rather than the npm-installed CLI-first flow. | `setup.sh:14`, `setup.sh:38` | read-only |
| `sync.sh` still contains its own TTY-gated interactive prompt flow and a duplicated sync prompt body that can drift from `templates/SYNC.md`. | `sync.sh:156`, `sync.sh:169-198`, `templates/SYNC.md:29-62` | read-only |
| `templates/.tool-configs/` contains six files including `README.md`, but the tracked `.mex/.tool-configs/` copy has five files and no `README.md`; npm users never receive either directory because setup copies individual tool-config files to root destinations. | `templates/.tool-configs/README.md`, `templates/.tool-configs/CLAUDE.md`, `templates/.tool-configs/.cursorrules`, `templates/.tool-configs/.windsurfrules`, `templates/.tool-configs/copilot-instructions.md`, `templates/.tool-configs/opencode.json`, `.mex/.tool-configs/CLAUDE.md`, `.mex/.tool-configs/.cursorrules`, `.mex/.tool-configs/.windsurfrules`, `.mex/.tool-configs/copilot-instructions.md`, `.mex/.tool-configs/opencode.json`, `src/setup/index.ts:52-59` | read-only |
| `src/drift/checkers/tool-config-sync.ts` still describes these files as ones that `setup.sh` may copy, which encodes the same stale model. | `src/drift/checkers/tool-config-sync.ts:6` | read-only |

## Commands run

Actual commands and actual output. This is the proof, not a summary of the proof.

```bash
$ MEX_TELEMETRY=0 diff templates/SETUP.md .mex/SETUP.md

$ MEX_TELEMETRY=0 diff templates/SYNC.md .mex/SYNC.md

$ MEX_TELEMETRY=0 grep -rn 'setup\.sh\|sync\.sh' templates/ .mex/

$ MEX_TELEMETRY=0 sed -n '45,53p' templates/SYNC.md
- Use surgical, targeted edits — NOT full file rewrites. Read the existing content,
  identify what changed, and update only those sections.
- PRESERVE YAML frontmatter structure. Never delete or rewrite the entire frontmatter block.
  Edit individual fields only. The edges, triggers, name, and description fields must
  survive every sync. If you need to update edges, add or remove individual entries —
  do not replace the entire array.
- In context/decisions.md: NEVER delete existing decisions.
  If a decision has changed, mark the old entry as "Superseded by [new decision title]"

$ MEX_TELEMETRY=0 npx vitest test/template-paths.test.ts
[NOT RUN — gate owned by orchestrator]
```

---

## Decisions

### Decision: fate of the four root shell scripts

- **Options considered:**
  1. Delete `setup.sh`, `sync.sh`, `update.sh`, and `visualize.sh` now.
  2. Keep them as maintainer-only tooling, mark that audience explicitly, and deduplicate the copied sync prompt.
- **Chosen:** Recommend option 2.
- **Why:** They still encode maintainer workflows and repository-local assumptions outside this lane, but their current text still teaches the pre-npm model (`setup.sh:14`, `setup.sh:38`, `update.sh:70-90`). `sync.sh` also duplicates the sync prompt body already shipped in `templates/SYNC.md:29-62`, and the two copies have already drifted apart; the visible difference today is shell quote escaping around “today's date” in `templates/SYNC.md:53` versus `sync.sh:169-198`.
- **What this rules out:** It rules out silently treating those scripts as user-facing npm-installed entrypoints, and it rules out leaving the duplicated `sync.sh:169-198` prompt in place without a clear source of truth.
- **Revisit if:** The parent chooses to delete the scripts entirely or replace them with documented npm-facing commands.

### Decision: whether `.mex/.tool-configs/` should exist in user projects

- **Options considered:**
  1. Start copying `.tool-configs/` into user `.mex/` installs to match the tracked repo copy and `update.sh` assumptions.
  2. Treat `.tool-configs/` as packaging-only source material and keep copying concrete files to root destinations only.
- **Chosen:** Recommend option 2.
- **Why:** The live installer copies concrete tool-config outputs to root destinations, not a `.mex/.tool-configs/` directory (`src/setup/index.ts:52-59`). Keeping `.tool-configs/` as an internal source directory matches the npm install behavior and avoids creating a second, user-visible copy that existing setup logic does not consume.
- **What this rules out:** It rules out trying to make `.mex/.tool-configs/` a user-facing install artifact without first redesigning `SCAFFOLD_FILES`, `TOOL_CONFIGS`, and the updater model together.
- **Revisit if:** The parent decides tool-config templates should become editable scaffold content in user projects instead of installer inputs.

---

## Dead ends

**Do not skip this.** What you tried that did not work is the most valuable thing in this file — it is what stops the next session from spending the same hours.

| Approach | Why it failed |
|---|---|
| Reuse `mex check`'s `MISSING_PATH` checker instead of adding a focused regression test. | Executed probe in shared context already disproved it: after a simulated `mex setup`, `runDriftCheck` reported score 79 with zero `MISSING_PATH` issues and `Checker paths: 0 issues`. Structurally, `src/drift/index.ts:140` only forwards path claims from `ROUTER.md`, `src/drift/claims.ts:83-102` only emits `kind:"command"` for fenced blocks, and `src/drift/checkers/path.ts:119-131` strips `.mex/` then checks repo-root existence, which would let this repo's root `sync.sh` mask the missing installed path. |
| Broaden the test to every Markdown-looking token and allowlist the noise away. | That would catch placeholder examples inside the long setup/sync prompts, then force a large allowlist for illustrative paths like `context/auth.md` or `add-endpoint.md`. The narrower extractor is more honest for this bug: inline code spans plus shell fences, restricted to repo-relative-looking paths and `.mex/` references. |
| Promise the old four-option interactive menu in `templates/SYNC.md` but swap in `mex sync`. | `mex sync` is interactive, but the current implementation offers a mode/tool choice flow rather than the shell script's old four-option menu (`src/sync/index.ts:186-205`). Keeping that claim would replace one stale path with stale behavior. |

---

## Changes made

| File | Change |
|---|---|
| `templates/SETUP.md` | Replaced the `.mex/setup.sh` recommendation with `mex setup` and rewrote the keep-fresh guidance around `mex sync`, `mex sync --dry-run`, and `mex check --fix`. |
| `.mex/SETUP.md` | Applied the same rewrite to keep the maintained copy byte-identical to `templates/SETUP.md`. |
| `templates/SYNC.md` | Replaced the `.mex/sync.sh` section with CLI-first guidance for `mex sync`, `--dry-run`, `--warnings`, and `mex check` while leaving the Quick Check block and manual SYNC PROMPT unchanged. |
| `.mex/SYNC.md` | Applied the same rewrite to keep the maintained copy byte-identical to `templates/SYNC.md`. |
| `test/template-paths.test.ts` | Added a regression test that simulates the installed `.mex/` scaffold, checks inline-code and shell-fence path references against the installed files, and includes a negative `.mex/sync.sh` test with both inline and fenced references. |
| `docs/omp-integration/notes/19-shipped-templates-reference-missing-scripts.md` | Recorded the evidence, dead ends, out-of-lane recommendations, and verification commands for Issue #19. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/template-paths.test.ts` | No Markdown file that `mex setup` copies into `.mex/` may reference a relative path that a fresh install fixture does not contain; regressions must be caught for inline code spans and shell fences, including a negative `.mex/sync.sh` case. |

---

## Verification

- [ ] Acceptance criteria all met
- [ ] Ran the actual thing (output pasted above)
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `mex check` did not regress from `94/100` (or the change is explained)
- [x] Docs updated where behavior changed
- [ ] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2
- [x] Worktrees / scratch dirs cleaned up

## Follow-ups

Adjacent breakage found but deliberately not fixed here. File these as issues; do not silently widen scope.

- [ ] Parent lane: promote the resolved pre-npm-residue finding from AGENT-ONBOARDING §4.3 to §4.2 and remove the now-stale inference label there.
- [ ] Parent lane: decide whether to keep or delete the root maintainer scripts, then either add explicit maintainer-only headers plus deduplicate `sync.sh:169-198` against `templates/SYNC.md:29-62`, or remove the scripts entirely.
- [ ] Parent lane: align `update.sh:70-90`, `src/drift/checkers/tool-config-sync.ts:6`, and the packaging model around whether `.tool-configs/` is internal installer source only or a user-facing scaffold directory.

## Handoff

Ticket files are updated. Orchestrator still needs to run the repo-owned gates and confirm the focused test passes in the shared worktree.
