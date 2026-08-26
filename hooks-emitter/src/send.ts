#!/usr/bin/env node
/**
 * Detached "sender" process. Spawned by index.ts (never invoked directly
 * by a Claude Code hook) so that the actual network POST — and any
 * latency it incurs — happens fully outside the hook's process lifetime.
 *
 * Reads one JSON event off argv[2], POSTs it to $AGENTSVIZ_EVENTS_URL
 * (falling back to http://localhost:4000/events), and always exits 0.
 * Every failure mode (bad JSON, connection refused, timeout, non-2xx) is
 * swallowed silently — this process must never write to stderr in a way
 * that would surface as hook noise, and must never throw.
 */

const DEFAULT_EVENTS_URL = "http://localhost:4000/events";
const TIMEOUT_MS = 3000;

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) return;

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const url = process.env.AGENTSVIZ_EVENTS_URL || DEFAULT_EVENTS_URL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
  } catch {
    // Connection refused, DNS failure, timeout abort, etc. — swallow.
  } finally {
    clearTimeout(timer);
  }
}

main()
  .catch(() => {
    /* never throw out of the process */
  })
  .finally(() => {
    process.exit(0);
  });
