/**
 * Agent discovery and configuration
 */

import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
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

export function discoverAgents(): { agents: AgentConfig[]; skipped: string[] } {
  // Agents ship next to this extension so the whole setup lives in the config repo.
  const agentsDirectory = join(dirname(fileURLToPath(import.meta.url)), "agents");
  return loadAgentsFromDirectory(agentsDirectory);
}

function loadAgentsFromDirectory(directory: string): { agents: AgentConfig[]; skipped: string[] } {
  const pairs: { file: string; agent: AgentConfig }[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return dropDuplicateNames(pairs);
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    let content: string;
    try {
      content = readFileSync(join(directory, entry.name), "utf-8");
    } catch {
      continue;
    }

    // A real YAML parser runs here, so any scalar or collection can appear in each value.
    const { frontmatter, body } = parseFrontmatter(content);

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
