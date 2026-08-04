import simpleGit, { type SimpleGit, type LogResult } from "simple-git";

/**
 * One handle per repository root. A long-lived process (the MCP server) serves
 * many project roots in sequence, so a single shared handle would pin the first
 * root's repository for every later caller.
 */
const gitByRoot = new Map<string, SimpleGit>();

export function getGit(cwd?: string): SimpleGit {
  const root = cwd ?? process.cwd();
  let git = gitByRoot.get(root);
  if (!git) {
    git = simpleGit(root);
    gitByRoot.set(root, git);
  }
  return git;
}

/** Get days since a file was last modified in git */
export async function daysSinceLastChange(
  filePath: string,
  cwd?: string
): Promise<number | null> {
  try {
    const git = getGit(cwd);
    const log = await git.log({ file: filePath, maxCount: 1 });
    if (!log.latest?.date) return null;
    const lastDate = new Date(log.latest.date);
    const now = new Date();
    return Math.floor(
      (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
    );
  } catch {
    return null;
  }
}

/** Get number of commits since a file was last modified */
export async function commitsSinceLastChange(
  filePath: string,
  cwd?: string
): Promise<number | null> {
  try {
    const git = getGit(cwd);
    const fileLog = await git.log({ file: filePath, maxCount: 1 });
    if (!fileLog.latest?.hash) return null;

    const allLog = await git.log();
    const totalCommits = allLog.all.length;
    const fileIndex = allLog.all.findIndex(
      (c) => c.hash === fileLog.latest!.hash
    );
    return fileIndex === -1 ? null : fileIndex;
  } catch {
    return null;
  }
}

/** Get git diff for specific paths */
export async function getGitDiff(
  paths: string[],
  cwd?: string
): Promise<string> {
  try {
    const git = getGit(cwd);
    return await git.diff(["HEAD~5", "HEAD", "--", ...paths]);
  } catch {
    return "";
  }
}

/** Get full git log */
export async function getLog(
  cwd?: string,
  maxCount = 50
): Promise<LogResult> {
  const git = getGit(cwd);
  return git.log({ maxCount });
}
