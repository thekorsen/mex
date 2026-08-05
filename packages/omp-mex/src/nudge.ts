/**
 * Post-edit drift nudge.
 *
 * The wiki is only useful while it still describes the code. The moment an agent
 * edits a source file, the wiki's claims about that file are *suspect* — but
 * running a full drift check inside the edit path would tax every write, and
 * blocking on it would be worse. So this module does the cheapest useful thing:
 * it watches `tool_result` and, occasionally, tells the user where to look.
 *
 * # Why `tool_result` and not `tool_call`
 *
 * `tool_call` fails **closed** — a throwing pre-exec handler blocks the tool
 * outright, so a bug in a *nudge* would stop the agent from editing files at all.
 * `tool_result` is post-exec: the write already happened, nothing can be blocked.
 * A throw there is still not free (it pollutes the extension error channel and
 * would be reported to the user as an extension fault), so the handler body is
 * wrapped and swallows.
 *
 * # Why this handler never returns a value
 *
 * `tool_result` is *middleware-style*: handlers run in registration order and each
 * one sees the modifications made by those before it. Returning `{ content }` or
 * `{ details }` from here would overwrite the edit tool's own output — and the
 * model, which asked for that output, would silently receive a nudge instead.
 * This handler observes; it never rewrites. It returns `undefined`, always.
 */

import { relative, resolve } from "node:path";
import type { MexScaffold } from "./mex.js";
import type { OmpContext, OmpExtensionAPI, OmpToolResultEvent } from "./omp-api.js";

/**
 * Lazy scaffold lookup supplied by the composition root
 * (`packages/omp-mex/src/index.ts:51-57`). Declared locally rather than imported
 * from a sibling module so the registration slices stay decoupled.
 */
export type ScaffoldResolver = (cwd: string) => Promise<MexScaffold | null>;

/**
 * Tools whose success means "a file on disk just changed".
 *
 * Enumerated explicitly rather than pattern-matched on the name: a substring test
 * like `includes("edit")` would catch a hypothetical `edit_history` or a read-only
 * `preview_edit` and nudge on tools that wrote nothing. Both multi-edit spellings
 * are listed because the two are used interchangeably across harness versions and
 * missing one would silently disable the nudge for batch edits — the *most* likely
 * source of drift.
 */
export const EDIT_TOOL_NAMES: Readonly<Record<string, true>> = {
  edit: true,
  write: true,
  multiedit: true,
  multi_edit: true,
};

/**
 * Five minutes between nudges, per project.
 *
 * A cooldown window is the right knob here rather than a touched-file count: a
 * refactor that rewrites twenty files in one burst is a *single* drift event from
 * the user's point of view, and a count-based rule would fire mid-burst — while
 * the edits are still landing and the wiki cannot yet be meaningfully compared.
 * Five minutes is short enough that the nudge still arrives inside the task that
 * caused the drift, and long enough that a normal edit-heavy turn produces at most
 * one line. The touched files are still accumulated and reported in that one line,
 * so nothing is lost by waiting.
 */
export const NUDGE_COOLDOWN_MS = 5 * 60_000;

/** Per-project nudge bookkeeping. */
interface ProjectNudgeState {
  /** Source files touched since the last nudge. A set: re-editing one file is one drift risk. */
  sourceTouched: Set<string>;
  /** `.mex/**` files touched since the last nudge — the wiki changed, not the code. */
  wikiTouched: Set<string>;
  /** `Date.now()` of the last emitted nudge; `0` means "never nudged this project". */
  lastNudgeAt: number;
}

/**
 * Read the touched path out of a tool result event.
 *
 * omp passes the tool's raw input through as `event.input`
 * (`packages/omp-mex/src/omp-api.ts:112`), and in this harness the edit tools
 * carry the target as `path`. Anything else — a missing key, a number, a nested
 * object from a tool whose name happens to collide — is *ignored*, not coerced:
 * an observer that throws on an unfamiliar payload turns another extension's
 * unusual tool into a mex fault report.
 */
function readTouchedPath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>).path;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `true` when `absPath` is the scaffold directory or something inside it.
 *
 * A prefix test on `scaffoldPath` alone would also match a sibling named
 * `.mexicali`, so the separator is part of the comparison.
 */
function isWikiPath(absPath: string, scaffold: MexScaffold): boolean {
  if (absPath === scaffold.scaffoldPath) return true;
  return !relative(scaffold.scaffoldPath, absPath).startsWith("..");
}

/**
 * Register the post-edit drift nudge.
 *
 * State is a `Map` keyed by `projectRoot`, never a bare module-level counter.
 * mex's own issue #11 was exactly this bug class: process-global state shared
 * across project roots, so one project's answers leaked into another's session.
 * One omp process can hold sessions in several checkouts at once, and a shared
 * counter would let edits in repo A both silence and mis-attribute the nudge in
 * repo B.
 */
export function registerNudge(pi: OmpExtensionAPI, getScaffold: ScaffoldResolver): void {
  const byProject = new Map<string, ProjectNudgeState>();

  pi.on("tool_result", async (event: OmpToolResultEvent, ctx: OmpContext): Promise<undefined> => {
    try {
      // `hasOwnProperty` rather than `EDIT_TOOL_NAMES[name]`: a tool literally
      // named "constructor" or "toString" would otherwise test truthy off the
      // prototype chain and nudge on a tool that wrote nothing.
      if (!Object.prototype.hasOwnProperty.call(EDIT_TOOL_NAMES, event.toolName)) return undefined;
      // A failed edit changed nothing, so there is no new drift to warn about.
      if (event.isError) return undefined;

      const scaffold = await getScaffold(ctx.cwd);
      if (!scaffold) return undefined;

      const touched = readTouchedPath(event.input);
      if (touched === null) return undefined;

      // `resolve` against the project root handles both the relative paths a model
      // usually emits and the absolute ones some tools normalise to, and collapses
      // `./` and `..` segments — so the `.mex/` test below is not fooled by
      // `./.mex/ROUTER.md` vs `/abs/repo/.mex/ROUTER.md` vs `src/../.mex/x.md`.
      const absPath = resolve(scaffold.projectRoot, touched);

      let state = byProject.get(scaffold.projectRoot);
      if (state === undefined) {
        state = { sourceTouched: new Set(), wikiTouched: new Set(), lastNudgeAt: 0 };
        byProject.set(scaffold.projectRoot, state);
      }

      // The two directions of drift are genuinely different advice: editing the
      // wiki can invalidate its own grounded claims, editing code can invalidate
      // the wiki's description of that code.
      if (isWikiPath(absPath, scaffold)) state.wikiTouched.add(absPath);
      else state.sourceTouched.add(absPath);

      const now = Date.now();
      if (state.lastNudgeAt !== 0 && now - state.lastNudgeAt < NUDGE_COOLDOWN_MS) {
        return undefined;
      }

      const sourceCount = state.sourceTouched.size;
      const wikiCount = state.wikiTouched.size;
      state.sourceTouched.clear();
      state.wikiTouched.clear();
      state.lastNudgeAt = now;

      // Guarded because ui methods are no-ops in print/headless mode
      // (`ctx.hasUI === false`) — checking keeps the intent explicit.
      if (!ctx.hasUI) return undefined;

      const what =
        wikiCount > 0 && sourceCount > 0
          ? `${sourceCount} source file(s) and ${wikiCount} wiki file(s)`
          : wikiCount > 0
            ? `${wikiCount} wiki file(s) under .mex/`
            : `${sourceCount} source file(s)`;
      const why =
        wikiCount > 0 && sourceCount === 0
          ? "the wiki's own claims may no longer hold"
          : "the wiki may no longer describe them";

      ctx.ui.notify(`mex: edited ${what} — ${why}. Run /mex-drift (or \`mex check\`).`, "info");
      return undefined;
    } catch {
      // Unlike `tool_call`, which fails CLOSED and would block the tool outright,
      // `tool_result` is post-exec — the edit already happened and nothing here
      // can undo it. A throw would still be surfaced to the user as a mex
      // extension fault, so a nudge that cannot compute its own message simply
      // stays quiet.
      return undefined;
    }
  });
}
