/**
 * Code-graph retrieval tools backed by a `node` subprocess.
 *
 * # Why these exist as an extension, not only as MCP tools
 *
 * `packages/mex-mcp` already exposes the same four operations over stdio
 * (`packages/mex-mcp/src/tools/graph.ts:50,84,113,146`). These extension tools do
 * **not** exist to remove the subprocess any more — that premise died once live
 * execution showed omp is a Bun program and Bun does not provide `node:sqlite`,
 * which mex's graph reader requires (`packages/omp-mex/src/mex.ts:30-36`,
 * `packages/omp-mex/src/spawn.ts:6-23`). Retrieval therefore MUST run under
 * `node`, from a subprocess, even when invoked inside omp.
 *
 * The tools still earn their place in-registry: there is no MCP server to
 * configure, no stdio channel to stand up, and the extension remains one install
 * unit the user can load with `-e`. For high-volume retrieval,
 * `packages/mex-mcp` is the preferred channel because one persistent server
 * amortises startup across every call; the measured numbers in this worktree were
 * ~340 ms for `node dist/cli.js graph scope ...` versus ~97 ms for the same
 * retrieval in-process under node, with a full graph build around ~7 s
 * (`packages/omp-mex/src/spawn.ts:32-44`).
 *
 * # The schemas are a deliberate copy, not a fork
 *
 * Parameter names, defaults, and `describe()` wording are lifted verbatim from
 * the MCP tools. Two channels reaching the same operation with two different
 * schemas would be a regression the model pays for: it would learn one shape and
 * be wrong half the time. `tokenBudget` -> `maxOutputTokens` for
 * scope/query/impact, and the literal `maxOutputTokens` for `graph get`, mirrors
 * the MCP naming exactly (`packages/mex-mcp/src/tools/graph.ts:62,96,128,158`),
 * including that inconsistency.
 *
 * # Names
 *
 * All four keep the `mex_` prefix. omp dedups tools **first-wins by name** across
 * providers, so an unprefixed `graph_scope` would be a live collision hazard with
 * any other extension; the prefix is what makes the name globally unique.
 */

import type { MexScaffold } from "./mex.js";
import type {
  OmpContext,
  OmpExtensionAPI,
  OmpToolDefinition,
  OmpToolResult,
  OmpZodType,
} from "./omp-api.js";
import {
  buildArgs,
  resolveMexCli,
  runRetrievalCli,
  type Operation,
} from "./spawn.js";

/**
 * Cross-slice contract with `index.ts`. Declared locally in every registrar so
 * the five modules stay independent of each other's write order.
 */
export type ScaffoldResolver = (cwd: string) => Promise<MexScaffold | null>;

/**
 * Structured mirror of what the JSONL says, so the TUI and session state can
 * reconstruct a result without re-parsing newline-delimited JSON.
 */
interface RetrievalDetails {
  operation: Operation;
  /** The root actually handed to the retrieval op after resolution. */
  projectRoot: string;
  /** Whether a `.mex/graph.db` was known to exist before the call. */
  graphAvailable: boolean;
  /** JSONL record counts keyed by the record's `type` field. */
  recordCounts: Record<string, number>;
  /** `code` of the first `{"type":"error"}` record, when the stream carried one. */
  errorCode?: string;
}

/** Hint appended whenever retrieval could not reach a graph. */
const NO_GRAPH_HINT =
  "No mex code graph for this project yet. Run `mex graph` at the project root to build `.mex/graph.db`, then retry.";

/** Hint returned when mex's built CLI is missing. */
const NO_CLI_HINT =
  "mex's retrieval CLI is not built yet. Run `npm run build` in the mex project, then retry.";

/**
 * Resolve the root a retrieval op should run against.
 *
 * Precedence is explicit-param, then the session's resolved mex project, then the
 * raw cwd. The middle step matters: `findConfig` walks up to the git root
 * (`src/config.ts:56`), so a session started in a subdirectory still reaches the
 * graph at the repo root instead of reporting GRAPH_UNAVAILABLE.
 */
async function resolveRoot(
  params: Record<string, unknown>,
  getScaffold: ScaffoldResolver,
  ctx: OmpContext | undefined,
): Promise<{ root: string; scaffold: MexScaffold | null }> {
  const explicit = typeof params.projectRoot === "string" ? params.projectRoot : undefined;
  const cwd = ctx?.cwd ?? process.cwd();
  const scaffold = await getScaffold(cwd);
  return { root: explicit ?? scaffold?.projectRoot ?? cwd, scaffold };
}

/**
 * Read one property off an untrusted value without asserting a shape.
 *
 * Retrieval JSONL and persisted `details` both arrive as `unknown` — they cross a
 * process/serialization boundary — so every field read here is checked at runtime
 * and returned as `unknown` for the caller to narrow.
 */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  if (!(key in value)) return undefined;
  // Narrowed above: `value` is a non-null object that has `key`, so an index read
  // is sound; TypeScript just has no type for "object with arbitrary keys".
  const record = value as Record<string, unknown>;
  return record[key];
}

/** Count JSONL records by `type`, and surface the first error `code`. */
function summarize(jsonl: string): { recordCounts: Record<string, number>; errorCode?: string } {
  const recordCounts: Record<string, number> = {};
  let errorCode: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A non-JSON line is not something retrieval emits; count it rather than
      // throwing, because a tool must always return a result.
      recordCounts.unparsed = (recordCounts.unparsed ?? 0) + 1;
      continue;
    }
    const typeField = field(record, "type");
    const type = typeof typeField === "string" ? typeField : "unknown";
    recordCounts[type] = (recordCounts[type] ?? 0) + 1;
    if (type === "error" && errorCode === undefined) {
      const code = field(record, "code");
      if (typeof code === "string") errorCode = code;
    }
  }
  return { recordCounts, errorCode };
}

/**
 * Shape one retrieval stream into a tool result.
 *
 * Two things are load-bearing here:
 *
 * 1. **The JSONL must pass through verbatim.** These tools front the CLI, whose
 *    stdout is the protocol surface; re-serializing would risk changing line
 *    order, whitespace, or framing the model relies on. `runRetrievalCli()`
 *    already returns the captured stdout as raw text for this reason
 *    (`packages/omp-mex/src/spawn.ts:79-85,121-153`).
 * 2. **Missing graph is a state, not a failure.** The CLI writes
 *    `{"type":"error","code":"GRAPH_UNAVAILABLE"}` to stdout and exits 0 for
 *    ordinary retrieval misses, so the stream is passed through verbatim and an
 *    actionable hint is appended, with `isError` left unset. Marking that case as
 *    a tool error would invite the model to retry the same call instead of running
 *    `mex graph`.
 */
function runRetrieval(operation: Operation, root: string, jsonl: string): OmpToolResult {
  const { recordCounts, errorCode } = summarize(jsonl);
  const details: RetrievalDetails = {
    operation,
    projectRoot: root,
    // Read off the stream, not off the session scaffold: an explicit
    // `projectRoot` param can point at an entirely different tree, and reporting
    // this session's answer about `root` would then be a lie. A `meta` record is
    // only framed once a session opened (`src/graph/agent-protocol.ts:6-7`), so
    // its presence *is* the evidence a graph was reachable.
    graphAvailable: recordCounts.meta !== undefined,
    recordCounts,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
  const text = errorCode === "GRAPH_UNAVAILABLE" ? `${jsonl}\n\n${NO_GRAPH_HINT}` : jsonl;
  return { content: [{ type: "text", text }], details };
}

/**
 * Short-circuit for a project with no wiki or no built graph.
 *
 * Retrieval would emit `GRAPH_UNAVAILABLE` anyway, but only after spawning node
 * and opening a session; answering here keeps the hint identical whether the miss
 * was detected by the resolver or by the CLI, and skips the subprocess work.
 */
function noGraphResult(operation: Operation, root: string): OmpToolResult {
  const details: RetrievalDetails = {
    operation,
    projectRoot: root,
    graphAvailable: false,
    recordCounts: { error: 1 },
    errorCode: "GRAPH_UNAVAILABLE",
  };
  const envelope = JSON.stringify({
    type: "error",
    code: "GRAPH_UNAVAILABLE",
    message: "Run `mex graph` first.",
  });
  return { content: [{ type: "text", text: `${envelope}\n\n${NO_GRAPH_HINT}` }], details };
}

/**
 * Actionable result for a checkout where `dist/cli.js` has not been built yet.
 *
 * Exported as a test seam. The alternative — driving this path through `execute`
 * — can only be reached by actually having an unbuilt CLI, which is the opposite
 * of the state the rest of the suite needs, so a test for it would either spawn a
 * real subprocess or silently pass for the wrong reason.
 */
export function noCliResult(operation: Operation, root: string): OmpToolResult {
  const details: RetrievalDetails = {
    operation,
    projectRoot: root,
    graphAvailable: false,
    recordCounts: {},
    errorCode: "CLI_UNBUILT",
  };
  return {
    content: [{ type: "text", text: NO_CLI_HINT }],
    details,
  };
}

/**
 * Actionable result for a subprocess failure outside retrieval's JSONL envelope.
 *
 * Exported as a test seam for the same reason as {@link noCliResult}: reaching it
 * through `execute` requires a real `spawnSync` that genuinely fails (ENOENT,
 * timeout, non-zero exit), which no hermetic unit test should manufacture.
 */
export function toolFailedResult(operation: Operation, root: string, failure: string): OmpToolResult {
  const details: RetrievalDetails = {
    operation,
    projectRoot: root,
    graphAvailable: false,
    recordCounts: {},
    errorCode: "TOOL_FAILED",
  };
  return {
    content: [{ type: "text", text: `mex ${operation} failed: ${failure}` }],
    details,
    isError: true,
  };
}

/** `{"type":"error","code":"ABORTED"}`-shaped early return for a cancelled call. */
function abortedResult(operation: Operation, root: string): OmpToolResult {
  const details: RetrievalDetails = {
    operation,
    projectRoot: root,
    graphAvailable: false,
    recordCounts: {},
    errorCode: "ABORTED",
  };
  return {
    content: [{ type: "text", text: `mex ${operation} aborted before it started.` }],
    details,
  };
}

/** Numeric param or `undefined`; zod has already validated the type. */
function num(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}

/** String param or `undefined`. */
function str(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Compact human summary for the TUI, in place of raw JSONL.
 *
 * A scope call returns dozens of `fact` lines; rendering them verbatim in the
 * transcript costs the user's screen for information the model consumed. The
 * counts plus the budget line are what a human actually wants to see.
 *
 * Defensive by construction: `details` arrives as `unknown` because it round-trips
 * through session persistence, so every field is checked before use. The harness
 * catches renderer throws, but a tool whose result cannot be displayed is still a
 * broken tool.
 */
function renderRetrievalSummary(details: unknown, budgetKey: string): string | undefined {
  const operation = field(details, "operation");
  if (typeof operation !== "string") return undefined;

  const errorCode = field(details, "errorCode");
  if (errorCode === "GRAPH_UNAVAILABLE") return `mex ${operation}: no code graph — run \`mex graph\``;
  if (typeof errorCode === "string") return `mex ${operation}: ${errorCode}`;

  const counts = field(details, "recordCounts");
  if (counts === null || typeof counts !== "object") return undefined;
  const parts: string[] = [];
  for (const [type, count] of Object.entries(counts)) {
    // `meta`/`summary` are protocol framing on every stream
    // (`src/graph/agent-protocol.ts:6-8`); reporting "1 meta" every time is noise.
    if (type === "meta" || type === "summary") continue;
    parts.push(`${String(count)} ${type}`);
  }
  const body = parts.length > 0 ? parts.join(", ") : "no records";
  return `mex ${operation}: ${body} (${budgetKey})`;
}

/** Build CLI flags from validated tool params, omitting absent values entirely. */
function retrievalFlags(
  params: Record<string, unknown>,
  spec: ReadonlyArray<{ param: string; flag: string }>,
): Array<[string, string | undefined]> {
  return spec.map(({ param, flag }) => {
    const numeric = num(params, param);
    if (numeric !== undefined) return [flag, String(numeric)];
    const text = str(params, param);
    if (text !== undefined) return [flag, text];
    return [flag, undefined];
  });
}

export function registerTools(pi: OmpExtensionAPI, getScaffold: ScaffoldResolver): void {
  const { z } = pi.zod;

  /** Shared `detail` schema. Wording copied from `packages/mex-mcp/src/tools/graph.ts:11-16`. */
  const detail = (): OmpZodType =>
    z
      .enum(["minimal", "standard", "source"])
      .optional()
      .describe(
        "Controls how much graph detail the returned JSONL includes: minimal facts (default), standard facts plus structural edges, or source excerpts when they fit the budget.",
      );

  const projectRoot = (): OmpZodType =>
    z.string().optional().describe("Absolute path to the project root. Defaults to cwd.");

  const tokenBudget = (): OmpZodType =>
    z
      .number()
      .default(1500)
      .describe(
        "Hard output token cap for the emitted JSONL. Defaults to 1500 and is enforced while records are emitted; overflowing records are dropped instead of exceeding the cap.",
      );

  /**
   * Wrap a retrieval op as an omp tool `execute`.
   *
   * `signal?.aborted` is checked once, up front. The subprocess path uses
   * `spawnSync`, so there is still no await point inside the retrieval itself at
   * which a mid-flight abort could be observed; pretending otherwise with a
   * post-hoc check would be theatre. The pre-check is the honest, and only,
   * cancellation point.
   */
  const executor =
    (
      operation: Operation,
      argsFor: (params: Record<string, unknown>, root: string) => string[],
    ) =>
    async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: (partial: OmpToolResult) => void,
      ctx?: OmpContext,
    ): Promise<OmpToolResult> => {
      const { root, scaffold } = await resolveRoot(params, getScaffold, ctx);
      if (signal?.aborted) return abortedResult(operation, root);
      // Only short-circuit when we positively know there is no graph. An explicit
      // `projectRoot` bypasses the session scaffold entirely, so trust retrieval's
      // own guard there rather than this session's answer about a different root.
      const explicitRoot = typeof params.projectRoot === "string";
      if (!explicitRoot && (scaffold === null || !scaffold.hasGraph)) return noGraphResult(operation, root);

      const cli = resolveMexCli();
      if (cli === null) return noCliResult(operation, root);

      const run = runRetrievalCli(cli, argsFor(params, root), ctx?.cwd ?? process.cwd());
      if (run.failure !== undefined) return toolFailedResult(operation, root, run.failure);
      return runRetrieval(operation, root, run.jsonl);
    };

  const scope: OmpToolDefinition = {
    name: "mex_graph_scope",
    label: "mex graph scope",
    description:
      "Entry point for graph retrieval. Returns scored JSONL symbol neighborhoods for a task under a hard token budget, so an agent can identify relevant code before expanding source.",
    parameters: z.object({
      projectRoot: projectRoot(),
      task: z
        .string()
        .describe(
          "Natural-language task to scope. Returns scored JSONL facts for the most relevant symbols and, at higher detail levels, structural edges or source that fit the budget.",
        ),
      tokenBudget: tokenBudget(),
      maxNodes: z
        .number()
        .optional()
        .describe("Maximum number of graph nodes to return in the scoped JSONL neighborhood for the task."),
      detail: detail(),
      maxSourceLines: z
        .number()
        .optional()
        .describe("When detail is source, caps the source lines included per returned node in the JSONL output."),
    }),
    execute: executor("graph_scope", (params, root) =>
      buildArgs(
        "graph_scope",
        root,
        retrievalFlags(params, [
          { param: "tokenBudget", flag: "--max-output-tokens" },
          { param: "maxNodes", flag: "--max-nodes" },
          { param: "detail", flag: "--detail" },
          { param: "maxSourceLines", flag: "--max-source-lines" },
        ]),
        [str(params, "task") ?? ""],
      ),
    ),
    renderResult: (...args: unknown[]) => renderRetrievalSummary(args[0], "budgeted JSONL"),
  };

  const get: OmpToolDefinition = {
    name: "mex_graph_get",
    label: "mex graph get",
    description:
      "Expand specific graph node ids to source. Returns raw JSONL source records for known node ids after scope/query/impact identifies what to inspect.",
    parameters: z.object({
      projectRoot: projectRoot(),
      ids: z
        .array(z.string())
        .describe(
          "Graph node ids to expand. Returns JSONL source records for each found node id and JSONL error records for ids that are missing.",
        ),
      maxOutputTokens: z
        .number()
        .default(1500)
        .describe(
          "Hard output token cap for the emitted JSONL source expansion. Defaults to 1500 and is enforced while records are emitted; overflowing records are dropped instead of exceeding the cap.",
        ),
      maxSourceLines: z
        .number()
        .optional()
        .describe("Caps the source lines included per requested node in the returned JSONL source records."),
    }),
    execute: executor("graph_get", (params, root) => {
      const raw = params.ids;
      const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
      return buildArgs(
        "graph_get",
        root,
        retrievalFlags(params, [
          { param: "maxOutputTokens", flag: "--max-output-tokens" },
          { param: "maxSourceLines", flag: "--max-source-lines" },
        ]),
        ids,
      );
    }),
  };

  const query: OmpToolDefinition = {
    name: "mex_graph_query",
    label: "mex graph query",
    description:
      "Answer structural graph questions. Returns raw JSONL for who-calls, what-calls, or where-defined so an agent can trace relationships without dumping full source first.",
    parameters: z.object({
      projectRoot: projectRoot(),
      relation: z
        .enum(["who-calls", "what-calls", "where-defined"])
        .describe(
          "Structural question to answer. Returns JSONL result records for callers, callees, or defining nodes matching the target.",
        ),
      target: z
        .string()
        .describe(
          "Symbol name or node id to query. Returns JSONL structural matches for the requested relation against this target.",
        ),
      tokenBudget: tokenBudget(),
      maxNodes: z
        .number()
        .optional()
        .describe("Maximum number of related graph nodes to return in the JSONL query results."),
      detail: detail(),
    }),
    execute: executor("graph_query", (params, root) => {
      // ARGUMENT-ORDER TRAP: the CLI query form is `graph --root <dir> query
      // [flags] -- <relation> <target>` (`packages/omp-mex/src/spawn.ts:158-173`).
      // Both positionals are strings, so swapping them still builds argv and then
      // fails at runtime with `{"type":"error","code":"INVALID_QUERY"}`
      // because the relation parser sees the symbol name where the relation should
      // be. Covered by `test/omp-ext-tools.test.ts`.
      return buildArgs(
        "graph_query",
        root,
        retrievalFlags(params, [
          { param: "tokenBudget", flag: "--max-output-tokens" },
          { param: "maxNodes", flag: "--max-nodes" },
          { param: "detail", flag: "--detail" },
        ]),
        [str(params, "relation") ?? "", str(params, "target") ?? ""],
      );
    }),
  };

  const impact: OmpToolDefinition = {
    name: "mex_impact",
    label: "mex impact",
    description:
      "Estimate reverse-dependency blast radius. Returns raw JSONL for defining nodes plus transitive callers, useful before changing a symbol or file path.",
    parameters: z.object({
      projectRoot: projectRoot(),
      target: z
        .string()
        .describe(
          "Symbol name or file path to analyze. Returns JSONL defining nodes plus impacted callers reachable from this target.",
        ),
      tokenBudget: tokenBudget(),
      maxNodes: z
        .number()
        .optional()
        .describe(
          "Maximum number of defining and impacted graph nodes to return in the JSONL blast-radius result.",
        ),
      depth: z
        .number()
        .optional()
        .describe("Maximum reverse-call depth to traverse when computing blast radius in the returned JSONL."),
      detail: detail(),
    }),
    execute: executor("impact", (params, root) =>
      buildArgs(
        "impact",
        root,
        retrievalFlags(params, [
          { param: "tokenBudget", flag: "--max-output-tokens" },
          { param: "maxNodes", flag: "--max-nodes" },
          { param: "depth", flag: "--depth" },
          { param: "detail", flag: "--detail" },
        ]),
        [str(params, "target") ?? ""],
      ),
    ),
  };

  for (const definition of [scope, get, query, impact]) pi.registerTool(definition);
}
