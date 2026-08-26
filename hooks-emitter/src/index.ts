#!/usr/bin/env node
/**
 * Claude Code hook entry point. Register this script against
 * PreToolUse / PostToolUse / SessionStart / Stop / SubagentStop (see
 * README.md for a sample .claude/settings.json block).
 *
 * Contract this script MUST uphold (see issue #29):
 *   - Never throw, never let a rejected promise escape.
 *   - Never write to stderr in a way that would surface as hook noise
 *     (e.g. on connection refused / unreachable server).
 *   - Always exit 0, regardless of outcome — this is observe-only
 *     tooling and must never block or deny a tool call.
 *   - Add no perceptible latency to the tool call it's hooked to: the
 *     actual network POST happens in a detached child process (send.ts)
 *     spawned and left to run after this process exits.
 *
 * Flow: read the hook's JSON payload from stdin -> map it to an
 * AgentsViz event (map.ts) -> hand the event off to a detached sender
 * process -> exit 0 immediately without waiting for the POST.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mapHookPayload, parseHookPayload } from "./map.js";

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    // Defensive: if stdin is a TTY (script run manually with no pipe),
    // don't hang forever waiting for input.
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function dispatchToSender(eventJson: string): void {
  const senderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "send.js");
  const child = spawn(process.execPath, [senderPath, eventJson], {
    detached: true,
    stdio: "ignore",
  });
  // Let the child outlive this process; don't keep our event loop (or
  // exit) waiting on it either way.
  child.unref();
}

async function run(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return;
  }

  const payload = parseHookPayload(parsedBody);
  if (!payload) return;

  const event = mapHookPayload(payload);
  if (!event) return;

  dispatchToSender(JSON.stringify(event));
}

run()
  .catch(() => {
    /* swallow — this script must never throw */
  })
  .finally(() => {
    process.exit(0);
  });
