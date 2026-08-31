# Event Schema & Protocol

This document defines the JSON shape that agents emit for every lifecycle
event: agent start, agent stop, tool call start, tool call end, log line,
and error. It is the contract between agent runtimes (emitters), the
server (ingestion/storage), and the frontend (visualization), and must be
agreed upon before server or frontend code is written.

## Design goals

- **One envelope, many event types.** Every event uses the same top-level
  field set; fields that don't apply to a given event type are omitted
  rather than sent as `null`.
- **Machine-orderable.** `timestamp` plus `agentId` is enough to
  reconstruct a per-agent timeline; `caller` links tool calls back to the
  agent (or parent agent, for sub-agent/delegation scenarios) that
  triggered them.
- **Transport-agnostic.** This schema describes the JSON payload only. It
  does not assume a specific transport (HTTP POST, WebSocket frame, log
  file line, message queue message, etc.) — any transport that can carry
  a JSON object can carry these events.

## Emitters

Two packages in this repo produce events in this exact shape:

- **[`instrumentation/`](../instrumentation/README.md)** — a helper
  library any agent process imports and calls explicitly. Transport- and
  framework-agnostic.
- **[`hooks-emitter/`](../hooks-emitter/README.md)** — a Claude Code
  [hook](https://code.claude.com/docs/en/hooks) script that maps hook
  payloads to this schema automatically, with no code changes in the
  agent. Claude Code-specific.

Both POST to the same `/events` endpoint and are validated by the same
`server/src/eventSchema.ts`. This document is the single source of truth
for the wire format either one produces — see each package's README for
its own setup and payload-mapping details.

## Authentication

The wire envelope is transport-agnostic, but the reference server
(`server/`) gates its endpoints on a bearer token so an open port can't
be used to forge agent events or silently observe real agents' tool
inputs/outputs (issue #52):

| Endpoint | Token sent as |
|---|---|
| `POST /events` | `Authorization: Bearer <token>` header (also accepts `X-API-Key`). |
| `GET /events/history` | Same header. |
| `WebSocket /ws` | `?token=<token>` query param on the handshake URL (browsers can't set handshake headers); the `Authorization` header also works for non-browser clients. |

A missing or unrecognized token gets a clean `401`
(`{ "error": "Unauthorized", "details": [...] }`) on the HTTP endpoints
and a rejected handshake on `/ws` — consistent with the `400`
(invalid event) and `413` (oversized body) responses.

The server validates against an allow-list from `AGENTSVIZ_API_KEYS`
(comma-separated). When that is unset it accepts **only** a built-in
local-dev token, `dev-local-token`, which every emitter and the frontend
also default to — so a stock `npm run dev` works with no configuration.
Set `AGENTSVIZ_API_KEYS` for anything non-local. Token config per package:

| Package | Variable | Default |
|---|---|---|
| `server` | `AGENTSVIZ_API_KEYS` (comma-separated allow-list; `AGENTSVIZ_API_KEY` also accepted) | `dev-local-token` |
| `instrumentation` | `AGENTSVIZ_API_KEY` env var, or `configure({ apiKey })` | `dev-local-token` |
| `hooks-emitter` | `AGENTSVIZ_API_KEY` env var | `dev-local-token` |
| `frontend` | `VITE_AGENTSVIZ_TOKEN` (build-time) | `dev-local-token` |

v1 is a single flat allow-list — no per-team/per-project keys and no
viewer-vs-emitter scope split.

## Field reference

These are the complete set of fields used across all event types. Each
event type uses the subset relevant to it (see per-event-type sections
below for exactly which fields are required/optional/omitted for that
type).

| Field       | Type                 | Required | Description |
|-------------|----------------------|----------|-------------|
| `type`      | `string` (enum)      | Always | The event type. One of: `agent_start`, `agent_stop`, `tool_call_start`, `tool_call_end`, `log`, `error`. |
| `timestamp` | `string` (ISO 8601)  | Always | UTC timestamp of when the event occurred, e.g. `2026-08-24T14:32:01.123Z`. Millisecond precision preferred. |
| `agentId`   | `string`             | Always | Stable unique identifier for the agent instance that owns this event (e.g. a UUID or `<agent-name>-<run-id>`). Every event belongs to exactly one agent. |
| `team`      | `string`             | Optional | Name/identifier of the team or crew the agent belongs to, for multi-agent setups. Omitted for single-agent runs where the concept doesn't apply. |
| `caller`    | `string`             | Optional | The `agentId` (or other identifier, e.g. `"user"`) that triggered this event — used on tool call events to record who initiated the call, and optionally on `agent_start`/`agent_stop` to record which agent/process spawned this one (e.g. a Claude Code sub-agent, which never emits `agent_start`, carries it on `agent_stop`). Omitted when there is no meaningful caller (e.g. a top-level agent started by a human). |
| `tool`      | `string`             | Tool call events only | Name of the tool being invoked (e.g. `"web_search"`, `"read_file"`). Present on `tool_call_start` and `tool_call_end`; omitted otherwise. |
| `input`     | `object`             | `tool_call_start` only | The arguments/parameters passed to the tool, as a JSON object. Omitted on all other event types. |
| `result`    | `any`                | `tool_call_end` only | The tool's return value on success. May be a string, object, array, or number depending on the tool. Omitted when the call errored (see `status`/`message` instead) or on event types other than `tool_call_end`. |
| `status`    | `string` (enum)      | `tool_call_end`, `agent_stop`, `error` | Outcome of the event. For `tool_call_end` and `agent_stop`: `"success"` or `"error"`. For `error`: always `"error"`. Omitted on `agent_start`, `tool_call_start`, and `log`, which don't carry an outcome. |
| `message`   | `string`             | `log`, `error` (required); others optional | Free-text human-readable message. Required on `log` (the log line content) and `error` (the error description). May optionally appear on `agent_stop` to give a human-readable stop reason. Omitted elsewhere. |

### Notes on shared fields

- `type`, `timestamp`, and `agentId` appear on **every** event and form
  the minimal envelope needed to route and order events.
- `team` and `caller` are contextual metadata that may appear on any
  event type when relevant, but are most commonly seen on `agent_start`
  (which team/caller spawned this agent) and tool call events (which
  agent is calling the tool).
- Consumers (server, frontend) should treat unknown/absent optional
  fields as "not applicable" rather than an error, and should tolerate
  additional fields being added to the envelope over time (forward
  compatible).

## Event types

### `agent_start`

Emitted once when an agent instance begins running.

**Fields used:** `type`, `timestamp`, `agentId`, `team` (optional),
`caller` (optional).

```json
{
  "type": "agent_start",
  "timestamp": "2026-08-24T14:30:00.000Z",
  "agentId": "researcher-7f3a",
  "team": "research-team",
  "caller": "orchestrator-01"
}
```

### `agent_stop`

Emitted once when an agent instance finishes running, whether it
completed successfully, was cancelled, or failed.

**Fields used:** `type`, `timestamp`, `agentId`, `team` (optional),
`caller` (optional), `status`, `message` (optional).

```json
{
  "type": "agent_stop",
  "timestamp": "2026-08-24T14:35:42.500Z",
  "agentId": "researcher-7f3a",
  "team": "research-team",
  "status": "success",
  "message": "Completed task with 3 sources gathered"
}
```

`caller` is optional here and is normally omitted for a top-level agent.
It matters for runtimes where a sub-agent never emits its own
`agent_start` — notably Claude Code sub-agents, which have no
`SessionStart` hook — so `agent_stop` (mapped from `SubagentStop`) is the
event that carries the sub-agent → parent link. Consumers that build a
delegation tree from `caller` should read it off `agent_stop` too, not
just `agent_start` / tool call events.

Error case:

```json
{
  "type": "agent_stop",
  "timestamp": "2026-08-24T14:36:10.000Z",
  "agentId": "researcher-7f3a",
  "team": "research-team",
  "status": "error",
  "message": "Agent crashed: unhandled exception in step 4"
}
```

#### Server-side liveness timeout (no `agent_stop` received)

`agent_stop` is a best-effort signal, not a guarantee: a terminal/session
window can be closed, a process can be killed, or the network/server can
be briefly unreachable exactly when a fire-and-forget `agent_stop` POST
goes out — both `instrumentation/` and `hooks-emitter/` intentionally
swallow POST failures rather than retrying, so the event can be silently
lost. Without a fallback, an agent in that situation would stay shown as
`running` in the Graph/Teams tabs forever, even after the server process
that ingested its `agent_start` has been running for hours with no other
sign of life from it.

To guard against that, `server/src/store.ts`'s `StateStore` tracks the
timestamp of the most recent event of **any** type — `agent_start`,
`agent_stop`, `tool_call_start`/`_end`, `log`, or `error` — seen for each
`agentId`. An interval timer in `server/src/index.ts`
(`AGENT_STALE_CHECK_INTERVAL_MS`, default 30s) sweeps for agents still
marked `running` whose most recent event is older than
`AGENT_STALE_TIMEOUT_MS` (default 5 minutes, configurable via that env
var) and marks them `stopped` in the store, broadcasting the updated
snapshot to connected WebSocket clients so open dashboards update live.

This is **inferred, not explicit** — the server is guessing based on
silence, not being told. Consumers of the state store/snapshot (including
the frontend) can tell the two apart: an agent reaped this way gets
`inferred: true` on its `AgentState`, plus `stopStatus: "error"` and a
`stopMessage` of the form `"No activity for 5 minutes — presumed
stopped"`. A clean `agent_stop` never sets `inferred`. If a genuine
(delayed) `agent_stop` arrives for an agent that was already reaped this
way, the explicit event wins and clears `inferred`.

This is deliberately best-effort liveness detection via timeout, not a
guarantee of correctness — a slow-but-alive agent that goes quiet for
longer than the configured timeout (e.g. waiting on a long-running tool
call with no intermediate `log` events) will also be marked `stopped`.
Tune `AGENT_STALE_TIMEOUT_MS` for your workload if the default doesn't
fit.

### `tool_call_start`

Emitted when an agent invokes a tool, before the tool executes.

**Fields used:** `type`, `timestamp`, `agentId`, `caller`, `tool`,
`input`, `team` (optional).

```json
{
  "type": "tool_call_start",
  "timestamp": "2026-08-24T14:31:05.200Z",
  "agentId": "researcher-7f3a",
  "team": "research-team",
  "caller": "researcher-7f3a",
  "tool": "web_search",
  "input": {
    "query": "latest agentsviz event schema conventions",
    "maxResults": 5
  }
}
```

### `tool_call_end`

Emitted when a tool call finishes, whether it succeeded or errored.
Correlate with the matching `tool_call_start` via `agentId` + `tool` +
proximity in time (or a shared call id if the emitter provides one as an
additional field).

**Fields used:** `type`, `timestamp`, `agentId`, `caller`, `tool`,
`result` (on success), `status`, `message` (on error), `team` (optional).

Success:

```json
{
  "type": "tool_call_end",
  "timestamp": "2026-08-24T14:31:06.850Z",
  "agentId": "researcher-7f3a",
  "team": "research-team",
  "caller": "researcher-7f3a",
  "tool": "web_search",
  "status": "success",
  "result": {
    "results": [
      { "title": "Event schema design patterns", "url": "https://example.com/a" }
    ]
  }
}
```

Error:

```json
{
  "type": "tool_call_end",
  "timestamp": "2026-08-24T14:31:07.000Z",
  "agentId": "researcher-7f3a",
  "team": "research-team",
  "caller": "researcher-7f3a",
  "tool": "web_search",
  "status": "error",
  "message": "Request timed out after 5000ms"
}
```

### `log`

A free-form log line emitted by an agent during its run, for
human-readable progress/debug information that doesn't fit a more
specific event type.

**Fields used:** `type`, `timestamp`, `agentId`, `message`, `team`
(optional).

```json
{
  "type": "log",
  "timestamp": "2026-08-24T14:31:04.000Z",
  "agentId": "researcher-7f3a",
  "team": "research-team",
  "message": "Starting research phase, planning 3 search queries"
}
```

### `error`

An unrecoverable or notable error, not necessarily tied to a specific
tool call (e.g. an internal agent error, a validation failure, a
connectivity problem). For errors that occur specifically during a tool
call, prefer `tool_call_end` with `status: "error"` instead.

**Fields used:** `type`, `timestamp`, `agentId`, `status` (always
`"error"`), `message`, `team` (optional), `caller` (optional).

```json
{
  "type": "error",
  "timestamp": "2026-08-24T14:33:20.000Z",
  "agentId": "researcher-7f3a",
  "team": "research-team",
  "status": "error",
  "message": "Failed to parse configuration: missing required key 'model'"
}
```

## Redaction (server-side, best-effort)

The wire envelope allows arbitrary JSON in `input`/`result` and arbitrary
free text in `message`. In real fleets those routinely carry customer
PII, API responses with tokens, or database rows with private fields.
Storing and broadcasting that unfiltered is a liability once this tool is
pointed at production agents rather than toy ones (issue #54).

To limit that, the reference server (`server/`) runs a **redaction pass**
in `POST /events` after validation and before the event reaches *any*
consumer — the in-memory `StateStore`, the WebSocket broadcast, the JSONL
log, and the SQLite store all see the same scrubbed copy. It touches only
`input`, `result`, and `message`, recursing through nested objects and
arrays, and combines two mechanisms:

- **Field-name denylist** (case-insensitive): any object key whose name
  matches (e.g. `password`, `apiKey`, `token`, `secret`, `authorization`,
  `ssn`, `credit_card`, `cvv`, …) has its **entire** value replaced with
  `[REDACTED]`, whatever the value's shape.
- **Value patterns**: every string leaf is matched against regexes for
  common secret/token/PII shapes — OpenAI-style `sk-…` keys, `Bearer`/`Basic`
  authorization values, AWS/GitHub/Slack/Google key formats, JWTs, PEM
  private-key blocks, email addresses, and credit-card-like digit groups —
  and each match is replaced with `[REDACTED]`.

Non-string, non-object leaves (numbers, booleans, `null`) pass through
untouched unless their key is on the denylist.

### Configuration (server env vars)

| Var | Default | Effect |
|---|---|---|
| `AGENTSVIZ_REDACTION` | on | `off` / `0` / `false` / `no` disables the pass entirely. Safe-by-default: on unless explicitly turned off. |
| `AGENTSVIZ_REDACT_FIELDS` | — | Extra comma-separated field names to add to the denylist. |
| `AGENTSVIZ_REDACT_PATTERNS` | — | Extra comma-separated regex sources to add to the value-pattern list (compiled global + case-insensitive; an un-compilable entry is warned about and skipped). |

Regexes and the denylist set are compiled once at startup, so the
`/events` hot path just walks the payload — no meaningful per-event
overhead for typical payload sizes.

### Not a compliance guarantee

This is **best-effort pattern matching, not a guarantee**. Novel key
shapes, secrets split across multiple fields, base64/gzipped blobs, and
sensitive data that simply looks like ordinary prose will pass through.
Redaction here reduces casual exposure in the dashboard and its logs; it
is **not** a substitute for data-handling controls in the agents
themselves. Agents feeding genuinely sensitive data into tool calls
remain responsible for not doing so, or for pre-redacting it before it is
emitted. See [`/SECURITY.md`](../SECURITY.md).

## Summary: field usage by event type

| Field       | agent_start | agent_stop | tool_call_start | tool_call_end | log | error |
|-------------|:-----------:|:----------:|:----------------:|:-------------:|:---:|:-----:|
| `type`      | required | required | required | required | required | required |
| `timestamp` | required | required | required | required | required | required |
| `agentId`   | required | required | required | required | required | required |
| `team`      | optional | optional | optional | optional | optional | optional |
| `caller`    | optional | optional | required | required | – | optional |
| `tool`      | – | – | required | required | – | – |
| `input`     | – | – | required | – | – | – |
| `result`    | – | – | – | on success | – | – |
| `status`    | – | required | – | required | – | required (`"error"`) |
| `message`   | – | optional | – | on error | required | required |

## Open questions for reviewers

These are called out for backend/frontend owners to confirm during
review (see acceptance criteria below):

- Whether `tool_call_start`/`tool_call_end` pairs need an explicit shared
  correlation id (e.g. `callId`) beyond `agentId` + `tool` + timestamp
  ordering, for cases where an agent calls the same tool concurrently.
- Whether `team` should be required rather than optional once
  multi-agent/team support is finalized.
- Maximum size / truncation policy for `input`, `result`, and `message`
  payloads (e.g. large tool outputs).

## Status

- [x] Written schema doc covering all event types
- [x] Field list finalized (`type`, `timestamp`, `agentId`, `team`,
      `caller`, `tool`, `input`, `result`, `status`, `message`)
- [x] Example payload per event type in `/docs/event-schema.md`
- [ ] Reviewed by backend + frontend owners
