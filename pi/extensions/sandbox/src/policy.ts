import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import type { EffectivePolicy } from "../../lib/path-permissions.ts";
import type { PathSelector } from "../../lib/path-permission-rules.ts";

export interface PolicyOptions {
  platform: "darwin" | "linux";
  homeDirectory: string;
  toolchainRead: string[];
  extraDenyRead: string[];
}

export function filesystemConfig(policy: EffectivePolicy, options: PolicyOptions): FilesystemConfig {
  const { platform, homeDirectory, toolchainRead, extraDenyRead } = options;
  const secrets = secretPaths(homeDirectory);
  return {
    denyRead: unique([...userRoots(platform), homeDirectory, ...secrets, ...extraDenyRead, ...policy.read.deny.map(selectorPath)]),
    allowRead: unique([...policy.read.allow.map(selectorPath), ...toolchainRead, sandboxRuntimeDirectory()]),
    allowWrite: unique(policy.write.allow.filter((selector) => platform === "darwin" || selector.kind !== "glob").map(selectorPath)),
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
