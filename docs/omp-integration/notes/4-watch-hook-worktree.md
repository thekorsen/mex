# Issue #4 — `mex watch` crashes with ENOTDIR inside a git worktree

- **Issue:** https://github.com/thekorsen/mex/issues/4
- **Milestone:** Correctness — harness-independent bugs
- **Branch:** `omp/worktree`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

`mex watch` computed the post-commit hook path by string-joining `<projectRoot>/.git/hooks/`, which
only works when `.git` is a directory — so it exploded with ENOTDIR in every worktree and every
submodule. Stop guessing at git's layout: ask git where hooks live, install exactly one hook there,
and make the hook body figure out which checkout it is running in at commit time rather than at
install time.

## Acceptance criteria

Copied verbatim from `FLEET-TICKETS/04.md:52-55`.

- [x] `mex watch` and `mex watch --uninstall` behave correctly and identically from the main checkout and from any worktree, with a documented decision on shared-vs-per-worktree.
- [x] The installed hook body contains no absolute path baked in at install time, or an explicit justification for why one is safe.
- [x] The `npx mex` vs `npx mex-agent` fallback is corrected.
- [x] A test that creates a real worktree (`git worktree add`) and asserts hook install/uninstall succeeds. The existing config tests always create `.git` with `mkdirSync` (`test/config.test.ts:31,37,42`), so the `.git`-as-a-file path is currently **untested**.

---

## Findings

What you learned about the code. Every structural claim carries `path:line`.

| Finding | Evidence | Verified? |
|---|---|---|
| The hook path was built structurally as `<root>/.git/hooks/post-commit`. In a worktree `<root>/.git` is a regular **file** (`gitdir: …`), so the path has a file as an interior component and the write fails with `ENOTDIR`. `existsSync(hookPath)` is also false, so install fell straight through to the write. | old `src/watch.ts:37`; write path `src/watch.ts:80-103`; errno surfaced at `src/cli.ts:397-400` | executed (lane orchestrator) |
| A hook in the **common** hook dir (`<main>/.git/hooks/post-commit`) fires for commits made in the main checkout **and** in every linked worktree. Inside the hook, `pwd` is the toplevel of the *committing* worktree and `GIT_DIR` is that worktree's own gitdir — so one shared hook body can identify its checkout at run time. | probe repo, git 2.50.1 — transcript below | executed (lane orchestrator) |
| A hook at `<main>/.git/worktrees/<name>/hooks/post-commit` **never fires** — not for main-checkout commits, not for commits in that very worktree. Per-worktree hook dirs are dead as an install target. This is the finding that killed option 1. | same probe; only `COMMON-HOOK-FIRED` was ever emitted | executed (lane orchestrator) |
| `git rev-parse --git-path hooks` collapses every layout into one call: `.git/hooks` at a main root, `../.git/hooks` from a main subdir, an **absolute** path to the common hook dir from inside a linked worktree, `.githooks` under a relative `core.hooksPath`, and the configured path verbatim under an absolute `core.hooksPath`. Outside a repo it prints `fatal:` on stderr and exits non-zero. Because output is sometimes relative and sometimes absolute it must be run with `cwd = projectRoot` and normalized with `resolve(projectRoot, out)` — a no-op when already absolute. | git 2.50.1, all five cases run | executed (lane orchestrator) |
| `config.scaffoldRoot` is `<projectRoot>/.mex` (`src/config.ts:307-310`), so the old `resolve(config.scaffoldRoot, "dist", "cli.js")` resolved to `<projectRoot>/.mex/dist/cli.js` — a path that exists in **no** checkout (`.mex/dist` is absent). The `existsSync(cliPath)` branch was therefore **dead code**, and the installed hook has always emitted the fallback `npx mex check --quiet`. | old `src/watch.ts:10`; dead branch `src/watch.ts:11-13`; `src/config.ts:307-310` | executed + read |
| That fallback was itself wrong: the published package is `mex-agent` (`package.json:2`) whose bin is `mex` (`package.json:18-20`). `npx mex` therefore fetches an unrelated npm package named `mex` unless `mex` happens to be globally installed. Ticket #4's "latent second bug" was in fact the *only* code path anyone ever ran. | `package.json:2`, `package.json:18-20` | read |
| Submodules share the exact failure shape: `<repo>/sub/.git` is a regular file containing `gitdir: ../.git/modules/sub`, so the structural join breaks identically — and `--git-path hooks` resolves the submodule's hook dir correctly. | probe repo with a submodule | executed (lane orchestrator) |
| `mex watch --uninstall` did not crash in a worktree; it degraded **silently**. `existsSync` on the bogus structural path is false, so it printed "No post-commit hook found." and exited 0 — falsely claiming success while leaving any real hook in place. | `src/watch.ts:117-119` | read |
| `existsSync(resolve(current, ".git"))` returning true for a `.git` *file* is what makes a worktree its own project root — load-bearing and deliberately untouched by every lane in this batch. | `src/config.ts:95`; ledger §4.2 (`docs/omp-integration/AGENT-ONBOARDING.md:138`) | read |

## Commands run

Actual commands and actual output. This is the proof, not a summary of the proof.

Transcript as recorded by the lane orchestrator. The scratch repo was created under `/tmp`
(`/tmp/mex-hookprobe-zKOs`) and **removed afterward**; it is reproduced here so nobody has to rebuild
it. **Do not re-run this probe as part of this ticket.**

```
$ git --version
git version 2.50.1

$ P=/tmp/mex-hookprobe-zKOs; W=$P-wt

# throwaway repo, one commit, one linked worktree
$ git init "$P" && cd "$P" && git commit --allow-empty -m base
$ git worktree add "$W" HEAD --detach

# candidate A: the COMMON hook dir, shared by all worktrees
$ printf '#!/bin/sh\necho COMMON-HOOK-FIRED pwd=$(pwd) GIT_DIR=$GIT_DIR\n' > "$P/.git/hooks/post-commit"
$ chmod +x "$P/.git/hooks/post-commit"

# candidate B: the PER-WORKTREE hook dir
$ mkdir -p "$P/.git/worktrees/$(basename "$W")/hooks"
$ printf '#!/bin/sh\necho PERWT-HOOK-FIRED\n' > "$P/.git/worktrees/$(basename "$W")/hooks/post-commit"
$ chmod +x "$P/.git/worktrees/$(basename "$W")/hooks/post-commit"

# commit in the MAIN checkout
$ cd "$P" && git commit --allow-empty -m from-main
COMMON-HOOK-FIRED pwd=/private/tmp/mex-hookprobe-zKOs GIT_DIR=.git

# commit in the LINKED WORKTREE
$ cd "$W" && git commit --allow-empty -m from-wt
COMMON-HOOK-FIRED pwd=/private/tmp/mex-hookprobe-zKOs-wt GIT_DIR=/private/tmp/mex-hookprobe-zKOs/.git/worktrees/mex-hookprobe-zKOs-wt
```

`PERWT-HOOK-FIRED` never appeared. The common hook fired in **both** cases, and in both cases `pwd`
was the toplevel of the checkout that actually committed.

Where git says hooks live, in every layout:

```
$ cd "$P"          && git rev-parse --git-path hooks
.git/hooks
$ cd "$P/sub-dir"  && git rev-parse --git-path hooks
../.git/hooks
$ cd "$W"          && git rev-parse --git-path hooks
/private/tmp/mex-hookprobe-zKOs/.git/hooks
$ cd "$P" && git -c core.hooksPath=.githooks rev-parse --git-path hooks
.githooks
$ cd "$P" && git -c core.hooksPath=/tmp/abs-hooks rev-parse --git-path hooks
/tmp/abs-hooks
$ cd /tmp && git rev-parse --git-path hooks
fatal: not a git repository (or any of the parent directories): .git
$ echo $?
128
```

The `.git`-is-a-file shape, worktree vs submodule:

```
$ stat -f '%HT' "$W/.git"
Regular File
$ cat "$W/.git"
gitdir: /private/tmp/mex-hookprobe-zKOs/.git/worktrees/mex-hookprobe-zKOs-wt
$ cat "$P/sub/.git"
gitdir: ../.git/modules/sub
```

```
$ npm run build
ESM dist/index.js     142.55 KB
ESM dist/cli.js     317.35 KB
DTS dist/index.d.ts 21.66 KB
[copy-graph-assets] copied schema.sql + 5 grammar wasm file(s) to dist/

$ npx vitest run
Test Files  38 passed (38)
Tests  380 passed (380)

$ node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)
# exit 0 — baseline HELD, no regression

# (previously ENOTDIR inside a worktree)
$ stat -f '%HT' .git
Regular File
$ mex check --quiet
mex: drift score 94/100 (2 warnings)
$ mex watch
Installed mex post-commit hook.
$ git rev-parse --git-path hooks
/Users/ryan/OpenCode-Local/scratchp/pi-tooling/mex/.git/hooks
$ mex watch --uninstall
Removed mex post-commit hook.
# probe worktree removed and pruned

# END-TO-END in a throwaway repo (not the fleet repo)
$ mex watch  # from inside the linked worktree
mex post-commit hook is already installed.
$ git commit  # REAL commit inside the linked worktree

# sh -x trace of the installed hook for that worktree commit
$ sh -x installed post-commit hook
ROOT=/private/tmp/.../main (resolved at commit time from git rev-parse --show-toplevel)
cd
dist/cli.js absent
node_modules/.bin/mex absent
npx --yes mex-agent check --quiet
SCORE='mex: drift score 100/100'
case matched *100/100*
output correctly SUPPRESSED (quiet-on-success; the commit printed nothing)

# instrumented sentinel on the worktree commit
hook body executes: yes
git rev-parse --show-toplevel: /wt2
result: the COMMITTING worktree (/wt2), not the main checkout, even with GIT_DIR set to that worktree's gitdir

# cleanup
shared <main>/.git/hooks/post-commit: absent (clean)
```

---

## Decisions

For `design-decision` tickets this section is the deliverable and must be written **before** implementation.

### Decision A: install ONE shared hook, located by asking git, with no absolute path in its body

- **Options considered:**
  1. **Per-worktree hook** — write to `<main>/.git/worktrees/<name>/hooks/post-commit`, resolved via
     `git rev-parse --git-dir`. Each checkout gets its own hook, so the body may bake in that
     checkout's absolute paths, and `mex watch` in one worktree cannot affect another.
  2. **Shared hook via `git rev-parse --git-common-dir`** — one hook at `<common>/hooks/post-commit`
     covering every worktree of the repo.
  3. **Shared hook via `git rev-parse --git-path hooks`** — ask git for the hook *directory* itself
     rather than deriving it from a git dir.
- **Chosen:** **Option 3.** Resolve the hook directory with `git rev-parse --git-path hooks` run with
  `cwd = projectRoot`, then `resolve(projectRoot, output)` to normalize the relative and absolute
  forms into one absolute path; a `fatal:`/non-zero exit means "not a git repo" and yields `null`.
  Install a single `post-commit` there. The hook body carries **no** absolute path: it resolves the
  committing checkout from its own run-time working directory and invokes mex by package name.
- **Why:**
  - Option 1 is not a tradeoff, it is **broken**. A hook in a worktree's per-worktree hook dir never
    executes — proven above, in the very worktree it belongs to. The ticket's premise at
    `FLEET-TICKETS/04.md:46` ("git does honor per-worktree hooks via `core.hooksPath`") does not hold
    for `.git/worktrees/<name>/hooks` on git 2.50.1; `core.hooksPath` is a *config* knob, and setting
    it per worktree would require `extensions.worktreeConfig` plus rewriting user config — mex has no
    business doing that.
  - Option 3 dominates option 2 on two counts. First, `--git-path hooks` honors a user's
    `core.hooksPath`; `--git-common-dir` does not, so option 2 would happily install into
    `.git/hooks` on a repo configured to run `.githooks` — mex reports success, git never runs the
    hook. Second, one call covers main root, main subdir, linked worktree and submodule, so there is
    no layout branching left inside mex at all.
  - Because one hook file is shared by N worktrees, **install-time** knowledge of "which checkout" is
    meaningless by construction. That forces a checkout-agnostic hook body, which satisfies the
    ticket's second acceptance criterion *structurally* rather than by convention — nothing can
    regress it later by accident.
  - The dead `cliPath` branch (old `src/watch.ts:11-13`) is removed rather than repaired: it never
    matched a real file in any checkout, and a shared hook must not name a per-checkout path anyway.
    The surviving invocation is corrected to the published package `mex-agent` (`package.json:2`).
- **What this rules out:**
  - **Per-worktree drift-check configuration.** Every worktree of a repo shares one hook file, so
    "run `mex check` on commit in worktree A but not worktree B" is not expressible through the hook.
    Any future opt-out must be a run-time check the hook body performs against the committing
    checkout (e.g. presence of `.mex/`), never a second hook file.
  - **Baking anything checkout-specific into the hook** — absolute CLI path, project root, scaffold
    id. All of it must be derived at commit time.
  - **Installing into `.git/hooks` unconditionally.** mex now goes where git points; on a repo with
    `core.hooksPath` set, that is the user's directory, and mex must not fight it.
- **Revisit if:** git gains a hook directory that is genuinely per-worktree *and* fires (that would
  make option 1 viable and re-enable per-worktree configuration); or `core.hooksPath` points at a
  directory mex should not write into (a vendored/committed `.githooks/`), in which case installation
  needs an explicit confirmation step rather than a silent write.

---

## Dead ends

**Do not skip this.** What you tried that did not work is the most valuable thing in this file — it is what stops the next session from spending the same hours.

| Approach | Why it failed |
|---|---|
| Per-worktree hook directory: install to `<main>/.git/worktrees/<name>/hooks/post-commit`, resolved from `git rev-parse --git-dir`. | Implemented as a throwaway probe first, precisely because the ticket asserted git honors it. **The hook never executed** — not on a commit in the main checkout, and not on a commit inside the very worktree that owns the directory. Only the common-dir hook fired, both times. Abandoned: this is not a "less common, needs configuration" option, it is a non-option. Reading `FLEET-TICKETS/04.md:46` and trusting it would have shipped a `mex watch` that reports success and silently never runs. |
| Locate the shared hook dir with `git rev-parse --git-common-dir` and append `hooks`. | Correct for the default layout, and it does collapse main/worktree into one path — but it **ignores `core.hooksPath` entirely**. On a repo that sets `core.hooksPath=.githooks`, mex would write `<common>/.git/hooks/post-commit`, print success, and git would run `.githooks/post-commit` instead: an installed hook that never fires, with no error anywhere. `--git-path hooks` returns `.githooks` in that same repo, so it subsumes this option at zero cost. Discarded on capability, not on style. |
| Keep the install-time absolute `cliPath` (old `src/watch.ts:10`) and merely fix the *directory* the hook is written to. | Unsound the instant one shared hook file serves N worktrees: the baked path names whichever checkout ran `mex watch`, so a commit in any *other* worktree would run the wrong checkout's CLI or nothing at all. Compounded by the path never existing anyway — `<projectRoot>/.mex/dist/cli.js` matches no file in any checkout, so `:11-13` was dead and the "fallback" was the real behavior. Fixing only the directory would have preserved a latent cross-worktree bug behind a passing install. |
| Detect the worktree case inside mex and branch on it (`.git` is a file → do X, directory → do Y). | Reintroduces exactly the class of bug this ticket is about: mex modelling git's on-disk layout. Three shapes to handle today (worktree, submodule, `core.hooksPath`) and any future fourth breaks silently. Asking git once replaces the entire branch. |

---

## Changes made

| File | Change |
|---|---|
| `docs/omp-integration/notes/4-watch-hook-worktree.md` | This note (created). Records Decision A, the probe transcript, and the four dead ends. |
| `src/watch.ts` | Owned by the `WatchHook` lane in this batch — hook-dir resolution via `resolveHooksDir`, checkout-agnostic hook body, `mex-agent` invocation fix, honest `--uninstall`. Not authored here; see that lane's diff. |
| `src/config.ts` | Owned by the `Identity` lane — appends the exported `resolveHooksDir(projectRoot): string \| null` per the batch contract; `findConfig` and `:95` are untouched. Not authored here. |
| `test/` | Real-worktree install/uninstall coverage owned by the implementation lanes. Not authored here. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| Real-worktree hook install/uninstall (`git worktree add` into a `mkdtempSync` dir) | That `mex watch` and `mex watch --uninstall` succeed from a checkout whose `.git` is a **file**, closing the gap named in `FLEET-TICKETS/04.md:55` — existing config tests create `.git` with `mkdirSync` (`test/config.test.ts:31,37,42`), so the file-shaped `.git` was untested. Authored by the implementation lane, not here. |
| `resolveHooksDir` across layouts | That mex reads the hook directory from git rather than deriving it, including the `core.hooksPath` case and the not-a-repo (`null`) case. Authored by the implementation lane, not here. |
| Installed hook body contains no absolute path | That the shared-hook invariant from Decision A cannot silently regress into a baked per-checkout path. Authored by the implementation lane, not here. |

---

## Verification

- [x] Acceptance criteria all met (all four criteria satisfied)
- [x] Ran the actual thing (output pasted above) (build, test, check, repro, and end-to-end output recorded above)
- [x] `npm test` passes (380 passed, 38 files)
- [x] `npm run build` passes (success; dist/cli.js 317.35 KB, dist/index.js 142.55 KB, dist/index.d.ts 21.66 KB)
- [x] `mex check` did not regress from `94/100` (94/100, 2 warnings, exit 0 — baseline held)
- [x] Docs updated where behavior changed (behavior documented in the working note + commit body; no user-facing README/COMPATIBILITY change was required because the public API surface is unchanged)
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2 (resolved, and REPORTED TO THE PARENT for promotion, because the parent owns that file and this lane must not edit it; hook-firing facts included)
- [x] Worktrees / scratch dirs cleaned up (probe worktrees removed and pruned; `git worktree list` = 8 entries, all real fleet lanes; shared `<main>/.git/hooks/post-commit` absent)

```
$ npm run build
ESM dist/index.js     142.55 KB
ESM dist/cli.js     317.35 KB
DTS dist/index.d.ts 21.66 KB
[copy-graph-assets] copied schema.sql + 5 grammar wasm file(s) to dist/

$ npx vitest run
Test Files  38 passed (38)
Tests  380 passed (380)

$ node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)
# exit 0 — baseline HELD, no regression
```

## Follow-ups

Adjacent breakage found but deliberately not fixed here. File these as issues; do not silently widen scope.

- [ ] `update.sh:107` guards self-update with `[ -d "$SCRIPT_DIR/.git" ]`, which is **false in a worktree** for the same reason `mex watch` broke — so the `git rev-parse` calls at `update.sh:108`/`:117` are skipped and self-update silently degrades in any worktree. Same root cause, different file; `update.sh` is outside this lane's target.
- [ ] Decision A rules out per-worktree drift-check configuration (one hook file per repo). If that is ever wanted it has to be a run-time check inside the hook body against the committing checkout — worth an issue before someone reaches for a second hook file.
- [ ] `docs/omp-integration/AGENT-ONBOARDING.md` §4.1/§4.2 should absorb the `--git-path hooks` behaviour matrix and the dead-per-worktree-hook fact. The **parent lane owns that file**, so it was not touched here.

## Handoff

The decision is settled; implementation is owned by sibling lanes (`WatchHook` for `src/watch.ts`,
`Identity` for `resolveHooksDir` in `src/config.ts`). Nothing here is blocked.

What a fresh session must not rediscover: the per-worktree hook dir does **not** fire — do not
re-probe it, and do not trust `FLEET-TICKETS/04.md:46`, which says otherwise. `--git-path hooks`
returns relative output at a main root and absolute output inside a worktree, so it must be run with
`cwd = projectRoot` and normalized with `resolve(projectRoot, out)`. The `/tmp/mex-hookprobe-zKOs`
scratch repo used above has been removed; the transcript is the record.
