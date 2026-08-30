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
 *
 * Retention (issue #53): because a frequently-restarted server would
 * otherwise pile up `events-<timestamp>.jsonl` files forever (disk-fill
 * risk, unbrowsable `data/`), `pruneEventLogs` deletes old ones on startup
 * — see its doc comment for the `EVENT_LOG_RETENTION_COUNT` /
 * `EVENT_LOG_RETENTION_DAYS` knobs. Only the timestamped JSONL files are
 * touched; the SQLite event store (issue #51) is left alone.
 *
 * `getLogFilePath` exposes the resolved path of the *current* process's
 * log file (see issue #43) so other modules — namely the `/events/history`
 * route in index.ts — can read back this run's recorded events for replay
 * without duplicating the path-resolution logic above. It shares the same
 * lazily-resolved `resolvedPath` that `logEvent`/`getStream` use, so calling
 * it before any event has been logged still returns the exact path this
 * process will (or already does) write to, rather than resolving a second,
 * differently-timestamped default path.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";

const DEFAULT_LOG_DIR = path.join(process.cwd(), "data");

/** Keep this many of the newest JSONL logs (incl. the active one) by default. */
const DEFAULT_RETENTION_COUNT = 10;

/**
 * Auto-rotated log filenames: `events-<ISO-timestamp>.jsonl` (see
 * `resolveLogPath`). Retention only ever considers files matching this — an
 * explicitly-configured `EVENT_LOG_PATH`, the SQLite `.db`, or anything
 * else in the directory is never pruned.
 */
const ROTATED_LOG_PATTERN = /^events-.*\.jsonl$/;

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

/** Resolve (once) and cache the current process's log file path. */
function ensureResolvedPath(): string {
  if (!resolvedPath) {
    resolvedPath = resolveLogPath();
  }
  return resolvedPath;
}

/** Lazily create the write stream (and its directory) on first use. */
function getStream(): WriteStream {
  if (stream) return stream;

  const resolvedPath = ensureResolvedPath();
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

/**
 * The absolute path of the JSONL log file this process is (or will be)
 * writing accepted events to. Does not create the file or its directory —
 * that only happens lazily on the first `logEvent` call (see `getStream`)
 * — so a caller reading history before any event has been logged should
 * expect the file may not exist yet.
 */
export function getLogFilePath(): string {
  return ensureResolvedPath();
}

/** Non-negative integer from an env var, or `fallback` if unset/blank/invalid. */
function retentionEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** What `pruneEventLogs` did, for startup logging and tests. */
export interface PruneResult {
  /** Absolute paths of the files that were deleted. */
  pruned: string[];
  /** Total size of the deleted files, in bytes. */
  freedBytes: number;
}

/**
 * Delete old auto-rotated JSONL logs from the active log's directory,
 * keeping a bounded window. Intended to run once at startup (before the
 * fresh run's file is created), matching the existing "new file per
 * restart" rotation model.
 *
 * Two independent knobs, both applied when set — a file is pruned if it
 * falls outside *either* limit (whichever removes more):
 *
 *   `EVENT_LOG_RETENTION_COUNT`  keep only the N newest logs (default 10).
 *                                The active file counts as one of the N.
 *                                Set to `0` to disable the count limit.
 *   `EVENT_LOG_RETENTION_DAYS`   also delete anything whose mtime is older
 *                                than N days. Unset (or `0`) disables it.
 *
 * With both unset, the default count of 10 applies. Never deletes the
 * currently-active log file, and only ever touches files matching
 * `events-*.jsonl` (see `ROTATED_LOG_PATTERN`). A missing directory or an
 * individual unlink failure is swallowed with a `console.warn` — retention
 * is best-effort housekeeping and must never crash startup.
 */
export function pruneEventLogs(now: number = Date.now()): PruneResult {
  const result: PruneResult = { pruned: [], freedBytes: 0 };

  const activePath = ensureResolvedPath();
  const dir = path.dirname(activePath);

  const retentionCount = retentionEnvInt("EVENT_LOG_RETENTION_COUNT", DEFAULT_RETENTION_COUNT);
  const retentionDays = retentionEnvInt("EVENT_LOG_RETENTION_DAYS", 0);
  if (retentionCount <= 0 && retentionDays <= 0) return result;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No log directory yet (nothing has ever been logged) — nothing to do.
    return result;
  }

  interface Candidate {
    path: string;
    mtimeMs: number;
    size: number;
  }
  const candidates: Candidate[] = [];
  for (const name of entries) {
    if (!ROTATED_LOG_PATTERN.test(name)) continue;
    const full = path.join(dir, name);
    if (full === activePath) continue; // never prune the active file
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      candidates.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // Vanished between readdir and stat — ignore.
    }
  }

  // Newest first, so the count window is a simple slice.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const doomed = new Set<Candidate>();
  if (retentionCount > 0) {
    // The active file occupies one of the N slots, so keep at most (N - 1)
    // of these older files.
    const keepOthers = Math.max(0, retentionCount - 1);
    for (const c of candidates.slice(keepOthers)) doomed.add(c);
  }
  if (retentionDays > 0) {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    for (const c of candidates) {
      if (c.mtimeMs < cutoff) doomed.add(c);
    }
  }

  for (const c of doomed) {
    try {
      rmSync(c.path);
      result.pruned.push(c.path);
      result.freedBytes += c.size;
    } catch (err) {
      console.warn(`Event log retention: failed to delete ${c.path}:`, err);
    }
  }

  return result;
}
