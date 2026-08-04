---
name: add-mcp-tool
description: Add a new tool to the mex-mcp server. Covers the registrar shape, the error envelope, the stdout trap on a stdio transport, and the workspace-link precondition a green build does not prove.
triggers:
  - "mcp tool"
  - "mex-mcp"
  - "add a tool"
  - "expose over mcp"
  - "server.tool"
edges:
  - target: "context/conventions.md"
    condition: "when verifying naming, import style, and the public API boundary"
  - target: "context/decisions.md"
    condition: "when the tool needs a capability that is not yet public API"
grounds_to: []
last_updated: "2026-08-04"
---

# Add an MCP tool

## Context

The MCP server is a separate workspace package that talks to the library only through its
published entry point. Read these before starting:

- packages/mex-mcp/src/index.ts — the whole registration surface, 9 tools today.
- packages/mex-mcp/src/tools/graph.ts — the newest worked example, and the only one with a
  shared helper.
- packages/mex-mcp/src/tools/check.ts — the smallest complete example.
- COMPATIBILITY.md, sections "The public API" and "Graph retrieval" — what you are allowed
  to import.

The hard constraint: `mex-agent` publishes exactly one entry point, so **everything your
tool needs must be exported from src/index.ts**. There is no subpath export and the build
emits only two bundles, so a deep import fails at module resolution, not merely at policy.
If the capability is not public yet, promoting it is a public-API decision — write it down
in context/decisions.md and add it to COMPATIBILITY.md. Do not reach around the boundary.

## Steps

1. Create packages/mex-mcp/src/tools/<name>.ts. Export one `register<Subject>Tool(server)`
   taking the `McpServer`.
2. Call `server.tool(name, description, zodSchema, handler)`. Tool names are snake_case and
   `mex_`-prefixed: `mex_graph_scope`, `mex_impact`.
3. Give every parameter a `.describe()`. The description is the entire interface an agent
   sees — an undescribed parameter is an unusable one. Accept an optional `projectRoot`
   like every existing tool does.
4. Resolve config as `findConfig(projectRoot ?? process.cwd())`, inside a try/catch.
5. On a `findConfig` failure, return `{error, projectRoot}` as a **successful** response —
   a single text content block of JSON, not a thrown protocol error
   (packages/mex-mcp/src/tools/check.ts:18-29).
6. Return one text content block whose text is JSON. That is the shape every tool in the
   package returns; the type is named at packages/mex-mcp/src/tools/graph.ts:19.
7. Import the registrar in packages/mex-mcp/src/index.ts and call it alongside the others
   (packages/mex-mcp/src/index.ts:20-28). A tool that is not called is not registered, and
   nothing will tell you.
8. Update the package description if the tool list changed — it enumerates the tools
   (packages/mex-mcp/package.json:4).
9. Add a test modeled on test/mcp-graph-tools.test.ts: drive the real server over raw stdio
   with `initialize`, then `tools/list`, then `tools/call`.

## Gotchas

- **A green build does not mean the server runs.** `tsup` does not resolve runtime
  dependencies, so the build succeeds even with no `mex-agent` present. Without the
  workspace link the built entrypoint throws `ERR_MODULE_NOT_FOUND: Cannot find package
  'mex-agent'` on first import. The link comes from the root workspaces field plus
  `"mex-agent": "file:../.."` (packages/mex-mcp/package.json:22) and is created by an
  install at the repo root. This is the most likely first failure.
- **On a stdio transport, stdout is the JSON-RPC channel.** Anything that writes to
  `console.log` corrupts the protocol. The four retrieval operations default their `write`
  to `console.log`, so you must pass your own sink and collect the lines
  (packages/mex-mcp/src/tools/graph.ts:43-47). Never `console.log` from a tool handler.
- A missing scaffold is an ordinary answer, not a transport fault. Throwing turns a
  recoverable "this directory has no wiki" into a protocol error the agent cannot read.
- The test suite skips the stdio tests when the server is not built
  (test/mcp-graph-tools.test.ts:21,146). A green run therefore does not prove your tool
  works — confirm the build ran, or you are testing nothing.
- Process-global state in the server must be keyed by project root. The server is
  long-lived and takes a `projectRoot` per call, so a process-wide flag lets the first repo
  checked suppress behavior for every other repo (src/drift/index.ts:25-31).

## Verify

Set `MEX_TELEMETRY=0` first, then the four gates:

```bash
npm run typecheck
npm run build
npx vitest run
node dist/cli.js check --quiet
```

Plus, specific to this task type:

- [ ] The MCP package is built, and the built entrypoint imports without
      `ERR_MODULE_NOT_FOUND`.
- [ ] `tools/list` over raw stdio advertises the new tool, with a description and an object
      input schema that accepts `projectRoot`.
- [ ] `tools/call` on a directory with no scaffold returns `{error, projectRoot}` as a
      successful result, not a protocol error.
- [ ] No handler on the path writes to stdout. Every JSONL producer got an injected `write`.
- [ ] Nothing new is imported from a path other than the package entry point.

## Debug

- `ERR_MODULE_NOT_FOUND: Cannot find package 'mex-agent'` — the workspace link is missing.
  Install at the repo root. The build passing is not evidence against this.
- Tool absent from `tools/list` — the registrar was never called in
  packages/mex-mcp/src/index.ts.
- Client fails to parse a response, or the session dies mid-call — something wrote to
  stdout. Look for a defaulted `write` or a stray `console.log`.
- An import resolves in your editor but fails at runtime — you deep-imported. Only the
  package entry point exists on disk after a build.
- Empty text content — a JSONL producer was called with no `write`, so its output went to
  stdout and the collected array stayed empty.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
