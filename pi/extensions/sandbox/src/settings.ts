import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { expandHome } from "../../lib/path-resolution.ts";
import { parseActivationDecisions, parseProfileDefinition, parseProfiles, serializeActivationDecisions } from "./profiles.ts";
import type { ActivationDecisions, Profile, ProfileDefinition } from "./profiles.ts";

export interface SettingsFile {
  network: { allowedDomains: string[]; deniedDomains: string[]; deniedDomainReasons: Record<string, string>; allowUnixSockets: string[]; allowLocalBinding: boolean };
  filesystem: { denyRead: string[]; allowRead: string[] };
}

export interface Settings {
  allowedDomains: string[];
  deniedDomains: string[];
  // The user's reasons for denied domains, keyed by exact host or host:port, repeated to the agent on a denial.
  deniedDomainReasons: ReadonlyMap<string, string>;
  allowUnixSockets: string[];
  allowLocalBinding: boolean;
  toolchainRead: string[];
  extraDenyRead: string[];
}

const DEFAULT_ALLOWED_DOMAINS = ["github.com", "api.github.com", "*.githubusercontent.com", "registry.npmjs.org", "crates.io", "static.crates.io", "index.crates.io", "pypi.org", "files.pythonhosted.org"];
// Besides toolchains this holds config that git, jj and CFNetwork clients (curl) read on startup;
// denying it makes them warn or fail even though nothing secret lives there.
const DEFAULT_TOOLCHAIN_READ = [
  "~/.cargo", "~/.rustup", "~/.npm", "~/.nvm", "~/.cache", "~/.local/share/pnpm", "~/.bun", "~/.deno", "~/.pyenv", "~/.nix-profile",
  "~/.gitconfig", "~/.gitignore_global", "~/.config/git", "~/.config/jj",
  "~/Library/Preferences/.GlobalPreferences*", "~/Library/Preferences/ByHost/.GlobalPreferences*",
  // .shellrc-common puts these on PATH, and they run from any repository.
  "~/config/scripts",
];

// A missing file means defaults; a present but invalid one throws so the sandbox fails closed.
export async function loadSettings(filePath: string): Promise<Settings> {
  return resolveSettings(await readSettingsFile(filePath));
}

export function resolveSettings(file: SettingsFile): Settings {
  const { network, filesystem } = file;
  return {
    allowedDomains: unique([...DEFAULT_ALLOWED_DOMAINS, ...network.allowedDomains]),
    deniedDomains: unique(network.deniedDomains),
    deniedDomainReasons: new Map(Object.entries(network.deniedDomainReasons)),
    allowUnixSockets: network.allowUnixSockets.map(expandHome),
    allowLocalBinding: network.allowLocalBinding,
    toolchainRead: unique([...DEFAULT_TOOLCHAIN_READ, ...filesystem.allowRead].map(expandHome)),
    extraDenyRead: filesystem.denyRead.map(expandHome),
  };
}

export async function readSettingsFile(filePath: string): Promise<SettingsFile> {
  const text = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return parseSettingsFile({});
  try {
    return parseSettingsFile(JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid sandbox settings in ${filePath}: ${(error as Error).message}`);
  }
}

export function parseSettingsFile(value: unknown): SettingsFile {
  const root = asRecord(value, "settings");
  const network = asRecord(root.network ?? {}, "network");
  const filesystem = asRecord(root.filesystem ?? {}, "filesystem");
  return {
    network: {
      allowedDomains: stringArray(network.allowedDomains, "network.allowedDomains"),
      deniedDomains: stringArray(network.deniedDomains, "network.deniedDomains"),
      deniedDomainReasons: stringRecord(network.deniedDomainReasons, "network.deniedDomainReasons"),
      allowUnixSockets: stringArray(network.allowUnixSockets, "network.allowUnixSockets"),
      allowLocalBinding: boolean(network.allowLocalBinding, "network.allowLocalBinding"),
    },
    filesystem: {
      denyRead: stringArray(filesystem.denyRead, "filesystem.denyRead"),
      allowRead: stringArray(filesystem.allowRead, "filesystem.allowRead"),
    },
  };
}

// Rewrites only the network domain lists and keeps every other key of the file as the user wrote it.
export async function updateDomainLists(filePath: string, mutate: (lists: DomainLists) => void): Promise<void> {
  await rewriteSettings(filePath, (raw) => {
    const { network } = parseSettingsFile(raw);
    const lists: DomainLists = {
      allowedDomains: new Set(network.allowedDomains),
      deniedDomains: new Set(network.deniedDomains),
      deniedDomainReasons: new Map(Object.entries(network.deniedDomainReasons)),
    };
    mutate(lists);
    const rawNetwork = asRecord(raw.network ?? {}, "network");
    // The reasons key stays out of files that never had one.
    const reasons = lists.deniedDomainReasons.size > 0 || "deniedDomainReasons" in rawNetwork ? { deniedDomainReasons: Object.fromEntries(lists.deniedDomainReasons) } : {};
    return { ...raw, network: { ...rawNetwork, allowedDomains: [...lists.allowedDomains], deniedDomains: [...lists.deniedDomains], ...reasons } };
  });
}

// Profiles are read on every call, so hand edits apply without a restart.
export async function loadProfiles(filePath: string): Promise<Profile[]> {
  return parseProfiles((await readRawSettings(filePath)).profiles);
}

// Rewrites only profiles.<name>; returning undefined deletes it, together with its activation decision.
export async function updateProfile(filePath: string, name: string, mutate: (current: ProfileDefinition | undefined) => ProfileDefinition | undefined): Promise<void> {
  await rewriteSettings(filePath, (raw) => {
    const profiles = asRecord(raw.profiles ?? {}, "profiles");
    const current = name in profiles ? parseProfileDefinition(profiles[name], name) : undefined;
    const updated = mutate(current);
    if (updated === undefined) {
      const { [name]: _removed, ...remaining } = profiles;
      return withoutActivation({ ...raw, profiles: remaining }, name);
    }
    return { ...raw, profiles: { ...profiles, [name]: parseProfileDefinition(updated, name) } };
  });
}

export async function loadActivationDecisions(filePath: string): Promise<ActivationDecisions> {
  return parseActivationDecisions((await readRawSettings(filePath)).profileActivation);
}

// Rewrites only profileActivation. The key is written once a decision exists, and stays out of files that never had one.
export async function updateActivationDecisions(filePath: string, mutate: (decisions: ActivationDecisions) => void): Promise<void> {
  await rewriteSettings(filePath, (raw) => {
    const decisions = parseActivationDecisions(raw.profileActivation);
    mutate(decisions);
    if (decisions.allowed.size === 0 && decisions.denied.size === 0 && !("profileActivation" in raw)) return raw;
    return { ...raw, profileActivation: serializeActivationDecisions(decisions) };
  });
}

async function readRawSettings(filePath: string): Promise<Record<string, unknown>> {
  const text = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  try {
    return asRecord(JSON.parse(text), "settings");
  } catch (error) {
    throw new Error(`Invalid sandbox settings in ${filePath}: ${(error as Error).message}`);
  }
}

async function rewriteSettings(filePath: string, mutate: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await withLock(filePath, async () => {
    const raw = await readRawSettings(filePath);
    await writeAtomically(filePath, `${JSON.stringify(mutate(raw), null, 2)}\n`);
  });
}

function withoutActivation(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!("profileActivation" in raw)) return raw;
  const decisions = parseActivationDecisions(raw.profileActivation);
  decisions.allowed.delete(name);
  decisions.denied.delete(name);
  return { ...raw, profileActivation: serializeActivationDecisions(decisions) };
}

interface DomainLists {
  allowedDomains: Set<string>;
  deniedDomains: Set<string>;
  deniedDomainReasons: Map<string, string>;
}

async function withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (let locked = false; !locked;) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner"), `${process.pid} ${hostname()} ${new Date().toISOString()}\n`, { mode: 0o600 });
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error(`Could not acquire sandbox settings lock ${lockPath}; remove it manually if no process owns it.`);
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${name} must be an array of strings`);
  return value;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value, name);
  if (!Object.values(record).every((entry) => typeof entry === "string")) throw new Error(`${name} must be an object of strings`);
  return record as Record<string, string>;
}

function boolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
