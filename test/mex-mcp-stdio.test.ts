import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The built server. Gitignored build artifact: `npm run build --workspace mex-mcp`
// produces it, and `npm test` may legitimately run before that build (or on a
// clean checkout). Paths are relative to the repo root — vitest's cwd.
const SERVER = join("packages", "mex-mcp", "dist", "index.js");

// The tools the server advertises today (`CHANGELOG.md:48`). Asserted as a
// SUBSET, not an exact set: more tools are being added (graph retrieval over
// MCP is issue #10), and an exact-equality assertion would turn every future
// tool registration into a failure in this unrelated file. The contract worth
// defending is "these five are still advertised", not "only these exist".
const TOOLS_TODAY = ["mex_check", "mex_log", "mex_timeline", "mex_heartbeat", "mex_read_file"];

const HANDSHAKE_TIMEOUT_MS = 30_000;

interface JsonRpcResponse {
  id: number;
  result?: unknown;
}

interface ServerInfo {
  name?: unknown;
  version?: unknown;
}

interface InitializeResult {
  protocolVersion?: unknown;
  capabilities?: { tools?: unknown };
  serverInfo?: ServerInfo;
}

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolsListResult {
  tools?: ToolDescriptor[];
}

interface ToolCallResult {
  content?: { type?: string; text?: string }[];
}

/** Narrow a parsed stdout line to a JSON-RPC response we can index by id. */
function asResponse(value: unknown): JsonRpcResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("id" in value) || typeof value.id !== "number") return undefined;
  return value as JsonRpcResponse;
}

const children: ChildProcess[] = [];

afterEach(() => {
  // Always reap, even on assertion failure or timeout — a surviving stdio
  // server holds an open pipe and would wedge the rest of the suite.
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/**
 * Send newline-delimited JSON-RPC messages to the built server on stdin and
 * resolve once a response has arrived for every id in `awaitIds`. Responses are
 * matched by `id` rather than by arrival order, since nothing guarantees the
 * server answers in request order.
 */
async function rpc(messages: unknown[], awaitIds: number[]): Promise<Map<number, JsonRpcResponse>> {
  const child = spawn("node", [SERVER], {
    cwd: process.cwd(),
    env: { ...process.env, MEX_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) throw new Error("spawn did not provide stdio pipes");

  const { promise, resolve, reject } = Promise.withResolvers<Map<number, JsonRpcResponse>>();
  // Responses accumulate at runtime keyed by a numeric id, so Map over Record.
  const responses = new Map<number, JsonRpcResponse>();
  let pending = "";
  let errorOutput = "";

  // Real timer, deliberately: this is a watchdog on a spawned child process, not
  // a delay tuned to mask a race. Fake timers cannot bound how long an external
  // process takes to answer, and without this bound a hung server would burn the
  // whole suite timeout with no diagnostic.
  const timer = setTimeout(() => {
    settle(
      new Error(
        `no response for ids [${awaitIds}] within ${HANDSHAKE_TIMEOUT_MS}ms; stderr: ${errorOutput}`
      )
    );
  }, HANDSHAKE_TIMEOUT_MS);

  function settle(error?: Error) {
    clearTimeout(timer);
    child.kill("SIGKILL");
    if (error) reject(error);
    else resolve(responses);
  }

  stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });

  stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    // Framing is newline-delimited JSON; the trailing fragment may be partial.
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        settle(new Error(`non-JSON line on stdout: ${line}`));
        return;
      }
      const response = asResponse(parsed);
      if (response) responses.set(response.id, response);
    }
    if (awaitIds.every((id) => responses.has(id))) settle();
  });

  child.on("error", (e: Error) => settle(e));
  child.on("exit", (code) => {
    if (!awaitIds.every((id) => responses.has(id))) {
      settle(new Error(`server exited with code ${code} before responding; stderr: ${errorOutput}`));
    }
  });

  stdin.write(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  return promise;
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mex-stdio-test", version: "0" },
  },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };

// Skip, do not fail, when the server has not been built: `packages/mex-mcp/dist/`
// is gitignored, so a clean checkout running `npm test` before
// `npm run build --workspace mex-mcp` has nothing to drive. A red suite on a
// fresh clone is a worse signal than an explicitly skipped protocol test.
describe.skipIf(!existsSync(SERVER))("mex-mcp over stdio", () => {
  it("completes the initialize handshake and identifies itself", async () => {
    const responses = await rpc([initialize, initialized], [1]);
    const result = responses.get(1)?.result as InitializeResult | undefined;
    expect(result?.serverInfo?.name, "serverInfo.name").toBe("mex-mcp");
    expect(typeof result?.serverInfo?.version, "serverInfo.version is a string").toBe("string");
    expect(result?.protocolVersion, "protocolVersion echoed").toBeTruthy();
    expect(result?.capabilities?.tools, "server advertises the tools capability").toBeTruthy();
  });

  it("advertises today's tool set with usable input schemas", async () => {
    const responses = await rpc(
      [initialize, initialized, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
      [1, 2]
    );
    const tools = (responses.get(2)?.result as ToolsListResult | undefined)?.tools;
    expect(Array.isArray(tools), "tools/list returns an array").toBe(true);

    const names = tools?.map((t) => t.name);
    expect(names, "today's tools are still advertised").toEqual(expect.arrayContaining(TOOLS_TODAY));

    for (const name of TOOLS_TODAY) {
      const tool = tools?.find((t) => t.name === name);
      expect(tool?.description, `${name} has a description`).toBeTruthy();
      expect(tool?.inputSchema?.type, `${name} input schema is an object schema`).toBe("object");
      // Every tool accepts an optional projectRoot (`CHANGELOG.md:48`).
      expect(Object.keys(tool?.inputSchema?.properties ?? {}), `${name} accepts projectRoot`).toContain(
        "projectRoot"
      );
    }

    // `file` is the one required parameter across the whole surface
    // (`packages/mex-mcp/src/tools/read-file.ts:16-19`).
    const readFile = tools?.find((t) => t.name === "mex_read_file");
    expect(readFile?.inputSchema?.required, "mex_read_file requires file").toContain("file");
  });

  it("returns a drift report shape from mex_check", async () => {
    const call = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "mex_check", arguments: {} },
    };
    const responses = await rpc([initialize, initialized, call], [1, 2]);
    const content = (responses.get(2)?.result as ToolCallResult | undefined)?.content;
    expect(content?.[0]?.type, "result is a text content block").toBe("text");
    const report: unknown = JSON.parse(content?.[0]?.text ?? "null");
    // Shape only. The score is environment-dependent — it moves whenever the
    // wiki drifts from the code, so asserting `94` would make this test a
    // tripwire for unrelated documentation edits.
    expect(report).toMatchObject({
      score: expect.any(Number),
      issues: expect.any(Array),
      filesChecked: expect.any(Number),
    });
  });
});
