import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { globSync } from "glob";
import { afterEach, describe, expect, it } from "vitest";
import { checkToolConfigSync } from "../src/drift/checkers/tool-config-sync.js";
import { extractFrontmatter, findMexAnchors } from "../src/markdown.js";

const roots: string[] = [];
const embedded = ["CLAUDE.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md"];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shipped code-graph agent guidance", () => {
  it("models grounding slots and inert inline-anchor examples in templates and dogfood", () => {
    for (const area of ["templates", ".mex"]) {
      for (const name of ["architecture", "conventions", "decisions", "setup", "stack"]) {
        const content = readFileSync(join(area, "context", `${name}.md`), "utf-8");
        expect(extractFrontmatter(content)?.grounds_to, `${area}/${name}`).toEqual([]);
        expect(content, `${area}/${name}`).toContain("[`someFunction()`](mex://function:<tier-1-id>)");
        expect(findMexAnchors(content), `${area}/${name} examples must stay inert`).toEqual([]);
      }
      const patterns = readFileSync(join(area, "patterns/README.md"), "utf-8");
      expect(patterns).toContain("grounds_to:");
      expect(patterns).toContain('fingerprint: "mh:64:<hex-fingerprint>"');
      expect(patterns).toContain("[`someFunction()`](mex://function:<tier-1-id>)");
      expect(findMexAnchors(patterns), `${area}/patterns examples must stay inert`).toEqual([]);
    }
  });

  it("is identical across embedded tool configs and covers all agent responsibilities", () => {
    const contents = embedded.map((name) => readFileSync(join("templates/.tool-configs", name), "utf-8"));
    expect(new Set(contents).size).toBe(1);
    expect(contents[0]).toContain("mex impact <symbol|file>");
    expect(contents[0]).toContain("mex graph query <who-calls|what-calls|where-defined> <symbol>");
    expect(contents[0]).toContain("adjudicate any AMBIGUOUS grounding");
    expect(contents[0]).toContain("refreshed grounding is re-emitted");
  });

  it("keeps maintained equivalents aligned and OpenCode delegated to guided AGENTS.md", () => {
    const maintained = embedded.map((name) => readFileSync(join(".mex/.tool-configs", name), "utf-8"));
    expect(new Set(maintained).size).toBe(1);
    expect(maintained[0]).toContain("mex impact <symbol|file>");
    const agents = readFileSync("templates/AGENTS.md", "utf-8");
    expect(agents).toContain("mex graph query <who-calls|what-calls|where-defined> <symbol>");
    for (const file of ["templates/.tool-configs/opencode.json", ".mex/.tool-configs/opencode.json"]) {
      expect(JSON.parse(readFileSync(file, "utf-8")).instructions).toContain(".mex/AGENTS.md");
    }
  });

  it("passes tool-config-sync after installation", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-tool-configs-"));
    roots.push(root);
    const content = readFileSync("templates/.tool-configs/CLAUDE.md", "utf-8");
    for (const path of ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    expect(checkToolConfigSync(root)).toEqual([]);
  });
});

describe("shipped oh-my-pi artifacts", () => {
  const ompRoot = "templates/omp";
  const rules = ["mex-router.md", "mex-graph.md", "mex-grow.md"];

  it("bridges to the real anchor by import instead of embedding a sixth copy", () => {
    const anchor = readFileSync(join(ompRoot, "AGENTS.md"), "utf-8");
    expect(
      anchor.split("\n").map((line) => line.trim()),
      "the import must stand alone on its own line to resolve — it is relative to <root>/.omp/, and a token buried in prose or an HTML comment is inert",
    ).toContain("@../.mex/AGENTS.md");
    const embeddedBody = readFileSync("templates/.tool-configs/CLAUDE.md", "utf-8");
    expect(embeddedBody).toContain("mex impact <symbol|file>");
    expect(
      anchor,
      "the omp anchor must reference .mex/AGENTS.md, not inline the embedded guidance — otherwise it becomes a sixth copy to keep byte-identical",
    ).not.toContain("mex impact <symbol|file>");
    expect(extractFrontmatter(anchor), "omp context files take no frontmatter").toBeNull();
  });

  it("ships only rulebook-eligible rules", () => {
    for (const name of rules) {
      const frontmatter = extractFrontmatter(readFileSync(join(ompRoot, "rules", name), "utf-8"));
      expect(frontmatter?.description, `${name} needs a description or omp drops it from the rulebook`).toBeTypeOf("string");
      expect((frontmatter?.description ?? "").trim().length, `${name} description must not be blank`).toBeGreaterThan(0);
      expect(
        Object.keys(frontmatter ?? {}),
        `${name} must not set alwaysApply: combined with description it moves the rule into the always-apply bucket and silently excludes it from the rulebook — the exact opposite of the intent`,
      ).not.toContain("alwaysApply");
    }
  });

  it("ships the wiki skill where the native provider discovers it", () => {
    const skill = join(ompRoot, "skills/mex-wiki/SKILL.md");
    expect(existsSync(skill), "SKILL.md must sit one level under the skills root — deeper nesting is not discovered").toBe(true);
    const description = extractFrontmatter(readFileSync(skill, "utf-8"))?.description;
    expect(description, "a skill without a description is silently invisible to the native provider").toBeTypeOf("string");
    expect((description ?? "").trim().length).toBeGreaterThan(0);
  });

  it("gives every shipped command a description", () => {
    const commands = globSync("*.md", { cwd: join(ompRoot, "commands"), nodir: true });
    expect(commands.length).toBeGreaterThan(0);
    for (const name of commands) {
      const description = extractFrontmatter(readFileSync(join(ompRoot, "commands", name), "utf-8"))?.description;
      expect(description, `commands/${name} needs a description to be listed`).toBeTypeOf("string");
      expect((description ?? "").trim().length, `commands/${name} description must not be blank`).toBeGreaterThan(0);
    }
  });

  it("mex- prefixes every artifact name so first-wins dedup cannot collide with the user's own", () => {
    const named: string[] = [];
    for (const kind of ["rules", "commands"]) {
      const files = globSync("**/*", { cwd: join(ompRoot, kind), nodir: true });
      expect(files.length, `${kind} must ship at least one artifact`).toBeGreaterThan(0);
      named.push(...files.map((file) => `${kind}/${file}`));
    }
    const skills = readdirSync(join(ompRoot, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(skills.length, "skills must ship at least one artifact").toBeGreaterThan(0);
    named.push(...skills.map((entry) => `skills/${entry.name}`));
    for (const path of named) {
      expect(
        basename(path),
        `${path} must be mex- prefixed: omp dedups rules, skills, and commands first-wins by bare name, so an unprefixed name would shadow or be shadowed by a user's own artifact`,
      ).toMatch(/^mex-/);
    }
  });

  it("keeps the force-stuck rules file inside its per-turn budget", () => {
    const lines = readFileSync(join(ompRoot, "RULES.md"), "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(
      lines.length,
      "RULES.md is force-stuck and re-attached near every turn, so it is charged against every single turn's context — keep it to a handful of directives",
    ).toBeLessThanOrEqual(20);
  });
});
