import { createServer } from "node:http";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { validateEvent, type AgentEvent } from "./eventSchema.js";
import { logEvent } from "./eventLogger.js";
import { requestLogger } from "./logger.js";
import { StateStore } from "./store.js";

const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.use(express.json());
app.use(requestLogger);

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

httpServer.listen(PORT, () => {
  console.log(`Event server listening on http://localhost:${PORT}`);
  console.log(`WebSocket broadcast endpoint: ws://localhost:${PORT}/ws`);
});
