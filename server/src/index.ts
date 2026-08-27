import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { validateEvent, type AgentEvent } from "./eventSchema.js";
import { logEvent, getLogFilePath } from "./eventLogger.js";
import { requestLogger } from "./logger.js";
import { StateStore } from "./store.js";

const PORT = Number(process.env.PORT) || 4000;
// How long an agent can go without any event (of any type) before the
// liveness sweep presumes it dead and marks it stopped (see
// StateStore.reapStaleAgents in store.ts). Default 5 minutes.
const AGENT_STALE_TIMEOUT_MS = Number(process.env.AGENT_STALE_TIMEOUT_MS) || 5 * 60 * 1000;
// How often the sweep runs. Default 30 seconds.
const AGENT_STALE_CHECK_INTERVAL_MS = Number(process.env.AGENT_STALE_CHECK_INTERVAL_MS) || 30 * 1000;

const app = express();
app.use(express.json());
app.use(requestLogger);
// Permissive CORS: this is a local/internal dev dashboard with no auth, and
// the frontend (Vite dev server) and this server run on different ports in
// development. Needed specifically since issue #43's `/events/history` is
// fetched directly by the browser (unlike the WS connection, which isn't
// subject to CORS) — without this, a cross-port dev setup gets silently
// blocked by the browser rather than a clear server-side error.
app.use((_req: Request, res: Response, next: (err?: unknown) => void) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const store = new StateStore();

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
  // Fire-and-forget JSONL append (see eventLogger.ts) — not awaited, so it
  // cannot delay the broadcast above or this response.
  logEvent(event);
  res.status(202).json({ status: "accepted" });
});

// Read-back of this run's recorded event stream (issue #43), for the
// frontend's history/timeline scrubber to reconstruct past Graph state
// from. Reads the same JSONL file `eventLogger.ts` is appending accepted
// events to for this server process (see `getLogFilePath`) and returns it
// as a JSON array of raw events, oldest first — the same shape/order the
// events were originally POSTed to /events in.
//
// Reconstruction itself (folding these events into agent/tool-call state
// as of a given timestamp) happens client-side rather than here: the
// frontend already carries its own small `applyEvent` reducer (mirroring
// `StateStore.applyEvent`) to apply live WS events incrementally, and
// reusing that same reducer for history avoids a network round-trip (and
// re-parsing this whole file) on every scrub-drag frame. This route stays
// a dumb, cheap file read. Multi-session history (past `events-*.jsonl`
// files from earlier server runs) is explicitly out of scope — only the
// active log file for the current process is read.
app.get("/events/history", (_req: Request, res: Response) => {
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

// Fallback JSON body-parse error handler (e.g. malformed JSON payloads).
app.use((err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
  if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid event", details: ["Request body must be valid JSON."] });
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
});
