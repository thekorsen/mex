import { describe, it, expect, vi } from "vitest";
import { buildVerboseLog } from "../src/drift/index.js";
import { reportJSON, countBySeverity, CHECK_JSON_CONTRACT_VERSION } from "../src/reporter.js";
import type { Claim, DriftIssue, DriftReport, Severity } from "../src/types.js";

function makeClaim(kind: Claim["kind"]): Claim {
  return {
    kind,
    value: "test-value",
    file: "test.md",
    line: 1,
    raw: "test raw",
  };
}

function makeIssue(severity: Severity): DriftIssue {
  return {
    code: "MISSING_PATH",
    severity,
    file: "test.md",
    line: 1,
    message: `a ${severity}`,
  };
}

function makeReport(opts?: { verboseLog?: string[]; issues?: DriftIssue[] }): DriftReport {
  return {
    score: 85,
    issues: opts?.issues ?? [],
    filesChecked: 3,
    timestamp: "2026-04-10T00:00:00.000Z",
    verboseLog: opts?.verboseLog,
  };
}

/** Capture the single JSON document `reportJSON` writes to stdout. */
function emit(report: DriftReport, opts?: { verbose?: boolean }): Record<string, unknown> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    reportJSON(report, opts);
    return JSON.parse(spy.mock.calls[0][0]) as Record<string, unknown>;
  } finally {
    spy.mockRestore();
  }
}

describe("buildVerboseLog", () => {
  it("returns file count and claim breakdown", () => {
    const claims: Claim[] = [
      makeClaim("path"),
      makeClaim("path"),
      makeClaim("command"),
      makeClaim("dependency"),
    ];
    const checkerCounts: Array<[string, number]> = [
      ["path", 1],
      ["edges", 0],
    ];

    const log = buildVerboseLog(5, claims, checkerCounts);

    expect(log[0]).toBe("Scaffold files scanned: 5");
    expect(log[1]).toContain("Claims extracted: 4");
    expect(log[1]).toContain("path: 2");
    expect(log[1]).toContain("command: 1");
    expect(log[1]).toContain("dependency: 1");
    expect(log[2]).toBe("Checker path: 1 issue");
    expect(log[3]).toBe("Checker edges: 0 issues");
  });

  it("handles empty claims and checkers", () => {
    const log = buildVerboseLog(0, [], []);
    expect(log).toHaveLength(2);
    expect(log[0]).toBe("Scaffold files scanned: 0");
    expect(log[1]).toContain("Claims extracted: 0");
  });
});

describe("reportJSON verbose gating", () => {
  it("excludes verboseLog from JSON when verbose is off", () => {
    const report = makeReport({ verboseLog: ["line1", "line2"] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    reportJSON(report);

    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.verboseLog).toBeUndefined();
    spy.mockRestore();
  });

  it("includes verboseLog in JSON when verbose is on", () => {
    const report = makeReport({ verboseLog: ["line1", "line2"] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    reportJSON(report, { verbose: true });

    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.verboseLog).toEqual(["line1", "line2"]);
    spy.mockRestore();
  });
});

describe("reportJSON machine contract (mex check --json)", () => {
  it("reports exact counts for a mixed set of issues", () => {
    const issues = [
      makeIssue("error"),
      makeIssue("warning"),
      makeIssue("warning"),
      makeIssue("info"),
    ];

    const output = emit(makeReport({ issues }));

    expect(output.counts).toEqual({ error: 1, warning: 2, info: 1 });
  });

  it("zero-fills all three counts when there are no issues", () => {
    // The point of `counts`: a gate reads `.counts.error` unconditionally.
    // An absent key or an omitted zero would make `jq '.counts.error > 0'`
    // silently null-compare instead of failing the build.
    const output = emit(makeReport({ issues: [] }));

    expect(output.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it("emits contractVersion as the exported constant", () => {
    const output = emit(makeReport());

    expect(output.contractVersion).toBe(CHECK_JSON_CONTRACT_VERSION);
  });

  it("keeps the four original fields intact (backward compatibility)", () => {
    const issues = [makeIssue("error")];
    const report = makeReport({ issues });

    const output = emit(report);

    expect(output.score).toBe(85);
    expect(output.issues).toEqual(issues);
    expect(output.filesChecked).toBe(3);
    expect(output.timestamp).toBe("2026-04-10T00:00:00.000Z");
  });
});

describe("countBySeverity", () => {
  it("returns every severity key with zero for an empty list", () => {
    expect(countBySeverity([])).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it("tallies each severity independently", () => {
    const counts = countBySeverity([
      makeIssue("info"),
      makeIssue("info"),
      makeIssue("info"),
      makeIssue("error"),
    ]);

    expect(counts).toEqual({ error: 1, warning: 0, info: 3 });
  });
});
