/**
 * Instrumentation helper for Claude Code agents.
 *
 * Small helper agents call to emit schema-valid events (see
 * /docs/event-schema.md) at the right moments: start, stop, before/after
 * calling another agent as a tool, and arbitrary log lines.
 *
 * Every emitter here is fire-and-forget: it builds a payload, kicks off a
 * POST, and returns immediately without awaiting the network call. If the
 * event server isn't running (connection refused, DNS failure, timeout,
 * non-2xx response, etc.) the failure is swallowed and reported through
 * `onError` (default: a single `console.warn`) — it is never thrown back
 * into the caller and never blocks or crashes the agent process.
 */

import type {
  AgentEvent,
  ErrorEvent,
  Status,
} from "./types.js";

export type {
  AgentEvent,
  AgentStartEvent,
  AgentStopEvent,
  EventType,
  ErrorEvent,
  LogEvent,
  Status,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "./types.js";

/** Default target if nothing else is configured. */
const DEFAULT_SERVER_URL = "http://localhost:4000/events";
const DEFAULT_TIMEOUT_MS = 2000;

export interface InstrumentationConfig {
  /** Stable unique identifier for this agent instance. */
  agentId?: string;
  /** Team/crew this agent belongs to (multi-agent setups). */
  team?: string;
  /** Event server endpoint to POST events to. */
  serverUrl?: string;
  /** Abort the POST after this many ms so a dead server can't hang anything. */
  timeoutMs?: number;
  /** Flip off entirely (e.g. in tests) — emitters become true no-ops. */
  enabled?: boolean;
  /** Called with any dispatch failure. Defaults to a rate-limited console.warn. Must not throw. */
  onError?: (err: unknown, event: AgentEvent) => void;
}

let warnedOnce = false;
function defaultOnError(err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  // Soft warning only — one per process, so a consistently-unreachable
  // server doesn't spam logs on every event.
  // eslint-disable-next-line no-console
  console.warn(
    "[instrumentation] failed to reach event server (further failures in this process are silenced):",
    err instanceof Error ? err.message : err,
  );
}

function envServerUrl(): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env.INSTRUMENTATION_SERVER_URL || undefined;
}

function resolveConfig(overrides: InstrumentationConfig): Required<
  Pick<InstrumentationConfig, "serverUrl" | "timeoutMs" | "enabled" | "onError">
> &
  Pick<InstrumentationConfig, "agentId" | "team"> {
  return {
    agentId: overrides.agentId,
    team: overrides.team,
    serverUrl: overrides.serverUrl ?? envServerUrl() ?? DEFAULT_SERVER_URL,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    enabled: overrides.enabled ?? true,
    onError: overrides.onError ?? defaultOnError,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Fire-and-forget dispatch. Intentionally not `async` from the caller's
 * point of view — this function never returns a promise the caller is
 * expected to await, and any error inside is caught here.
 */
function dispatch(event: AgentEvent, cfg: ReturnType<typeof resolveConfig>): void {
  if (!cfg.enabled) return;

  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller?.abort(), cfg.timeoutMs);
    // Deliberately not awaited — this is the "fire" in fire-and-forget.
    fetch(cfg.serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
      .catch((err) => {
        // Network error, connection refused, timeout abort, etc. Never
        // let this surface to the caller.
        cfg.onError(err, event);
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  } catch (err) {
    // Defensive: even constructing/starting the request should never throw
    // into the caller (e.g. `fetch` unavailable in some exotic runtime).
    if (timer) clearTimeout(timer);
    cfg.onError(err, event);
  }
}

function requireAgentId(cfg: ReturnType<typeof resolveConfig>): string {
  if (!cfg.agentId) {
    throw new Error(
      "[instrumentation] agentId is not configured — call configure({ agentId }) " +
        "or pass { agentId } to this call before emitting events.",
    );
  }
  return cfg.agentId;
}

export interface AgentStartOptions extends InstrumentationConfig {
  caller?: string;
}

export interface AgentStopOptions extends InstrumentationConfig {
  status: Status;
  message?: string;
}

export interface ToolCallStartOptions extends InstrumentationConfig {
  caller: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolCallEndOptions extends InstrumentationConfig {
  caller: string;
  tool: string;
  status: Status;
  result?: unknown;
  message?: string;
}

export interface LogOptions extends InstrumentationConfig {
  message: string;
}

export interface ErrorOptions extends InstrumentationConfig {
  message: string;
  caller?: string;
}

/**
 * One instrumentation "instance" bound to a given agentId/team/serverUrl.
 * Use `createInstrumentation` to get one of these for isolated configs
 * (e.g. multiple agents in the same process), or use the module-level
 * singleton exported below via `configure()` + the top-level functions.
 */
export interface Instrumentation {
  configure(config: InstrumentationConfig): void;
  agentStart(options?: AgentStartOptions): void;
  agentStop(options: AgentStopOptions): void;
  toolCallStart(options: ToolCallStartOptions): void;
  toolCallEnd(options: ToolCallEndOptions): void;
  log(message: string, options?: InstrumentationConfig): void;
  error(message: string, options?: ErrorOptions): void;
  /** Wraps a tool/sub-agent call, emitting tool_call_start before and tool_call_end after. */
  withToolCall<T>(
    options: { caller: string; tool: string; input: Record<string, unknown> } & InstrumentationConfig,
    fn: () => Promise<T> | T,
  ): Promise<T>;
}

export function createInstrumentation(initial: InstrumentationConfig = {}): Instrumentation {
  let base: InstrumentationConfig = { ...initial };

  function merged(overrides: InstrumentationConfig): ReturnType<typeof resolveConfig> {
    return resolveConfig({ ...base, ...overrides });
  }

  return {
    configure(config: InstrumentationConfig): void {
      base = { ...base, ...config };
    },

    agentStart(options: AgentStartOptions = {}): void {
      const cfg = merged(options);
      const event: AgentEvent = {
        type: "agent_start",
        timestamp: nowIso(),
        agentId: requireAgentId(cfg),
        ...(cfg.team ? { team: cfg.team } : {}),
        ...(options.caller ? { caller: options.caller } : {}),
      };
      dispatch(event, cfg);
    },

    agentStop(options: AgentStopOptions): void {
      const cfg = merged(options);
      const event: AgentEvent = {
        type: "agent_stop",
        timestamp: nowIso(),
        agentId: requireAgentId(cfg),
        ...(cfg.team ? { team: cfg.team } : {}),
        status: options.status,
        ...(options.message ? { message: options.message } : {}),
      };
      dispatch(event, cfg);
    },

    toolCallStart(options: ToolCallStartOptions): void {
      const cfg = merged(options);
      const event: AgentEvent = {
        type: "tool_call_start",
        timestamp: nowIso(),
        agentId: requireAgentId(cfg),
        ...(cfg.team ? { team: cfg.team } : {}),
        caller: options.caller,
        tool: options.tool,
        input: options.input,
      };
      dispatch(event, cfg);
    },

    toolCallEnd(options: ToolCallEndOptions): void {
      const cfg = merged(options);
      const event: AgentEvent = {
        type: "tool_call_end",
        timestamp: nowIso(),
        agentId: requireAgentId(cfg),
        ...(cfg.team ? { team: cfg.team } : {}),
        caller: options.caller,
        tool: options.tool,
        status: options.status,
        ...(options.status === "success" && options.result !== undefined
          ? { result: options.result }
          : {}),
        ...(options.status === "error" && options.message ? { message: options.message } : {}),
      };
      dispatch(event, cfg);
    },

    log(message: string, options: InstrumentationConfig = {}): void {
      const cfg = merged(options);
      const event: AgentEvent = {
        type: "log",
        timestamp: nowIso(),
        agentId: requireAgentId(cfg),
        ...(cfg.team ? { team: cfg.team } : {}),
        message,
      };
      dispatch(event, cfg);
    },

    error(message: string, options: ErrorOptions = { message }): void {
      const cfg = merged(options);
      const event: ErrorEvent = {
        type: "error",
        timestamp: nowIso(),
        agentId: requireAgentId(cfg),
        ...(cfg.team ? { team: cfg.team } : {}),
        status: "error",
        message,
        ...(options.caller ? { caller: options.caller } : {}),
      };
      dispatch(event, cfg);
    },

    async withToolCall<T>(
      options: { caller: string; tool: string; input: Record<string, unknown> } & InstrumentationConfig,
      fn: () => Promise<T> | T,
    ): Promise<T> {
      const { caller, tool, input, ...rest } = options;
      this.toolCallStart({ caller, tool, input, ...rest });
      try {
        const result = await fn();
        this.toolCallEnd({ caller, tool, status: "success", result, ...rest });
        return result;
      } catch (err) {
        this.toolCallEnd({
          caller,
          tool,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
          ...rest,
        });
        throw err;
      }
    },
  };
}

/**
 * Module-level singleton, convenient for the common case of one agent per
 * process. Call `configure()` once (e.g. `agentId`, `team`, `serverUrl`),
 * then use the exported functions directly.
 */
const singleton = createInstrumentation();

export const configure = singleton.configure;
export const agentStart = singleton.agentStart;
export const agentStop = singleton.agentStop;
export const toolCallStart = singleton.toolCallStart;
export const toolCallEnd = singleton.toolCallEnd;
export const log = singleton.log;
export const error = singleton.error;
export const withToolCall = singleton.withToolCall.bind(singleton);
