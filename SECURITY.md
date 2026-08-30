# Security notes

AgentsViz is a **local/internal observability dashboard** for watching
multi-agent runs. It is not hardened for hostile multi-tenant use. This
document records the security-relevant behaviour that exists today and,
importantly, its limits.

## Authentication

`POST /events`, `GET /events/history`, and the `/ws` WebSocket handshake
require a bearer token (issue #52). Without one, anything that can reach
the port could forge agent events or silently observe every real agent's
tool inputs/outputs. Tokens are a single flat allow-list from
`AGENTSVIZ_API_KEYS` (comma-separated); with none set the server accepts
only the built-in `dev-local-token`. There is no per-team/per-project
scoping and no viewer-vs-emitter split. See the server README's
"Authentication" section.

CORS is intentionally permissive (`*`) — this is a same-host dev tool.

## PII / secret redaction (best-effort)

Since issue #54 the server runs a **redaction pass** over every accepted
event, in `POST /events`, before the event is applied to the in-memory
store, broadcast over `/ws`, appended to the JSONL log, or persisted to
SQLite. It scrubs only the free-form fields — `tool_call_start.input`,
`tool_call_end.result`, and `message` — recursing through nested objects
and arrays, using:

- a **case-insensitive field-name denylist** (`password`, `apiKey`,
  `token`, `secret`, `authorization`, `ssn`, `credit_card`, `cvv`, … —
  full list in `server/src/redact.ts`), whose matched keys have their
  entire value replaced with `[REDACTED]`; and
- a **value-pattern list** matched against every string leaf: OpenAI-style
  `sk-…` keys, `Bearer`/`Basic` authorization values, AWS/GitHub/Slack/
  Google key formats, JWTs, PEM private-key blocks, email addresses, and
  credit-card-like digit groups.

### Configuration

| Env var | Default | Effect |
|---|---|---|
| `AGENTSVIZ_REDACTION` | on | `off` / `0` / `false` / `no` disables redaction entirely. |
| `AGENTSVIZ_REDACT_FIELDS` | — | Extra comma-separated field names for the denylist. |
| `AGENTSVIZ_REDACT_PATTERNS` | — | Extra comma-separated regex sources for the value-pattern list. |

Redaction is **on by default** — safe-by-default is the right posture for
data you cannot un-broadcast.

### This is not a compliance guarantee

Redaction is **best-effort pattern matching**. It will miss:

- secrets in key shapes it does not recognise;
- sensitive values that look like ordinary prose (names, addresses, free
  text medical/financial detail);
- data split across multiple fields, encoded, compressed, or nested
  inside opaque blobs;
- anything added by a custom tool whose field names aren't on the
  denylist.

It also may over-redact (a field literally named `token` that holds a
non-secret is still masked).

Treat it as a way to cut down casual exposure in the dashboard and its
on-disk logs — **not** as a control that makes it safe to feed regulated
or genuinely sensitive data through tool calls. Agents remain responsible
for not emitting such data, or for redacting it themselves before it is
sent. If you have a hard requirement, disable ingestion of those tools'
payloads at the emitter, or run the server somewhere its storage and
broadcast surface are themselves in-scope for your controls.

## Storage

Accepted events are persisted to a local SQLite database
(`AGENTSVIZ_DB_PATH`, default `server/data/agentsviz.db`) and appended to
a per-run JSONL file. Both are plaintext on local disk with no
encryption-at-rest and no retention limit. The `data/` directory is
gitignored. Redaction (above) is applied before either write, so the
`[REDACTED]` marker — not the original value — is what lands on disk for
recognised patterns/fields.

## Reporting

This is a small internal project with no formal disclosure process. Open
an issue on the repository for anything security-relevant.
