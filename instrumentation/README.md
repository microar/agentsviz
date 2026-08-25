# @agentsviz/instrumentation

Small helper module Claude Code agents call to emit schema-valid events —
`agent_start`, `agent_stop`, `tool_call_start`, `tool_call_end`, `log`,
`error` — at the right moments. Payload shape follows
[`/docs/event-schema.md`](../docs/event-schema.md) exactly.

Every call is **fire-and-forget**: it builds the JSON payload and kicks off
a POST without awaiting the network response. If the event server (see
issue #2) isn't running — connection refused, DNS failure, timeout — the
failure is caught internally and never thrown into your agent code. Your
agent's control flow is never blocked or crashed by instrumentation.

## Install / build

```bash
cd instrumentation
npm install
npm run build   # compiles src/ -> dist/
npm test        # builds, then runs a smoke test against an unreachable server
```

## Copy-paste example

```ts
import {
  configure,
  agentStart,
  agentStop,
  withToolCall,
  log,
  error,
} from "../instrumentation/dist/index.js"; // or "@agentsviz/instrumentation" once published

// Configure once, near the top of your agent's entry point.
configure({
  agentId: "researcher-7f3a",       // stable id for this agent instance
  team: "research-team",             // optional, for multi-agent setups
  serverUrl: "http://localhost:4000/events", // defaults to this if omitted
  // or set INSTRUMENTATION_SERVER_URL in the environment instead
});

async function run() {
  agentStart({ caller: "orchestrator-01" });
  log("Starting research phase, planning 3 search queries");

  try {
    // Wrap a call to another agent/tool: emits tool_call_start before,
    // tool_call_end (success or error) after — automatically.
    const results = await withToolCall(
      { caller: "researcher-7f3a", tool: "web_search", input: { query: "agentsviz event schema" } },
      async () => {
        return await callWebSearchAgent("agentsviz event schema");
      },
    );

    agentStop({ status: "success", message: `Completed with ${results.length} sources` });
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    agentStop({ status: "error", message: "Agent crashed during research phase" });
  }
}

run();
```

### Manual before/after (if you'd rather not use `withToolCall`)

```ts
import { toolCallStart, toolCallEnd } from "../instrumentation/dist/index.js";

toolCallStart({ caller: "researcher-7f3a", tool: "web_search", input: { query: "..." } });
try {
  const result = await callWebSearchAgent("...");
  toolCallEnd({ caller: "researcher-7f3a", tool: "web_search", status: "success", result });
} catch (err) {
  toolCallEnd({
    caller: "researcher-7f3a",
    tool: "web_search",
    status: "error",
    message: err instanceof Error ? err.message : String(err),
  });
  throw err;
}
```

### Multiple agents in one process

Use `createInstrumentation()` to get an isolated instance per agent instead
of sharing the module-level singleton:

```ts
import { createInstrumentation } from "../instrumentation/dist/index.js";

const agentA = createInstrumentation({ agentId: "agent-a", team: "crew-1" });
const agentB = createInstrumentation({ agentId: "agent-b", team: "crew-1" });

agentA.agentStart();
agentB.agentStart();
```

## Configuration

| Option       | Default                          | Notes |
|--------------|-----------------------------------|-------|
| `agentId`    | *(required before first emit)*    | Set via `configure()`, `createInstrumentation()`, or per-call override. |
| `team`       | *(omitted)*                       | Optional, per schema. |
| `serverUrl`  | `http://localhost:4000/events`, or `$INSTRUMENTATION_SERVER_URL` if set | Where events are POSTed. |
| `timeoutMs`  | `2000`                            | POST is aborted after this long so a hung server can't leak resources. |
| `enabled`    | `true`                            | Set `false` to make every emitter a true no-op (e.g. in tests). |
| `onError`    | logs one `console.warn` per process | Called with `(err, event)` on any dispatch failure. Must not throw. |

Every emitter (`agentStart`, `agentStop`, `toolCallStart`, `toolCallEnd`,
`log`, `error`, `withToolCall`) also accepts these as a per-call override
on top of whatever was set via `configure()`.

## Safety guarantees

- **Never blocks**: emitters return synchronously (or, for `withToolCall`,
  only await the wrapped function — never the event POST).
- **Never throws from a dispatch failure**: network errors, timeouts, and
  non-2xx responses are caught internally.
- **Safe when the event server isn't running**: this is the expected state
  before issue #2 (event server) is deployed, or whenever the server is
  down — instrumentation calls remain no-ops that don't affect the agent.
