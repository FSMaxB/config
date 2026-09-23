import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { emptyRules, parseRules, serializeRules, type RuleSets } from "./path-permission-rules.ts";

export async function readStoredRules(filePath: string): Promise<RuleSets> {
  try { return parseRules(JSON.parse(await readFile(filePath, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRules(); throw error; }
}

export async function transaction<T>(filePath: string, operation: (rules: RuleSets) => Promise<T> | T): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(dirname(filePath), { recursive: true });
  const deadline = Date.now() + 10_000;
  let locked = false;
  try {
    while (!locked) {
      try { await mkdir(lockPath); await writeFile(join(lockPath, "owner"), `${process.pid} ${hostname()} ${new Date().toISOString()}\n`, { mode: 0o600 }); locked = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error(`Could not acquire path permission lock ${lockPath}; remove it manually if no process owns it.`); await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50)); }
    }
    const rules = await readStoredRules(filePath);
    const result = await operation(rules);
    await writeFile(temporaryPath, `${JSON.stringify(serializeRules(rules), null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
    return result;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (locked) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

