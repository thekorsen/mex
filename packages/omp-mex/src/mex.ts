/**
 * The bridge from this extension to `mex-agent`.
 *
 * # Two Bun-shaped constraints decide everything in this file
 *
 * omp is a Bun program (`#!/usr/bin/env bun`, `which omp`) and loads extension
 * modules with Bun's own loader. Two consequences were measured live in a real
 * `omp -p` session, and both invalidate the obvious implementation:
 *
 * 1. **A static `import ... from "mex-agent"` fails at extension load.** omp
 *    imports the entry through `loadLegacyPiModule()`, which installs a scoped
 *    Bun `onLoad` hook to rewrite legacy pi specifiers
 *    (`omp://extension-loading.md` §"Module import and factory contract"). That
 *    hook returns source text for every module it sees, so transitive CommonJS
 *    dependencies are re-parsed as ESM and their `exports.X = ...` assignments
 *    stop being visible as named exports. `mex-agent` reaches `simple-git`, which
 *    does `import { exists, FOLDER } from "@kwsites/file-exists"`
 *    (`node_modules/simple-git/dist/esm/index.js:70`) — a CJS package. The load
 *    fails with `Export named 'FOLDER' not found in module …/@kwsites/file-exists/dist/index.js`
 *    and omp reports `Failed to load extension`, so the whole integration
 *    silently does nothing. Reproduced outside omp by registering an equivalent
 *    `Bun.plugin` `onLoad` hook, which fails the same way one dependency deeper
 *    (`createDeferred` from `@kwsites/promise-deferred`).
 *
 *    The fix is {@link loadMex}: resolve the specifier to a `file://` URL and
 *    `import()` it from *inside a handler*, after load, where the scoped hook is
 *    no longer installed. Verified: a static import fails, a runtime
 *    `import(import.meta.resolve("mex-agent"))` returns all 19 exports.
 *
 * 2. **`node:sqlite` does not exist in Bun**, so the code graph cannot be read
 *    in-process at all. `runGraphScope` called inside a live omp session returns
 *    `{"type":"error","code":"GRAPH_UNAVAILABLE","message":"…Underlying error:
 *    ResolveMessage: No such built-in module: node:sqlite"}`. The identical call
 *    under `node` returns real JSONL facts. This is why graph retrieval is a
 *    subprocess (`spawn.ts`) rather than a function call, and it is the single
 *    most consequential finding of this lane.
 *
 * Everything mex exposes that does *not* touch the graph — `findConfig`,
 * `runDriftCheck`, `parseFrontmatter` — works fine in-process once loaded through
 * {@link loadMex}. Drift scored 100/100 from inside a live session.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
// NO import of "mex-agent" appears in this file, not even `import type`.
// Counter-intuitively, a type-only import is NOT safe here: omp loads extension
// source through a scoped Bun `onLoad` hook, and Bun resolves the specifier rather
// than erasing the declaration, so `import type { findConfig } from "mex-agent"`
// reproduces the exact `Export named 'FOLDER' not found` load failure the header
// describes. Verified by adding one such line to an otherwise-working probe
// package: it went from loading cleanly to failing. That is why `MexModule` below
// is a hand-written structural mirror instead of `typeof import("mex-agent").x`.

/** Estimator constant mirroring `src/graph/agent-protocol.ts:14`. */
export const TOKEN_CHARS = 4;

/**
 * Deterministic token estimate over raw text, same divisor mex uses for its own
 * budget ledger so the numbers in a routing report are comparable to the numbers
 * in a JSONL `meta` record.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS);
}

/** A resolved mex project: the git root plus its `.mex/` scaffold. */
export interface MexScaffold {
  /** Project root as `findConfig` resolved it. */
  projectRoot: string;
  /** Absolute path to `<projectRoot>/.mex`. */
  scaffoldPath: string;
  /** Whether a built code graph exists. Retrieval degrades without it. */
  hasGraph: boolean;
}

/**
 * The subset of `mex-agent`'s public API this extension calls in-process.
 *
 * A hand-written structural mirror, *not* `typeof import("mex-agent").findConfig`.
 * See the import note above: any reference to the `"mex-agent"` specifier in this
 * file — including a type-only one — makes the extension fail to load under omp.
 * The cost is stated plainly: `tsc` cannot catch a rename in `src/index.ts` here.
 * That is the same trade `omp-api.ts` makes for the harness, for the same reason,
 * and it is why acceptance for this package is a live session, not a typecheck.
 *
 * Shapes mirror `dist/index.d.ts`: `findConfig(startDir?) => MexConfig` (`:164`),
 * `runDriftCheck(config, opts?) => Promise<DriftReport>` (`:502`),
 * `parseFrontmatter(filePath) => ScaffoldFrontmatter | null` (`:505`). Only the
 * fields this package reads are declared.
 *
 * Only the graph-free operations appear. The four retrieval functions are
 * deliberately absent: they are unreachable under Bun (see the file header), so
 * naming them would advertise a capability that cannot work and invite a future
 * reader to "simplify" `spawn.ts` back into a direct call.
 */
export interface MexModule {
  findConfig(startDir?: string): { projectRoot: string; scaffoldRoot: string };
  runDriftCheck(
    config: { projectRoot: string; scaffoldRoot: string },
    opts?: { graphWarning?: (message: string) => void },
  ): Promise<{
    score: number;
    filesChecked: number;
    issues: ReadonlyArray<{
      severity: string;
      code: string;
      file: string;
      line: number | null;
      message: string;
    }>;
  }>;
  parseFrontmatter(filePath: string): Record<string, unknown> | null;
}

/**
 * Cached module promise.
 *
 * One `import()` per process, not per turn: `context` fires on every LLM call and
 * a resolved dynamic import is cheap only after the first. The *promise* is
 * cached rather than the module so concurrent handlers share one load. A
 * rejection is cached too — deliberately: if `mex-agent` cannot be loaded, that
 * fact will not change within the process, and retrying on every turn would turn
 * one failure into a per-call cost.
 */
let modulePromise: Promise<MexModule> | null = null;

/**
 * Load `mex-agent` at runtime, from inside a handler.
 *
 * Never call this during the extension factory: at that point omp's scoped loader
 * hook is still installed and the import fails.
 *
 * Two resolution strategies, in order, because the two runtimes that load this
 * file disagree about which one exists:
 *
 * 1. **`import.meta.resolve("mex-agent")`** — the only form that works under omp.
 *    It yields a `file://` URL, which sidesteps the specifier rewriting described
 *    in the file header. A bare specifier fails there.
 * 2. **A bare `import("mex-agent")`** — the fallback, for Vitest. Vitest transforms
 *    this module for its SSR pipeline, where `import.meta.resolve` is genuinely
 *    absent (`__vite_ssr_import_meta__.resolve is not a function`). No loader hook
 *    is installed there, so the bare specifier resolves normally.
 *
 * Ordered resolve-first rather than try-bare-first because the omp path is the one
 * that must not regress: under omp a bare import does not merely fail, it fails
 * *late* and leaves the extension registered but inert.
 */
export function loadMex(): Promise<MexModule> {
  modulePromise ??= (async () => {
    // `import.meta.resolve` MUST be called as a member expression, never lifted
    // into a local first: Bun enforces the binding and a detached reference throws
    // `TypeError: import.meta.resolve must be bound to an import.meta object`.
    // That failure is caught by the callers' guards, so it presents as "no mex
    // scaffold" — a silent, plausible-looking wrong answer rather than an error.
    const meta = import.meta as { resolve?: unknown };
    if (typeof meta.resolve === "function") {
      // Dynamic by necessity: the specifier is a runtime-resolved file:// URL, and
      // a static import of "mex-agent" fails at extension load under omp.
      return (await import(import.meta.resolve("mex-agent"))) as MexModule;
    }
    return (await import("mex-agent")) as MexModule;
  })();
  return modulePromise;
}

/**
 * Resolve the mex scaffold for a session, or `null`.
 *
 * `findConfig` throws when there is no `.mex/` (`src/config.ts:54-101`), and an
 * extension handler must never throw — a `session_start` throw is reported as an
 * extension error and the mex surface silently does nothing useful. Returning
 * `null` makes "this project has no wiki" an ordinary, reportable state.
 *
 * Async because {@link loadMex} is. Every caller already runs inside a handler,
 * which is the only place either is legal.
 */
export async function resolveScaffold(cwd: string): Promise<MexScaffold | null> {
  try {
    const mex = await loadMex();
    const config = mex.findConfig(cwd);
    const scaffoldPath = resolve(config.projectRoot, ".mex");
    if (!existsSync(scaffoldPath)) return null;
    return {
      projectRoot: config.projectRoot,
      scaffoldPath,
      hasGraph: existsSync(resolve(scaffoldPath, "graph.db")),
    };
  } catch {
    return null;
  }
}
