# mex ↔ omp surface mapping

How mex's scaffold maps onto oh-my-pi's native extension surfaces, what `mex setup` installs, and
which harness rules constrain each choice.

Verified against **omp 17.2.4**. Every harness claim cites the harness's own docs, readable with the
`read` tool at `omp://<doc>`.

---

## What `mex setup` installs for the omp target

Selecting **oh-my-pi (omp)** — menu choice `7`, `AiTool` key `"omp"` — writes nine files:

```
.omp/
├── AGENTS.md                      # thin bridge: @../.mex/AGENTS.md
├── RULES.md                       # sticky non-negotiables (force-stuck, per-turn cost)
├── rules/
│   ├── mex-router.md              # the ROUTER.md projection
│   ├── mex-graph.md               # code-graph retrieval discipline
│   ├── mex-grow.md                # the GROW contract
│   └── mex-pattern-<slug>.md      # one per .mex/patterns/<slug>.md with a description
├── skills/mex-wiki/SKILL.md       # retrieval playbook, fetched on demand
└── commands/
    ├── mex-check.md               # /mex-check
    ├── mex-sync.md                # /mex-sync
    └── mex-graph-scope.md         # /mex-graph-scope <task>
```

Paths are published from `src/setup/index.ts` as `ompArtifactPaths`. Nothing is ever overwritten:
an existing file is reported `already exists — skipped`, matching the anchor behavior at
`src/setup/index.ts:569-573`.

`mex setup` also appends `.mex/graph.db*` to the project `.gitignore` under a
`# mex — generated artifacts` marker — independent of tool selection, since a committed binary
graph is not an omp-specific problem.

---

## The mapping, row by row

| mex concept | omp surface | How it ships | Why |
|---|---|---|---|
| `.mex/AGENTS.md` anchor (≤150 tokens) | `.omp/AGENTS.md` context file, `native` priority 100 | one-line `@../.mex/AGENTS.md` import | native is the only shadow-proof slot; the import keeps `.mex/AGENTS.md` the single source of truth |
| Non-negotiables | `.omp/RULES.md` | ~7 lines, no frontmatter | force-stuck and re-attached near the current turn, so it survives long sessions where a context file has scrolled away |
| `.mex/ROUTER.md` routing table | `.omp/rules/mex-router.md` with `description` | pointer-only table | rulebook = name+description in prompt, body on demand — structurally identical to anchor → router → page |
| `.mex/patterns/*.md` `triggers:` | `.omp/rules/mex-pattern-<slug>.md` | generated; `description` projected | makes each pattern individually selectable by the model |
| `.mex/context/*.md` | `.omp/skills/mex-wiki/SKILL.md` + `mex-router` | one skill + the routing table | five near-identical "read this file" rules would bloat a listing every turn pays for |
| Graph retrieval playbook | `.omp/rules/mex-graph.md` + the skill | static template | it is mex behavior, versioned with mex, not project state |
| `mex check` / `mex sync` entry points | `.omp/commands/*.md` | `/mex-check`, `/mex-sync`, `/mex-graph-scope` | user-invoked, discoverable, no prose contract needed |

---

## Harness constraints that shaped the design

From `omp://rulebook-matching-pipeline.md`:

- **Canonical rule fields are exactly** `name`, `globs?`, `alwaysApply?`, `description?`,
  `condition?`, `astCondition?` (:34-42). Nothing else is canonical.
- **`name` comes from the filename**, minus `.md` (:76-80). No generated rule sets a frontmatter
  `name` — it would be a second source of truth that can disagree with the filename.
- **`description` is mandatory for rulebook inclusion.** Without it, and without `alwaysApply` or an
  accepted TTSR condition, a rule is not even addressable via `rule://` (:208-210).
- **`alwaysApply` + `description` → always-apply bucket, excluded from the rulebook** (:198-202).
  This is a trap worth naming: setting both to "get both behaviors" silently removes the rule from
  the routing table. No generated rulebook rule sets `alwaysApply`; `test/tool-config-templates.test.ts`
  asserts that.
- **Prompt rendering is `- <name> (<globs>): <description>`** (:265-267), body fetched via
  `rule://<name>` (:271-285). The description is the entire basis for selection, so each is written
  to name its *triggers*, not to describe itself.
- **`globs` are advisory** — surfaced, never enforced for auto-selection (:214-218). Routing is a
  hint, not a guarantee; that limitation is inherited, not introduced.
- **Dedup is first-wins by bare name** (:158-170) across `native` 100 > `omp-plugins` 90 >
  `agents` 70 > `cursor` 50 > `windsurf` 50 > `cline` 40 > `builtin-defaults` 1. **This is why every
  generated artifact is `mex-` prefixed.** A bare `router` or `check` would shadow, or be shadowed
  by, a user's own.
- **The active rule snapshot is installed once per session** (:271-275) — a mid-session edit to a
  rule file is not picked up.

From `omp://context-files.md`:

- `@` imports resolve **relative to the importing file's directory**, 5 hops max, cycles skipped
  (:147-154). `.omp/AGENTS.md` holding `@../.mex/AGENTS.md` therefore resolves to
  `<root>/.mex/AGENTS.md`.
- **A missing `@` target leaves the literal token in place — no warning, no error** (:147-154).
  This is the sharpest edge in the whole integration: the bridge fails *silently*. It is why
  `OMP_ANCHOR_BROKEN` exists.
- `.omp/RULES.md` is force-`alwaysApply` and frontmatter cannot un-stick it (:171-175). Keep it
  short; it is paid for on every turn.

From `omp://skills.md`:

- Layout is `<skills-root>/<skill-name>/SKILL.md`, exactly one level, **non-recursive** (:29-34).
  `skills/group/name/SKILL.md` is not discovered.
- The native provider passes `requireDescription: true` (:64-69) — **a skill without a
  `description` is silently invisible.** `name` defaults to the directory name.
- Name + description appear in the prompt; the body is fetched on demand (:131-140). So the body can
  afford real detail.

From `omp://slash-command-internals.md`:

- `.omp/commands/*.md`, non-recursive (:54-56, :66-69).
- **`description` is the only documented frontmatter key** (:114-119). `argument-hint`, `model`, and
  `allowed-tools` are *not* documented for omp and are deliberately unused.
- `$ARGUMENTS`, `$@`, `$1`, `$@[start]` expand textually (:189-198). Behavior for an **absent**
  argument is not documented, so `/mex-graph-scope` explicitly instructs the agent to ask rather
  than scope an empty query. Because substitution is textual, the body tells the agent to
  single-quote the task for the shell.

### Deliberately unused: `condition` / `astCondition` (TTSR)

A rule with a `condition` reaches TTSR **only if** `TtsrManager.addRule` accepts it — the regex must
compile, the scope must overlap a monitored stream, and the name must not duplicate
(`omp://ttsr-injection-lifecycle.md:44-51`). On rejection it **falls through to always-apply**,
silently converting a cheap routed rule into a per-turn cost. Unacceptable failure mode for a
generated file, so mex does not emit conditions.

---

## Claude Code compatibility under omp

| Claude Code artifact | omp | Consequence for mex |
|---|---|---|
| `.claude/CLAUDE.md` | ✅ `claude`, priority 80 | mex does not write this |
| root `CLAUDE.md` | ❌ not discovered | **the original bug** — mex writes exactly this |
| root `AGENTS.md` (Codex target) | ⚠️ `agents-md`, priority **10** | discovered but shadowed by anything native |
| `.cursorrules` / `.windsurfrules` | ❌ not rule providers at all | Cursor/Windsurf users get nothing under omp |
| `.opencode/opencode.json` | ✅ `opencode`, priority 55 | references `.mex/AGENTS.md`, so it still works |

Only `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, and `.clinerules` are rule providers. Fixing
Cursor/Windsurf under omp needs a new target and is out of scope here.

---

## Drift coverage

`src/drift/checkers/omp-artifacts.ts` returns `[]` when `<root>/.omp` is absent, so repos that never
adopted omp are unaffected.

| Code | Severity | Fires when |
|---|---|---|
| `OMP_ANCHOR_BROKEN` | error | an `@` import in `.omp/AGENTS.md` does not resolve — the anchor is silently not reaching the agent |
| `OMP_RULE_DRIFT` | warning | a generated `mex-pattern-<slug>.md` description no longer matches `.mex/patterns/<slug>.md` |
| `OMP_RULE_ORPHAN` | warning | a generated rule's source pattern no longer exists |

Only files carrying `<!-- mex-generated -->` are considered. A hand-written rule in `.omp/rules/` is
never reported.

`.omp/AGENTS.md` is **excluded** from `TOOL_CONFIG_DRIFT`. That checker byte-compares installed
anchors against each other (`src/drift/checkers/tool-config-sync.ts:36-47`); the bridge is a one-line
pointer and is *supposed* to differ, so including it would warn on every correct repo. Same rationale
already recorded for `.opencode/opencode.json` at `tool-config-sync.ts:8-10`. Byte-equality is the
wrong question for a reference file — *does the reference resolve* is the right one, and
`OMP_ANCHOR_BROKEN` asks it.

**Accepted gap:** a pattern **added** after setup gets no rule until `mex setup` re-runs, and
`mex check` stays silent. Reporting it would mean warning about patterns a user may have chosen not
to project. The two wrong-content directions are reported; the missing-rule direction is not.

---

## Manual verification

Automated tests cannot drive a live model, so omp-facing behavior is verified by hand. The canary
technique is required: **`--no-tools` is essential**, or the agent may simply *read* the file and
report a false positive.

```bash
# 1. anchor injection (issue #1)
printf 'CANARY_MEX_AGENTS\n' >> .mex/AGENTS.md
omp -p --no-tools "List every token starting with CANARY_ visible in your context. If none, say NONE."
# → CANARY_MEX_AGENTS

# 2. rulebook listing (issue #13)
omp -p --no-tools "List the exact names of every rule in your rulebook listing."
# → mex-graph, mex-grow, mex-router

# 3. rule body on demand (issue #13)
omp -p "Use the read tool on rule://mex-router and quote the table header verbatim."
# → | Task type | Read |

# 4. skill (issue #15)
omp -p "Use the read tool on skill://mex-wiki. State the first mex graph command it says to run."
# → mex graph scope "<task>"

# 5. slash commands (issue #15)
omp -p --no-tools "/mex-check"
# → the agent proceeds to run `mex check` and act on the report
```

All five were executed against omp 17.2.4 in a scratch repo set up by `mex setup`. Transcripts are in
`notes/15-omp-skill-and-commands.md`.
