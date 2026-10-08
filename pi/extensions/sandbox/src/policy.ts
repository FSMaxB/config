import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import type { EffectivePolicy } from "../../lib/path-permissions.ts";
import { exact, type PathSelector } from "../../lib/path-permission-rules.ts";
import { contains } from "../../lib/repo.ts";

export interface PolicyOptions {
  platform: "darwin" | "linux";
  homeDirectory: string;
  toolchainRead: string[];
  extraDenyRead: string[];
}

export function filesystemConfig(policy: EffectivePolicy, options: PolicyOptions): FilesystemConfig {
  const { platform, homeDirectory, toolchainRead, extraDenyRead } = options;
  const secrets = secretPaths(homeDirectory);
  const keepsSecretsDenied = (selector: PathSelector) => !secrets.some((secret) => mayExposeSecret(selector, secret));
  return {
    denyRead: unique([...userRoots(platform), homeDirectory, ...secrets, ...extraDenyRead, ...policy.read.deny.map(selectorPath)]),
    allowRead: unique([
      ...policy.read.allow.filter(keepsSecretsDenied).map(selectorPath),
      ...toolchainRead.filter((path) => keepsSecretsDenied(exact(path))),
      sandboxRuntimeDirectory(),
    ]),
    allowWrite: unique(policy.write.allow.filter((selector) => platform === "darwin" || selector.kind !== "glob").filter(keepsSecretsDenied).map(selectorPath)),
    denyWrite: unique([...secrets, ...[...policy.write.deny, ...policy.write.protected].map((selector) => writeDenyPath(selector, platform))]),
  };
}

export function secretPaths(homeDirectory: string): string[] {
  const relativePaths = [
    ".ssh", ".aws", ".gnupg", ".netrc", ".npmrc", ".config/gh", ".docker/config.json", ".kube", ".cargo/credentials.toml",
    ".pi/agent/auth.json", ".pi/agent/models.json", ".pi/agent/claude-bridge.json", ".claude/.credentials.json", "Library/Keychains",
  ];
  return relativePaths.map((relativePath) => join(homeDirectory, relativePath));
}

// srt lets an allow at or under a deny win, and a glob allow beat a literal deny: macOS re-applies a literal
// deny only beneath a literal allow, Linux expands the glob and binds every match back in. Literal allows
// strictly above a secret are safe on both, because the deeper deny is applied after them.
function mayExposeSecret(selector: PathSelector, secret: string): boolean {
  const root = selector.kind === "glob" ? selector.base : selector.path;
  if (contains(secret, root)) return true;
  if (selector.kind !== "glob" || !contains(root, secret)) return false;
  return globMayReach(selector.pattern.split("/"), relative(root, secret).split(sep));
}

// srt's glob semantics: no dotfile exception, `*` and `?` stay within a segment, `**` crosses any number.
// A match that ends above the secret only exposes that directory entry, not the secret beneath it.
function globMayReach(patternSegments: string[], secretSegments: string[]): boolean {
  const [segment, ...remainingSecret] = secretSegments;
  const [pattern, ...remainingPattern] = patternSegments;
  if (segment === undefined) return true;
  if (pattern === undefined) return false;
  if (pattern.includes("**")) return true;
  return segmentRegex(pattern).test(segment) && globMayReach(remainingPattern, remainingSecret);
}

function segmentRegex(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replaceAll("[!", "[^")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]");
  // An unparsable class counts as matching everything, so the grant is dropped rather than trusted.
  try { return new RegExp(`^${source}$`); } catch { return /(?:)/; }
}

// On Linux srt execs its vendored apply-seccomp helper from inside the outer bubblewrap namespace, so the
// package has to stay readable even when it lives under a denied tree such as $HOME.
function sandboxRuntimeDirectory(): string {
  return fileURLToPath(new URL("../node_modules/@anthropic-ai/sandbox-runtime", import.meta.url));
}

function userRoots(platform: PolicyOptions["platform"]): string[] {
  return platform === "darwin" ? ["/Users", "/Volumes"] : ["/home", "/root", "/mnt", "/media"];
}

// srt drops write globs on Linux; a dropped deny would widen access, so deny the glob's base tree instead.
function writeDenyPath(selector: PathSelector, platform: PolicyOptions["platform"]): string {
  if (selector.kind === "glob" && platform === "linux") return selector.base;
  return selectorPath(selector);
}

function selectorPath(selector: PathSelector): string {
  return selector.kind === "glob" ? `${selector.base}/${selector.pattern}` : selector.path;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
