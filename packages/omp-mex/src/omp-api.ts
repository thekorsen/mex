/**
 * Structural type surface for the subset of omp's `ExtensionAPI` this extension
 * uses.
 *
 * Why not import `@oh-my-pi/pi-coding-agent` directly? The harness is installed
 * globally (`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`) and
 * ships no `.d.ts`; adding it as a dependency would force an install this repo
 * deliberately does not run, and would pin a harness version an extension has no
 * business pinning. omp imports the entry module and calls the default export
 * (`omp://extension-loading.md`, "Module import and factory contract"), so the
 * only compile-time contract that matters is the shape of what we *call* on `pi`
 * and `ctx`. Declaring that shape locally keeps `tsc --noEmit` honest about our
 * own code without inventing a dependency.
 *
 * Consequence, stated plainly: these types are a hand-maintained mirror. They
 * cannot detect an upstream harness rename — only a live session can. That is
 * why acceptance for this package is a real `omp -p` run, not a typecheck.
 */

/** Minimal message shape used by the `context` event. Matches omp's `Message`. */
export interface OmpMessage {
  role: string;
  content: Array<{ type: string; text?: string }>;
  timestamp?: number;
  customType?: string;
  [key: string]: unknown;
}

/** Handle returned by `ctx.setInterval` / `ctx.setTimeout`. */
export type OmpTimer = unknown;

export interface OmpUI {
  notify(message: string, level?: "info" | "warn" | "error" | "success"): void;
  setStatus(key: string, text: string): void;
}

export interface OmpSessionManager {
  getBranch(): Array<{
    type?: string;
    customType?: string;
    data?: unknown;
    [key: string]: unknown;
  }>;
}

/** The `ctx` handed to event handlers and tool `execute`. */
export interface OmpContext {
  cwd: string;
  hasUI: boolean;
  ui: OmpUI;
  sessionManager?: OmpSessionManager;
  setInterval(fn: (...args: unknown[]) => unknown, ms: number, ...args: unknown[]): OmpTimer;
  setTimeout(fn: (...args: unknown[]) => unknown, ms: number, ...args: unknown[]): OmpTimer;
  clearTimer(timer: OmpTimer): void;
}

/** Command handlers get session-control methods on top of {@link OmpContext}. */
export interface OmpCommandContext extends OmpContext {
  waitForIdle(): Promise<void>;
}

export interface OmpToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

/**
 * `pi.zod` is the harness-injected `zod/v4` module. We only ever build object
 * schemas out of primitives, so the surface is narrow on purpose: a full zod
 * mirror would be a second dependency contract to maintain.
 */
export interface OmpZodType {
  optional(): OmpZodType;
  default(value: unknown): OmpZodType;
  describe(text: string): OmpZodType;
}

export interface OmpZod {
  z: {
    object(shape: Record<string, OmpZodType>): OmpZodType;
    string(): OmpZodType;
    number(): OmpZodType;
    boolean(): OmpZodType;
    array(inner: OmpZodType): OmpZodType;
    enum(values: readonly string[]): OmpZodType;
  };
}

export interface OmpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: OmpZodType;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: OmpToolResult) => void,
    ctx?: OmpContext,
  ): Promise<OmpToolResult>;
  /**
   * Optional custom renderer for the tool's transcript entry.
   *
   * Typed loosely on purpose: omp passes pi-tui component factories and theme
   * state here, and mirroring the pi-tui type surface is out of scope for this
   * package — a renderer that returns a plain string is all `tools.ts` needs, and
   * the harness catches renderer throws. Additive and optional, so no existing
   * tool definition changes shape.
   */
  renderResult?(...args: unknown[]): unknown;
}

/** Payloads for the events this extension subscribes to. */
export interface OmpContextEvent {
  messages: OmpMessage[];
}

export interface OmpToolResultEvent {
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

/** The registration surface. Only what this extension calls. */
export interface OmpExtensionAPI {
  zod: OmpZod;
  setLabel(label: string): void;
  on(event: "session_start", handler: (event: unknown, ctx: OmpContext) => unknown): void;
  on(event: "session_shutdown", handler: (event: unknown, ctx: OmpContext) => unknown): void;
  on(
    event: "context",
    handler: (
      event: OmpContextEvent,
      ctx: OmpContext,
    ) => Promise<{ messages: OmpMessage[] } | undefined> | { messages: OmpMessage[] } | undefined,
  ): void;
  on(
    event: "tool_result",
    handler: (event: OmpToolResultEvent, ctx: OmpContext) => unknown,
  ): void;
  registerTool(definition: OmpToolDefinition): void;
  registerCommand(
    name: string,
    definition: {
      description: string;
      handler: (args: string, ctx: OmpCommandContext) => Promise<void> | void;
    },
  ): void;
  appendEntry?(customType: string, data: unknown): void;
  sendMessage?(message: unknown, options?: Record<string, unknown>): void;
}

/** The default export omp calls at load time. */
export type OmpExtensionFactory = (pi: OmpExtensionAPI) => void;
