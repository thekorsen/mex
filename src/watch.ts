import { writeFileSync, readFileSync, existsSync, chmodSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { MexConfig } from "./types.js";
import { runHeartbeat } from "./heartbeat.js";
import { resolveHooksDir } from "./config.js";

const HOOK_MARKER = "# mex-drift-check";
/** Closes the block opened by {@link HOOK_MARKER}. Written so uninstall can delete an
 *  exact range instead of guessing at line prefixes. Hooks written before this marker
 *  existed still uninstall via the legacy prefix path in {@link uninstallHook}. */
const HOOK_END_MARKER = "# mex-drift-check:end";

const SHEBANG = "#!/bin/sh";

/**
 * The mex block, WITHOUT a shebang — that belongs to the hook file, not to our
 * section, since we may be appending to a hook someone else already owns.
 *
 * Takes no config on purpose: git runs `post-commit` from the repo's COMMON hook
 * dir, so ONE file is shared by every worktree of the repo (verified on git
 * 2.50.1 — a hook under `.git/worktrees/<n>/hooks/` never fires). Baking in an
 * install-time absolute path would therefore be wrong for every checkout except
 * the one that happened to run `mex watch`. Everything resolves at run time from
 * `$ROOT`, the checkout that is actually committing.
 */
function buildHookContent(): string {
  return `${HOOK_MARKER}
# Auto-installed by mex watch — runs drift check after each commit.
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$ROOT" ] || exit 0
cd "$ROOT" || exit 0
# Prefer a built CLI in the committing checkout, then a local install, then the
# published package. Resolved here rather than at install time: the old
# resolve(config.scaffoldRoot, "dist", "cli.js") meant <projectRoot>/.mex/dist/cli.js,
# which exists in no checkout, so that branch was dead and this always fell through.
# The published package is mex-agent, not mex — \`npx mex\` fetches something unrelated.
if [ -f "$ROOT/dist/cli.js" ]; then
  SCORE=$(node "$ROOT/dist/cli.js" check --quiet 2>&1) || true
elif [ -x "$ROOT/node_modules/.bin/mex" ]; then
  SCORE=$("$ROOT/node_modules/.bin/mex" check --quiet 2>&1) || true
else
  SCORE=$(npx --yes mex-agent check --quiet 2>&1) || true
fi
# Only show output if there are issues (not a perfect score)
case "$SCORE" in
  *"100/100"*) ;;
  *) echo "$SCORE" ;;
esac
${HOOK_END_MARKER}
`;
}

export async function manageHook(
  config: MexConfig,
  opts: { uninstall?: boolean; intervalMinutes?: number }
): Promise<void> {
  if (opts.intervalMinutes) {
    await runWatchInterval(config, opts.intervalMinutes);
    return;
  }

  const hooksDir = resolveHooksDir(config.projectRoot);
  if (!hooksDir) {
    throw new Error("Not a git repository — mex watch installs a post-commit hook and needs one. Initialize one first: git init");
  }

  const hookPath = resolve(hooksDir, "post-commit");

  if (opts.uninstall) {
    uninstallHook(hookPath);
    return;
  }

  mkdirSync(hooksDir, { recursive: true });
  installHook(hookPath);
}

export async function runWatchInterval(config: MexConfig, intervalMinutes: number): Promise<void> {
  console.log(chalk.green(`mex heartbeat running every ${intervalMinutes} minute${intervalMinutes === 1 ? "" : "s"}. Press Ctrl+C to stop.`));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    try {
      await runHeartbeat(config);
    } catch (err) {
      console.error((err as Error).message);
    }
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    console.log(chalk.dim("mex heartbeat stopped."));
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await run();
      scheduleNext();
    }, intervalMinutes * 60_000);
  };

  await run();
  scheduleNext();
}

function installHook(hookPath: string): void {
  const hookContent = buildHookContent();

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      console.log(chalk.yellow("mex post-commit hook is already installed."));
      return;
    }

    // Append our block to the hook the user already has, keeping their shebang.
    const updated = existing.trimEnd() + "\n\n" + hookContent;
    writeFileSync(hookPath, updated);
    chmodSync(hookPath, 0o755);
    console.log(
      chalk.green("Added mex drift check to existing post-commit hook.")
    );
    return;
  }

  writeFileSync(hookPath, SHEBANG + "\n" + hookContent);
  chmodSync(hookPath, 0o755);
  console.log(chalk.green("Installed mex post-commit hook."));
}

function uninstallHook(hookPath: string): void {
  if (!existsSync(hookPath)) {
    console.log(chalk.yellow("No post-commit hook found."));
    return;
  }

  const content = readFileSync(hookPath, "utf-8");
  if (!content.includes(HOOK_MARKER)) {
    console.log(
      chalk.yellow("post-commit hook exists but was not installed by mex.")
    );
    return;
  }

  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.includes(HOOK_MARKER));
  const end = lines.findIndex((l, i) => i > start && l.includes(HOOK_END_MARKER));

  let filtered: string[];
  if (end !== -1) {
    // Current format: the block is delimited, so remove exactly [start, end].
    filtered = [...lines.slice(0, start), ...lines.slice(end + 1)];
  } else {
    // Legacy format (no end marker): fall back to skipping lines that look like
    // ours. Only the shapes older mex versions actually emitted are listed —
    // matching generic shell (`else`, `fi`) would eat a user's own lines that
    // happen to follow our block.
    filtered = [];
    let inMexBlock = false;
    for (const [i, line] of lines.entries()) {
      if (i === start) {
        inMexBlock = true;
        continue;
      }
      if (inMexBlock) {
        if (line.startsWith("#") || line.startsWith("SCORE=") ||
            line.startsWith("case") || line.startsWith("  *") ||
            line.startsWith("esac") || line.startsWith("npx mex") ||
            line.startsWith("node ") || line.trim() === "") {
          continue;
        }
        inMexBlock = false;
      }
      filtered.push(line);
    }
  }

  const remaining = filtered.join("\n").trim();
  if (remaining === SHEBANG || remaining === "") {
    // Only shebang left — remove the file
    unlinkSync(hookPath);
    console.log(chalk.green("Removed mex post-commit hook."));
  } else {
    writeFileSync(hookPath, remaining + "\n");
    chmodSync(hookPath, 0o755);
    console.log(
      chalk.green("Removed mex section from post-commit hook.")
    );
  }
}
