import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  findConfig,
  runGraphGet,
  runGraphQuery,
  runGraphScope,
  runImpact,
} from "mex-agent";

const detailSchema = z
  .enum(["minimal", "standard", "source"])
  .optional()
  .describe(
    "Controls how much graph detail the returned JSONL includes: minimal facts (default), standard facts plus structural edges, or source excerpts when they fit the budget."
  );

/** A single text content block, the shape every tool in this package returns. */
type TextResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Resolve the project root, then run a graph command with its JSONL stream
 * captured. Mirrors the `findConfig` error envelope used by the other tools.
 */
function withGraphContent(
  projectRoot: string | undefined,
  run: (rootDir: string, write: (line: string) => void) => void,
): TextResult {
  const root = projectRoot ?? process.cwd();
  let config;
  try {
    config = findConfig(root);
  } catch (e) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: (e as Error).message, projectRoot: root }),
        },
      ],
    };
  }
  // Capture the JSONL stream: these commands default `write` to console.log,
  // and on a stdio server stdout is the JSON-RPC channel.
  const lines: string[] = [];
  run(config.projectRoot, (line) => lines.push(line));
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export function registerGraphScopeTool(server: McpServer) {
  server.tool(
    "mex_graph_scope",
    "Entry point for graph retrieval. Returns scored JSONL symbol neighborhoods for a task under a hard token budget, so an agent can identify relevant code before expanding source.",
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
      task: z
        .string()
        .describe("Natural-language task to scope. Returns scored JSONL facts for the most relevant symbols and, at higher detail levels, structural edges or source that fit the budget."),
      tokenBudget: z
        .number()
        .default(1500)
        .describe("Hard output token cap for the emitted JSONL. Defaults to 1500 and is enforced while records are emitted; overflowing records are dropped instead of exceeding the cap."),
      maxNodes: z
        .number()
        .optional()
        .describe("Maximum number of graph nodes to return in the scoped JSONL neighborhood for the task."),
      detail: detailSchema,
      maxSourceLines: z
        .number()
        .optional()
        .describe("When detail is source, caps the source lines included per returned node in the JSONL output."),
    },
    async ({ projectRoot, task, tokenBudget, maxNodes, detail, maxSourceLines }) => {
      return withGraphContent(projectRoot, (rootDir, write) => {
        runGraphScope(task, rootDir, { write }, { maxOutputTokens: tokenBudget, maxNodes, detail, maxSourceLines });
      });
    }
  );
}

export function registerGraphGetTool(server: McpServer) {
  server.tool(
    "mex_graph_get",
    "Expand specific graph node ids to source. Returns raw JSONL source records for known node ids after scope/query/impact identifies what to inspect.",
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
      ids: z
        .array(z.string())
        .describe("Graph node ids to expand. Returns JSONL source records for each found node id and JSONL error records for ids that are missing."),
      maxOutputTokens: z
        .number()
        .default(1500)
        .describe("Hard output token cap for the emitted JSONL source expansion. Defaults to 1500 and is enforced while records are emitted; overflowing records are dropped instead of exceeding the cap."),
      maxSourceLines: z
        .number()
        .optional()
        .describe("Caps the source lines included per requested node in the returned JSONL source records."),
    },
    async ({ projectRoot, ids, maxOutputTokens, maxSourceLines }) => {
      return withGraphContent(projectRoot, (rootDir, write) => {
        runGraphGet(ids, rootDir, { write }, { maxOutputTokens, maxSourceLines });
      });
    }
  );
}

export function registerGraphQueryTool(server: McpServer) {
  server.tool(
    "mex_graph_query",
    "Answer structural graph questions. Returns raw JSONL for who-calls, what-calls, or where-defined so an agent can trace relationships without dumping full source first.",
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
      relation: z
        .enum(["who-calls", "what-calls", "where-defined"])
        .describe("Structural question to answer. Returns JSONL result records for callers, callees, or defining nodes matching the target."),
      target: z
        .string()
        .describe("Symbol name or node id to query. Returns JSONL structural matches for the requested relation against this target."),
      tokenBudget: z
        .number()
        .default(1500)
        .describe("Hard output token cap for the emitted JSONL. Defaults to 1500 and is enforced while records are emitted; overflowing records are dropped instead of exceeding the cap."),
      maxNodes: z
        .number()
        .optional()
        .describe("Maximum number of related graph nodes to return in the JSONL query results."),
      detail: detailSchema,
    },
    async ({ projectRoot, relation, target, tokenBudget, maxNodes, detail }) => {
      return withGraphContent(projectRoot, (rootDir, write) => {
        runGraphQuery(relation, target, rootDir, { write }, { maxOutputTokens: tokenBudget, maxNodes, detail });
      });
    }
  );
}

export function registerImpactTool(server: McpServer) {
  server.tool(
    "mex_impact",
    "Estimate reverse-dependency blast radius. Returns raw JSONL for defining nodes plus transitive callers, useful before changing a symbol or file path.",
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
      target: z
        .string()
        .describe("Symbol name or file path to analyze. Returns JSONL defining nodes plus impacted callers reachable from this target."),
      tokenBudget: z
        .number()
        .default(1500)
        .describe("Hard output token cap for the emitted JSONL. Defaults to 1500 and is enforced while records are emitted; overflowing records are dropped instead of exceeding the cap."),
      maxNodes: z
        .number()
        .optional()
        .describe("Maximum number of defining and impacted graph nodes to return in the JSONL blast-radius result."),
      depth: z
        .number()
        .optional()
        .describe("Maximum reverse-call depth to traverse when computing blast radius in the returned JSONL."),
      detail: detailSchema,
    },
    async ({ projectRoot, target, tokenBudget, maxNodes, depth, detail }) => {
      return withGraphContent(projectRoot, (rootDir, write) => {
        runImpact(target, rootDir, { write }, { maxOutputTokens: tokenBudget, maxNodes, depth, detail });
      });
    }
  );
}
