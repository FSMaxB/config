import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorCode, errorMessage } from "../lib/errors.ts";
import { BYTES_PER_MEBIBYTE, MILLISECONDS_PER_DAY } from "../lib/units.ts";
import { isRecord } from "../lib/untyped.ts";
import { MarkerEvent, RECORD_VERSION } from "./records.ts";
import type { LogRecord, MarkerRecord } from "./records.ts";

export function cacheDebugDirectory(home: string = homedir()): string {
  return join(home, ".pi", "agent", "cache-debug");
}

// A busy session writes a few MiB a day; the cap only stops a runaway session from filling the disk.
const LOG_LIMIT_MEBIBYTES = 50;
const LOG_LIMIT_BYTES = LOG_LIMIT_MEBIBYTES * BYTES_PER_MEBIBYTE;
// A month keeps the logs of every session that is still likely to be resumed.
const MAXIMUM_LOG_AGE_DAYS = 30;
const MAXIMUM_LOG_AGE_MILLISECONDS = MAXIMUM_LOG_AGE_DAYS * MILLISECONDS_PER_DAY;
// The logs describe the user's sessions, so only the owner may read them.
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export class LogWriter {
  lastError: string | undefined;
  #queue: Promise<void> = Promise.resolve();
  readonly #sizes = new Map<string, number>();
  readonly #capped = new Set<string>();
  readonly #directory: string;
  readonly #limitBytes: number;

  constructor(directory: string, limitBytes = LOG_LIMIT_BYTES) {
    this.#directory = directory;
    this.#limitBytes = limitBytes;
  }

  // Fire-and-forget: callers sit in the request path and must never wait on or fail from disk I/O.
  append(record: LogRecord): void {
    this.#queue = this.#queue
      .then(() => this.#write(record))
      .catch((error: unknown) => {
        this.lastError = errorMessage(error);
      });
  }

  flush(): Promise<void> {
    return this.#queue;
  }

  async #write(record: LogRecord): Promise<void> {
    const path = logFilePath(this.#directory, record.sessionId);
    if (this.#capped.has(path)) return;
    await mkdir(this.#directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
    const size = this.#sizes.get(path) ?? (await stat(path).then(({ size: existing }) => existing, () => 0));
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (size + lineBytes > this.#limitBytes) {
      this.#capped.add(path);
      const marker: MarkerRecord = {
        version: RECORD_VERSION,
        kind: "marker",
        sessionId: record.sessionId,
        at: new Date().toISOString(),
        event: MarkerEvent.LogCapped,
      };
      await appendFile(path, `${JSON.stringify(marker)}\n`, { mode: OWNER_ONLY_FILE_MODE });
      return;
    }
    await appendFile(path, line, { mode: OWNER_ONLY_FILE_MODE });
    this.#sizes.set(path, size + lineBytes);
  }
}

export async function pruneLogs(directory: string, maximumAgeMs = MAXIMUM_LOG_AGE_MILLISECONDS, now = Date.now()): Promise<number> {
  const names = await readdir(directory).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  const removals = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(directory, name);
        const { mtimeMs } = await stat(path);
        if (mtimeMs >= now - maximumAgeMs) return 0;
        await rm(path, { force: true });
        return 1;
      }),
  );
  return removals.reduce<number>((sum, removed) => sum + removed, 0);
}

// A crash can leave a torn last line, so unparseable lines are skipped instead of failing the report.
export async function readLog(path: string): Promise<LogRecord[]> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const record = parseRecord(line);
      return record ? [record] : [];
    });
}

export async function resolveLogPath(directory: string, target: string | undefined): Promise<string | undefined> {
  if (target === undefined) return newestLog(directory);
  if (target.endsWith(".jsonl") || target.includes("/")) return target;
  return logFilePath(directory, target);
}

export function logFilePath(directory: string, sessionId: string): string {
  return join(directory, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
}

function parseRecord(line: string): LogRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.version !== RECORD_VERSION) return undefined;
    const record: unknown = parsed;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only this extension writes the log, and the version check identifies the shape
    return record as LogRecord;
  } catch {
    return undefined;
  }
}

async function newestLog(directory: string): Promise<string | undefined> {
  const names = await readdir(directory).catch(() => []);
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => ({ path: join(directory, name), mtimeMs: (await stat(join(directory, name))).mtimeMs })),
  );
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
}
