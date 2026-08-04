import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGraphGround } from "../src/graph/cli-ground.js";
import type { MexConfig } from "../src/types.js";
const { captureGroundingBaselines } = vi.hoisted(() => ({
  captureGroundingBaselines: vi.fn(),
}));

vi.mock("../src/graph/runtime.js", () => ({
  captureGroundingBaselines,
}));
const roots: string[] = [];

function fixture(): { root: string; config: MexConfig } {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-ground-cli-"));
  roots.push(root);
  const scaffoldRoot = join(root, ".mex");
  mkdirSync(scaffoldRoot, { recursive: true });
  writeFileSync(join(scaffoldRoot, "graph.db"), "stub");
  return { root, config: { projectRoot: root, scaffoldRoot, aiTools: [] } };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("runGraphGround capture output", () => {
  it("prints the commit instruction after automatic-agent capture", async () => {
    const { config, root } = fixture();
    captureGroundingBaselines.mockResolvedValue({ captured: 2, skipped: 0 });
    const output: string[] = [];

    await expect(
      runGraphGround(config, {}, { runAgent: vi.fn().mockReturnValue(true), write: (line) => output.push(line) }),
    ).resolves.toBe("ran");

    expect(captureGroundingBaselines).toHaveBeenCalledWith(config, { warn: expect.any(Function) });
    expect(output).toEqual([
      "Captured 2 grounding baseline(s).",
      "Wrote baselines to .mex/grounding.json; commit this file so other checkouts can verify grounding.",
    ]);
    expect(output).not.toContain(root);
  });

  it("keeps the no-capture warning for manual confirmation", async () => {
    const { config } = fixture();
    captureGroundingBaselines.mockResolvedValue({ captured: 0, skipped: 0 });
    const output: string[] = [];

    await expect(
      runGraphGround(config, {}, { write: (line) => output.push(line), confirmAuthored: async () => true }),
    ).resolves.toBe("ran");

    expect(captureGroundingBaselines).toHaveBeenCalledWith(config, { warn: expect.any(Function) });
    expect(output.at(-1)).toBe(
      "Warning: no grounding baselines were captured; verify the migration authored grounding.",
    );
  });
});
