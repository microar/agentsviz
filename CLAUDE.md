# CLAUDE.md

## What this is

AgentsViz — a live dashboard for watching multi-agent runs. Agents report
their own lifecycle events; a server ingests and broadcasts them; a React
frontend renders a graph, log stream, and team view.

```
instrumentation/ or hooks-emitter/  --POST /events-->  server/  --WS broadcast /ws-->  frontend/
```

`docs/event-schema.md` is the wire contract shared by all packages. Read it
before touching event shapes, validation, or the state reducers. The
frontend's `applyEvent` reducer intentionally mirrors `server/src/store.ts`
`applyEvent` — keep them in sync.

## Layout

Not an npm workspaces monorepo. Each package installs and builds
independently; root `package.json` only provides `npm run dev`.

- `server/` — Express + `ws`. `POST /events` (validate → `StateStore` →
  broadcast → persist), `GET /events/history` (raw event replay),
  `/health`, WS at `/ws` (sends full snapshot on connect). `StateStore` is
  in-memory but rebuilt on startup by replaying the persistent event store
  (`eventRepository.ts` — SQLite via `node:sqlite`, `AGENTSVIZ_DB_PATH`,
  default `server/data/agentsviz.db`), so state survives restarts;
  persistence is fire-and-forget and degrades to in-memory-only if the DB
  can't be opened. Accepted events are also still appended to a JSONL file.
  Stale agents (no event for `AGENT_STALE_TIMEOUT_MS`, default 5min) get
  reaped and marked `stopped` with `inferred: true`.
- `frontend/` — React 19 + Vite. Self-reconnecting WS client (`ws.ts`),
  event store (`store.tsx`), tabs: Graph (canvas renderer under
  `src/graph/`), Logs, Teams.
- `instrumentation/` — fire-and-forget helper library agents import
  (`agentStart`, `agentStop`, `toolCallStart`/`End`, `withToolCall`,
  `log`, `error`). Dispatch failures are swallowed — never throws into
  agent code.
- `hooks-emitter/` — Claude Code hook script; maps hook payloads to the
  schema, zero agent code changes. Claude Code-specific alternative to
  `instrumentation/`.
- `integration/` — end-to-end tests driving real helper against real
  server.
- `docs/event-schema.md` — the schema/protocol contract.

## Commands

Node v20+ (developed against v24). Package manager: **npm**.

```bash
npm install && npm run dev   # from root: server (:4000) + frontend (:5173) via concurrently
```

Per package (run inside the package dir, or with `--prefix <pkg>`):

| Package | typecheck | test | build |
|---|---|---|---|
| `server` | `npm run typecheck` | `npm test` (tsx `--test`) | `npm run build` |
| `frontend` | `tsc -b` (part of `npm run build`) | — (no unit tests) | `npm run build` |
| `instrumentation` | `npm run typecheck` | `npm test` (builds + smoke-test) | `npm run build` |
| `hooks-emitter` | `npm run typecheck` | `npm test` (builds + map test) | `npm run build` |
| `integration` | — | `npm test` (e2e + hooks-emitter + stale-agent) | — |

`frontend` lint: `npm run lint` (oxlint). No CI workflows in the repo.

## Verifying changes

- Schema / server / instrumentation / hooks-emitter change → run
  `integration/`'s `npm test` (spins up the real server, drives the real
  helper, asserts on the WS stream and final snapshot). It reinstalls and
  rebuilds the packages it needs.
- Server-only change → `server/` `npm test` + `npm run typecheck`.
- Frontend change → `npm run build` (typechecks) + `npm run lint`; for
  behavior, `npm run dev` and drive a real agent or the integration
  fixtures against `:4000`.
- Always run the touched package's `typecheck` before finishing.

## Notes

- `server` and `frontend` `dev` output is colored/labeled (blue / magenta)
  under `concurrently`.
- Server env vars: `PORT`, `AGENTSVIZ_DB_PATH` (SQLite event store,
  default `server/data/agentsviz.db`; `:memory:` for ephemeral),
  `EVENT_LOG_PATH`, `AGENT_STALE_TIMEOUT_MS`,
  `AGENT_STALE_CHECK_INTERVAL_MS`, `JSON_BODY_LIMIT` (default `5mb` — tool
  results can be large). Frontend: `VITE_WS_URL` overrides the
  `ws://<host>:4000/ws` default.
- CORS is intentionally permissive (`*`) — local dev dashboard, no auth.
- `frontend` uses TypeScript `~6.0.2`; `server` uses `~5.7.2`. Don't
  "align" them without reason.
