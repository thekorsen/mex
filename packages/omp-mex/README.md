# mex-omp

The [oh-my-pi](https://github.com/oh-my-pi/oh-my-pi) (`omp`) **extension module** for
[`mex`](https://github.com/mex-memory/mex).

`mex` maintains a repo-local living wiki (`.mex/`, structured Markdown, committed) and a
deterministic Tree-sitter→SQLite code graph (`.mex/graph.db`, gitignored, rebuilt
locally). This package wires both into an omp session as running code — routed context
injection, in-process retrieval tools, commands, and a supervised drift watcher.

It is deliberately small. mex already ships **declarative** omp artifacts that cover
everything a Markdown file can express; see
[What this does NOT ship, and why](#what-this-does-not-ship-and-why).

## What it registers, and why each one has to be code

| Surface | Registered as | Why a declarative artifact cannot do it |
|---|---|---|
| Routed per-turn wiki injection | `context` event handler | A rule body is fetched *on demand by the model*, and only if the model decides to. A `context` handler runs on **every** turn, before the request leaves: it reads the live task text, scores `.mex/ROUTER.md`'s `edges:` against it, and admits only the pages that fit a token budget. A static rule can offer a routing *table* and hope. |
| Code-graph retrieval | 4 tools — `mex_graph_scope`, `mex_graph_get`, `mex_graph_query`, `mex_impact` | Each tool runs mex's own retrieval as a **`node` subprocess** and passes the JSONL back verbatim. It has to be a subprocess: omp runs on Bun, Bun has no `node:sqlite`, and `.mex/graph.db` is `node:sqlite` — so in-process retrieval returns `GRAPH_UNAVAILABLE` under omp, always (see [Retrieval runs under `node`](#retrieval-runs-under-node)). A Markdown file could only *tell* the agent to shell out and hope it parses the result; a registered tool gives the model a typed schema, a budget it cannot exceed, and a structured result — with no MCP server to configure. |
| `/mex-context` | slash command | Shows what the router *would* inject for a task and why — the scores, the admitted pages, the rejected ones, the budget arithmetic. There is nothing to print until the routing code exists. |
| `/mex-drift` | slash command | Runs mex's drift check in-process and reports it through the session UI. Drift needs no graph, so this one genuinely is in-process. |
| `/mex-graph-impact` | slash command | Blast-radius review before an edit. Registered **in code** rather than shipped as `commands/mex-graph-impact.md`, because a package's sibling `commands/*.md` is not discovered (verified live — see [Distribution](#distribution)). |
| Background drift watching | `session_start` / `session_shutdown` handlers + `ctx.setInterval` | **Nothing declarative has a timer.** Default interval 10 minutes (`DEFAULT_WATCH_INTERVAL_MS`); status surfaces through `ctx.ui.setStatus("mex", …)`. |
| Post-edit drift nudge | `tool_result` event handler | Requires *observing* other tools' results (`edit`/`write`) to notice the repository moved under a wiki claim. No file can observe an event. |

Nothing in that table duplicates a name that `mex setup` projects into `.omp/`.

### Configuring the router

There is no extension setting to tune. The per-turn injection budget is a fixed
constant (`DEFAULT_INJECTION_BUDGET` in `src/router.ts`, 3000 estimated tokens), and
`src/router.ts` is otherwise a pure scoring engine with no user-facing knobs.

**The configuration surface is `.mex/ROUTER.md`'s own `edges:` frontmatter.** Each edge
is a `{ target, condition }` pair; the `condition` prose is what the router scores the
task against, and the `target` is the page it admits. You tune routing by editing the
wiki — which is also what `mex check` validates and what a human reads — rather than by
configuring the extension.

### Naming rule: keep the `mex-` / `mex_` prefix

Every artifact this package ships is prefixed — tools `mex_*`, commands `mex-*`, skills
`mex-*`. This is not cosmetic. omp resolves artifact-name collisions across providers by
**first-wins dedup**: the highest-precedence provider keeps the name, and each lower
duplicate survives only as a `_shadowed` registry entry that does nothing
(`omp://slash-command-internals.md` §"Name-collision behavior"; `omp://skills.md`
§"Collision and duplicate handling"). Two consequences:

1. An unprefixed name (`graph_scope`, `/check`) will eventually be claimed by another
   plugin, and the loser fails **silently** — no error, just a capability that quietly
   stopped existing.
2. A name colliding with a `templates/omp/` artifact is worse than useless: it converts
   a working declarative artifact into a load-order race against a code twin.

## Requirements

- **Node ≥ 22.5**, matching `mex-agent`.
- **`mex` initialized in the project** — `npx mex-agent setup`. Without `.mex/`, the
  extension resolves no scaffold and every surface degrades to a clean no-op rather
  than an error.
- **`.mex/graph.db` built** before retrieval returns facts — run `mex graph` once per
  checkout, and again after large refactors. The graph is gitignored on purpose, so a
  fresh clone has none. Until it exists, all four retrieval tools return the envelope
  `{"type":"error","code":"GRAPH_UNAVAILABLE","message":"Run \`mex graph\` first."}`.
  That is a **record, not an exception** (`src/graph/cli-agent.ts:469-472`), so a
  missing graph otherwise looks like an ordinary empty answer — which is exactly why
  the tools append an explicit hint to it.
- **`node` on `PATH`.** Retrieval spawns it; see below.

## Retrieval runs under `node`

omp is a Bun program, and **Bun has no `node:sqlite`**. mex's code graph is
`node:sqlite` (`src/graph/db/sqlite.ts:60`), so calling mex's retrieval functions
in-process inside an omp session cannot work — it returns
`{"type":"error","code":"GRAPH_UNAVAILABLE","message":"…Underlying error:
ResolveMessage: No such built-in module: node:sqlite"}` every time. Verified live, and
the same call under `node` returns real JSONL facts.

So each retrieval tool spawns `node <mex>/dist/cli.js graph …` and passes the JSONL
back verbatim. Two consequences worth knowing before you depend on it:

- **`node` must be on `PATH`.** `process.execPath` is deliberately *not* used: under
  omp that is the Bun binary, the one runtime that cannot open the graph.
- **`npm run build` must have run** in the mex project, because the tools invoke
  `dist/cli.js`. If it has not, they say so and name the command rather than failing
  obscurely.

### Cost, and when to prefer the MCP server

Measured on this repo: `node dist/cli.js graph scope "drift check" --max-nodes 5` takes
**~340 ms** (five consecutive runs: 0.35 / 0.34 / 0.34 / 0.33 / 0.34 s). Roughly 240 ms
of that is Node startup, paid per call. In-process under `node` the same operation is
~97 ms — a number omp cannot reach at any price.

For a few calls per turn that is fine; the useful comparison is against a full graph
build (~7 s) or against the agent reading files by hand. **For high-volume retrieval,
prefer `packages/mex-mcp`**: one persistent server process amortises startup across
every call in the session instead of paying it each time. The tool schemas here are a
deliberate copy of that server's, so the same call is portable between the two channels.
Configure it in `.omp/mcp.json` — it is not bundled here (see [Distribution](#distribution)).

## No build step

This package is loaded as **TypeScript source**. omp imports extension entry points with
Bun, which executes `.ts` directly (`omp://extension-loading.md` §"Module import and
factory contract"), so `package.json` points `omp.extensions` at `./src/index.ts` and
there is no bundler, no `dist/`, and nothing to rebuild after an edit — omp even appends
an `?mtime` cache-buster so edited source reloads.

`tsconfig.json` therefore sets `"noEmit": true`. `npm run typecheck` here is a pure
checker: it produces no artifact and is not a prerequisite for running.

This is the opposite of the sibling `packages/mex-mcp`, which *is* bundled by tsup —
an MCP server is spawned as its own process and must be a runnable JS file.

## Installing

### Local / development — `-e`

```bash
omp -e ./packages/omp-mex
```

The path is a directory, so omp reads its `package.json` `omp.extensions` and loads the
declared entry (`omp://extension-loading.md` §"If configured path is a directory").
Loading the package this way also makes the `omp-plugins` provider discover its
**sibling capability directories** (`omp://skills/authoring-extensions.md:97`) — but only
partly, which was verified live rather than taken from the doc:

| Sibling | Discovered? |
|---|---|
| `skills/mex-graph-retrieval/` | **yes** — appears as `skill:mex-graph-retrieval` |
| `commands/*.md` | **no** — a probe package's `commands/probe-cmd.md` never reached `pi.getCommands()` |
| `mcp.json` / `.mcp.json` | **no** — registered zero MCP tools |

So the skill rides along with no registration, and that is why `/mex-graph-impact` is
registered in code (`src/commands.ts`) instead of relying on
`commands/mex-graph-impact.md`, and why the MCP server must be configured in
`.omp/mcp.json` by hand rather than bundled here.

To make it permanent for a project, put it in `<project>/.omp/config.yml` instead:

```yaml
extensions:
  - ./packages/omp-mex
```

### As an npm dependency

Install the package, then point omp at it:

```yaml
# ~/.omp/agent/config.yml or <project>/.omp/config.yml
extensions:
  - ./node_modules/mex-omp
```

Or install it as an omp plugin, which reads the manifest itself and needs no
`extensions:` entry:

```bash
omp plugin install mex-omp          # npm spec
omp plugin link ./packages/omp-mex  # local checkout, symlinked
```

Plugin extension entries are resolved from the package's `omp.extensions` manifest via
`getAllPluginExtensionPaths(cwd)` (`omp://extension-loading.md` §"Installed plugin
extension entries").

### Disabling

```yaml
disabledExtensions:
  - extension-module:omp-mex # derived from the entry path
```

## Distribution

### The documented conflict

Whether a **marketplace** install loads `package.json#omp.extensions` is the one
distribution question the omp docs answer inconsistently. Both readings:

- **`omp://marketplace.md`** (§Concepts), echoed by
  `omp://skills/authoring-marketplaces.md` §"Plugin structure", says marketplace
  installs **do** load them: *"installation symlinks the cached plugin into the scope's
  `node_modules` tree and records it in `omp-plugins.lock.json`, the same runtime
  surfaces used by npm-installed and `omp plugin link`ed plugins."*
  `omp://plugin-manager-installer-plumbing.md` agrees, listing
  `<scope>/plugins/node_modules/<package>` as *"symlink to the cached plugin, allowing
  its `package.json` `omp.extensions` and tools to load"*.
- **`omp://skills/authoring-extensions.md:84`** says the opposite, flatly:
  *"Marketplace cache installs do not feed extension modules — they surface
  skills/commands/hooks/tools/MCP only."*

`[INFERENCE]` The symlink-plus-lockfile reading is the likelier current one: it appears
in two independent documents including the installer-plumbing internals, it names the
concrete mechanism, and `omp://extension-loading.md` §"Installed plugin extension
entries" describes `getAllPluginExtensionPaths(cwd)` as sourcing entries from package
manifests with no carve-out for marketplace-installed packages. The
authoring-extensions sentence reads as a stale caveat predating the symlink. **This is a
documentary judgement, not an executed test.**

What would settle it, and nothing short of it does:

```bash
omp plugin marketplace add ./packages/omp-mex
omp plugin install mex-omp@mex-omp-local
# then start a session and check the tool registry
```

If `mex_graph_scope` is registered, extensions load from marketplace installs. If only
`/mex-graph-impact` and the `mex-graph-retrieval` skill appear, they do not — those come
from plugin-root discovery, which both readings agree happens either way. That asymmetry
is what makes the test decisive.

**Until it is executed, the supported install paths are `-e`, `extensions:`,
`omp plugin link`, and `omp plugin install <npm-spec>`** — all four are unambiguously
documented to load `omp.extensions`.

### Catalog requirements for a consumer

A marketplace is a Git repository or local directory containing a catalog at:

- `.omp-plugin/marketplace.json` — **preferred**, read first
- `.claude-plugin/marketplace.json` — Claude Code-compatible fallback, used only when
  the `.omp-plugin/` path is absent. A repository may ship both.

Required fields: top-level `name`, `owner.name`, and `plugins[]`; each plugin entry
needs `name` and `source`. `metadata.description` / `.version` / `.pluginRoot` are
optional, and `pluginRoot` is prepended to relative sources.

Names — marketplace and plugin alike — must be lowercase letters, digits, hyphens, and
dots, must start and end alphanumeric, and are capped at 64 characters. `mex-omp` is
valid, and the plugin id `mex-omp@mex-omp-local` is well inside the 128-character id
limit.

**npm sources do not work.** `{"source":"npm","package":…}` parses, but the current
installer rejects it with `npm plugin sources are not yet supported`. A real
distribution must use a relative path, GitHub shorthand, a git URL, or `git-subdir`.

### The bundled catalog, and the relative-source form

`packages/omp-mex/.omp-plugin/marketplace.json` exists as an empirical fixture: point
`omp plugin marketplace add` at this package directory and the question above becomes
testable in one command.

That catalog has an unusual shape, deliberately. A string `source` must start with `./`
and resolves **inside the marketplace root**, with traversal outside the root rejected
(`omp://marketplace.md` §"Plugin source formats";
`omp://skills/authoring-marketplaces.md` §"Relative path string"). Normally a catalog
sits at a repository root and points *down* into `./plugins/<name>/`. Here it sits
**inside the very directory it advertises** — the plugin *is* `packages/omp-mex/`, and
the catalog is at `packages/omp-mex/.omp-plugin/`. The marketplace root is therefore
`packages/omp-mex/` itself, and the plugin source must denote *that root*.

The chosen form is:

```json
"source": "./."
```

Reasoning: `"./."` satisfies the literal `./` prefix requirement **and** normalizes to
the marketplace root under either plausible implementation. `path.resolve(root, "./.")`
and `path.join(root, "./.")` both yield `root` exactly, and `path.relative(root, root)`
is `""` — which cannot trip a `startsWith("..")` traversal guard. Each alternative fails
one half of that:

- `"."` — normalizes correctly but does **not** start with `./`, so a literal prefix
  check rejects it.
- `"./"` — passes the prefix check, but `path.join(root, "./")` yields `root/` with a
  trailing separator, which a guard comparing normalized strings could mishandle.

`[INFERENCE]` `"./."` is the form most likely to resolve on the first attempt. If it is
rejected, the fallback that avoids the self-reference entirely is to move the catalog up
one level — into a directory that *contains* `packages/omp-mex/` — and use
`"source": "./packages/omp-mex"`. That catalog no longer ships inside this package,
which is why it is not the default here.

## What this does NOT ship, and why

`mex setup` projects a set of **declarative** omp artifacts into a consuming repo's
`.omp/`, from `templates/omp/`. Every one of them works today. Because omp dedups
first-wins by name, shipping a second copy of any of them in this package would add
**zero** capability and create a silent shadowing race: whichever provider loaded first
would win, the other would sit in the registry marked `_shadowed` doing nothing, and
there would be no error to notice.

Intentionally absent from this package:

| Not shipped here | Owned by | What it does |
|---|---|---|
| `.omp/AGENTS.md` | `templates/omp/AGENTS.md` | Anchor bridge — `@../.mex/AGENTS.md` import |
| `.omp/RULES.md` | `templates/omp/RULES.md` | Always-on behavioural rules |
| `rules/mex-router.md` | `templates/omp/rules/mex-router.md` | Which `.mex/` page to read |
| `rules/mex-graph.md` | `templates/omp/rules/mex-graph.md` | Graph-over-grep discipline, CLI phrasing |
| `rules/mex-grow.md` | `templates/omp/rules/mex-grow.md` | The GROW step after meaningful work |
| `skills/mex-wiki/` | `templates/omp/skills/mex-wiki/SKILL.md` | Retrieval playbook for the **wiki** |
| `commands/mex-check.md` | `templates/omp/commands/mex-check.md` | `/mex-check` — drift report |
| `commands/mex-graph-scope.md` | `templates/omp/commands/mex-graph-scope.md` | `/mex-graph-scope` — CLI scope |
| `commands/mex-sync.md` | `templates/omp/commands/mex-sync.md` | `/mex-sync` — repair drift |

The two artifacts this package *does* ship exist precisely because no template claims
their names and neither makes sense without the extension's tools:

- **`skills/mex-graph-retrieval/`** — the retrieval *workflow* over the four `mex_*`
  tools: scope-then-expand ordering, budget discipline, the JSONL `meta`/`summary`
  framing, and the fact that records are **dropped, not truncated**, at the budget
  ceiling. Distinct from `mex-wiki`, which is about the `.mex/` prose wiki and speaks in
  `mex graph …` CLI invocations. omp **requires** `description` in skill frontmatter for
  the `omp-plugins` provider (unlike Claude Code, where it is optional) — omitting it
  makes the skill silently undiscoverable, so it is present and written to be matched
  on.
- **`commands/mex-graph-impact.md`** — the `/mex-graph-impact` procedure, blast-radius
  review before an edit. `templates/omp/commands/` ships `mex-check`, `mex-graph-scope`
  and `mex-sync`; impact is not among them. Note this file is **not** the delivery
  mechanism: package-sibling `commands/*.md` are not discovered (verified live), so the
  same procedure is registered in code at `src/commands.ts` and this file is the
  readable source of record. Either way the command drives the `mex_impact` **tool**
  rather than a shell line, because command arguments are substituted textually and a
  target containing a quote or backtick would otherwise break or inject into it.

Neither shipped file carries mex's generated-provenance marker — the HTML comment
`mex setup` writes as the first line after frontmatter. That marker means "emitted into
`.omp/` by `mex setup`", and the omp-artifacts drift checker reads its absence as
"hand-written, not mex's business" (`src/drift/checkers/omp-artifacts.ts:9-14`).
Package-shipped artifacts are never projected into `.omp/`, so claiming generated
provenance would be false. The marker is also matched by a bare
`content.includes(...)` (`:139`) with no position constraint, so the two shipped files
avoid the literal string entirely rather than mentioning it in a comment — today the
checker globs only `.omp/rules/mex-pattern-*.md` (`:122-125`), but a claim that depends
on a glob staying narrow is a claim waiting to rot.

## Related

- `packages/mex-mcp` — the same graph retrieval exposed over MCP, for harnesses without
  an extension API. Bundled with tsup because it runs as its own process.
- `docs/omp-integration/` — the integration decision record and evidence ledger.
