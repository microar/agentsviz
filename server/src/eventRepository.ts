/**
 * Persistent event storage — a SQLite-backed log of every accepted event.
 *
 * This is the durable counterpart to the in-memory `StateStore`
 * (`store.ts`) and the per-process JSONL file (`eventLogger.ts`): both of
 * those are wiped on every server restart, so a deploy/crash/restart used
 * to lose all observability data. Every event accepted by `POST /events`
 * is appended here as one row (full envelope columns + the raw JSON), and
 * on startup `server/src/index.ts` replays `readAll()` through the
 * unchanged `StateStore.applyEvent` to reconstruct the live view instead
 * of starting empty. `StateStore` stays a pure in-memory derivation of
 * the event stream — its shape (and the frontend `applyEvent` mirror,
 * see CLAUDE.md) is untouched; this module only makes the *input* stream
 * survive restarts.
 *
 * Backend: Node's built-in `node:sqlite` (`DatabaseSync`). Zero external
 * dependency, in keeping with this repo's minimal-tooling style (no test
 * framework, no logging library). The schema mirrors the event envelope
 * from `docs/event-schema.md` and can be pointed at a different SQLite
 * file — or, in future, swapped for a Postgres-backed implementation of
 * the same tiny surface (`append` / `readAll` / `count`) for multi-instance
 * deployments — without touching callers.
 *
 * Never throws into the ingestion path. Like `eventLogger.ts`, every
 * operation is wrapped: if the driver is unavailable, the file can't be
 * opened, or a write fails, the error is reported via `console.warn` and
 * the repository degrades to a disabled no-op (`enabled === false`). Live
 * validation, `StateStore` updates and the WebSocket broadcast are
 * completely unaffected — persistence is best-effort durability layered
 * under an already-working live pipeline.
 *
 * Config: `AGENTSVIZ_DB_PATH` env var (a filesystem path, or `:memory:`
 * for an ephemeral DB); defaults to `<cwd>/data/agentsviz.db`.
 *
 * Schema versioning: `PRAGMA user_version` holds the applied schema
 * version; `MIGRATIONS` is an ordered list of DDL steps and `migrate()`
 * applies every step past the current version inside a transaction. A
 * first-cut but real strategy — adding a column later is a new array
 * entry, no manual DB surgery.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentEvent } from "./eventSchema.js";

const DEFAULT_DB_DIR = path.join(process.cwd(), "data");
const DEFAULT_DB_FILE = "agentsviz.db";

/**
 * Ordered schema migrations. The array index + 1 is the schema version a
 * step brings the DB to; `migrate()` runs every step whose version is
 * greater than the current `PRAGMA user_version`. Only ever append —
 * never edit or reorder existing entries.
 */
const MIGRATIONS: string[] = [
  // v1 — initial schema: one row per accepted event, columns mirroring the
  // envelope in docs/event-schema.md plus the verbatim JSON for lossless
  // replay, and a server-side ingestion timestamp.
  `
    CREATE TABLE events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      team        TEXT,
      caller      TEXT,
      tool        TEXT,
      input       TEXT,
      result      TEXT,
      status      TEXT,
      message     TEXT,
      raw         TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE INDEX idx_events_agent_id ON events (agent_id);
    CREATE INDEX idx_events_timestamp ON events (timestamp);
  `,
];

/** Resolve the SQLite database path: `AGENTSVIZ_DB_PATH`, or a local default. */
export function resolveDbPath(): string {
  const configured = process.env.AGENTSVIZ_DB_PATH;
  if (configured && configured.trim().length > 0) {
    return configured.trim() === ":memory:" ? ":memory:" : path.resolve(configured.trim());
  }
  return path.join(DEFAULT_DB_DIR, DEFAULT_DB_FILE);
}

/** `JSON.stringify`, but tolerant: unstringifiable values persist as `null`. */
function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

export interface PersistedEventRow {
  seq: number;
  type: string;
  timestamp: string;
  agentId: string;
  receivedAt: string;
  /** The verbatim event envelope as originally accepted by `POST /events`. */
  event: unknown;
}

export class EventRepository {
  private db: DatabaseSync | undefined;
  private insertStmt: ReturnType<DatabaseSync["prepare"]> | undefined;
  private _enabled = false;
  readonly path: string;

  constructor(dbPath: string = resolveDbPath()) {
    this.path = dbPath;
    try {
      if (dbPath !== ":memory:") {
        const dir = path.dirname(dbPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }

      this.db = new DatabaseSync(dbPath);
      // WAL keeps the fire-and-forget append off the read path's lock and
      // survives an unclean shutdown better than the default rollback journal.
      if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
      this.migrate();

      this.insertStmt = this.db.prepare(
        `INSERT INTO events
           (type, timestamp, agent_id, team, caller, tool, input, result, status, message, raw, received_at)
         VALUES
           (:type, :timestamp, :agent_id, :team, :caller, :tool, :input, :result, :status, :message, :raw, :received_at)`,
      );

      this._enabled = true;
      const count = this.count();
      console.log(
        `Event store: SQLite at ${dbPath} (${count} event${count === 1 ? "" : "s"} persisted)`,
      );
    } catch (err) {
      console.warn(
        `Event store: persistence disabled — could not open SQLite at ${dbPath}:`,
        err,
      );
      this.safeClose();
      this.db = undefined;
      this.insertStmt = undefined;
      this._enabled = false;
    }
  }

  /** True when events are actually being persisted. False = degraded no-op mode. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Apply any schema migrations past the DB's current `user_version`. */
  private migrate(): void {
    if (!this.db) return;
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const current = typeof row?.user_version === "number" ? row.user_version : 0;
    if (current >= MIGRATIONS.length) return;

    for (let version = current; version < MIGRATIONS.length; version++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[version]);
        // PRAGMA doesn't accept bound params; the value is a loop int, not user input.
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
    console.log(`Event store: schema migrated ${current} -> ${MIGRATIONS.length}`);
  }

  /**
   * Persist one accepted event. Fire-and-forget: never throws — a write
   * failure is logged via `console.warn` and otherwise ignored so it
   * can't affect validation, `StateStore`, or the WebSocket broadcast.
   */
  append(event: AgentEvent): void {
    if (!this._enabled || !this.insertStmt) return;
    try {
      const e = event as Record<string, unknown>;
      this.insertStmt.run({
        type: event.type,
        timestamp: event.timestamp,
        agent_id: event.agentId,
        team: (e.team as string | undefined) ?? null,
        caller: (e.caller as string | undefined) ?? null,
        tool: (e.tool as string | undefined) ?? null,
        input: "input" in e ? toJson(e.input) : null,
        result: "result" in e ? toJson(e.result) : null,
        status: (e.status as string | undefined) ?? null,
        message: (e.message as string | undefined) ?? null,
        raw: JSON.stringify(event),
        received_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`Event store: append failed (${this.path}):`, err);
    }
  }

  /**
   * Every persisted event, oldest first — the same shape and order they
   * were POSTed to `/events`. Used on startup to rebuild `StateStore` and
   * by `/events/history` for the timeline scrubber. Returns `[]` when
   * persistence is disabled or the read fails.
   */
  readAll(): unknown[] {
    return this.readAllRows().map((row) => row.event);
  }

  /** Like `readAll`, but each entry keeps its `seq`/`receivedAt` metadata. */
  readAllRows(): PersistedEventRow[] {
    if (!this._enabled || !this.db) return [];
    try {
      const rows = this.db
        .prepare(
          "SELECT seq, type, timestamp, agent_id, raw, received_at FROM events ORDER BY seq ASC",
        )
        .all() as Array<{
        seq: number;
        type: string;
        timestamp: string;
        agent_id: string;
        raw: string;
        received_at: string;
      }>;
      return rows.map((row) => ({
        seq: row.seq,
        type: row.type,
        timestamp: row.timestamp,
        agentId: row.agent_id,
        receivedAt: row.received_at,
        event: JSON.parse(row.raw),
      }));
    } catch (err) {
      console.warn(`Event store: read failed (${this.path}):`, err);
      return [];
    }
  }

  /** Number of persisted events (0 when disabled or on error). */
  count(): number {
    if (!this.db) return 0;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n?: number } | undefined;
      return typeof row?.n === "number" ? row.n : 0;
    } catch {
      return 0;
    }
  }

  /** Close the underlying database handle. Safe to call more than once. */
  close(): void {
    this.safeClose();
    this.db = undefined;
    this.insertStmt = undefined;
    this._enabled = false;
  }

  private safeClose(): void {
    try {
      this.db?.close();
    } catch {
      // Already closed / never opened — nothing to do.
    }
  }
}
