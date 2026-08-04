import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { program } from "../src/cli.js";
import { resolveGraphRoot, runGraphScope } from "../src/graph/cli-agent.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";

const roots: string[] = [];

function fixture(withScaffold = true): { root: string; sourceDir: string } {
  const root = mkdtempSync(join(tmpdir(), withScaffold ? "mex-graph-subdir-" : "mex-graph-subdir-missing-"));
  roots.push(root);
  const sourceDir = join(root, "src");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  if (withScaffold) {
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  }
  writeFileSync(join(sourceDir, "math.ts"), `
export function helper(value: number): number {
  return value + 1;
}

export function total(value: number): number {
  return helper(value);
}
`);
  return { root, sourceDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("graph root resolution from subdirectories", () => {
  it("runs graph scope from a subdirectory when a scaffolded repo root exists", async () => {
    const { root, sourceDir } = fixture();
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    const cwd = process.cwd();
    const output: string[] = [];
    try {
      process.chdir(sourceDir);
      runGraphScope("total", resolveGraphRoot(), { write: (line) => output.push(line) });
    } finally {
      process.chdir(cwd);
    }

    const rows = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.some((row) => row.type === "fact")).toBe(true);
    expect(rows.some((row) => row.code === "GRAPH_UNAVAILABLE")).toBe(false);
  }, 10_000);

  it("keeps the graph-unavailable envelope when no scaffold exists", () => {
    const { sourceDir } = fixture(false);
    const cwd = process.cwd();
    const output: string[] = [];
    let resolved = "";
    try {
      process.chdir(sourceDir);
      expect(() => {
        resolved = resolveGraphRoot();
      }).not.toThrow();
      runGraphScope("total", resolved, { write: (line) => output.push(line) });
    } finally {
      process.chdir(cwd);
    }

    expect(realpathSync(resolved)).toBe(realpathSync(sourceDir));
    expect(JSON.parse(output[0]!)).toMatchObject({ type: "error", code: "GRAPH_UNAVAILABLE" });
  });

  it("lets an explicit root override cwd", async () => {
    const { root } = fixture();
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    const isolated = mkdtempSync(join(tmpdir(), "mex-graph-subdir-cwd-"));
    roots.push(isolated);
    mkdirSync(join(isolated, "elsewhere"), { recursive: true });

    const cwd = process.cwd();
    const output: string[] = [];
    let resolved = "";
    try {
      process.chdir(join(isolated, "elsewhere"));
      resolved = resolveGraphRoot(root);
      runGraphScope("total", resolved, { write: (line) => output.push(line) });
    } finally {
      process.chdir(cwd);
    }

    const rows = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(existsSync(join(resolved, ".mex", "graph.db"))).toBe(true);
    expect(realpathSync(resolved)).toBe(realpathSync(root));
    expect(rows.some((row) => row.type === "fact")).toBe(true);
  }, 10_000);

  // `--root` is declared once, on the parent `graph` command (src/cli.ts:206):
  // commander resolves a parent-known flag even when it trails a subcommand name,
  // so a duplicate declaration on `scope` would silently never be populated.
  // This drives the real commander wiring, which a direct resolveGraphRoot() call
  // cannot cover.
  it("routes --root through the real CLI wiring for both flag positions", async () => {
    const { root } = fixture();
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    const isolated = mkdtempSync(join(tmpdir(), "mex-graph-subdir-flag-"));
    roots.push(isolated);

    for (const argv of [
      ["node", "mex", "graph", "scope", "total", "--root", root],
      ["node", "mex", "graph", "--root", root, "scope", "total"],
      ["node", "mex", "impact", "total", "--root", root],
    ]) {
      const output: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
      const cwd = process.cwd();
      try {
        process.chdir(isolated);
        await program.parseAsync(argv);
      } finally {
        process.chdir(cwd);
        log.mockRestore();
      }
      const rows = output.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows.some((row) => row.code === "GRAPH_UNAVAILABLE"), argv.join(" ")).toBe(false);
      expect(rows.some((row) => row.type === "fact" || row.type === "defines"), argv.join(" ")).toBe(true);
    }
  }, 20_000);
});
