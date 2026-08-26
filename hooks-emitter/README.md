# @agentsviz/hooks-emitter

A Claude Code [hook](https://code.claude.com/docs/en/hooks) script that
reports a Claude Code session to AgentsViz with **zero code changes in the
agent** — configuration only. It's a second event-emission path alongside
[`instrumentation/`](../instrumentation): instead of an agent calling
`agentStart`/`toolCallStart`/etc explicitly, this script is invoked
automatically by the Claude Code harness itself at each lifecycle point,
maps the hook's payload to the same event envelope, and POSTs it to the
event server.

Payload shape follows [`/docs/event-schema.md`](../docs/event-schema.md)
exactly (also enforced by `server/src/eventSchema.ts`).

## What it maps

| Claude Code hook | AgentsViz event    |
|-------------------|---------------------|
| `SessionStart`     | `agent_start`        |
| `PreToolUse`        | `tool_call_start`    |
| `PostToolUse`       | `tool_call_end`      |
| `Stop`               | `agent_stop`          |
| `SubagentStop`      | `agent_stop`          |

`agentId` is normally the hook payload's `session_id` — stable for the
lifetime of one Claude Code session. Any other hook event
(`Notification`, `PreCompact`, `PermissionDenied`, etc.) is ignored.

## Sub-agent hierarchies (Task tool) — `team` and `caller`

Claude Code hook payloads don't have a native "team" or "caller" concept,
and — per [the hooks docs](https://code.claude.com/docs/en/hooks) — a
Task-tool-spawned sub-agent does **not** get its own distinct
`session_id`; it shares the parent session's. What the payload *does*
carry, on every hook that fires **inside** the sub-agent's own execution
(its `PreToolUse`, `PostToolUse`, `SubagentStop` — not the parent's
`PreToolUse` for the `Task` call itself, which fires before the sub-agent
exists), is `agent_id` (unique per sub-agent) and `agent_type`. This
package uses that to derive `agentId`/`caller`:

- **`agentId`**: when a hook payload carries `agent_id` (i.e. it fired
  inside a sub-agent), the emitted `agentId` is synthesized as
  `${session_id}-${agent_id}` — distinct from the parent's own `agentId`
  (plain `session_id`). Without `agent_id`, `agentId` is just
  `session_id`, as before.
- **`caller`**: always the owning session's `session_id`. For a
  top-level agent this is a self-reference (unchanged from #29's
  behavior); for a sub-agent event it's the *parent's* agentId, which is
  exactly the edge the Graph tab needs to draw parent and child as linked
  nodes instead of one flat, disconnected agent per session.

**Honesty note / fallback:** this correlation depends on the harness
actually populating `agent_id` on hooks that fire inside a sub-agent, per
the documented behavior above. If some Claude Code version or hook path
ever omits it, this package has no independent way to recover sub-agent
identity (hook invocations are separate, stateless processes — there's no
in-memory place to correlate a `Task` call to the sub-agent it later
spawns), so it falls back to treating that event as top-level: `agentId`
equals `session_id`, indistinguishable from the parent. That's a
degraded-but-safe fallback (nothing crashes, the event is still emitted),
not a guarantee every sub-agent is always distinguishable.

### `team`

`team` is derived, in precedence order:

1. The `$AGENTSVIZ_TEAM` environment variable, if set in the environment
   Claude Code runs hooks in — e.g. via an `env` block in your project's
   `.claude/settings.json` (if your Claude Code version supports one) or
   your shell profile. Set this to override the default per project.
2. Otherwise, the basename of the hook payload's `cwd` (e.g.
   `/Users/dev/projects/agentsviz` -> `agentsviz`).
3. Omitted if neither is available.

Because a sub-agent runs in the same project directory as its parent,
both derive the same `cwd` basename (or the same env override), so every
agent/sub-agent originating from one project consistently reports the
same `team` — grouping them together in the Teams tab.

## Install / build

```bash
cd hooks-emitter
npm install
npm run build   # compiles src/ -> dist/
npm test        # builds, then runs the payload-mapping unit tests
```

## Register it with Claude Code

Add a block like this to your project's (or user-level) `.claude/settings.json`,
pointing `command` at the built `dist/index.js` (use an absolute path, or a
path relative to `$CLAUDE_PROJECT_DIR` if your Claude Code version supports
that variable):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/hooks-emitter/dist/index.js" }
        ]
      }
    ]
  }
}
```

The same script handles all five hooks — it reads `hook_event_name` from
the stdin payload to decide what (if anything) to emit, so one command can
be reused across every entry above.

By default events go to `http://localhost:4000/events`. Point them
elsewhere by setting `AGENTSVIZ_EVENTS_URL` in the environment Claude Code
runs hooks in (e.g. via your shell profile, or a `env` block if your
Claude Code version supports one in the hook entry).

```bash
export AGENTSVIZ_EVENTS_URL=http://localhost:4000/events
```

## Safety guarantees

These match the acceptance criteria in issue #29:

- **Never blocks or denies a tool call.** The script always exits `0`,
  regardless of outcome, and never emits a `permissionDecision`. This is
  observe-only tooling.
- **Never errors on an unreachable server.** Connection refused, DNS
  failure, timeout, and non-2xx responses are all swallowed silently — no
  stderr noise, no nonzero exit.
- **Adds no perceptible latency to `PreToolUse`.** The actual HTTP POST
  happens in a short-lived, detached child process (`dist/send.js`) that
  the hook script spawns and immediately leaves running after it exits —
  the hook itself never awaits the network call.

## How it works internally

- `src/map.ts` — pure functions (`parseHookPayload`, `mapHookPayload`,
  `classifyToolResponse`, `deriveAgentId`, `deriveCaller`, `deriveTeam`)
  that turn a hook JSON payload into an event, or `null` if there's
  nothing to emit. No I/O; this is what `npm test` exercises directly.
- `src/index.ts` — the hook entry point: reads the payload from stdin,
  maps it, and hands the resulting event off to the detached sender
  before exiting `0`.
- `src/send.ts` — the detached sender: POSTs one event JSON (passed as an
  argv string) with a timeout, swallows every failure, and exits `0`.

### `PostToolUse` success/error mapping

Claude Code's `tool_response` shape varies by tool and harness version.
`classifyToolResponse` (in `src/map.ts`) uses a best-effort heuristic: it
treats the response as an error if it looks like `{ type: "error" }`,
`{ is_error: true }` / `{ isError: true }`, `{ success: false }` /
`{ ok: false }`, or carries a non-empty `error` field — and as success
otherwise, using the raw response as `result`. On error, `message` is
pulled from `content`/`message`/`error`/`stderr` when present, falling
back to a stringified response so `message` is never empty (required by
the schema whenever `status` is `"error"`).

## Out of scope for this package

- Broader README/docs updates beyond this file (#31).
- A full integration test suite against a live server (#32) — this
  package only unit-tests its payload-mapping logic (`npm test`).
