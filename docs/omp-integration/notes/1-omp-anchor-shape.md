# Issue #1 — omp never loads the root CLAUDE.md anchor that `mex setup` installs

- **Issue:** https://github.com/thekorsen/mex/issues/1
- **Milestone:** Tier 1 — native omp surfaces
- **Branch:** `omp/anchors`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

`mex setup` writes its always-loaded anchor to the repository root (`CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, …). omp does not read any of those at a priority that matters, so under omp the
anchor → `ROUTER.md` → page routing contract never engages and the agent falls back to full-repo
scanning — the exact failure mex exists to prevent. Decide *which* anchor mex should write for omp,
implement it, and make its silent failure mode detectable.

## Acceptance criteria

- [x] A documented, tested path by which an omp session receives the mex anchor without the user
      hand-editing files.
- [x] `mex check`'s `TOOL_CONFIG_DRIFT` checker (`src/drift/checkers/tool-config-sync.ts:14-20`)
      covers whatever new file is installed, or a written justification for excluding it (as
      `.opencode/opencode.json` already is, because it references rather than embeds).
- [x] A canary-token test in `test/` proving the anchor reaches an omp session, or — if driving omp
      in CI is out of scope — a documented manual verification procedure with the exact command and
      expected output.

---

## Decisions

### Decision: which anchor `mex setup` writes for omp

- **Options considered:**
  1. **Native full anchor.** Write `.omp/AGENTS.md` containing a full *copy* of the anchor text,
     the way the five root anchors are byte-identical copies today
     (`test/tool-config-templates.test.ts:33-40`). Highest priority, no indirection.
  2. **Thin native bridge.** Write `.omp/AGENTS.md` containing only `@../.mex/AGENTS.md`. Native
     priority 100, single source of truth stays in `.mex/AGENTS.md`. Verified working
     (onboarding §4.1, "`@` import bridges to `.mex/`").
  3. **Also write `.claude/CLAUDE.md`** so the existing Claude target works under omp too.
  4. **Do nothing; document `.claude/CLAUDE.md`** and let users hand-place files.
- **Chosen:** **option 2, the thin native bridge** — `mex setup` writes `<root>/.omp/AGENTS.md`
  whose entire payload is `@../.mex/AGENTS.md`. Root `CLAUDE.md` behavior is left exactly as it is
  for real Claude Code; omp is treated as its own target. Options 3 and 4 are explicitly rejected.
- **Why:**
  - **A sixth copy of the anchor is a sixth thing to drift.** mex already maintains five
    byte-identical anchors and needed a whole checker (`TOOL_CONFIG_DRIFT`) plus a test to police
    them. Option 1 would enlist omp into that problem for no gain. `.mex/AGENTS.md` is already the
    stated source of truth (`templates/.tool-configs/README.md:49-51`); the bridge *references* it,
    exactly as `.opencode/opencode.json` does (`templates/.tool-configs/opencode.json:3`). This
    reuses the convention already in the repo rather than adding a second one.
  - **Native priority is the only shadow-proof slot.** Precedence is `native` (100) > `claude` (80)
    > `agents`/`codex` (70) > … and dedup is first-wins. Anything below native can be shadowed by a
    file the user already has. `.omp/AGENTS.md` cannot be.
  - **`@` import resolution is verified, not assumed.** Onboarding §4.1 records
    `.omp/AGENTS.md` = `@../.mex/AGENTS.md` → `CANARY_MEX_AGENTS` reported. Re-verified here
    (see Commands run).
  - **Rejecting option 3 (`.claude/CLAUDE.md`):** writing into `.claude/` to serve *omp* conflates
    two targets. A user who selects only omp would get a Claude Code artifact they did not ask for,
    and `.claude/` is a directory `.gitignore` commonly excludes — so the anchor could vanish for
    the next clone. If someone wants Claude-under-omp, the right move is a `claude` target change,
    which is out of this ticket's scope and would alter existing Claude Code behavior.
  - **Rejecting option 4 (do nothing):** it fails the acceptance criterion outright, since it
    requires the user to hand-edit files.
- **What this rules out:**
  - The anchor is now **two hops** from the agent (`.omp/AGENTS.md` → `.mex/AGENTS.md`), so anything
    that breaks hop two breaks the anchor.
  - It rules out `.omp/AGENTS.md` ever carrying omp-specific anchor prose. If we later need that,
    it goes in `.omp/RULES.md` (sticky, always-apply) or a rulebook rule — not in the bridge.
  - It rules out `mex setup` fixing Claude Code under omp. Documented as a known gap below.
- **Revisit if:** omp gains a warning for unresolved `@` imports (which would make the silent
  failure loud and reduce the value of our own checker), or if a second consumer needs the anchor
  text inlined rather than referenced.

### Decision: the `@`-import silent-failure mode, and how `mex check` covers it

- **The hazard.** A missing `@` import target is **not** an error in omp — the literal token is left
  in place (`omp://context-files.md:147-154`). So if `.mex/AGENTS.md` is renamed, moved, or never
  committed, the agent silently receives the text `@../.mex/AGENTS.md` instead of the anchor, and
  **nothing in mex or omp reports it**. That is strictly worse than the bug this ticket fixes: the
  original failure at least left the anchor visibly unused, whereas this one looks configured.
- **Options considered:**
  1. Add `.omp/AGENTS.md` to `TOOL_CONFIG_FILES` in `src/drift/checkers/tool-config-sync.ts:12-18`.
  2. Exclude it from `TOOL_CONFIG_DRIFT` with a written justification, and cover the *real* failure
     mode with a purpose-built checker.
- **Chosen:** **option 2.** `.omp/AGENTS.md` is excluded from `TOOL_CONFIG_DRIFT`, and a new checker
  `src/drift/checkers/omp-artifacts.ts` emits **`OMP_ANCHOR_BROKEN`** (severity `error`) when an
  `@` import in `.omp/AGENTS.md` does not resolve.
- **Why:** `TOOL_CONFIG_DRIFT` byte-compares installed anchors against each other and reports when
  they diverge (`tool-config-sync.ts:36-47`). The bridge is a one-line pointer and is *supposed* to
  differ from the five embedded anchors — adding it to that list would fire a warning on every
  correctly configured repo. This is precisely the rationale already recorded for
  `.opencode/opencode.json` at `tool-config-sync.ts:8-10` ("a different format and references
  `.mex/AGENTS.md` rather than embedding the same text"), so excluding the bridge **reuses the
  existing precedent instead of inventing a second convention**. Byte-equality is the wrong
  question for a reference file; *does the reference resolve* is the right one, and no existing
  checker asks it.
- **What this rules out:** the bridge's content is never compared to anything, so a corrupted
  bridge whose import still resolves would pass. Accepted: the import line is the entire payload,
  and `OMP_ANCHOR_BROKEN` covers the only way it can fail.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| omp does not discover root `CLAUDE.md`; the `claude` provider reads `.claude/CLAUDE.md` | onboarding §4.1 | executed (prior session) |
| mex installs the anchor at the repo *root* | `src/setup/index.ts:52-59` | read-only |
| `.omp/AGENTS.md` is `native`, priority 100, and shadows everything | onboarding §3 precedence table | executed (prior session) |
| An `@../.mex/AGENTS.md` import inside it resolves and injects | onboarding §4.1; re-run below | executed |
| `@` imports resolve relative to the *importing file's* directory, 5 hops, cycles skipped | `omp://context-files.md:147-154` | read-only |
| **A missing `@` target leaves the literal token — no warning, no error** | `omp://context-files.md:147-154` | read-only |
| `.mex/AGENTS.md` is the declared source of truth for anchor content | `templates/.tool-configs/README.md:49-51` | read-only |
| `.opencode/opencode.json` already sets the "reference, don't embed" precedent | `templates/.tool-configs/opencode.json:3`; rationale at `src/drift/checkers/tool-config-sync.ts:8-10` | read-only |
| Existing anchors are never overwritten by re-running setup | `src/setup/index.ts:428-433` | read-only |
| `TOOL_CONFIG_DRIFT` byte-compares only files present in its own list | `src/drift/checkers/tool-config-sync.ts:12-18,36-47` | read-only |

## Commands run

See `15-omp-skill-and-commands.md` for the live-omp canary transcript covering the anchor bridge,
the rulebook, the skill, and the commands in one session (they share a single scratch repo).

The manual verification procedure for this anchor, in isolation:

```
# in a scratch git repo containing a .mex/ scaffold
$ mkdir -p .omp && printf '@../.mex/AGENTS.md\n' > .omp/AGENTS.md
$ printf 'CANARY_MEX_AGENTS\n' >> .mex/AGENTS.md
$ MEX_TELEMETRY=0 omp -p --no-tools "List every CANARY_ token visible in your context. If none, say NONE."
# expected: CANARY_MEX_AGENTS
```

`--no-tools` is essential: without it the agent may simply *read* the file and report a false
positive. This is the technique that established the bug (onboarding §5).

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Adding `.omp/AGENTS.md` to `TOOL_CONFIG_FILES` (`tool-config-sync.ts:12-18`) | It byte-compares anchors against each other. The bridge is a one-line pointer and *must* differ from the five embedded anchors, so every correctly configured repo would emit a spurious `TOOL_CONFIG_DRIFT` warning. Wrong question asked of the wrong file. |
| Writing a *copy* of the anchor to `.omp/AGENTS.md` (option 1) | Would work, but enlists omp into the five-way byte-identical-copy problem that already needs a checker and a test to police. Rejected on maintenance grounds, not correctness. |
| Writing `.claude/CLAUDE.md` as part of the omp target (option 3) | Conflates two tool targets: selecting omp would silently produce a Claude Code artifact. `.claude/` is also commonly gitignored, so the anchor could disappear on the next clone. |
| Relying on root `AGENTS.md` (the Codex target) to serve omp | It *is* discovered, but by the `agents-md` provider at priority **10** — the lowest. Any native file shadows it, so it is not a dependable anchor. |
| Expecting omp to warn on an unresolved `@` import | It does not. `omp://context-files.md:147-154` specifies the literal token is left in place. This is what forced `OMP_ANCHOR_BROKEN` to exist. |

---

## Changes made

| File | Change |
|---|---|
| `templates/omp/AGENTS.md` | New. The thin bridge: `@../.mex/AGENTS.md`, no frontmatter. |
| `src/setup/index.ts` | `omp` tool target writes `.omp/AGENTS.md` via `ompArtifactPaths`. See note for #2. |
| `src/drift/checkers/omp-artifacts.ts` | New. `OMP_ANCHOR_BROKEN` when an `@` import fails to resolve. |
| `src/types.ts` | Added `OMP_ANCHOR_BROKEN` to the `IssueCode` union. |
| `docs/omp-integration/omp-surface-mapping.md` | Documents the anchor decision and the manual canary procedure. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/setup-omp.test.ts` — anchor bridge | `.omp/AGENTS.md` is written, contains a resolving `@../.mex/AGENTS.md`, and is not duplicated or clobbered on re-run. |
| `test/checkers.test.ts` — `OMP_ANCHOR_BROKEN` | A broken `@` import is reported as an error; a resolving one is silent; a repo with no `.omp/` gains no issue. |

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (live `omp -p --no-tools` canary; transcript in the #15 note)
- [x] `npm test` passes
- [x] `npm run build` passes
- [x] `mex check` did not regress from `94/100`
- [x] Docs updated where behavior changed
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2
- [x] Worktrees / scratch dirs cleaned up

## Follow-ups

- [ ] Claude Code under omp is still broken: omp reads `.claude/CLAUDE.md`, mex writes root
      `CLAUDE.md`. Deliberately out of scope — changing the `claude` target alters existing Claude
      Code behavior and deserves its own ticket.
- [ ] `.cursorrules` / `.windsurfrules` are not omp rule providers at all (onboarding §3). Cursor
      and Windsurf users get nothing under omp. A `.cursor/rules/*.mdc` target would fix it.

## Handoff

Finished. The anchor shape is fixed by this note; #2 implements the target, #13 the rulebook.
