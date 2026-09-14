import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseRules, serializeRules, type RuleSets } from "./path-permission-rules.ts";

export interface PathRuleStoreOptions { filePath: string; lockTimeoutMs?: number; retryMs?: number }

export async function readStoredRules(options: PathRuleStoreOptions): Promise<RuleSets> {
  try { return parseRules(JSON.parse(await readFile(options.filePath, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStoredRules(); throw error; }
}

export async function transaction<T>(options: PathRuleStoreOptions, operation: (rules: RuleSets) => Promise<T> | T): Promise<T> {
  const lockPath = `${options.filePath}.lock`;
  const temporaryPath = join(dirname(options.filePath), `.${basename(options.filePath)}.${randomUUID()}.tmp`);
  await mkdir(dirname(options.filePath), { recursive: true });
  const deadline = Date.now() + (options.lockTimeoutMs ?? 10_000);
  let locked = false;
  try {
    while (!locked) {
      try { await mkdir(lockPath); await writeFile(join(lockPath, "owner"), `${process.pid} ${hostname()} ${new Date().toISOString()}\n`, { mode: 0o600 }); locked = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error(`Could not acquire path permission lock ${lockPath}; remove it manually if no process owns it.`); await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 25 + Math.random() * 50)); }
    }
    const rules = await readStoredRules(options);
    const result = await operation(rules);
    await writeFile(temporaryPath, `${JSON.stringify(serializeRules(rules), null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, options.filePath);
    return result;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (locked) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function emptyStoredRules(): RuleSets { return { read: { allow: new Set(), deny: new Set() }, write: { allow: new Set(), deny: new Set() } }; }
