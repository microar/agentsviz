# AgentsViz

A live dashboard for watching multi-agent runs as they happen: agents
report themselves — either via a tiny helper library or, for Claude Code
agents, zero-code-change hooks — an event server ingests and broadcasts
what they report, and a React frontend renders it as a live graph, log
stream, and team view.

```
instrumentation/ or hooks-emitter/  --POST /events-->  server/  --WebSocket broadcast-->  frontend/
      (agent reporting)                            (ingest + state store)              (Graph / Logs / Teams)
```

## Architecture

- **[`instrumentation/`](instrumentation/README.md)** — a small helper
  module agents import and call (`agentStart`, `agentStop`,
  `toolCallStart`/`toolCallEnd` or the `withToolCall` wrapper, `log`,
  `error`) to emit schema-valid lifecycle events. Every call is
  fire-and-forget: if the event server isn't running, dispatch failures
  are caught internally and never thrown into agent code, so instrumented
  agents run identically whether or not anyone is watching. Transport- and
  framework-agnostic: works with any agent runtime that can run this
  Node module.
- **[`hooks-emitter/`](hooks-emitter/README.md)** — a Claude Code
  [hook](https://code.claude.com/docs/en/hooks) script that reports a
  Claude Code session to AgentsViz with zero code changes in the agent —
  configuration only. It's an alternative to `instrumentation/` for
  Claude Code users specifically; see "Hooks-based reporting" below.
- **[`server/`](server/README.md)** — an Express + `ws` server that
  accepts events at `POST /events`, validates them, applies them to an
  in-memory state store (agents, tool calls, team map), and broadcasts
  each accepted event to every connected WebSocket client at `/ws`. New
  clients get a full state snapshot on connect. Accepted events are
  persisted to a local SQLite database (Node's built-in `node:sqlite`, no
  external dependency) and also appended to a JSONL file; on startup the
  in-memory state store is rebuilt by replaying the persisted events, so
  agent/tool-call/team state survives a restart, crash, or deploy. See
  [`server/README.md`](server/README.md) for the storage design and
  `AGENTSVIZ_DB_PATH`.
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

## Hooks-based reporting (Claude Code only)

If the agent you want to watch is a **Claude Code** session (including
its Task-tool sub-agents), you don't need to touch its code at all.
[`hooks-emitter/`](hooks-emitter/README.md) is a small script that
Claude Code itself invokes at each lifecycle point (`SessionStart`,
`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`), which maps the
hook's payload to the same event envelope as `instrumentation/` and
POSTs it to the event server. This is configuration-only: register the
script in `.claude/settings.json` and Claude Code does the rest.

**Which one to pick:**

- **Instrumenting a Claude Code agent, don't want to change its code?**
  Use `hooks-emitter/`.
- **Instrumenting anything else** (a different agent framework, a
  non-Claude-Code process, or you want fine-grained control over exactly
  what gets reported and when)? Use `instrumentation/` — it's
  transport/framework-agnostic, while `hooks-emitter/` only works because
  the Claude Code harness itself calls the hook script; there's no
  equivalent hook mechanism for other agent runtimes.

Build it, then register it with Claude Code:

```bash
cd hooks-emitter
npm install
npm run build   # compiles src/ -> dist/
```

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }] }
    ]
  }
}
```

The same script handles all five hooks — see
[`hooks-emitter/README.md`](hooks-emitter/README.md) for the full
snippet, the hook -> event mapping table, and how it derives `agentId`,
`team`, and `caller` for Task-tool sub-agent hierarchies.

Env vars it respects (set in the environment Claude Code runs hooks in):

- `AGENTSVIZ_EVENTS_URL` — where to POST events. Defaults to
  `http://localhost:4000/events`.
- `AGENTSVIZ_API_KEY` — bearer token sent on every POST (see
  "Authentication" below). Defaults to the shared dev token.
- `AGENTSVIZ_TEAM` — overrides the derived `team` field. If unset, `team`
  falls back to the basename of the session's working directory.

**Known limitation:** `hooks-emitter/` is Claude Code-specific — it only
works because Claude Code's hook mechanism invokes the script for you.
It cannot report on other agent frameworks or non-Claude-Code processes;
for those, use `instrumentation/` instead.

## Env vars / ports

| Package          | Variable                    | Default                                      | Description |
|-------------------|------------------------------|-----------------------------------------------|--------------|
| `server`          | `PORT`                       | `4000`                                        | Port the HTTP + WebSocket server listens on. |
| `server`          | `AGENTSVIZ_DB_PATH`         | `server/data/agentsviz.db`                    | Path to the persistent SQLite event store (or `:memory:`). State is rebuilt from it on startup. |
| `server`          | `EVENT_LOG_PATH`             | `server/data/events-<start-timestamp>.jsonl`  | Path to the JSONL event log file. |
| `server`          | `EVENT_LOG_RETENTION_COUNT`  | `10`                                          | On startup, keep only the N newest auto-rotated `events-*.jsonl` files (active file counts as one; `0` disables). See server README's "Event log". |
| `server`          | `EVENT_LOG_RETENTION_DAYS`   | *(unset)*                                     | On startup, also delete auto-rotated `events-*.jsonl` files older than N days (unset/`0` disables). |
| `server`          | `AGENT_STALE_TIMEOUT_MS`     | `300000` (5 min)                              | How long an agent can go without any event before the server presumes it dead and marks it `stopped` (`inferred: true`) — see "Stale agents" below. |
| `server`          | `AGENT_STALE_CHECK_INTERVAL_MS` | `30000` (30s)                              | How often the server sweeps for stale agents. |
| `server`          | `JSON_BODY_LIMIT`            | `5mb`                                         | Max size of a POST `/events` JSON body. Requests over this get a clean `413`. |
| `server`          | `AGENTSVIZ_API_KEYS`        | `dev-local-token` (built-in dev token)        | Comma-separated allow-list of bearer tokens for `POST /events`, `GET /events/history`, and the `/ws` handshake — see "Authentication" below. |
| `frontend`        | `VITE_WS_URL`                | derived from `window.location` + port `4000`  | WebSocket URL the frontend connects to. Set this if the server isn't on the same host or the default port. |
| `frontend`        | `VITE_AGENTSVIZ_TOKEN`      | `dev-local-token`                             | Build-time viewer token sent on the `/ws` handshake and `/events/history` fetch — see "Authentication" below. |
| `frontend` (dev)  | *(Vite dev server port)*     | `5173`                                        | Local dev server port, printed on `npm run dev`. |
| `instrumentation` | `INSTRUMENTATION_SERVER_URL` | `http://localhost:4000/events`                | Where instrumented agents POST events. Can also be set via `configure({ serverUrl })`. |
| `instrumentation` | `AGENTSVIZ_API_KEY`         | `dev-local-token`                             | Bearer token sent on every POST. Can also be set via `configure({ apiKey })`. |
| `hooks-emitter`   | `AGENTSVIZ_EVENTS_URL`       | `http://localhost:4000/events`                | Where the hook script POSTs events. |
| `hooks-emitter`   | `AGENTSVIZ_API_KEY`         | `dev-local-token`                             | Bearer token sent on every POST. |
| `hooks-emitter`   | `AGENTSVIZ_TEAM`             | *(basename of the session's `cwd`)*           | Overrides the derived `team` field. |

## Authentication

`POST /events`, `GET /events/history`, and the `/ws` WebSocket handshake
require a bearer token (issue #52) — otherwise anyone who can reach the
port could forge fake agent events or silently observe every real
agent's tool inputs/outputs by connecting to `/ws`.

- Emitters and browser `fetch` send `Authorization: Bearer <token>`.
- The frontend's WebSocket sends `?token=<token>` on the handshake URL,
  since browser `WebSocket` clients can't set headers.
- A missing/invalid token gets a clean `401` on HTTP and a rejected
  handshake on `/ws`. `/health` stays open.

The server matches tokens against `AGENTSVIZ_API_KEYS` (comma-separated).
**When it's unset, the server accepts only the built-in dev token
`dev-local-token`**, which `instrumentation/`, `hooks-emitter/`, and the
frontend all default to — so `npm run dev` works out of the box with no
configuration. For anything beyond local use, set `AGENTSVIZ_API_KEYS` on
the server and the matching per-package token var above. v1 is a single
shared allow-list — no per-team/per-project keys yet.

## Stale agents (no `agent_stop` received)

`agent_stop` is fire-and-forget by design (see "Instrumentation guide"
and "Hooks-based reporting" above), so it can be lost: a terminal/session
window closed abruptly, a process killed, or the server briefly
unreachable exactly when the stop POST went out. Without a fallback,
such an agent would stay shown as `running` in the Graph/Teams tabs
forever.

To prevent that, the server runs a best-effort liveness sweep
(`server/src/store.ts`'s `reapStaleAgents`, called on an interval from
`server/src/index.ts`): any agent that hasn't produced an event of *any*
kind (not just `agent_stop` — tool calls, logs, and errors all count) for
`AGENT_STALE_TIMEOUT_MS` (default 5 minutes) is marked `stopped` and
broadcast live to connected dashboards. This is clearly distinguished
from a clean stop in the data: reaped agents get `inferred: true` on
their `AgentState`, plus a `stopMessage` like `"No activity for 5
minutes — presumed stopped"`. The Graph and Teams tabs render this case
with its own dashed-amber "presumed stopped" style rather than the solid
green/red used for a real `agent_stop`. This is inherently best-effort,
not a guarantee — see `docs/event-schema.md`'s "Server-side liveness
timeout" section for the full rationale and edge cases (e.g. a
slow-but-alive agent that goes quiet longer than the timeout will also be
reaped). Tune `AGENT_STALE_TIMEOUT_MS`/`AGENT_STALE_CHECK_INTERVAL_MS`
(see the table above) if the defaults don't fit your workload.

## Troubleshooting

- **Port already in use.** Something else is bound to `4000` (server) or
  `5173` (frontend). Set `PORT` for the server, or pass Vite's `--port`
  flag / stop the conflicting process.
- **Frontend shows "connecting" and never updates.** Confirm the server
  is actually running and reachable at the WebSocket URL the frontend is
  using (check the browser console/network tab, and `VITE_WS_URL` if set)
  — the frontend's WS client retries with backoff, so a server that
  starts late will eventually connect on its own. If the handshake is
  getting a `401`, the token doesn't match: the server has
  `AGENTSVIZ_API_KEYS` set to something the frontend's
  `VITE_AGENTSVIZ_TOKEN` (baked in at build time) isn't in — see
  "Authentication" above.
- **Agent/hook POSTs get a `401`.** The emitter's `AGENTSVIZ_API_KEY`
  (or `configure({ apiKey })`) isn't in the server's `AGENTSVIZ_API_KEYS`
  allow-list. With neither side configured, both default to
  `dev-local-token` and it just works.
- **Instrumented agent doesn't show up anywhere.** Check that
  `INSTRUMENTATION_SERVER_URL` (or `configure({ serverUrl })`) points at
  the running server's `/events` endpoint. By design, instrumentation
  calls made while the server is down (or unreachable) fail silently and
  never throw or block the agent — this is intentional (see
  `instrumentation/README.md`), but it means a misconfigured URL looks
  identical to "server not running" from the agent's side. Check the
  server's `GET /health` endpoint and its stdout request log to confirm
  events are arriving.
- **Claude Code session (via `hooks-emitter/`) doesn't show up anywhere.**
  Same idea as above, but check `AGENTSVIZ_EVENTS_URL` and confirm the
  `command` paths in `.claude/settings.json` point at the built
  `hooks-emitter/dist/index.js`. The hook script never errors or blocks
  the session (by design — see `hooks-emitter/README.md`), so a
  misconfigured path or URL fails silently from the agent's side too.
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
