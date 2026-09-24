import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Project } from "./project.ts";

export interface Limits {
  maxJobsPerDay: number;
  maxInputEstimatedTokensPerDay: number;
  maxOutputTokensPerDay: number;
}
export interface Configuration {
  enabled: boolean;
  useMemories: boolean;
  generateMemories: boolean;
  extractionModel?: string;
  consolidationModel?: string;
  limits: Limits;
}
export interface EffectiveConfig {
  config: Configuration;
  origin: "global" | "project";
}
const defaults: Configuration = {
  enabled: false, useMemories: true, generateMemories: true,
  limits: { maxJobsPerDay: 20, maxInputEstimatedTokensPerDay: 200000, maxOutputTokensPerDay: 40000 },
};

export function loadConfiguration(agentDir: string, project: Project): EffectiveConfig {
  assertSafeDirectory(agentDir);
  const global = readJson(join(agentDir, "memory.json"));
  validateKeys(global, ["enabled", "useMemories", "generateMemories", "extractionModel", "consolidationModel", "limits"]);
  const limits = global.limits === undefined ? defaults.limits : validateLimits(global.limits);
  const config = { ...defaults, ...global, limits } as Configuration;
  for (const name of ["enabled", "useMemories", "generateMemories"] as const) {
    if (typeof config[name] !== "boolean") throw new Error(`Invalid memory configuration: ${name}`);
  }
  for (const name of ["extractionModel", "consolidationModel"] as const) {
    if (config[name] !== undefined && (typeof config[name] !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(config[name]))) {
      throw new Error(`Invalid memory configuration: ${name}`);
    }
  }
  const overridePath = projectConfigPath(agentDir, project);
  if (existsSync(dirname(overridePath))) assertSafeDirectory(dirname(overridePath));
  const override = readJson(overridePath);
  if (!existsSync(overridePath)) return { config, origin: "global" };
  validateKeys(override, ["version", "projectRoot", "enabled"]);
  if (override.version !== 1 || override.projectRoot !== project.root || typeof override.enabled !== "boolean") {
    throw new Error("Invalid project memory configuration");
  }
  return { config: { ...config, enabled: override.enabled }, origin: "project" };
}

export function writeProjectActivation(agentDir: string, project: Project, enabled: boolean): void {
  const path = projectConfigPath(agentDir, project);
  assertSafeDirectory(agentDir);
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify({ version: 1, projectRoot: project.root, enabled }) + "\n");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    assertSafePath(path);
    renameSync(temporary, path);
  } catch (error) {
    // A failed rename leaves no partial activation file.
    unlinkSync(temporary);
    throw error;
  }
}

export function ensurePrivateDirectory(path: string): void {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor)) { missing.unshift(ancestor.split(sep).at(-1)!); ancestor = dirname(ancestor); }
  if (!lstatSync(ancestor).isDirectory()) throw new Error("Unsafe memory storage path");
  const absolute = join(realpathSync(ancestor), ...missing);
  const pieces = absolute.split(sep);
  let current = pieces[0] || sep;
  for (const piece of pieces.slice(1)) {
    current = join(current, piece);
    if (existsSync(current)) {
      if (!lstatSync(current).isDirectory()) throw new Error("Unsafe memory storage path");
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
  if ((statSync(absolute).mode & 0o077) !== 0) throw new Error("Memory storage directory is not private");
}

export function assertSafePath(path: string): void {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("Unsafe memory file path");
}

function assertSafeDirectory(path: string): void {
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error("Unsafe memory storage path");
}

function projectConfigPath(agentDir: string, project: Project): string {
  return join(agentDir, "memory-projects", `${project.hash}.json`);
}

function readJson(path: string): Record<string, unknown> {
  assertSafePath(path);
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory configuration");
  return value as Record<string, unknown>;
}

function validateKeys(value: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown memory configuration key: ${key}`);
}

function validateLimits(value: unknown): Limits {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory limits");
  const record = value as Record<string, unknown>;
  validateKeys(record, Object.keys(defaults.limits));
  const limits = { ...defaults.limits, ...record } as Limits;
  for (const number of Object.values(limits)) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid memory limit");
  }
  return limits;
}
