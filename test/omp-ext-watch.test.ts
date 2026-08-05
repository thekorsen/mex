import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_WATCH_INTERVAL_MS,
  createWatchTick,
  registerWatch,
  resolveWatchIntervalMs,
  type WatchNotifyLevel,
} from "../packages/omp-mex/src/watch.js";
import { EDIT_TOOL_NAMES, registerNudge } from "../packages/omp-mex/src/nudge.js";
import { resolveScaffold } from "../packages/omp-mex/src/mex.js";
import type {
  OmpContext,
  OmpExtensionAPI,
  OmpTimer,
  OmpToolResultEvent,
} from "../packages/omp-mex/src/omp-api.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-omp-watch-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Minimal `.git` + `.mex/ROUTER.md` project, which is exactly what `findConfig`
 * requires before it will return a config (src/config.ts:66-83) and therefore what
 * `resolveScaffold` needs to return non-null (packages/omp-mex/src/mex.ts:52-65).
 */
function scaffoldProject(root: string, opts: { graph?: boolean } = {}): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# router\n");
  if (opts.graph) writeFileSync(join(root, ".mex", "graph.db"), "");
}

/** Async wrapper matching the registrar contract: scaffold resolution now awaits `loadMex` (packages/omp-mex/src/mex.ts:122-125). */
const getScaffold = async (cwd: string) => resolveScaffold(cwd);

interface RecordedTimer {
  fn: (...args: unknown[]) => unknown;
  ms: number;
  handle: OmpTimer;
}

interface FakeCtx extends OmpContext {
  timers: RecordedTimer[];
  cleared: OmpTimer[];
  notices: Array<{ message: string; level?: WatchNotifyLevel }>;
  statuses: Array<{ key: string; text: string }>;
}

/**
 * A `ctx` that records timer scheduling instead of performing it. The whole point
 * of the watch contract is *which* scheduler is used, so the fake must be able to
 * tell `ctx.setInterval` from the global one.
 */
function fakeCtx(cwd: string, hasUI = true): FakeCtx {
  const timers: RecordedTimer[] = [];
  const cleared: OmpTimer[] = [];
  const notices: Array<{ message: string; level?: WatchNotifyLevel }> = [];
  const statuses: Array<{ key: string; text: string }> = [];
  return {
    cwd,
    hasUI,
    timers,
    cleared,
    notices,
    statuses,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
    setInterval: (fn, ms) => {
      const handle = { id: timers.length };
      timers.push({ fn, ms, handle });
      return handle;
    },
    setTimeout: (fn, ms) => {
      const handle = { id: timers.length };
      timers.push({ fn, ms, handle });
      return handle;
    },
    clearTimer: (timer) => cleared.push(timer),
  };
}

interface FakePi extends OmpExtensionAPI {
  handlers: Map<string, Array<(event: never, ctx: OmpContext) => unknown>>;
}

/** A `pi` that files handlers by event name so a test can drive them directly. */
function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: never, ctx: OmpContext) => unknown>>();
  const pi = {
    handlers,
    zod: undefined as unknown as OmpExtensionAPI["zod"],
    setLabel: () => {},
    on: (event: string, handler: (event: never, ctx: OmpContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: () => {},
    registerCommand: () => {},
  };
  return pi as unknown as FakePi;
}

/** Fire every handler registered for `event`, awaiting whatever they return. */
async function fire(pi: FakePi, event: string, payload: unknown, ctx: OmpContext): Promise<unknown[]> {
  const list = pi.handlers.get(event) ?? [];
  const results: unknown[] = [];
  for (const handler of list) {
    results.push(await (handler as (e: unknown, c: OmpContext) => unknown)(payload, ctx));
  }
  return results;
}

/** A `tool_result` payload with only the fields this extension reads. */
function toolResult(overrides: Partial<OmpToolResultEvent>): OmpToolResultEvent {
  return {
    toolName: "edit",
    input: {},
    content: [{ type: "text", text: "ok" }],
    ...overrides,
  };
}

describe("mex omp watch tick", () => {
  // The primary safety contract. Extensions are not sandboxed: a tick that
  // propagates a failure reaches the process as an uncaughtException /
  // unhandledRejection and ends the user's session. A rejected promise is the more
  // likely real-world failure because the real check is async
  // (src/drift/index.ts:67-70), so both shapes are pinned here.
  it("swallows a synchronously throwing check and reports it through notify, so a broken drift check cannot end the session", async () => {
    const notices: Array<{ message: string; level?: WatchNotifyLevel }> = [];
    const tick = createWatchTick(
      {
        check: () => {
          throw new Error("unreadable ROUTER.md");
        },
        notify: (message, level) => notices.push({ message, level }),
      },
      {},
    );

    await expect(tick()).resolves.toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("unreadable ROUTER.md");
    expect(notices[0].level).toBe("warn");
  });

  it("swallows a rejected promise from the check, since the real check is async and a floating rejection is the path that kills sessions", async () => {
    const notices: string[] = [];
    const tick = createWatchTick(
      {
        check: () => Promise.reject(new Error("graph.db locked")),
        notify: (message) => notices.push(message),
      },
      {},
    );

    await expect(tick()).resolves.toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("graph.db locked");
  });

  // The noise contract: a background timer that speaks every interval regardless
  // of new information gets the extension uninstalled, which loses the signal too.
  it("notifies on the first score and on every change, but stays silent when the score is unchanged", async () => {
    const notices: string[] = [];
    const scores = [80, 80, 71, 71];
    let i = 0;
    const tick = createWatchTick(
      {
        check: () => scores[i++],
        notify: (message) => notices.push(message),
      },
      {},
    );

    await tick(); // 80 — first observation is new information
    expect(notices).toHaveLength(1);

    await tick(); // 80 again — nothing new to say
    expect(notices).toHaveLength(1);

    await tick(); // 71 — a real change
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("80");
    expect(notices[1]).toContain("71");

    await tick(); // 71 again — quiet
    expect(notices).toHaveLength(2);
  });

  it("throws only under the MEX_OMP_WATCH_THROW verification seam, so the live session-survival check has a real wired path", async () => {
    const tick = createWatchTick(
      { check: () => 100, notify: () => {} },
      { MEX_OMP_WATCH_THROW: "1" },
    );

    await expect(tick()).rejects.toThrow(/deliberate watch failure/);
  });

  it("skips a tick that lands while the previous check is still running, so slow checks cannot stack or race the score comparison", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tick = createWatchTick(
      {
        check: async () => {
          started += 1;
          await gate;
          return 90;
        },
        notify: () => {},
      },
      {},
    );

    const first = tick();
    await tick(); // lands mid-flight: must be a no-op, not a second check
    expect(started).toBe(1);

    release?.();
    await first;

    // The guard must not latch: the next tick has to run.
    await tick();
    expect(started).toBe(2);
  });

  it("honours MEX_OMP_WATCH_INTERVAL_MS but floors it, so a misconfigured override cannot become a runaway loop", () => {
    expect(resolveWatchIntervalMs({})).toBe(DEFAULT_WATCH_INTERVAL_MS);
    expect(resolveWatchIntervalMs({ MEX_OMP_WATCH_INTERVAL_MS: "30000" })).toBe(30_000);
    expect(resolveWatchIntervalMs({ MEX_OMP_WATCH_INTERVAL_MS: "1" })).toBe(1_000);
    expect(resolveWatchIntervalMs({ MEX_OMP_WATCH_INTERVAL_MS: "nonsense" })).toBe(
      DEFAULT_WATCH_INTERVAL_MS,
    );
  });
});

describe("mex omp watch registration", () => {
  // The session-teardown safety contract. `ctx.setInterval` is isolated, unref'd
  // and auto-cleared; the global one is none of those.
  it("schedules the periodic check through ctx.setInterval rather than the global timer, and clears it on session_shutdown", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerWatch(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    // Proving a negative ("the global scheduler was not used") requires replacing
    // it for the duration of the call. The stub is deliberately inert: nothing in
    // this path legitimately needs a real global timer, so a call is the failure.
    const realSetInterval = globalThis.setInterval;
    const globalCalls: number[] = [];
    const target = globalThis as unknown as Record<string, unknown>;
    target.setInterval = (_fn: unknown, ms?: number) => {
      globalCalls.push(ms ?? 0);
      return 0;
    };
    try {
      await fire(pi, "session_start", {}, ctx);
    } finally {
      target.setInterval = realSetInterval;
    }

    expect(globalCalls).toEqual([]);
    expect(ctx.timers).toHaveLength(1);
    expect(ctx.timers[0].ms).toBe(DEFAULT_WATCH_INTERVAL_MS);

    await fire(pi, "session_shutdown", {}, ctx);
    expect(ctx.cleared).toEqual([ctx.timers[0].handle]);
  });

  it("tolerates session_shutdown with no timer registered, which is the ordinary case in a project that has no wiki", async () => {
    const pi = fakePi();
    registerWatch(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    await expect(fire(pi, "session_shutdown", {}, ctx)).resolves.toBeDefined();
    expect(ctx.cleared).toHaveLength(0);
  });

  // Both branches must be observable: an extension that says nothing when there is
  // no scaffold is indistinguishable from one that failed to load.
  it("reports the missing-scaffold branch and registers no timer when the project has no .mex/", async () => {
    const pi = fakePi();
    registerWatch(pi, getScaffold);
    const ctx = fakeCtx(tmpDir); // temp dir with no .git and no .mex

    await fire(pi, "session_start", {}, ctx);

    expect(ctx.timers).toHaveLength(0);
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0].message).toContain(".mex");
  });

  it("reports the resolved project root and whether a code graph exists when the scaffold is found", async () => {
    scaffoldProject(tmpDir, { graph: true });
    const pi = fakePi();
    registerWatch(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    await fire(pi, "session_start", {}, ctx);

    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0].message).toContain("code graph ready");
    expect(ctx.timers).toHaveLength(1);
  });

  it("says the code graph is missing when there is a scaffold but no graph.db, because retrieval degrades without it", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerWatch(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    await fire(pi, "session_start", {}, ctx);

    expect(ctx.notices[0].message).toContain("no code graph");
  });

  it("emits nothing in headless mode where ctx.hasUI is false and the ui methods are no-ops", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerWatch(pi, getScaffold);
    const ctx = fakeCtx(tmpDir, false);

    await fire(pi, "session_start", {}, ctx);

    expect(ctx.notices).toHaveLength(0);
    expect(ctx.timers).toHaveLength(1); // still watching; it just does not narrate
  });
});

describe("mex omp post-edit nudge", () => {
  // `tool_result` is middleware-style: each handler sees prior modifications, so a
  // returned `{content}` from an observer would silently overwrite the edit tool's
  // real output before the model reads it.
  it("returns undefined for a successful edit so it never overwrites the edit tool's own result", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerNudge(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    const results = await fire(
      pi,
      "tool_result",
      toolResult({ toolName: "edit", input: { path: "src/thing.ts" } }),
      ctx,
    );

    expect(results).toEqual([undefined]);
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0].message).toContain("/mex-drift");
  });

  it("ignores tool names outside the explicit edit set, so read-only tools never trigger a drift nudge", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerNudge(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    for (const toolName of ["read", "grep", "bash", "edit_history"]) {
      await fire(pi, "tool_result", toolResult({ toolName, input: { path: "src/a.ts" } }), ctx);
    }

    expect(ctx.notices).toHaveLength(0);
    expect(Object.keys(EDIT_TOOL_NAMES).sort()).toEqual([
      "edit",
      "multi_edit",
      "multiedit",
      "write",
    ]);
  });

  it("ignores a failed edit, because a tool that errored changed nothing on disk", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerNudge(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    await fire(
      pi,
      "tool_result",
      toolResult({ input: { path: "src/a.ts" }, isError: true }),
      ctx,
    );

    expect(ctx.notices).toHaveLength(0);
  });

  it("ignores malformed or missing input shapes without throwing, since another extension's tool may use any payload", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerNudge(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    const malformed: Array<Record<string, unknown>> = [
      {},
      { path: 42 },
      { path: "" },
      { path: "   " },
      { path: null },
      { paths: ["src/a.ts"] },
      { file_path: "src/a.ts" },
    ];
    for (const input of malformed) {
      const results = await fire(pi, "tool_result", toolResult({ input }), ctx);
      expect(results).toEqual([undefined]);
    }

    expect(ctx.notices).toHaveLength(0);
  });

  it("nudges at most once per cooldown window so an edit burst produces one line, not one per file", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerNudge(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    for (const name of ["a", "b", "c", "d"]) {
      await fire(
        pi,
        "tool_result",
        toolResult({ toolName: "write", input: { path: `src/${name}.ts` } }),
        ctx,
      );
    }

    expect(ctx.notices).toHaveLength(1);
  });

  it("distinguishes a .mex/ wiki edit from a source edit, because the two imply different next steps", async () => {
    scaffoldProject(tmpDir);
    const pi = fakePi();
    registerNudge(pi, getScaffold);
    const ctx = fakeCtx(tmpDir);

    await fire(
      pi,
      "tool_result",
      toolResult({ input: { path: ".mex/context/architecture.md" } }),
      ctx,
    );

    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0].message).toContain("wiki file");
  });

  it("keeps nudge state per project root, so an edit in one checkout cannot silence the nudge in another", async () => {
    const other = mkdtempSync(join(tmpdir(), "mex-omp-watch-other-"));
    try {
      scaffoldProject(tmpDir);
      scaffoldProject(other);
      const pi = fakePi();
      registerNudge(pi, getScaffold);
      const ctxA = fakeCtx(tmpDir);
      const ctxB = fakeCtx(other);

      const event = toolResult({ input: { path: "src/a.ts" } });
      await fire(pi, "tool_result", event, ctxA);
      await fire(pi, "tool_result", event, ctxB);

      // Both projects nudge: the cooldown is per project root, not process-global
      // (the shape of mex issue #11).
      expect(ctxA.notices).toHaveLength(1);
      expect(ctxB.notices).toHaveLength(1);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("stays quiet in a project with no wiki, where there is nothing for drift to be measured against", async () => {
    const pi = fakePi();
    registerNudge(pi, getScaffold);
    const ctx = fakeCtx(tmpDir); // no .mex/

    const results = await fire(pi, "tool_result", toolResult({ input: { path: "src/a.ts" } }), ctx);

    expect(results).toEqual([undefined]);
    expect(ctx.notices).toHaveLength(0);
  });
});
