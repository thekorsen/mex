/**
 * Supervised background drift watching.
 *
 * # Why every timer here goes through `ctx`
 *
 * omp extensions are **not sandboxed**: they run inside the agent's own process.
 * A callback handed to the global `setInterval` has no handler frame above it, so
 * when it throws — or leaves a rejected promise unhandled — the failure surfaces
 * as a process-level `uncaughtException`/`unhandledRejection` and takes the
 * *entire omp session* down with it. The user would lose their conversation
 * because a background wiki drift check hit an unreadable file.
 *
 * `ctx.setInterval` wraps the callback in the same isolation omp uses for event
 * handlers (covering a returned rejected promise as well as a synchronous throw),
 * returns a handle for `ctx.clearTimer`, is `unref`'d so a pending tick never
 * holds the process open, and is auto-cleared on `session_shutdown`. Using the
 * global timer here would not be a style nit; it would be a bug whose blast
 * radius is the whole session.
 *
 * That isolation is the *backstop*, not the plan: {@link createWatchTick} awaits
 * its own work inside `try`/`catch` and reports failures through the notify path,
 * so a broken check degrades into one warning line instead of a dead timer. The
 * distinction matters because `runDriftCheck` is async (`src/drift/index.ts:67-70`)
 * — a bare synchronous `try` around a *floating* promise catches nothing and
 * leaves exactly the unhandled rejection described above.
 *
 * # Load-time contract
 *
 * Only registration happens at factory time (`packages/omp-mex/src/index.ts:26-32`);
 * every filesystem touch and every notification happens from an event handler.
 */

import { loadMex, type MexScaffold } from "./mex.js";
import type { OmpContext, OmpExtensionAPI, OmpTimer } from "./omp-api.js";

/**
 * Lazy scaffold lookup supplied by the composition root
 * (`packages/omp-mex/src/index.ts:51-57`). Declared locally rather than imported
 * from a sibling module so the registration slices stay decoupled.
 */
export type ScaffoldResolver = (cwd: string) => Promise<MexScaffold | null>;

/**
 * Notification levels omp's UI accepts (`packages/omp-mex/src/omp-api.ts:33`).
 * Aliased so {@link WatchTickDeps} is satisfiable by `ctx.ui.notify` directly,
 * with no widening cast.
 */
export type WatchNotifyLevel = "info" | "warn" | "error" | "success";

/**
 * Ten minutes.
 *
 * A full drift check on this repo costs on the order of a second, but its *value*
 * decays slowly: the score is `100 - (errors*10 + warnings*3 + infos*1)` clamped
 * to `0..100` (`src/drift/scoring.ts:3-15`), so it only moves when files are
 * edited or the wiki changes — and an edit burst plus review takes minutes, not
 * seconds. A tight loop would therefore burn CPU inside the agent's own process
 * to recompute the same number, and, worse, would make an extension that talks to
 * the user on a timer. That is how extensions get uninstalled, at which point the
 * watcher's real signal is lost too. Ten minutes is long enough that consecutive
 * ticks usually see genuinely different repo state, and short enough that a nudge
 * still lands inside the task that caused the drift.
 */
export const DEFAULT_WATCH_INTERVAL_MS = 10 * 60_000;

/** Floor for the env override below; anything tighter is a runaway loop. */
const MIN_WATCH_INTERVAL_MS = 1_000;

/**
 * Verification-only seam. `MEX_OMP_WATCH_THROW=1` makes the scheduled tick fail
 * on purpose, *outside* its own guard, so a live omp session can demonstrate that
 * a throwing tick is contained by `ctx.setInterval` rather than fatal. Never set
 * this in normal use.
 */
export const WATCH_THROW_ENV = "MEX_OMP_WATCH_THROW";

/**
 * Verification/ops override for {@link DEFAULT_WATCH_INTERVAL_MS}, in
 * milliseconds. Exists so the throw seam above can be exercised in a live session
 * without waiting ten minutes for the first tick.
 */
export const WATCH_INTERVAL_ENV = "MEX_OMP_WATCH_INTERVAL_MS";

/** Injected collaborators for the tick, so the failure path is testable. */
export interface WatchTickDeps {
  /**
   * Produce the current drift score.
   *
   * `runDriftCheck` resolves a whole `DriftReport` (`src/drift/index.ts:67-70`,
   * shape at `src/types.ts:151-157`), but the tick's only decision is "did the
   * score change", and a *background* line should say no more than the score —
   * the user runs `/mex-drift` when they want the issue list. So the seam is
   * narrowed to `report.score` (`src/types.ts:152`) and the report is unwrapped at
   * the call site in {@link registerWatch}.
   *
   * Typed as possibly-async because the real implementation is: a test can inject
   * a check that throws synchronously *or* one that returns a rejected promise,
   * and both must be contained. The rejection is the likelier real failure.
   */
  check: () => Promise<number> | number;
  notify: (message: string, level?: WatchNotifyLevel) => void;
}

/** Resolved tick period, honouring {@link WATCH_INTERVAL_ENV}. */
export function resolveWatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WATCH_INTERVAL_ENV];
  if (raw === undefined) return DEFAULT_WATCH_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WATCH_INTERVAL_MS;
  return Math.max(MIN_WATCH_INTERVAL_MS, Math.floor(parsed));
}

/**
 * Build the callback handed to `ctx.setInterval`.
 *
 * Exported and used by the production registration path below — not duplicated
 * there — so a test that injects a failing `check` exercises the real code rather
 * than a lookalike copy. Three behaviours are load-bearing:
 *
 * 1. **`await` inside the guard.** The returned callback is `async` and awaits
 *    `deps.check()` inside `try`/`catch`. A synchronous `try` around a floating
 *    promise would catch a sync throw and miss every rejection — the exact
 *    unhandled-rejection path that kills sessions.
 * 2. **Notify only on a score change.** The last score lives in closure state. An
 *    unconditional "drift score is still 87" every ten minutes is pure noise, and
 *    noise gets extensions uninstalled. The first observation of a session does
 *    notify: "unknown" → a number is new information.
 * 3. **Never reject in normal operation.** A failing check is an ordinary,
 *    reportable state (unreadable file, half-written wiki page), so it is caught
 *    and surfaced through `notify`; `ctx.setInterval`'s isolation stays the
 *    backstop for the unforeseen rather than the first line of defence.
 *
 * The single deliberate exception is {@link WATCH_THROW_ENV}, which fails *before*
 * entering the guarded region precisely so it reaches the harness boundary.
 */
export function createWatchTick(
  deps: WatchTickDeps,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<void> {
  let lastScore: number | null = null;

  const report = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      deps.notify(`mex: drift watch check failed: ${message}`, "warn");
    } catch {
      // A notify sink that itself throws is out of our hands. Swallowing keeps
      // the *failure* path from becoming the thing that ends the session.
    }
  };

  // A drift check on a large repo can outlast a short interval (and the interval
  // is overridable down to a second for verification). Without this guard the
  // ticks would stack, each holding its own graph load, and the score comparison
  // would race — whichever finished last would win regardless of which ran last.
  let inFlight = false;

  return async () => {
    if (env[WATCH_THROW_ENV] === "1") {
      // Deliberately outside the try: this is the live proof that a failing tick
      // is contained by `ctx.setInterval` and does not tear down the session.
      throw new Error(`mex: deliberate watch failure (${WATCH_THROW_ENV}=1)`);
    }
    if (inFlight) return;
    inFlight = true;
    try {
      const score = await deps.check();
      if (typeof score !== "number" || !Number.isFinite(score)) return;
      if (score === lastScore) return;
      const previous = lastScore;
      lastScore = score;
      if (previous === null) {
        deps.notify(`mex: wiki drift score ${score}/100.`, score === 100 ? "success" : "info");
        return;
      }
      deps.notify(
        `mex: wiki drift score ${previous} → ${score}/100. Run /mex-drift for the issue list.`,
        score < previous ? "warn" : "success",
      );
    } catch (error) {
      report(error);
    } finally {
      // `finally`, not the end of `try`: the body has early returns on an
      // unchanged score, and leaving the flag set would silently kill the watcher
      // for the rest of the session.
      inFlight = false;
    }
  };
}

/**
 * Compute the drift score for a resolved project.
 *
 * `findConfig` throws when there is no `.mex/` (`src/config.ts:54-101`), which is
 * why this only ever runs behind a resolved {@link MexScaffold}; the surrounding
 * tick catches it regardless.
 *
 * `graphWarning` is redirected away from its `console.warn` default
 * (`src/drift/index.ts:90,95,101`) for the same reason `mex.ts:9-14` captures
 * JSONL: an extension shares the agent's stdio, so a stray `console.warn` prints
 * over the harness UI. From a *background* tick that is doubly wrong — the user
 * gets terminal noise they cannot trace to anything they did.
 */
async function driftScore(projectRoot: string): Promise<number> {
  const { findConfig, runDriftCheck } = await loadMex();
  const config = findConfig(projectRoot);
  const report = await runDriftCheck(config, { graphWarning: () => {} });
  return report.score;
}

/**
 * Register the background drift watcher.
 *
 * `session_start` always reports what it found, on both branches: an extension
 * that silently does nothing when there is no `.mex/` is indistinguishable from
 * one that is broken.
 */
export function registerWatch(pi: OmpExtensionAPI, getScaffold: ScaffoldResolver): void {
  // Session-scoped, but held in extension closure state because that is the only
  // state omp carries across the two events. `null` means "no timer owned".
  let timer: OmpTimer | null = null;

  /**
   * In print/headless mode `ctx.hasUI === false` and the ui methods are no-ops,
   * so guard rather than relying on the no-op: it keeps message construction off
   * the hot path and makes the intent explicit.
   */
  const notifier =
    (ctx: OmpContext) =>
    (message: string, level?: WatchNotifyLevel): void => {
      if (!ctx.hasUI) return;
      ctx.ui.notify(message, level);
    };

  pi.on("session_start", async (_event: unknown, ctx: OmpContext) => {
    const notify = notifier(ctx);
    const scaffold = await getScaffold(ctx.cwd);

    if (!scaffold) {
      // No timer is registered on this branch — there is nothing to watch.
      notify(
        "mex: no .mex/ wiki scaffold for this project — drift watch off. Run `mex setup` to create one.",
        "info",
      );
      return;
    }

    // A second `session_start` without an intervening shutdown would otherwise
    // leak the previous interval, whose owning closure slot has just been reused.
    if (timer !== null) {
      ctx.clearTimer(timer);
      timer = null;
    }

    const intervalMs = resolveWatchIntervalMs();
    notify(
      `mex: wiki at ${scaffold.projectRoot}` +
        (scaffold.hasGraph ? " (code graph ready)" : " (no code graph — run `mex graph`)") +
        `; drift watch every ${Math.round(intervalMs / 60_000)} min.`,
      "info",
    );

    const tick = createWatchTick({
      check: () => driftScore(scaffold.projectRoot),
      notify,
    });
    timer = ctx.setInterval(tick, intervalMs);
  });

  // omp clears extension timers on shutdown anyway. Clearing explicitly states
  // that this module owns the handle, which is what survives a future refactor
  // that moves the timer somewhere omp is not auto-clearing for us.
  pi.on("session_shutdown", (_event: unknown, ctx: OmpContext) => {
    if (timer === null) return;
    ctx.clearTimer(timer);
    timer = null;
  });
}
