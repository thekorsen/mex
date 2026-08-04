# Compatibility & versioning

## Runtime requirement

mex 0.7.0 requires Node.js 22.5 or newer. The code graph uses the built-in `node:sqlite` module; older Node releases are unsupported. Users who cannot upgrade Node can remain on mex v0.6.3, which supports Node.js 20 or newer.

This document defines `mex-agent`'s public contract: what's stable, what isn't,
and what counts as a breaking change. It is intended for embedders — tools that
depend on `mex-agent` as a library — and for `mex-agent` maintainers when
shipping new versions.

If you only use the `mex` CLI, most of this still applies, but CLI flags
themselves are best-effort (see [CLI surface](#cli-surface) below).

## The public API

The only public surface is what's exported from the package entry point:

```ts
import { /* … */ } from "mex-agent";
```

Concretely, that's everything re-exported from
[`src/index.ts`](./src/index.ts):

- **Functions** — `findConfig`, `createConfig`, `appendEvent`, `readEvents`,
  `eventLogPath`, `runDriftCheck`, `parseFrontmatter`, `checkHeartbeat`,
  `runHeartbeat`.
- **Graph retrieval functions** — `runGraphScope`, `runGraphGet`,
  `runGraphQuery`, `runImpact`. See
  [Graph retrieval](#graph-retrieval) for the precise boundary.
- **Runtime constants** — `EVENT_KINDS`, `DEFAULT_STALENESS_THRESHOLDS`,
  `DEFAULT_SCAFFOLD_PATTERNS`, `DEFAULT_HEARTBEAT_PATTERNS`,
  `DEFAULT_RETRIEVAL_OPTIONS`.
- **Types** — `MexConfig`, `CreateConfigInput`, `EventEntry`, `EventKind`,
  `LogOpts`, `DriftReport`, `DriftIssue`, `RunDriftCheckOpts`,
  `HeartbeatResult`, `HeartbeatOpts`, `CheckHeartbeatOpts`,
  `StalenessThresholds`, `WatchConfig`, `HeartbeatConfig`, `AiTool`,
  `IssueCode`, `Severity`, `ScaffoldFrontmatter`, `FrontmatterEdge`, `Claim`,
  `ClaimKind`, `AgentCommandDeps`, `AgentOptions`, `DetailLevel`.

The CI smoke test at [`test/public-api.test.ts`](./test/public-api.test.ts)
asserts the existence and basic shape of these exports. Any change that breaks
that test is a breaking change.

## What is NOT public

Everything else. Specifically:

- All internal modules — `src/cli.ts`, `src/sync/`, `src/scanner/`,
  `src/setup/`, `src/tui.ts`, `src/watch.ts`, `src/doctor.ts`, `src/graph/`,
  and any other path not re-exported from `src/index.ts`. The graph retrieval
  operations re-exported from `src/index.ts` are the sole exception — see
  [Graph retrieval](#graph-retrieval).
- Deep imports such as `mex-agent/dist/internal.js` — the `exports` field in
  `package.json` blocks these, and they may break without notice.
- The on-disk format of internal files such as the scaffold `config.json`. Use
  the documented helpers to read and write them.

## Semver policy

`mex-agent` follows [semver](https://semver.org/) with this interpretation:

| Change                                                | Type  |
| ----------------------------------------------------- | ----- |
| Adding a new export                                   | minor |
| Adding an optional parameter to a public function     | minor |
| Adding an optional field to a public interface        | minor |
| Widening accepted input types                         | minor |
| Bug fix preserving documented behaviour               | patch |
| Internal refactor not visible from outside            | patch |
| Removing a public export                              | major |
| Renaming a public export                              | major |
| Changing a function signature (required parameters)   | major |
| Narrowing a return type or required field             | major |
| Removing a field from a public interface              | major |

While the package is on `0.x` (pre-1.0), breaking changes may ship in minor
versions, but they will still be flagged as breaking — surfaced in the
changelog, with a deprecation note where possible and migration guidance in the
PR description.

## "Soft" parts of the public API

Two exports are public *in name* but not in *contents*:

- **`DEFAULT_SCAFFOLD_PATTERNS`** — the constant continues to exist and to be
  exported, but new entries may be added in any minor version. Embedders that
  need exact behaviour should pass `scaffoldPatterns` explicitly to
  `runDriftCheck`.
- **`DEFAULT_HEARTBEAT_PATTERNS`** — same policy. Pass `scaffoldPatterns`
  explicitly to `checkHeartbeat` / `runHeartbeat` if exact behaviour matters.

These constants are exported so embedders can extend the defaults
(`[...DEFAULT_SCAFFOLD_PATTERNS, "traces/**/*.md"]`) rather than re-typing the
list. They are not a contract on the list's contents.

## Graph retrieval

Four retrieval operations are public: `runGraphScope`, `runGraphGet`,
`runGraphQuery`, and `runImpact`. They exist as public exports because the MCP
server ships as a separate package (`packages/mex-mcp`) and can reach
`mex-agent` only through this entry point; compact, budgeted retrieval is worth
a stable contract.

The contract covers:

- The four functions, their parameter order, and their streaming shape. Each is
  synchronous, returns `void`, and emits one newline-delimited JSON record per
  `write` call.
- **`AgentCommandDeps.write`** — the seam that captures the JSONL stream.
  `write` defaults to `console.log`; a host whose stdout carries a protocol
  (an MCP stdio server, for instance) **must** pass its own `write`.
- The `AgentOptions` field names — `detail`, `maxNodes`, `maxOutputTokens`,
  `maxSourceLines`, `depth`, `fingerprint` — and `DEFAULT_RETRIEVAL_OPTIONS` as
  a base to spread from. `maxOutputTokens` is enforced *while* records are
  emitted, so a response is truncated rather than allowed to exceed it.
- The emitted record `type` values (`meta`, `fact`, `edge`, `source`, `result`,
  `target`, `defines`, `caller`, `grounding`, `error`, `summary`), the
  `schemaVersion` field on `meta`, and the error `code` values. `meta` is
  always first and `summary` always last.

The contract does **not** cover anything that produces those records. The graph
engine, tree-sitter extraction, symbol resolution, fingerprint reconciliation,
and `schema.sql` remain internal, as does every other module under
`src/graph/`. The public surface names *operations*, not implementations: no
way to construct, mutate, or introspect a graph became public.

Bumping `schemaVersion` is a breaking change and is surfaced as one.

## Scaffold-directory ownership

### Code-node grounding

Scaffold frontmatter may include an optional `grounds_to` array. Each entry stores a graph node id and serialized fingerprint:

```yaml
grounds_to:
  - node: "function:a3f8...c21"
    fingerprint: "mh:64:9f2a..."
```

Files without `grounds_to` retain their previous behavior. The graph database and grounding baselines under `.mex/` are internal mex data and should not be edited directly.

The `LanguageExtractor` and `FrameworkResolver` interfaces are source-level contribution seams, not part of the public npm API, and may change between minor versions. They are intentionally not exported from `src/index.ts`. See [Graph retrieval](#graph-retrieval) for the narrow set of graph *operations* that are public.

Inside the `.mex/` scaffold directory, some paths are owned by `mex-agent`
itself, and some are reserved for embedders.

### Owned by mex (mex writes, scans, or manages these)

- `ROUTER.md`, `AGENTS.md`, `SETUP.md`, `SYNC.md` — top-level scaffold files.
- `context/*.md` — context documents (scanned by drift checkers).
- `patterns/*.md` — pattern documents (scanned by drift checkers).
- `events/decisions.jsonl` — append-only event log.
- `config.json` — persisted scaffold configuration.
- `graph.db` (plus SQLite sidecar files) — generated code graph, fingerprints, and grounding baselines.

Embedders should not write to these paths.

### Reserved for embedders

These paths are not scanned by default checkers and `mex-agent` will not write
to them. Embedders may use them freely:

- `.mex/traces/**` — long-form decision traces.
- `.mex/failures/**` — failure / postmortem records.

Other paths under `.mex/` are unclaimed. If you're an embedder and need a new
namespace, open an issue first — `mex-agent` may add features later that
conflict otherwise.

## CLI surface

The `mex` CLI ships in the package, but its flag and subcommand surface is
**best-effort, not contract-bound**. The CLI is a thin wrapper over the
programmatic API; embedders should consume the programmatic API directly
rather than shell out.

The one exception is a small, explicitly enumerated subset that CI systems
need in order to gate a pull request: see [CI contract](#ci-contract) below.
Everything outside that carve-out remains best-effort.

If you need a CLI flag to remain stable, file an issue requesting it be
promoted to the public contract.

## CI contract

This section carves a narrow, stable surface out of the best-effort CLI so a
continuous-integration job can depend on it. A narrow promise the project can
keep beats a broad one it cannot, so the carve-out is deliberately minimal.

### Scope

Exactly two things are contract-bound:

- The shape of the document written by `mex check --json`.
- The process exit codes of `mex check`.

Everything else about the CLI stays best-effort: all other commands, all other
flags, all human-readable output, and all log and stderr text.

In particular, `mex sync`'s output is **not** contract-bound. Its brief text,
wording, and formatting may change at any time. The only promises about `sync`
are its exit code and that `mex sync --non-interactive` — and any `sync`
invocation where stdin or stdout is not a TTY, which is detected as
non-interactive — never blocks on stdin. No particular brief text is promised.

### The `--json` document

```json
{
  "score": 94,
  "issues": [],
  "filesChecked": 12,
  "timestamp": "2026-08-04T21:26:26.594Z",
  "counts": { "error": 0, "warning": 2, "info": 0 },
  "contractVersion": 1
}
```

- `score` — number, 0-100.
- `issues` — array of issue objects (see below).
- `filesChecked` — number.
- `timestamp` — string, ISO 8601.
- `counts` — object with `error`, `warning`, and `info`, all numbers. All three
  keys are always present, including when their value is zero.
- `contractVersion` — number, currently `1`.

Each element of `issues` has:

- `code` — string.
- `severity` — `"error" | "warning" | "info"`.
- `file` — string, repo-relative path.
- `line` — number, or `null`.
- `message` — string.

An issue may also carry a `claim` field. It is optional and internal, and is
**not** part of the contract. Likewise, `verboseLog` appears at the top level
only with `--verbose`, and is **not** part of the contract.

### What the promise actually is

- The six top-level contract fields above keep their names, types, and meanings
  within a major version.
- New fields **may** be added. Additive changes are not breaking, so consumers
  must tolerate unknown keys.
- `contractVersion` is bumped **only** on a breaking change to this shape. It is
  currently `1`. A consumer should assert on `contractVersion` rather than on the
  package version.
- New `code` values **may** be added to `issues[]`. A consumer must not
  exhaustively switch on `code`.
- New `severity` values will **not** be added within a major version.

### Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| `0`  | No error-severity issues — clean, or warnings and info only.                         |
| `1`  | At least one error-severity issue.                                                   |
| `2`  | mex could not complete the check — bad or missing scaffold, no git repository, internal error. |

`0` and `1` keep their current meanings. `2` exists because an operational
failure previously exited `1` with empty stdout and the reason on stderr, which
a gate cannot distinguish from genuine drift — so CI would read "no scaffold" as
"the wiki is accurate". A consumer that treats any non-zero exit as failure
keeps working unchanged; one that wants to tell infrastructure breakage apart
from knowledge drift can now do so.

### Stream discipline

With `--json`, the document is written to **stdout** and nothing else is. All
human-readable text, warnings, and the feedback nudge go to **stderr**
([`src/feedback/index.ts:127-134`](./src/feedback/index.ts)). A consumer may
safely pipe stdout to `jq`.

### Worked example

```bash
#!/usr/bin/env bash
# MEX_TELEMETRY=0 belongs in any CI environment.
export MEX_TELEMETRY=0

mex check --json > mex-check.json
status=$?

case "$status" in
  0) echo "wiki is accurate" ;;
  1)
    errors=$(jq '.counts.error' mex-check.json)
    echo "knowledge drift: $errors error-severity issues"
    exit 1
    ;;
  2)
    echo "mex could not run the check — treat as infrastructure failure" >&2
    exit 1
    ;;
esac
```

Read `.counts.error` directly rather than reducing `issues` by severity: the
counts object is contract-bound and always present, and it stays correct as new
`code` values are added.

### Extending it

Anything a consumer needs beyond this surface is still best-effort. File an
issue requesting it be promoted to the public contract, and it will be added
here deliberately.

## Deprecation policy

When a public export is going to be removed:

1. It is marked `@deprecated` in JSDoc and noted in the changelog.
2. It remains functional for **at least one minor version** with the
   deprecation warning in place.
3. The next major version removes it.

Concrete example: if `foo` is deprecated in 0.7.0, it still works in 0.7.x. It
may be removed in 0.8.0 or 1.0.0.

## Reporting compatibility issues

If you find behaviour that diverges from this document — an undocumented
breaking change, an unclear case, or a contract you need that isn't covered —
open an issue at <https://github.com/mex-memory/mex/issues>.
