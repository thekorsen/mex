/**
 * Graph retrieval as a `node` subprocess.
 *
 * # Why this is not a function call
 *
 * mex's code graph is SQLite, read through the built-in `node:sqlite`
 * (`src/graph/db/sqlite.ts:60`). **Bun does not have `node:sqlite`**, and omp is a
 * Bun program, so an extension cannot read the graph in-process. Verified live in
 * this worktree, three ways:
 *
 * - `runGraphScope(...)` called from inside a real omp session returns
 *   `{"type":"error","code":"GRAPH_UNAVAILABLE","message":"mex code-graph requires
 *   the built-in node:sqlite module (Node.js 22.5+).\nRun mex on Node 22.5 or
 *   newer. Underlying error: ResolveMessage: No such built-in module: node:sqlite"}`.
 * - `bun -e 'await import("node:sqlite")'` → `No such built-in module`, both via
 *   `import()` and via `createRequire`.
 * - `node -e 'require("node:sqlite")'` → `DatabaseSync,StatementSync,Session,…`,
 *   and the same retrieval run under `node` returns real JSONL facts.
 *
 * So the only channel that can reach the graph from inside omp is a process that
 * is not Bun. `spawnSync("node", ["dist/cli.js", "graph", …])` from inside a live
 * session returns the real JSONL envelope; the identical call with
 * `process.execPath` (Bun) returns `GRAPH_UNAVAILABLE`. Hence {@link NODE_BIN}.
 *
 * **Rejected:** porting mex's storage layer to `bun:sqlite`. Bun does ship
 * `bun:sqlite`, but with a different API (`Database`, not `DatabaseSync`), so this
 * would fork mex's storage across two incompatible SQLite surfaces to serve one
 * harness. mex is deliberately provider-neutral; that cost is permanent and the
 * benefit is one harness's in-process latency. Not done, and recorded in
 * `docs/omp-integration/notes/16-omp-extension-module.md` so it is not revisited.
 *
 * # Cost, measured
 *
 * `node dist/cli.js graph scope "drift check" --max-nodes 5`: **~340 ms**
 * wall-clock, five consecutive runs (0.35/0.34/0.34/0.33/0.34 s). The same
 * operation in-process under node is ~97 ms. So the spawn costs roughly 240 ms,
 * dominated by Node startup plus loading `dist/cli.js`.
 *
 * That is not in a hot loop — a model issues a few retrievals per turn, and the
 * comparison that matters is against a full graph build (~7 s) or against the
 * agent re-reading files by hand. For high-volume retrieval `packages/mex-mcp` is
 * the better channel: one persistent server process amortises startup across
 * every call in the session. Both are documented in the package README so a
 * consumer can choose with real numbers.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * The interpreter retrieval runs under.
 *
 * Deliberately the bare name `node`, resolved through `PATH`, and deliberately
 * **not** `process.execPath` — under omp that is the Bun binary, which is exactly
 * the runtime that cannot open the graph. Verified present on `PATH` from inside a
 * live omp session (`node --version` → `v26.0.0`, exit 0).
 */
export const NODE_BIN = "node";

/** Retrieval is a read; a slow one is a bug, not something to wait out. */
export const RETRIEVAL_TIMEOUT_MS = 30_000;

/**
 * Cap on captured stdout, in bytes.
 *
 * Retrieval enforces its own token budget while emitting
 * (`src/graph/agent-protocol.ts:9,101-107`), so output is already bounded in
 * normal operation. This is the backstop for the abnormal case — a wrong `--root`
 * pointed at something that streams — because `spawnSync` buffers into memory
 * inside the agent's own process.
 */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The four retrieval operations, as they appear in `details.operation`. */
export type Operation = "graph_scope" | "graph_get" | "graph_query" | "impact";

/** Outcome of one retrieval subprocess. `jsonl` is passed through verbatim. */
export interface RetrievalRun {
  jsonl: string;
  /** Process exit status, or `null` when it was killed by a signal. */
  status: number | null;
  /** Set when the process could not be spawned or ran over time/output limits. */
  failure?: string;
}

/**
 * Absolute path to mex's built CLI, or `null`.
 *
 * Resolved from `mex-agent/package.json` rather than from this file's own
 * location: this package reaches mex as a dependency, and the two are only
 * siblings inside this repo's workspace. Resolving through the dependency graph
 * keeps it correct when `mex-omp` is installed from npm into `node_modules/`.
 *
 * `dist/cli.js` is gitignored and built by `npm run build`, so its absence is an
 * ordinary state on a fresh checkout — reported to the model as an actionable
 * message rather than thrown.
 *
 * Two resolution strategies for the same reason as `mex.ts:loadMex()`: under omp
 * only `import.meta.resolve` exists, while under Vitest's SSR transform it is
 * absent and `createRequire` is what works.
 */
export function resolveMexCli(): string | null {
  let manifest: string;
  try {
    // Called as a member expression, never through a lifted local: Bun throws
    // `TypeError: import.meta.resolve must be bound to an import.meta object` for a
    // detached reference, and this function's `catch` would turn that into a silent
    // "CLI not built".
    const meta = import.meta as { resolve?: unknown };
    manifest =
      typeof meta.resolve === "function"
        ? fileURLToPath(import.meta.resolve("mex-agent/package.json"))
        : createRequire(import.meta.url).resolve("mex-agent/package.json");
  } catch {
    return null;
  }
  const cli = resolve(dirname(manifest), "dist", "cli.js");
  return existsSync(cli) ? cli : null;
}

/**
 * Run one graph retrieval and capture its JSONL.
 *
 * `args` must already be ordered flags-then-`--`-then-positionals; see
 * {@link buildArgs}.
 *
 * Never throws. Every failure mode — missing CLI, spawn error, timeout, non-zero
 * exit — comes back as a {@link RetrievalRun} for the caller to shape into a tool
 * result, because a tool that throws gives the model nothing to act on.
 */
export function runRetrievalCli(cli: string, args: string[], cwd: string): RetrievalRun {
  const result = spawnSync(NODE_BIN, [cli, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: RETRIEVAL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    // Telemetry fires from a `preAction` hook on every command (`src/cli.ts:55-72`).
    // A model calling retrieval several times a turn would otherwise emit an event
    // per call from inside the user's editor session.
    env: { ...process.env, MEX_TELEMETRY: "0" },
  });

  const jsonl = (result.stdout ?? "").trim();

  if (result.error !== undefined) {
    // ENOENT here means no `node` on PATH — the one environment where this
    // extension's retrieval genuinely cannot work, so it must be said plainly
    // rather than reported as an empty result.
    return { jsonl, status: null, failure: result.error.message };
  }
  if (result.signal !== null) {
    return { jsonl, status: null, failure: `killed by ${result.signal} after ${RETRIEVAL_TIMEOUT_MS}ms` };
  }
  if (result.status !== 0) {
    // The CLI writes its JSONL error envelope to stdout and exits 0 for ordinary
    // failures like a missing graph, so a non-zero status is something else —
    // surface stderr, which is where commander and uncaught errors land.
    const stderr = (result.stderr ?? "").trim();
    return { jsonl, status: result.status, failure: stderr.length > 0 ? stderr : `exit ${String(result.status)}` };
  }

  return { jsonl, status: 0 };
}

/**
 * Build argv for a `graph`/`impact` subcommand.
 *
 * Two ordering rules, both established by executing the built CLI rather than
 * inferred:
 *
 * 1. **`--root` goes before the subcommand name.** `graph` declares `--root`
 *    (`src/cli.ts:206`) and a duplicate declaration on `scope`/`get`/`query` is a
 *    dead flag (ledger §4.2). `graph --root <dir> scope …` is the form that works.
 *    Top-level `impact` has no parent and takes its own `--root`.
 * 2. **Flags first, then `--`, then positionals.** A task string beginning with a
 *    dash is otherwise parsed as an option: `graph … scope "-oh no"` fails with
 *    `error: unknown option '-oh no'`. Putting `--` *after* the flags and before
 *    the positionals fixes it without swallowing the flags — `scope --max-nodes 1
 *    -- "-oh no"` yields `"task":"-oh no"` with `maxNodes:1`, whereas the naive
 *    `scope -- "-oh no" --max-nodes 1` folds the flags into the task text
 *    (`"task":"-oh no --max-nodes 1"`, `maxNodes:10`). This matters because the
 *    task string comes from the model.
 */
export function buildArgs(
  operation: Operation,
  root: string,
  flags: ReadonlyArray<[string, string | undefined]>,
  positionals: readonly string[],
): string[] {
  // `impact` is top-level and takes its own `--root`; the three `graph`
  // subcommands take the parent's, which must precede the subcommand name.
  const args: string[] =
    operation === "impact"
      ? ["impact", "--root", root]
      : ["graph", "--root", root, SUBCOMMAND[operation]];

  for (const [flag, value] of flags) {
    if (value === undefined) continue;
    args.push(flag, value);
  }
  args.push("--", ...positionals);
  return args;
}

/** CLI subcommand name per operation. `impact` is top-level and has none. */
const SUBCOMMAND: Record<Exclude<Operation, "impact">, string> = {
  graph_scope: "scope",
  graph_get: "get",
  graph_query: "query",
};
