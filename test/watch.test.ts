import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createConfig } from "../src/config.js";
import { manageHook } from "../src/watch.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-watch-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, MEX_TELEMETRY: "0" },
  }).trim();
}

function setupRepo(projectRoot: string): void {
  mkdirSync(projectRoot, { recursive: true });
  git(projectRoot, "init");
  git(projectRoot, "config", "user.email", "watch@example.com");
  git(projectRoot, "config", "user.name", "Mex Watch");
  writeFileSync(join(projectRoot, "README.md"), "# test\n");
  git(projectRoot, "add", "README.md");
  git(projectRoot, "commit", "-m", "init");
  const scaffoldRoot = join(projectRoot, ".mex");
  mkdirSync(scaffoldRoot, { recursive: true });
}

function makeConfig(projectRoot: string) {
  return createConfig({
    projectRoot,
    scaffoldRoot: join(projectRoot, ".mex"),
  });
}

describe("manageHook", () => {
  it("installs and uninstalls a post-commit hook in a main checkout", async () => {
    const projectRoot = join(tmpDir, "repo");
    setupRepo(projectRoot);
    const config = makeConfig(projectRoot);
    const hookPath = join(projectRoot, ".git", "hooks", "post-commit");

    await manageHook(config, {});
    expect(existsSync(hookPath)).toBe(true);

    await manageHook(config, { uninstall: true });
    expect(existsSync(hookPath)).toBe(false);
  });

  it("installs and uninstalls in a linked worktree using the common hooks directory", async () => {
    const projectRoot = join(tmpDir, "repo");
    setupRepo(projectRoot);
    const worktreeRoot = join(tmpDir, "wt");
    git(projectRoot, "worktree", "add", worktreeRoot, "HEAD", "--detach");

    try {
      const config = makeConfig(worktreeRoot);
      const commonHookPath = join(projectRoot, ".git", "hooks", "post-commit");

      await expect(manageHook(config, {})).resolves.toBeUndefined();
      expect(existsSync(commonHookPath)).toBe(true);
      expect(readFileSync(commonHookPath, "utf-8")).toContain("mex-agent");

      await manageHook(config, { uninstall: true });
      expect(existsSync(commonHookPath)).toBe(false);
    } finally {
      git(projectRoot, "worktree", "remove", "--force", worktreeRoot);
    }
  });

  it("writes a runtime-resolved hook body with mex-agent and no temp-repo absolute path", async () => {
    const projectRoot = join(tmpDir, "repo");
    setupRepo(projectRoot);
    const config = makeConfig(projectRoot);
    const hookPath = join(projectRoot, ".git", "hooks", "post-commit");

    await manageHook(config, {});

    const hook = readFileSync(hookPath, "utf-8");
    expect(hook).toContain("ROOT=$(git rev-parse --show-toplevel 2>/dev/null)");
    expect(hook).toContain('cd "$ROOT" || exit 0');
    expect(hook).toContain("npx --yes mex-agent check --quiet");
    expect(hook).not.toContain("npx mex check --quiet");
    expect(hook).not.toContain(projectRoot);
  });

  it("round-trips install then uninstall with no post-commit file left", async () => {
    const projectRoot = join(tmpDir, "repo");
    setupRepo(projectRoot);
    const config = makeConfig(projectRoot);
    const hookPath = join(projectRoot, ".git", "hooks", "post-commit");

    await manageHook(config, {});
    await manageHook(config, { uninstall: true });

    expect(existsSync(hookPath)).toBe(false);
  });

  it("appends to an existing hook and preserves non-mex content after uninstall", async () => {
    const projectRoot = join(tmpDir, "repo");
    setupRepo(projectRoot);
    const config = makeConfig(projectRoot);
    const hookPath = join(projectRoot, ".git", "hooks", "post-commit");
    const existingHook = "#!/bin/sh\necho existing-hook\n";

    writeFileSync(hookPath, existingHook);
    await manageHook(config, {});

    const installed = readFileSync(hookPath, "utf-8");
    expect(installed).toContain("echo existing-hook");
    expect(installed).toContain("mex-agent");

    await manageHook(config, { uninstall: true });
    expect(readFileSync(hookPath, "utf-8")).toBe(existingHook);
  });
});
