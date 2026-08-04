# Issue #2 — Add `.omp` (oh-my-pi) as a first-class tool target in `mex setup`

- **Issue:** https://github.com/thekorsen/mex/issues/2
- **Milestone:** Tier 1 — native omp surfaces
- **Branch:** `omp/anchors`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

`mex setup`'s tool menu has no oh-my-pi row, so omp users get no anchor installed and no `aiTools`
entry persisted. Add omp as a real target — union member, `AI_TOOLS` metadata, menu row, template —
with the `cli`/`promptFlag` metadata correct enough that a later lane can drive `mex sync` with it.

## Acceptance criteria

- [x] `mex setup` offers oh-my-pi, installs the anchor, and persists `"omp"` in `.mex/config.json`
      `aiTools`.
- [x] Re-running `mex setup` does not duplicate or clobber the anchor.
- [x] `mex check` reports no new issues on a freshly set-up repo with the omp anchor installed.
- [x] `npm test` passes, including whatever `test/tool-config-templates.test.ts` becomes.

---

## Findings

| Finding | Evidence | Verified? |
|---|---|---|
| `AiTool` union and `AI_TOOLS` metadata table | `src/types.ts:5,14-21` | read-only |
| omp's CLI is `omp`, non-interactive flag is `-p` | `omp --version` → `omp/17.2.4`; onboarding §5 | executed |
| **`loadAiTools` filtered against a hardcoded list that omitted `omp`** | `src/config.ts:120-126` (before) | read-only |
| Menu numbering hardcoded 1-6 tools, 7 = Multiple, 8 = None | `src/setup/index.ts:532-542` (before) | read-only |
| `TOOL_CHOICE_MAP` maps menu key → `AiTool` separately from `TOOL_CONFIGS` | `src/setup/index.ts:516-524` | read-only |
| Existing anchors are never overwritten | `src/setup/index.ts:569-573` | read-only + executed |
| `templates/` ships wholesale via `package.json:23`, so no packaging change was needed for `templates/omp/**` | `package.json:21-27` | read-only |

### The bug this ticket would have shipped with

`src/config.ts:120` held `VALID_AI_TOOLS` as a **second, hardcoded** list of tool names, independent
of `AI_TOOLS`. `loadAiTools` filtered against it (`:122-126`), so adding `"omp"` to the union and the
metadata table would still have left the persisted selection **silently dropped on every reload** —
`mex setup` would report success, `config.json` would contain `"omp"`, and `findConfig().aiTools`
would come back `[]`.

Fixed by validating against `AI_TOOLS` itself:

```ts
return arr.filter((v): v is AiTool => typeof v === "string" && v in AI_TOOLS);
```

One source of truth, so no future tool addition can desync. `test/setup-omp.test.ts` carries the
regression test. Escalated to the parent before editing, since `src/config.ts` sits outside this
lane's OWNED FILES (`FLEET-TICKETS/02.md:17` lists it as in-scope; ASSIGNMENT.md does not); the parent
chose the derive-from-`AI_TOOLS` fix.

## Commands run

```
$ printf '7\n' | node dist/cli.js setup
...
✓ Added .mex/graph.db* to existing .gitignore

Which AI tool do you use?
  1) Claude Code
  ...
  6) Codex (OpenAI)
  7) oh-my-pi (omp)
  8) Multiple (select next)
  9) None / skip

Choice [1-9] (default: 1): ✓ Copied .omp/AGENTS.md
✓ Copied .omp/RULES.md
✓ Copied .omp/rules/mex-router.md
✓ Copied .omp/rules/mex-graph.md
✓ Copied .omp/rules/mex-grow.md
✓ Copied .omp/skills/mex-wiki/SKILL.md
✓ Copied .omp/commands/mex-check.md
✓ Copied .omp/commands/mex-sync.md
✓ Copied .omp/commands/mex-graph-scope.md

$ cat .mex/config.json
{
  "aiTools": [
    "omp"
  ],
  "scaffold_id": "cec65cd7-2741-4478-a0e7-33f60ae04054",
  ...
}
```

Re-run, proving nothing duplicates or clobbers:

```
$ printf '7\n' | node dist/cli.js setup
→ Skipped .gitignore (.mex/graph.db* already ignored)
! .omp/AGENTS.md already exists — skipped (delete it first to replace)
! .omp/RULES.md already exists — skipped (delete it first to replace)
! .omp/rules/mex-router.md already exists — skipped (delete it first to replace)
...  (all 9 artifacts skipped)
```

---

## Decisions

### Decision: `promptFlag` for omp

- **Chosen:** `{ name: "oh-my-pi", cli: "omp", promptFlag: ["-p"] }`.
- **Why:** `promptFlag` is spread ahead of the brief in `src/sync/index.ts:28`
  (`[...meta.promptFlag, brief]`), so `-p` produces `omp -p "<brief>"` — exactly the verified
  non-interactive invocation. Keyed `"omp"` with `cli: "omp"` per the fleet contract, so the
  `mex sync` lane can spawn it without touching this file.

### Decision: menu numbering

- **Chosen:** omp becomes `7`; "Multiple" and "None" shift to `8`/`9`, prompt becomes `[1-9]`.
- **Why:** appending keeps every existing tool's number stable, so muscle memory and any doc that
  says "press 5 for OpenCode" stays correct. Only the two meta-options move. The alternative —
  inserting omp next to the other native-anchor tools — would have renumbered four tools for
  cosmetic grouping.
- **Note:** three separate structures are keyed by the same menu string (`TOOL_CONFIGS`,
  `TOOL_CHOICE_MAP`, and the `switch`). All three were updated; a fourth `case` fallthrough in the
  `switch` is what actually admits the choice, and omitting it would have silently no-op'd the row.

---

## Dead ends

| Approach | Why it failed |
|---|---|
| Adding `"omp"` to the union and `AI_TOOLS` only | Setup appears to work and `config.json` contains `"omp"`, but `loadAiTools` (`src/config.ts:122-126`) filtered it back out on every read. The selection was silently dropped. This is the whole reason the ticket names `src/config.ts` in scope. |
| Appending `"omp"` to the `VALID_AI_TOOLS` literal | Works, but leaves two hardcoded lists that must agree forever — the exact shape of the bug just fixed. Rejected in favour of deriving from `AI_TOOLS`. |
| A derived `const VALID_AI_TOOLS = new Set(Object.keys(AI_TOOLS))` | Correct, but `AI_TOOLS` is *already* a static `Record` — the right lookup for a small fixed string-keyed table. The intermediate `Set` allocated a second structure for nothing; `v in AI_TOOLS` is the whole fix. |
| Inserting the omp row mid-menu | Renumbers four existing tools for cosmetic grouping. Appending shifts only "Multiple"/"None". |
| Extending `templates/.tool-configs/` with an `omp` anchor | The five files there are byte-identical embedded anchors policed by `test/tool-config-templates.test.ts:33-40`. The omp bridge is a one-line pointer, so it belongs in `templates/omp/`, not beside them. |

---

## Changes made

| File | Change |
|---|---|
| `src/types.ts:5` | `"omp"` added to the `AiTool` union. |
| `src/types.ts:21` | `AI_TOOLS.omp = { name: "oh-my-pi", cli: "omp", promptFlag: ["-p"] }`. |
| `src/config.ts:121-127` | `loadAiTools` validates against `AI_TOOLS` instead of a duplicate list. |
| `src/setup/index.ts:59` | `TOOL_CONFIGS["7"]` → `.omp/AGENTS.md`. |
| `src/setup/index.ts:523` | `TOOL_CHOICE_MAP["7"] = "omp"`. |
| `src/setup/index.ts:530-544` | Menu row + `[1-9]` prompt; Multiple/None → 8/9. |
| `src/setup/index.ts:586-600` | `case "7"` added; Multiple/None cases renumbered. |
| `src/setup/index.ts` | `ompArtifactPaths` exported (fleet contract). |
| `templates/omp/AGENTS.md` | New. The anchor bridge. |
| `templates/.tool-configs/README.md` | omp row added to the tool → file table. |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `test/setup-omp.test.ts` — `AI_TOOLS.omp` shape | `cli: "omp"` + `promptFlag` containing `-p`; the fleet contract a later `mex sync` lane consumes. |
| `test/setup-omp.test.ts` — config round-trip | Regression: `"omp"` survives `saveAiTools` → `findConfig`, which the old hardcoded whitelist broke. |
| `test/setup-omp.test.ts` — `ompArtifactPaths` | The published cross-lane path names cannot be renamed silently. |
| `test/tool-config-templates.test.ts` | The bridge references rather than embeds, and the five embedded anchors stay byte-identical. |

---

## Verification

- [x] Acceptance criteria all met
- [x] Ran the actual thing (output pasted above)
- [x] `npm test` passes
- [x] `npm run build` passes
- [x] `mex check` did not regress from `94/100`
- [x] Docs updated where behavior changed
- [x] Worktrees / scratch dirs cleaned up

## Follow-ups

- [ ] `mex sync` does not yet drive omp; that is issue #14's lane. The metadata it needs is in place.

## Handoff

Done. Contract for downstream lanes: `AI_TOOLS.omp` is keyed `"omp"`, `cli: "omp"`,
`promptFlag: ["-p"]`; artifact paths come from `ompArtifactPaths` in `src/setup/index.ts`.
