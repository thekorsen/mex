import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock cross-spawn so we can inspect the exact argv payload `runToolInteractive`
// hands off, including the oversize-brief path that must avoid E2BIG entirely.
vi.mock("cross-spawn", () => ({
  default: { sync: vi.fn() },
}));

vi.mock("../src/cli-tools.js", () => ({
  isCliAvailable: vi.fn(() => true),
}));

vi.mock("../src/graph/runtime.js", () => ({
  captureGroundingBaselines: vi.fn(async () => ({ captured: 0 })),
  loadGroundingRuntime: vi.fn(async () => null),
  persistMovedGroundings: vi.fn(),
}));

import crossSpawn from "cross-spawn";
import { runToolInteractive } from "../src/sync/index.js";
import { briefArgvBudget, deliverBrief } from "../src/sync/brief-delivery.js";
import { AI_TOOLS } from "../src/types.js";
import { runGraphGround } from "../src/graph/cli-ground.js";
import type { MexConfig } from "../src/types.js";

const mockSync = crossSpawn.sync as unknown as ReturnType<typeof vi.fn>;
const fixtures: string[] = [];

/**
 * `runToolInteractive` uses the real `briefArgvBudget()`, so an "oversized" brief must be
 * sized against it rather than a fixed constant — 160 KB spills on linux/win32 but fits
 * comfortably inside darwin's measured ~1,046 KB budget, so a hardcoded size silently
 * tests the inline path on macOS and proves nothing about the spill it claims to cover.
 */
function oversizedBrief(): string {
  return "0123456789abcdef".repeat(Math.ceil((briefArgvBudget() + 64 * 1024) / 16));
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("briefArgvBudget", () => {
  it("returns a positive budget for a normal environment", () => {
    expect(briefArgvBudget({ PATH: "/usr/bin", HOME: "/tmp/mex" }, "darwin")).toBeGreaterThan(0);
  });

  it("shrinks as the environment block grows", () => {
    const smallEnv = { PATH: "/usr/bin" };
    const largeEnv = { PATH: "/usr/bin", BIG: "x".repeat(100 * 1024) };

    expect(briefArgvBudget(largeEnv, "darwin")).toBeLessThan(briefArgvBudget(smallEnv, "darwin"));
  });

  it("is per-platform", () => {
    const env = { PATH: "/usr/bin" };

    expect(briefArgvBudget(env, "win32")).toBeLessThan(briefArgvBudget(env, "darwin"));
  });

  it("never returns a negative number even when the environment alone exceeds the platform ceiling", () => {
    const hugeEnv = { BIG: "x".repeat(2 * 1024 * 1024) };

    expect(briefArgvBudget(hugeEnv, "linux")).toBeGreaterThanOrEqual(0);
  });
});

describe("deliverBrief", () => {
  it("passes through a brief that fits unchanged", () => {
    const brief = "Fix the repo without spilling.";
    const delivery = deliverBrief(brief, { budget: Buffer.byteLength(brief, "utf8") });

    try {
      expect(delivery.prompt).toBe(brief);
      expect(delivery.spillPath).toBeNull();
    } finally {
      delivery.cleanup();
    }
  });

  it("spills an oversized brief to disk", () => {
    const brief = "x".repeat(512);
    const delivery = deliverBrief(brief, { budget: 32 });

    try {
      expect(delivery.spillPath).not.toBeNull();
      expect(existsSync(delivery.spillPath!)).toBe(true);
      expect(delivery.prompt).not.toBe(brief);
      fixtures.push(dirname(delivery.spillPath!));
    } finally {
      delivery.cleanup();
    }
  });

  it("writes the complete oversized brief without truncation", () => {
    const brief = [
      "# Repair brief",
      "",
      "Read everything in full — do not summarize.",
      "",
      "```ts",
      "console.log(\"修\");",
      "```",
      "",
      "Final line.",
    ].join("\n");
    const delivery = deliverBrief(brief, { budget: 32 });

    try {
      fixtures.push(dirname(delivery.spillPath!));
      const readback = readFileSync(delivery.spillPath!, "utf8");
      expect(readback).toBe(brief);
      expect(Buffer.byteLength(readback, "utf8")).toBe(Buffer.byteLength(brief, "utf8"));
    } finally {
      delivery.cleanup();
    }
  });

  it("replaces an oversized brief with a short pointer prompt", () => {
    // Sized like a real brief (whole files inlined) rather than a token-sized one: the
    // contract is that argv carries a pointer instead of the payload, and the pointer is
    // a fixed-length sentence, so the ratio is only meaningful against a realistic brief.
    const brief = "large brief line with inlined file content\n".repeat(5_000);
    const delivery = deliverBrief(brief, { budget: 32 });

    try {
      fixtures.push(dirname(delivery.spillPath!));
      expect(delivery.prompt).toContain(delivery.spillPath!);
      expect(delivery.prompt.length).toBeLessThan(brief.length / 100);
    } finally {
      delivery.cleanup();
    }
  });

  it("removes the spill directory during cleanup", () => {
    const brief = "x".repeat(512);
    const delivery = deliverBrief(brief, { budget: 32 });
    const spillDir = dirname(delivery.spillPath!);
    fixtures.push(spillDir);

    delivery.cleanup();

    expect(existsSync(spillDir)).toBe(false);
  });

  it("allows cleanup to be called twice without throwing", () => {
    const brief = "x".repeat(512);
    const delivery = deliverBrief(brief, { budget: 32 });
    const spillDir = dirname(delivery.spillPath!);
    fixtures.push(spillDir);

    expect(() => {
      delivery.cleanup();
      delivery.cleanup();
    }).not.toThrow();
    expect(existsSync(spillDir)).toBe(false);
  });
});

describe("runToolInteractive brief delivery", () => {
  const cliTool = Object.entries(AI_TOOLS).find(([, meta]) => meta.cli)?.[0];

  if (!cliTool) throw new Error("Expected at least one CLI-backed AI tool.");

  const cliMeta = AI_TOOLS[cliTool as keyof typeof AI_TOOLS];

  beforeEach(() => {
    mockSync.mockReset();
  });

  it("passes a small brief in argv verbatim", () => {
    const brief = "small brief";
    mockSync.mockReturnValue({ status: 0 });

    expect(runToolInteractive(cliTool as keyof typeof AI_TOOLS, brief, process.cwd())).toBe(true);

    const [, args] = mockSync.mock.calls[0] as [string, string[]];
    expect(args).toEqual([...cliMeta.promptFlag, brief]);
    expect(args.at(-1)).toBe(brief);
  });

  it("uses OMP metadata with an inner timeout and an @file for oversized briefs", () => {
    const brief = oversizedBrief();
    const ompTool = Object.entries(AI_TOOLS).find(([, meta]) => meta === AI_TOOLS.omp)?.[0];
    if (!ompTool) throw new Error("Expected OMP metadata to be registered.");

    let spillDir = "";
    mockSync.mockImplementation((cli: string, args: string[]) => {
      expect(cli).toBe(AI_TOOLS.omp.cli);
      expect(args.slice(0, AI_TOOLS.omp.promptFlag.length)).toEqual(AI_TOOLS.omp.promptFlag);
      expect(args).toContain("--max-time=14m");

      const finalArg = args.at(-1) ?? "";
      expect(finalArg.startsWith("@")).toBe(true);
      const spillPath = finalArg.slice(1);
      expect(readFileSync(spillPath, "utf8")).toBe(brief);
      spillDir = dirname(spillPath);
      fixtures.push(spillDir);
      return { status: 0 };
    });

    expect(
      runToolInteractive(ompTool as keyof typeof AI_TOOLS, brief, process.cwd())
    ).toBe(true);
    expect(existsSync(spillDir)).toBe(false);
  });

  it("replaces an oversized brief with a spill-file pointer before spawning", () => {
    const brief = oversizedBrief();

    mockSync.mockImplementation((_cli: string, args: string[]) => {
      const finalArg = args.at(-1) ?? "";
      const spillPath = finalArg.split("\n").find((line) => existsSync(line.trim()));
      expect(finalArg).not.toBe(brief);
      expect(finalArg.length).toBeLessThan(brief.length / 10);
      expect(spillPath).toBeTruthy();
      expect(existsSync(spillPath!)).toBe(true);
      fixtures.push(dirname(spillPath!));
      return { status: 0 };
    });

    expect(runToolInteractive(cliTool as keyof typeof AI_TOOLS, brief, process.cwd())).toBe(true);
  });

  it("cleans up the spill directory after runToolInteractive returns, including spawn errors", () => {
    const brief = oversizedBrief();
    const observedSpillDirs: string[] = [];

    mockSync.mockImplementationOnce((_cli: string, args: string[]) => {
      const spillPath = (args.at(-1) ?? "").split("\n").find((line) => existsSync(line.trim()));
      expect(spillPath).toBeTruthy();
      observedSpillDirs.push(dirname(spillPath!));
      return { status: 0 };
    });
    expect(runToolInteractive(cliTool as keyof typeof AI_TOOLS, brief, process.cwd())).toBe(true);
    expect(existsSync(observedSpillDirs[0])).toBe(false);

    mockSync.mockImplementationOnce((_cli: string, args: string[]) => {
      const spillPath = (args.at(-1) ?? "").split("\n").find((line) => existsSync(line.trim()));
      expect(spillPath).toBeTruthy();
      observedSpillDirs.push(dirname(spillPath!));
      return { error: new Error("spawn E2BIG"), status: null };
    });
    expect(runToolInteractive(cliTool as keyof typeof AI_TOOLS, brief, process.cwd())).toBe(false);
    expect(existsSync(observedSpillDirs[1])).toBe(false);
  });

  it("preserves boolean success and failure mapping across the new delivery path", () => {
    const brief = oversizedBrief();

    mockSync.mockReturnValueOnce({ error: new Error("spawn ENOENT"), status: null });
    expect(runToolInteractive(cliTool as keyof typeof AI_TOOLS, brief, process.cwd())).toBe(false);

    mockSync.mockReturnValueOnce({ status: 0 });
    expect(runToolInteractive(cliTool as keyof typeof AI_TOOLS, brief, process.cwd())).toBe(true);
  });
});

describe("graph ground OMP delivery", () => {
  it("selects configured OMP metadata and delegates through the shared spawn path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-ground-omp-"));
    const scaffoldRoot = join(root, ".mex");
    fixtures.push(root);
    mkdirSync(scaffoldRoot, { recursive: true });
    writeFileSync(join(scaffoldRoot, "graph.db"), "");

    const ompTool = Object.entries(AI_TOOLS).find(([, meta]) => meta === AI_TOOLS.omp)?.[0];
    if (!ompTool) throw new Error("Expected OMP metadata to be registered.");
    const config: MexConfig = {
      projectRoot: root,
      scaffoldRoot,
      aiTools: [ompTool as keyof typeof AI_TOOLS],
    };
    mockSync.mockReset();
    mockSync.mockReturnValue({ status: 0 });

    expect(await runGraphGround(config)).toBe("ran");
    expect(mockSync).toHaveBeenCalledOnce();
    const [cli, args] = mockSync.mock.calls[0] as [string, string[]];
    expect(cli).toBe(AI_TOOLS.omp.cli);
    expect(args.slice(0, AI_TOOLS.omp.promptFlag.length)).toEqual(AI_TOOLS.omp.promptFlag);
    expect(args).toContain("--max-time=14m");
    expect(args.at(-1)).toContain("retro-grounding");
  });
});

describe("oversized brief through a real spawn", () => {
  it("spawns successfully with the spill-file prompt even when the raw brief may exceed argv", () => {
    // Measured on this darwin host: getconf ARG_MAX = 1048576, and one argv string
    // first fails with E2BIG at 1,045,930 bytes with a 2,009-byte environ.
    const brief = "x".repeat(briefArgvBudget() + 64 * 1024);
    const delivery = deliverBrief(brief);

    try {
      fixtures.push(dirname(delivery.spillPath!));
      const verifier = [
        "const { readFileSync } = require('node:fs');",
        "const path = process.argv[1].split('\\n').at(-1);",
        "const bytes = Buffer.byteLength(readFileSync(path, 'utf8'));",
        "if (bytes !== Number(process.argv[2])) process.exit(2);",
        "process.stdout.write('OVERSIZED_BRIEF_COMPLETE');",
      ].join("");
      const delivered = spawnSync(
        process.execPath,
        ["-e", verifier, delivery.prompt, String(Buffer.byteLength(brief))],
        { encoding: "utf8" }
      );
      expect(delivered.error ?? null).toBeNull();
      expect(delivered.status).toBe(0);
      expect(delivered.stdout).toBe("OVERSIZED_BRIEF_COMPLETE");

      const raw = spawnSync(process.execPath, ["-e", "process.exit(0)", brief], {
        encoding: "utf8",
      });
      if (raw.error) {
        expect((raw.error as NodeJS.ErrnoException).code).toBe("E2BIG");
      }
    } finally {
      delivery.cleanup();
    }
  });
});
