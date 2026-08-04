import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComparisonBase } from "../src/git.js";

// Mock the git helpers BEFORE importing the checker so it picks up the stubs.
vi.mock("../src/git.js", () => ({
  daysSinceLastChange: vi.fn(),
  commitsSinceLastChange: vi.fn(),
  commitsTouchingPaths: vi.fn(),
  DEFAULT_COMMIT_COUNT_MODE: "no-merges",
}));

const {
  daysSinceLastChange,
  commitsSinceLastChange,
  commitsTouchingPaths,
  DEFAULT_COMMIT_COUNT_MODE,
} = await import("../src/git.js");
const {
  checkStaleness,
  DEFAULT_STALENESS_THRESHOLDS,
  STALENESS_COMMIT_COUNT_MODE,
  daysSinceFrontmatterDate,
} = await import("../src/drift/checkers/staleness.js");

const asMock = <T extends (...args: unknown[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

const baseFixture = (overrides: Partial<ComparisonBase> = {}): ComparisonBase => ({
  ref: "origin/main",
  mergeBase: "abc123",
  source: "tracking",
  ahead: 2,
  behind: 7,
  shallow: false,
  note: null,
  ...overrides,
});

beforeEach(() => {
  asMock(daysSinceLastChange).mockReset();
  asMock(commitsSinceLastChange).mockReset();
  asMock(commitsTouchingPaths).mockReset();
});

describe("checkStaleness — defaults", () => {
  it("defaults to 30d warn / 90d error / 50c warn / 200c error", () => {
    expect(DEFAULT_STALENESS_THRESHOLDS).toEqual({
      warnDays: 30,
      errorDays: 90,
      warnCommits: 50,
      errorCommits: 200,
    });
  });

  it("emits no issues when the file is fresh", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(5);
    asMock(commitsSinceLastChange).mockResolvedValue(10);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo");
    expect(issues).toEqual([]);
  });

  it("collapses day + commit warnings into one combined issue at the default thresholds", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(31);
    asMock(commitsSinceLastChange).mockResolvedValue(60);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", code: "STALE_FILE" });
    expect(issues[0].message).toContain("31 days");
    expect(issues[0].message).toContain("60 commits");
  });

  it("collapses day + commit errors into one combined issue at the default thresholds", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(120);
    asMock(commitsSinceLastChange).mockResolvedValue(300);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error" });
    expect(issues[0].message).toContain("threshold: 90d");
    expect(issues[0].message).toContain("threshold: 200");
  });
});

describe("checkStaleness — custom thresholds", () => {
  it("respects a tighter warn threshold (14d)", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(15);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 14,
      errorDays: 30,
      warnCommits: 20,
      errorCommits: 50,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning" });
    expect(issues[0].message).toContain("15 days");
    expect(issues[0].message).toContain("threshold: 14d");
  });

  it("respects a tighter error threshold (30d)", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(45);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 14,
      errorDays: 30,
      warnCommits: 20,
      errorCommits: 50,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error" });
    expect(issues[0].message).toContain("threshold: 30d");
  });

  it("respects tighter commit thresholds", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(25);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 999,
      errorDays: 9999,
      warnCommits: 20,
      errorCommits: 50,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning" });
    expect(issues[0].message).toContain("threshold: 20");
  });

  it("is silent when custom thresholds raise the bar above reality", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(60);
    asMock(commitsSinceLastChange).mockResolvedValue(150);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 90,
      errorDays: 180,
      warnCommits: 200,
      errorCommits: 500,
    });
    expect(issues).toEqual([]);
  });
});

describe("checkStaleness — commit count mode", () => {
  it("pins the staleness commit counting mode to no-merges", () => {
    expect(DEFAULT_COMMIT_COUNT_MODE).toBe("no-merges");
    expect(STALENESS_COMMIT_COUNT_MODE).toBe("no-merges");
  });

  it("passes the default no-merges mode to commitsSinceLastChange", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    await checkStaleness("a.md", "a.md", "/tmp/repo");

    expect(commitsSinceLastChange).toHaveBeenCalledWith("a.md", "/tmp/repo", {
      mode: "no-merges",
    });
  });

  it("lets an explicit all mode override the default", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      mode: "all",
    });

    expect(commitsSinceLastChange).toHaveBeenCalledWith("a.md", "/tmp/repo", {
      mode: "all",
    });
  });
});

describe("checkStaleness — upstream activity signal", () => {
  it("stays inert without upstream inputs", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo");

    expect(issues).toEqual([]);
    expect(commitsTouchingPaths).not.toHaveBeenCalled();
  });

  it("stays inert when claimedPaths are present without a base", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      claimedPaths: ["src/a.ts"],
    });

    expect(issues).toEqual([]);
    expect(commitsTouchingPaths).not.toHaveBeenCalled();
  });

  it("stays inert when the base has no merge base", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      claimedPaths: ["src/a.ts"],
      base: baseFixture({ mergeBase: null }),
    });

    expect(issues).toEqual([]);
    expect(commitsTouchingPaths).not.toHaveBeenCalled();
  });

  it("stays inert when claimedPaths is empty", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      claimedPaths: [],
      base: baseFixture(),
    });

    expect(issues).toEqual([]);
    expect(commitsTouchingPaths).not.toHaveBeenCalled();
  });

  it("adds one warning issue when upstream activity exceeds the warn threshold", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);
    asMock(commitsTouchingPaths).mockResolvedValue(75);

    const base = baseFixture({ ref: "origin/main", mergeBase: "deadbeef" });
    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      claimedPaths: ["src/a.ts", "src/b.ts"],
      base,
    });

    // The range MUST be mergeBase..<upstream ref>, not mergeBase..HEAD.
    // Counting toward HEAD counts OUR OWN commits, which reports 0 for a
    // checkout that is behind upstream — the exact case issue #9 exists for.
    // Verified end to end: a clone 60 commits behind reported 0 until `until`
    // was passed.
    expect(commitsTouchingPaths).toHaveBeenCalledWith(
      ["src/a.ts", "src/b.ts"],
      "deadbeef",
      "/tmp/repo",
      { mode: "no-merges", until: "origin/main" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", code: "STALE_FILE" });
    expect(issues[0].message).toContain("origin/main");
  });

  it("raises upstream activity to an error over the error threshold", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);
    asMock(commitsTouchingPaths).mockResolvedValue(250);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      claimedPaths: ["src/a.ts"],
      base: baseFixture(),
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "STALE_FILE" });
  });

  it("collapses day, commit, and upstream signals into one max-severity issue", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(120);
    asMock(commitsSinceLastChange).mockResolvedValue(300);
    asMock(commitsTouchingPaths).mockResolvedValue(250);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      claimedPaths: ["src/a.ts"],
      base: baseFixture(),
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "STALE_FILE" });
    expect(issues[0].message).toContain("120 days");
    expect(issues[0].message).toContain("300 commits");
    expect(issues[0].message).toContain("origin/main");
    expect(issues[0].message).toContain("; ");
  });

  it("marks shallow upstream counts as a lower bound", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);
    asMock(commitsTouchingPaths).mockResolvedValue(75);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      claimedPaths: ["src/a.ts"],
      base: baseFixture({ shallow: true, note: "count is a lower bound in a shallow clone" }),
    });

    expect(issues).toHaveLength(1);
    // "At least N" is the lower-bound marker; a shallow clone cannot know the
    // true count, so the message must not present 75 as exact.
    expect(issues[0].message).toContain("At least 75");
  });

  it("drops the upstream signal when commitsTouchingPaths fails", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);
    asMock(commitsTouchingPaths).mockResolvedValue(null);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", undefined, {
      claimedPaths: ["src/a.ts"],
      base: baseFixture(),
    });

    expect(issues).toEqual([]);
  });
});

describe("checkStaleness — last_updated frontmatter", () => {
  it("ignores missing or placeholder last_updated values", () => {
    const now = new Date("2026-05-14T12:00:00Z");
    expect(daysSinceFrontmatterDate(undefined, now)).toBeNull();
    expect(daysSinceFrontmatterDate("[YYYY-MM-DD]", now)).toBeNull();
  });

  it("computes days since a concrete frontmatter date", () => {
    const now = new Date("2026-05-14T12:00:00Z");
    expect(daysSinceFrontmatterDate("2026-05-07", now)).toBe(7);
  });

  it("adds last_updated staleness to the combined issue", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 7,
      errorDays: 30,
      warnCommits: 999,
      errorCommits: 9999,
    }, { lastUpdated: "2020-01-01" });

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("last_updated");
  });
});
