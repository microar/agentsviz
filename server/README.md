# AgentsViz Event Server

Minimal Node/Express + WebSocket server that ingests agent lifecycle events
and broadcasts them to all connected clients. No persistence yet — events
are validated and re-broadcast in memory only (a state store is tracked as
a separate issue).

## Getting started

```bash
npm install
npm run dev
```

The server prints the HTTP and WebSocket URLs it's listening on (defaults
to port `4000`).

## Configuration

| Env var | Default | Description |
|---------|---------|--------------|
| `PORT`  | `4000`  | Port the HTTP + WebSocket server listens on. |

## Scripts

- `npm run dev` — start the server with `tsx watch` (auto-restarts on change)
- `npm run build` — type-check and compile to `dist/`
- `npm run start` — run the compiled server from `dist/`
- `npm run typecheck` — type-check without emitting

## API

### `POST /events`

Ingests a single event and validates it against the schema defined in
[`/docs/event-schema.md`](../docs/event-schema.md) (event types:
`agent_start`, `agent_stop`, `tool_call_start`, `tool_call_end`, `log`,
`error`).

- **Valid event** → `202 Accepted`, body `{ "status": "accepted" }`. The
  event is immediately broadcast to all connected WebSocket clients.
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

Connect to receive every accepted event as a JSON text frame, broadcast to
all currently connected clients in the order they were accepted. There is
no history/replay — only events accepted while a client is connected are
delivered to it.

Example (using `wscat`):

```bash
npx wscat -c ws://localhost:4000/ws
```

## Notes

- No database or persistence — this is an in-memory ingest-and-broadcast
  scaffold only, per issue #2. A durable state store is a separate,
  follow-up issue.
- Request logging is a lightweight custom middleware (method, path,
  status, duration) writing to stdout — no external logging library.
