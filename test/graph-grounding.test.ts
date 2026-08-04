import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createFingerprint,
  deserializeFingerprint,
  serializeFingerprint,
} from "../src/graph/fingerprint.js";
import { FingerprintStore } from "../src/graph/fingerprint-store.js";
import { createGroundingChecker } from "../src/graph/grounding.js";
import { MinHashReconciler } from "../src/graph/reconcile-engine.js";
import type { Fingerprint, Reconciler } from "../src/graph/reconcile.js";
import type { GraphEngine } from "../src/graph/engine.js";
import type { GraphNode } from "../src/graph/types.js";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../src/graph/schema.sql", import.meta.url), "utf8"));
  return db;
}

function insertNode(db: DatabaseSync, id: string, bodyHash = "hash"): void {
  db.prepare(
    `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, body_hash, updated_at)
     VALUES (?, 'function', ?, ?, 'src/a.ts', 'typescript', 1, 2, 0, 1, ?, 1)`,
  ).run(id, id, id, bodyHash);
}

function fingerprint(matches: number, neighbors: string[] = ["neighbor"], tokenCount = 40): Fingerprint {
  return {
    minhash: Array.from({ length: 64 }, (_, index) => index < matches ? index : 10_000 + index),
    neighbors,
    tokenCount,
  };
}

describe("fingerprinting", () => {
  it("is deterministic and includes a sorted, unique neighborhood", () => {
    const left = createFingerprint(["function", "name", "(", ")", "return", "value"], ["b", "a"], ["a", "c"]);
    const right = createFingerprint(["function", "name", "(", ")", "return", "value"], ["b", "a"], ["a", "c"]);
    expect(left).toEqual(right);
    expect(left.minhash).toHaveLength(64);
    expect(left.neighbors).toEqual(["a", "b", "c"]);
    expect(left.tokenCount).toBe(6);
  });

  it("round-trips the complete baseline through mh:K:hex", () => {
    const original = fingerprint(64);
    const serialized = serializeFingerprint(original);
    expect(serialized).toMatch(/^mh:64:[0-9a-f]+$/);
    expect(deserializeFingerprint(serialized)).toEqual(original);
    expect(deserializeFingerprint("mh:63:00")).toBeNull();
  });
});

describe("FingerprintStore and MinHashReconciler", () => {
  it("stores fingerprints and finds candidates sharing an LSH band", () => {
    const db = database();
    insertNode(db, "candidate");
    const store = new FingerprintStore(db);
    const value = fingerprint(64);
    store.upsert("candidate", value);
    expect(store.get("candidate")).toEqual(value);
    expect(store.lookup(value).map((entry) => entry.nodeId)).toEqual(["candidate"]);
    db.close();
  });

  it("returns GONE for an untrusted small-token baseline", () => {
    const db = database();
    insertNode(db, "candidate");
    const store = new FingerprintStore(db);
    store.upsert("candidate", fingerprint(64));
    expect(new MinHashReconciler(store).reconcile("missing", fingerprint(64, ["neighbor"], 2))).toEqual({ kind: "GONE" });
    db.close();
  });

  it("returns MOVED for a high-scoring candidate", () => {
    const db = database();
    insertNode(db, "moved");
    const store = new FingerprintStore(db);
    store.upsert("moved", fingerprint(64));
    expect(new MinHashReconciler(store).reconcile("missing", fingerprint(64))).toEqual({ kind: "MOVED", nodeId: "moved" });
    db.close();
  });

  it("returns AMBIGUOUS for a mid-scoring candidate", () => {
    const db = database();
    insertNode(db, "candidate");
    const store = new FingerprintStore(db);
    const baseline = fingerprint(64);
    store.upsert("candidate", fingerprint(40));
    expect(new MinHashReconciler(store).reconcile("missing", baseline)).toEqual({ kind: "AMBIGUOUS", candidate: "candidate" });
    db.close();
  });

  it("returns GONE when a band match scores below LO", () => {
    const db = database();
    insertNode(db, "different");
    const store = new FingerprintStore(db);
    store.upsert("different", fingerprint(2, ["other"]));
    expect(new MinHashReconciler(store).reconcile("missing", fingerprint(64))).toEqual({ kind: "GONE" });
    db.close();
  });
});

function node(id: string, bodyHash: string): GraphNode {
  return {
    id, bodyHash, kind: "function", name: id, qualifiedName: id,
    filePath: "src/a.ts", language: "typescript", startLine: 1, endLine: 2,
    startColumn: 0, endColumn: 1, updatedAt: 1,
  };
}

function graph(nodes: GraphNode[]): GraphEngine {
  return {
    build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
    sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
    searchNodes: () => [],
    getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
    getCallers: () => [], getCallees: () => [], close: () => {},
  };
}

type ReconcileResolution =
  | { kind: "MOVED"; nodeId: string }
  | { kind: "AMBIGUOUS"; candidate: string }
  | { kind: "GONE" };

describe("grounding checker", () => {
  it("is clean for an unchanged DB baseline hit and warns when its body hash moves", () => {
    const db = database();
    const store = new FingerprintStore(db);
    const baseline = fingerprint(64);
    store.saveGroundedSource({
      scaffoldFile: ".mex/context.md", nodeId: "current", source: "old",
      bodyHash: "old-hash", fingerprint: serializeFingerprint(baseline),
    });
    const reconciler = new MinHashReconciler(store);
    const fm = { grounds_to: [{ node: "current", fingerprint: serializeFingerprint(baseline) }] };
    expect(createGroundingChecker(graph([node("current", "old-hash")]), reconciler)(fm, "/repo/.mex/context.md", "context.md", "/repo", "/repo/.mex")).toEqual([]);
    const issues = createGroundingChecker(graph([node("current", "new-hash")]), reconciler)(fm, "/repo/.mex/context.md", "context.md", "/repo", "/repo/.mex");
    expect(issues).toMatchObject([{ code: "GROUNDING_DRIFT", severity: "warning" }]);
    db.close();
  });

  it("prefers sidecar-like baselines for body drift and deduplicates repeated current-node drift", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-anchor-check-"));
    const mexRoot = join(root, ".mex");
    const file = join(mexRoot, "context.md");
    const baseline = fingerprint(64);
    const fm = { grounds_to: [{ node: "current", fingerprint: serializeFingerprint(fingerprint(12)) }] };
    const reconciler = {
      reconcile: () => ({ kind: "GONE" as const }),
      getGroundedSource: () => ({
        scaffoldFile: ".mex/context.md",
        nodeId: "current",
        source: "old",
        bodyHash: "db-hash",
        fingerprint: serializeFingerprint(fingerprint(24)),
      }),
      getGroundingBaseline: () => ({ bodyHash: "sidecar-hash", fingerprint: serializeFingerprint(baseline) }),
    };
    try {
      mkdirSync(mexRoot, { recursive: true });
      writeFileSync(file, "[`symbol()`](mex://current)\n");
      expect(createGroundingChecker(graph([node("current", "sidecar-hash")]), reconciler)(fm, file, "context.md", root, mexRoot)).toEqual([]);
      expect(createGroundingChecker(graph([node("current", "changed-hash")]), reconciler)(fm, file, "context.md", root, mexRoot)).toMatchObject([
        { code: "GROUNDING_DRIFT", severity: "warning", message: "Grounded node body changed: current" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports GONE and AMBIGUOUS, and silently rebinds MOVED", () => {
    const baseline = fingerprint(64);
    const grounding = { node: "missing", fingerprint: serializeFingerprint(baseline) };
    const check = (reconciler: Reconciler) => createGroundingChecker(graph([]), reconciler)(
      { grounds_to: [grounding] }, "/repo/.mex/context.md", "context.md", "/repo", "/repo/.mex",
    );
    expect(check({ reconcile: () => ({ kind: "GONE" }) })).toMatchObject([{ code: "GROUNDING_GONE", severity: "error" }]);
    expect(check({ reconcile: () => ({ kind: "AMBIGUOUS", candidate: "maybe" }) })).toMatchObject([{ code: "GROUNDING_AMBIGUOUS", severity: "warning" }]);
    expect(check({ reconcile: () => ({ kind: "MOVED", nodeId: "new-id" }) })).toEqual([]);
    expect(grounding.node).toBe("new-id");
  });

  it("aggregates missing baselines once per distinct current node across frontmatter and inline anchors", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-anchor-check-"));
    const mexRoot = join(root, ".mex");
    const file = join(mexRoot, "context.md");
    const current = node("function:missing", "hash");
    const other = node("function:other", "hash-2");
    const fm = {
      grounds_to: [
        { node: "function:missing", fingerprint: serializeFingerprint(fingerprint(64)) },
        { node: "function:other", fingerprint: serializeFingerprint(fingerprint(32)) },
      ],
    };
    const reconciler = {
      reconcile: () => ({ kind: "GONE" as const }),
      getGroundingBaseline: (_scaffoldFile: string, nodeId: string) => (nodeId === "function:other"
        ? { bodyHash: "hash-2", fingerprint: serializeFingerprint(fingerprint(32)) }
        : null),
    };
    try {
      mkdirSync(mexRoot, { recursive: true });
      writeFileSync(file, "[`symbol()`](mex://function:missing)\n[`other()`](mex://function:other)\n");
      const issues = createGroundingChecker(graph([current, other]), reconciler)(fm, file, "context.md", root, mexRoot);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: "GROUNDING_UNVERIFIABLE", severity: "warning" });
      expect(issues[0]!.message).toContain("1 grounded node");
      expect(issues[0]!.message).toContain(".mex/context.md");
      expect(issues[0]!.message).toContain("run `mex graph ground` and commit `.mex/grounding.json`");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still emits aggregated unverifiable warnings when the scaffold file cannot be read", () => {
    const fm = {
      grounds_to: [{ node: "current", fingerprint: serializeFingerprint(fingerprint(64)) }],
    };
    const issues = createGroundingChecker(graph([node("current", "hash")]), { reconcile: () => ({ kind: "GONE" as const }) })(
      fm,
      "/repo/.mex/missing.md",
      "context.md",
      "/repo",
      "/repo/.mex",
    );
    expect(issues).toMatchObject([
      { code: "GROUNDING_UNVERIFIABLE", severity: "warning" },
    ]);
  });

  it("handles inline anchor hit, MOVED, GONE, and AMBIGUOUS as warning-only navigation drift", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-anchor-check-"));
    const file = join(root, "context.md");
    const baseline = fingerprint(64);
    const check = (
      nodes: GraphNode[],
      resolution: ReconcileResolution,
      getGroundingBaseline?: (scaffoldFile: string, nodeId: string) => { bodyHash: string; fingerprint: string } | null,
    ) => {
      writeFileSync(file, "[`symbol()`](mex://function:old)\n");
      const reconciler = {
        reconcile: () => resolution,
        getFingerprint: () => baseline,
        getGroundingBaseline,
      };
      return createGroundingChecker(graph(nodes), reconciler)(null, file, "context.md", root, root);
    };
    try {
      expect(check([node("function:old", "hash")], { kind: "GONE" }, () => ({ bodyHash: "hash", fingerprint: serializeFingerprint(baseline) }))).toEqual([]);
      expect(check([], { kind: "MOVED", nodeId: "function:new" })).toMatchObject([{
        code: "GROUNDING_DRIFT", severity: "warning", message: expect.stringContaining("candidate: function:new"),
      }]);
      expect(check([], { kind: "GONE" })).toMatchObject([{ code: "GROUNDING_GONE", severity: "warning" }]);
      expect(check([], { kind: "AMBIGUOUS", candidate: "function:maybe" })).toMatchObject([{
        code: "GROUNDING_AMBIGUOUS", severity: "warning", message: expect.stringContaining("function:maybe"),
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
