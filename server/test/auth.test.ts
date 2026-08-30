/**
 * Unit tests for src/auth.ts (issue #52) — token parsing and extraction
 * in isolation, no HTTP. The end-to-end behaviour (401 on POST /events
 * and the /ws handshake) is covered by test/events-route.test.ts and the
 * integration suite.
 *
 * Uses node's built-in test runner via tsx, same as store.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import {
  DEV_FALLBACK_TOKEN,
  getAllowedTokens,
  isAllowed,
  tokenFromHeaders,
  tokenFromUpgradeRequest,
  usingDevFallback,
} from "../src/auth.js";

test("getAllowedTokens falls back to the dev token when nothing is configured", () => {
  assert.deepEqual(getAllowedTokens({}), [DEV_FALLBACK_TOKEN]);
  assert.deepEqual(getAllowedTokens({ AGENTSVIZ_API_KEYS: "   " }), [DEV_FALLBACK_TOKEN]);
  assert.equal(usingDevFallback({}), true);
});

test("getAllowedTokens parses a comma-separated list, trimming blanks", () => {
  assert.deepEqual(getAllowedTokens({ AGENTSVIZ_API_KEYS: "a, b ,,c" }), ["a", "b", "c"]);
  assert.equal(usingDevFallback({ AGENTSVIZ_API_KEYS: "a,b" }), false);
});

test("getAllowedTokens also accepts the singular AGENTSVIZ_API_KEY", () => {
  assert.deepEqual(getAllowedTokens({ AGENTSVIZ_API_KEY: "solo" }), ["solo"]);
});

test("tokenFromHeaders reads Bearer, bare Authorization, and X-API-Key", () => {
  assert.equal(tokenFromHeaders({ authorization: "Bearer abc123" }), "abc123");
  assert.equal(tokenFromHeaders({ authorization: "bearer abc123" }), "abc123");
  assert.equal(tokenFromHeaders({ authorization: "abc123" }), "abc123");
  assert.equal(tokenFromHeaders({ "x-api-key": "abc123" }), "abc123");
  assert.equal(tokenFromHeaders({}), undefined);
  assert.equal(tokenFromHeaders({ authorization: "Bearer   " }), undefined);
});

test("tokenFromUpgradeRequest reads ?token= from the handshake URL, header taking precedence", () => {
  assert.equal(
    tokenFromUpgradeRequest({ url: "/ws?token=fromquery", headers: {} } as IncomingMessage),
    "fromquery",
  );
  assert.equal(
    tokenFromUpgradeRequest({
      url: "/ws?token=fromquery",
      headers: { authorization: "Bearer fromheader" },
    } as IncomingMessage),
    "fromheader",
  );
  assert.equal(
    tokenFromUpgradeRequest({ url: "/ws", headers: {} } as IncomingMessage),
    undefined,
  );
});

test("isAllowed only accepts a non-empty token present in the list", () => {
  assert.equal(isAllowed("a", ["a", "b"]), true);
  assert.equal(isAllowed("z", ["a", "b"]), false);
  assert.equal(isAllowed(undefined, ["a", "b"]), false);
});
