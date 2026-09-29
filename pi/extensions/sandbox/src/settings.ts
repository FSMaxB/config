import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { expandHome } from "../../lib/path-resolution.ts";

export interface SettingsFile {
  network: { allowedDomains: string[]; deniedDomains: string[]; allowUnixSockets: string[]; allowLocalBinding: boolean };
  filesystem: { denyRead: string[]; allowRead: string[] };
}

export interface Settings {
  allowedDomains: string[];
  deniedDomains: string[];
  allowUnixSockets: string[];
  allowLocalBinding: boolean;
  toolchainRead: string[];
  extraDenyRead: string[];
}

const DEFAULT_ALLOWED_DOMAINS = ["github.com", "api.github.com", "*.githubusercontent.com", "registry.npmjs.org", "crates.io", "static.crates.io", "index.crates.io", "pypi.org", "files.pythonhosted.org"];
const DEFAULT_TOOLCHAIN_READ = ["~/.cargo", "~/.rustup", "~/.npm", "~/.nvm", "~/.cache", "~/.local/share/pnpm", "~/.bun", "~/.deno", "~/.pyenv", "~/.nix-profile"];

// A missing file means defaults; a present but invalid one throws so the sandbox fails closed.
export async function loadSettings(filePath: string): Promise<Settings> {
  return resolveSettings(await readSettingsFile(filePath));
}

export function resolveSettings(file: SettingsFile): Settings {
  const { network, filesystem } = file;
  return {
    allowedDomains: unique([...DEFAULT_ALLOWED_DOMAINS, ...network.allowedDomains]),
    deniedDomains: unique(network.deniedDomains),
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
export async function updateDomainLists(filePath: string, mutate: (lists: { allowedDomains: Set<string>; deniedDomains: Set<string> }) => void): Promise<void> {
  await withLock(filePath, async () => {
    const text = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
    const raw = asRecord(JSON.parse(text), "settings");
    const { network } = parseSettingsFile(raw);
    const lists = { allowedDomains: new Set(network.allowedDomains), deniedDomains: new Set(network.deniedDomains) };
    mutate(lists);
    const updated = { ...raw, network: { ...asRecord(raw.network ?? {}, "network"), allowedDomains: [...lists.allowedDomains], deniedDomains: [...lists.deniedDomains] } };
    await writeAtomically(filePath, `${JSON.stringify(updated, null, 2)}\n`);
  });
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

function boolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
