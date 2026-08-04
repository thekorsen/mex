import simpleGit, { type SimpleGit, type LogResult } from "simple-git";

let _git: SimpleGit | null = null;

export function getGit(cwd?: string): SimpleGit {
  if (!_git || cwd) {
    _git = simpleGit(cwd ?? process.cwd());
  }
  return _git;
}

/** How commits are counted toward staleness thresholds. */
export type CommitCountMode = "all" | "no-merges";

/** Merge commits do not count as authored work. */
export const DEFAULT_COMMIT_COUNT_MODE: CommitCountMode = "no-merges";

/**
 * How a comparison base was resolved, and how far to trust it.
 * `ref === null` means no upstream could be resolved.
 */
export interface ComparisonBase {
  /** The ref compared against, e.g. "origin/main". null when unresolvable. */
  ref: string | null;
  /** merge-base(HEAD, ref). null when unresolvable. */
  mergeBase: string | null;
  /** How `ref` was chosen. "local" means no upstream exists. */
  source: "explicit" | "tracking" | "remote-head" | "local";
  /** Commits on HEAD not on `ref`. null when unknown. */
  ahead: number | null;
  /** Commits on `ref` not on HEAD — the "what landed upstream" number. null when unknown. */
  behind: number | null;
  /** True for a shallow clone: all counts are LOWER BOUNDS. */
  shallow: boolean;
  /** Human-readable degradation reason, else null. */
  note: string | null;
}

function getRevListArgs(
  fromRef: string,
  untilRef: string,
  mode: CommitCountMode
): string[] {
  const args = ["rev-list", "--count"];
  if (mode === "no-merges") {
    args.push("--no-merges");
  }
  args.push(`${fromRef}..${untilRef}`);
  return args;
}

async function resolveHeadRef(git: SimpleGit, ref?: string): Promise<{
  ref: string | null;
  source: ComparisonBase["source"];
  note: string | null;
}> {
  if (ref) {
    try {
      const resolved = (await git.raw(["rev-parse", "--abbrev-ref", ref])).trim();
      return {
        ref: resolved || ref,
        source: "explicit",
        note: null,
      };
    } catch {
      return {
        ref: null,
        source: "local",
        note: `Explicit comparison ref \"${ref}\" could not be resolved locally.`,
      };
    }
  }

  try {
    const trackingRef = (await git.raw(["rev-parse", "--abbrev-ref", "@{upstream}"])).trim();
    if (trackingRef) {
      return {
        ref: trackingRef,
        source: "tracking",
        note: null,
      };
    }
  } catch {
    // Fall through.
  }

  try {
    const originHead = (await git.raw(["rev-parse", "--abbrev-ref", "origin/HEAD"])).trim();
    if (originHead) {
      return {
        ref: originHead,
        source: "remote-head",
        note: null,
      };
    }
  } catch {
    // Fall through.
  }

  try {
    const remotesOutput = await git.raw(["remote"]);
    const remotes = remotesOutput
      .split("\n")
      .map((remote) => remote.trim())
      .filter(Boolean);

    if (remotes.length === 1) {
      const remoteHead = (
        await git.raw(["rev-parse", "--abbrev-ref", `${remotes[0]}/HEAD`])
      ).trim();
      if (remoteHead) {
        return {
          ref: remoteHead,
          source: "remote-head",
          note: null,
        };
      }
    }

    if (remotes.length > 1) {
      return {
        ref: null,
        source: "local",
        note: "No tracking branch is configured and multiple remotes exist, so no comparison base could be chosen locally.",
      };
    }
  } catch {
    // Fall through.
  }

  return {
    ref: null,
    source: "local",
    note: "No upstream or remote HEAD could be resolved locally.",
  };
}

/**
 * Resolve the comparison base without touching the network.
 * NEVER runs `git fetch`; it only uses already-local refs.
 */
export async function resolveComparisonBase(
  cwd?: string,
  opts?: { ref?: string }
): Promise<ComparisonBase> {
  const git = getGit(cwd);

  let shallow = false;
  let note: string | null = null;

  try {
    shallow = (await git.raw(["rev-parse", "--is-shallow-repository"])).trim() === "true";
    if (shallow) {
      note = "Repository is shallow; ahead/behind counts are lower bounds.";
    }
  } catch {
    note = "Could not determine whether the repository is shallow.";
  }

  try {
    await git.raw(["rev-parse", "--verify", "HEAD"]);
  } catch {
    return {
      ref: null,
      mergeBase: null,
      source: "local",
      ahead: null,
      behind: null,
      shallow,
      note: note ?? "Repository has no commits yet.",
    };
  }

  try {
    const resolved = await resolveHeadRef(git, opts?.ref);
    if (!resolved.ref) {
      return {
        ref: null,
        mergeBase: null,
        source: resolved.source,
        ahead: null,
        behind: null,
        shallow,
        note: note ?? resolved.note,
      };
    }

    const mergeBase = (await git.raw(["merge-base", "HEAD", resolved.ref])).trim();
    const counts = (await git.raw(["rev-list", "--count", "--left-right", `${resolved.ref}...HEAD`]))
      .trim()
      .split(/\s+/);
    const behind = Number.parseInt(counts[0] ?? "", 10);
    const ahead = Number.parseInt(counts[1] ?? "", 10);

    return {
      ref: resolved.ref,
      mergeBase: mergeBase || null,
      source: resolved.source,
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null,
      shallow,
      note: note ?? resolved.note,
    };
  } catch {
    return {
      ref: null,
      mergeBase: null,
      source: "local",
      ahead: null,
      behind: null,
      shallow,
      note: note ?? "Could not resolve a comparison base locally.",
    };
  }
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

/**
 * Commits that landed since `filePath` was last committed.
 * Uses `--follow` when locating the file's last commit.
 */
export async function commitsSinceLastChange(
  filePath: string,
  cwd?: string,
  opts?: { mode?: CommitCountMode; until?: string }
): Promise<number | null> {
  try {
    const git = getGit(cwd);
    const mode = opts?.mode ?? DEFAULT_COMMIT_COUNT_MODE;
    const until = opts?.until ?? "HEAD";
    const sha = (
      await git.raw(["log", "-1", "--follow", "--format=%H", "--", filePath])
    ).trim();

    if (!sha) return null;

    const count = (await git.raw(getRevListArgs(sha, until, mode))).trim();
    const parsed = Number.parseInt(count, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Commits touching `paths` since `sinceRef`, counted with `mode`.
 * Empty `paths` returns null.
 */
export async function commitsTouchingPaths(
  paths: string[],
  sinceRef: string,
  cwd?: string,
  opts?: { mode?: CommitCountMode; until?: string }
): Promise<number | null> {
  if (paths.length === 0) {
    return null;
  }

  try {
    const git = getGit(cwd);
    const mode = opts?.mode ?? DEFAULT_COMMIT_COUNT_MODE;
    const until = opts?.until ?? "HEAD";
    const args = getRevListArgs(sinceRef, until, mode);
    args.push("--", ...paths);
    const count = (await git.raw(args)).trim();
    const parsed = Number.parseInt(count, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Diff for `paths` against a meaningful comparison base instead of the old
 * hardcoded `HEAD~5..HEAD` window.
 *
 * Diffs `<mergeBase>` (NOT `<mergeBase>..HEAD`) so that **uncommitted** work in
 * the working tree is included. The only consumer is the `mex sync` brief
 * (`src/sync/brief-builder.ts:106`), which shows an agent what changed about the
 * paths a knowledge page claims — work in progress is exactly what matters
 * there, and a two-dot range would silently omit it.
 *
 * Falls back to `HEAD` (working tree vs tip) when no base resolves, and to `""`
 * on any failure. Never throws.
 */
export async function getGitDiff(
  paths: string[],
  cwd?: string,
  opts?: { base?: ComparisonBase; ref?: string }
): Promise<string> {
  try {
    const git = getGit(cwd);
    const base = opts?.base ?? await resolveComparisonBase(cwd, { ref: opts?.ref });

    if (base.mergeBase) {
      return await git.diff([base.mergeBase, "--", ...paths]);
    }

    return await git.diff(["HEAD", "--", ...paths]);
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
