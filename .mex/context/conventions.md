---
name: conventions
description: How code is written in this project — naming, structure, patterns, and style. Load when writing new code or reviewing existing code.
triggers:
  - "convention"
  - "pattern"
  - "naming"
  - "style"
  - "how should I"
  - "what's the right way"
edges:
  - target: context/architecture.md
    condition: when a convention depends on understanding the system structure
# Add only nodes that embody the documented convention; do not ground examples broadly.
# grounds_to:
#   - node: "function:<tier-1-id>"
#     fingerprint: "mh:64:<hex>"
grounds_to: []
last_updated: "2026-08-04"
---

# Conventions

Read broad, ground tight. When a claim here depends on one specific symbol,
anchor that symbol inline and leave the surrounding prose plain:

```markdown
[`someFunction()`](mex://function:<tier-1-id>)
```

Citations in this scaffold are written as plain text — src/types.ts:5, not the
same string in backticks. A backticked path becomes a claim (src/drift/claims.ts:49,55)
and `pathExists` never strips a `:line` suffix (src/drift/checkers/path.ts:113-164),
so a backticked citation resolves to nothing and raises a MISSING_PATH error.

## Naming

- Files: kebab-case, one concern per file — `tool-config-sync.ts`, `script-coverage.ts`,
  `broken-link.ts`, `engine-impl.ts`, `brief-builder.ts`. Never PascalCase.
- Drift checkers: `check` + subject, verb-first camelCase, one exported per file —
  `checkPaths`, `checkStaleness`, `checkScriptCoverage`, `checkOmpArtifacts`.
- Command entry points: `run` + command — `runDriftCheck`, `runSync`, `runGraphScope`,
  `runImpact`, `runHeartbeat`, `runPatternAdd`. If it is the top of a CLI or MCP
  invocation, it is `run*`.
- MCP tool registrars: `register` + subject + `Tool`, taking the server —
  `registerCheckTool`, `registerGraphScopeTool` (packages/mex-mcp/src/tools/graph.ts:50).
- Module-level constants: SCREAMING_SNAKE_CASE — `DEFAULT_STALENESS_THRESHOLDS`,
  `AI_TOOLS`, `IGNORED_SCRIPTS`, `CHECK_JSON_CONTRACT_VERSION`, `LINK_RE`.
- **Anything persisted or parsed is snake_case; anything in memory is camelCase.**
  On disk: `content_hash`, `modified_at`, `node_count` (src/graph/schema.sql:104-113),
  `last_updated`, `grounds_to`, `scaffold_id`, `checkout_id` (src/types.ts:59-73,181-191).
  In TypeScript: `projectRoot`, `scaffoldRoot`, `aiTools`, `stalenessThresholds`
  (src/types.ts:76-92). The boundary is the file format, not the language.

## Structure

- **ESM with explicit `.js` on every relative import**, even though the sources are
  TypeScript: `from "../../types.js"`, `from "./engine-impl.js"` (src/graph/runtime.ts:4-15,
  src/drift/checkers/staleness.ts:1-8). Zero extensionless relative imports exist
  outside src/graph/__tests__/fixtures, which are parser fixtures excluded from the
  build (tsconfig.json:17). Omitting the extension breaks at runtime, not at build.
- **Named imports from `node:`-prefixed builtins**, never a default import:
  `import { existsSync, readFileSync } from "node:fs"`, `import { resolve, dirname } from "node:path"`,
  `import { tmpdir } from "node:os"` (src/config.ts:1-4). There are no default builtin
  imports in src, test, or packages.
- One checker per file in `src/drift/checkers/`, exporting one `check*` returning
  `DriftIssue[]`. Nothing else invokes a checker: `runDriftCheck` is the only caller
  and the only place a new checker gets wired (src/drift/index.ts:118-203).
- `src/index.ts` is the only public module. Everything else — src/cli.ts, src/setup/,
  src/sync/, src/graph/, src/tui.ts — is internal by declaration (COMPATIBILITY.md:46-56).
- Tests are flat in `test/`, named `<topic>.test.ts`, and never sit beside the source
  they cover. Graph-internal unit tests are the one exception, under src/graph/__tests__/.
- **Non-obvious code carries a comment saying why, usually citing a path or an issue.**
  See src/drift/index.ts:159-162 (why path claims are scoped to ROUTER.md),
  src/graph/runtime.ts:97-101 (why a hash match does not rewrite mtime),
  src/drift/checkers/staleness.ts:98-102 (why the upstream ref, not HEAD),
  src/cli.ts:170-176 (why exit code 2 exists). A comment restating the code is noise;
  a comment naming the rejected alternative is the convention.

## Patterns

**A checker degrades to silence — it never throws.** A file it cannot read yields no
issues, because a crashed check is indistinguishable from an accurate wiki to a CI gate.

```ts
// Correct — src/drift/checkers/broken-link.ts:18-23, script-coverage.ts:36-42
let content: string;
try {
  content = readFileSync(filePath, "utf-8");
} catch {
  continue;             // or: return []
}

// Wrong — one unreadable file fails the whole run
const content = readFileSync(filePath, "utf-8");
```

The same shape guards absent inputs: `checkOmpArtifacts` returns `[]` when there is no
.omp directory (src/drift/checkers/omp-artifacts.ts:33-36), `checkIndexSync` returns `[]`
with no INDEX.md (src/drift/checkers/index-sync.ts:15-16), and the script and dependency
loaders return `null` rather than throwing on malformed JSON
(src/drift/checkers/script-coverage.ts:80-90).

**Off-process output goes through an injected `write`, never `console.log`.** The four
retrieval operations default `write` to `console.log`, so any host whose stdout carries a
protocol must pass its own sink (COMPATIBILITY.md:111-113).

```ts
// Correct — packages/mex-mcp/src/tools/graph.ts:43-47
const lines: string[] = [];
run(config.projectRoot, (line) => lines.push(line));
return { content: [{ type: "text", text: lines.join("\n") }] };

// Wrong — on an MCP stdio server, stdout is the JSON-RPC channel
runGraphScope(task, root);   // writes JSONL straight into the protocol stream
```

**An MCP tool reports failure as a successful response carrying the error, not a protocol
error.** A missing scaffold is an answer, not a transport fault.

```ts
// Correct — packages/mex-mcp/src/tools/check.ts:18-29, graph.ts:31-42
try {
  config = findConfig(root);
} catch (e) {
  return { content: [{ type: "text",
    text: JSON.stringify({ error: (e as Error).message, projectRoot: root }) }] };
}
```

**Contracts widen, they never shift.** `IssueCode` is an additive union — a new checker
appends a member with a comment naming its emitter and severity (src/types.ts:116-139).
`check --json` added `counts` and `contractVersion` while the original four fields kept
their names and positions (src/reporter.ts:80-86), so `contractVersion` is still 1.
Removing or renaming either is a breaking change (COMPATIBILITY.md:242-253).

**A test opens a temp dir, collects it, and cleans it in a hook.** Canonical example:
test/tool-config-templates.test.ts:1-13,52-62. Paths are repo-root-relative because vitest
runs from the repo root, so `readFileSync(join("templates", path))` is correct and a
`../..` walk is not. The second `expect` argument is an assertion label, and it is used
wherever a failure would otherwise be anonymous.

```ts
// Correct — test/tool-config-templates.test.ts:9-14
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const root = mkdtempSync(join(tmpdir(), "mex-tool-configs-"));
roots.push(root);
expect(checkToolConfigSync(root), "installed configs must agree").toEqual([]);
```

`describe`/`it`/`expect` are named imports from `vitest`; there are no globals. Telemetry
is disabled suite-wide in vitest.config.ts, so a test never needs to set `MEX_TELEMETRY`
unless it is testing telemetry itself.

**A test must defend an observable contract and fail on a plausible bug.** Test behavior,
boundaries, invariants, precedence, and real errors. Do not assert source text, an
incidental default, or that a function was merely called. The shipped literals asserted by
test/tool-config-templates.test.ts:19-29 are the deliberate exception: they pin a
*documented authoring contract* — the grounding slots must stay present and the inline
anchor examples must stay inert, which `findMexAnchors(content)` returning `[]` is what
actually proves.

## Verify Checklist

Before presenting any code, run the four gates in this order and state each result.
Export `MEX_TELEMETRY=0` first — a `preAction` hook fires telemetry on every command
(src/cli.ts:55-72).

```bash
npm run typecheck            # tsc --noEmit
npm run build                # tsup + copy-graph-assets
npx vitest run               # full suite, repo-root cwd
node dist/cli.js check --quiet
```

- [ ] Every relative import ends in `.js`; every builtin import is `node:`-prefixed and named.
- [ ] `node dist/cli.js check --quiet` reports zero errors. Warnings are a judgement call;
      an error exits 1 (src/cli.ts:177) and fails the CI gate.
- [ ] A new drift checker is wired into `runDriftCheck`, its code appended to the
      `IssueCode` union, and its severity chosen deliberately — error means exit 1.
- [ ] A new export from `src/index.ts` was intended, is listed in COMPATIBILITY.md, and is
      covered by test/public-api.test.ts. Adding one silently is the failure mode here.
- [ ] Any new test defends an observable contract and would fail on a plausible bug — not
      source text, not an incidental default.
- [ ] Scaffold prose edits cite path:line as plain text, not in backticks, and no
      `**bold**` library name sits under a heading matching stack, tech, dependencies,
      key libraries, or core technologies (src/drift/claims.ts:9,105-110).
