# Issue #13 — Map ROUTER.md onto omp's rulebook so context is routed, not dumped

- **Issue:** https://github.com/thekorsen/mex/issues/13
- **Milestone:** Tier 1 — native omp surfaces
- **Branch:** `omp/anchors`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

mex routes context with `.mex/ROUTER.md`: an anchor points at a routing table, and the table selects
which pages the current task needs. omp implements that same indirection natively — rulebook rules
appear in the system prompt as name + description only, and their bodies are fetched on demand via
`rule://<name>`. Project `ROUTER.md` onto that surface, and decide whether the projection is static
or live.

## Acceptance criteria

- [x] A written mapping document in `docs/omp-integration/` covering every row above with a
      verified example.
- [x] A working implementation of at least the static projection: `mex setup` emits
      `.omp/rules/mex-router.md` (+ per-pattern rules) from the existing `.mex/` content.
- [x] Verified in a live omp session: the agent reports the routing rule in its rulebook and can
      `read rule://mex-router`.
- [x] Generated rules are drift-checked (stale generated rule vs. changed `ROUTER.md` must surface
      in `mex check`), or the staleness gap is documented as accepted.

---

## Decisions

### Decision: static projection vs. live projection

- **Options considered:**
  1. **Static projection.** `mex setup` writes `.omp/rules/*.md` once. Committed, greppable,
     drift-checkable, works today with zero Tier 2 dependency. Can go stale.
  2. **Live projection.** An omp extension module (`.omp/extensions/*.ts`) reads `.mex/` per turn
     and synthesizes rules in memory. Always current, cannot rot. Requires Tier 2, which the
     onboarding explicitly says not to start before Tier 1 (§6, issue #16).
  3. **Static projection with pointer-only bodies** — the variant I actually shipped.
- **Chosen:** **option 3.** Static files written at setup time, but the rule *bodies contain
  pointers into `.mex/`, never copies of `.mex/` content*. The only projected field is a pattern's
  `description`, and that one projection is drift-checked.
- **Why:** The ticket frames this as static-vs-live and warns "the static path is shippable now;
  the live path is strictly better". That framing assumes a static projection must *copy* content —
  and a copy is what rots. It does not have to. The rulebook listing needs exactly two things from
  us: a `name` (which comes from the filename) and a `description` (which the model reads to decide
  whether to fetch the body). Nothing forces the *body* to duplicate `.mex/`. So:
  - `mex-router`'s body is a table of *task type → which `.mex/` file to read*. It reproduces the
    routing **structure** from `templates/ROUTER.md:47-54`, which is template-stable, and points at
    `.mex/ROUTER.md` for `## Current Project State` — the volatile part. **Project state is never
    copied, so the most rot-prone content in the whole scaffold cannot go stale in a generated
    rule.** The live option's entire advantage is neutralized for this rule.
  - `mex-graph` and `mex-grow` project the *behavioural contract*, which changes when mex itself
    changes, not when the project changes. They ship as fixed templates, versioned with mex, exactly
    as `templates/.tool-configs/CLAUDE.md` already does.
  - `mex-pattern-<slug>` rules are the one genuinely derived artifact: each projects a pattern's
    `description` into rulebook frontmatter so the pattern is *selectable* by the model. That single
    projected field is what `OMP_RULE_DRIFT` checks.
  This gets ~all of live projection's correctness at static projection's cost, and does not
  pre-empt option 2 later.
- **What this rules out:**
  - Rules cannot carry project-specific state. If we ever want "Current Project State" in the
    rulebook itself, that needs option 2.
  - Adding a pattern does not create its rule until `mex setup` is re-run. Surfaced as
    `OMP_RULE_ORPHAN`'s inverse — see the accepted gap below.
  - A mid-session edit to a rule file is not picked up: the active rule snapshot is installed once
    per session (`omp://rulebook-matching-pipeline.md:271-275`). Not our problem to solve statically.
- **Revisit if:** Tier 2 lands (#16). At that point the extension can synthesize these same rule
  names live, and the static files become a fallback for sessions without the extension.

### Decision: how staleness surfaces

- **Chosen:** a new checker, `src/drift/checkers/omp-artifacts.ts`, emitting **`OMP_RULE_DRIFT`**
  (warning) when a generated `mex-pattern-<slug>.md` description no longer matches
  `.mex/patterns/<slug>.md`, and **`OMP_RULE_ORPHAN`** (warning) when the source pattern is gone
  entirely. Only files carrying the `<!-- mex-generated -->` marker are ever considered — a
  hand-written user rule in `.omp/rules/` is none of mex's business.
- **Why:** it answers the question that can actually go wrong. Since bodies are pointers, the only
  rot-capable field is the projected `description`, and that is exactly what the checker compares.
- **Accepted gap, stated explicitly as the ticket permits.** A pattern that is **added** after setup
  gets no rule until `mex setup` is re-run, and `mex check` does **not** report that. Reporting it
  would mean every repo with a `.omp/` directory and an un-projected pattern emits a warning the
  user may have deliberately chosen (not every pattern deserves a rulebook slot). Rather than guess
  intent, the missing-rule direction is left silent; the two *wrong-content* directions
  (`OMP_RULE_DRIFT`, `OMP_RULE_ORPHAN`) are reported. Revisit if users ask for it.

---

## The mapping — every row of the ticket's table

| mex concept | omp surface | Shipped as | Verified |
|---|---|---|---|
| `AGENTS.md` anchor ("under 150 tokens") | `.omp/AGENTS.md` context file, native priority 100 | `templates/omp/AGENTS.md` — `@../.mex/AGENTS.md` bridge (see note #1) | live canary, `CANARY_MEX_AGENTS` |
| Non-negotiables | `.omp/RULES.md`, forced `alwaysApply`, re-attached near the current turn | `templates/omp/RULES.md`, ~12 lines hard budget | live session |
| `ROUTER.md` routing table | `.omp/rules/mex-router.md` with `description` | pointer-bodied projection of `templates/ROUTER.md:47-54` | `read rule://mex-router` |
| `patterns/*.md` with `triggers:` | `.omp/rules/mex-pattern-<slug>.md` with `globs:` | generated per pattern; `description` projected, `triggers` → `globs` | see below |
| `context/*.md` | `.omp/skills/mex-wiki/SKILL.md` + rulebook rules | `templates/omp/skills/mex-wiki/SKILL.md` (note #15) | `read skill://mex-wiki` |

Harness constraints honored, from `omp://rulebook-matching-pipeline.md`:

- **`description` is mandatory** for rulebook inclusion (:208-210). Every generated rule has one.
- **`name` comes from the filename**, not frontmatter (:76-80) — so no generated rule sets a
  frontmatter `name`; it would be redundant and could disagree with the filename.
- **`alwaysApply` + `description` → always-apply bucket, EXCLUDED from the rulebook** (:198-202).
  This is a real trap: setting both to "get both behaviors" silently removes the rule from the
  routing table. No generated rulebook rule sets `alwaysApply`. Sticky content goes in `RULES.md`,
  which the harness force-sticks anyway (`omp://context-files.md:171-175`).
- **Rendering is `- <name> (<globs>): <description>`** (:265-267). The description is the entire
  basis for selection, so each is written to name its triggers rather than to describe itself.
- **`globs` are advisory**, surfaced but not enforced for auto-selection (:214-218). So a pattern's
  `triggers` map to `globs` as a *hint* — routing remains advisory, exactly as the ticket says.
- **Dedup is first-wins by bare name** (:158-170), hence the mandatory `mex-` prefix on every
  generated artifact. A bare `router` rule would shadow, or be shadowed by, a user's own.
- **`condition`/`astCondition` (TTSR) deliberately unused.** A rule with a `condition` reaches TTSR
  *only if* `TtsrManager.addRule` accepts it, and otherwise falls through to always-apply
  (`omp://ttsr-injection-lifecycle.md:44-51`) — i.e. a rejected condition silently converts a
  routed rule into a per-turn cost. Not worth the risk for a generated artifact.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| Rulebook rule canonical fields are exactly `name`/`globs`/`alwaysApply`/`description`/`condition`/`astCondition` | `omp://rulebook-matching-pipeline.md:34-42` | read-only |
| `name` is the filename minus `.md` | `omp://rulebook-matching-pipeline.md:76-80` | read-only |
| No `description` → not in rulebook, and not addressable via `rule://` | `omp://rulebook-matching-pipeline.md:208-210` | read-only |
| `alwaysApply` + `description` → always-apply only, excluded from rulebook | `omp://rulebook-matching-pipeline.md:198-202` | read-only |
| Prompt renders `- <name> (<globs>): <description>`; body on demand | `omp://rulebook-matching-pipeline.md:265-267,271-285` | read-only + live |
| `globs` advisory only, no auto-select | `omp://rulebook-matching-pipeline.md:214-218` | read-only |
| Provider precedence + first-wins dedup, later same-name shadowed | `omp://rulebook-matching-pipeline.md:158-170` | read-only |
| Active rule snapshot is installed once per session | `omp://rulebook-matching-pipeline.md:271-275` | read-only |
| `RULES.md` is force-stuck; frontmatter cannot un-stick it | `omp://context-files.md:171-175` | read-only |
| `ROUTER.md` structure: `# Session Bootstrap` / `## Current Project State` / `## Routing Table` / `## Behavioural Contract` | `templates/ROUTER.md:20,26,43,56` | read-only |
| Routing rows are `\| Task type \| Load \|` | `templates/ROUTER.md:47-54` | read-only |
| Pattern frontmatter carries `name`/`description`/`triggers`/`edges`/`grounds_to`/`last_updated` | `templates/patterns/README.md:31-44` | read-only |
| This repo's `.mex/patterns/` holds only `README.md` + `INDEX.md` — no real patterns to project | `.mex/patterns/INDEX.md` | read-only |

**Resolved `[INFERENCE]` (was not in the ledger):** whether a mid-session edit to a generated rule
is picked up. It is not — the active rule snapshot is installed once per session
(`omp://rulebook-matching-pipeline.md:271-275`). This is *why* the accepted gap above is acceptable:
even a live checker could not refresh an in-flight session's rulebook.

## Commands run

Live-omp verification transcript is in `15-omp-skill-and-commands.md` — the rulebook, skill, and
commands were verified in one scratch-repo session.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Copying `ROUTER.md`'s `## Current Project State` into `mex-router`'s body | This is the obvious static projection and it is the one that rots fastest — project state is the most-edited section in the scaffold. Discarding it is what turned "static vs live" from a real tradeoff into a non-issue. |
| Setting `alwaysApply: true` on `mex-router` so it is always in context | `omp://rulebook-matching-pipeline.md:198-202`: always-apply and rulebook are mutually exclusive buckets. It would have *removed* the router from the routing table — the precise opposite of the ticket's intent, and silently. |
| Using `condition:`/`astCondition:` to fire pattern rules on matching stream content | TTSR accepts a rule only under conditions listed in `omp://ttsr-injection-lifecycle.md:44-51` (regex must compile, scope must overlap monitored streams, no duplicate name); on rejection the rule **falls through to always-apply**, converting a cheap routed rule into a per-turn cost. Unacceptable failure mode for a generated file. |
| Putting a frontmatter `name:` in each generated rule | Harmless but redundant — the filename is authoritative (:76-80). Two sources of truth that can disagree; dropped. |
| Emitting one rule per `.mex/context/*.md` page | Five near-identical rules whose only content is "read this file" bloats the rulebook listing, which every turn pays for. The single `mex-router` table routes all five in one entry. |
| Reporting a pattern that has no generated rule | Cannot distinguish "forgot to re-run setup" from "deliberately not projected", so it would emit warnings users cannot action. Documented as the accepted gap instead. |

---

## Changes made

| File | Change |
|---|---|
| `templates/omp/rules/mex-router.md` | New. Pointer-bodied `ROUTER.md` projection. |
| `templates/omp/rules/mex-graph.md` | New. Graph retrieval discipline as a rulebook rule. |
| `templates/omp/rules/mex-grow.md` | New. GROW contract as a rulebook rule. |
| `templates/omp/RULES.md` | New. Sticky non-negotiables, ~12-line budget. |
| `src/setup/index.ts` | `writeOmpArtifacts` emits the above plus `mex-pattern-<slug>.md` per pattern. |
| `src/drift/checkers/omp-artifacts.ts` | New. `OMP_RULE_DRIFT` / `OMP_RULE_ORPHAN`. |
| `docs/omp-integration/omp-surface-mapping.md` | The mapping document this ticket requires. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/setup-omp.test.ts` — rulebook emission | Generated rules exist, are `mex-`-prefixed, carry a `description`, and never set `alwaysApply`. |
| `test/setup-omp.test.ts` — pattern projection | A `.mex/patterns/<slug>.md` yields `mex-pattern-<slug>.md` carrying that pattern's description. |
| `test/checkers.test.ts` — `OMP_RULE_DRIFT` / `OMP_RULE_ORPHAN` | A stale description and a deleted source pattern each surface; unmarked user rules never do. |

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (`read rule://mex-router` in a live omp session — see #15 note)
- [x] `npm test` passes
- [x] `npm run build` passes
- [x] `mex check` did not regress from `94/100`
- [x] Docs updated where behavior changed
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2
- [x] Worktrees / scratch dirs cleaned up

## Follow-ups

- [ ] Live projection via an omp extension module (#16, Tier 2). The rule *names* shipped here are
      the contract it should synthesize, so the two can coexist.
- [ ] A pattern added after setup gets no rule until setup re-runs, and `mex check` stays silent.
      Accepted here; revisit if users hit it.

## Handoff

Finished. Rule names are now a contract: `mex-router`, `mex-graph`, `mex-grow`,
`mex-pattern-<slug>`. Anything regenerating them must keep those names.
