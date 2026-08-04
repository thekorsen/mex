---
name: omp-tier0-quickstart
description: Copy-pasteable quickstart for the Tier 0 omp integration — the mex MCP server plus the @-import anchor bridge, both working today with zero mex source changes.
last_updated: 2026-08-04
---

# Tier 0 — omp integration with zero mex source changes

A working `omp` integration exists today. It requires **no patch to mex** — only a local build and two config files you write yourself. Everything below was executed in this repo on 2026-08-04; the output blocks are transcripts, not paraphrase.

Tier 0 has exactly two mechanisms:

1. **The MCP server** (`packages/mex-mcp`) — mex as native `omp` tool calls over stdio.
2. **The anchor bridge** — `.omp/AGENTS.md` containing an `@` import of `.mex/AGENTS.md`, so the mex wiki anchor reaches the model as injected context.

Read [What Tier 0 does NOT give you](#what-tier-0-does-not-give-you) before you build on it. Tier 0 is a real integration with real holes, and an incomplete promise is worse than none.

---

## Prerequisites

- **Node ≥ 22.5.** Hard requirement, not advisory: mex opens its code graph with the built-in `node:sqlite` `DatabaseSync` (`src/graph/db/sqlite.ts:59-60`), and `package.json#engines` declares `{"node":">=22.5"}`. Verified against Node v26.0.0.
- **A local clone of this repo.** `mex-mcp` is **not published to npm** — `packages/mex-mcp/package.json` depends on `"mex-agent": "file:../.."`, and `CHANGELOG.md:54` states it plainly. There is no `npx mex-mcp`. Local build only.
- **`omp`** for the end-to-end check. Verified against `omp v17.2.4`. The stdio probe and the test suite do **not** need `omp`.

---

## Build

Three commands, in this order, from the repo root:

```bash
npm install                          # creates the mex-agent workspace link
npm run build                        # dist/cli.js
npm run build --workspace mex-mcp    # packages/mex-mcp/dist/index.js
```

### Trap: a green build does not mean the server runs

This is a verified failure you will hit if you skip `npm install` (or if `node_modules` gets pruned):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'mex-agent'
```

`packages/mex-mcp/dist/index.js` imports `mex-agent` at runtime (`packages/mex-mcp/src/tools/check.ts:3`, and the same in the other four tools). That import resolves through the workspace link at `node_modules/mex-agent`, which `npm install` creates from root `package.json#workspaces` (`["packages/*"]`) plus `packages/mex-mcp/package.json`'s `"mex-agent": "file:../.."`.

**`npm run build --workspace mex-mcp` succeeds anyway**, because `tsup` does not resolve runtime dependencies. So the build is not the check. Verify the link directly:

```bash
node --input-type=module -e 'const m = await import("mex-agent"); console.log("ok, exports:", Object.keys(m).length)'
```

```
ok, exports: 14
```

If that throws `ERR_MODULE_NOT_FOUND`, run `npm install` at the repo root and try again. The stdio probe in the next section is the stronger check — it exercises the same import through the actual server entrypoint.

---

## Verify the server before wiring omp to it

Talk to the server directly over stdio. No `omp`, no MCP client, no config — just three newline-delimited JSON-RPC messages on stdin:

```bash
export MEX_TELEMETRY=0
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node packages/mex-mcp/dist/index.js
```

The `initialize` response, verbatim (reflowed for reading; the wire form is one line):

```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"mex-mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

`tools/list` returns one entry per tool with its full JSON Schema. Exit code `0`, empty stderr.

`MEX_TELEMETRY=0` is not politeness. Telemetry fires from a `preAction` hook on every mex command (`src/cli.ts:55-72`); an agent loop emits hundreds of events otherwise. `DO_NOT_TRACK=1` has the same effect.

You can also call a tool in the same session by appending a fourth message:

```bash
export MEX_TELEMETRY=0
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mex_check","arguments":{}}}' \
  | node packages/mex-mcp/dist/index.js
```

The `mex_check` result carries the `DriftReport` as JSON inside a text content block. Decoded:

```json
{
  "score": 94,
  "issues": [
    {
      "code": "UNDOCUMENTED_SCRIPT",
      "severity": "warning",
      "file": "package.json",
      "line": null,
      "message": "Script \"eval\" exists in package.json but is not mentioned in any scaffold file"
    },
    {
      "code": "UNDOCUMENTED_SCRIPT",
      "severity": "warning",
      "file": "package.json",
      "line": null,
      "message": "Script \"eval:e2e\" exists in package.json but is not mentioned in any scaffold file"
    }
  ],
  "filesChecked": 12,
  "timestamp": "2026-08-04T21:39:44.065Z"
}
```

`94` is this repo's current baseline, matching `node dist/cli.js check --quiet` → `mex: drift score 94/100 (2 warnings)`. It is **environment-dependent** — it moves whenever the wiki drifts from the code. Treat a successful handshake and a `score` field as the signal; do not treat `94` as a constant.

---

## Register the server with omp

Write `.omp/mcp.json` at your project root:

```json
{
  "mcpServers": {
    "mex": {
      "type": "stdio",
      "command": "node",
      "args": ["<abs-path-to-repo>/packages/mex-mcp/dist/index.js"],
      "env": { "MEX_TELEMETRY": "0" }
    }
  }
}
```

Replace `<abs-path-to-repo>` with the real absolute path — e.g. `/Users/you/src/mex`. Facts you need to know about this file, all from `omp://mcp-config.md`:

- **The path must be absolute.** `command` is required for `stdio`; `type` defaults to `"stdio"` when omitted, and `args`/`env`/`cwd` are the optional stdio fields. A relative `args` path is resolved against whatever cwd `omp` happens to launch the child in — do not rely on it.
- **`.omp/mcp.json` is project-scoped and profile-independent.** `omp://mcp-config.md`: *"Project-scoped MCP config (`.omp/mcp.json`) is keyed to the working directory, not the profile, so it applies under every profile."* Committing it therefore affects **every** collaborator and every profile — including the absolute path, which will be wrong on their machines.
- **`${VAR}` expansion is the portability escape hatch.** `omp` expands `${VAR}` and `${VAR:-default}` while discovering MCP configs from omp-native files, recursively over string values in `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, and `oauth`; unresolved placeholders stay literal. So a committable form is `"args": ["${MEX_REPO}/packages/mex-mcp/dist/index.js"]` with each collaborator exporting `MEX_REPO`. Note the failure mode: an unset `MEX_REPO` leaves the literal string `${MEX_REPO}/…`, which `node` then fails to open — it does not error at config load.
- **Optional but useful:** add `"$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json"` for editor validation. Server names must match `^[a-zA-Z0-9_.-]{1,100}$`; `mex` does.

Then confirm from inside `omp`:

```bash
export MEX_TELEMETRY=0
omp -p "Call the mex_check MCP tool with no arguments and report only the numeric score."
```

Expect the score for your checkout — `94` on this repo at the pinned baseline. Useful adjuncts once a session is running: `/mcp list` shows which config file each server came from, `/mcp test mex` tests just this server, and `/mcp reload` re-discovers after you edit the JSON.

Verified end to end on 2026-08-04. A disposable project containing only the `.omp/mcp.json` above (with `args` pointing at this repo's built server) plus a `git init`, then:

```bash
export MEX_TELEMETRY=0
omp -p "Call the mex_check MCP tool with projectRoot set to <abs-path-to-repo> and report ONLY the numeric score value it returns."
```

```
94
```

That is the ticket's acceptance criterion met through the harness, not just over raw stdio: `omp` discovered the config, spawned the server, called the tool, and returned mex's real drift score. Note the explicit `projectRoot` — the server defaults to `process.cwd()`, which is the *omp session's* directory (`packages/mex-mcp/src/tools/check.ts:16`). Pass `projectRoot` whenever the session cwd is not the mex project you mean to check.

---

## The tools available today

These are the tools the server advertises **today**, as of `mex-mcp` 0.1.0. This list grows — treat it as the current surface, not a final or closed set, and re-run `tools/list` against your own build rather than trusting this table.

Every tool takes an optional `projectRoot` (absolute path to the project root; defaults to `process.cwd()`). Every tool returns a single text content block containing JSON. Every tool resolves its config via `findConfig(root)` and, on failure, returns `{"error": …, "projectRoot": …}` as a **successful** MCP response rather than a protocol error — so check for an `error` key in the payload.

| Tool | Parameters beyond `projectRoot` | Returns | Source |
|---|---|---|---|
| `mex_check` | none | The full `DriftReport`: `{score, issues[], filesChecked, timestamp}`. `issues[]` entries carry `code`, `severity`, `file`, `line`, `message`. | `packages/mex-mcp/src/tools/check.ts:6-32` |
| `mex_log` | `action`: `"read"` \| `"write"` (default `"read"`); `kind`: one of `decision`, `note`, `risk`, `todo` (required for write); `summary`: string (required for write); `limit`: positive integer, default `20` | Read → the last `limit` events as a JSON array. Write → `{ok: true, kind, summary}`. Write without both `kind` and `summary` → `{"error":"kind and summary are required for write"}`. | `packages/mex-mcp/src/tools/log.ts:6-51` |
| `mex_timeline` | `kind`: string, optional exact-match filter on event kind; `since`: ISO 8601 timestamp, keeps events at or after it; `limit`: positive integer, default `50` | Matching events as a JSON array, sorted **newest first**, then truncated to `limit`. | `packages/mex-mcp/src/tools/timeline.ts:6-49` |
| `mex_heartbeat` | none | `checkHeartbeat` result: `ok` status, stale files with age in days, memory-cleanup status. | `packages/mex-mcp/src/tools/heartbeat.ts:6-32` |
| `mex_read_file` | `file`: **required** string, path relative to `.mex/` — e.g. `AGENTS.md`, `context/stack.md` | The file's raw UTF-8 text (not JSON-wrapped). Sandboxed: a path escaping the scaffold root returns `{"error":"Path escapes scaffold root", "file":…}`; a missing file returns `{"error":"File not found: …", "scaffoldRoot":…}`. | `packages/mex-mcp/src/tools/read-file.ts:7-60` |

Two properties worth noting: the server imports the `mex-agent` public API directly rather than shelling out to the CLI (`CHANGELOG.md:48`), and `mex_read_file` is confined to the `.mex/` scaffold by an explicit prefix check (`packages/mex-mcp/src/tools/read-file.ts:35-43`).

---

## The anchor bridge

The MCP server gives `omp` mex's *tools*. The anchor bridge gives it mex's *wiki* as injected context. It is one file:

`.omp/AGENTS.md`

```
# project anchor

@../.mex/AGENTS.md
```

### Use `@../.mex/AGENTS.md`, not `@.mex/AGENTS.md`

This is the single most important line in this document, because getting it wrong **fails silently**.

`omp://context-files.md:147`: *"Relative paths resolve from the importing file's own directory, not the session's working directory."* The importing file is `.omp/AGENTS.md`, whose directory is `.omp/`. So:

| Written in `.omp/AGENTS.md` | Resolves to | Result |
|---|---|---|
| `@.mex/AGENTS.md` | `.omp/.mex/AGENTS.md` | does not exist → **silently inert** |
| `@../.mex/AGENTS.md` | `<root>/.mex/AGENTS.md` | expanded, content injected ✅ |

Verified by canary probe: with both forms present in one `.omp/AGENTS.md` and a real `.mex/AGENTS.md` as a sibling of `.omp/`, an `omp -p --no-tools` session reported form B's canary token while form A came back as **literal text with nothing inlined**. A control run that also created `.omp/.mex/AGENTS.md` made form A expand — to `.omp/.mex/`, pinning the resolution base. This also matches the ledger entry in `AGENT-ONBOARDING.md:129`.

The silence is by design: `omp://context-files.md:154` — *"A missing or unreadable target leaves the original `@token` text in place rather than erroring."* No warning, no diagnostic. The literal string `@.mex/AGENTS.md` lands in the model's context and looks, to a casual reader of the transcript, like it worked. Always confirm with a canary token and `--no-tools`; without `--no-tools` the agent may simply `read` the file and report a false positive.

Some tickets and older notes say `@.mex/AGENTS.md`. They are wrong. Use the `../` form.

### Other rules that bite

- **`.omp/` must be non-empty.** An empty `.omp/` directory is skipped during the ancestor walk-up and discovery continues to the next ancestor (`omp://context-files.md:32`, restated at `:215`). Creating the directory is not enough — the file has to be there with content.
- **Discovery walks up to the repo root and takes the *nearest* non-empty `.omp/AGENTS.md`.** Farther ancestors are not also loaded (`omp://context-files.md:25,31`). In a monorepo, a package-level `.omp/AGENTS.md` shadows the root one entirely.
- **`native` is priority 100 — it wins outright** over `claude` (80), `agents`/`codex` (70), and everything below (`omp://context-files.md:61,112`).
- **Imports recurse up to five hops** (`:152`) and cycles are skipped (`:153`), so `.mex/AGENTS.md` may itself `@`-import further pages — subject to that budget.
- **Tokens inside fenced code blocks and inline code spans are not expanded** (`omp://context-files.md:149`). The `@../.mex/AGENTS.md` shown in the fence above is therefore **inert as printed** — copy the path into a real `.omp/AGENTS.md` outside any fence for it to do anything. This is deliberate harness behavior, so you can write *about* an `@token`; it also means a fenced example is never self-testing.

### omp cannot see mex's primary Claude Code anchor

`omp` reads `.claude/CLAUDE.md` (the `claude` provider, priority 80) but **not** root `CLAUDE.md` — which is exactly the file `mex setup` installs (`AGENT-ONBOARDING.md:87,96`, verified by canary at `:127`). mex's primary Claude Code anchor is invisible to `omp`. The bridge above is the workaround, not a fix; the fix is a separate ticket (#1, and `.omp` as a `mex setup` tool target is #2).

Likewise, `.cursorrules` and `.windsurfrules` are not `omp` rule providers at all — only `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, and `.clinerules` are (`AGENT-ONBOARDING.md:88`). Two more mex anchors that do nothing here.

---

## What Tier 0 does NOT give you

Every item below is verified or cited. Nothing here is speculation.

**No graph retrieval over MCP.** None of the tools listed above expose the code graph — `tools/list` on this build returned no graph tool of any kind. An agent that wants a code neighborhood must `bash` out to the CLI — `mex graph scope <task…>`, `mex graph get <id…>`, `mex graph query <who-calls|what-calls|where-defined> <symbol>` (confirmed via `node dist/cli.js graph --help`). That costs you the two things MCP was worth: input-schema validation before the call, and a structured result the harness can hand back as data instead of scraped stdout. Note also that graph retrieval fails from any subdirectory (`GRAPH_UNAVAILABLE`, `AGENT-ONBOARDING.md:119`), so the `bash` workaround has to run from the project root. Check `tools/list` against your own build before assuming this still holds — the tool surface is being extended.

**No sync.** There is no `mex_sync` tool, deliberately: *"`mex_sync` is deferred until its structured return shape is settled"* (`CHANGELOG.md:48` — line verified). And the CLI `mex sync` cannot substitute inside an agent loop, because it is TTY-bound: it builds a `node:readline` interface over `process.stdin`/`process.stdout` (`src/sync/index.ts:14-22`) and blocks on `askUser` for a mode choice (`:203`) and again for "run another cycle?" (`:303-305`). `sync --dry-run` is headless and prints the brief (`AGENT-ONBOARDING.md:133`), but it does not perform a sync.

**`mex-mcp` is unpublished.** `"mex-agent": "file:../.."` and `CHANGELOG.md:54`. Every consumer needs a local clone and a local build. There is no version you can pin, and `packages/mex-mcp/dist/` is a gitignored build artifact — a fresh clone has no server until someone runs the build.

**The workspace-link trap.** Covered above and repeated here because it is the most likely first failure: a green `npm run build --workspace mex-mcp` is **not** proof the server runs. Without `node_modules/mex-agent` the built entrypoint throws `ERR_MODULE_NOT_FOUND: Cannot find package 'mex-agent'` on first import.

**No routed context.** The `@` import pulls in the **whole** anchor file — there is no selective retrieval. mex's design is anchor → `ROUTER.md` → page, but under Tier 0 that routing is prose the model is asked to follow, enforced by nothing. Compare `omp`'s rulebook, where rules advertise a `description` and bodies are fetched on demand via `rule://` — a structural match for `ROUTER.md` that Tier 0 does not use (`AGENT-ONBOARDING.md:89`, issue #13).

**The absolute path is not portable.** `.omp/mcp.json` is project-scoped and profile-independent, so committing it hands every collaborator *your* filesystem layout. `${VAR}` expansion mitigates this but does not solve it: each collaborator must export the variable, and an unset variable degrades to a literal `${VAR}` path that fails at spawn time rather than at config load.

**`mex setup` does not write any of this.** Neither `.omp/mcp.json` nor `.omp/AGENTS.md` is in `SCAFFOLD_FILES` or `TOOL_CONFIGS` (`src/setup/index.ts:33-45`, `:52-59`) — `.omp` is not a mex tool target at all. Both files are hand-written, every time, in every checkout. That gap is issue #2.

---

## The regression test

`test/mex-mcp-stdio.test.ts` drives the built server over stdio and asserts the durable contract: the `initialize` handshake completes, the server identifies itself as `mex-mcp` with a version, and it still advertises the tools listed above. It needs no `omp` and no network.

```bash
npx vitest run test/mex-mcp-stdio.test.ts
```

Two deliberate properties: the tool-name assertion is a **subset** check (`expect.arrayContaining`), so adding tools does not break it; and the suite **skips** rather than fails when `packages/mex-mcp/dist/index.js` is absent, because that path is a gitignored build artifact and `npm test` may run before the workspace build. It does not assert the drift score — `94` is environment-dependent.

---

## References

- `docs/omp-integration/AGENT-ONBOARDING.md` — harness facts and the verified-vs-inferred ledger.
- `omp://mcp-config.md` — MCP config locations, fields, `${VAR}` expansion, `/mcp` commands.
- `omp://context-files.md` — context-file discovery, precedence, and `@`-import semantics.
- `CHANGELOG.md:45-54` — the `0.6.3` entry that introduced `packages/mex-mcp`.
