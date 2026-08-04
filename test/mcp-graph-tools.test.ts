/**
 * Protocol-level test for the graph retrieval tools exposed over MCP (issue #10).
 *
 * Speaks JSON-RPC 2.0 to the BUILT server over raw stdio rather than importing
 * the registration functions, because the contract wave-2 callers rely on is the
 * wire shape — advertised tool names, which inputs are required, and the fact
 * that graph JSONL arrives as text content instead of corrupting stdout.
 *
 * `packages/mex-mcp/dist/index.js` is a gitignored build artifact, so the suite
 * skips itself (loudly) rather than failing on a fresh checkout.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(repoRoot, "packages", "mex-mcp", "dist", "index.js");
const serverBuilt = existsSync(serverPath);

const EXPECTED_TOOLS = [
  "mex_check",
  "mex_graph_get",
  "mex_graph_query",
  "mex_graph_scope",
  "mex_heartbeat",
  "mex_impact",
  "mex_log",
  "mex_read_file",
  "mex_timeline",
];

const GRAPH_TOOLS = ["mex_graph_scope", "mex_graph_get", "mex_graph_query", "mex_impact"];

interface JsonRpcResponse {
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

interface ToolDefinition {
  name: string;
  inputSchema: { properties: Record<string, unknown>; required?: string[] };
}

interface McpClient {
  child: ChildProcessWithoutNullStreams;
  request: (method: string, params: unknown) => Promise<JsonRpcResponse>;
  notify: (method: string, params: unknown) => void;
}

/**
 * Minimal hand-rolled MCP client: newline-delimited JSON both ways, responses
 * correlated by `id`. A stdout chunk can split a message mid-line, so partial
 * lines are buffered until a newline arrives. Hangs are bounded by the suite
 * timeout, and premature child exit rejects immediately with captured stderr —
 * no polling and no guessed delays.
 */
function startServer(): McpClient {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, MEX_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  let stdoutBuffer = "";
  let stderrText = "";

  child.stderr.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    let newline: number;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line === "") continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  child.on("exit", (code, signal) => {
    const error = new Error(`mex-mcp server exited (code ${code}, signal ${signal}). stderr: ${stderrText}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  let nextId = 0;
  const send = (payload: unknown): void => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    child,
    request: (method, params) =>
      new Promise<JsonRpcResponse>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      }),
    notify: (method, params) => {
      send({ jsonrpc: "2.0", method, params });
    },
  };
}

/**
 * A project root `findConfig` accepts: `.git` locates the root (src/config.ts:95)
 * and `.mex/ROUTER.md` proves the scaffold is complete (src/config.ts:68-70).
 * Deliberately has no `.mex/graph.db`, so graph calls take the unavailable path.
 */
function makeScaffold(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".mex"));
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  return root;
}

function textOf(response: JsonRpcResponse): string {
  const content = response.result?.content;
  expect(Array.isArray(content)).toBe(true);
  expect(content![0].type).toBe("text");
  return content![0].text;
}

const suite = serverBuilt ? describe : describe.skip;

suite(
  "mex-mcp graph tools over stdio JSON-RPC",
  () => {
    if (!serverBuilt) {
      it("needs the mex-mcp build — run: npm run build --workspace mex-mcp", () => {
        expect(serverBuilt).toBe(true);
      });
      return;
    }

    const server = startServer();
    const tempRoots: string[] = [];
    let handshake: Promise<ToolDefinition[]> | null = null;

    afterAll(() => {
      server.child.kill("SIGKILL");
      for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    });

    /** Initialize once, then reuse the advertised tool list — the server is long-lived by design. */
    function listTools(): Promise<ToolDefinition[]> {
      handshake ??= (async () => {
        await server.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mex-mcp-graph-tools-test", version: "0.0.0" },
        });
        server.notify("notifications/initialized", {});
        const listed = await server.request("tools/list", {});
        return (listed.result as { tools: ToolDefinition[] }).tools;
      })();
      return handshake;
    }

    function schemaFor(tools: ToolDefinition[], name: string): ToolDefinition["inputSchema"] {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `${name} is not advertised`).toBeDefined();
      return tool!.inputSchema;
    }

    it("advertises the four graph tools alongside the original five", async () => {
      const tools = await listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    });

    it("takes projectRoot on every graph tool and never requires it", async () => {
      const tools = await listTools();
      for (const name of GRAPH_TOOLS) {
        const schema = schemaFor(tools, name);
        expect(Object.keys(schema.properties), name).toContain("projectRoot");
        expect(schema.required ?? [], name).not.toContain("projectRoot");
      }
    });

    it("exposes an optional tokenBudget on mex_graph_scope, leaving task the only requirement", async () => {
      const tools = await listTools();
      const schema = schemaFor(tools, "mex_graph_scope");
      expect(Object.keys(schema.properties)).toContain("tokenBudget");
      // Wave-2 callers send only task + projectRoot + tokenBudget.
      expect(schema.required ?? []).toEqual(["task"]);
    });

    it("reports a missing graph as structured GRAPH_UNAVAILABLE, not a stack trace", async () => {
      const root = makeScaffold("mex-mcp-nograph-");
      tempRoots.push(root);
      const response = await server.request("tools/call", {
        name: "mex_graph_scope",
        arguments: { projectRoot: root, task: "authentication flow", tokenBudget: 400 },
      });
      const text = textOf(response);
      expect(text).not.toContain("    at ");
      expect(JSON.parse(text)).toMatchObject({ type: "error", code: "GRAPH_UNAVAILABLE" });
    });

    it("streams schema-versioned JSONL for a real graph and honours the token budget", async () => {
      const response = await server.request("tools/call", {
        name: "mex_graph_scope",
        arguments: { projectRoot: repoRoot, task: "drift check scoring", tokenBudget: 400 },
      });
      const text = textOf(response);
      expect(text).not.toContain("    at ");
      const records = text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

      // This repo only has .mex/graph.db once `mex graph` has run, and the graph
      // engine needs node:sqlite (Node 22.5+). Either outcome is a valid contract.
      if (records.length === 1 && records[0].type === "error") {
        expect(records[0]).toMatchObject({ code: "GRAPH_UNAVAILABLE" });
        return;
      }

      expect(records[0]).toMatchObject({
        type: "meta",
        schemaVersion: 1,
        command: "graph scope",
        task: "drift check scoring",
        maxOutputTokens: 400,
      });
      expect(records.some((record) => record.type === "fact")).toBe(true);

      const summary = records[records.length - 1];
      expect(summary).toMatchObject({ type: "summary", maxOutputTokens: 400 });
      // The budget is enforced while emitting, so the reported estimate must sit
      // under the requested ceiling and a dropped candidate must be declared.
      expect(summary.estimatedOutputTokens as number).toBeLessThanOrEqual(400);
      expect(summary.returnedNodes as number).toBeLessThanOrEqual(summary.matchedNodes as number);
      if ((summary.returnedNodes as number) < (summary.matchedNodes as number)) {
        expect(summary.truncated).toBe(true);
      }
    });

    it("rejects an unknown query relation instead of running it", async () => {
      const root = makeScaffold("mex-mcp-badrelation-");
      tempRoots.push(root);
      const response = await server.request("tools/call", {
        name: "mex_graph_query",
        arguments: { projectRoot: root, relation: "who-imports", target: "runDriftCheck" },
      });
      // The SDK turns the input-validation McpError into an isError content block
      // rather than a JSON-RPC error (@modelcontextprotocol/sdk server/mcp.js:135-161).
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).toBe(true);
      const text = textOf(response);
      expect(text).toContain("relation");
      // Not a graph stream: the JSONL parser must not accept this body.
      expect(() => JSON.parse(text)).toThrow();
    });

    it("accepts each valid query relation", async () => {
      const root = makeScaffold("mex-mcp-relations-");
      tempRoots.push(root);
      for (const relation of ["who-calls", "what-calls", "where-defined"]) {
        const response = await server.request("tools/call", {
          name: "mex_graph_query",
          arguments: { projectRoot: root, relation, target: "runDriftCheck" },
        });
        expect(response.result?.isError, relation).toBeUndefined();
        // The fixture has no graph, so the contract here is that validation passed
        // and the graph layer degraded structurally rather than throwing.
        expect(JSON.parse(textOf(response)), relation).toMatchObject({
          type: "error",
          code: "GRAPH_UNAVAILABLE",
        });
      }
    });
  },
  60_000,
);
