import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { execSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { stdin, stdout } from "node:process";
import { globSync } from "glob";
import chalk from "chalk";
import {
  buildFreshPrompt,
  buildExistingWithBriefPrompt,
  buildExistingNoBriefPrompt,
} from "./prompts.js";
import { saveAiTools, ensureScaffoldIdentity, findGitRoot } from "../config.js";
import { isCliAvailable } from "../cli-tools.js";
import { captureGroundingBaselines } from "../graph/runtime.js";
import { extractFrontmatter } from "../markdown.js";
import type { AiTool } from "../types.js";

// ── Constants ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = resolve(__dirname, "../templates");

const SOURCE_EXTENSIONS = [
  "*.py", "*.js", "*.ts", "*.tsx", "*.jsx", "*.go", "*.rs", "*.java",
  "*.kt", "*.swift", "*.rb", "*.php", "*.c", "*.cpp", "*.cs", "*.ex",
  "*.exs", "*.zig", "*.lua", "*.dart", "*.scala", "*.clj", "*.erl",
  "*.hs", "*.ml", "*.vue", "*.svelte",
];

const SCAFFOLD_FILES = [
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

const AGENT_MEMORY_FILES = [
  ...SCAFFOLD_FILES,
  "HEARTBEAT.md",
];

const TOOL_CONFIGS: Record<string, { src: string; dest: string }> = {
  "1": { src: ".tool-configs/CLAUDE.md", dest: "CLAUDE.md" },
  "2": { src: ".tool-configs/.cursorrules", dest: ".cursorrules" },
  "3": { src: ".tool-configs/.windsurfrules", dest: ".windsurfrules" },
  "4": { src: ".tool-configs/copilot-instructions.md", dest: ".github/copilot-instructions.md" },
  "5": { src: ".tool-configs/opencode.json", dest: ".opencode/opencode.json" },
  "6": { src: ".tool-configs/CLAUDE.md", dest: "AGENTS.md" },  // Codex reads AGENTS.md at root
  "7": { src: "omp/AGENTS.md", dest: ".omp/AGENTS.md" },       // oh-my-pi: native anchor bridge
};

/**
 * Where `mex setup` installs oh-my-pi artifacts, relative to the project root.
 *
 * omp discovers these natively at priority 100 and dedups **first-wins by bare
 * name**, so every generated name is `mex-`-prefixed and can never shadow a
 * rule, skill, or command the user wrote themselves.
 *
 * `anchor` is a thin bridge holding a single `@../.mex/AGENTS.md` import rather
 * than a copy of the anchor text — `.mex/AGENTS.md` stays the one source of
 * truth. See `docs/omp-integration/notes/1-omp-anchor-shape.md`.
 */
export const ompArtifactPaths = {
  anchor: ".omp/AGENTS.md",
  stickyRules: ".omp/RULES.md",
  rulesDir: ".omp/rules",
  skillsDir: ".omp/skills",
  commandsDir: ".omp/commands",
} as const;

/** Static omp artifacts, copied verbatim from `templates/omp/`. */
const OMP_STATIC_ARTIFACTS = [
  "RULES.md",
  "rules/mex-router.md",
  "rules/mex-graph.md",
  "rules/mex-grow.md",
  "skills/mex-wiki/SKILL.md",
  "commands/mex-check.md",
  "commands/mex-sync.md",
  "commands/mex-graph-scope.md",
];

// ── Helpers ──

const ok = (msg: string) => console.log(`${chalk.green("✓")} ${msg}`);
const info = (msg: string) => console.log(`${chalk.blue("→")} ${msg}`);
const warn = (msg: string) => console.log(`${chalk.yellow("!")} ${msg}`);
const header = (msg: string) => console.log(`\n${chalk.bold(msg)}`);


function isTemplateContent(content: string): boolean {
  return content.includes("[Project Name]") || content.includes("[YYYY-MM-DD]");
}

/**
 * Install the oh-my-pi rulebook, sticky rules, skill, and slash commands.
 *
 * Called only when the user selects the omp target. Existing files are never
 * overwritten, matching the anchor behavior at {@link selectToolConfig}, so a
 * user who has customised a generated rule keeps their version.
 *
 * Per-pattern rules are a **static projection**: the body holds pointers into
 * `.mex/`, and the only derived field is the pattern's `description`. That one
 * projection is what `OMP_RULE_DRIFT` verifies. See
 * `docs/omp-integration/notes/13-router-to-omp-rulebook.md`.
 */
function writeOmpArtifacts(projectRoot: string, dryRun: boolean): void {
  const copyArtifact = (rel: string, dest: string) => {
    const src = resolve(TEMPLATES_DIR, "omp", rel);
    if (!existsSync(src)) return;
    const target = resolve(projectRoot, dest);

    if (dryRun) {
      ok(`(dry run) Would copy ${dest}`);
      return;
    }
    if (existsSync(target)) {
      warn(`${dest} already exists — skipped (delete it first to replace)`);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
    ok(`Copied ${dest}`);
  };

  for (const rel of OMP_STATIC_ARTIFACTS) {
    copyArtifact(rel, `.omp/${rel}`);
  }

  for (const { slug, description } of readPatternDescriptions(projectRoot)) {
    const dest = `${ompArtifactPaths.rulesDir}/mex-pattern-${slug}.md`;
    const target = resolve(projectRoot, dest);

    if (dryRun) {
      ok(`(dry run) Would generate ${dest}`);
      continue;
    }
    if (existsSync(target)) {
      warn(`${dest} already exists — skipped (delete it first to regenerate)`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buildPatternRule(slug, description));
    ok(`Generated ${dest}`);
  }
}

/**
 * Read `name`/`description` from each `.mex/patterns/<slug>.md`, skipping the
 * authoring spec and the index, which are not patterns. A pattern without a
 * usable `description` is skipped rather than projected with a placeholder: omp
 * requires a `description` for rulebook inclusion, so a generated rule without
 * a real one would be invisible anyway.
 */
function readPatternDescriptions(projectRoot: string): Array<{ slug: string; description: string }> {
  const patternsDir = resolve(projectRoot, ".mex", "patterns");
  if (!existsSync(patternsDir)) return [];

  const projected: Array<{ slug: string; description: string }> = [];
  for (const file of globSync("*.md", { cwd: patternsDir })) {
    const slug = file.replace(/\.md$/, "");
    if (slug === "README" || slug === "INDEX") continue;
    try {
      const description = extractFrontmatter(readFileSync(resolve(patternsDir, file), "utf-8"))?.description;
      if (typeof description === "string" && description.trim()) {
        projected.push({ slug, description: description.trim() });
      }
    } catch {
      // Unreadable pattern — skip rather than fail the whole setup.
    }
  }
  return projected;
}

/**
 * A per-pattern rulebook rule. Carries `description` and no `alwaysApply`:
 * setting both would move the rule into the always-apply bucket and silently
 * exclude it from the rulebook (`omp://rulebook-matching-pipeline.md:198-202`).
 * The rule `name` is the filename, so no frontmatter `name` is emitted.
 */
function buildPatternRule(slug: string, description: string): string {
  return `---
description: ${JSON.stringify(description)}
---

<!-- mex-generated -->

# Pattern: ${slug}

Read \`.mex/patterns/${slug}.md\` and follow its Steps before writing code.

If you are about to deviate from this pattern, say so and why first. If you learn a
gotcha the pattern does not cover, update the pattern as part of the GROW step.

<!-- Projected from \`.mex/patterns/${slug}.md\` by \`mex setup\`. The body is a pointer,
     so only the description above can go stale; \`mex check\` reports that as
     OMP_RULE_DRIFT, and a deleted source pattern as OMP_RULE_ORPHAN. -->
`;
}

const GITIGNORE_MARKER = "# mex — generated artifacts";

/**
 * Ignore the generated code graph so consumers do not commit a binary SQLite
 * database, plus its WAL/SHM sidecars (WAL mode is on — `src/graph/database.ts:31`).
 *
 * Appends a marked block, mirroring how {@link installHook} appends to an
 * existing git hook (`src/watch.ts:83-99`): existing content is preserved
 * byte-for-byte above the block, and the marker makes the append idempotent.
 *
 * `.mex/events/decisions.jsonl` is deliberately **not** ignored — it is
 * append-only, line-oriented, merges tolerably, and is meant to be shared. The
 * emitted comment says so, so nobody "cleans it up" later.
 */
function ensureGitignoreRule(projectRoot: string, dryRun: boolean): void {
  const gitignorePath = resolve(projectRoot, ".gitignore");
  const block = `${GITIGNORE_MARKER}
# The code graph is a generated SQLite database (plus WAL/SHM sidecars) — never commit it.
# Rebuild it with \`mex graph\`.
.mex/graph.db*
# NOT ignored, on purpose: .mex/events/decisions.jsonl is append-only, merges
# tolerably, and is meant to be committed and shared. Do not add it here.
`;

  if (existsSync(gitignorePath)) {
    let existing: string;
    try {
      existing = readFileSync(gitignorePath, "utf-8");
    } catch {
      warn("Could not read .gitignore — add `.mex/graph.db*` manually");
      return;
    }

    // Already handled, either by us or by a hand-written rule.
    if (existing.includes(GITIGNORE_MARKER) || /^\s*\.mex\/graph\.db\*?\s*$/m.test(existing)) {
      info("Skipped .gitignore (.mex/graph.db* already ignored)");
      return;
    }

    if (dryRun) {
      ok("(dry run) Would append .mex/graph.db* to .gitignore");
      return;
    }

    writeFileSync(gitignorePath, `${existing.trimEnd()}\n\n${block}`);
    ok("Added .mex/graph.db* to existing .gitignore");
    return;
  }

  if (dryRun) {
    ok("(dry run) Would create .gitignore with .mex/graph.db*");
    return;
  }

  writeFileSync(gitignorePath, block);
  ok("Created .gitignore ignoring .mex/graph.db*");
}

function banner() {
  const GRN = "\x1b[38;2;91;140;90m";
  const DGR = "\x1b[38;2;74;122;73m";
  const ORN = "\x1b[38;2;232;132;92m";
  const DRK = "\x1b[38;2;61;61;61m";
  const ROYAL = "\x1b[38;2;25;68;241m";
  const NC = "\x1b[0m";
  const BOLD = "\x1b[1m";

  console.log();
  console.log(`${GRN}     ████      ${ROYAL}███╗   ███╗███████╗██╗  ██╗${NC}`);
  console.log(`${GRN}    █${DGR}█${GRN}██${DGR}█${GRN}█     ${ROYAL}████╗ ████║██╔════╝╚██╗██╔╝${NC}`);
  console.log(`${ORN}  ██████████   ${ROYAL}██╔████╔██║█████╗   ╚███╔╝${NC}`);
  console.log(`${ORN}█ ██${DRK}██${ORN}██${DRK}██${ORN}██ █ ${ROYAL}██║╚██╔╝██║██╔══╝   ██╔██╗${NC}`);
  console.log(`${ORN}█ ██████████ █ ${ROYAL}██║ ╚═╝ ██║███████╗██╔╝ ██╗${NC}`);
  console.log(`${ORN}   █ █  █ █    ${ROYAL}╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝${NC}`);
  console.log();
  console.log(`               ${BOLD}universal ai context scaffold${NC}`);
}

// ── Main ──

type ProjectState = "existing" | "fresh" | "partial";

type SetupMode = "code-repo" | "agent-memory";

export async function runSetup(opts: { dryRun?: boolean; mode?: string } = {}): Promise<void> {
  const { dryRun = false } = opts;
  const mode = normalizeMode(opts.mode);

  banner();
  console.log();

  if (dryRun) {
    warn("DRY RUN — no files will be created or modified");
    console.log();
  }

  // Verify templates directory exists (sanity check for npm package integrity)
  if (!existsSync(TEMPLATES_DIR)) {
    throw new Error(
      `Templates directory not found at ${TEMPLATES_DIR}. The mex-agent package may be corrupted — try reinstalling.`
    );
  }

  // Resolve by the same rule as every other command (`findConfig`, src/config.ts:65),
  // so setup run from a subdirectory scaffolds the repo root rather than the cwd.
  // `findConfig` itself is unusable here: it requires the `.mex/` scaffold this
  // command creates. Degrading to the cwd is deliberate — `mex setup` in a
  // not-yet-git directory is a legitimate first move.
  const projectRoot = findGitRoot(process.cwd()) ?? process.cwd();
  const mexDir = resolve(projectRoot, ".mex");

  // Guard: don't run inside the mex repo itself
  if (existsSync(resolve(projectRoot, "src", "setup", "index.ts"))) {
    const pkg = resolve(projectRoot, "package.json");
    if (existsSync(pkg)) {
      const pkgContent = readFileSync(pkg, "utf-8");
      if (pkgContent.includes('"promexeus"') || pkgContent.includes('"mex"')) {
        throw new Error(
          "You're inside the mex repository itself. Run this from your project root instead."
        );
      }
    }
  }

  // ── Step 1: Detect project state ──

  const state = detectProjectState(projectRoot, mexDir);

  if (mode === "agent-memory") {
    info("Detected: agent-memory workspace");
    info("Mode: persistent-agent operational memory");
  } else {
    switch (state) {
      case "existing":
        info("Detected: existing codebase with source files");
        info("Mode: populate scaffold from code");
        break;
      case "fresh":
        info("Detected: fresh project (no source files yet)");
        info("Mode: populate scaffold from intent");
        break;
      case "partial":
        info("Detected: existing codebase with partially populated scaffold");
        info("Mode: will populate empty slots, skip what's already filled");
        break;
    }
  }
  console.log();

  // ── Step 2: Create .mex/ scaffold ──

  header("Creating .mex/ scaffold...");
  console.log();

  const scaffoldFiles = mode === "agent-memory" ? AGENT_MEMORY_FILES : SCAFFOLD_FILES;
  for (const file of scaffoldFiles) {
    const agentMemorySrc = resolve(TEMPLATES_DIR, "agent-memory", file);
    const src = mode === "agent-memory" && existsSync(agentMemorySrc)
      ? agentMemorySrc
      : resolve(TEMPLATES_DIR, file);
    const dest = resolve(mexDir, file);

    if (existsSync(dest)) {
      const existingContent = readFileSync(dest, "utf-8");
      const templateContent = readFileSync(src, "utf-8");

      // Skip if file has been populated (no longer matches template markers)
      if (!isTemplateContent(existingContent) && existingContent !== templateContent) {
        info(`Skipped .mex/${file} (already populated)`);
        continue;
      }
    }

    if (dryRun) {
      ok(`(dry run) Would copy .mex/${file}`);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      ok(`Copied .mex/${file}`);
    }
  }

  ensureGitignoreRule(projectRoot, dryRun);
  console.log();

  // ── Step 3: Tool config selection ──

  let selectedClaude = false;

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    selectedClaude = await selectToolConfig(rl, projectRoot, dryRun);
  } finally {
    rl.close();
  }
  console.log();

  // Mint a stable scaffold identity. Independent of tool selection so a setup
  // that picks no AI tool still gets a scaffold_id written to config.json.
  if (!dryRun) {
    ensureScaffoldIdentity(mexDir, projectRoot);
  }

  // ── Step 4: Run scanner (if not fresh) ──

  let scannerBrief: string | null = null;

  if (mode !== "agent-memory" && state !== "fresh") {
    try {
      info("Scanning codebase...");
      const { runScan } = await import("../scanner/index.js");
      const config = { projectRoot, scaffoldRoot: mexDir, aiTools: [] as AiTool[] };
      const result = await runScan(config, { jsonOnly: true });
      scannerBrief = JSON.stringify(result, null, 2);
      ok("Pre-analysis complete — AI will reason from brief instead of exploring");
    } catch {
      warn("Scanner failed — AI will explore the filesystem directly");
    }
  }

  // Fresh installs get the additive code graph by default. A missing runtime,
  // grammar, or SQLite capability must never make scaffold setup unusable.
  if (mode === "code-repo" && !dryRun) {
    try {
      info("Building code graph...");
      const { createGraphEngine } = await import("../graph/index.js");
      const graph = createGraphEngine({ rootDir: projectRoot });
      try {
        await graph.build();
        ok("Code graph ready");
      } finally {
        graph.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`Code graph unavailable — setup will continue: ${message}`);
    }
  }

  // ── Step 5: Build population prompt ──

  let prompt: string;
  if (mode === "agent-memory") {
    const { buildAgentMemoryPrompt } = await import("./prompts.js");
    prompt = buildAgentMemoryPrompt();
  } else if (state === "fresh") {
    prompt = buildFreshPrompt();
  } else if (scannerBrief) {
    prompt = buildExistingWithBriefPrompt(scannerBrief);
  } else {
    prompt = buildExistingNoBriefPrompt();
  }

  // ── Step 6: Run or print ──

  if (dryRun) {
    header("Would run population prompt (dry run — skipping)");
    console.log();
    ok("Done (dry run).");
    return;
  }

  const hasClaude = hasClaudeCli();

  if (selectedClaude && hasClaude) {
    header("Launching Claude Code to populate the scaffold...");
    console.log();
    info("An interactive Claude Code session will open with the population prompt.");
    info("You'll see the agent working in real-time.");
    console.log();

    try {
      await launchClaude(prompt);
      if (mode === "code-repo") {
        try {
          const result = await captureGroundingBaselines(
            { projectRoot, scaffoldRoot: mexDir, aiTools: [] },
            { warn },
          );
          if (result.captured > 0) ok(`Captured ${result.captured} grounding baseline(s)`);
          else warn("No grounding baselines were captured; verify the agent authored grounding.");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warn(`Grounding baselines unavailable — setup will continue: ${message}`);
        }
      }
      console.log();
      ok("Setup complete.");
    } catch (err) {
      // A launch/exit failure must not crash setup with an unhandled
      // rejection — report it and fall back to the manual-paste prompt.
      console.log();
      warn(`Couldn't run Claude Code automatically: ${(err as Error).message}`);
      info("Paste the prompt below into your AI tool to populate the scaffold instead.");
      printPromptForManualPaste(prompt);
      await confirmAndCaptureGrounding(projectRoot, mexDir, mode);
    }
    await promptGlobalInstall();
    return;
  } else {
    header("Almost done. One more step — populate the scaffold.");
    console.log();

    if (hasClaude) {
      info("You can run this directly with Claude Code:");
      console.log();
      console.log("  claude -p '<the prompt below>'");
      console.log();
      info("Or paste the prompt below into your AI tool.");
    } else {
      info("Paste the prompt below into your AI tool.");
      info("The agent will read your codebase and fill every scaffold file.");
    }

    printPromptForManualPaste(prompt);
    await confirmAndCaptureGrounding(projectRoot, mexDir, mode);
  }

  await promptGlobalInstall();
}

function normalizeMode(raw: string | undefined): SetupMode {
  const mode = raw ?? "code-repo";
  if (mode === "code-repo" || mode === "agent-memory") return mode;
  throw new Error(`Unknown setup mode "${mode}". Use code-repo or agent-memory.`);
}

// ── Step functions ──

function detectProjectState(projectRoot: string, mexDir: string): ProjectState {
  // Check if scaffold is already partially populated
  const agentsMd = resolve(mexDir, "AGENTS.md");
  let scaffoldPopulated = false;
  if (existsSync(agentsMd)) {
    const content = readFileSync(agentsMd, "utf-8");
    if (!content.includes("[Project Name]")) {
      scaffoldPopulated = true;
    }
  }

  // Count source files
  const patterns = SOURCE_EXTENSIONS.map(
    (ext) => `**/${ext}`
  );
  const sourceFiles = globSync(patterns, {
    cwd: projectRoot,
    ignore: ["**/node_modules/**", "**/.mex/**", "**/vendor/**", "**/.git/**"],
    maxDepth: 4,
    nodir: true,
  });

  if (scaffoldPopulated && sourceFiles.length > 0) {
    return "partial";
  } else if (sourceFiles.length > 3) {
    return "existing";
  } else {
    return "fresh";
  }
}

const TOOL_CHOICE_MAP: Record<string, AiTool> = {
  "1": "claude",
  "2": "cursor",
  "3": "windsurf",
  "4": "copilot",
  "5": "opencode",
  "6": "codex",
  "7": "omp",
};

async function selectToolConfig(
  rl: ReturnType<typeof createInterface>,
  projectRoot: string,
  dryRun: boolean,
): Promise<boolean> {
  header("Which AI tool do you use?");
  console.log();
  console.log("  1) Claude Code");
  console.log("  2) Cursor");
  console.log("  3) Windsurf");
  console.log("  4) GitHub Copilot");
  console.log("  5) OpenCode");
  console.log("  6) Codex (OpenAI)");
  console.log("  7) oh-my-pi (omp)");
  console.log("  8) Multiple (select next)");
  console.log("  9) None / skip");
  console.log();

  const choice = (await rl.question("Choice [1-9] (default: 1): ")).trim() || "1";

  let selectedClaude = false;
  const selectedTools: AiTool[] = [];

  const copyAnchor = (config: { src: string; dest: string }) => {
    const src = resolve(TEMPLATES_DIR, config.src);
    const dest = resolve(projectRoot, config.dest);

    if (dryRun) {
      if (existsSync(dest)) {
        warn(`(dry run) Would overwrite ${config.dest}`);
      } else {
        ok(`(dry run) Would copy ${config.dest}`);
      }
      return;
    }

    if (existsSync(dest)) {
      // Can't ask interactively here since we already have rl,
      // so just warn and skip
      warn(`${config.dest} already exists — skipped (delete it first to replace)`);
      return;
    }

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    ok(`Copied ${config.dest}`);
  };

  const copyConfig = (key: string) => {
    const config = TOOL_CONFIGS[key];
    if (!config) return;

    if (key === "1") selectedClaude = true;
    const tool = TOOL_CHOICE_MAP[key];
    if (tool) selectedTools.push(tool);

    copyAnchor(config);

    // omp gets the rulebook, sticky rules, skill, and commands alongside its
    // anchor. Runs even when the anchor was skipped, so a re-run still installs
    // artifacts added by a later mex version.
    if (tool === "omp") writeOmpArtifacts(projectRoot, dryRun);
  };

  switch (choice) {
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
      copyConfig(choice);
      break;
    case "8": {
      const multi = (await rl.question("Enter tool numbers separated by spaces (e.g. 1 2 5): ")).trim();
      for (const c of multi.split(/\s+/)) {
        copyConfig(c);
      }
      break;
    }
    case "9":
      info("Skipped tool config — AGENTS.md in .mex/ works with any tool that can read files");
      break;
    default:
      warn("Unknown choice, skipping tool config");
      break;
  }

  // Persist tool selection
  if (selectedTools.length > 0 && !dryRun) {
    const mexDir = resolve(projectRoot, ".mex");
    saveAiTools(mexDir, selectedTools);
  }

  return selectedClaude;
}

function printPromptForManualPaste(prompt: string): void {
  console.log();
  console.log("─────────────────── COPY BELOW THIS LINE ───────────────────");
  console.log();
  console.log(prompt);
  console.log();
  console.log("─────────────────── COPY ABOVE THIS LINE ───────────────────");
  console.log();
  ok("Paste the prompt above into your agent to populate the scaffold.");
}

async function confirmAndCaptureGrounding(
  projectRoot: string,
  mexDir: string,
  mode: SetupMode,
): Promise<void> {
  if (mode !== "code-repo" || !stdin.isTTY) return;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log();
    info("After the agent finishes populating, return here to capture grounding baselines.");
    const answer = (await rl.question("  Has population finished? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") return;
    const result = await captureGroundingBaselines(
      { projectRoot, scaffoldRoot: mexDir, aiTools: [] },
      { warn },
    );
    if (result.captured > 0) ok(`Captured ${result.captured} grounding baseline(s)`);
    else warn("No grounding baselines were captured; verify the agent authored grounding.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Grounding baselines unavailable — setup will continue: ${message}`);
  } finally {
    rl.close();
  }
}

function hasClaudeCli(): boolean {
  return isCliAvailable("claude");
}

function launchClaude(prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // cross-spawn resolves the Windows `claude.cmd` wrapper and escapes the
    // prompt correctly. Plain spawn threw ENOENT on Windows (issue #85).
    const child = crossSpawn("claude", [prompt], {
      stdio: "inherit",
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Claude exited with code ${code}`));
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to launch Claude: ${err.message}`));
    });
  });
}

async function promptGlobalInstall(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    header("One more thing");
    console.log();
    info("Install mex globally so `mex check` works anywhere?");
    console.log();

    const answer = (await rl.question("  Install mex globally? [Y/n] ")).trim().toLowerCase();

    if (answer === "" || answer === "y" || answer === "yes") {
      console.log();
      info("Installing mex-agent globally...");
      try {
        execSync("npm install -g mex-agent", { stdio: "inherit" });
        console.log();
        ok("Installed globally. `mex check` and `mex sync` work from anywhere now.");
        printNextSteps(true);
      } catch {
        console.log();
        warn("Global install failed. You can retry manually:");
        console.log("    npm install -g mex-agent");
        console.log();
        printNextSteps(false);
      }
    } else {
      console.log();
      info("No problem. You can always install later:");
      console.log("    npm install -g mex-agent");
      console.log();
      printNextSteps(false);
    }
  } finally {
    rl.close();
  }
}

function printNextSteps(globalInstalled: boolean) {
  header("What's next");
  console.log();
  info("Verify — start a fresh session and ask:");
  console.log('    "Read .mex/ROUTER.md and tell me what you know about this project."');
  console.log();

  if (globalInstalled) {
    info("Ongoing commands:");
    console.log("    mex check              Drift score — are scaffold files still accurate?");
    console.log("    mex check --quiet      One-liner drift score");
    console.log("    mex sync               Fix drift — AI updates only what's broken");
    console.log("    mex watch              Auto-check drift after every commit");
  } else {
    info("Ongoing commands (via npx):");
    console.log("    npx mex-agent check                Drift score — are scaffold files still accurate?");
    console.log("    npx mex-agent check --quiet        One-liner drift score");
    console.log("    npx mex-agent sync                 Fix drift — AI updates only what's broken");
    console.log("    npx mex-agent watch                Auto-check drift after every commit");
    console.log();
    info("Or install globally to use the shorter `mex` command:");
    console.log("    npm install -g mex-agent");
  }
  console.log();
}
