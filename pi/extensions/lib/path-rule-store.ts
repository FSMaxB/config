import { readFile } from "node:fs/promises";
import { errorCode } from "./errors.ts";
import { withFileLock } from "./file-lock.ts";
import { writeJsonFileAtomically } from "./json.ts";
import { emptyStoredRules, parseStoredRules, serializeStoredRules } from "./path-permission-rules.ts";
import type { StoredRules } from "./path-permission-rules.ts";

export async function transaction<T>(filePath: string, operation: (rules: StoredRules) => Promise<T> | T): Promise<T> {
  return await withFileLock(filePath, "path permission", async () => {
    const rules = await readStoredRules(filePath);
    const result = await operation(rules);
    await writeJsonFileAtomically(filePath, serializeStoredRules(rules));
    return result;
  });
}

export async function readStoredRules(filePath: string): Promise<StoredRules> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyStoredRules();
    throw error;
  }
  return parseStoredRules(JSON.parse(text));
}
