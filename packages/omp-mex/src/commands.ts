/**
 * `/mex-*` slash commands that only code can provide.
 *
 * # What is deliberately absent
 *
 * `mex setup` already projects three declarative commands from
 * `templates/omp/commands/`: `mex-check.md`, `mex-graph-scope.md`, and
 * `mex-sync.md`. omp dedups discovered commands **first-wins by name**, so
 * registering any of those three names here would not override them and would not
 * add a capability — it would create a load-order race where whichever provider
 * is discovered first wins and the other silently does nothing. Every command
 * below exists because a markdown prompt body physically cannot do the work:
 * one computes a routing decision, the other calls a mex function in-process.
 *
 * # Failure policy
 *
 * Both handlers are fully wrapped. A throwing command handler surfaces as a raw
 * extension error with no useful recovery path for the user, so every failure is
 * reported through `ctx.ui.notify(..., "error")` instead.
 */

import { loadMex, type MexScaffold } from "./mex.js";
import {
  DEFAULT_INJECTION_BUDGET,
  buildWikiIndex,
  routeContext,
  type RouteDecision,
  type WikiPage,
} from "./router.js";
import type { OmpCommandContext, OmpExtensionAPI } from "./omp-api.js";

/**
 * Cross-slice contract with `index.ts`. Declared locally in every registrar so
 * the five modules stay independent of each other's write order.
 */
export type ScaffoldResolver = (cwd: string) => Promise<MexScaffold | null>;

/**
 * Command names owned by the declarative artifacts in `templates/omp/commands/`.
 *
 * Kept as a named constant rather than a comment so the first-wins decision is
 * assertable from a test — the failure mode it guards against (a future lane
 * "helpfully" adding a code version of `/mex-check`) is silent by nature.
 */
export const DECLARATIVE_COMMANDS = ["mex-check", "mex-graph-scope", "mex-sync"] as const;

/** One routed page as a report line: marker, path, token cost, and why it matched. */
function pageLine(page: WikiPage, marker: string): string {
  const why = page.condition !== "" ? page.condition : page.description;
  const suffix = why !== "" ? ` — ${why}` : "";
  return `  ${marker} ${page.relPath} (${String(page.tokens)}t)${suffix}`;
}

/**
 * Human-readable routing report.
 *
 * The dump-vs-routed comparison is the whole point of the command: it is the only
 * place a user can see what the `context` handler is *not* sending, and what that
 * omission is buying them. `RouteDecision` carries `dumpTokens` for exactly this
 * (`packages/omp-mex/src/router.ts:202-203`).
 */
function renderRoutingReport(task: string, decision: RouteDecision, scaffoldPath: string): string {
  const { selected, skipped, totalTokens, budget, dumpTokens } = decision;
  const saved = dumpTokens - totalTokens;
  const lines: string[] = [
    `mex routed context for: ${task}`,
    `  scaffold: ${scaffoldPath}`,
    `  budget: ${String(totalTokens)}/${String(budget)} tokens across ${String(selected.length)} page(s)`,
    `  full-dump cost: ${String(dumpTokens)} tokens — routing saves ${String(saved)}`,
  ];

  if (selected.length === 0) {
    lines.push("  injected: nothing — no candidate page scored above zero for this task");
  } else {
    lines.push("  injected:");
    for (const page of selected) lines.push(pageLine(page, "+"));
  }

  if (skipped.length > 0) {
    lines.push(`  not injected (${String(skipped.length)}):`);
    for (const page of skipped) lines.push(pageLine(page, "-"));
  }

  return lines.join("\n");
}

/** Group drift issues by severity for a one-line headline. `Severity` is `"error"|"warning"|"info"` (`src/types.ts:114`). */
function countBySeverity(issues: ReadonlyArray<{ severity: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
  return counts;
}

/** Cap the per-issue listing so one badly drifted wiki cannot flood the transcript. */
const MAX_ISSUE_LINES = 15;

export function registerCommands(pi: OmpExtensionAPI, getScaffold: ScaffoldResolver): void {
  pi.registerCommand("mex-context", {
    description:
      "Show which .mex/ wiki pages would be routed into context for a task, their token cost, and what a full wiki dump would have cost instead.",
    handler: async (args: string, ctx: OmpCommandContext) => {
      // No `waitForIdle()`: this is a pure read of `.mex/` plus arithmetic. It
      // mutates no session state and races nothing, so blocking on the session
      // settling would only delay the report the user asked for.
      try {
        const task = args.trim();
        if (task === "") {
          report(ctx, "Usage: /mex-context <task description>", "warn");
          return;
        }
        const scaffold = await getScaffold(ctx.cwd);
        if (scaffold === null) {
          report(ctx, `No .mex/ wiki found from ${ctx.cwd}. Run \`mex setup\` to create one.`, "warn");
          return;
        }
        const { parseFrontmatter } = await loadMex();
        const pages = buildWikiIndex(scaffold, parseFrontmatter);
        if (pages.length === 0) {
          report(
            ctx,
            ".mex/ROUTER.md lists no routable edges, so nothing can be routed. Add `edges:` frontmatter or run `mex sync`.",
            "warn",
          );
          return;
        }
        const decision = routeContext(task, pages, DEFAULT_INJECTION_BUDGET);
        report(ctx, renderRoutingReport(task, decision, scaffold.scaffoldPath), "info");
      } catch (error) {
        report(ctx, `/mex-context failed: ${message(error)}`, "error");
      }
    },
  });

  pi.registerCommand("mex-drift", {
    description:
      "Run mex drift detection in-process against the .mex/ wiki and report the score plus the issues found.",
    handler: async (_args: string, ctx: OmpCommandContext) => {
      // Not a duplicate of the declarative `/mex-check`. That command is a prompt
      // body telling the model to shell out to the `mex check` CLI: a subprocess, a
      // built `dist/`, and a result that exists only as transcript text. This calls
      // `runDriftCheck` directly (`src/drift/index.ts:67-70`), so there is no
      // subprocess and no build step, and the `DriftReport` is a live value this
      // extension's own state can read.
      //
      // No `waitForIdle()` either: drift reads files off disk and never touches the
      // message history, so an in-flight turn is not a hazard.
      try {
        const scaffold = await getScaffold(ctx.cwd);
        if (scaffold === null) {
          report(ctx, `No .mex/ wiki found from ${ctx.cwd}. Run \`mex setup\` to create one.`, "warn");
          return;
        }
        if (ctx.hasUI) ctx.ui.setStatus("mex-drift", "mex: checking drift…");

        // `runDriftCheck` defaults its graph nudges to `console.warn`
        // (`src/drift/index.ts:90,95,101`). In-process that lands in the harness
        // terminal, detached from the report, so they are captured and folded in.
        const warnings: string[] = [];
        const { findConfig, runDriftCheck } = await loadMex();
        const config = findConfig(scaffold.projectRoot);
        const drift = await runDriftCheck(config, { graphWarning: (m: string) => warnings.push(m) });

        const counts = countBySeverity(drift.issues);
        const severityBreakdown = Object.entries(counts)
          .map(([severity, n]) => `${String(n)} ${severity}`)
          .join(", ");
        const lines: string[] = [
          drift.issues.length === 0
            ? `mex drift: score ${String(drift.score)}/100, no issues across ${String(drift.filesChecked)} file(s)`
            : `mex drift: score ${String(drift.score)}/100 — ${String(drift.issues.length)} issue(s) across ${String(drift.filesChecked)} file(s) (${severityBreakdown})`,
        ];

        for (const issue of drift.issues.slice(0, MAX_ISSUE_LINES)) {
          // `DriftIssue.line` is `number | null` (`src/types.ts:145`).
          const where = issue.line === null ? issue.file : `${issue.file}:${String(issue.line)}`;
          lines.push(`  [${issue.severity}] ${issue.code} ${where} — ${issue.message}`);
        }
        if (drift.issues.length > MAX_ISSUE_LINES) {
          lines.push(
            `  … ${String(drift.issues.length - MAX_ISSUE_LINES)} more — run \`mex check\` for the full report`,
          );
        }
        for (const warning of warnings) lines.push(`  note: ${warning}`);

        // Notification level tracks the worst issue: an `error` means the wiki
        // asserts something about the code that is no longer true.
        const level = counts.error !== undefined ? "error" : counts.warning !== undefined ? "warn" : "info";
        if (ctx.hasUI) ctx.ui.setStatus("mex-drift", `mex: drift ${String(drift.score)}/100`);
        report(ctx, lines.join("\n"), level);
      } catch (error) {
        report(ctx, `/mex-drift failed: ${message(error)}`, "error");
      }
    },
  });

  /**
   * `/mex-graph-impact` — blast-radius review before an edit.
   *
   * Registered in code, unlike the other prompt-body commands, because a sibling
   * `commands/*.md` inside an extension package is **not discovered**. Verified
   * live: a probe package's `commands/probe-cmd.md` never appeared in
   * `pi.getCommands()`, while its `skills/` sibling did (as `skill:probe-skill`).
   * `commands/mex-graph-impact.md` therefore ships as the *body* this handler
   * emits, not as a discovered artifact.
   *
   * The handler deliberately does not call `mex_impact` itself. The command's job
   * is to put a reviewed procedure in front of the model — read `summary` before
   * reporting a caller count, re-run with a node id on `TARGET_AMBIGUOUS`, treat
   * returned source as already read — and that procedure is prose. Running the
   * query here would produce JSONL the model then has to be told how to read
   * anyway, in a channel with no room for the telling.
   */
  pi.registerCommand("mex-graph-impact", {
    description:
      "Review the blast radius of a change before making it — resolve the target in the code graph, list its transitive callers, and name the wiki pages that will owe an update.",
    handler: (args: string, ctx: OmpCommandContext) => {
      try {
        const target = args.trim();
        if (target === "") {
          report(ctx, "Usage: /mex-graph-impact <symbol, node id, or file path>", "warn");
          return;
        }
        // The target is passed as a *tool argument*, never interpolated into a
        // shell line: omp substitutes command arguments textually, so a target
        // containing a quote, backtick or `$` would otherwise terminate or inject
        // into any `mex impact '...'` string assembled around it. A JSON string
        // argument makes those characters inert data.
        report(ctx, impactBrief(target), "info");
      } catch (error) {
        report(ctx, `/mex-graph-impact failed: ${message(error)}`, "error");
      }
    },
  });
}

/**
 * The `/mex-graph-impact` procedure, with the target substituted as data.
 *
 * Kept in step with `commands/mex-graph-impact.md`, which is the same procedure in
 * the form omp *would* discover if package-sibling commands were discovered. The
 * markdown file remains the readable source for a consumer; this is what actually
 * reaches a session.
 */
function impactBrief(target: string): string {
  return [
    `Assess what a change to ${JSON.stringify(target)} would break, before writing the change.`,
    "",
    "Call the `mex_impact` tool with that target as a tool argument:",
    "",
    `    mex_impact { target: ${JSON.stringify(target)}, detail: "standard" }`,
    "",
    "Then work the returned JSONL:",
    "",
    "1. Read the `summary` record first. `truncated: true` means callers were DROPPED, not clipped — the blast radius is at least what you see and possibly larger, so do not report a caller count from a truncated result.",
    "2. On `{\"code\":\"TARGET_AMBIGUOUS\"}`, pick the intended id from `candidates` and re-run with that node id rather than guessing which one was meant.",
    "3. On `{\"code\":\"GRAPH_UNAVAILABLE\"}`, the local graph is not built: run `mex graph`, then retry. Do not fall back to grepping for callers by hand — that is the unreliable answer the graph exists to replace.",
    "4. Widen only if the radius looks suspiciously small: raise `depth` (default 2) one step at a time, or raise `maxNodes`. Re-running the same query unchanged returns the identical dropped set.",
    "5. For any caller you cannot judge from its signature alone, expand just that one: `mex_graph_get { ids: [\"<id>\"], maxSourceLines: 60 }`. Treat source the graph returns as ALREADY READ — do not re-open those files.",
    "",
    "Impact also surfaces the `.mex/` wiki pages grounded to the target. Those are the documentation debt the change creates: if you make the edit, they are what you owe an update to, and `mex check` will report them if you do not.",
    "",
    "Report: the resolved target, affected callers grouped by file, the grounded wiki pages needing updates, whether the result was truncated, and whether the change is safe as scoped or should be split.",
  ].join("\n");
}

/**
 * Emit a report to the user, or to stdout when there is no UI.
 *
 * `ctx.ui.notify` is a no-op when `ctx.hasUI === false` (print/headless mode), and
 * a command whose only output is a notification would then silently produce
 * nothing — the user typed `/mex-context` and got a blank screen. Falling back to
 * stdout is correct precisely here, unlike the retrieval JSONL in `tools.ts`: this
 * text was explicitly requested by the user, not by the model.
 */
function report(ctx: OmpCommandContext, text: string, level: "info" | "warn" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }
  console.log(text);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
