import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Mock cross-spawn so we can drive the exact SpawnSyncReturns shapes that
// `runToolInteractive` must map to a boolean, without launching anything.
vi.mock("cross-spawn", () => ({
  default: { sync: vi.fn() },
}));

import crossSpawn from "cross-spawn";
import { runToolInteractive } from "../src/sync/index.js";

const mockSync = crossSpawn.sync as unknown as ReturnType<typeof vi.fn>;

describe("runToolInteractive return-value logic", () => {
  beforeEach(() => {
    mockSync.mockReset();
  });

  it("treats a clean exit (status 0) as success", () => {
    mockSync.mockReturnValue({ status: 0 });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(true);
    expect(mockSync).toHaveBeenCalledWith("claude", ["brief"], expect.objectContaining({
      timeout: 15 * 60_000,
    }));
  });

  it("treats a non-zero exit (status 1) as failure", () => {
    mockSync.mockReturnValue({ status: 1 });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(false);
  });

  it("treats a spawn error / timeout (error set, status null) as failure", () => {
    mockSync.mockReturnValue({ error: new Error("spawn ENOENT"), status: null });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(false);
  });

  it("treats a signal kill (status null, no error) as failure", () => {
    mockSync.mockReturnValue({ status: null, signal: "SIGINT" });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(false);
  });

  it("returns false without spawning for a tool that has no CLI", () => {
    // `cursor` is IDE-only (cli: null) — must short-circuit before spawning.
    expect(runToolInteractive("cursor", "brief", process.cwd())).toBe(false);
    expect(mockSync).not.toHaveBeenCalled();
  });
});

// The contract here is TTY behavior, so this spawns the built CLI for real —
// stubbing `process.stdin.isTTY` would only prove the stub works.
describe("mex sync headless contract", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cliPath = join(repoRoot, "dist", "cli.js");
  const env = { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" };

  beforeAll(() => {
    // `npm run test` runs before `npm run build` in CI and vitest runs files in
    // parallel, so the artifact test/cli.test.ts builds may not exist yet here.
    // Reuse it when present; build once only if it is genuinely missing.
    if (!existsSync(cliPath)) execSync("npm run build", { cwd: repoRoot, stdio: "pipe" });
  }, 300_000);

  // Every `askUser` prompt in the sync flow ends with this suffix
  // (src/sync/index.ts:81, :96, :238), so it is the reliable "we tried to read
  // stdin" tell — narrower markers like "Choice [1-3]" miss the tool-picker
  // prompt, which is the first one a regression would actually reach.
  const PROMPT_MARKER = "(default: 1)";

  /** `input` makes stdin a pipe at EOF — never a TTY, exactly like CI. */
  function runSyncCli(args: string[], cwd: string = repoRoot) {
    return spawnSync(process.execPath, [cliPath, "sync", ...args], {
      cwd,
      encoding: "utf8",
      env,
      input: "",
      timeout: 60_000,
    });
  }

  const fixtures: string[] = [];

  afterEach(() => {
    for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * A throwaway repo carrying exactly one seeded warning-level issue: a
   * package.json script no scaffold file mentions, which `checkScriptCoverage`
   * reports as `UNDOCUMENTED_SCRIPT` at warning severity
   * (src/drift/checkers/script-coverage.ts:66-74).
   *
   * These tests used to run against the live repo and relied on it carrying
   * warning-level drift as an ambient precondition. That inverts the incentive:
   * the moment the wiki got healthy (100/100) the assertion became
   * unsatisfiable, because sync correctly reports "No drift detected" and never
   * builds a brief. The contract under test is headless sync, not the repo's
   * score, so the drift is seeded here instead.
   *
   * `UNDOCUMENTED_SCRIPT` is chosen deliberately: it is warning severity (so
   * `--warnings` is what pulls it into scope, which is the branch being tested)
   * and it is computed from file contents alone, so it needs no commit history.
   */
  function seedWarningDriftRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "mex-sync-headless-"));
    fixtures.push(root);
    // `findConfig` treats a directory containing `.git` as the project root
    // (src/config.ts:95), so the fixture must be its own repo or resolution
    // walks up into the real one.
    execSync("git init -q", { cwd: root, stdio: "pipe" });
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "mex-sync-fixture", version: "1.0.0", scripts: { "seeded-undocumented-script": "echo hi" } }, null, 2)}\n`,
    );
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n\nNo scripts are documented here.\n");
    return root;
  }

  it("reaches a deterministic exit without prompting when stdin is not a TTY", () => {
    const result = runSyncCli(["--non-interactive"]);

    // A regression to a blocking prompt shows up as a timeout kill (signal set)
    // or, worse, the old silent-hang bug. Both fail here.
    expect(result.signal).toBe(null);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(PROMPT_MARKER);
  }, 90_000);

  it("prints the repair brief instead of launching an agent when drift is in scope", () => {
    // `--warnings` pulls the seeded warning-only issue into scope, so sync gets
    // past the "only warnings remain" early return (src/sync/index.ts:169-176)
    // and reaches the non-interactive guard.
    const result = runSyncCli(["--non-interactive", "--warnings"], seedWarningDriftRepo());

    expect(result.signal).toBe(null);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(PROMPT_MARKER);
    // Asserted on stdout only: the `askUser` EOF error text also contains
    // "--non-interactive", so matching combined output would pass on the bug.
    expect(result.stdout).toContain("emitting the repair brief");
  }, 90_000);

  it("auto-detects the non-TTY stdin without the explicit flag", () => {
    const result = runSyncCli(["--warnings"], seedWarningDriftRepo());

    expect(result.signal).toBe(null);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(PROMPT_MARKER);
    expect(result.stdout).toContain("emitting the repair brief");
  }, 90_000);
});
