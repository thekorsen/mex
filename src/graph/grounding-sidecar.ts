import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GroundingBaseline {
  scaffoldFile: string;
  nodeId: string;
  bodyHash: string;
  fingerprint: string;
}
/**
 * The committed baseline sidecar — the half of grounding that survives a clone.
 *
 * Anchors (`grounds_to` + inline `mex://`) are committed inside `.mex/**.md`, but
 * the baseline they are compared against lived only in `_mex_grounded_source`
 * inside `.mex/graph.db`, which is gitignored (`.gitignore:21`, an UPSTREAM rule
 * — commit `9952db4`). So `GROUNDING_DRIFT` could never fire on a checkout that
 * had not itself run the grounding pass (`src/drift/checkers/grounding.ts:36`).
 *
 * This file is the fix: a small, text-diffable, committed mirror of the one
 * column the drift comparison actually needs. It is meaningful across machines
 * only because node ids are content-independent and path-derived
 * (`src/graph/extraction/node-id.ts:29-38`) and because `graph.db` is now
 * content-addressed rather than mtime-addressed (issue #6,
 * `src/graph/runtime.ts:97-101`).
 *
 * It deliberately does NOT carry node source text. `bodyHash` is what the
 * checker compares; `source` exists only to render an old-vs-new diff for
 * `mex sync` (`src/graph/runtime.ts:270-286`). Committing bodies would duplicate
 * the codebase into the wiki and conflict on every concurrent body change. The
 * old body stays recoverable from this file's own git history.
 */
export const GROUNDING_SIDECAR_FILE = "grounding.json";

/** Bump only for a breaking shape change; unknown versions are ignored, not merged. */
export const GROUNDING_SIDECAR_VERSION = 1;

/**
 * Absolute path of the sidecar. Named because the read path, the write path,
 * `mex graph ground`'s operator message, and the tests must all agree on it.
 */
export function groundingSidecarPath(scaffoldRoot: string): string {
  return resolve(scaffoldRoot, GROUNDING_SIDECAR_FILE);
}

/**
 * Composite lookup key. Grounding is keyed by (scaffold_file, node_id) — the
 * same primary key the table uses (`src/graph/schema.sql:242`) — because one
 * node may be grounded by several pages, each with its own baseline.
 */
export function groundingBaselineKey(scaffoldFile: string, nodeId: string): string {
  return `${scaffoldFile}\u0000${nodeId}`;
}

/**
 * Read the committed baselines, keyed by {@link groundingBaselineKey}.
 *
 * Degrades to an empty map on a missing, unreadable, malformed, or
 * future-versioned file. That is deliberate and safe in the honest direction:
 * an unusable sidecar yields no baselines, and no baseline now produces a
 * visible `GROUNDING_UNVERIFIABLE` rather than a silent clean check.
 */
export function readGroundingSidecar(scaffoldRoot: string): Map<string, GroundingBaseline> {
  const baselines = new Map<string, GroundingBaseline>();
  const path = groundingSidecarPath(scaffoldRoot);
  if (!existsSync(path)) return baselines;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return baselines;
  }
  if (!parsed || typeof parsed !== "object") return baselines;
  const { version, baselines: rows } = parsed as { version?: unknown; baselines?: unknown };
  if (version !== GROUNDING_SIDECAR_VERSION || !Array.isArray(rows)) return baselines;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { scaffoldFile, nodeId, bodyHash, fingerprint } = row as Record<string, unknown>;
    if (
      typeof scaffoldFile !== "string" || typeof nodeId !== "string"
      || typeof bodyHash !== "string" || typeof fingerprint !== "string"
      || !scaffoldFile || !nodeId || !bodyHash
    ) continue;
    baselines.set(groundingBaselineKey(scaffoldFile, nodeId), {
      scaffoldFile, nodeId, bodyHash, fingerprint,
    });
  }
  return baselines;
}

/**
 * Write the sidecar, sorted by (scaffoldFile, nodeId) so the file is a stable
 * text diff and two developers grounding different pages do not reorder each
 * other's lines. Returns whether bytes changed: an unchanged capture must not
 * churn the working tree, because this file is tracked.
 */
export function writeGroundingSidecar(
  scaffoldRoot: string,
  baselines: Iterable<GroundingBaseline>,
): boolean {
  const rows = [...baselines].sort((left, right) =>
    left.scaffoldFile.localeCompare(right.scaffoldFile) || left.nodeId.localeCompare(right.nodeId));
  const path = groundingSidecarPath(scaffoldRoot);
  const serialized = JSON.stringify({
    version: GROUNDING_SIDECAR_VERSION,
    baselines: rows,
  }, null, 2) + "\n";
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf-8") === serialized) return false;
    } catch {
      // Unreadable but present: fall through and overwrite with a valid file.
    }
  } else if (rows.length === 0) {
    return false;
  }
  writeFileSync(path, serialized, "utf-8");
  return true;
}
