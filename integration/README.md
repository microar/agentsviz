# Integration test (issue #10)

End-to-end integration test that exercises the real pieces built for
issues #3, #4, and #6 together: the **instrumentation helper**
(`instrumentation/`), the **event server**'s HTTP ingest + WebSocket
broadcast + in-memory state store (`server/`), and the schema they both
speak (`/docs/event-schema.md`).

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

## How to run

```bash
cd integration
npm run test:e2e
```

This installs/builds `instrumentation` and `server` first (so it always
runs against current source, not stale `dist/` output), then runs the
test. It starts its own server on a free port, so it's safe to run
alongside a `server` you already have running in dev mode elsewhere. The
test cleans up its child server process on both success and failure.

Exit code is `0` on success, `1` with a per-assertion failure list on
any failure.

## Known gaps

This test satisfies the spirit of issue #10's acceptance criteria but
has real, deliberate limitations:

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
