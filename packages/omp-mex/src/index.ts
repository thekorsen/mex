/**
 * `mex-omp` — the oh-my-pi extension module for mex.
 *
 * # What this package owns, and what it deliberately does not
 *
 * mex already ships working *declarative* omp artifacts, projected by `mex setup`
 * from `templates/omp/`: the `.omp/AGENTS.md` anchor bridge, `.omp/RULES.md`,
 * `.omp/rules/mex-*.md`, `.omp/skills/mex-wiki/`, and `.omp/commands/mex-*.md`.
 * Those are verified working (ledger §4.1) and omp dedups discovered artifacts
 * **first-wins by name**, so shipping a second copy of any of them inside this
 * package would not add a capability — it would create a silent shadowing race
 * where whichever provider loads first wins and the other does nothing.
 *
 * This module therefore registers only what *no* declarative artifact can do:
 *
 * | Capability | Why it must be code |
 * |---|---|
 * | Routed per-turn context injection | A rule body is fetched on demand by the model; only a `context` handler can select pages per turn and enforce a token budget before the request leaves. |
 * | Graph retrieval tools backed by `node` subprocesses | omp runs under Bun, and Bun has no `node:sqlite`, so reading `.mex/graph.db` in-process fails (see `mex.ts` header). The tools still belong here because the extension keeps them in omp's native registry with no MCP server to configure and one install unit; for high-volume retrieval prefer `packages/mex-mcp`, whose persistent server amortises the ~340 ms per-call spawn. |
 * | `/mex-context`, `/mex-drift`, `/mex-graph-impact` | Two compute a value; the third is registered in code because sibling `commands/*.md` in an extension package are **not** discovered (verified live). |
 * | Supervised background drift watching | Nothing declarative has a timer. |
 * | Post-edit drift nudge | Requires observing `tool_result` for `edit`/`write`. |
 *
 * The full decision record is `docs/omp-integration/notes/16-omp-extension-module.md`.
 *
 * # Load-time contract, and why this file imports nothing
 *
 * omp runs this factory at load and *only registration is legal here*; runtime
 * action methods throw `ExtensionRuntimeNotInitializedError` during load
 * (`omp://extensions.md`, "Runtime model").
 *
 * **Every sibling module is loaded dynamically, from inside the first handler that
 * needs it. That is load-bearing, not a style choice.** omp imports the extension
 * entry through `loadLegacyPiModule()`, which installs a scoped Bun `onLoad` hook
 * to rewrite legacy pi specifiers (`omp://extension-loading.md` §"Module import and
 * factory contract"). That hook applies to the entry's whole *static* module graph,
 * and any module pulled in that way can no longer resolve `mex-agent` at all: the
 * hook re-parses transitive CommonJS dependencies as ESM and
 * `import { exists, FOLDER } from "@kwsites/file-exists"` inside `simple-git`
 * (`node_modules/simple-git/dist/esm/index.js:70`) stops resolving, so `loadMex()`
 * fails with `Export named 'FOLDER' not found`.
 *
 * Verified by bisection in live sessions: an entry with `import { registerInjection }
 * from "./inject.js"` silently injects nothing (the handler's own catch reports the
 * failure as "no scaffold"), while a byte-identical implementation reached through
 * `await import()` injects correctly and its output appears in
 * `before_provider_request`. A cache-busting query string does **not** help once a
 * module is already in the hooked graph, and `createRequire` cannot load
 * `dist/index.js` at all because it uses top-level await.
 *
 * So: no static imports here beyond types, which are erased. The one-time dynamic
 * load is memoised in {@link loadRegistrars}.
 */

// `./omp-api.js` is safe to import here: it is types only and references no other
// module, so nothing is pulled into the hooked graph.
//
// `./mex.js` is deliberately NOT imported, not even with `import type`. Bun's
// loader hook *resolves* a type-only specifier rather than erasing it, so
// `import type { MexScaffold } from "./mex.js"` in this file is enough to pull
// `mex.js` into the hooked graph and make `loadMex()` fail with
// `Export named 'FOLDER' not found`. Verified by adding exactly that one line to
// an otherwise-working probe: it flipped from injecting to silently not injecting.
// The scaffold shape is therefore restated structurally below.
import type { OmpExtensionAPI, OmpExtensionFactory } from "./omp-api.js";

/**
 * Structural restatement of `mex.ts`'s `MexScaffold`.
 *
 * Duplicated rather than imported for the load-order reason above. The two must
 * stay in step; they are three fields and `mex.ts` is the authority.
 */
interface Scaffold {
  projectRoot: string;
  scaffoldPath: string;
  hasGraph: boolean;
}

/** Resolver shared by every registered surface. */
export type ScaffoldResolver = (cwd: string) => Promise<Scaffold | null>;

/** The five registration functions, plus the scaffold resolver they all need. */
interface Registrars {
  registerInjection: (pi: OmpExtensionAPI, getScaffold: ScaffoldResolver) => void;
  registerTools: (pi: OmpExtensionAPI, getScaffold: ScaffoldResolver) => void;
  registerCommands: (pi: OmpExtensionAPI, getScaffold: ScaffoldResolver) => void;
  registerWatch: (pi: OmpExtensionAPI, getScaffold: ScaffoldResolver) => void;
  registerNudge: (pi: OmpExtensionAPI, getScaffold: ScaffoldResolver) => void;
  resolveScaffold: (cwd: string) => Promise<Scaffold | null>;
}

/**
 * Load the sibling modules, once per process.
 *
 * Dynamic by necessity — see the file header. Resolved against `import.meta.url`
 * rather than by bare relative specifier so the URL is absolute and unambiguous
 * regardless of the cwd omp was started in.
 */
let registrarsPromise: Promise<Registrars> | null = null;

function loadRegistrars(): Promise<Registrars> {
  registrarsPromise ??= (async () => {
    const base = new URL("./", import.meta.url).href;
    const [inject, tools, commands, watch, nudge, mex] = await Promise.all([
      import(`${base}inject.js`),
      import(`${base}tools.js`),
      import(`${base}commands.js`),
      import(`${base}watch.js`),
      import(`${base}nudge.js`),
      import(`${base}mex.js`),
    ]);
    return {
      registerInjection: inject.registerInjection,
      registerTools: tools.registerTools,
      registerCommands: commands.registerCommands,
      registerWatch: watch.registerWatch,
      registerNudge: nudge.registerNudge,
      resolveScaffold: mex.resolveScaffold,
    } as Registrars;
  })();
  return registrarsPromise;
}

/**
 * Lazy, cwd-keyed scaffold lookup shared by every registered surface.
 *
 * Caches the *promise*, so concurrent handlers on the same turn share one
 * resolution instead of racing three filesystem walks, and a resolved `null` is
 * not re-resolved on every subsequent turn.
 *
 * Keyed by cwd rather than stored as a single value because one omp process can
 * switch sessions across projects, and mex's own process-global-state bug
 * (issue #11) is the cautionary tale: a cache that ignores the project root serves
 * one project's answers to another.
 */
export function createScaffoldResolver(): ScaffoldResolver {
  const cache = new Map<string, Promise<Scaffold | null>>();
  return (cwd: string) => {
    const cached = cache.get(cwd);
    if (cached !== undefined) return cached;
    // The resolver itself is deferred too: `resolveScaffold` lives in a dynamically
    // loaded module, so the first call pays the module load and every later one does
    // not.
    const pending = loadRegistrars().then((r) => r.resolveScaffold(cwd));
    cache.set(cwd, pending);
    return pending;
  };
}

/**
 * Register one surface, deferring the module load to first use.
 *
 * The factory cannot `await`, so each surface is registered through a thin
 * forwarding shim: omp gets a synchronous registration now, and the real handler
 * body is attached once the module graph has loaded. Failures are swallowed for the
 * same reason every handler swallows — an extension that cannot load its own code
 * must degrade to doing nothing, never take the session down.
 */
function registerDeferred(
  pi: OmpExtensionAPI,
  getScaffold: ScaffoldResolver,
  pick: (registrars: Registrars) => (pi: OmpExtensionAPI, getScaffold: ScaffoldResolver) => void,
): void {
  void loadRegistrars().then(
    (registrars) => {
      pick(registrars)(pi, getScaffold);
    },
    () => {
      // Nothing to report to — `pi.logger` is the only sink and a load failure here
      // means the module carrying our reporting conventions is the thing that failed.
    },
  );
}

const factory: OmpExtensionFactory = (pi: OmpExtensionAPI) => {
  const getScaffold = createScaffoldResolver();

  pi.setLabel("mex");

  // Order is registration order, which is also `context`-chain order. Injection
  // first so a later handler in another extension sees mex's routed pages. The
  // single `Promise.all` inside `loadRegistrars` resolves once, so all five shims
  // attach in this order on the same microtask tick.
  registerDeferred(pi, getScaffold, (r) => r.registerInjection);
  registerDeferred(pi, getScaffold, (r) => r.registerTools);
  registerDeferred(pi, getScaffold, (r) => r.registerCommands);
  registerDeferred(pi, getScaffold, (r) => r.registerWatch);
  registerDeferred(pi, getScaffold, (r) => r.registerNudge);
};

export default factory;
