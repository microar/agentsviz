/**
 * Token auth for `POST /events`, `GET /events/history`, and the `/ws`
 * handshake (issue #52).
 *
 * Before this, anything that could reach the port could forge agent
 * events (poisoning the dashboard) or silently observe every real
 * agent's tool inputs/outputs by connecting to `/ws`. v1 closes that
 * with a single flat allow-list of bearer tokens read from an env var —
 * deliberately not per-team / per-project scoped, and no
 * viewer-vs-emitter split. Every emitter (`instrumentation/`,
 * `hooks-emitter/`) and the frontend send one of these tokens; anything
 * else gets a clean `401` (HTTP) or a rejected handshake (WS),
 * consistent with the existing `400`/`413` clean-error shape.
 *
 * Local dev stays zero-config: with no env var set the server accepts
 * ONLY the built-in dev token below, which every package in this repo
 * also defaults to, so `npm run dev` needs no setup. Set
 * `AGENTSVIZ_API_KEYS` (comma-separated) to lock it down for anything
 * real.
 */

import type { IncomingMessage } from "node:http";
import type { Request, Response } from "express";

/**
 * Shared dev fallback token — mirrored (as the same literal) in
 * `instrumentation/`, `hooks-emitter/`, and `frontend/` so the default
 * local-dev setup authenticates out of the box.
 */
export const DEV_FALLBACK_TOKEN = "dev-local-token";

function rawTokenEnv(env: NodeJS.ProcessEnv): string {
  // AGENTSVIZ_API_KEYS (plural, comma-separated) is the documented server
  // knob; AGENTSVIZ_API_KEY (singular) is accepted too so a deployment
  // that reuses the one emitter-side var still works.
  return env.AGENTSVIZ_API_KEYS ?? env.AGENTSVIZ_API_KEY ?? "";
}

function parseTokens(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * The set of accepted tokens. Falls back to `[DEV_FALLBACK_TOKEN]` when
 * nothing is configured — never an empty list, so the endpoints are
 * always gated by something.
 */
export function getAllowedTokens(env: NodeJS.ProcessEnv = process.env): string[] {
  const tokens = parseTokens(rawTokenEnv(env));
  return tokens.length > 0 ? tokens : [DEV_FALLBACK_TOKEN];
}

/** True when no token env var is set and the server is only accepting the built-in dev token. */
export function usingDevFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseTokens(rawTokenEnv(env)).length === 0;
}

/**
 * Pulls a token from request headers: `Authorization: Bearer <token>`
 * (case-insensitive scheme), a bare `Authorization: <token>`, or
 * `X-API-Key: <token>`. Returns undefined when none is present.
 */
export function tokenFromHeaders(headers: IncomingMessage["headers"]): string | undefined {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.trim().length > 0) {
    const trimmed = auth.trim();
    // `Authorization: Bearer` with nothing after it carries no token.
    if (/^Bearer$/i.test(trimmed)) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(trimmed);
    const token = (match ? match[1] : trimmed).trim();
    return token.length > 0 ? token : undefined;
  }
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim().length > 0) return apiKey.trim();
  return undefined;
}

/**
 * The token for a WebSocket upgrade request. Browser `WebSocket` clients
 * can't set arbitrary headers on the handshake, so the frontend passes
 * `?token=<token>` on the URL; non-browser clients (tests, wscat,
 * server-to-server) can still use the `Authorization` header, so accept
 * either, header first.
 */
export function tokenFromUpgradeRequest(req: IncomingMessage): string | undefined {
  const fromHeader = tokenFromHeaders(req.headers);
  if (fromHeader) return fromHeader;
  try {
    const url = new URL(req.url ?? "", "http://placeholder.invalid");
    return url.searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Narrowing check: is `token` a non-empty string present in `allowed`? */
export function isAllowed(token: string | undefined, allowed: readonly string[]): token is string {
  return typeof token === "string" && allowed.includes(token);
}

/**
 * Express middleware factory guarding a route with the token allow-list.
 * Rejects a missing/invalid token with `401` in the same
 * `{ error, details }` shape the malformed-body (`400`) and
 * oversized-body (`413`) handlers use.
 */
export function requireApiToken(allowed: readonly string[]) {
  return (req: Request, res: Response, next: (err?: unknown) => void): void => {
    if (isAllowed(tokenFromHeaders(req.headers), allowed)) {
      next();
      return;
    }
    res.status(401).json({
      error: "Unauthorized",
      details: ["Missing or invalid API token. Send `Authorization: Bearer <token>`."],
    });
  };
}
