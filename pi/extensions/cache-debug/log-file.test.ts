import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LogWriter, logFilePath, pruneLogs, readLog, resolveLogPath } from "./log-file.ts";
import { MarkerEvent, Outcome, RECORD_VERSION, type LogRecord } from "./records.ts";

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-cache-debug-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function freshDirectory(): string {
  counter += 1;
  return join(root, `case-${counter}`);
}

function record(id: string): LogRecord {
  return {
    version: RECORD_VERSION,
    kind: "request",
    sessionId: "session",
    provider: "p",
    model: id,
    api: "a",
    startedAt: new Date(0).toISOString(),
    outcome: Outcome.Completed,
  };
}

test("appends are written in order with owner-only permissions", async () => {
  // arrange
  const directory = freshDirectory();
  const writer = new LogWriter(directory);

  // act
  writer.append(record("one"));
  writer.append(record("two"));
  await writer.flush();

  // assert
  const records = await readLog(logFilePath(directory, "session"));
  assert.deepEqual(records.map((entry) => entry.kind === "request" && entry.model), ["one", "two"]);
  const { mode } = await stat(logFilePath(directory, "session"));
  assert.equal(mode & 0o777, 0o600);
});

test("the size cap writes one marker and then stops", async () => {
  // arrange
  const directory = freshDirectory();
  const lineBytes = Buffer.byteLength(`${JSON.stringify(record("one"))}\n`);
  const writer = new LogWriter(directory, Math.floor(lineBytes * 1.5));

  // act
  writer.append(record("one"));
  writer.append(record("two"));
  writer.append(record("three"));
  await writer.flush();

  // assert
  const records = await readLog(logFilePath(directory, "session"));
  assert.equal(records.length, 2);
  assert.ok(records[1]?.kind === "marker" && records[1].event === MarkerEvent.LogCapped);
});

test("the size cap counts bytes that are already on disk", async () => {
  // arrange
  const directory = freshDirectory();
  const first = new LogWriter(directory);
  first.append(record("one"));
  await first.flush();
  const lineBytes = Buffer.byteLength(`${JSON.stringify(record("one"))}\n`);
  const writer = new LogWriter(directory, lineBytes + 10);

  // act
  writer.append(record("two"));
  await writer.flush();

  // assert
  const records = await readLog(logFilePath(directory, "session"));
  assert.deepEqual(records.map(({ kind }) => kind), ["request", "marker"]);
});

test("a failing write sets lastError instead of throwing", async () => {
  // arrange
  const blocker = freshDirectory();
  await writeFile(blocker, "not a directory");
  const writer = new LogWriter(blocker);

  // act
  writer.append(record("one"));
  await writer.flush();

  // assert
  assert.ok(writer.lastError);
});

test("pruneLogs removes only stale jsonl files", async () => {
  // arrange
  const directory = freshDirectory();
  const writer = new LogWriter(directory);
  writer.append(record("one"));
  await writer.flush();
  const stale = join(directory, "stale.jsonl");
  const unrelated = join(directory, "notes.txt");
  await writeFile(stale, "{}\n");
  await writeFile(unrelated, "keep");
  const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await utimes(stale, thirtyOneDaysAgo, thirtyOneDaysAgo);
  await utimes(unrelated, thirtyOneDaysAgo, thirtyOneDaysAgo);

  // act
  const removed = await pruneLogs(directory);

  // assert
  assert.equal(removed, 1);
  await assert.rejects(stat(stale));
  await stat(unrelated);
  await stat(logFilePath(directory, "session"));
});

test("readLog skips torn lines and other versions", async () => {
  // arrange
  const directory = freshDirectory();
  const path = join(directory, "mixed.jsonl");
  const good = JSON.stringify(record("good"));
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${good}\n${JSON.stringify({ ...record("future"), version: 2 })}\n{"version":1,"kind":"requ`);

  // act
  const records = await readLog(path);

  // assert
  assert.deepEqual(records.map((entry) => entry.kind === "request" && entry.model), ["good"]);
});

test("resolveLogPath picks the newest log, a session id or a path", async () => {
  // arrange
  const directory = freshDirectory();
  await mkdir(directory, { recursive: true });
  const older = join(directory, "older.jsonl");
  const newer = join(directory, "newer.jsonl");
  await writeFile(older, "");
  await writeFile(newer, "");
  await utimes(older, new Date(1000), new Date(1000));

  // act
  const newest = await resolveLogPath(directory, undefined);
  const byId = await resolveLogPath(directory, "abc-1");
  const byPath = await resolveLogPath(directory, "/somewhere/else.jsonl");

  // assert
  assert.equal(newest, newer);
  assert.equal(byId, join(directory, "abc-1.jsonl"));
  assert.equal(byPath, "/somewhere/else.jsonl");
});
