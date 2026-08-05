/**
 * `mex sync` briefs inline whole file contents (`src/sync/brief-builder.ts:117-120`) with no
 * size cap, so a large repair brief can exceed the OS argv limit; before this module, that
 * surfaced only as an undiagnosable "session failed" from sync.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How a brief will reach the agent process, plus the cleanup that owns its temp file. */
export interface BriefDelivery {
  /** The single string to hand the agent CLI as its prompt argument. */
  prompt: string;
  /** Absolute path of the spill file, or `null` when the brief fit in argv. */
  spillPath: string | null;
  /** Remove the spill directory. Idempotent, and never throws. */
  cleanup(): void;
}

// `getconf ARG_MAX` is 1048576 on this darwin host, but one argv string first fails
// with E2BIG at 1045930 bytes with a 2009-byte environ, so mex keeps 4096 bytes of
// headroom. Linux is bound by MAX_ARG_STRLEN at 131072 bytes for a single argument,
// Windows caps the whole command line at 32767 characters, and a constant table beats
// per-sync `getconf` because Windows lacks it and Linux needs the per-argument limit.
const PLATFORM_ARGV_CEILINGS: Record<string, number> = {
  darwin: 1_048_576,
  linux: 131_072,
  win32: 32_767,
};

const ARG_HEADROOM_BYTES = 4_096;

/** Bytes available for one argv prompt string on this platform, given the current environment. */
export function briefArgvBudget(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): number {
  const ceiling = PLATFORM_ARGV_CEILINGS[platform] ?? PLATFORM_ARGV_CEILINGS.linux;
  const envBytes = Object.entries(env).reduce((total, [key, value]) => {
    return total + key.length + (value ?? "").length + 2;
  }, 0);
  return Math.max(0, ceiling - envBytes - ARG_HEADROOM_BYTES);
}

/** Route a brief to argv when it fits, or to a temp file with a pointer prompt when it does not. */
export function deliverBrief(brief: string, opts: { budget?: number } = {}): BriefDelivery {
  const budget = opts.budget ?? briefArgvBudget();
  if (Buffer.byteLength(brief, "utf8") <= budget) {
    return {
      prompt: brief,
      spillPath: null,
      cleanup: () => {},
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "mex-brief-"));
  const spillPath = join(dir, "brief.md");
  writeFileSync(spillPath, brief, "utf8");

  return {
    prompt:
      "The repair brief was too large for the command line. Read the file below in full, carry out every instruction in it, and treat that file as the complete brief with nothing else to fetch.\n" +
      spillPath,
    spillPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
