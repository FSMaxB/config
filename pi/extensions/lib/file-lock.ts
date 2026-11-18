import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { errorCode } from "./errors.ts";
import { OWNER_ONLY_FILE_MODE } from "./json.ts";

// Long enough for any other pi process to finish its read-modify-write of a small JSON file.
const LOCK_TIMEOUT_MILLISECONDS = 10_000;
// A short, randomized backoff keeps concurrent waiters from retrying in lockstep.
const RETRY_BASE_MILLISECONDS = 25;
const RETRY_JITTER_MILLISECONDS = 50;

// Runs the operation while holding `<file>.lock`, a directory that mkdir creates atomically, so
// separate pi processes never interleave their changes to one file. The owner file inside names
// the process, for removing a stale lock by hand.
export async function withFileLock<T>(filePath: string, description: string, operation: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true });
  const deadline = now() + LOCK_TIMEOUT_MILLISECONDS;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || now() >= deadline) {
        throw new Error(`Could not acquire ${description} lock ${lockPath}; remove it manually if no process owns it.`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MILLISECONDS + Math.random() * RETRY_JITTER_MILLISECONDS));
    }
  }
  try {
    await writeFile(join(lockPath, "owner"), `${process.pid} ${hostname()} ${new Date(now()).toISOString()}\n`, { mode: OWNER_ONLY_FILE_MODE });
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}
