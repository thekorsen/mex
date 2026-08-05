/**
 * The `context` event handler: mex's routed wiki injection.
 *
 * This is the capability that justifies shipping code at all. `.omp/rules/` and
 * `.omp/skills/` can tell a model the wiki *exists*, but a rule body is fetched on
 * demand by the model — nothing declarative can look at the turn that is about to
 * be sent, choose which pages it needs, and enforce a token ceiling before the
 * request leaves the process. Only a `context` handler runs at that moment.
 *
 * Three harness facts shape the implementation:
 *
 * 1. `context` handlers are **chained**: each one receives the previous handler's
 *    `messages`. Returning `{ messages }` replaces the array for the rest of the
 *    chain, so we must append to what we were given and never reconstruct it from
 *    an earlier snapshot — clobbering another extension's injection is a bug that
 *    only shows up once a second extension is installed.
 * 2. `context` fires **once per LLM call**, not once per session. Any filesystem
 *    work here is multiplied by the length of the conversation, which is why the
 *    index is cached (see {@link indexCache}).
 * 3. A throwing handler degrades the turn. mex failing to route must never break
 *    the user's session, so the whole body is wrapped (see the `catch` below).
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadMex, type MexScaffold } from "./mex.js";
import type { OmpContext, OmpContextEvent, OmpExtensionAPI, OmpMessage } from "./omp-api.js";
import {
  buildWikiIndex,
  renderInjection,
  routeContext,
  DEFAULT_INJECTION_BUDGET,
  INJECTION_MARKER,
  type WikiPage,
} from "./router.js";

/**
 * Declared locally rather than imported from a sibling registrar on purpose: every
 * module in this package needs the same shape, and importing it from one of them
 * would couple the registrars to each other for a two-line type.
 */
export type ScaffoldResolver = (cwd: string) => Promise<MexScaffold | null>;

interface CachedIndex {
  /** `ROUTER.md`'s mtime in ms when the index was built. */
  routerMtimeMs: number;
  pages: WikiPage[];
}

/**
 * Wiki index cache, keyed by project root.
 *
 * `context` fires on every LLM call, so an uncached `buildWikiIndex` would re-read
 * `ROUTER.md` plus every page it lists — a `readFileSync` and a markdown parse each
 * — on every turn, synchronously, on the path that assembles the request.
 *
 * The invalidation key is `ROUTER.md`'s mtime because the router *is* the candidate
 * set: adding, removing or retargeting an edge touches it, and `mex sync` rewrites
 * it when the wiki changes (.mex/ROUTER.md:4-16 is the live table). Editing a
 * page's body without touching the router leaves a stale `tokens` estimate until
 * the next router write — an acceptable trade, because the estimate only ranks and
 * budgets, while the text the model actually receives is re-read fresh at render
 * time by `renderInjection` (router.ts).
 *
 * Keyed by project root, never held as a single value, because one omp process can
 * serve sessions in different checkouts; mex's own process-global-state bug
 * (issue #11) is the cautionary tale for a cache that ignores the root.
 */
const indexCache = new Map<string, CachedIndex>();

/** Roles whose text can be a task. Assistant and tool turns describe work already done. */
const TASK_ROLE = "user";

/**
 * Register the routed-injection handler.
 *
 * Registration only. omp runs the factory before the runtime exists, so a runtime
 * action here would throw `ExtensionRuntimeNotInitializedError`; every filesystem
 * touch and every decision happens inside the handler, on a real turn.
 */
export function registerInjection(pi: OmpExtensionAPI, getScaffold: ScaffoldResolver): void {
  pi.on("context", async (event: OmpContextEvent, ctx: OmpContext) => {
    // One try/catch around the entire body. Everything below touches the
    // filesystem or hand-authored YAML, and a `context` handler that throws
    // degrades the very turn it was supposed to improve. "mex could not route"
    // must always resolve to "the turn goes out unmodified".
    try {
      const { parseFrontmatter } = await loadMex();
      const scaffold = await getScaffold(ctx.cwd);
      // No `.mex/` is the ordinary state of most repositories, not an error.
      // `undefined` leaves the chain's messages exactly as received.
      if (!scaffold) return undefined;

      const messages = event.messages;
      if (!Array.isArray(messages) || messages.length === 0) return undefined;

      // Idempotence: if the tail already carries our marker, a previous pass — or a
      // replayed or resumed turn — already injected. A second copy would double the
      // token cost and, worse, read as two separate sets of instructions.
      const last = messages[messages.length - 1];
      if (last && messageText(last).includes(INJECTION_MARKER)) return undefined;

      const task = latestTask(messages);
      // A turn with no user text to route against — a tool-result continuation, or
      // image-only content — has nothing to score. Injecting anyway would spend the
      // budget on noise.
      if (!task) return undefined;

      const pages = wikiIndex(scaffold, parseFrontmatter);
      if (pages.length === 0) return undefined;

      const decision = routeContext(task, pages, DEFAULT_INJECTION_BUDGET);
      // Nothing scored, or nothing fit. Return undefined rather than injecting an
      // empty block: a header announcing that mex selected zero pages costs tokens
      // to say nothing. The degradation is not lost, though — when candidates
      // scored but none fit the budget, `routeContext` leaves every one of them in
      // `decision.skipped` with `totalTokens === 0`, which is what lets the
      // `/mex-context` command report "N pages matched, none fit in <budget>"
      // instead of the user seeing unexplained silence.
      if (decision.selected.length === 0) return undefined;

      const injected: OmpMessage = {
        role: TASK_ROLE,
        content: [{ type: "text", text: renderInjection(decision, task) }],
        timestamp: Date.now(),
      };

      // Append into a fresh array: never mutate the input (a later handler in the
      // chain, and omp itself, hold that reference) and never drop an entry.
      return { messages: [...messages, injected] };
    } catch {
      return undefined;
    }
  });
}

/** Concatenate a message's text parts. Non-text content (images, tool payloads) carries no task text. */
function messageText(message: OmpMessage): string {
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const part of message.content) {
    if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/**
 * The task to route against: the text of the most recent user message.
 *
 * Walks from the end so a long conversation routes against what the user just
 * asked rather than the topic it opened on — per-turn routing is only worth doing
 * because relevance moves as the session moves.
 *
 * Skips any message carrying {@link INJECTION_MARKER}. Our own injection is
 * user-role, because omp's `context` event has no separate channel for extension
 * content, so without this guard a persisted injection from turn N becomes the
 * "task" on turn N+1 and the router feeds on its own output: the "Not routed"
 * section quotes every candidate's condition text, so scores would flatten toward
 * uniform and the ranking would stop meaning anything.
 */
function latestTask(messages: OmpMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== TASK_ROLE) continue;
    const text = messageText(message);
    if (!text.trim() || text.includes(INJECTION_MARKER)) continue;
    return text;
  }
  return "";
}

/** Build the wiki index, or reuse the cached one when `ROUTER.md` has not been rewritten. */
function wikiIndex(
  scaffold: MexScaffold,
  parseFrontmatter: (path: string) => Record<string, unknown> | null,
): WikiPage[] {
  const routerPath = resolve(scaffold.scaffoldPath, "ROUTER.md");
  let routerMtimeMs: number;
  try {
    routerMtimeMs = statSync(routerPath).mtimeMs;
  } catch {
    // No ROUTER.md means no routing table, and `buildWikiIndex` would return an
    // empty set anyway. Answer directly rather than caching a negative result under
    // a key whose invalidation signal does not exist.
    return [];
  }

  const cached = indexCache.get(scaffold.projectRoot);
  if (cached && cached.routerMtimeMs === routerMtimeMs) return cached.pages;

  const pages = buildWikiIndex(scaffold, parseFrontmatter);
  indexCache.set(scaffold.projectRoot, { routerMtimeMs, pages });
  return pages;
}

/**
 * Drop every cached index.
 *
 * Exported for tests, which rewrite `ROUTER.md` within one temp directory faster
 * than mtime resolution can distinguish — without this a second fixture in the same
 * test would silently be served the first fixture's index.
 */
export function clearWikiIndexCache(): void {
  indexCache.clear();
}
