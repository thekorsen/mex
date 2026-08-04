/**
 * Issue #11 acceptance test: the long-lived MCP server serves many project roots
 * from ONE process, so nothing that varies per root may live in a process-global.
 *
 * Driven in-process against the real functions rather than over stdio, because
 * process-global leakage is only observable when two roots share one process —
 * which is exactly what a spawned-per-call test would hide.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createConfig, runDriftCheck, type MexConfig, type RunDriftCheckOpts } from "../src/index.js";
import { getGit } from "../src/git.js";

const GRAPH_UPGRADE_NUDGE = /A code graph unlocks sharper drift detection/;

const tempRoots: string[] = [];

/**
 * A scaffold that reaches the grounding-nudge branch. `runDriftCheck` only tries
 * to load the grounding runtime when a scaffold file is a populated grounding
 * candidate (src/drift/index.ts:81, :200-210): it must live under `context/` or
 * `patterns/`, be non-empty, and carry no `[YYYY-MM-DD]` template placeholder.
 * `.git` lets git-backed checkers resolve a root (src/config.ts:95).
 */
function makeProject(label: string): { root: string; config: MexConfig } {
  const root = mkdtempSync(join(tmpdir(), `mex-isolation-${label}-`));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, ".mex", "context", "stack.md"), `# Stack\n\n${label} is a TypeScript service.\n`);
  tempRoots.push(root);
  return { root, config: createConfig({ projectRoot: root, scaffoldRoot: join(root, ".mex") }) };
}

/** Force the "no graph runtime" branch and capture the nudge instead of writing to the console. */
function collectingOpts(sink: string[]): RunDriftCheckOpts {
  return {
    groundingRuntimeLoader: async () => null,
    graphWarning: (message) => sink.push(message),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("project-root isolation across one long-lived process", () => {
  it("nudges every project root, not just the first one checked", async () => {
    const a = makeProject("a");
    const b = makeProject("b");

    const warningsA: string[] = [];
    await runDriftCheck(a.config, collectingOpts(warningsA));
    const warningsB: string[] = [];
    await runDriftCheck(b.config, collectingOpts(warningsB));

    // A process-global "already nudged" boolean would leave warningsB empty.
    expect(warningsA.filter((message) => GRAPH_UPGRADE_NUDGE.test(message))).toHaveLength(1);
    expect(warningsB.filter((message) => GRAPH_UPGRADE_NUDGE.test(message))).toHaveLength(1);
  });

  it("still nudges a given root only once, so the fix is per-root and not a removed guard", async () => {
    const a = makeProject("once");

    const first: string[] = [];
    await runDriftCheck(a.config, collectingOpts(first));
    const second: string[] = [];
    await runDriftCheck(a.config, collectingOpts(second));

    expect(first.filter((message) => GRAPH_UPGRADE_NUDGE.test(message))).toHaveLength(1);
    expect(second.filter((message) => GRAPH_UPGRADE_NUDGE.test(message))).toHaveLength(0);
  });

  it("keeps two roots' drift reports independent", async () => {
    const a = makeProject("report-a");
    const b = makeProject("report-b");
    writeFileSync(join(a.root, ".mex", "ROUTER.md"), "# Router\n\nSee `src/only/in/a.ts`.\n");

    const reportA = await runDriftCheck(a.config, collectingOpts([]));
    const reportB = await runDriftCheck(b.config, collectingOpts([]));

    const missingIn = (issues: typeof reportA.issues): string[] =>
      issues.filter((issue) => issue.code === "MISSING_PATH").map((issue) => issue.message);
    expect(missingIn(reportA.issues).join(" ")).toContain("src/only/in/a.ts");
    expect(missingIn(reportB.issues)).toHaveLength(0);
  });
});

describe("git handles are keyed per repository root", () => {
  it("hands each root its own handle and reuses one handle per root", () => {
    const a = makeProject("git-a");
    const b = makeProject("git-b");

    // A shared singleton would pin root A's repository for every later caller.
    expect(getGit(a.root)).not.toBe(getGit(b.root));
    // But it must still be a cache, not a fresh handle per call.
    expect(getGit(a.root)).toBe(getGit(a.root));
    expect(getGit(b.root)).toBe(getGit(b.root));
  });
});
