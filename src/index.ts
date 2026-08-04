/**
 * Public API for `mex-agent`.
 *
 * Everything re-exported from this file is part of the package's compatibility
 * contract. See COMPATIBILITY.md at the repo root for the versioning policy
 * and what counts as a breaking change.
 *
 * Internal modules (`src/cli.ts`, `src/sync/`, `src/scanner/`, `src/setup/`,
 * `src/tui.ts`, `src/watch.ts`, `src/doctor.ts`, etc.) are NOT part of the
 * contract and may change without notice. Import only from `"mex-agent"`.
 */

// ── Config ───────────────────────────────────────────────────────────────────
export { findConfig, createConfig, getScaffoldIdentity } from "./config.js";
export type { CreateConfigInput } from "./config.js";

// ── Events (append-only JSONL log) ───────────────────────────────────────────
export {
  appendEvent,
  readEvents,
  eventLogPath,
  EVENT_KINDS,
} from "./events.js";
export type { EventEntry, EventKind, LogOpts } from "./events.js";

// ── Drift detection ──────────────────────────────────────────────────────────
export {
  runDriftCheck,
  DEFAULT_SCAFFOLD_PATTERNS,
} from "./drift/index.js";
export type { RunDriftCheckOpts } from "./drift/index.js";
export { parseFrontmatter } from "./drift/frontmatter.js";
export { DEFAULT_STALENESS_THRESHOLDS } from "./drift/checkers/staleness.js";

// ── Graph retrieval (agent-facing, budgeted JSONL) ───────────────────────────
// Deliberately promoted for `mex-mcp` (issue #10): the MCP server is a separate
// package and can only reach `mex-agent` through this entry point, so retrieval
// had to become public or be lost. The surface is the four retrieval operations
// plus the seams needed to call them off-process: `AgentCommandDeps.write`
// captures the JSONL stream instead of `console.log`. The emitted record shapes
// and `schemaVersion` are part of the contract; the graph internals that produce
// them (`src/graph/**`) are not. See COMPATIBILITY.md.
export {
  runGraphScope,
  runGraphGet,
  runGraphQuery,
  runImpact,
} from "./graph/cli-agent.js";
export type { AgentCommandDeps } from "./graph/cli-agent.js";
export { DEFAULT_OPTIONS as DEFAULT_RETRIEVAL_OPTIONS } from "./graph/agent-protocol.js";
export type { AgentOptions } from "./graph/agent-protocol.js";
export type { DetailLevel } from "./graph/scope.js";

// ── Heartbeat (scaffold staleness + memory cleanup) ──────────────────────────
export {
  checkHeartbeat,
  runHeartbeat,
  DEFAULT_HEARTBEAT_PATTERNS,
} from "./heartbeat.js";
export type {
  HeartbeatResult,
  HeartbeatOpts,
  CheckHeartbeatOpts,
} from "./heartbeat.js";

// ── Shared types ─────────────────────────────────────────────────────────────
export type {
  AiTool,
  MexConfig,
  ScaffoldIdentity,
  StalenessThresholds,
  WatchConfig,
  HeartbeatConfig,
  ScaffoldFrontmatter,
  FrontmatterEdge,
  DriftReport,
  DriftIssue,
  IssueCode,
  Severity,
  Claim,
  ClaimKind,
} from "./types.js";
