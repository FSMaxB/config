import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import { createInterface } from "node:readline";

export async function hasPersistedEntries(path: string, sessionId: string, ids: Set<string>, signal: AbortSignal): Promise<boolean> {
  if (!path || !existsSync(path)) return false;
  let descriptor: number;
  try { descriptor = openSync(path,"r"); } catch { return false; }
  let terminated = false;
  try {
    const size = statSync(path).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(descriptor,last,0,1,size-1);
      terminated = last[0] === 10;
    }
  } catch { return false; }
  finally { closeSync(descriptor); }
  const remaining = new Set(ids);
  const stream = createReadStream(path,{ encoding: "utf8",signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let previous: string | undefined;
  let first = true;
  const consume = (line: string): boolean => {
    const entry = JSON.parse(line);
    if (first) { first = false; return entry?.type === "session" && entry.id === sessionId; }
    if (entry?.type === "message" && typeof entry.id === "string") remaining.delete(entry.id);
    return true;
  };
  try {
    for await (const line of lines) {
      if (previous !== undefined && !consume(previous)) return false;
      previous = line;
      if (remaining.size === 0 && !first) return true;
    }
    if (terminated && previous !== undefined && !consume(previous)) return false;
    return !first && remaining.size === 0;
  } catch { return false; }
  finally { lines.close(); stream.destroy(); }
}
