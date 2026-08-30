/**
 * Unit tests for src/redact.ts (issue #54) — the best-effort PII/secret
 * redaction pass applied in `POST /events` before an event is stored,
 * broadcast, logged, or persisted.
 *
 * Uses node's built-in test runner via tsx, same as store.test.ts —
 * no separate test framework, in keeping with this repo's style.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REDACTED_MARKER,
  loadRedactionConfig,
  redactEvent,
  type RedactionConfig,
} from "../src/redact.js";

/** A config with all defaults and nothing from the environment. */
function defaultConfig(): RedactionConfig {
  return loadRedactionConfig({} as NodeJS.ProcessEnv);
}

const M = REDACTED_MARKER;

test("redacts common secret/token shapes in a tool_call_start input", () => {
  const event = {
    type: "tool_call_start",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "http_request",
    input: {
      url: "https://api.example.com/v1/things",
      headers: { Authorization: "Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345" },
      note: "call on behalf of jane.doe@example.com",
    },
  };

  const out = redactEvent(event, defaultConfig()) as typeof event;

  // `Authorization` is a denylisted field name -> whole value masked.
  assert.equal(out.input.headers.Authorization, M);
  // Email in a free-text string leaf -> masked in place.
  assert.equal(out.input.note, `call on behalf of ${M}`);
  // Untouched value stays intact.
  assert.equal(out.input.url, "https://api.example.com/v1/things");
  // Original object not mutated.
  assert.equal(event.input.note, "call on behalf of jane.doe@example.com");
});

test("redacts secret shapes in a tool_call_end result and message", () => {
  const event = {
    type: "tool_call_end",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "db_query",
    status: "success",
    result: {
      rows: [
        { id: 1, email: "user1@corp.io", card: "4242 4242 4242 4242" },
        { id: 2, email: "user2@corp.io", card: "4000056655665556" },
      ],
      awsKey: "AKIAIOSFODNN7EXAMPLE",
    },
    message: "fetched token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMiJ9.abcDEF123-_x",
  };

  const out = redactEvent(event, defaultConfig()) as typeof event;

  assert.equal(out.result.rows[0].email, M);
  assert.equal(out.result.rows[0].card, `${M}`);
  assert.equal(out.result.rows[1].email, M);
  assert.equal(out.result.rows[1].card, M);
  assert.equal(out.result.awsKey, M);
  assert.equal(out.result.rows[0].id, 1, "non-string leaves untouched");
  assert.equal(out.message, `fetched token ${M}`);
});

test("field-name denylist masks the whole value regardless of shape", () => {
  const event = {
    type: "tool_call_start",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "login",
    input: {
      username: "alice",
      password: "hunter2",
      apiKey: { primary: "abc", secondary: "def" },
      token: 1234567,
      NESTED: { Secret: ["a", "b"] },
    },
  };

  const out = redactEvent(event, defaultConfig()) as unknown as {
    input: Record<string, unknown>;
  };

  assert.equal(out.input.username, "alice");
  assert.equal(out.input.password, M);
  assert.equal(out.input.apiKey, M, "object value fully masked");
  assert.equal(out.input.token, M, "numeric value on denylisted key masked");
  assert.deepEqual(out.input.NESTED, { Secret: M }, "case-insensitive, nested");
});

test("recurses through nested objects and arrays", () => {
  const event = {
    type: "tool_call_end",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "t",
    status: "success",
    result: {
      a: [{ b: [{ c: "reach me at deep@nested.example" }] }],
    },
  };

  const out = redactEvent(event, defaultConfig()) as unknown as {
    result: { a: Array<{ b: Array<{ c: string }> }> };
  };

  assert.equal(out.result.a[0].b[0].c, `reach me at ${M}`);
});

test("non-string leaves are left untouched", () => {
  const event = {
    type: "tool_call_start",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "t",
    input: { count: 42, ok: true, nothing: null, ratio: 3.14 },
  };

  const out = redactEvent(event, defaultConfig()) as typeof event;
  assert.deepEqual(out.input, { count: 42, ok: true, nothing: null, ratio: 3.14 });
});

test("only input/result/message are touched — other fields pass through", () => {
  const event = {
    type: "tool_call_start",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "agent@example.com",
    caller: "sk-abcdefghijklmnopqrstuvwxyz",
    team: "bearer team",
    tool: "t",
    input: { q: "hello" },
  };

  const out = redactEvent(event, defaultConfig()) as typeof event;
  assert.equal(out.agentId, "agent@example.com", "agentId not redacted");
  assert.equal(out.caller, "sk-abcdefghijklmnopqrstuvwxyz", "caller not redacted");
  assert.equal(out.team, "bearer team");
});

test("disabled mode passes the event through unchanged (same reference)", () => {
  const config = loadRedactionConfig({ AGENTSVIZ_REDACTION: "off" } as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);

  const event = {
    type: "tool_call_start",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "t",
    input: { password: "hunter2", note: "me@example.com" },
  };

  const out = redactEvent(event, config);
  assert.equal(out, event, "returns the very same object reference");
  assert.equal(event.input.password, "hunter2", "nothing mutated");
});

test("assorted falsy AGENTSVIZ_REDACTION values disable redaction", () => {
  for (const val of ["0", "false", "no", "OFF", "Disabled", " off "]) {
    assert.equal(
      loadRedactionConfig({ AGENTSVIZ_REDACTION: val } as NodeJS.ProcessEnv).enabled,
      false,
      `expected "${val}" to disable`,
    );
  }
});

test("redaction is on by default and for unrecognised values", () => {
  assert.equal(loadRedactionConfig({} as NodeJS.ProcessEnv).enabled, true);
  assert.equal(
    loadRedactionConfig({ AGENTSVIZ_REDACTION: "on" } as NodeJS.ProcessEnv).enabled,
    true,
  );
  assert.equal(
    loadRedactionConfig({ AGENTSVIZ_REDACTION: "1" } as NodeJS.ProcessEnv).enabled,
    true,
  );
});

test("custom field names from AGENTSVIZ_REDACT_FIELDS are honoured (case-insensitive)", () => {
  const config = loadRedactionConfig({
    AGENTSVIZ_REDACT_FIELDS: "customerName, Internal_Id",
  } as NodeJS.ProcessEnv);

  const event = {
    type: "tool_call_start",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "t",
    input: { customername: "Jane Q", internal_id: "X-99", keep: "ok" },
  };

  const out = redactEvent(event, config) as typeof event;
  assert.equal(out.input.customername, M);
  assert.equal(out.input.internal_id, M);
  assert.equal(out.input.keep, "ok");
});

test("custom patterns from AGENTSVIZ_REDACT_PATTERNS are honoured", () => {
  const config = loadRedactionConfig({
    AGENTSVIZ_REDACT_PATTERNS: "EMP-\\d{5},\\bproject-[a-z]+\\b",
  } as NodeJS.ProcessEnv);

  const event = {
    type: "log",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    message: "assigned EMP-01234 to project-apollo",
  };

  const out = redactEvent(event, config) as typeof event;
  assert.equal(out.message, `assigned ${M} to ${M}`);
});

test("an un-compilable custom pattern is skipped, not fatal", () => {
  const config = loadRedactionConfig({
    AGENTSVIZ_REDACT_PATTERNS: "([unclosed, GOOD-\\d+",
  } as NodeJS.ProcessEnv);

  const event = {
    type: "log",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    message: "ref GOOD-42 here",
  };

  const out = redactEvent(event, config) as typeof event;
  assert.equal(out.message, `ref ${M} here`);
});

test("events without any redactable field are returned untouched", () => {
  const event = {
    type: "agent_start",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    team: "t",
  };
  const out = redactEvent(event, defaultConfig());
  assert.equal(out, event);
});

test("a clean payload with no secrets keeps the same string references", () => {
  const event = {
    type: "tool_call_end",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "search",
    status: "success",
    result: { summary: "3 key findings", hits: 2 },
    message: "done",
  };
  const out = redactEvent(event, defaultConfig()) as typeof event;
  assert.equal(out.message, "done");
  assert.equal(out.result.summary, "3 key findings");
  assert.equal(out.result.hits, 2);
});

test("redacts a PEM private key block spanning multiple lines", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nabcd/efgh+iAsdf==\n-----END RSA PRIVATE KEY-----";
  const event = {
    type: "tool_call_end",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentId: "a1",
    caller: "a1",
    tool: "t",
    status: "success",
    result: { key: `here it is:\n${pem}\nthanks` },
  };
  const out = redactEvent(event, defaultConfig()) as typeof event;
  assert.equal(out.result.key, `here it is:\n${M}\nthanks`);
});
