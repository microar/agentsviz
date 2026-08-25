# AgentsViz

A live dashboard for watching multi-agent runs as they happen: agents
instrument themselves with a tiny helper library, an event server ingests
and broadcasts what they report, and a React frontend renders it as a
live graph, log stream, and team view.

```
instrumentation/  --POST /events-->  server/  --WebSocket broadcast-->  frontend/
 (agent helper)                  (ingest + state store)              (Graph / Logs / Teams)
```

## Architecture

- **[`instrumentation/`](instrumentation/README.md)** — a small helper
  module agents import and call (`agentStart`, `agentStop`,
  `toolCallStart`/`toolCallEnd` or the `withToolCall` wrapper, `log`,
  `error`) to emit schema-valid lifecycle events. Every call is
  fire-and-forget: if the event server isn't running, dispatch failures
  are caught internally and never thrown into agent code, so instrumented
  agents run identically whether or not anyone is watching.
- **[`server/`](server/README.md)** — an Express + `ws` server that
  accepts events at `POST /events`, validates them, applies them to an
  in-memory state store (agents, tool calls, team map), and broadcasts
  each accepted event to every connected WebSocket client at `/ws`. New
  clients get a full state snapshot on connect. Accepted events are also
  appended to a local JSONL file as a cheap foundation for future replay.
  No external database; state resets on restart.
- **[`frontend/`](frontend/README.md)** — a React + Vite app that
  connects to the server's WebSocket endpoint (with automatic reconnect)
  and renders the resulting state across a **Graph** tab (live agent
  graph), **Logs** tab (per-agent filterable log stream), and **Teams**
  tab (team/agent hierarchy).
- **[`docs/event-schema.md`](docs/event-schema.md)** — the JSON schema
  and protocol shared by all three pieces above. This is the contract:
  instrumentation emits it, the server validates and stores it, the
  frontend renders it.
- **[`integration/`](integration/README.md)** — an end-to-end test that
  drives the real instrumentation helper against a real running server
  and asserts on the WebSocket broadcast stream and final state snapshot,
  proving the whole pipeline works together (see "Validating the full
  pipeline" below).

## Setup

**Prerequisites:** Node.js (v20+ recommended; developed against v24).

Each package (`server/`, `frontend/`, `instrumentation/`, `integration/`)
manages its own dependencies independently — this is not an npm
workspaces monorepo, just enough root tooling for a one-command dev
startup. Install what you need:

```bash
# Root tooling (only needed for the combined `npm run dev` below)
npm install

# Each package you plan to run
npm install --prefix server
npm install --prefix frontend
npm install --prefix instrumentation   # only if instrumenting an agent
npm install --prefix integration       # only if running the e2e test
```

### One-command dev startup

From the repo root:

```bash
npm install   # first time only
npm run dev
```

This runs `server`'s and `frontend`'s `dev` scripts in parallel via
[`concurrently`](https://www.npmjs.com/package/concurrently), with
labeled, colored output (`server` in blue, `frontend` in magenta) so you
can tell which process printed what. Stop both with `Ctrl+C`.

- Server: http://localhost:4000 (WebSocket at `ws://localhost:4000/ws`)
- Frontend: http://localhost:5173

To run either piece alone, use its own `npm run dev` inside `server/` or
`frontend/` — see their READMEs.

## Instrumentation guide

Any agent process can report itself to AgentsViz by importing the
`instrumentation` helper and calling it around its own lifecycle. Minimal
example (see [`instrumentation/README.md`](instrumentation/README.md)
for the full guide, including `withToolCall` and multi-agent-per-process
setups):

```ts
import { configure, agentStart, agentStop, log } from "../instrumentation/dist/index.js";

configure({ agentId: "researcher-7f3a", team: "research-team" });

agentStart({ caller: "orchestrator-01" });
log("Starting research phase");
// ... do work ...
agentStop({ status: "success", message: "Done" });
```

Build the helper first with `npm install && npm run build` inside
`instrumentation/`. If the event server isn't running, these calls are
safe no-ops — see "Server not running" below.

## Env vars / ports

| Package          | Variable                    | Default                                      | Description |
|-------------------|------------------------------|-----------------------------------------------|--------------|
| `server`          | `PORT`                       | `4000`                                        | Port the HTTP + WebSocket server listens on. |
| `server`          | `EVENT_LOG_PATH`             | `server/data/events-<start-timestamp>.jsonl`  | Path to the JSONL event log file. |
| `frontend`        | `VITE_WS_URL`                | derived from `window.location` + port `4000`  | WebSocket URL the frontend connects to. Set this if the server isn't on the same host or the default port. |
| `frontend` (dev)  | *(Vite dev server port)*     | `5173`                                        | Local dev server port, printed on `npm run dev`. |
| `instrumentation` | `INSTRUMENTATION_SERVER_URL` | `http://localhost:4000/events`                | Where instrumented agents POST events. Can also be set via `configure({ serverUrl })`. |

## Troubleshooting

- **Port already in use.** Something else is bound to `4000` (server) or
  `5173` (frontend). Set `PORT` for the server, or pass Vite's `--port`
  flag / stop the conflicting process.
- **Frontend shows "connecting" and never updates.** Confirm the server
  is actually running and reachable at the WebSocket URL the frontend is
  using (check the browser console/network tab, and `VITE_WS_URL` if set)
  — the frontend's WS client retries with backoff, so a server that
  starts late will eventually connect on its own.
- **Instrumented agent doesn't show up anywhere.** Check that
  `INSTRUMENTATION_SERVER_URL` (or `configure({ serverUrl })`) points at
  the running server's `/events` endpoint. By design, instrumentation
  calls made while the server is down (or unreachable) fail silently and
  never throw or block the agent — this is intentional (see
  `instrumentation/README.md`), but it means a misconfigured URL looks
  identical to "server not running" from the agent's side. Check the
  server's `GET /health` endpoint and its stdout request log to confirm
  events are arriving.
- **`npm run dev` at the root doesn't do anything.** Make sure you ran
  `npm install` at the repo root first (installs `concurrently`), and
  that `server/` and `frontend/` each have their own `node_modules`
  installed too.

## Validating the full pipeline

To confirm instrumentation → server → state store → broadcast all work
together end-to-end, run the integration test instead of manually
wiring things up:

```bash
cd integration
npm run test:e2e
```

This builds and runs the real server and real instrumentation helper
(no mocks), simulates a two-agent run, and asserts on event ordering,
tool-call correlation, final agent status, and team grouping. See
[`integration/README.md`](integration/README.md) for details and known
gaps (it doesn't drive the frontend itself).
