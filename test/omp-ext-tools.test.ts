/**
 * Contract tests for the omp extension's tool and command registrars
 * (`packages/omp-mex/src/tools.ts`, `commands.ts`).
 *
 * These drive the registrars with a fake `pi` rather than a live omp session,
 * because the harness ships no test double and no `.d.ts`
 * (`packages/omp-mex/src/omp-api.ts:5-13`). The fake records registrations and
 * hands back the definitions so `execute` can be called directly — one layer in
 * from the approach `test/mcp-graph-tools.test.ts` takes for the MCP server.
 *
 * `pi.zod` is faked too, not imported. The harness injects `zod/v4` and the repo
 * root declares no `zod` dependency (only `packages/mex-mcp/package.json:24`
 * does), so importing the real one here would silently depend on workspace
 * hoisting. The fake records the schema shape, which is all these tests assert.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildWikiIndex } from "../packages/omp-mex/src/router.js";
import { buildArgs } from "../packages/omp-mex/src/spawn.js";
import type * as CommandsModule from "../packages/omp-mex/src/commands.js";
import type * as ToolsModule from "../packages/omp-mex/src/tools.js";
import type { MexScaffold } from "../packages/omp-mex/src/mex.js";
import type {
  OmpCommandContext,
  OmpContext,
  OmpExtensionAPI,
  OmpToolDefinition,
  OmpToolResult,
  OmpZodType,
} from "../packages/omp-mex/src/omp-api.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Why `await import` here rather than a static import — the runtime-availability
 * exception, named explicitly.
 *
 * `packages/omp-mex` reaches mex only through the published entry
 * (`packages/omp-mex/src/mex.ts:17`), which resolves through the `mex-agent`
 * self-symlink to `dist/index.js`. `dist/` is gitignored (`.gitignore:8`) and CI
 * runs `npm run test` *before* `npm run build` (`.github/workflows/ci.yml:27-28`),
 * so on a fresh checkout that module genuinely does not exist yet. A static import
 * would fail at *collection*, taking down the whole file — including the cases
 * that need no build at all. Loading behind an `existsSync` guard turns the
 * shortfall into a loud skip, the same trade `test/mcp-graph-tools.test.ts:21`
 * makes for the built MCP server.
 */
const distBuilt = existsSync(join(repoRoot, "dist", "index.js"));
const tools: typeof ToolsModule | null = distBuilt ? await import("../packages/omp-mex/src/tools.js") : null;
const commands: typeof CommandsModule | null = distBuilt
  ? await import("../packages/omp-mex/src/commands.js")
  : null;
// Static import cannot work here: `mex-agent` resolves through `dist/index.js`,
// which is gitignored and may not exist before the build this file explicitly
// guards (`packages/omp-mex/src/mex.ts:103-110`).
const parseFrontmatter: ((path: string) => Record<string, unknown> | null) | null = distBuilt
  ? ((await import("mex-agent")).parseFrontmatter as (path: string) => Record<string, unknown> | null)
  : null;


const EXPECTED_TOOLS = ["mex_graph_scope", "mex_graph_get", "mex_graph_query", "mex_impact"];

// ── fakes ───────────────────────────────────────────────────────────────────

/** A recorded zod node: what it is, plus the chained modifiers applied to it. */
interface FakeSchema extends OmpZodType {
  kind: string;
  shape?: Record<string, FakeSchema>;
  values?: readonly string[];
  chain: string[];
}

function schema(kind: string, extra: { shape?: Record<string, FakeSchema>; values?: readonly string[] } = {}): FakeSchema {
  const node: FakeSchema = {
    kind,
    chain: [],
    ...extra,
    optional() {
      node.chain.push("optional");
      return node;
    },
    default(value: unknown) {
      node.chain.push(`default:${JSON.stringify(value)}`);
      return node;
    },
    describe(text: string) {
      node.chain.push(`describe:${String(text.length)}`);
      return node;
    },
  };
  return node;
}

/** Every schema this fake produces is a `FakeSchema`, so downcasting reads is sound. */
function asFake(value: OmpZodType | undefined): FakeSchema | undefined {
  return value as FakeSchema | undefined;
}

const fakeZod = {
  z: {
    object: (shape: Record<string, OmpZodType>) => {
      const inner: Record<string, FakeSchema> = {};
      for (const [key, value] of Object.entries(shape)) {
        const fake = asFake(value);
        if (fake !== undefined) inner[key] = fake;
      }
      return schema("object", { shape: inner });
    },
    string: () => schema("string"),
    number: () => schema("number"),
    boolean: () => schema("boolean"),
    array: (inner: OmpZodType) => {
      const fake = asFake(inner);
      return schema("array", fake === undefined ? {} : { shape: { inner: fake } });
    },
    enum: (values: readonly string[]) => schema("enum", { values }),
  },
};

interface FakeCommand {
  description: string;
  handler: (args: string, ctx: OmpCommandContext) => Promise<void> | void;
}

interface FakePi extends OmpExtensionAPI {
  tools: Map<string, OmpToolDefinition>;
  commands: Map<string, FakeCommand>;
}

function makePi(): FakePi {
  const registeredTools = new Map<string, OmpToolDefinition>();
  const registeredCommands = new Map<string, FakeCommand>();
  return {
    tools: registeredTools,
    commands: registeredCommands,
    zod: fakeZod,
    setLabel: () => {},
    on: () => {},
    registerTool: (definition) => {
      registeredTools.set(definition.name, definition);
    },
    registerCommand: (name, definition) => {
      registeredCommands.set(name, definition);
    },
  };
}

/** Records every `ui.notify` so a command's report can be asserted on. */
interface FakeCtx extends OmpCommandContext {
  notifications: Array<{ text: string; level?: string }>;
}

function makeCtx(cwd: string, hasUI = true): FakeCtx {
  const notifications: Array<{ text: string; level?: string }> = [];
  return {
    cwd,
    hasUI,
    notifications,
    ui: {
      notify: (text, level) => notifications.push({ text, level }),
      setStatus: () => {},
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimer: () => {},
    waitForIdle: async () => {},
  };
}

/** Fixed scaffold resolver: both registrars take resolution as a parameter. */
function resolver(scaffold: MexScaffold | null): (cwd: string) => Promise<MexScaffold | null> {
  return async () => scaffold;
}

function scaffoldFor(root: string): MexScaffold {
  return {
    projectRoot: root,
    scaffoldPath: join(root, ".mex"),
    hasGraph: existsSync(join(root, ".mex", "graph.db")),
  };
}

/** Register the tools and return the fake `pi` holding them. */
function withTools(scaffold: MexScaffold | null): FakePi {
  const pi = makePi();
  tools!.registerTools(pi, resolver(scaffold));
  return pi;
}

/** Register the commands and return the fake `pi` holding them. */
function withCommands(scaffold: MexScaffold | null): FakePi {
  const pi = makePi();
  commands!.registerCommands(pi, resolver(scaffold));
  return pi;
}

/** Invoke a registered tool's `execute` with omp's argument order. */
function run(
  pi: FakePi,
  name: string,
  params: Record<string, unknown>,
  ctx: OmpContext,
  signal?: AbortSignal,
): Promise<OmpToolResult> {
  const tool = pi.tools.get(name);
  if (tool === undefined) throw new Error(`tool ${name} was not registered`);
  return tool.execute("call-1", params, signal, undefined, ctx);
}

function textOf(result: OmpToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

/** The single notification a command emitted. Fails loudly if it emitted none. */
function onlyNotification(ctx: FakeCtx): { text: string; level?: string } {
  expect(ctx.notifications).toHaveLength(1);
  return ctx.notifications[0]!;
}

// ── fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-omp-ext-tools-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A project root `findConfig` accepts: `.git` plus a complete `.mex/` scaffold. */
function scaffoldProject(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# router\n");
}

function localFrontmatter(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;

  const out: Record<string, unknown> = {};
  const edges: Array<Record<string, string>> = [];
  let currentEdge: Record<string, string> | null = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (/^\s*-\s+target:\s+/.test(rawLine)) {
      currentEdge = { target: rawLine.replace(/^\s*-\s+target:\s+/, "") };
      edges.push(currentEdge);
      continue;
    }
    if (/^\s+condition:\s+/.test(rawLine) && currentEdge !== null) {
      currentEdge.condition = rawLine.replace(/^\s+condition:\s+/, "");
      continue;
    }
    const field = /^([A-Za-z0-9_-]+):\s+(.*)$/.exec(rawLine);
    if (!field) continue;
    const [, key, rawValue] = field;
    if (key === "edges") continue;
    try {
      out[key] = JSON.parse(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  if (edges.length > 0) out.edges = edges;
  return out;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!distBuilt)("registerTools", () => {
  it("registers exactly the four graph tools, every name mex_-prefixed — omp dedups tools first-wins by name across providers, so an unprefixed name would silently lose to, or shadow, another extension's", () => {
    const pi = withTools(null);

    expect([...pi.tools.keys()].sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const name of pi.tools.keys()) expect(name.startsWith("mex_")).toBe(true);
  });

  it("mirrors the MCP tools' parameter names so the model learns one shape per operation instead of two divergent ones", () => {
    const pi = withTools(null);
    const shapeOf = (name: string): string[] =>
      Object.keys(asFake(pi.tools.get(name)?.parameters)?.shape ?? {}).sort();

    // Compare against packages/mex-mcp/src/tools/graph.ts:54-75,88-104,117-137,150-171.
    expect(shapeOf("mex_graph_scope")).toEqual(
      ["detail", "maxNodes", "maxSourceLines", "projectRoot", "task", "tokenBudget"].sort(),
    );
    expect(shapeOf("mex_graph_get")).toEqual(["ids", "maxOutputTokens", "maxSourceLines", "projectRoot"].sort());
    expect(shapeOf("mex_graph_query")).toEqual(
      ["detail", "maxNodes", "projectRoot", "relation", "target", "tokenBudget"].sort(),
    );
    expect(shapeOf("mex_impact")).toEqual(
      ["depth", "detail", "maxNodes", "projectRoot", "target", "tokenBudget"].sort(),
    );
  });

  it("defaults the output token cap to 1500 on every operation, matching the MCP default so the same call is portable between the two channels", () => {
    const pi = withTools(null);
    const field = (tool: string, name: string): FakeSchema | undefined =>
      asFake(pi.tools.get(tool)?.parameters)?.shape?.[name];

    for (const [tool, name] of [
      ["mex_graph_scope", "tokenBudget"],
      ["mex_graph_get", "maxOutputTokens"],
      ["mex_graph_query", "tokenBudget"],
      ["mex_impact", "tokenBudget"],
    ] as const) {
      expect(field(tool, name)?.chain).toContain("default:1500");
    }
  });

  it("constrains relation to the three the query engine accepts, so an unsupported value is rejected at the schema instead of surfacing as INVALID_QUERY JSONL", () => {
    const pi = withTools(null);
    const relation = asFake(pi.tools.get("mex_graph_query")?.parameters)?.shape?.relation;

    // Guard list lives at src/graph/cli-agent.ts:132.
    expect(relation?.values).toEqual(["who-calls", "what-calls", "where-defined"]);
  });
});

describe("buildArgs", () => {
  it("puts graph --root before the subcommand, keeps flags before --, and leaves positionals after -- for scope/query/get", () => {
    expect(
      buildArgs(
        "graph_scope",
        "/repo",
        [["--max-nodes", "5"], ["--detail", "source"], ["--max-output-tokens", "200"]],
        ["fix login"],
      ),
    ).toEqual([
      "graph",
      "--root",
      "/repo",
      "scope",
      "--max-nodes",
      "5",
      "--detail",
      "source",
      "--max-output-tokens",
      "200",
      "--",
      "fix login",
    ]);

    expect(
      buildArgs(
        "graph_query",
        "/repo",
        [["--max-nodes", "3"], ["--detail", "minimal"]],
        ["who-calls", "targetFn"],
      ),
    ).toEqual([
      "graph",
      "--root",
      "/repo",
      "query",
      "--max-nodes",
      "3",
      "--detail",
      "minimal",
      "--",
      "who-calls",
      "targetFn",
    ]);

    expect(
      buildArgs(
        "graph_get",
        "/repo",
        [["--max-source-lines", "25"], ["--max-output-tokens", "1500"]],
        ["node:1", "node:2"],
      ),
    ).toEqual([
      "graph",
      "--root",
      "/repo",
      "get",
      "--max-source-lines",
      "25",
      "--max-output-tokens",
      "1500",
      "--",
      "node:1",
      "node:2",
    ]);
  });

  it("puts impact's own --root after the top-level command name, because impact is not a graph subcommand", () => {
    expect(
      buildArgs(
        "impact",
        "/repo",
        [["--depth", "2"], ["--max-output-tokens", "400"]],
        ["src/foo.ts"],
      ),
    ).toEqual(["impact", "--root", "/repo", "--depth", "2", "--max-output-tokens", "400", "--", "src/foo.ts"]);
  });

  it("keeps a leading-dash task after -- so it survives as a positional instead of being parsed as an option", () => {
    expect(buildArgs("graph_scope", "/repo", [["--max-nodes", "1"]], ["-oh no"])).toEqual([
      "graph",
      "--root",
      "/repo",
      "scope",
      "--max-nodes",
      "1",
      "--",
      "-oh no",
    ]);
  });

  it("maps both tokenBudget-style and maxOutputTokens-style callers onto --max-output-tokens, keeps query positionals in relation-target order, omits absent flags, and stringifies numbers", () => {
    expect(
      buildArgs(
        "graph_query",
        "/repo",
        [["--detail", undefined], ["--max-nodes", String(7)], ["--max-output-tokens", String(900)]],
        ["where-defined", "runDriftCheck"],
      ),
    ).toEqual([
      "graph",
      "--root",
      "/repo",
      "query",
      "--max-nodes",
      "7",
      "--max-output-tokens",
      "900",
      "--",
      "where-defined",
      "runDriftCheck",
    ]);

    expect(
      buildArgs(
        "graph_get",
        "/repo",
        [["--max-output-tokens", String(250)], ["--max-source-lines", undefined]],
        ["node:1"],
      ),
    ).toEqual(["graph", "--root", "/repo", "get", "--max-output-tokens", "250", "--", "node:1"]);
  });
});

describe.skipIf(!distBuilt)("graph retrieval tool results", () => {
  // Both failure shapes are asserted against the exported shaping functions rather
  // than through `execute`. Reaching them for real requires either an unbuilt
  // `dist/cli.js` or a genuinely failing `spawnSync` — neither of which a hermetic
  // unit test should manufacture, and both of which would otherwise make these
  // cases pass for the wrong reason on a machine where the CLI happens to be built.
  it("returns a non-throwing actionable result when the mex CLI is not built, because a fresh checkout is an ordinary state and the model needs the next step rather than a crash", () => {
    const result = tools?.noCliResult("graph_scope", tmpDir);

    expect(result?.isError).toBeUndefined();
    expect(textOf(result!)).toContain("npm run build");
    expect(result?.details).toMatchObject({ errorCode: "CLI_UNBUILT", projectRoot: tmpDir });
  });

  it("marks a retrieval runner failure as isError true, so an ENOENT/timeout/non-zero exit is surfaced as a real tool failure instead of ordinary GRAPH_UNAVAILABLE guidance", () => {
    const result = tools?.toolFailedResult("graph_query", tmpDir, "spawn node ENOENT");

    expect(result?.isError).toBe(true);
    expect(textOf(result!)).toContain("failed");
    expect(textOf(result!)).toContain("spawn node ENOENT");
    expect(result?.details).toMatchObject({ errorCode: "TOOL_FAILED", projectRoot: tmpDir });
  });

  it("returns a non-error result carrying GRAPH_UNAVAILABLE plus a run-`mex graph` hint instead of throwing — a missing graph is a project state the model must act on, not a tool malfunction it should retry", async () => {
    scaffoldProject(tmpDir);
    const pi = withTools(scaffoldFor(tmpDir));

    const result = await run(pi, "mex_graph_scope", { task: "anything", tokenBudget: 500 }, makeCtx(tmpDir));

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("GRAPH_UNAVAILABLE");
    expect(textOf(result)).toContain("mex graph");
  });

  it("still answers without throwing when the resolver returns null, so a session started outside any mex project degrades rather than erroring", async () => {
    const pi = withTools(null);

    const result = await run(pi, "mex_impact", { target: "foo" }, makeCtx(tmpDir));

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("GRAPH_UNAVAILABLE");
  });

  it("lets retrieval's own guard answer when an explicit projectRoot points somewhere other than the session's project — short-circuiting on this session's scaffold would report a different tree's answer", async () => {
    scaffoldProject(tmpDir);
    const pi = withTools(scaffoldFor(repoRoot));

    const result = await run(
      pi,
      "mex_graph_scope",
      { task: "anything", projectRoot: tmpDir },
      makeCtx(repoRoot),
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("GRAPH_UNAVAILABLE");
    expect(result.details).toMatchObject({ projectRoot: tmpDir, graphAvailable: false });
  });

  it("returns early without running retrieval when the signal is already aborted", async () => {
    const pi = withTools(scaffoldFor(repoRoot));

    const result = await run(pi, "mex_graph_scope", { task: "x" }, makeCtx(repoRoot), AbortSignal.abort());

    expect(result.details).toMatchObject({ errorCode: "ABORTED" });
  });
});


describe.skipIf(!distBuilt)("buildWikiIndex", () => {
  it("uses parseFrontmatter to recover ROUTER edges and page descriptions, so command routing still reads the same frontmatter semantics mex itself does", () => {
    scaffoldProject(tmpDir);
    writeFileSync(
      join(tmpDir, ".mex", "ROUTER.md"),
      [
        "---",
        "edges:",
        "  - target: context/conventions.md",
        "    condition: when writing new code",
        "---",
        "# router",
        "",
      ].join("\n"),
    );
    mkdirSync(join(tmpDir, ".mex", "context"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".mex", "context", "conventions.md"),
      ["---", 'description: "house style"', "---", "", "Use two-space indent."].join("\n"),
    );

    const pages = buildWikiIndex(scaffoldFor(tmpDir), parseFrontmatter ?? localFrontmatter);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      relPath: "context/conventions.md",
      condition: "when writing new code",
      description: "house style",
    });
  });
});

describe.skipIf(!distBuilt)("mex_graph_scope renderResult", () => {
  it("renders a compact record-count summary rather than raw JSONL, and points at `mex graph` when no graph was reachable", () => {
    const pi = withTools(null);
    const render = pi.tools.get("mex_graph_scope")?.renderResult;
    expect(render).toBeTypeOf("function");

    expect(
      render!({
        operation: "graph_scope",
        projectRoot: "/x",
        graphAvailable: true,
        recordCounts: { meta: 1, fact: 7, summary: 1 },
      }),
    ).toBe("mex graph_scope: 7 fact (budgeted JSONL)");

    expect(
      render!({
        operation: "graph_scope",
        projectRoot: "/x",
        graphAvailable: false,
        recordCounts: { error: 1 },
        errorCode: "GRAPH_UNAVAILABLE",
      }),
    ).toContain("mex graph");
  });

  it("returns undefined instead of throwing on details it cannot understand — details round-trips through session persistence, so the renderer must never assume its shape", () => {
    const pi = withTools(null);
    const render = pi.tools.get("mex_graph_scope")!.renderResult!;

    for (const bad of [undefined, null, "text", 42, {}, { operation: 7 }]) {
      expect(render(bad)).toBeUndefined();
    }
  });
});

describe.skipIf(!distBuilt)("registerCommands", () => {
  it("registers the three commands only code can provide — two compute a value, and mex-graph-impact is here because a package's sibling commands/*.md is not discovered by omp", () => {
    const pi = withCommands(null);

    expect([...pi.commands.keys()].sort()).toEqual(["mex-context", "mex-drift", "mex-graph-impact"]);
  });

  it("passes a mex-graph-impact target through as a tool argument rather than a shell line, because omp substitutes command arguments textually and a quote or backtick in the target would otherwise inject into an assembled command", () => {
    const pi = withCommands(null);
    const emitted: string[] = [];
    const ctx = { cwd: "/repo", hasUI: false, waitForIdle: async () => {} };
    const log = console.log;
    console.log = (line: string) => emitted.push(String(line));
    try {
      void pi.commands.get("mex-graph-impact")!.handler(`weird"'\`$(x)`, ctx as never);
    } finally {
      console.log = log;
    }

    const text = emitted.join("\n");
    // JSON-quoted as data on the tool-argument line, never interpolated into a
    // `mex impact '...'` shell invocation.
    expect(text).toContain(`mex_impact { target: ${JSON.stringify(`weird"'\`$(x)`)}`);
    expect(text).not.toMatch(/mex impact ['"`]/);
  });

  it("asks for a target instead of running an empty impact query, which would burn the budget resolving nothing", () => {
    const pi = withCommands(null);
    const emitted: string[] = [];
    const ctx = { cwd: "/repo", hasUI: false, waitForIdle: async () => {} };
    const log = console.log;
    console.log = (line: string) => emitted.push(String(line));
    try {
      void pi.commands.get("mex-graph-impact")!.handler("   ", ctx as never);
    } finally {
      console.log = log;
    }

    expect(emitted.join("\n")).toContain("Usage: /mex-graph-impact");
  });

  it("never registers mex-check, mex-graph-scope, or mex-sync — those ship as declarative artifacts from templates/omp/commands/, and omp dedups commands first-wins by name, so a code copy would add no capability and create a silent load-order shadowing race", () => {
    const pi = withCommands(null);

    for (const name of commands!.DECLARATIVE_COMMANDS) expect(pi.commands.has(name)).toBe(false);
    // Guard the guard: an empty list would make the assertion above vacuous.
    expect(commands!.DECLARATIVE_COMMANDS).toEqual(["mex-check", "mex-graph-scope", "mex-sync"]);
  });

  it("reports a missing wiki as a warning through the UI instead of throwing, because a throwing command handler surfaces as a bare extension error with no recovery path for the user", async () => {
    const pi = withCommands(null);
    const ctx = makeCtx(tmpDir);

    await pi.commands.get("mex-context")!.handler("some task", ctx);

    const note = onlyNotification(ctx);
    expect(note.level).toBe("warn");
    expect(note.text).toContain("mex setup");
  });

  it("prints usage rather than routing an empty task, so /mex-context with no argument is not silently a no-op", async () => {
    const pi = withCommands(scaffoldFor(tmpDir));
    const ctx = makeCtx(tmpDir);

    await pi.commands.get("mex-context")!.handler("   ", ctx);

    expect(onlyNotification(ctx).text).toContain("Usage:");
  });

  it("reports the routed pages and the dump-vs-routed comparison, which is the only figure a user can audit to justify routing instead of dumping the whole wiki", async () => {
    scaffoldProject(tmpDir);
    writeFileSync(
      join(tmpDir, ".mex", "ROUTER.md"),
      [
        "---",
        "edges:",
        "  - target: context/conventions.md",
        "    condition: when writing new code or unsure about project patterns",
        "  - target: context/stack.md",
        "    condition: when working with specific technologies or libraries",
        "---",
        "# router",
        "",
      ].join("\n"),
    );
    mkdirSync(join(tmpDir, ".mex", "context"), { recursive: true });
    writeFileSync(join(tmpDir, ".mex", "context", "conventions.md"), "# conventions\n\nUse two-space indent.\n");
    writeFileSync(join(tmpDir, ".mex", "context", "stack.md"), "# stack\n\nNode and TypeScript.\n");

    const pi = withCommands(scaffoldFor(tmpDir));
    const ctx = makeCtx(tmpDir);

    await pi.commands.get("mex-context")!.handler("writing new code conventions", ctx);

    const note = onlyNotification(ctx);
    expect(note.level).toBe("info");
    expect(note.text).toContain("context/conventions.md");
    expect(note.text).toContain("full-dump cost");
    expect(note.text).toMatch(/budget: \d+\/\d+ tokens/);
  });

  it("reports a drift score for a real scaffold without throwing, proving in-process runDriftCheck needs neither a subprocess nor a built CLI", async () => {
    scaffoldProject(tmpDir);
    const pi = withCommands(scaffoldFor(tmpDir));
    const ctx = makeCtx(tmpDir);

    await pi.commands.get("mex-drift")!.handler("", ctx);

    const note = onlyNotification(ctx);
    expect(note.text).toMatch(/^mex drift: score \d+\/100/);
    expect(note.level).not.toBe("error");
  });

  it("captures runDriftCheck's graph nudge into the report instead of letting it reach the terminal — it defaults to console.warn (src/drift/index.ts:90,95,101), which in-process would detach the note from the report it belongs to", async () => {
    scaffoldProject(tmpDir);
    const pi = withCommands(scaffoldFor(tmpDir));
    const ctx = makeCtx(tmpDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await pi.commands.get("mex-drift")!.handler("", ctx);

    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to stdout when there is no UI, because ui.notify is a no-op in print mode and the user who typed the command would otherwise get a blank response", async () => {
    const pi = withCommands(null);
    const ctx = makeCtx(tmpDir, false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await pi.commands.get("mex-context")!.handler("some task", ctx);

    expect(ctx.notifications).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
