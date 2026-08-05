/**
 * The wiki routing engine: task string in, a budgeted selection of `.mex/` pages
 * out.
 *
 * # Why this exists as code and not as a rule
 *
 * `.omp/rules/mex-router.md` already tells the model *that* a router exists, but
 * a rule body is fetched on demand by the model — it cannot decide which of six
 * wiki pages this particular turn needs, and it cannot enforce a token ceiling
 * before the request leaves the process. Only an omp `context` handler can, and a
 * `context` handler needs a deterministic scorer. That scorer is this file.
 *
 * # Why it reuses mex's own routing table
 *
 * `.mex/ROUTER.md` frontmatter already carries a machine-readable `edges:` list
 * of `{target, condition}` (src/types.ts:194-197, and see the live table at
 * .mex/ROUTER.md:4-16). That *is* mex's routing convention, authored by the same
 * agents that maintain the wiki and drift-checked as part of the scaffold. This
 * module reads it rather than inventing a second, competing source of truth that
 * would immediately diverge from the first.
 *
 * # Purity
 *
 * Nothing here imports an omp type. The engine is a pure function of
 * (task, disk state, budget), which is what makes it testable without a live
 * harness — see test/omp-ext-routing.test.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateTokens, type MexScaffold } from "./mex.js";

/** One routable `.mex/` page, with everything the scorer and the renderer need. */
export interface WikiPage {
  /** Path relative to the scaffold, exactly as `ROUTER.md` spells the edge target. */
  relPath: string;
  /** Absolute path, so the injected text can tell the model where to read more. */
  absPath: string;
  /** The page's own frontmatter `description`, or `""` when it has none. */
  description: string;
  /** The `condition` from the `ROUTER.md` edge, or `""` when the edge omits it. */
  condition: string;
  /** Estimated tokens for the page *body* (frontmatter excluded). */
  tokens: number;
}

/**
 * Per-turn injection budget, in estimated tokens.
 *
 * Twice mex's own on-demand retrieval default of 1500
 * (`DEFAULT_RETRIEVAL_OPTIONS.maxOutputTokens`, src/graph/agent-protocol.ts:27-34),
 * which is the opposite of the intuition that a per-turn cost should be cheaper
 * than a per-request one. The number is set by measurement, not by that intuition.
 *
 * Body token counts for the six pages `.mex/ROUTER.md` routes to, observed on this
 * repo at this commit via `buildWikiIndex` (observations, not targets — a wiki that
 * grows will move them):
 *
 * | page | tokens |
 * |---|---|
 * | context/architecture.md | 2119 |
 * | context/stack.md | 1258 |
 * | context/conventions.md | 2211 |
 * | context/decisions.md | 3778 |
 * | context/setup.md | 2353 |
 * | patterns/INDEX.md | 171 |
 * | **whole-wiki dump** | **11890** |
 *
 * The smallest page carrying real topical signal is 1258, so any budget under that
 * admits only `patterns/INDEX.md` and the router silently becomes a no-op on mex's
 * own repository — the routing would typecheck, pass a synthetic-fixture test, and
 * do nothing in production. 3000 admits roughly two real pages, which is the
 * granularity that makes routing worth building, and still beats dumping the wiki
 * by ~4x.
 *
 * Note what is deliberately absent: page bodies are never truncated to force a
 * fit. A half-injected wiki page is worse than an absent one, because the model
 * cannot tell it was cut and may act on a partial decision record. Whole pages or
 * nothing.
 */
export const DEFAULT_INJECTION_BUDGET = 3000;

/** Literal marker on the first line of every injection, so it is greppable in a transcript. */
export const INJECTION_MARKER = "<!-- mex-routed-context -->";

/**
 * Terms carrying no routing signal.
 *
 * English function words plus dev filler that appears in nearly every task
 * phrasing ("code", "file", "project", "add", "use") and would otherwise match
 * nearly every page's condition, flattening the ranking into noise. `md` is here
 * for the mirror-image reason: it is a suffix of every single `relPath`, so it can
 * only ever add a constant.
 */
const STOPWORDS: Record<string, true> = {
  the: true, a: true, an: true, and: true, or: true, of: true, to: true,
  in: true, on: true, for: true, with: true, is: true, are: true, be: true,
  this: true, that: true, it: true, i: true, we: true, you: true, my: true,
  code: true, file: true, files: true, project: true, please: true, help: true,
  need: true, want: true, make: true, do: true, does: true, how: true,
  what: true, why: true, when: true, add: true, use: true, using: true,
  md: true,
};

/**
 * Suffix rewrites applied to a fixed point by {@link normalizeTerm}.
 *
 * Needed because the two sides of every comparison are written in different
 * voices: task strings are imperative ("write a drift checker") while the
 * `ROUTER.md` conditions are gerunds ("when writing new code", .mex/ROUTER.md:10).
 * Without folding, `write`/`writing` and `library`/`libraries` miss, and the
 * conditions mex actually ships would route almost nothing.
 *
 * Order matters: longer, more specific suffixes first. Iterating to a fixed point
 * is what keeps the fold *consistent* rather than merely aggressive — `classes`
 * folds `es` to `class`, which must then keep folding to reach the same stem as a
 * bare `class`, or the two would never match.
 */
const SUFFIX_FOLDS: ReadonlyArray<readonly [string, string]> = [
  ["ies", "y"],
  ["ing", ""],
  ["ed", ""],
  ["es", ""],
  ["s", ""],
  ["e", ""],
];

/** Shortest stem we will fold down to; below this, folding destroys the word. */
const MIN_STEM = 3;

/** Longest task echo we put in the injection; enough to audit the routing, not a second copy of the turn. */
const TASK_ECHO_LIMIT = 200;

/**
 * Fold one lowercase term to a comparison stem.
 *
 * Deliberately not a Porter stemmer: correctness here means "the same input
 * always yields the same stem, and two morphological variants land on it", not
 * linguistic accuracy. A dependency-free fixed-point fold is auditable in one
 * read, and over-folding costs at most a spurious match on a low-weight field.
 */
export function normalizeTerm(term: string): string {
  let stem = term;
  // Bounded loop: each iteration strictly shortens `stem`, so it terminates; the
  // guard exists only to make that obvious to the next reader.
  for (let pass = 0; pass < 4; pass++) {
    let folded = false;
    for (const [suffix, replacement] of SUFFIX_FOLDS) {
      if (!stem.endsWith(suffix)) continue;
      const next = stem.slice(0, stem.length - suffix.length) + replacement;
      if (next.length < MIN_STEM) continue;
      stem = next;
      folded = true;
      break;
    }
    if (!folded) break;
  }
  return stem;
}

/**
 * Split text into distinct scoring terms: lowercase, split on every
 * non-alphanumeric run, drop stopwords, fold to stems.
 */
export function extractTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS[raw]) continue;
    terms.add(normalizeTerm(raw));
  }
  return terms;
}

/**
 * Field weights. A `condition` was written by a wiki author specifically to
 * answer "should this page be loaded for this task", so it is the strongest
 * evidence available; a `description` describes the page's *contents*, which is
 * correlated but weaker; a `relPath` is a filename, the weakest signal of the
 * three and the one most prone to incidental collisions.
 */
const WEIGHT_CONDITION = 3;
const WEIGHT_DESCRIPTION = 2;
const WEIGHT_RELPATH = 1;

/**
 * Deterministic lexical relevance of `task` against one page, in `[0, 1]`.
 *
 * A term scores its *best* field only, never the sum across fields — otherwise a
 * word that happens to appear in all three would outweigh three distinct topical
 * matches, and a page whose description merely restates its condition would beat
 * a page that genuinely covers more of the task. Normalizing by
 * `taskTerms * WEIGHT_CONDITION` makes the result a fraction of the best possible
 * score for *this* task, so values are comparable across pages of very different
 * lengths — which is the whole point, since these pages range from 686 to 9243
 * bytes.
 */
export function scoreRoute(task: string, page: WikiPage): number {
  const taskTerms = extractTerms(task);
  if (taskTerms.size === 0) return 0;

  const conditionTerms = extractTerms(page.condition);
  const descriptionTerms = extractTerms(page.description);
  const pathTerms = extractTerms(page.relPath);

  let weighted = 0;
  for (const term of taskTerms) {
    if (conditionTerms.has(term)) weighted += WEIGHT_CONDITION;
    else if (descriptionTerms.has(term)) weighted += WEIGHT_DESCRIPTION;
    else if (pathTerms.has(term)) weighted += WEIGHT_RELPATH;
  }

  return weighted / (taskTerms.size * WEIGHT_CONDITION);
}

/** What the router decided, and enough of the arithmetic to justify it in the prompt. */
export interface RouteDecision {
  /** Pages admitted, in injection order (best score first). */
  selected: WikiPage[];
  /** Every candidate not admitted — zero-scored or over budget — same ordering rule. */
  skipped: WikiPage[];
  /** Estimated tokens of `selected`. Invariant: `<= budget`. */
  totalTokens: number;
  /** The ceiling that was enforced. */
  budget: number;
  /** Estimated tokens of *all* candidates: what dumping the whole wiki would cost. */
  dumpTokens: number;
}

/**
 * Strip a leading `---` frontmatter block.
 *
 * The token figure has to describe what the model would actually read, and
 * frontmatter is machine metadata. Implemented as a raw-text strip rather than
 * via the markdown AST because `parseFrontmatter` returns the parsed *values* and
 * gives no way back to the body offset (src/drift/frontmatter.ts:6-15).
 */
function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

/**
 * Build the candidate set from `.mex/ROUTER.md`'s `edges:`.
 *
 * Never throws. A stale edge — a target that was renamed or deleted without the
 * router being updated — is skipped, because the router is agent-maintained prose
 * and *will* drift; that is precisely what `mex check` exists to report. Degrading
 * to "route over the pages that do exist" is right, and letting a stale edge take
 * down the session's `context` handler is not.
 */
export function buildWikiIndex(
  scaffold: MexScaffold,
  parseFrontmatter: (path: string) => Record<string, unknown> | null,
): WikiPage[] {
  const routerPath = resolve(scaffold.scaffoldPath, "ROUTER.md");
  const edges = parseFrontmatter(routerPath)?.edges;
  if (!Array.isArray(edges)) return [];

  const pages: WikiPage[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    // `edges` is typed `FrontmatterEdge[]` but comes from `YAML.parse` through an
    // unchecked cast (src/markdown.ts:25), so every field is really `unknown` at
    // runtime. Hand-authored wiki frontmatter drifts; guard rather than trust.
    const target = edge?.target;
    if (typeof target !== "string" || target.length === 0) continue;
    // A duplicated edge would inject the same page twice and double-charge the
    // budget for it.
    if (seen.has(target)) continue;

    const absPath = resolve(scaffold.scaffoldPath, target);
    if (!existsSync(absPath)) continue;

    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      // Unreadable (permissions, a directory where a file was expected): skip.
      continue;
    }
    const pageFrontmatter = parseFrontmatter(absPath);

    seen.add(target);
    pages.push({
      relPath: target,
      absPath,
      // Second read of the same file: `parseFrontmatter` is path-based
      // (src/drift/frontmatter.ts:6-15) and mex exports no content-based
      // `extractFrontmatter`. Paid once per index build, which `inject.ts` caches
      // against ROUTER.md's mtime, not once per turn.
      description: typeof pageFrontmatter?.description === "string" ? pageFrontmatter.description : "",
      condition: typeof edge.condition === "string" ? edge.condition : "",
      tokens: estimateTokens(stripFrontmatter(content)),
    });
  }

  return pages;
}

/**
 * Rank pages for `task`, then admit greedily under `budget`.
 *
 * Two details are load-bearing:
 *
 * 1. **The tie-break is explicit.** Equal scores fall back to `relPath` ascending.
 *    `Array.prototype.sort` stability would make the result depend on
 *    `ROUTER.md`'s edge order, and a prompt that changes when an unrelated line
 *    moves is not reviewable — nor is a diff of two transcripts meaningful.
 * 2. **Overflow does not stop admission.** A page that does not fit is skipped and
 *    the scan continues to smaller, lower-ranked pages. Stopping at the first
 *    overflow would let one large page starve the entire remaining budget — on this
 *    repo's own wiki `context/decisions.md` is 3778 estimated tokens against a 3000
 *    budget, so the first-overflow behaviour would route nothing whenever decisions
 *    ranked first.
 */
export function routeContext(task: string, pages: WikiPage[], budget: number): RouteDecision {
  let dumpTokens = 0;
  const ranked: Array<{ page: WikiPage; score: number }> = [];
  // Pages the task does not touch at all. Partitioned here rather than recovered
  // later by scanning `selected`/`skipped`, which would be quadratic and would tie
  // membership to object identity — fragile the moment a caller maps over `pages`.
  const irrelevant: WikiPage[] = [];

  for (const page of pages) {
    dumpTokens += page.tokens;
    const score = scoreRoute(task, page);
    if (score > 0) ranked.push({ page, score });
    else irrelevant.push(page);
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (a.page.relPath < b.page.relPath ? -1 : a.page.relPath > b.page.relPath ? 1 : 0),
  );

  const selected: WikiPage[] = [];
  const overflowed: WikiPage[] = [];
  let totalTokens = 0;

  for (const { page } of ranked) {
    if (totalTokens + page.tokens <= budget) {
      selected.push(page);
      totalTokens += page.tokens;
    } else {
      overflowed.push(page);
    }
  }

  // `skipped` is every candidate the model will *not* receive: over-budget pages
  // first, in rank order, then the irrelevant ones by path. Both groups matter —
  // the renderer names them so the model knows the wiki holds more, and a caller
  // reporting "N pages matched, none fit" reads the overflow group from here when
  // `selected` came back empty.
  irrelevant.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  return {
    selected,
    skipped: [...overflowed, ...irrelevant],
    totalTokens,
    budget,
    dumpTokens,
  };
}

/**
 * Render the text that actually gets injected.
 *
 * Three things it must accomplish, in order of importance:
 *
 * 1. Be unmistakably attributed to mex, so a user reading a transcript knows
 *    where this block came from and an agent knows not to treat it as user intent.
 * 2. Tell the model these pages were selected *for this task* — routed, not the
 *    whole wiki — and what that cost.
 * 3. Name the pages that were **not** routed, with real absolute paths. Without
 *    this the routing is lossy in a way the model cannot recover from: it would
 *    have no way to know the wiki holds more and no path to read it with. This is
 *    the difference between a budget and a truncation.
 */
export function renderInjection(decision: RouteDecision, task: string): string {
  const lines: string[] = [INJECTION_MARKER];

  lines.push("");
  lines.push("## mex wiki — pages routed for this task");
  lines.push("");
  lines.push(
    `The repo-local mex wiki was routed against your current task. These ${decision.selected.length} page(s) ` +
      `scored as relevant and fit the per-turn budget of ${decision.budget} tokens ` +
      `(routed: ~${decision.totalTokens} tokens; dumping the whole wiki would cost ~${decision.dumpTokens}). ` +
      `Read them before acting — they are this project's own conventions and decisions, ` +
      `and they override your general priors about how the code should look.`,
  );
  lines.push("");

  for (const page of decision.selected) {
    lines.push(`### .mex/${page.relPath} (~${page.tokens} tokens)`);
    if (page.description) lines.push(`_${page.description}_`);
    lines.push("");
    // Bodies are read here, not cached on the WikiPage, so the index stays cheap
    // metadata that `inject.ts` can hold across turns — only the handful of pages
    // that win the budget pay a read. A page that vanished between indexing and
    // rendering degrades to a pointer rather than throwing out of the handler.
    try {
      lines.push(stripFrontmatter(readFileSync(page.absPath, "utf-8")).trim());
    } catch {
      lines.push(`(unreadable at render time — read it directly at ${page.absPath})`);
    }
    lines.push("");
  }

  if (decision.skipped.length > 0) {
    lines.push("### Not routed for this task");
    lines.push("");
    lines.push(
      "These wiki pages exist but did not score as relevant to this task, or did not fit the budget. " +
        "They were not omitted because they are empty — read any of them on demand if the task turns out to touch them:",
    );
    lines.push("");
    for (const page of decision.skipped) {
      const why = page.condition ? ` — ${page.condition}` : "";
      lines.push(`- \`${page.absPath}\` (~${page.tokens} tokens)${why}`);
    }
    lines.push("");
  }

  // Echo the task, flattened and capped, so a reviewer can audit *why* these pages
  // were chosen without the injection becoming a second copy of the turn.
  const flatTask = task.replace(/\s+/g, " ").trim();
  const echo = flatTask.length <= TASK_ECHO_LIMIT ? flatTask : `${flatTask.slice(0, TASK_ECHO_LIMIT)}…`;
  lines.push(
    `Routing was lexical over \`.mex/ROUTER.md\` edge conditions against: ${JSON.stringify(echo)}. ` +
      "If it routed the wrong pages, read the right ones directly at the paths above.",
  );

  return lines.join("\n");
}
