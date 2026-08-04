import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { findConfig, saveAiTools, ensureScaffoldIdentity, getScaffoldIdentity, createConfig, getCheckoutIdentity, resolveHooksDir } from "../src/config.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-config-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("findConfig", () => {
  it("throws when you run it from inside the .mex/ folder", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    expect(() => findConfig(mexPath)).toThrow("You're inside the .mex/ directory");
  });

  it("throws when no git repository is found", () => {
    expect(() => findConfig(tmpDir)).toThrow("No git repository found");
  });

  it("throws when scaffold directory exists but looks incomplete", () => {
    mkdirSync(join(tmpDir, ".git"));
    mkdirSync(join(tmpDir, ".mex"));
    expect(() => findConfig(tmpDir)).toThrow("Scaffold directory exists but looks incomplete");
  });

  it("throws when no .mex/ scaffold found at all", () => {
    mkdirSync(join(tmpDir, ".git"));
    expect(() => findConfig(tmpDir)).toThrow("No .mex/ scaffold found. Run: mex setup");
  });

  it("works without .git if a complete scaffold exists", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    
    const config = findConfig(tmpDir);
    expect(config.projectRoot).toBe(tmpDir);
    expect(config.scaffoldRoot).toBe(mexPath);
  });

  it("does not treat the removed root context/ layout as a scaffold", () => {
    mkdirSync(join(tmpDir, ".git"));
    mkdirSync(join(tmpDir, "context"));
    expect(() => findConfig(tmpDir)).toThrow("No .mex/ scaffold found");
  });

  it("uses .mex/ even when an unrelated context/ directory exists", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    mkdirSync(join(tmpDir, "context"));
    const config = findConfig(tmpDir);
    expect(config.scaffoldRoot).toBe(mexPath);
  });

  it("returns empty aiTools when no config.json exists", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    const config = findConfig(tmpDir);
    expect(config.aiTools).toEqual([]);
  });

  it("loads aiTools from config.json when present", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ aiTools: ["opencode", "claude"] }));
    const config = findConfig(tmpDir);
    expect(config.aiTools).toEqual(["opencode", "claude"]);
  });
});

describe("findConfig — stalenessThresholds", () => {
  function setupScaffold(staleness: unknown): void {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ staleness }));
  }

  it("loads full thresholds from config.json", () => {
    setupScaffold({ warnDays: 14, errorDays: 60, warnCommits: 25, errorCommits: 100 });
    const config = findConfig(tmpDir);
    expect(config.stalenessThresholds).toEqual({
      warnDays: 14,
      errorDays: 60,
      warnCommits: 25,
      errorCommits: 100,
    });
  });

  it("fills missing fields from the checker defaults", () => {
    setupScaffold({ warnDays: 14 });
    const config = findConfig(tmpDir);
    expect(config.stalenessThresholds).toEqual({
      warnDays: 14,
      errorDays: 90,
      warnCommits: 50,
      errorCommits: 200,
    });
  });

  it("warns and falls back to defaults when warn exceeds error", () => {
    setupScaffold({ warnDays: 90, errorDays: 30 });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const config = findConfig(tmpDir);
      expect(config.stalenessThresholds).toEqual({
        warnDays: 30,
        errorDays: 90,
        warnCommits: 50,
        errorCommits: 200,
      });
      expect(warnings.some((w) => w.includes("invert warn/error"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("warns when commit invariant is violated too", () => {
    setupScaffold({ warnCommits: 500, errorCommits: 100 });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const config = findConfig(tmpDir);
      expect(config.stalenessThresholds).toEqual({
        warnDays: 30,
        errorDays: 90,
        warnCommits: 50,
        errorCommits: 200,
      });
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("findConfig — watch and heartbeat config", () => {
  function setupConfig(config: unknown): void {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify(config));
  }

  it("loads watch interval from config.json", () => {
    setupConfig({ watch: { intervalMinutes: 45 } });
    const config = findConfig(tmpDir);
    expect(config.watch).toEqual({ intervalMinutes: 45 });
  });

  it("loads heartbeat thresholds from config.json", () => {
    setupConfig({ heartbeat: { staleDays: 5, memoryCleanupDays: 8, dailyMemoryRetentionDays: 21 } });
    const config = findConfig(tmpDir);
    expect(config.heartbeat).toEqual({
      staleDays: 5,
      memoryCleanupDays: 8,
      dailyMemoryRetentionDays: 21,
    });
  });

  it("ignores non-positive watch and heartbeat values", () => {
    setupConfig({ watch: { intervalMinutes: 0 }, heartbeat: { staleDays: -1 } });
    const config = findConfig(tmpDir);
    expect(config.watch).toBeUndefined();
    expect(config.heartbeat).toBeUndefined();
  });
});

describe("scaffold identity", () => {
  function makeMex(): string {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath, { recursive: true });
    return mexPath;
  }

  it("mints a v4 scaffold_id, names it after the project dir, and persists it", () => {
    const mexPath = makeMex();
    const id = ensureScaffoldIdentity(mexPath, tmpDir);

    expect(id.scaffold_id).toMatch(UUID_V4);
    expect(id.scaffold_name).toBe(basename(tmpDir));

    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.scaffold_id).toBe(id.scaffold_id);
    expect(raw.scaffold_name).toBe(id.scaffold_name);
  });

  it("is idempotent — never regenerates an existing id", () => {
    const mexPath = makeMex();
    const first = ensureScaffoldIdentity(mexPath, tmpDir);
    const second = ensureScaffoldIdentity(mexPath, tmpDir);
    expect(second.scaffold_id).toBe(first.scaffold_id);
  });

  it("preserves existing config keys when minting identity", () => {
    const mexPath = makeMex();
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ aiTools: ["claude"], someOther: true }));
    ensureScaffoldIdentity(mexPath, tmpDir);
    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.aiTools).toEqual(["claude"]);
    expect(raw.someOther).toBe(true);
    expect(raw.scaffold_id).toMatch(UUID_V4);
  });

  it("mints distinct ids for distinct scaffolds (id is random, not path-derived)", () => {
    const a = join(tmpDir, "a", ".mex");
    const b = join(tmpDir, "b", ".mex");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const idA = ensureScaffoldIdentity(a, join(tmpDir, "a"));
    const idB = ensureScaffoldIdentity(b, join(tmpDir, "b"));
    expect(idA.scaffold_id).not.toBe(idB.scaffold_id);
  });

  it("swallows a write failure and still returns an identity", () => {
    // Put a file where a directory needs to be so the config write throws.
    const blocker = join(tmpDir, "blocker");
    writeFileSync(blocker, "not a directory");
    const scaffoldRoot = join(blocker, ".mex");
    const id = ensureScaffoldIdentity(scaffoldRoot, tmpDir);
    expect(id.scaffold_id).toMatch(UUID_V4);
    expect(existsSync(join(scaffoldRoot, "config.json"))).toBe(false);
  });

  it("findConfig surfaces an existing identity without minting", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({
      scaffold_id: "11111111-1111-4111-8111-111111111111",
      scaffold_name: "demo",
    }));
    const config = findConfig(tmpDir);
    expect(config.identity).toEqual({
      scaffold_id: "11111111-1111-4111-8111-111111111111",
      scaffold_name: "demo",
    });
  });

  it("findConfig stays a pure read — does not write config.json", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    const config = findConfig(tmpDir);
    expect(config.identity).toBeUndefined();
    expect(existsSync(join(mexPath, "config.json"))).toBe(false);
  });

  it("getScaffoldIdentity migrates a scaffold missing scaffold_id", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ aiTools: ["claude"] }));

    const config = findConfig(tmpDir);
    expect(config.identity).toBeUndefined(); // not minted by the read

    const id = getScaffoldIdentity(config);
    expect(id.scaffold_id).toMatch(UUID_V4);
    expect(config.identity).toEqual(id); // accessor backfills the in-memory config

    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.scaffold_id).toBe(id.scaffold_id);
    expect(raw.aiTools).toEqual(["claude"]); // existing keys untouched
  });

  it("backfills an empty scaffold_name without regenerating the id", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    // scaffold_id present but no scaffold_name (e.g. hand-edited / partial write)
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ scaffold_id: "keep-this-id" }));

    const id = getScaffoldIdentity(findConfig(tmpDir));
    expect(id.scaffold_id).toBe("keep-this-id"); // id preserved, never regenerated
    expect(id.scaffold_name).toBe(basename(tmpDir)); // name backfilled to the default

    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.scaffold_id).toBe("keep-this-id");
    expect(raw.scaffold_name).toBe(basename(tmpDir));
  });
});

describe("checkout identity and hook resolution", () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, MEX_TELEMETRY: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function setupRepo(root: string): string {
    git(root, "init");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test User");
    writeFileSync(join(root, "README.md"), "hello\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "init");
    const scaffoldRoot = join(root, ".mex");
    mkdirSync(scaffoldRoot);
    writeFileSync(join(scaffoldRoot, "ROUTER.md"), "");
    return scaffoldRoot;
  }

  it("resolveHooksDir returns the repo hooks dir from the root and a subdir", () => {
    setupRepo(tmpDir);
    const subdir = join(tmpDir, "nested");
    mkdirSync(subdir);
    expect(resolveHooksDir(tmpDir)).toBe(join(tmpDir, ".git", "hooks"));
    expect(resolveHooksDir(subdir)).toBe(join(tmpDir, ".git", "hooks"));
  });

  it("resolveHooksDir returns null outside a git repo", () => {
    expect(resolveHooksDir(tmpDir)).toBeNull();
  });

  it("resolveHooksDir honors core.hooksPath", () => {
    setupRepo(tmpDir);
    git(tmpDir, "config", "core.hooksPath", ".githooks");
    expect(resolveHooksDir(tmpDir)).toBe(join(tmpDir, ".githooks"));
  });

  it("resolveHooksDir returns the common hooks dir inside a linked worktree", () => {
    setupRepo(tmpDir);
    const worktreeRoot = join(tmpDir, "..", `${basename(tmpDir)}-wt`);
    git(tmpDir, "worktree", "add", worktreeRoot, "HEAD", "--detach");
    try {
      // realpathSync: on macOS the tmpdir is a symlink (/var -> /private/var) and
      // git reports the resolved path, so compare canonical paths.
      expect(resolveHooksDir(worktreeRoot)).toBe(realpathSync(join(tmpDir, ".git", "hooks")));
    } finally {
      git(tmpDir, "worktree", "remove", "--force", worktreeRoot);
    }
  });

  it("getCheckoutIdentity separates worktrees while scaffold identity stays shared", () => {
    const scaffoldRoot = setupRepo(tmpDir);
    const worktreeRoot = join(tmpDir, "..", `${basename(tmpDir)}-wt`);
    git(tmpDir, "worktree", "add", worktreeRoot, "HEAD", "--detach");
    try {
      // A real worktree inherits the COMMITTED config.json, so mint the shared
      // identity in the main scaffold first, then copy it across the way git would.
      // That shared scaffold_id surviving is the whole point of #18.
      const mainConfig = createConfig({ projectRoot: tmpDir, scaffoldRoot });
      const mainScaffold = getScaffoldIdentity(mainConfig);

      const worktreeScaffoldRoot = join(worktreeRoot, ".mex");
      mkdirSync(worktreeScaffoldRoot);
      writeFileSync(join(worktreeScaffoldRoot, "ROUTER.md"), "");
      writeFileSync(
        join(worktreeScaffoldRoot, "config.json"),
        readFileSync(join(scaffoldRoot, "config.json"), "utf-8"),
      );
      const worktreeConfig = createConfig({ projectRoot: worktreeRoot, scaffoldRoot: worktreeScaffoldRoot });

      const worktreeScaffold = getScaffoldIdentity(worktreeConfig);
      const mainCheckout = getCheckoutIdentity(mainConfig);
      const worktreeCheckout = getCheckoutIdentity(worktreeConfig);

      expect(mainScaffold.scaffold_id).toBe(worktreeScaffold.scaffold_id);
      expect(mainCheckout.checkout_id).not.toBe(worktreeCheckout.checkout_id);
    } finally {
      git(tmpDir, "worktree", "remove", "--force", worktreeRoot);
    }
  });

  it("getCheckoutIdentity is stable, uses a 32-char hex id, and names the checkout dir", () => {
    setupRepo(tmpDir);
    const worktreeRoot = join(tmpDir, "..", "wt");
    git(tmpDir, "worktree", "add", worktreeRoot, "HEAD", "--detach");
    try {
      const worktreeScaffoldRoot = join(worktreeRoot, ".mex");
      mkdirSync(worktreeScaffoldRoot);
      writeFileSync(join(worktreeScaffoldRoot, "ROUTER.md"), "");
      const config = createConfig({ projectRoot: worktreeRoot, scaffoldRoot: worktreeScaffoldRoot });
      const first = getCheckoutIdentity(config);
      const second = getCheckoutIdentity(config);

      expect(second).toBe(first);
      expect(first.checkout_id).toMatch(/^[0-9a-f]{32}$/);
      expect(first.checkout_name).toBe("wt");
    } finally {
      git(tmpDir, "worktree", "remove", "--force", worktreeRoot);
    }
  });
});

describe("saveAiTools", () => {
  it("creates config.json with aiTools", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath, { recursive: true });
    saveAiTools(mexPath, ["opencode"]);
    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.aiTools).toEqual(["opencode"]);
  });

  it("preserves existing config keys when saving", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath, { recursive: true });
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ someOther: true }));
    saveAiTools(mexPath, ["codex"]);
    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.aiTools).toEqual(["codex"]);
    expect(raw.someOther).toBe(true);
  });

  it("overwrites previous aiTools value", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath, { recursive: true });
    saveAiTools(mexPath, ["claude"]);
    saveAiTools(mexPath, ["opencode", "codex"]);
    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.aiTools).toEqual(["opencode", "codex"]);
  });
});
