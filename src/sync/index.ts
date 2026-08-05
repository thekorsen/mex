import chalk from "chalk";
import crossSpawn from "cross-spawn";
import { createInterface } from "node:readline";
import type { MexConfig, SyncTarget, DriftIssue, AiTool } from "../types.js";
import { AI_TOOLS } from "../types.js";
import { runDriftCheck } from "../drift/index.js";
import { isCliAvailable } from "../cli-tools.js";
import { buildSyncBrief, buildCombinedBrief } from "./brief-builder.js";
import { deliverBrief } from "./brief-delivery.js";
import { findScaffoldFiles } from "../drift/index.js";
import { captureGroundingBaselines, loadGroundingRuntime, persistMovedGroundings } from "../graph/runtime.js";

const INTERACTIVE_AI_TIMEOUT_MS = 15 * 60_000;

function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Executor form, not `Promise.withResolvers`: this package compiles at
  // `target: ES2022` (tsconfig.json:2) and withResolvers needs lib ES2024.
  return new Promise<string>((resolve, reject) => {
    // On EOF readline emits `close` and the `question` callback NEVER fires, so
    // an unguarded prompt used to leave sync silently exiting 0 with drift
    // unrepaired. Fail loudly instead; callers gate on a TTY check first.
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
    rl.once("close", () => {
      if (!answered) {
        reject(
          new Error(
            "mex sync needs a TTY to prompt, but stdin is closed. Use `mex sync --non-interactive` or `--dry-run`."
          )
        );
      }
    });
  });
}

export function runToolInteractive(tool: AiTool, brief: string, cwd: string): boolean {
  const meta = AI_TOOLS[tool];
  if (!meta.cli) return false;

  const delivery = deliverBrief(brief);
  const isOmp = meta === AI_TOOLS.omp;
  // OMP expands @<path> into the initial message, avoiding a read tool call. Its
  // inner deadline is one minute shorter than mex's outer process timeout so the
  // harness can stop cleanly before cross-spawn kills it. CLI and prompt flags
  // still come exclusively from AI_TOOLS.omp.
  const promptArg = isOmp && delivery.spillPath ? `@${delivery.spillPath}` : delivery.prompt;
  const ompTimeoutMinutes = INTERACTIVE_AI_TIMEOUT_MS / 60_000 - 1;
  const args = [
    ...meta.promptFlag,
    ...(isOmp ? [`--max-time=${ompTimeoutMinutes}m`] : []),
    promptArg,
  ];
  try {
    // cross-spawn resolves Windows `.cmd`/`.bat` wrappers (npm installs `claude`
    // as `claude.cmd`) and escapes args correctly — plain spawnSync throws ENOENT
    // on Windows, and `shell: true` mangles the multi-line prompt (issue #85).
    const result = crossSpawn.sync(meta.cli, args, {
      cwd,
      stdio: "inherit",
      timeout: INTERACTIVE_AI_TIMEOUT_MS,
    });
    // A spawn failure (ENOENT, etc.) sets `error` and leaves `status` null — don't
    // mistake that for success, and report it once because pre-fix E2BIG surfaced
    // only as a generic session failure, making an argv-sized brief look like the agent broke.
    if (result.error) {
      console.log(chalk.red("  ✗ " + meta.name + " could not run: " + result.error.message));
      return false;
    }
    return result.status === 0;
  } finally {
    // cross-spawn.sync blocks until the child exits, so the spill file necessarily
    // outlives the agent process and can be removed immediately after spawn returns.
    delivery.cleanup();
  }
}

/** Pick which AI tool to use for interactive sync */
async function pickSyncTool(configuredTools: AiTool[]): Promise<AiTool | null> {
  // Filter to tools that have a CLI and are installed
  let available = configuredTools.filter((t) => {
    const meta = AI_TOOLS[t];
    return meta.cli && isCliAvailable(meta.cli);
  });

  // If no configured tools matched, scan for any installed CLI and ask user
  if (available.length === 0) {
    const detected = (Object.keys(AI_TOOLS) as AiTool[]).filter((t) => {
      const meta = AI_TOOLS[t];
      return meta.cli && isCliAvailable(meta.cli);
    });

    if (detected.length === 0) return null;

    console.log(chalk.yellow("\nNo AI tool configured — but found installed CLI(s):"));
    console.log();
    detected.forEach((t, i) => {
      console.log(`  ${i + 1}) ${AI_TOOLS[t].name}`);
    });
    console.log();

    const choice = await askUser(`Which one should we use? [1-${detected.length}] (default: 1): `);
    const idx = parseInt(choice || "1", 10) - 1;
    return detected[idx] ?? detected[0];
  }

  if (available.length === 1) return available[0];

  // Multiple CLI tools available — ask user
  console.log(chalk.bold("\nWhich tool should fix these?"));
  console.log();
  available.forEach((t, i) => {
    console.log(`  ${i + 1}) ${AI_TOOLS[t].name}`);
  });
  console.log();

  const choice = await askUser(`Choice [1-${available.length}] (default: 1): `);
  const idx = parseInt(choice || "1", 10) - 1;
  return available[idx] ?? available[0];
}

type SyncMode = "interactive" | "prompts";

/** Run targeted sync: detect → brief → AI → verify → ask → loop */
export async function runSync(
  config: MexConfig,
  opts: { dryRun?: boolean; includeWarnings?: boolean; nonInteractive?: boolean }
): Promise<void> {
  let cycle = 0;
  let mode: SyncMode | null = null;
  let activeTool: AiTool | null = null;
  // Explicit flag wins; otherwise infer from the terminal — both ends must be a
  // TTY to prompt, since piped/closed stdin (CI, a bot) is never promptable.
  // Either way sync must reach a deterministic end without reading stdin.
  const nonInteractive =
    opts.nonInteractive === true ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true;

  while (true) {
    cycle++;

    // Step 1: Run drift check
    if (cycle === 1) {
      console.log(chalk.bold("Running drift check..."));
    } else {
      console.log(chalk.bold("\nRe-checking for remaining drift..."));
    }

    const scaffoldFiles = findScaffoldFiles(config.projectRoot, config.scaffoldRoot);
    if (!opts.dryRun) {
      const repairRuntime = await loadGroundingRuntime(config).catch(() => null);
      if (repairRuntime) {
        try {
          persistMovedGroundings(config, scaffoldFiles, repairRuntime);
        } catch {
          // Drift check owns the user-facing degradation warning; sync continues.
        } finally {
          // Always release the SQLite handle, even if persistence threw.
          repairRuntime.close();
        }
      }
    }
    const report = await runDriftCheck(config);

    if (report.issues.length === 0) {
      console.log(chalk.green("✓ No drift detected. Everything is in sync."));
      return;
    }

    console.log(
      chalk.yellow(
        `Found ${report.issues.length} issues (score: ${report.score}/100)`
      )
    );

    // Step 2: Group issues by file
    const relevantIssues = opts.includeWarnings
      ? report.issues
      : report.issues.filter((i) => {
          // Every grounding outcome is a repair path, including warning-only
          // inline GONE anchors; do not require --warnings to maintain pointers.
          if (i.code.startsWith("GROUNDING_")) return true;
          const fileHasError = report.issues.some(
            (other) => other.file === i.file && other.severity === "error"
          );
          return fileHasError;
        });

    if (relevantIssues.length === 0) {
      console.log(
        chalk.green(
          "No errors found. Only warnings remain (use --warnings to include them)."
        )
      );
      return;
    }

    const targets = groupIntoTargets(relevantIssues);

    console.log(
      chalk.bold(`\n${targets.length} file(s) need attention:\n`)
    );

    for (const target of targets) {
      const errors = target.issues.filter(
        (i) => i.severity === "error"
      ).length;
      const warnings = target.issues.filter(
        (i) => i.severity === "warning"
      ).length;
      console.log(
        `  ${target.file} — ${errors} errors, ${warnings} warnings`
      );
    }

    // Dry run — show combined prompt and exit
    if (opts.dryRun) {
      console.log(
        chalk.dim("\n--dry-run: showing prompt without executing\n")
      );
      const brief = await buildGroundingAwareBrief(targets, config);
      console.log(brief);
      console.log();
      return;
    }

    // Headless: emit the brief for a bot/agent to act on, never prompt. This is
    // a *reporting* path by design — sync does not repair unattended.
    if (nonInteractive) {
      console.log(
        chalk.dim(
          "\nnon-interactive: emitting the repair brief without launching an agent\n"
        )
      );
      const brief = await buildGroundingAwareBrief(targets, config);
      console.log(brief);
      console.log();
      return;
    }

    // Ask user for mode (only on first cycle)
    if (mode === null) {
      // Determine if any configured tool has a usable CLI
      const syncTool = await pickSyncTool(config.aiTools);
      const toolName = syncTool ? AI_TOOLS[syncTool].name : null;

      console.log(chalk.bold("\nHow should we fix these?"));
      console.log();
      if (toolName) {
        console.log(`  1) Interactive — ${toolName} fixes with you watching (default)`);
      } else {
        console.log("  1) Interactive — AI fixes with you watching (default)");
      }
      console.log("  2) Show prompts — I'll paste manually");
      console.log("  3) Exit");
      console.log();

      const choice = await askUser("Choice [1-3] (default: 1): ");
      const picked = choice || "1";

      switch (picked) {
        case "1":
          if (!syncTool) {
            console.log(chalk.yellow("No supported AI CLI detected. Falling back to prompts mode."));
            // Derive the visible CLI list from AI_TOOLS so a new tool cannot be missing from it.
            console.log(chalk.dim("Supported CLIs: " + (Object.keys(AI_TOOLS) as AiTool[])
              .filter((tool) => AI_TOOLS[tool].cli)
              .map((tool) => AI_TOOLS[tool].cli)
              .join(", ")));
            console.log();
            mode = "prompts";
          } else {
            activeTool = syncTool;
            mode = "interactive";
          }
          break;
        case "2":
          mode = "prompts";
          break;
        case "3":
          console.log(chalk.dim("Exiting. Run mex sync again anytime."));
          return;
        default:
          console.log(chalk.dim("Exiting."));
          return;
      }
    }

    // Show prompts mode — print combined prompt and exit
    if (mode === "prompts") {
      const brief = await buildGroundingAwareBrief(targets, config);
      console.log(brief);
      console.log();
      return;
    }

    // Step 3: Fix all files in one interactive session
    console.log();
    const toolLabel = activeTool ? AI_TOOLS[activeTool].name : "AI";
    console.log(chalk.bold(`\nSending all ${targets.length} file(s) to ${toolLabel} in one session...\n`));

    const brief = await buildGroundingAwareBrief(targets, config);
    const ok = runToolInteractive(activeTool!, brief, config.projectRoot);

    if (!ok) {
      console.log(chalk.red(`  ✗ ${toolLabel} session failed`));
    } else {
      try {
        await captureGroundingBaselines(config, { updateFingerprints: true });
      } catch {
        // The following drift check reports graph degradation without crashing sync.
      }
    }

    // Step 4: Verify
    const postReport = await runDriftCheck(config);
    const scoreDelta = postReport.score - report.score;
    const deltaStr =
      scoreDelta > 0
        ? chalk.green(`+${scoreDelta}`)
        : scoreDelta === 0
          ? chalk.yellow("+0")
          : chalk.red(`${scoreDelta}`);

    console.log(
      chalk.bold(
        `\nDrift score: ${report.score} → ${postReport.score}/100 (${deltaStr})`
      )
    );

    // Step 5: Check if we should continue
    const remainingErrors = postReport.issues.filter(
      (i) => i.severity === "error"
    ).length;
    const remainingWarnings = postReport.issues.filter(
      (i) => i.severity === "warning"
    ).length;

    if (remainingErrors === 0 && !opts.includeWarnings) {
      if (remainingWarnings > 0) {
        console.log(
          chalk.dim(
            `${remainingWarnings} warning(s) remain (use --warnings to include them).`
          )
        );
      } else {
        console.log(chalk.green("✓ All issues resolved."));
      }
      return;
    }

    if (postReport.score === 100) {
      console.log(chalk.green("✓ Perfect score. All issues resolved."));
      return;
    }

    // Ask user whether to continue
    const remaining = opts.includeWarnings
      ? remainingErrors + remainingWarnings
      : remainingErrors;

    const answer = await askUser(
      `\n${remaining} issue(s) remain. Run another cycle? [Y/n] `
    );

    if (answer.toLowerCase() === "n") {
      console.log(chalk.dim("Stopped. Run mex sync again anytime."));
      return;
    }
  }
}

async function buildGroundingAwareBrief(targets: SyncTarget[], config: MexConfig): Promise<string> {
  try {
    const runtime = await loadGroundingRuntime(config);
    if (!runtime) return buildCombinedBrief(targets, config.projectRoot);
    try {
      return await buildCombinedBrief(targets, config.projectRoot, { config, runtime });
    } finally {
      runtime.close();
    }
  } catch {
    return buildCombinedBrief(targets, config.projectRoot);
  }
}

function groupIntoTargets(issues: DriftIssue[]): SyncTarget[] {
  const byFile = new Map<string, DriftIssue[]>();
  for (const issue of issues) {
    if (!byFile.has(issue.file)) byFile.set(issue.file, []);
    byFile.get(issue.file)!.push(issue);
  }

  return Array.from(byFile.entries()).map(([file, issues]) => ({
    file,
    issues,
    gitDiff: null,
  }));
}
