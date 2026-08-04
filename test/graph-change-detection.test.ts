import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../src/graph/db/sqlite.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { findChangedSourceFiles } from "../src/graph/runtime.js";

const roots: string[] = [];

function fixture(prefix = "mex-graph-change-"): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  const source = join(root, "src", "service.ts");
  writeFileSync(source, "export function version(): number {\n  return 1;\n}\n");
  return { root, source };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("graph change detection", () => {
  it("treats content-identical files with new mtimes as unchanged", async () => {
    const { root, source } = fixture();
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    const now = new Date();
    const shifted = new Date(now.getTime() + 60_000);
    utimesSync(source, shifted, now);

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(findChangedSourceFiles(root, db)).toEqual([]);
    } finally {
      db.close();
    }
  }, 10_000);

  it("detects same-size content edits when mtimes move", async () => {
    const { root, source } = fixture();
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    const edited = readFileSync(source, "utf-8").replace("return 1;", "return 2;");
    writeFileSync(source, edited);

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(findChangedSourceFiles(root, db)).toEqual(["src/service.ts"]);
    } finally {
      db.close();
    }
  }, 10_000);

  it("treats a copied graph database in a second checkout of identical content as unchanged", async () => {
    const { root: rootA } = fixture("mex-graph-change-a-");
    const engine = createGraphEngine({ rootDir: rootA });
    await engine.build();
    engine.close();

    const rootB = mkdtempSync(join(tmpdir(), "mex-graph-change-b-"));
    roots.push(rootB);
    cpSync(rootA, rootB, { recursive: true });
    writeFileSync(join(rootB, "src", "service.ts"), readFileSync(join(rootA, "src", "service.ts"), "utf-8"));
    copyFileSync(join(rootA, ".mex", "graph.db"), join(rootB, ".mex", "graph.db"));

    const db = openSqlite(join(rootB, ".mex", "graph.db"));
    try {
      expect(findChangedSourceFiles(rootB, db)).toEqual([]);
    } finally {
      db.close();
    }
  }, 10_000);

  it("still reports added and deleted tracked source files", async () => {
    const { root, source } = fixture();
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    writeFileSync(join(root, "src", "added.ts"), "export const added = 1;\n");
    unlinkSync(source);

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(findChangedSourceFiles(root, db)).toEqual(["src/added.ts", "src/service.ts"]);
    } finally {
      db.close();
    }
  }, 10_000);
});
