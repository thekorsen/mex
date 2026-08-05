import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { DriftIssue, Grounding, ScaffoldFrontmatter } from "../../types.js";
import { deserializeFingerprint, serializeFingerprint } from "../../graph/fingerprint.js";
import type { GraphEngine } from "../../graph/engine.js";
import type { GroundedSource, GroundingChecker } from "../../graph/grounding.js";
import type { Fingerprint, Reconciler } from "../../graph/reconcile.js";
import { findMexAnchors } from "../../markdown.js";

interface GroundingBaseline {
  bodyHash: string;
  fingerprint: string;
}

interface GroundingReconcilerCapabilities {
  getGroundedSource?(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getGroundingBaseline?(scaffoldFile: string, nodeId: string): GroundingBaseline | null;
  getFingerprint?(nodeId: string): Fingerprint | null;
}

export function makeGroundingChecker(
  graph: GraphEngine,
  reconciler: Reconciler,
): GroundingChecker {
  const capabilities = reconciler as Reconciler & GroundingReconcilerCapabilities;

  return function checkGrounding(
    frontmatter: ScaffoldFrontmatter | null,
    filePath: string,
    source: string,
    projectRoot: string,
    _scaffoldRoot: string,
  ): DriftIssue[] {
    const scaffoldFile = relative(projectRoot, filePath).replaceAll("\\", "/");
    const issues: DriftIssue[] = [];

    const driftedNodeIds = new Set<string>();
    const unverifiableNodeIds = new Set<string>();

    for (const grounding of frontmatter?.grounds_to ?? []) {
      if (!isGrounding(grounding)) continue;
      const current = graph.getNode(grounding.node);
      const sidecarBaseline = capabilities.getGroundingBaseline?.(scaffoldFile, grounding.node);
      const groundedSource = sidecarBaseline ? null : (capabilities.getGroundedSource?.(scaffoldFile, grounding.node) ?? null);
      const baseline = sidecarBaseline ?? (groundedSource
        ? { bodyHash: groundedSource.bodyHash, fingerprint: groundedSource.fingerprint }
        : null);
      if (current) {
        if (!baseline) {
          unverifiableNodeIds.add(grounding.node);
          continue;
        }
        if (current.bodyHash !== baseline.bodyHash && !driftedNodeIds.has(grounding.node)) {
          driftedNodeIds.add(grounding.node);
          issues.push(issue("GROUNDING_DRIFT", "warning", source,
            `Grounded node body changed: ${grounding.node}`));
        }
        continue;
      }

      const fingerprint = deserializeFingerprint(grounding.fingerprint)
        ?? (baseline ? deserializeFingerprint(baseline.fingerprint) : null);
      if (!fingerprint) continue;
      const resolution = reconciler.reconcile(grounding.node, fingerprint);
      if (resolution.kind === "MOVED") {
        grounding.node = resolution.nodeId;
        const movedFingerprint = capabilities.getFingerprint?.(resolution.nodeId);
        if (movedFingerprint) grounding.fingerprint = serializeFingerprint(movedFingerprint);
      } else if (resolution.kind === "AMBIGUOUS") {
        issues.push(issue("GROUNDING_AMBIGUOUS", "warning", source,
          `Grounded node may have moved: ${grounding.node}; candidate: ${resolution.candidate}`));
      } else {
        issues.push(issue("GROUNDING_GONE", "error", source,
          `Grounded node no longer exists: ${grounding.node}`));
      }
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      for (const anchor of findMexAnchors(content)) {
        const current = graph.getNode(anchor.nodeId);
        const sidecarBaseline = capabilities.getGroundingBaseline?.(scaffoldFile, anchor.nodeId);
        const groundedSource = sidecarBaseline ? null : (capabilities.getGroundedSource?.(scaffoldFile, anchor.nodeId) ?? null);
        const baseline = sidecarBaseline ?? (groundedSource
          ? { bodyHash: groundedSource.bodyHash, fingerprint: groundedSource.fingerprint }
          : null);
        if (current) {
          if (!baseline) {
            unverifiableNodeIds.add(anchor.nodeId);
            continue;
          }
          if (current.bodyHash !== baseline.bodyHash && !driftedNodeIds.has(anchor.nodeId)) {
            driftedNodeIds.add(anchor.nodeId);
            issues.push(issue("GROUNDING_DRIFT", "warning", source,
              `Grounded node body changed: ${anchor.nodeId}`));
          }
          continue;
        }
        const fingerprint = capabilities.getFingerprint?.(anchor.nodeId)
          ?? (baseline ? deserializeFingerprint(baseline.fingerprint) : null);
        if (!fingerprint) {
          issues.push(issue("GROUNDING_GONE", "warning", source,
            `Inline anchor points to an unavailable node: ${anchor.nodeId}`));
          continue;
        }
        const resolution = reconciler.reconcile(anchor.nodeId, fingerprint);
        if (resolution.kind === "MOVED") {
          issues.push(issue("GROUNDING_DRIFT", "warning", source,
            `Inline anchor should move: ${anchor.nodeId}; candidate: ${resolution.nodeId}`));
        } else if (resolution.kind === "AMBIGUOUS") {
          issues.push(issue("GROUNDING_AMBIGUOUS", "warning", source,
            `Inline anchor may have moved: ${anchor.nodeId}; candidate: ${resolution.candidate}`));
        } else {
          issues.push(issue("GROUNDING_GONE", "warning", source,
            `Inline anchor points to a deleted node: ${anchor.nodeId}`));
        }
      }
    } catch {}

    if (unverifiableNodeIds.size > 0) {
      issues.push(issue(
        "GROUNDING_UNVERIFIABLE",
        "warning",
        source,
        `${unverifiableNodeIds.size} grounded node${unverifiableNodeIds.size === 1 ? "" : "s"} in ${scaffoldFile} ${unverifiableNodeIds.size === 1 ? "is" : "are"} unverifiable; run \`mex graph ground\` and commit \`.mex/grounding.json\`.`,
      ));
    }

    return issues;
  };
}

function isGrounding(value: unknown): value is Grounding {
  if (!value || typeof value !== "object") return false;
  const grounding = value as Partial<Grounding>;
  return typeof grounding.node === "string" && typeof grounding.fingerprint === "string";
}

function issue(
  code: DriftIssue["code"],
  severity: DriftIssue["severity"],
  file: string,
  message: string,
): DriftIssue {
  return { code, severity, file, line: null, message };
}

