import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildWikiIndex,
  routeContext,
  scoreRoute,
  renderInjection,
  DEFAULT_INJECTION_BUDGET,
  INJECTION_MARKER,
} from "../packages/omp-mex/src/router.js";
import { registerInjection, clearWikiIndexCache } from "../packages/omp-mex/src/inject.js";
import type { MexScaffold } from "../packages/omp-mex/src/mex.js";
import type {
  OmpContext,
  OmpContextEvent,
  OmpExtensionAPI,
  OmpMessage,
} from "../packages/omp-mex/src/omp-api.js";

function parseFrontmatter(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;

  const out: Record<string, unknown> = {};
  const edges: Array<Record<string, string>> = [];
  let currentEdge: Record<string, string> | null = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (/^\s*-\s+target:\s+/.test(rawLine)) {
      currentEdge = { target: rawLine.replace(/^\s*-\s+target:\s+/, "") };
      edges.push(currentEdge);
      continue;
    }
    if (/^\s+condition:\s+/.test(rawLine) && currentEdge !== null) {
      currentEdge.condition = rawLine.replace(/^\s+condition:\s+/, "");
      continue;
    }
    const field = /^([A-Za-z0-9_-]+):\s+(.*)$/.exec(rawLine);
    if (!field) continue;
    const [, key, rawValue] = field;
    if (key === "edges") continue;
    try {
      out[key] = JSON.parse(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  if (edges.length > 0) out.edges = edges;
  return out;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-omp-routing-"));
  // The index is cached per project root against ROUTER.md's mtime. Temp roots are
  // unique per test so a collision is unlikely, but a fixture rewritten inside one
  // test would land within mtime resolution — clear the seam rather than rely on
  // filesystem timestamp granularity.
  clearWikiIndexCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** One `ROUTER.md` edge plus the page it points at. */
interface Fixture {
  target: string;
  condition: string;
  /** Page frontmatter description, omitted when empty. */
  description?: string;
  /** Page body. Token cost is `ceil(length / 4)`, so length is the budget dial. */
  body: string;
}

/**
 * Write a `.mex/` scaffold: a `ROUTER.md` whose `edges:` list the fixtures in the
 * given order, plus each fixture's page. Returns the scaffold the engine consumes.
 *
 * `extraEdges` are written into `ROUTER.md` with no page on disk, which is how the
 * stale-edge case is built.
 */
function wiki(fixtures: Fixture[], extraEdges: string[] = []): MexScaffold {
  const scaffoldPath = join(tmpDir, ".mex");
  mkdirSync(scaffoldPath, { recursive: true });

  const edgeLines = [
    ...fixtures.map((f) => `  - target: ${f.target}\n    condition: ${f.condition}`),
    ...extraEdges.map((t) => `  - target: ${t}\n    condition: a page that no longer exists`),
  ];
  writeFileSync(
    join(scaffoldPath, "ROUTER.md"),
    `---\nname: router\nedges:\n${edgeLines.join("\n")}\n---\n\n# Router\n`,
  );

  for (const f of fixtures) {
    const pagePath = join(scaffoldPath, f.target);
    mkdirSync(dirname(pagePath), { recursive: true });
    const front = f.description
      ? `---\ndescription: ${JSON.stringify(f.description)}\n---\n`
      : "";
    writeFileSync(pagePath, `${front}${f.body}`);
  }

  return { projectRoot: tmpDir, scaffoldPath, hasGraph: false };
}

/** A message the handler will treat as the task. */
function userMessage(text: string): OmpMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

type ContextHandler = (
  event: OmpContextEvent,
  ctx: OmpContext,
) => Promise<{ messages: OmpMessage[] } | undefined> | { messages: OmpMessage[] } | undefined;

/**
 * Register the injection handler against a recording `pi` and return the handler.
 *
 * The fakes are cast because `OmpExtensionAPI`/`OmpContext` mirror a harness that
 * ships no types (packages/omp-mex/src/omp-api.ts:5-13); a full literal would
 * declare a zod module and timer surface this handler never touches.
 */
function handlerFor(getScaffold: (cwd: string) => Promise<MexScaffold | null>): ContextHandler {
  const registered = new Map<string, ContextHandler>();
  const pi = {
    on(event: string, handler: ContextHandler) {
      registered.set(event, handler);
    },
  } as unknown as OmpExtensionAPI;

  registerInjection(pi, getScaffold);

  const handler = registered.get("context");
  if (!handler) throw new Error("registerInjection did not register a `context` handler");
  return handler;
}

/** A `ctx` carrying only what the injection handler reads. */
function contextFor(cwd: string): OmpContext {
  return { cwd, hasUI: false } as unknown as OmpContext;
}

describe("wiki index", () => {
  it("skips a ROUTER edge whose target is gone instead of throwing — the router is agent-authored prose that drifts, and a stale edge must not take down the context handler for every remaining page", () => {
    const scaffold = wiki(
      [{ target: "context/live.md", condition: "when doing live work", body: "body" }],
      ["context/deleted.md", "patterns/renamed.md"],
    );

    const pages = buildWikiIndex(scaffold, parseFrontmatter);

    expect(pages.map((p) => p.relPath)).toEqual(["context/live.md"]);
  });

  it("returns an empty candidate set when ROUTER.md has no edges, so a scaffold without a routing table degrades to no injection rather than an error", () => {
    const scaffoldPath = join(tmpDir, ".mex");
    mkdirSync(scaffoldPath, { recursive: true });
    writeFileSync(join(scaffoldPath, "ROUTER.md"), "---\nname: router\n---\n\n# Router\n");

    expect(buildWikiIndex({ projectRoot: tmpDir, scaffoldPath, hasGraph: false }, parseFrontmatter)).toEqual([]);
  });

  it("excludes frontmatter from the token estimate so the budget reflects what the model reads, not the machine metadata attached to it", () => {
    const body = "x".repeat(400);
    const scaffold = wiki([
      {
        target: "context/a.md",
        condition: "when doing anything",
        description: "a description long enough to move a token count if it were counted",
        body,
      },
    ]);

    // 400 body chars at 4 chars/token. A counted frontmatter block would exceed this.
    expect(buildWikiIndex(scaffold, parseFrontmatter)[0].tokens).toBe(100);
  });
});

describe("task routing", () => {
  it("gives task A's pages to task A only — a login task selects the auth page and scores the database page at zero, which is the entire reason routing exists instead of dumping the wiki", () => {
    const scaffold = wiki([
      {
        target: "context/auth.md",
        condition: "when working on authentication, login, or sessions",
        body: "auth notes",
      },
      {
        target: "context/database.md",
        condition: "when working on database migrations or schema",
        body: "db notes",
      },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);

    const decision = routeContext(
      "fix the login redirect after authentication",
      pages,
      DEFAULT_INJECTION_BUDGET,
    );

    expect(decision.selected.map((p) => p.relPath)).toEqual(["context/auth.md"]);
    expect(decision.skipped.map((p) => p.relPath)).toEqual(["context/database.md"]);
  });

  it("matches an imperative task against a gerund condition — every condition mex ships is phrased 'when writing…' while users type 'write…', so without suffix folding the shipped routing table would match almost nothing", () => {
    const scaffold = wiki([
      {
        target: "context/conventions.md",
        condition: "when writing new code or reviewing code",
        body: "conventions",
      },
    ]);
    const [page] = buildWikiIndex(scaffold, parseFrontmatter);

    expect(scoreRoute("write a new drift checker", page)).toBeGreaterThan(0);
  });

  it("scores zero when nothing overlaps, and a zero-scored page is never admitted no matter how much budget is free", () => {
    const scaffold = wiki([
      {
        target: "context/deployment.md",
        condition: "when deploying to kubernetes",
        body: "deployment",
      },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);

    expect(scoreRoute("rename a local variable", pages[0])).toBe(0);
    expect(routeContext("rename a local variable", pages, 100_000).selected).toEqual([]);
  });

  it("ranks a condition hit above a description-only hit, because a condition was authored to answer 'load this page for this task' while a description merely says what the page contains", () => {
    const scaffold = wiki([
      {
        target: "context/by-condition.md",
        condition: "when handling websocket reconnection",
        body: "a",
      },
      {
        target: "context/by-description.md",
        condition: "when doing unrelated things",
        description: "notes about websocket reconnection",
        body: "b",
      },
    ]);
    const [byCondition, byDescription] = buildWikiIndex(scaffold, parseFrontmatter);
    const task = "websocket reconnection";

    expect(scoreRoute(task, byCondition)).toBeGreaterThan(scoreRoute(task, byDescription));
  });

  it("breaks a score tie on relPath ascending rather than on ROUTER.md edge order, so reordering an unrelated router line cannot silently reorder the prompt and make two transcripts undiffable", () => {
    const condition = "when writing api handlers";
    // Deliberately listed zebra-first in ROUTER.md: sort stability alone would
    // preserve that order and hide the missing tie-break.
    const scaffold = wiki([
      { target: "zebra.md", condition, body: "z".repeat(40) },
      { target: "alpha.md", condition, body: "a".repeat(40) },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);
    const task = "writing api handlers";

    expect(scoreRoute(task, pages[0])).toBe(scoreRoute(task, pages[1]));
    expect(
      routeContext(task, pages, DEFAULT_INJECTION_BUDGET).selected.map((p) => p.relPath),
    ).toEqual(["alpha.md", "zebra.md"]);
  });
});

describe("budget enforcement", () => {
  it("skips a page that does not fit and keeps admitting smaller ones — stopping at the first overflow would let a single large page starve the whole remaining budget", () => {
    const scaffold = wiki([
      {
        target: "big.md",
        // Scores higher than small.md (three condition terms vs two), so it is
        // ranked first and is the page that overflows.
        condition: "when deploying kubernetes clusters",
        body: "x".repeat(4000),
      },
      { target: "small.md", condition: "when deploying kubernetes", body: "y".repeat(40) },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);

    const decision = routeContext("deploying kubernetes clusters", pages, 500);

    expect(decision.selected.map((p) => p.relPath)).toEqual(["small.md"]);
    expect(decision.skipped.map((p) => p.relPath)).toEqual(["big.md"]);
    expect(decision.totalTokens).toBeLessThanOrEqual(500);
  });

  it("never exceeds the budget across a range of budgets, which is the invariant the whole per-turn design rests on", () => {
    const scaffold = wiki([
      { target: "a.md", condition: "when handling caching", body: "a".repeat(1200) },
      { target: "b.md", condition: "when handling caching layers", body: "b".repeat(800) },
      { target: "c.md", condition: "when handling caching keys", body: "c".repeat(400) },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);

    for (const budget of [0, 1, 50, 101, 200, 350, 600, 10_000]) {
      const decision = routeContext("handling caching layers and keys", pages, budget);
      expect(decision.totalTokens).toBeLessThanOrEqual(budget);
      expect(decision.totalTokens).toBe(
        decision.selected.reduce((sum, p) => sum + p.tokens, 0),
      );
    }
  });

  it("reports matched-but-unfittable candidates in `skipped` with `totalTokens` at zero, so a wiki whose every page exceeds the budget is a state a command can explain rather than unexplained silence", () => {
    const scaffold = wiki([
      { target: "a.md", condition: "when handling caching", body: "a".repeat(1200) },
      { target: "b.md", condition: "when handling caching layers", body: "b".repeat(800) },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);

    const decision = routeContext("handling caching layers", pages, 1);

    expect(decision.selected).toEqual([]);
    expect(decision.skipped.map((p) => p.relPath).sort()).toEqual(["a.md", "b.md"]);
    expect(decision.totalTokens).toBe(0);
  });

  it("counts every candidate in `dumpTokens` regardless of selection, which is what makes the routed-vs-dumped comparison meaningful", () => {
    const scaffold = wiki([
      { target: "a.md", condition: "when handling caching", body: "a".repeat(400) },
      { target: "z.md", condition: "when doing something unrelated", body: "z".repeat(400) },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);

    const decision = routeContext("handling caching", pages, DEFAULT_INJECTION_BUDGET);

    expect(decision.selected.map((p) => p.relPath)).toEqual(["a.md"]);
    expect(decision.dumpTokens).toBe(200);
    expect(decision.totalTokens).toBe(100);
  });
});

describe("injection text", () => {
  it("leads with the literal marker so an injection is greppable in a transcript and the handler can recognise its own output", () => {
    const scaffold = wiki([
      { target: "context/auth.md", condition: "when working on login", body: "auth body text" },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);
    const task = "working on login";

    const text = renderInjection(routeContext(task, pages, DEFAULT_INJECTION_BUDGET), task);

    expect(text.split("\n")[0]).toBe(INJECTION_MARKER);
  });

  it("names unrouted pages at their real absolute paths — without them the routing is lossy in a way the model cannot recover from, since it would not know the wiki holds more or how to reach it", () => {
    const scaffold = wiki([
      { target: "context/auth.md", condition: "when working on login", body: "auth body" },
      { target: "context/db.md", condition: "when migrating a schema", body: "db body" },
    ]);
    const pages = buildWikiIndex(scaffold, parseFrontmatter);
    const task = "working on login";

    const text = renderInjection(routeContext(task, pages, DEFAULT_INJECTION_BUDGET), task);

    expect(text).toContain("auth body");
    expect(text).toContain(resolve(scaffold.scaffoldPath, "context/db.md"));
    expect(text).not.toContain("db body");
  });
});

describe("context handler", () => {
  it("leaves messages untouched in a project with no .mex/ scaffold — most repositories have no wiki, and that is an ordinary state rather than an error", async () => {
    const handler = handlerFor(async () => null);
    const messages = [userMessage("fix the login redirect")];

    expect(await handler({ messages }, contextFor(tmpDir))).toBeUndefined();
  });

  it("leaves messages untouched when the latest turn has no user text to route against, so a tool-result continuation does not spend the budget on noise", async () => {
    const scaffold = wiki([
      { target: "context/auth.md", condition: "when working on login", body: "auth body" },
    ]);
    const handler = handlerFor(async () => scaffold);

    const result = await handler(
      { messages: [{ role: "assistant", content: [{ type: "text", text: "working on login" }] }] },
      contextFor(tmpDir),
    );

    expect(result).toBeUndefined();
  });

  it("appends the routed block and preserves every message it was given — context handlers are chained, so replacing or trimming the array would silently discard another extension's contribution", async () => {
    const scaffold = wiki([
      { target: "context/auth.md", condition: "when working on login", body: "auth body" },
    ]);
    const handler = handlerFor(async () => scaffold);
    const earlier = userMessage("hello");
    const priorHandlerOutput: OmpMessage = {
      role: "user",
      content: [{ type: "text", text: "another extension's injected context" }],
    };
    const task = userMessage("fix the login flow");
    const messages = [earlier, priorHandlerOutput, task];

    const result = await handler({ messages }, contextFor(tmpDir));

    expect(result).toBeDefined();
    const out = result!.messages;
    expect(out.slice(0, 3)).toEqual([earlier, priorHandlerOutput, task]);
    expect(out).toHaveLength(4);
    expect(out[3].role).toBe("user");
    expect(out[3].content[0].text).toContain(INJECTION_MARKER);
    // The input array is held by omp and by later handlers in the chain.
    expect(messages).toHaveLength(3);
  });

  it("does not inject a second copy when its own marker is already the last message, so a replayed or re-entered turn cannot double the token cost or read as two sets of instructions", async () => {
    const scaffold = wiki([
      { target: "context/auth.md", condition: "when working on login", body: "auth body" },
    ]);
    const handler = handlerFor(async () => scaffold);
    const messages = [userMessage("fix the login flow")];

    const first = await handler({ messages }, contextFor(tmpDir));
    expect(first).toBeDefined();

    expect(await handler({ messages: first!.messages }, contextFor(tmpDir))).toBeUndefined();
  });

  it("routes against the newest user turn rather than a stale injection of its own, because an injection is user-role and quoting it back as the task would collapse every score toward uniform", async () => {
    const scaffold = wiki([
      { target: "context/auth.md", condition: "when working on login", body: "auth body" },
      { target: "context/db.md", condition: "when migrating a database schema", body: "db body" },
    ]);
    const handler = handlerFor(async () => scaffold);

    const first = await handler({ messages: [userMessage("fix the login flow")] }, contextFor(tmpDir));
    expect(first!.messages[1].content[0].text).toContain("auth body");

    // A new turn on a different topic, with the previous injection still in history.
    const second = await handler(
      { messages: [...first!.messages, userMessage("migrating the database schema")] },
      contextFor(tmpDir),
    );

    const injected = second!.messages[second!.messages.length - 1].content[0].text ?? "";
    expect(injected).toContain("db body");
    expect(injected).not.toContain("auth body");
  });

  it("leaves messages untouched when nothing scores, rather than injecting a header that announces zero pages and costs tokens to say nothing", async () => {
    const scaffold = wiki([
      { target: "context/deploy.md", condition: "when deploying to kubernetes", body: "deploy" },
    ]);
    const handler = handlerFor(async () => scaffold);

    const result = await handler(
      { messages: [userMessage("rename a local variable")] },
      contextFor(tmpDir),
    );

    expect(result).toBeUndefined();
  });

  it("survives a scaffold resolver that throws — a context handler that propagates degrades the very turn it was meant to improve, so mex failing to route must always mean 'send the turn unmodified'", async () => {
    const handler = handlerFor(async () => {
      throw new Error("resolver exploded");
    });

    const result = await handler(
      { messages: [userMessage("fix the login flow")] },
      contextFor(tmpDir),
    );

    expect(result).toBeUndefined();
  });
});

describe("this repository's own wiki", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const scaffoldPath = resolve(repoRoot, ".mex");

  it("routes strictly cheaper than dumping the wiki — the whole justification for a scoring engine is that a subset of pages costs less than all of them", () => {
    // Robust against wiki edits: skip only if this checkout genuinely has no
    // routing table, and derive the task from the cheapest page's own condition so
    // the assertion cannot depend on today's page titles or budget headroom.
    if (!existsSync(resolve(scaffoldPath, "ROUTER.md"))) return;

    const pages = buildWikiIndex({ projectRoot: repoRoot, scaffoldPath, hasGraph: false }, parseFrontmatter);
    if (pages.length < 2) return;

    const cheapest = pages.reduce((min, p) => (p.tokens < min.tokens ? p : min));
    const decision = routeContext(cheapest.condition, pages, DEFAULT_INJECTION_BUDGET);

    expect(decision.selected.length).toBeGreaterThan(0);
    expect(decision.totalTokens).toBeGreaterThan(0);
    expect(decision.totalTokens).toBeLessThanOrEqual(DEFAULT_INJECTION_BUDGET);
    expect(decision.dumpTokens).toBeGreaterThan(decision.totalTokens);
  });
});
