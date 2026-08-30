# Integration tests (issues #10, #32, #37)

End-to-end integration tests that exercise the real pieces built for
issues #3, #4, #6, #29, and #37 together: the **instrumentation helper**
(`instrumentation/`), the **hooks-emitter** script (`hooks-emitter/`),
the **event server**'s HTTP ingest + WebSocket broadcast + in-memory
state store (`server/`), and the schema they all speak
(`/docs/event-schema.md`).

There are two independent producers of the same event schema, and two
matching test files, plus a third test for the server's own stale-agent
liveness sweep:

- `e2e-test.mjs` (issue #10) — the `instrumentation/` library, called
  directly the way a real agent's own code would call it.
- `hooks-emitter-e2e-test.mjs` (issue #32) — the `hooks-emitter/` script,
  driven the way Claude Code's own harness drives it: spawned as a real
  child process per lifecycle event, fed one JSON hook payload on stdin,
  fire-and-forget (no HTTP response visibility, no waiting). See that
  file's header comment and the section below for what's different about
  testing this path.
- `stale-agent-e2e-test.mjs` (issue #37) — proves the server's
  liveness-timeout reaping (`StateStore.reapStaleAgents`, swept on an
  interval from `server/src/index.ts`) works end-to-end: starts a real
  server with a short `AGENT_STALE_TIMEOUT_MS`, starts one agent that
  never sends `agent_stop` (simulating a killed process/closed terminal)
  and another that keeps emitting plain `log` events, and asserts the
  abandoned agent is broadcast live over WebSocket as `stopped` with
  `inferred: true` once the timeout elapses, while the actively-emitting
  one is never falsely reaped. `server/test/store.test.ts` covers the
  same logic as a fast, deterministic unit test against the store
  directly.

All three start a real, unmodified event server and assert against its
real WebSocket broadcast stream and state snapshot — no mocks, no stubs.

## What it does

`e2e-test.mjs`:

1. Starts the real, unmodified event server (`server/dist/index.js`) as a
   child process on a free local port — no mocks, no stubs.
2. Opens a real WebSocket client to `ws://localhost:<port>/ws` and records
   every message the server broadcasts, in arrival order.
3. Uses the real `instrumentation/` helper (via `createInstrumentation`,
   `agentStart`, `agentStop`, `toolCallStart`, `toolCallEnd`, `log`,
   `error` — the same functions a real agent would call) to simulate a
   two-agent run:
   - Agent A starts and logs a line.
   - Agent A calls Agent B as a tool (`tool_call_start` / `tool_call_end`
     bracketing Agent B's entire lifecycle: `agent_start`, a log line,
     `agent_stop`).
   - Agent A logs another line, then calls a second tool that fails
     (`tool_call_end` with `status: "error"`), then emits a standalone
     `error` event (not tied to a tool call), then stops.
4. Reconnects with a fresh WebSocket client to pull the server's current
   state snapshot (the same message format a real frontend client
   receives on connect) and asserts against it, and asserts against the
   recorded broadcast stream from step 2.

### What's asserted

- **No dropped events**: the count of events broadcast back over the
  WebSocket equals the count of events sent.
- **Execution order matches reality**: the broadcast order is compared
  event-for-event against actual send order, plus a causal check that
  Agent B's entire lifecycle is nested inside Agent A's
  `tool_call_start`/`tool_call_end` bracket (proving the server doesn't
  reorder or interleave events incorrectly).
- **Final status is correct**: both agents show `status: "stopped"` (not
  removed from the store) with the right `stopStatus`.
- **Tool call correlation is correct**: the Agent A → Agent B call is
  recorded once with `status: "success"`; the failing tool call is
  recorded with `status: "error"` and the exact error message.
- **Logs and errors are captured**: expected log-line and error-event
  counts per agent.
- **Team grouping is correct**: both agents appear under the shared team
  in the snapshot's `teams` map.

## `hooks-emitter-e2e-test.mjs` (issue #32)

`hooks-emitter/test/map.test.mjs` already unit tests the pure hook
payload → event mapping logic in isolation (no I/O). This test instead
proves the *whole script* works against a *real running server*, driven
exactly the way Claude Code's own harness drives a hook:

1. Starts the real, unmodified event server as a child process, and opens
   a live WebSocket client, same as `e2e-test.mjs` above.
2. Spawns the real, compiled `hooks-emitter/dist/index.js` as a fresh
   child process once per hook firing — never calling its internal
   functions directly — writing a realistic synthetic Claude Code hook
   payload to its stdin and letting it exit on its own, exactly as the
   Claude Code harness would invoke it.
3. Drives a plausible single-session sequence covering all 4 mapped hook
   types plus a Task-tool sub-agent delegation: `SessionStart` →
   `PreToolUse`/`PostToolUse` (Bash) → `PreToolUse` (Task, spawns a
   sub-agent) → `PreToolUse`/`PostToolUse` (Read, inside the sub-agent,
   carrying `agent_id`) → `SubagentStop` → `PostToolUse` (Task ends) →
   `Stop`.
4. For each hook firing, waits for the resulting event to arrive over the
   live WebSocket before sending the next one — this is also how the test
   observes HTTP-level acceptance, since the hook script's own contract
   (#29) is fire-and-forget: it never surfaces the POST's response to its
   own stdout or exit code (the actual network call happens in a detached
   child process the script does not wait for). The server's own request
   log (`POST /events 202` lines on its stdout) is asserted separately as
   a second, independent confirmation signal.
5. Reconnects for a fresh state snapshot and asserts final agent/tool-call
   state, same as `e2e-test.mjs`.
6. Adds an unreachable-server case: points `$AGENTSVIZ_EVENTS_URL` at a
   closed port (`http://127.0.0.1:1/events`) and asserts the hook process
   still exits `0` promptly with empty stdout/stderr — the fire-and-forget
   contract from #29's acceptance criteria.

### What's asserted

- **Payload mapping matches `/docs/event-schema.md`**: every field on
  every broadcast event (`type`, `agentId`, `caller`, `team`, `tool`,
  `input`, `status`, `result`, `message`) is checked against the exact
  value the corresponding hook payload should produce. This test fails
  loudly if `hooks-emitter/src/map.ts`'s mapping ever drifts from the
  schema.
- **Server-level acceptance**: 202-accepted count in the server's request
  log matches the number of hooks fired.
- **Sub-agent correlation (#30)**: the sub-agent's events get a distinct,
  compound `agentId` (`${session_id}-${agent_id}`), a `caller` that links
  back to the parent session, and the same derived `team` as the parent
  (via shared `cwd`) — and its whole lifecycle is causally nested inside
  the parent's `Task` `tool_call_start`/`tool_call_end` bracket.
- **Final snapshot correctness**: both the top-level agent and the
  sub-agent appear with `status: "stopped"`/`stopStatus: "success"`, and
  their tool calls are recorded under the right `agentId`/`caller`
  (notably: the sub-agent never gets its own `SessionStart` hook per the
  Claude Code docs, so it only enters the store via its `SubagentStop` —
  this test explicitly verifies that "stopped with no prior running
  state" path works).
- **Fire-and-forget contract holds**: the hook process always exits `0`
  with no stderr, reachable or not.

## How to run

```bash
cd integration
npm test                  # all three: instrumentation (#10) + hooks-emitter (#32) + stale-agent (#37)
npm run test:e2e           # instrumentation library only
npm run test:hooks-emitter # hooks-emitter script only
npm run test:stale-agent   # server-side stale-agent liveness sweep only
```

Each script installs/builds its own producer package (`instrumentation`
or `hooks-emitter`) and `server` first (so it always runs against current
source, not stale `dist/` output), then runs its test. Each starts its
own server on a free port, so both are safe to run alongside a `server`
you already have running in dev mode elsewhere, and alongside each other.
Every server child process is cleaned up on both success and failure.

The spawned server sets no `AGENTSVIZ_API_KEYS`, so it accepts only the
built-in dev token (`dev-local-token`, issue #52). The producer packages
default to that same token, so their POSTs need no extra wiring; the
tests' own raw `fetch`/`WebSocket` calls pass it explicitly (an
`Authorization: Bearer` header, or `?token=` on the WS handshake URL).

Exit code is `0` on success, `1` with a per-assertion failure list on
any failure.

## Known gaps

These tests satisfy the spirit of issues #10 and #32's acceptance
criteria but have real, deliberate limitations:

- **Simulated, not real-API agents.** This does not invoke actual
  Claude Code / Claude API–backed agents. Doing so in an automated,
  repeatable test would be costly (API spend on every run) and
  nondeterministic (model output varies, timing varies). Instead it
  drives the exact same instrumentation entry points a real agent would
  call, with deterministic, hand-authored data. What it validates —
  server ingestion, state reconstruction, WebSocket broadcast, ordering,
  tool-call correlation — is identical either way, since the server has
  no way to distinguish a simulated caller from a real one. What it does
  *not* validate: real LLM tool-call latency/jitter, real agent process
  lifecycles (crashes, OOM, SIGKILL mid-run), or real concurrent
  multi-process agents (this test's two "agents" run in one Node
  process).
- **Not a load/stress test.** Events are emitted with explicit
  confirmation-waits between them (see `emit()` in `e2e-test.mjs`) to
  make ordering assertions deterministic and non-flaky. This proves
  correctness under light, well-behaved local load, but does not prove
  ordering/drop-rate guarantees under many agents emitting concurrently
  at high volume — see the "Open questions" section of
  `/docs/event-schema.md` about a shared tool-call `callId`, which
  matters more once concurrent same-tool calls are common.
- **Single process, single server instance.** No coverage of server
  restarts mid-run, multiple server replicas, or network partition
  between an agent and the server (the instrumentation helper's
  fire-and-forget/timeout behavior for an unreachable server is instead
  covered by `instrumentation/smoke-test.mjs`).
- **Frontend is not driven end-to-end.** This test verifies the server's
  state store and broadcast stream — the same snapshot/event data the
  frontend's WebSocket client (`frontend/src/store.tsx`) consumes — but
  does not render the React app or assert against the DOM. The frontend
  store's mapping from these exact message shapes to UI state is
  unexercised here.
- **No persistence.** Consistent with `server/src/store.ts` itself, this
  test only checks in-memory state during the life of one server
  process; it doesn't test recovery/replay after a restart (the server
  has none — see `server/README.md`).
- **Synthetic hook payloads, not a real Claude Code harness.**
  `hooks-emitter-e2e-test.mjs` hand-authors realistic hook JSON based on
  the [documented hook schema](https://code.claude.com/docs/en/hooks)
  rather than capturing it from a live Claude Code session, for the same
  cost/determinism reasons `e2e-test.mjs` doesn't invoke real agents. It
  does spawn the real, compiled `hooks-emitter` script as an actual child
  process reading real stdin (not calling its internal functions), which
  is the part that most needs proving — but if a future Claude Code
  harness version changes the hook payload shape itself, this test won't
  catch that until the sample payloads here are updated to match.
- **One hook process per event, sequential.** Real Claude Code hooks for
  concurrently-running sub-agents could in principle fire close together
  from separate OS processes; this test fires them one at a time and
  waits for each to be broadcast before sending the next, for the same
  determinism reasons `e2e-test.mjs`'s `emit()` helper does.
