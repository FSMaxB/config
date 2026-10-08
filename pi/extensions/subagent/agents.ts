/**
 * Agent discovery and configuration
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { dropDuplicateNames } from "./agent-names.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  systemPrompt: string;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
};

export function discoverAgents(): { agents: AgentConfig[]; skipped: string[] } {
  // Agents ship next to this extension so the whole setup lives in the config repo.
  const userDir = join(dirname(fileURLToPath(import.meta.url)), "agents");
  return loadAgentsFromDir(userDir);
}

function loadAgentsFromDir(dir: string): { agents: AgentConfig[]; skipped: string[] } {
  const pairs: { file: string; agent: AgentConfig }[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return dropDuplicateNames(pairs);
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    let content: string;
    try {
      content = readFileSync(join(dir, entry.name), "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
      continue;
    }

    pairs.push({
      file: entry.name,
      agent: {
        name: frontmatter.name,
        description: frontmatter.description,
        tools: parseToolList(frontmatter.tools),
        model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
        thinkingLevel: parseThinkingLevel(frontmatter.thinkingLevel),
        systemPrompt: body,
      },
    });
  }

  return dropDuplicateNames(pairs);
}

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 || (Array.isArray(value) && value.length === 0) ? tools : undefined;
}

// Lenient like parseToolList: a bad value must not take down the whole agent file.
function parseThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
  return THINKING_LEVELS.find((level) => level === value);
}
