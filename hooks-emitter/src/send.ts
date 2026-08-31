#!/usr/bin/env node
/**
 * Detached "sender" process. Spawned by index.ts (never invoked directly
 * by a Claude Code hook) so that the actual network POST — and any
 * latency it incurs — happens fully outside the hook's process lifetime.
 *
 * Reads one JSON event off argv[2], POSTs it to $AGENTSVIZ_EVENTS_URL
 * (falling back to http://localhost:4000/events) with an
 * `Authorization: Bearer` header from $AGENTSVIZ_API_KEY (issue #52,
 * falling back to the shared local-dev token so a default `npm run dev`
 * setup works with no config), and always exits 0. Every failure mode
 * (bad JSON, connection refused, timeout, non-2xx, 401) is swallowed
 * silently — this process must never write to stderr in a way that would
 * surface as hook noise, and must never throw.
 *
 * The one addition (issue #67): when `$AGENTSVIZ_DEBUG` is set, a failed
 * delivery is appended to a log FILE (never stderr) via `debugLog`, so a
 * user who set nothing up but sees an empty dashboard has a way to find
 * out their events are being rejected. With the env var unset this is a
 * no-op and behaviour is exactly as before.
 */

import { describeFailure, debugLog, postEvent } from "./emit.js";

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) return;

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const outcome = await postEvent(event);
  const failure = describeFailure(outcome);
  if (failure) debugLog(failure);
}

main()
  .catch(() => {
    /* never throw out of the process */
  })
  .finally(() => {
    process.exit(0);
  });
