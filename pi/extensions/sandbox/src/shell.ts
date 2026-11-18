import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Bash before 5.1 writes every here-document to a temp file and ignores $TMPDIR for it (3.2 tries /var/tmp, /tmp,
// /usr/tmp, then the current directory), none of which the sandbox lets it write. 5.1 sends small ones through a
// pipe and puts larger ones under $TMPDIR.
const MINIMUM_VERSION: BashVersion = { major: 5, minor: 1 };

// Homebrew's locations, for a pi started without Homebrew on PATH (e.g. from a GUI launcher).
const WELL_KNOWN_SHELLS = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"];

// `bash --version` answers in milliseconds; this only bounds a broken binary.
const PROBE_TIMEOUT_MILLISECONDS = 2000;

export interface BashVersion {
  major: number;
  minor: number;
}

export interface ProbedShell {
  path: string;
  version: BashVersion | undefined;
}

export type ShellChoice =
  | { kind: "found"; path: string }
  | { kind: "missing"; checked: string[] };

export async function resolveSandboxShell(environmentPath: string | undefined): Promise<ShellChoice> {
  const candidates = shellCandidates(environmentPath);
  const probed: ProbedShell[] = [];
  for (const path of candidates) {
    const shell = { path, version: await bashVersion(path) };
    probed.push(shell);
    if (isSupported(shell.version)) break;
  }
  return chooseShell(probed);
}

export function shellCandidates(environmentPath: string | undefined): string[] {
  const onPath = (environmentPath ?? "")
    .split(delimiter)
    .filter((directory) => directory !== "")
    .map((directory) => join(directory, "bash"));
  return [...new Set([...onPath, ...WELL_KNOWN_SHELLS])];
}

export function chooseShell(probed: readonly ProbedShell[]): ShellChoice {
  const supported = probed.find(({ version }) => isSupported(version));
  return supported ? { kind: "found", path: supported.path } : { kind: "missing", checked: probed.map(({ path }) => path) };
}

// Output of `echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"`.
export function parseBashVersion(output: string): BashVersion | undefined {
  const match = /^(\d+)\.(\d+)\s*$/.exec(output);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

function isSupported(version: BashVersion | undefined): boolean {
  if (!version) return false;
  return version.major > MINIMUM_VERSION.major || (version.major === MINIMUM_VERSION.major && version.minor >= MINIMUM_VERSION.minor);
}

// A missing, non-executable or non-bash candidate yields undefined.
async function bashVersion(path: string): Promise<BashVersion | undefined> {
  try {
    await access(path, constants.X_OK);
    const { stdout } = await execFileAsync(path, ["-c", 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { timeout: PROBE_TIMEOUT_MILLISECONDS });
    return parseBashVersion(stdout);
  } catch {
    return undefined;
  }
}
