import {
  daysSinceLastChange,
  commitsSinceLastChange,
  commitsTouchingPaths,
  DEFAULT_COMMIT_COUNT_MODE,
} from "../../git.js";
import type { CommitCountMode, ComparisonBase } from "../../git.js";
import type { DriftIssue, Severity, StalenessThresholds } from "../../types.js";

/** Default thresholds. Overridden via MexConfig.stalenessThresholds / CLI flags. */
export const DEFAULT_STALENESS_THRESHOLDS: StalenessThresholds = {
  warnDays: 30,
  errorDays: 90,
  warnCommits: 50,
  errorCommits: 200,
};

/**
 * Merge commits do not count as authored work, so merge-flow and rebase-flow
 * teams get the same staleness signal from the same underlying work.
 */
export const STALENESS_COMMIT_COUNT_MODE: CommitCountMode = DEFAULT_COMMIT_COUNT_MODE;

type StaleSignal = { severity: Severity; message: string };

function daysSignal(
  days: number,
  warnDays: number,
  errorDays: number
): StaleSignal | null {
  if (days >= errorDays) {
    return {
      severity: "error",
      message: `File hasn't been updated in ${days} days (threshold: ${errorDays}d)`,
    };
  }
  if (days >= warnDays) {
    return {
      severity: "warning",
      message: `File hasn't been updated in ${days} days (threshold: ${warnDays}d)`,
    };
  }
  return null;
}

function commitsSignal(
  commits: number,
  warnCommits: number,
  errorCommits: number
): StaleSignal | null {
  if (commits >= errorCommits) {
    return {
      severity: "error",
      message: `${commits} commits since file was last updated (threshold: ${errorCommits})`,
    };
  }
  if (commits >= warnCommits) {
    return {
      severity: "warning",
      message: `${commits} commits since file was last updated (threshold: ${warnCommits})`,
    };
  }
  return null;
}


const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/**
 * Check how stale a scaffold file is based on git history.
 *
 * When both the day threshold and the commit threshold are exceeded, this
 * returns a single combined issue at the higher of the two severities —
 * two STALE_FILE issues on the same file are the same underlying condition
 * and should cost the score once, not twice.
 */
export async function checkStaleness(
  filePath: string,
  source: string,
  cwd: string,
  thresholds: StalenessThresholds = DEFAULT_STALENESS_THRESHOLDS,
  opts: {
    lastUpdated?: string;
    mode?: CommitCountMode;
    claimedPaths?: string[];
    base?: ComparisonBase;
  } = {}
): Promise<DriftIssue[]> {
  const { warnDays, errorDays, warnCommits, errorCommits } = thresholds;
  const mode = opts.mode ?? STALENESS_COMMIT_COUNT_MODE;

  const days = await daysSinceLastChange(filePath, cwd);
  const commits = await commitsSinceLastChange(filePath, cwd, { mode });
  const claimedCommits =
    opts.claimedPaths &&
    opts.claimedPaths.length > 0 &&
    opts.base &&
    opts.base.mergeBase !== null
      ? await commitsTouchingPaths(opts.claimedPaths, opts.base.mergeBase, cwd, { mode })
      : null;

  const signals: StaleSignal[] = [];
  if (days !== null) {
    const s = daysSignal(days, warnDays, errorDays);
    if (s) signals.push(s);
  }
  if (commits !== null) {
    const s = commitsSignal(commits, warnCommits, errorCommits);
    if (s) signals.push(s);
  }
  if (claimedCommits !== null && opts.base?.ref) {
    const threshold = claimedCommits >= errorCommits ? errorCommits : warnCommits;
    const s = commitsSignal(claimedCommits, warnCommits, errorCommits);
    if (s) {
      signals.push({
        severity: s.severity,
        message: `${opts.base.shallow ? "At least " : ""}${claimedCommits} commits touching claimed code since ${opts.base.ref} (threshold: ${threshold})`,
      });
    }
  }
  const fieldDays = daysSinceFrontmatterDate(opts.lastUpdated);
  if (fieldDays !== null) {
    const s = daysSignal(fieldDays, warnDays, errorDays);
    if (s) {
      signals.push({
        severity: s.severity,
        message: `last_updated is ${fieldDays} days old (threshold: ${
          s.severity === "error" ? errorDays : warnDays
        }d)`,
      });
    }
  }

  if (signals.length === 0) return [];

  const severity = signals.reduce<Severity>(
    (acc, s) => (SEVERITY_RANK[s.severity] > SEVERITY_RANK[acc] ? s.severity : acc),
    signals[0].severity
  );
  const message = signals.map((s) => s.message).join("; ");

  return [
    {
      code: "STALE_FILE",
      severity,
      file: source,
      line: null,
      message,
    },
  ];
}

export function daysSinceFrontmatterDate(value: string | undefined, now = new Date()): number | null {
  if (!value || value.includes("[") || value.includes("]")) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dateUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const days = Math.floor((todayUtc - dateUtc) / 86_400_000);
  return days < 0 ? null : days;
}
