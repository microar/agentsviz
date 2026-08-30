import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { validateEvent, type AgentEvent } from "./eventSchema.js";
import { logEvent, getLogFilePath, pruneEventLogs } from "./eventLogger.js";
import { EventRepository } from "./eventRepository.js";
import { requestLogger } from "./logger.js";
import { StateStore } from "./store.js";
import {
  DEV_FALLBACK_TOKEN,
  getAllowedTokens,
  isAllowed,
  requireApiToken,
  tokenFromUpgradeRequest,
  usingDevFallback,
} from "./auth.js";

const PORT = Number(process.env.PORT) || 4000;
// How long an agent can go without any event (of any type) before the
// liveness sweep presumes it dead and marks it stopped (see
// StateStore.reapStaleAgents in store.ts). Default 5 minutes.
const AGENT_STALE_TIMEOUT_MS = Number(process.env.AGENT_STALE_TIMEOUT_MS) || 5 * 60 * 1000;
// How often the sweep runs. Default 30 seconds.
const AGENT_STALE_CHECK_INTERVAL_MS = Number(process.env.AGENT_STALE_CHECK_INTERVAL_MS) || 30 * 1000;

const app = express();
// body-parser's default limit is 100kb, which is easy for a legitimate event
// to exceed: the schema allows tool_call_end's `result` field to be an
// arbitrary string/object/array (see docs/event-schema.md), and a real tool
// result (e.g. a file read, command output, or API response) can plausibly
// run well past 100kb of JSON. 5mb is a generous ceiling for this schema's
// realistic payloads while still bounding memory per request; configurable
// via env var following the PORT/AGENT_STALE_TIMEOUT_MS pattern above.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "5mb";
// Token allow-list for the data endpoints (issue #52). Resolved once at
// startup: `POST /events`, `GET /events/history`, and the `/ws` handshake
// all check an incoming token against this list. Defaults to the built-in
// dev token when no env var is set — see auth.ts.
const ALLOWED_TOKENS = getAllowedTokens();

app.use(requestLogger);
// Permissive CORS: this is a local/internal dev dashboard, and the
// frontend (Vite dev server) and this server run on different ports in
// development. Needed specifically since issue #43's `/events/history` is
// fetched directly by the browser (unlike the WS connection, which isn't
// subject to CORS) — without this, a cross-port dev setup gets silently
// blocked by the browser rather than a clear server-side error. Since #52
// the browser also sends an `Authorization` header on that fetch, which
// makes it a non-simple request — so allow that header and answer the
// preflight `OPTIONS` before the auth gate (a preflight carries no auth).
app.use((req: Request, res: Response, next: (err?: unknown) => void) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "authorization, content-type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
// Auth gate: every `/events*` request must carry a valid token. Mounted
// before `express.json()` so an unauthenticated request gets a clean 401
// without the body being parsed. `/health` stays open (liveness only, no
// agent data).
app.use("/events", requireApiToken(ALLOWED_TOKENS));
app.use(express.json({ limit: JSON_BODY_LIMIT }));

const httpServer = createServer(app);
// Reject an unauthenticated WebSocket during the handshake (issue #52),
// before `connection` fires or any snapshot is sent. Browser clients
// can't set headers on `new WebSocket()`, so the token comes in as
// `?token=<token>` on the URL; header auth is also accepted for
// non-browser clients (see tokenFromUpgradeRequest).
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  verifyClient: ({ req }, done) => {
    if (isAllowed(tokenFromUpgradeRequest(req), ALLOWED_TOKENS)) {
      done(true);
      return;
    }
    done(false, 401, "Unauthorized");
  },
});
const store = new StateStore();

// Durable event storage (see eventRepository.ts). Every accepted event is
// appended here in addition to the in-memory StateStore and the JSONL log,
// so a restart/crash/deploy doesn't lose observability data. If the SQLite
// backend can't be opened it degrades to a no-op (`enabled === false`) and
// the server runs exactly as before — persistence never blocks ingestion.
const eventRepository = new EventRepository();

// Rebuild the in-memory view from persisted events on startup, so the
// dashboard shows prior agent/tool-call/team state instead of resetting to
// empty. StateStore.applyEvent is unchanged — we just feed it the recorded
// stream (oldest first) exactly as if it had just arrived over the wire.
if (eventRepository.enabled) {
  const persisted = eventRepository.readAll();
  for (const event of persisted) {
    try {
      store.applyEvent(event as AgentEvent);
    } catch (err) {
      console.warn("Skipped an unreplayable persisted event:", err);
    }
  }
  if (persisted.length > 0) {
    console.log(`Restored ${persisted.length} persisted event(s) into the in-memory store`);
  }
}

// Prune old auto-rotated JSONL event logs before this run's file is
// created (issue #53). Startup-only, matching the "fresh file per restart"
// rotation model — without it a frequently-restarted server accumulates
// `data/events-*.jsonl` forever. Bounded by EVENT_LOG_RETENTION_COUNT /
// EVENT_LOG_RETENTION_DAYS; the SQLite store is untouched. Best-effort:
// pruneEventLogs swallows its own errors, so this never blocks startup.
const pruned = pruneEventLogs();
if (pruned.pruned.length > 0) {
  const freedKiB = (pruned.freedBytes / 1024).toFixed(1);
  console.log(
    `Event log retention: pruned ${pruned.pruned.length} old log file(s), freed ${freedKiB} KiB`,
  );
}

/** Broadcast an accepted event, as JSON, to every currently-connected WS client. */
function broadcast(event: unknown): void {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", clients: wss.clients.size });
});

app.post("/events", (req: Request, res: Response) => {
  const { valid, errors } = validateEvent(req.body);

  if (!valid) {
    res.status(400).json({ error: "Invalid event", details: errors });
    return;
  }

  const event = req.body as AgentEvent;
  store.applyEvent(event);
  broadcast(event);
  // Fire-and-forget persistence — neither is awaited, and both swallow their
  // own failures (see eventRepository.ts / eventLogger.ts), so they cannot
  // delay the broadcast above or this response, nor break ingestion if the
  // disk / DB is unavailable.
  eventRepository.append(event);
  logEvent(event);
  res.status(202).json({ status: "accepted" });
});

// Read-back of the recorded event stream (issue #43), for the frontend's
// history/timeline scrubber to reconstruct past Graph state from. Returns
// a JSON array of raw events, oldest first — the same shape/order the
// events were originally POSTed to /events in.
//
// Source of truth is the persistent event store (eventRepository.ts) when
// it's enabled, so history now spans every server run instead of just the
// current process's JSONL file — a restart no longer truncates the
// scrubber's timeline. When persistence is disabled we fall back to the
// current run's JSONL file (`getLogFilePath`), preserving the pre-existing
// single-session behaviour.
//
// Reconstruction itself (folding these events into agent/tool-call state
// as of a given timestamp) happens client-side rather than here: the
// frontend already carries its own small `applyEvent` reducer (mirroring
// `StateStore.applyEvent`) to apply live WS events incrementally, and
// reusing that same reducer for history avoids a network round-trip on
// every scrub-drag frame. This route stays a dumb, cheap read.
app.get("/events/history", (_req: Request, res: Response) => {
  if (eventRepository.enabled) {
    res.status(200).json(eventRepository.readAll());
    return;
  }

  const logPath = getLogFilePath();
  if (!existsSync(logPath)) {
    // Nothing logged yet this run (no event has been accepted since
    // startup) — an empty history, not an error.
    res.status(200).json([]);
    return;
  }

  try {
    const raw = readFileSync(logPath, "utf8");
    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    res.status(200).json(events);
  } catch (err) {
    console.warn(`Failed to read event history (${logPath}):`, err);
    res.status(500).json({ error: "Failed to read event history" });
  }
});

// Fallback body-parser error handler (malformed JSON, oversized payloads).
app.use((err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
  const type = err && typeof err === "object" && "type" in err ? (err as { type?: string }).type : undefined;
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid event", details: ["Request body must be valid JSON."] });
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json({
      error: "Payload too large",
      details: [`Request body must not exceed ${JSON_BODY_LIMIT}.`],
    });
    return;
  }
  next(err);
});

wss.on("connection", (socket) => {
  console.log(`WebSocket client connected (${wss.clients.size} total)`);

  // Send a full state snapshot first, so new clients don't have to wait for
  // future events to know current agent/tool-call/team state.
  socket.send(JSON.stringify({ type: "snapshot", data: store.getSnapshot() }));

  socket.on("close", () => {
    console.log(`WebSocket client disconnected (${wss.clients.size} total)`);
  });
});

// Best-effort liveness sweep (see StateStore.reapStaleAgents): agents that
// have gone quiet for AGENT_STALE_TIMEOUT_MS are marked stopped so the
// Graph/Teams tabs don't accumulate permanently-"running" ghost nodes when
// a session ends without an explicit agent_stop (killed process, closed
// terminal, dropped fire-and-forget POST). Reaped agents are broadcast to
// connected WS clients as a fresh snapshot so open dashboards update live,
// the same way a newly-connecting client is seeded.
const staleAgentInterval = setInterval(() => {
  const reaped = store.reapStaleAgents(AGENT_STALE_TIMEOUT_MS);
  if (reaped.length === 0) return;
  console.log(`Reaped ${reaped.length} stale agent(s) after ${AGENT_STALE_TIMEOUT_MS}ms of inactivity`);
  broadcast({ type: "snapshot", data: store.getSnapshot() });
}, AGENT_STALE_CHECK_INTERVAL_MS);
staleAgentInterval.unref();

httpServer.listen(PORT, () => {
  console.log(`Event server listening on http://localhost:${PORT}`);
  console.log(`WebSocket broadcast endpoint: ws://localhost:${PORT}/ws`);
  if (usingDevFallback()) {
    console.warn(
      `[auth] No AGENTSVIZ_API_KEYS set — accepting only the built-in dev token ("${DEV_FALLBACK_TOKEN}"). ` +
        "Set AGENTSVIZ_API_KEYS (comma-separated) to lock this down for anything non-local.",
    );
  }
});

// Flush and close the SQLite handle cleanly on shutdown. Each append
// already commits on its own (see eventRepository.ts), so this is just
// tidiness — but it checkpoints the WAL so the .db file is self-contained
// between runs.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  eventRepository.close();
  httpServer.close(() => process.exit(0));
  // Don't hang forever on lingering connections (e.g. open WebSockets).
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
