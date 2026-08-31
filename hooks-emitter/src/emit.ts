/**
 * Shared network + diagnostics helpers for the emitter.
 *
 * Split out of send.ts so the detached sender (send.ts) and the hook
 * entry point's `--check` self-test (index.ts) resolve the target URL,
 * bearer token, and timeout the same way, and so the opt-in failure log
 * (issue #67) lives in exactly one place.
 *
 * The delivery guarantees from issue #29 still hold: nothing here writes
 * to stdout/stderr, and `debugLog` is a no-op unless `$AGENTSVIZ_DEBUG`
 * is set — the default (no env var) behaviour is unchanged, every failure
 * mode still swallowed silently.
 */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DEFAULT_EVENTS_URL = "http://localhost:4000/events";
// Shared local-dev token — the event server accepts only this when no
// AGENTSVIZ_API_KEYS is configured. Override via $AGENTSVIZ_API_KEY.
export const DEFAULT_API_KEY = "dev-local-token";
export const TIMEOUT_MS = 3000;

export function resolveEventsUrl(): string {
  return process.env.AGENTSVIZ_EVENTS_URL || DEFAULT_EVENTS_URL;
}

export function resolveApiKey(): string {
  return process.env.AGENTSVIZ_API_KEY || DEFAULT_API_KEY;
}

/**
 * Append one line to the emitter's failure log — but only when
 * `$AGENTSVIZ_DEBUG` is set. This is the opt-in "why are my events not
 * showing up?" diagnostic from issue #67: it never writes to stderr (that
 * would surface as Claude Code hook noise, forbidden by #29) and never
 * throws, so enabling it can't change the emitter's observable behaviour
 * beyond the log file appearing.
 *
 * Log path defaults to `hooks-emitter/.agentsviz-emitter.log` (one level
 * up from this compiled file's `dist/` dir); override with
 * `$AGENTSVIZ_DEBUG_LOG`.
 */
export function debugLog(message: string): void {
  if (!process.env.AGENTSVIZ_DEBUG) return;
  try {
    const file =
      process.env.AGENTSVIZ_DEBUG_LOG ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".agentsviz-emitter.log");
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never break — or block — the emitter.
  }
}

export interface PostOutcome {
  /** HTTP status if the request completed, else null. */
  status: number | null;
  /** Set only when the request never completed (refused, DNS, timeout). */
  error?: string;
}

/**
 * POST one event to the configured events URL with the bearer token and a
 * hard timeout. Never throws — a request that never completes comes back
 * as `{ status: null, error }`.
 */
export async function postEvent(event: unknown): Promise<PostOutcome> {
  const apiKey = resolveApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(resolveEventsUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    return { status: res.status };
  } catch (err) {
    return { status: null, error: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch` rejections wrap the useful part (ECONNREFUSED, ENOTFOUND, an
 * abort) in `err.cause`, so unwrap one level for a message that actually
 * says why delivery failed.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : cause instanceof Error
        ? cause.message
        : undefined;
  return causeCode ? `${err.name}: ${err.message} (${causeCode})` : `${err.name}: ${err.message}`;
}

/**
 * Human-readable one-liner describing a non-delivered POST, for the debug
 * log and the `--check` output. `null` means the POST was delivered and
 * accepted.
 */
export function describeFailure(outcome: PostOutcome): string | null {
  const url = resolveEventsUrl();
  if (outcome.error !== undefined) {
    return `POST ${url} failed before a response: ${outcome.error}`;
  }
  const { status } = outcome;
  if (status !== null && (status < 200 || status >= 300)) {
    const hint =
      status === 401
        ? " — bad or missing bearer token. On a stale build, rebuild hooks-emitter (`npm run build`) so send.js carries the Authorization header; otherwise set $AGENTSVIZ_API_KEY to match the server's AGENTSVIZ_API_KEYS."
        : "";
    return `POST ${url} rejected: HTTP ${status}${hint}`;
  }
  return null;
}
