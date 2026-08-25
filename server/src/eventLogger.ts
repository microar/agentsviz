/**
 * Cheap JSONL event logging — a foundation for future replay/debugging.
 *
 * Every accepted event is appended to a local `.jsonl` file, one JSON
 * object per line. This is deliberately minimal (per issue #13, a
 * "stretch" feature): no rotation policy, no external logging library.
 *
 * Non-blocking by design: `logEvent` writes to a `fs.WriteStream` and
 * never returns a promise the caller is expected to await, so it cannot
 * delay the WS broadcast or the HTTP response. A single sequential write
 * stream (rather than one `fs.appendFile` call per event) avoids
 * interleaved writes under concurrent requests while still never
 * blocking the event loop on disk I/O. Stream errors are swallowed and
 * reported via `console.warn` — logging failures must never crash the
 * server or affect live broadcasting.
 *
 * File rotation: a fresh file is started on every server startup, named
 * with the process start time, so restarting the server is enough to
 * "rotate" — old sessions are never appended to. The log directory is
 * gitignored, so clearing between sessions is as simple as deleting the
 * directory's contents.
 */

import { existsSync, mkdirSync, type WriteStream } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";

const DEFAULT_LOG_DIR = path.join(process.cwd(), "data");

/** Resolve the JSONL log file path: `EVENT_LOG_PATH` env var, or a timestamped default. */
function resolveLogPath(): string {
  const configured = process.env.EVENT_LOG_PATH;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(DEFAULT_LOG_DIR, `events-${timestamp}.jsonl`);
}

let stream: WriteStream | undefined;
let resolvedPath: string | undefined;

/** Lazily create the write stream (and its directory) on first use. */
function getStream(): WriteStream {
  if (stream) return stream;

  resolvedPath = resolveLogPath();
  const dir = path.dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // "a" (append) so an explicitly-configured EVENT_LOG_PATH that already
  // exists is added to rather than clobbered mid-run.
  stream = createWriteStream(resolvedPath, { flags: "a" });
  stream.on("error", (err) => {
    console.warn(`Event log write failed (${resolvedPath}):`, err);
  });

  console.log(`Event log: appending accepted events to ${resolvedPath}`);
  return stream;
}

/**
 * Append one accepted event to the JSONL log. Fire-and-forget: does not
 * block or await, and never throws — write failures are logged via
 * `console.warn` and otherwise ignored so they can't affect live
 * broadcasting or the HTTP response.
 */
export function logEvent(event: unknown): void {
  try {
    const line = JSON.stringify(event) + "\n";
    getStream().write(line, (err) => {
      if (err) {
        console.warn(`Event log write failed (${resolvedPath}):`, err);
      }
    });
  } catch (err) {
    console.warn("Event log write failed:", err);
  }
}
