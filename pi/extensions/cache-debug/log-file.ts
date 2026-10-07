import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MarkerEvent, RECORD_VERSION, type LogRecord, type MarkerRecord } from "./records.ts";

export function cacheDebugDirectory(): string {
  return join(homedir(), ".pi", "agent", "cache-debug");
}

export function logFilePath(directory: string, sessionId: string): string {
  return join(directory, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
}

export class LogWriter {
  lastError: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly sizes = new Map<string, number>();
  private readonly capped = new Set<string>();
  private readonly directory: string;
  private readonly limitBytes: number;

  constructor(directory: string, limitBytes = 50 * 1024 * 1024) {
    this.directory = directory;
    this.limitBytes = limitBytes;
  }

  // Fire-and-forget: callers sit in the request path and must never wait on or fail from disk I/O.
  append(record: LogRecord): void {
    this.queue = this.queue
      .then(() => this.write(record))
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private async write(record: LogRecord): Promise<void> {
    const path = logFilePath(this.directory, record.sessionId);
    if (this.capped.has(path)) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const size = this.sizes.get(path) ?? (await stat(path).then(({ size: existing }) => existing, () => 0));
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (size + lineBytes > this.limitBytes) {
      this.capped.add(path);
      const marker: MarkerRecord = {
        version: RECORD_VERSION,
        kind: "marker",
        sessionId: record.sessionId,
        at: new Date().toISOString(),
        event: MarkerEvent.LogCapped,
      };
      await appendFile(path, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
      return;
    }
    await appendFile(path, line, { mode: 0o600 });
    this.sizes.set(path, size + lineBytes);
  }
}

export async function pruneLogs(directory: string, maximumAgeMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
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
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
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

function parseRecord(line: string): LogRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return (parsed as { version?: unknown }).version === RECORD_VERSION ? (parsed as LogRecord) : undefined;
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
