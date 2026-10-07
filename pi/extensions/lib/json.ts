import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// undefined when the file does not exist; throws when it exists but is not a JSON object, so callers
// never mistake a damaged file for an empty one and overwrite it.
export async function readJsonObjectFile(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const parsed = parseJson(text, path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; fix or delete it.`);
  return parsed as Record<string, unknown>;
}

export async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or delete it.`);
  }
}
