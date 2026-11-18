import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode, errorMessage } from "../../lib/errors.ts";
import { withFileLock } from "../../lib/file-lock.ts";
import { writeJsonFileAtomically } from "../../lib/json.ts";
import { expandHome } from "../../lib/path-resolution.ts";
import { sandboxProfilesDirectory } from "../../lib/sandbox-state.ts";
import { parseActivationDecisions, serializeActivationDecisions } from "./profiles.ts";
import type { ActivationDecisions } from "./profiles.ts";
import { booleanValue, requireRecord, stringArray, stringRecord, unique } from "./settings-values.ts";

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
    allowUnixSockets: network.allowUnixSockets.map((path) => expandHome(path)),
    allowLocalBinding: network.allowLocalBinding,
    toolchainRead: unique([...DEFAULT_TOOLCHAIN_READ, ...filesystem.allowRead].map((path) => expandHome(path))),
    extraDenyRead: filesystem.denyRead.map((path) => expandHome(path)),
  };
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

export async function readSettingsFile(filePath: string): Promise<SettingsFile> {
  const raw = await readRawSettings(filePath);
  try {
    return parseSettingsFile(raw);
  } catch (error) {
    throw new Error(`Invalid sandbox settings in ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
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
    const rawNetwork = requireRecord(raw.network ?? {}, "network");
    // The reasons key stays out of files that never had one.
    const reasons = lists.deniedDomainReasons.size > 0 || "deniedDomainReasons" in rawNetwork ? { deniedDomainReasons: Object.fromEntries(lists.deniedDomainReasons) } : {};
    return { ...raw, network: { ...rawNetwork, allowedDomains: [...lists.allowedDomains], deniedDomains: [...lists.deniedDomains], ...reasons } };
  });
}

export function parseSettingsFile(value: unknown): SettingsFile {
  const root = requireRecord(value, "settings");
  const network = requireRecord(root.network ?? {}, "network");
  const filesystem = requireRecord(root.filesystem ?? {}, "filesystem");
  return {
    network: {
      allowedDomains: stringArray(network.allowedDomains, "network.allowedDomains"),
      deniedDomains: stringArray(network.deniedDomains, "network.deniedDomains"),
      deniedDomainReasons: stringRecord(network.deniedDomainReasons, "network.deniedDomainReasons"),
      allowUnixSockets: stringArray(network.allowUnixSockets, "network.allowUnixSockets"),
      allowLocalBinding: booleanValue(network.allowLocalBinding, "network.allowLocalBinding"),
    },
    filesystem: {
      denyRead: stringArray(filesystem.denyRead, "filesystem.denyRead"),
      allowRead: stringArray(filesystem.allowRead, "filesystem.allowRead"),
    },
  };
}

export interface SettingsFile {
  network: { allowedDomains: string[]; deniedDomains: string[]; deniedDomainReasons: Record<string, string>; allowUnixSockets: string[]; allowLocalBinding: boolean };
  filesystem: { denyRead: string[]; allowRead: string[] };
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

async function rewriteSettings(filePath: string, mutate: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await withFileLock(filePath, "sandbox settings", async () => {
    const raw = await readRawSettings(filePath);
    await writeJsonFileAtomically(filePath, mutate(raw));
  });
}

async function readRawSettings(filePath: string): Promise<Record<string, unknown>> {
  const text = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return "{}";
    throw error;
  });
  try {
    const raw = requireRecord(JSON.parse(text), "settings");
    if ("profiles" in raw) throw new Error(`profiles is not read from here: put each profiles.<name> object into ${sandboxProfilesDirectory(dirname(filePath))}/<name>.json, then delete the profiles key`);
    return raw;
  } catch (error) {
    throw new Error(`Invalid sandbox settings in ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
}

interface DomainLists {
  allowedDomains: Set<string>;
  deniedDomains: Set<string>;
  deniedDomainReasons: Map<string, string>;
}
