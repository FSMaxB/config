import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorCode } from "./errors.ts";
import { isRecord } from "./untyped.ts";

// The agent directory's state files can hold grants and denial notes, so only the owner may read them.
export const OWNER_ONLY_FILE_MODE = 0o600;
// Indented so the files stay readable and diffable when edited by hand.
const JSON_INDENT = 2;

// undefined when the file does not exist; throws when it exists but is not a JSON object, so callers
// never mistake a damaged file for an empty one and overwrite it.
export async function readJsonObjectFile(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const parsed = parseJson(text, path);
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object; fix or delete it.`);
  return parsed;
}

export async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
}

// Readers see either the old or the new content, never a partly written file.
export async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { mode: OWNER_ONLY_FILE_MODE });
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
