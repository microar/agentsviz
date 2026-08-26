# AgentsViz Event Server

Minimal Node/Express + WebSocket server that ingests agent lifecycle events,
broadcasts them to all connected clients, and reconstructs current state
(agents, tool calls, team map) in an in-memory store. No external DB or
disk persistence — state lives only in the running process and is rebuilt
from scratch on restart.

## Getting started

```bash
npm install
npm run dev
```

The server prints the HTTP and WebSocket URLs it's listening on (defaults
to port `4000`).

## Configuration

| Env var         | Default                                   | Description |
|-----------------|--------------------------------------------|--------------|
| `PORT`          | `4000`                                     | Port the HTTP + WebSocket server listens on. |
| `EVENT_LOG_PATH`| `server/data/events-<start-timestamp>.jsonl` | Path to the JSONL event log file (see "Event log" below). |
| `AGENT_STALE_TIMEOUT_MS` | `300000` (5 min)                  | How long an agent can go without any event before it's presumed dead and marked `stopped` (see "Stale agent reaping" below). |
| `AGENT_STALE_CHECK_INTERVAL_MS` | `30000` (30s)              | How often the stale-agent sweep runs. |

## Scripts

- `npm run dev` — start the server with `tsx watch` (auto-restarts on change)
- `npm run build` — type-check and compile to `dist/`
- `npm run start` — run the compiled server from `dist/`
- `npm run typecheck` — type-check without emitting
- `npm test` — run the unit tests (`test/*.test.ts`, via node's built-in
  test runner)

## API

### `POST /events`

Ingests a single event and validates it against the schema defined in
[`/docs/event-schema.md`](../docs/event-schema.md) (event types:
`agent_start`, `agent_stop`, `tool_call_start`, `tool_call_end`, `log`,
`error`).

- **Valid event** → `202 Accepted`, body `{ "status": "accepted" }`. The
  event updates the in-memory state store (see "State store" below) and is
  immediately broadcast to all connected WebSocket clients.
- **Invalid event** → `400 Bad Request`, body:
  ```json
  { "error": "Invalid event", "details": ["<one message per problem found>"] }
  ```

Example:

```bash
curl -i -X POST http://localhost:4000/events \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "log",
    "timestamp": "2026-08-24T14:31:04.000Z",
    "agentId": "researcher-7f3a",
    "message": "Starting research phase"
  }'
```

### `GET /health`

Returns `200 OK` with `{ "status": "ok", "clients": <n> }` — useful for a
quick liveness check and to see how many WebSocket clients are connected.

### WebSocket: `ws://localhost:<port>/ws`

On connect, the server immediately sends a **snapshot message** reflecting
current state, before any live events:

```json
{
  "type": "snapshot",
  "data": {
    "agents": [ /* AgentState[] */ ],
    "toolCalls": [ /* ToolCallState[] */ ],
    "teams": { "research-team": ["researcher-7f3a", "writer-2b1c"] }
  }
}
```

After the snapshot, the client receives every subsequently accepted event
as its own JSON text frame, broadcast to all currently connected clients in
the order they were accepted. There is no event history/replay beyond the
snapshot — a client that connects mid-stream gets caught up via the
snapshot, then stays current via live events; it does not receive the raw
events that produced that snapshot.

Example (using `wscat`):

```bash
npx wscat -c ws://localhost:4000/ws
```

## State store

The server reconstructs current state from the accepted event stream in a
plain in-memory store (`server/src/store.ts`) — no external DB, no disk
persistence. State is lost on process restart.

- **Agents** (`agents: AgentState[]`) — keyed internally by `agentId`.
  `agent_start` adds the agent (or updates it) with `status: "running"`.
  `agent_stop` sets `status: "stopped"` **in place** — the agent is never
  removed from the store, so its history (team, timestamps, stop
  reason/status) remains queryable after it stops.
- **Tool calls** (`toolCalls: ToolCallState[]`) — each call starts as
  `status: "pending"` on `tool_call_start`. Since the event schema has no
  shared `callId` field yet (see "Open questions" in
  `/docs/event-schema.md`), calls are correlated by `agentId` + `caller` +
  `tool`; the matching `tool_call_end` updates that same entry's `status`
  (`"success"`/`"error"`), `result`, and `message` **in place** rather than
  appending a duplicate. A `tool_call_end` with no matching in-flight call
  (e.g. it started before the store existed) is recorded directly as an
  already-completed call instead of being dropped.
- **Teams** (`teams: Record<string, string[]>`) — derived from the `team`
  field on known agents, mapping each team name to the `agentId`s
  currently associated with it.

### Stale agent reaping

`agent_stop` can be lost (killed process, closed terminal, dropped
fire-and-forget POST — see the root README's "Stale agents" section for
the full rationale). To keep the dashboard from accumulating
permanently-`running` ghost agents, `StateStore.reapStaleAgents(timeoutMs,
now?)` is called on a `setInterval` from `index.ts` (every
`AGENT_STALE_CHECK_INTERVAL_MS`, default 30s). It marks any `running`
agent whose most recent event of any kind is older than
`AGENT_STALE_TIMEOUT_MS` (default 5 min) as `stopped`, with `inferred:
true`, `stopStatus: "error"`, and an explanatory `stopMessage` — clearly
distinct from a clean `agent_stop`, which never sets `inferred`. Each
sweep that reaps at least one agent triggers a fresh snapshot broadcast
to all connected WebSocket clients, same as a normal state-changing
event, so open dashboards update live without a page refresh. See
`server/test/store.test.ts` for the behavior this guarantees (and
`integration/stale-agent-e2e-test.mjs` for the end-to-end version against
a real running server).

## Event log (JSONL)

As a cheap foundation for future replay/debugging (see issue #13), every
**accepted** event is also appended to a local `.jsonl` file — one JSON
object per line, in acceptance order.

- **Location**: `server/data/events-<start-timestamp>.jsonl` by default
  (the directory is created automatically). Override with the
  `EVENT_LOG_PATH` env var to point at a specific file instead, e.g.:
  ```bash
  EVENT_LOG_PATH=/tmp/agentsviz-events.jsonl npm run dev
  ```
- **No performance impact on live broadcasting**: the write is
  fire-and-forget (not awaited before the WS broadcast or the HTTP
  response — see `logEvent` in `server/src/eventLogger.ts`), using a
  single sequential `fs.WriteStream` per run so writes can't interleave.
  Write failures are logged with `console.warn` and otherwise ignored —
  they never affect broadcasting or the HTTP response.
- **Rotating / clearing between sessions**: with the default path, every
  server start writes to a fresh, timestamped file — nothing is ever
  appended across restarts, so there's no "stale" log to clear. To
  reclaim disk space, just delete everything under `server/data/`; the
  directory is gitignored (along with any `*.jsonl` file, in case
  `EVENT_LOG_PATH` points elsewhere in the repo), so no event data is
  ever committed. This is intentionally simple — no size-based rotation
  or log retention policy.

## Notes

- No database — events are validated and applied to the in-memory state
  store, which still resets on restart. Accepted events are additionally
  appended to a local JSONL file for future replay (see "Event log"
  above); this is a cheap append-only log, not a queryable persistence
  layer.
- Request logging is a lightweight custom middleware (method, path,
  status, duration) writing to stdout — no external logging library.
