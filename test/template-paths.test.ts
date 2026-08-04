import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const scaffoldFiles = [
  "ROUTER.md",
  "AGENTS.md",
  "SETUP.md",
  "SYNC.md",
  "context/architecture.md",
  "context/stack.md",
  "context/conventions.md",
  "context/decisions.md",
  "context/setup.md",
  "patterns/README.md",
  "patterns/INDEX.md",
];
// Keep this list in lockstep with SCAFFOLD_FILES in src/setup/index.ts:33-45.
// `.mex/graph.db` is produced by `mex graph`, not by `mex setup`, and is gitignored
// (.gitignore:21). It is a real artifact of the documented workflow, so the reference in
// templates/AGENTS.md is legitimate even though a fresh scaffold does not contain it.
// Every allowlist entry needs a justification like this one.
const allowedMissingReferences: Record<string, true> = {
  "AGENTS.md::.mex/graph.db": true,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shipped scaffold markdown paths", () => {
  it("only references paths that a simulated mex setup installs", () => {
    const templateFiles = scaffoldFiles.filter((path) => {
      readFileSync(join("templates", path), "utf-8");
      return true;
    });
    expect(templateFiles, "test list must mirror templates/ copies of SCAFFOLD_FILES").toEqual(scaffoldFiles);

    const root = mkdtempSync(join(tmpdir(), "mex-template-paths-"));
    roots.push(root);
    const scaffoldRoot = join(root, ".mex");
    mkdirSync(scaffoldRoot, { recursive: true });

    for (const path of scaffoldFiles) {
      const destination = join(scaffoldRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join("templates", path), "utf-8"));
    }

    expect(collectMissingReferences(scaffoldRoot, scaffoldFiles), "every checked reference must resolve in a fresh mex setup fixture").toEqual([]);
  });

  it("flags dangling .mex shell-script references in inline code and bash fences", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-template-paths-negative-"));
    roots.push(root);
    const scaffoldRoot = join(root, ".mex");
    mkdirSync(scaffoldRoot, { recursive: true });

    for (const path of scaffoldFiles) {
      const destination = join(scaffoldRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join("templates", path), "utf-8"));
    }

    const fence = "```";
    writeFileSync(
      join(scaffoldRoot, "SETUP.md"),
      [
        readFileSync(join(scaffoldRoot, "SETUP.md"), "utf-8"),
        "",
        "Inline regression: `.mex/sync.sh`.",
        "",
        `${fence}bash`,
        ".mex/sync.sh",
        fence,
        "",
      ].join("\n")
    );

    expect(collectMissingReferences(scaffoldRoot, ["SETUP.md"]), "extractor must catch dangling .mex/sync.sh references").toContain(
      "SETUP.md → .mex/sync.sh"
    );
  });
});

function collectMissingReferences(scaffoldRoot: string, installedFiles: string[]) {
  const missing = new Set<string>();

  for (const file of installedFiles) {
    const source = readFileSync(join(scaffoldRoot, file), "utf-8");
    const references = new Set<string>();

    for (const match of source.matchAll(/`([^`]+)`/g)) {
      const candidate = match[1].trim().replace(/^[('"[{]+|[)\]}'";,:]+$/g, "");
      if (!candidate) continue;
      if (candidate.includes("<") || candidate.includes(">")) continue;
      if (candidate === "filename.md") continue;
      if (candidate.startsWith(".") && !candidate.startsWith(".mex/")) continue;
      const looksLikeMexPath = candidate.startsWith(".mex/");
      const looksLikeRelativeFile = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(candidate);
      if (!looksLikeMexPath && !looksLikeRelativeFile) continue;
      if (candidate.endsWith(".md") && !candidate.startsWith(".mex/")) continue;
      references.add(candidate);
    }

    // Do not reuse the drift claim extractor here: src/drift/claims.ts:83-102 only
    // emits kind:"command" from fenced code blocks, and src/drift/index.ts:140 only
    // sends ROUTER.md path claims to the MISSING_PATH checker.
    for (const match of source.matchAll(/^```(\w+)?\n([\s\S]*?)^```$/gm)) {
      const info = (match[1] ?? "").toLowerCase();
      if (info && !["bash", "sh", "shell", "zsh"].includes(info)) continue;
      for (const token of match[2].split(/\s+/)) {
        const candidate = token.trim().replace(/^[('"[{]+|[)\]}'";,:]+$/g, "");
        if (!candidate) continue;
        if (candidate.includes("<") || candidate.includes(">")) continue;
        if (candidate === "filename.md") continue;
        if (candidate.startsWith(".") && !candidate.startsWith(".mex/")) continue;
        const looksLikeMexPath = candidate.startsWith(".mex/");
        const looksLikeRelativeFile = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(candidate);
        if (!looksLikeMexPath && !looksLikeRelativeFile) continue;
        if (candidate.endsWith(".md") && !candidate.startsWith(".mex/")) continue;
        references.add(candidate);
      }
    }

    for (const reference of references) {
      const key = `${file}::${reference}`;
      if (allowedMissingReferences[key]) continue;
      const target = reference.startsWith(".mex/")
        ? join(scaffoldRoot, reference.slice(5))
        : join(dirname(join(scaffoldRoot, file)), reference);

      try {
        readFileSync(target, "utf-8");
      } catch {
        missing.add(`${file} → ${reference}`);
      }
    }
  }

  return [...missing].sort();
}
