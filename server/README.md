# AgentsViz Event Server

Minimal Node/Express + WebSocket server that ingests agent lifecycle events,
broadcasts them to all connected clients, and reconstructs current state
(agents, tool calls, team map) in an in-memory store. The in-memory store
is still the live read path, but it is now backed by a persistent event
store (SQLite via Node's built-in `node:sqlite`): every accepted event is
durably recorded, and on startup the in-memory view is rebuilt by replaying
that recorded stream instead of starting empty — so a restart, crash, or
deploy no longer wipes agent/tool-call/team state. See "Persistent event
store" below.

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
| `AGENTSVIZ_API_KEYS` | `dev-local-token` (built-in dev token) | Comma-separated allow-list of bearer tokens accepted on `POST /events`, `GET /events/history`, and the `/ws` handshake (see "Authentication" below). `AGENTSVIZ_API_KEY` (singular) is also accepted. |
| `AGENTSVIZ_DB_PATH` | `server/data/agentsviz.db`             | Path to the persistent SQLite event store (see "Persistent event store" below). Use `:memory:` for an ephemeral DB. |
| `EVENT_LOG_PATH`| `server/data/events-<start-timestamp>.jsonl` | Path to the JSONL event log file (see "Event log" below). |
| `EVENT_LOG_RETENTION_COUNT` | `10`                          | Keep only the N newest auto-rotated `events-*.jsonl` files on startup (the active file counts as one). `0` disables the count limit. See "Retention" below. |
| `EVENT_LOG_RETENTION_DAYS` | *(unset)*                      | Also delete auto-rotated `events-*.jsonl` files older than N days on startup. Unset (or `0`) disables the age limit. |
| `AGENT_STALE_TIMEOUT_MS` | `300000` (5 min)                  | How long an agent can go without any event before it's presumed dead and marked `stopped` (see "Stale agent reaping" below). |
| `AGENT_STALE_CHECK_INTERVAL_MS` | `30000` (30s)              | How often the stale-agent sweep runs. |
| `JSON_BODY_LIMIT` | `5mb`                                   | Max size of a `POST /events` JSON body; larger requests get a clean `413`. |

## Authentication

`POST /events`, `GET /events/history`, and the `/ws` handshake require a
bearer token (issue #52) — without one, an open port could be used to
forge agent events or silently observe real agents' tool inputs/outputs.

- HTTP endpoints: `Authorization: Bearer <token>` (or `X-API-Key: <token>`).
- WebSocket: `?token=<token>` on the handshake URL, since browser
  `WebSocket` clients can't set headers (the `Authorization` header is
  also accepted for non-browser clients).
- Missing/invalid token → `401 { "error": "Unauthorized", "details": [...] }`
  on HTTP, rejected handshake on `/ws`.
- `/health` is unauthenticated (liveness only, no agent data).

Tokens are matched against `AGENTSVIZ_API_KEYS` (comma-separated). When
unset, the server accepts **only** the built-in `dev-local-token`, which
`instrumentation/`, `hooks-emitter/`, and the frontend all default to —
so local `npm run dev` needs no setup. Set `AGENTSVIZ_API_KEYS` for
anything non-local.

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
- **Missing/invalid token** → `401 Unauthorized`, body
  `{ "error": "Unauthorized", "details": [...] }` (see "Authentication" above).

Example:

```bash
curl -i -X POST http://localhost:4000/events \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer dev-local-token' \
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

### WebSocket: `ws://localhost:<port>/ws?token=<token>`

The handshake requires a token as a `?token=` query param (see
"Authentication" above); an unauthenticated handshake is rejected with
`401` before `connection` fires or any snapshot is sent.

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
npx wscat -c 'ws://localhost:4000/ws?token=dev-local-token'
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

## Persistent event store

The in-memory state store above is a derived, in-process view; the durable
source of truth is a SQLite database written by
`server/src/eventRepository.ts` using Node's built-in `node:sqlite`
(`DatabaseSync`) — **zero external dependency**, in keeping with this
package's minimal-tooling style. It can be swapped for a Postgres-backed
implementation of the same small surface (`append` / `readAll` / `count`)
for multi-instance deployments without touching callers.

- **What's stored**: one row per accepted event in an `events` table whose
  columns mirror the envelope in
  [`/docs/event-schema.md`](../docs/event-schema.md) (`type`, `timestamp`,
  `agent_id`, `team`, `caller`, `tool`, `input`, `result`, `status`,
  `message`), plus the verbatim JSON (`raw`) for lossless replay and a
  server-side `received_at`.
- **Design choice — replay on startup, not read-through cache**:
  `StateStore` (`store.ts`) is left exactly as-is — a pure in-memory
  reduction of the event stream, still mirrored by the frontend's
  `applyEvent`. On boot, `index.ts` reads every persisted event
  (oldest-first) and feeds it back through `StateStore.applyEvent`, so the
  reconstructed view is identical to what a live run would have produced.
  This keeps the hot path (validate → store → broadcast) unchanged and
  adds nothing to per-event latency.
- **Never blocks / never crashes ingestion**: `append` is fire-and-forget
  and wrapped — exactly like the JSONL logger. If the driver is
  unavailable or the file can't be opened, the repository logs a
  `console.warn` and degrades to a disabled no-op (`enabled === false`);
  the server then behaves exactly as the old in-memory-only scaffold.
  Individual write failures are logged and swallowed.
- **`GET /events/history`** now reads from this store when it's enabled, so
  the frontend timeline scrubber's history spans **every** server run, not
  just the current process. It falls back to the current run's JSONL file
  when persistence is disabled.
- **Location**: `server/data/agentsviz.db` by default (the directory is
  created automatically; it's gitignored). Override with `AGENTSVIZ_DB_PATH`,
  or set it to `:memory:` for an ephemeral DB (used by the unit tests). A
  `-wal`/`-shm` sidecar file is normal (WAL journal mode).
- **Schema versioning**: `PRAGMA user_version` holds the applied schema
  version; `MIGRATIONS` in `eventRepository.ts` is an ordered, append-only
  list of DDL steps applied in a transaction on startup. Minimal but real —
  adding a column later is a new array entry, no manual DB surgery.

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
  ever committed.
- **Retention**: a fresh file per restart still accumulates without
  bound on a frequently-restarted server. On startup (before the new
  run's file is created) the server prunes old auto-rotated
  `events-*.jsonl` files in the active log's directory, keeping a
  bounded window:
  - `EVENT_LOG_RETENTION_COUNT` (default `10`) — keep only the N newest
    log files; the currently-active file counts as one of the N. `0`
    disables this limit.
  - `EVENT_LOG_RETENTION_DAYS` (default unset) — also delete anything
    whose mtime is older than N days. Unset or `0` disables this limit.

  Both are applied when set: a file is pruned if it falls outside
  *either* window (whichever removes more). With both disabled, nothing
  is pruned. The currently-active log file is never deleted, and only
  files matching the `events-*.jsonl` name pattern are ever
  considered — an explicitly-configured `EVENT_LOG_PATH`, the SQLite
  `.db`, and any other files are left alone. Pruning is best-effort:
  failures are logged with `console.warn` and never block startup. When
  anything is removed, a one-line summary (count + bytes freed) is
  printed at startup. This is startup-only — there's no background timer.

## Notes

- Events are validated, applied to the in-memory state store, broadcast,
  and then persisted to SQLite (see "Persistent event store" above) — the
  in-memory view is rebuilt from that store on restart rather than reset.
  Accepted events are *also* still appended to a per-run JSONL file (see
  "Event log" below); that log is now redundant with the SQLite store and
  kept only as a plain-text convenience.
- Request logging is a lightweight custom middleware (method, path,
  status, duration) writing to stdout — no external logging library.
