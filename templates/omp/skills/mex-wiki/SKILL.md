---
description: Retrieval playbook for this repo's mex living wiki and code graph. Use for architecture questions, symbol lookup ("where is X", "who calls X"), impact analysis before editing a symbol, choosing which .mex/ page to read, and repairing wiki drift with mex check / mex sync.
---
<!-- mex-generated -->

# mex Retrieval Playbook

## What `.mex/` is

Two things live side by side:

- **The living wiki** — `.mex/*.md`, committed to git. `AGENTS.md` (identity, non-negotiables, commands), `ROUTER.md` (session bootstrap, current project state, routing table, behavioural contract), `context/` (architecture, stack, conventions, decisions, setup), and `patterns/` (task runbooks, indexed by `patterns/INDEX.md`, authored per `patterns/README.md`).
- **The code graph** — `.mex/graph.db`, gitignored and rebuilt locally. A Tree-sitter/SQLite index of symbols and their relationships. It is a retrieval layer, not documentation.

Prose answers "why and how we work"; the graph answers "where and what calls what". Ask the right one.

## Graph first, files last

Prefer graph commands over grepping or reading files.

1. `mex graph scope "<task>"` — start here for anything you cannot already name. It returns a compact JSONL manifest (`meta`, `fact`s, `summary`) — a scored neighborhood under a hard token budget, not a source dump.
2. Pick **1-3** relevant node ids from the manifest. Expand only those: `mex graph get <id> --detail source`.
3. Treat any source the graph returns as **ALREADY READ**. Do not re-open those files with a file read — that is a pure duplicate of context you are already paying for.
4. If you already know the symbol, skip scope entirely: `mex graph query where-defined <symbol>`, `mex graph query who-calls <symbol>`, `mex graph query what-calls <symbol>`.
5. **Before editing a symbol**, run `mex impact <symbol|file>`. It lists affected callers and the wiki pages grounded to that symbol — those pages are the ones you will owe an update to.
6. If a result reports `truncated`, do **not** repeat the broad query. Narrow the task string, or follow the summary's `suggestedNextCommands`. Scale through a few focused calls, never one giant response.

Fall back to plain file reads only when the graph genuinely has nothing: config files, generated output, non-indexed languages, or prose.

## Which wiki page to read

| Situation | Read |
|---|---|
| Session start, or you have lost the thread of project state | `.mex/ROUTER.md` — read it fully; it names current state and routes onward |
| How components connect, integrations, system design | `.mex/context/architecture.md` |
| A specific library, runtime, or tech decision | `.mex/context/stack.md` |
| Writing or reviewing code; unsure of a project pattern | `.mex/context/conventions.md` |
| "Why is it built this way" | `.mex/context/decisions.md` |
| Environment setup, running the project | `.mex/context/setup.md` |
| Starting any recurring task | `.mex/patterns/INDEX.md`, then the matching pattern file |

A `patterns/` file is a runbook: Context, Steps, Gotchas, Verify, Debug. If one matches the task, follow its Steps. If you are about to deviate from it, say so before writing code — state the deviation and why.

Do not read the whole wiki. The routing table exists so you load one or two pages, not all of them.

## The drift loop

The wiki is only worth trusting because it is checked.

- `mex check` — validates paths, commands, dependencies, links, indexes, staleness, tool configuration, and grounded code symbols. No AI tokens. A **nonzero exit means at least one error-severity issue**; warnings alone exit clean.
- `mex sync` — hands you only the drifted files with targeted context, so you repair instead of rediscovering the project.

When repairing:

- Make **surgical edits**, never whole-file rewrites. Preserve frontmatter structure; edit individual fields.
- Adjudicate any **AMBIGUOUS** grounding rather than guessing: use `scope`/`query`/`impact` to decide whether the surfaced candidate is the same behavior. If it is, point `grounds_to` and any inline `mex://` anchor at that id; otherwise pick the correct node or remove the stale grounding.
- Decide per issue which side is wrong: reality changed (update the page) or the claim was always wrong (fix the claim). **Never edit `.mex/` prose merely to make a checker pass** — that deletes the only signal the tool has.

## After meaningful work — GROW

- **Ground:** what changed in reality? Name the changed behavior, command, dependency, or workflow.
- **Record:** update `.mex/ROUTER.md` "Current Project State"; surgically update the affected `.mex/context/` page.
- **Orient:** if this task can recur and no pattern covers it, add one under `.mex/patterns/` and register it in `INDEX.md`. If a pattern exists and you hit a gotcha, add the gotcha.
- **Write:** bump `last_updated` on every scaffold file you changed, and run `mex log` when the rationale matters.
