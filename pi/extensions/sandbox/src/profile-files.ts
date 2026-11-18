import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorCode, errorMessage } from "../../lib/errors.ts";
import { withFileLock } from "../../lib/file-lock.ts";
import { writeJsonFileAtomically } from "../../lib/json.ts";
import { PROFILE_NAME_RULE, isValidProfileName, parseProfileDefinition } from "./profiles.ts";
import type { Profile, ProfileDefinition } from "./profiles.ts";

// Selects profile files and leaves out the lock directories and temporary files of the writers.
const PROFILE_FILE_SUFFIX = ".json";

// Read on every bash call, so hand edits apply without a restart. A missing directory means no
// profiles; an invalid file throws, so the sandbox fails closed.
export async function loadProfiles(directory: string): Promise<Profile[]> {
  const fileNames = await readdir(directory).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  const names = fileNames
    .filter((fileName) => fileName.endsWith(PROFILE_FILE_SUFFIX))
    .map((fileName) => fileName.slice(0, -PROFILE_FILE_SUFFIX.length))
    .sort();
  const profiles = await Promise.all(names.map(async (name) => {
    const definition = await readProfile(directory, name);
    // A file deleted between readdir and readFile is a profile that no longer exists.
    return definition === undefined ? [] : [{ name, ...definition }];
  }));
  return profiles.flat();
}

// Returning undefined deletes the profile's file.
export async function updateProfile(directory: string, name: string, mutate: (current: ProfileDefinition | undefined) => ProfileDefinition | undefined): Promise<void> {
  const filePath = profileFilePath(directory, name);
  await withFileLock(filePath, "sandbox profile", async () => {
    const updated = mutate(await readProfile(directory, name));
    if (updated === undefined) {
      await rm(filePath, { force: true });
      return;
    }
    await writeJsonFileAtomically(filePath, parseProfileDefinition(updated));
  });
}

async function readProfile(directory: string, name: string): Promise<ProfileDefinition | undefined> {
  const filePath = profileFilePath(directory, name);
  const text = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parseProfileDefinition(parsed);
  } catch (error) {
    throw new Error(`Invalid sandbox profile in ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
}

// The name becomes a file name, so it is checked before it reaches the file system.
function profileFilePath(directory: string, name: string): string {
  const filePath = join(directory, `${name}${PROFILE_FILE_SUFFIX}`);
  if (!isValidProfileName(name)) throw new Error(`Invalid sandbox profile file name ${filePath}: ${PROFILE_NAME_RULE}.`);
  return filePath;
}
