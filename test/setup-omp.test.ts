import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { findConfig, saveAiTools } from "../src/config.js";
import { AI_TOOLS } from "../src/types.js";
import { ompArtifactPaths } from "../src/setup/index.js";
import { checkOmpArtifacts } from "../src/drift/checkers/omp-artifacts.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-setup-omp-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write `content` at `relPath` under the temp project, creating parent dirs. */
function file(relPath: string, content: string): void {
  const target = join(tmpDir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Minimal `---`-delimited frontmatter carrying only a description. */
function frontmatter(description: string): string {
  return `---\ndescription: ${JSON.stringify(description)}\n---\n`;
}

const GENERATED_MARKER = "<!-- mex-generated -->";

describe("omp tool target", () => {
  it("exposes the spawn contract mex sync needs: cli 'omp' with an array promptFlag containing -p", () => {
    const meta = AI_TOOLS.omp;
    expect(meta.cli).toBe("omp");
    expect(Array.isArray(meta.promptFlag)).toBe(true);
    expect(meta.promptFlag).toContain("-p");
  });

  it("keeps 'omp' through a config round-trip — loadAiTools used to filter it out against a hardcoded list, silently dropping the selection on reload", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");

    saveAiTools(mexPath, ["omp"]);

    expect(findConfig(tmpDir).aiTools).toEqual(["omp"]);
  });

  it("publishes omp artifact paths anchored at .omp/AGENTS.md with every generated dir under .omp/", () => {
    expect(ompArtifactPaths.anchor).toBe(".omp/AGENTS.md");
    for (const dir of [
      ompArtifactPaths.rulesDir,
      ompArtifactPaths.skillsDir,
      ompArtifactPaths.commandsDir,
    ]) {
      expect(dir.startsWith(".omp/")).toBe(true);
    }
  });
});

describe("checkOmpArtifacts", () => {
  it("returns no issues at all when the project has no .omp/ directory", () => {
    file(".mex/ROUTER.md", "");
    expect(checkOmpArtifacts(tmpDir)).toEqual([]);
  });

  it("accepts an anchor import that resolves", () => {
    file(".omp/AGENTS.md", "@../.mex/AGENTS.md\n");
    file(".mex/AGENTS.md", "# anchor\n");

    const issues = checkOmpArtifacts(tmpDir);
    expect(issues.filter((i) => i.code === "OMP_ANCHOR_BROKEN")).toHaveLength(0);
  });

  it("reports an unresolvable anchor import as an error against the bridge file", () => {
    file(".omp/AGENTS.md", "@../.mex/AGENTS.md\n");

    const issues = checkOmpArtifacts(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("OMP_ANCHOR_BROKEN");
    expect(issues[0].severity).toBe("error");
    expect(issues[0].file).toBe(".omp/AGENTS.md");
  });

  it("reports a generated pattern rule whose projected description no longer matches the pattern", () => {
    file(".mex/patterns/foo.md", frontmatter("real description"));
    file(
      ".omp/rules/mex-pattern-foo.md",
      `${frontmatter("stale description")}\n${GENERATED_MARKER}\n`
    );

    const issues = checkOmpArtifacts(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("OMP_RULE_DRIFT");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].file).toBe(".omp/rules/mex-pattern-foo.md");
  });

  it("accepts a generated pattern rule whose description still matches the pattern", () => {
    file(".mex/patterns/foo.md", frontmatter("real description"));
    file(
      ".omp/rules/mex-pattern-foo.md",
      `${frontmatter("real description")}\n${GENERATED_MARKER}\n`
    );

    expect(checkOmpArtifacts(tmpDir)).toEqual([]);
  });

  it("reports a generated pattern rule whose source pattern has been deleted", () => {
    mkdirSync(join(tmpDir, ".mex", "patterns"), { recursive: true });
    file(
      ".omp/rules/mex-pattern-gone.md",
      `${frontmatter("orphaned description")}\n${GENERATED_MARKER}\n`
    );

    const issues = checkOmpArtifacts(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("OMP_RULE_ORPHAN");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].file).toBe(".omp/rules/mex-pattern-gone.md");
  });

  it("never reports a hand-written rule that lacks the mex-generated marker, however much it looks generated", () => {
    // Drifted-looking: same name shape, description disagrees with the pattern.
    file(".mex/patterns/foo.md", frontmatter("real description"));
    file(".omp/rules/mex-pattern-foo.md", frontmatter("stale description"));
    // Orphan-looking: no source pattern at all.
    file(".omp/rules/mex-pattern-gone.md", frontmatter("orphaned description"));

    expect(checkOmpArtifacts(tmpDir)).toEqual([]);
  });
});
