/**
 * Unit tests for validateEvent's optional token/cost fields (#55).
 *
 * Uses node's built-in test runner via tsx, same as store.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEvent } from "../src/eventSchema.js";

const TS = "2026-08-24T00:00:00.000Z";

const toolCallEnd = { type: "tool_call_end", timestamp: TS, agentId: "a", tool: "search", caller: "a", status: "success" };
const agentStop = { type: "agent_stop", timestamp: TS, agentId: "a", status: "success" };

test("events without cost fields are still valid", () => {
  assert.equal(validateEvent(toolCallEnd).valid, true);
  assert.equal(validateEvent(agentStop).valid, true);
});

test("valid non-negative numbers are accepted on tool_call_end and agent_stop", () => {
  for (const base of [toolCallEnd, agentStop]) {
    const result = validateEvent({ ...base, tokensIn: 1200, tokensOut: 0, costUsd: 0.0123 });
    assert.equal(result.valid, true, JSON.stringify(result));
  }
});

test("negative, non-finite, and non-number cost fields are rejected", () => {
  const bad: unknown[] = [-1, Number.NaN, Number.POSITIVE_INFINITY, "10", null, true, {}];
  for (const field of ["tokensIn", "tokensOut", "costUsd"]) {
    for (const value of bad) {
      const result = validateEvent({ ...toolCallEnd, [field]: value });
      assert.equal(result.valid, false, `${field}=${String(value)} should be rejected`);
      if (!result.valid) {
        assert.ok(
          result.errors.some((e) => e.includes(`"${field}"`)),
          `expected an error naming ${field}, got ${JSON.stringify(result.errors)}`,
        );
      }
    }
  }
});
