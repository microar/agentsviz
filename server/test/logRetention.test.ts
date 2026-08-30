/**
 * Unit tests for eventLogger.ts's `pruneEventLogs` (issue #53).
 *
 * Retention deletes old auto-rotated `events-*.jsonl` files from the active
 * log's directory on startup. What matters here: the count and age windows
 * are honoured and env-configurable, the currently-active file is never
 * deleted, non-matching files are left alone, and a missing directory is a
 * no-op rather than a throw.
 *
 * Same setup as eventLogger.test.ts — point `EVENT_LOG_PATH` at a temp file
 * and import the module dynamically so its lazy path resolution picks that
 * directory deterministically. `pruneEventLogs` re-reads its env vars on
 * every call, so each test sets the knobs it needs and clears them after.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "agentsviz-retention-"));
const activePath = path.join(dir, "events-active-run.jsonl");
process.env.EVENT_LOG_PATH = activePath;

const { pruneEventLogs } = await import("../src/eventLogger.js");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wipe the temp dir back to just the (empty) active log file. */
function resetDir(): void {
  for (const name of readdirSync(dir)) rmSync(path.join(dir, name));
  writeFileSync(activePath, "");
}

/** Create `data/events-<name>.jsonl` with the given content and mtime age. */
function makeLog(name: string, ageMs: number, content = "x\n"): string {
  const full = path.join(dir, `events-${name}.jsonl`);
  writeFileSync(full, content);
  const when = new Date(Date.now() - ageMs);
  utimesSync(full, when, when);
  return full;
}

function clearEnv(): void {
  delete process.env.EVENT_LOG_RETENTION_COUNT;
  delete process.env.EVENT_LOG_RETENTION_DAYS;
}

test("default count window keeps the 10 newest (active file counts as one)", () => {
  resetDir();
  clearEnv();
  // 15 older rotated files, ages 1..15 days.
  for (let i = 1; i <= 15; i++) makeLog(`d${String(i).padStart(2, "0")}`, i * DAY_MS);

  const result = pruneEventLogs();

  // Keep 9 others + the active file = 10 total. Prune the 6 oldest.
  assert.equal(result.pruned.length, 6);
  const remaining = readdirSync(dir).sort();
  assert.equal(remaining.length, 10);
  assert.ok(remaining.includes("events-active-run.jsonl"));
  assert.ok(remaining.includes("events-d09.jsonl"), "9-day-old file kept");
  assert.ok(!remaining.includes("events-d10.jsonl"), "10-day-old file pruned");
  assert.ok(result.freedBytes > 0);
  clearEnv();
});

test("EVENT_LOG_RETENTION_COUNT is configurable", () => {
  resetDir();
  process.env.EVENT_LOG_RETENTION_COUNT = "3";
  for (let i = 1; i <= 5; i++) makeLog(`c${i}`, i * DAY_MS);

  const result = pruneEventLogs();

  // Keep 2 others + active; prune 3.
  assert.equal(result.pruned.length, 3);
  const remaining = readdirSync(dir).sort();
  assert.deepEqual(remaining, ["events-active-run.jsonl", "events-c1.jsonl", "events-c2.jsonl"]);
  clearEnv();
});

test("EVENT_LOG_RETENTION_DAYS prunes by age; COUNT=0 disables the count limit", () => {
  resetDir();
  process.env.EVENT_LOG_RETENTION_COUNT = "0";
  process.env.EVENT_LOG_RETENTION_DAYS = "7";
  makeLog("fresh1", 1 * DAY_MS);
  makeLog("fresh2", 6 * DAY_MS);
  makeLog("old1", 8 * DAY_MS);
  makeLog("old2", 40 * DAY_MS);

  const result = pruneEventLogs();

  assert.equal(result.pruned.length, 2);
  const remaining = readdirSync(dir).sort();
  assert.deepEqual(remaining, [
    "events-active-run.jsonl",
    "events-fresh1.jsonl",
    "events-fresh2.jsonl",
  ]);
  clearEnv();
});

test("count and age windows combine — a file outside either is pruned", () => {
  resetDir();
  process.env.EVENT_LOG_RETENTION_COUNT = "5";
  process.env.EVENT_LOG_RETENTION_DAYS = "3";
  // 3 recent files (within both windows) + 1 recent-but-6th-newest is n/a
  // here; instead: 2 within age, 2 outside age but within count.
  makeLog("r1", 1 * DAY_MS);
  makeLog("r2", 2 * DAY_MS);
  makeLog("a1", 10 * DAY_MS); // within count window (<=4 others) but too old
  makeLog("a2", 20 * DAY_MS);

  const result = pruneEventLogs();

  // Count window (keep 4 others) would keep all 4; age window removes a1, a2.
  assert.equal(result.pruned.length, 2);
  const remaining = readdirSync(dir).sort();
  assert.deepEqual(remaining, ["events-active-run.jsonl", "events-r1.jsonl", "events-r2.jsonl"]);
  clearEnv();
});

test("never prunes the active log file even under heavy pressure", () => {
  resetDir();
  process.env.EVENT_LOG_RETENTION_COUNT = "1";
  process.env.EVENT_LOG_RETENTION_DAYS = "1";
  // Make the active file look ancient — it must still survive.
  const ancient = new Date(Date.now() - 365 * DAY_MS);
  utimesSync(activePath, ancient, ancient);
  makeLog("other", 2 * DAY_MS);

  const result = pruneEventLogs();

  assert.ok(existsSync(activePath), "active file still present");
  assert.ok(!result.pruned.includes(activePath));
  assert.deepEqual(readdirSync(dir).sort(), ["events-active-run.jsonl"]);
  clearEnv();
});

test("leaves non-matching files (SQLite db, unrelated files) alone", () => {
  resetDir();
  process.env.EVENT_LOG_RETENTION_COUNT = "1";
  writeFileSync(path.join(dir, "agentsviz.db"), "sqlite");
  writeFileSync(path.join(dir, "notes.txt"), "hello");
  makeLog("rotated", 5 * DAY_MS);

  const result = pruneEventLogs();

  assert.equal(result.pruned.length, 1);
  const remaining = readdirSync(dir).sort();
  assert.deepEqual(remaining, ["agentsviz.db", "events-active-run.jsonl", "notes.txt"]);
  clearEnv();
});

test("both knobs disabled (COUNT=0, DAYS unset) prunes nothing", () => {
  resetDir();
  process.env.EVENT_LOG_RETENTION_COUNT = "0";
  for (let i = 1; i <= 5; i++) makeLog(`k${i}`, i * DAY_MS);

  const result = pruneEventLogs();

  assert.equal(result.pruned.length, 0);
  assert.equal(readdirSync(dir).length, 6);
  clearEnv();
});

test("empty log directory (only the active file, or none) prunes nothing", () => {
  resetDir();
  clearEnv();
  assert.deepEqual(pruneEventLogs(), { pruned: [], freedBytes: 0 });
});

// Must run last — it removes the temp directory the other tests rely on.
test("a missing log directory is a no-op, not a throw", () => {
  clearEnv();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
  assert.deepEqual(pruneEventLogs(), { pruned: [], freedBytes: 0 });
});
