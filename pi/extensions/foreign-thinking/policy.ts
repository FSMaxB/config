import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import { isRecord } from "../lib/untyped.ts";
import { matchesWildcard } from "../lib/wildcard.ts";

export const ThinkingMode = {
  Drop: "drop",
  Text: "text",
  Keep: "keep",
} as const;
export type ThinkingMode = (typeof ThinkingMode)[keyof typeof ThinkingMode];

export interface ThinkingRule { from?: string; to?: string; mode: ThinkingMode }
export interface ThinkingConfig { fallback: ThinkingMode; rules: ThinkingRule[] }
export interface ParsedConfig { config: ThinkingConfig; problems: string[] }
export interface TargetModel { provider: string; api: string; id: string }

const BRIDGE_PROVIDER = "pi-claude";
const BRIDGE_API = "claude-bridge";
const ANTHROPIC_MESSAGES_API = "anthropic-messages";
export const DEFAULT_CONFIG: ThinkingConfig = { fallback: ThinkingMode.Text, rules: [] };

export function parseConfig(settings: object): ParsedConfig {
  const foreignThinking: unknown = Reflect.get(settings, "foreignThinking");
  if (foreignThinking === undefined) return { config: DEFAULT_CONFIG, problems: [] };
  if (!isRecord(foreignThinking)) {
    return { config: DEFAULT_CONFIG, problems: ["foreignThinking must be an object; using the defaults"] };
  }
  const problems: string[] = [];
  return {
    config: {
      fallback: parseFallback(foreignThinking.default, problems),
      rules: parseRules(foreignThinking.rules, problems),
    },
    problems,
  };
}

/**
 * The bridge is never a target: it converts thinking itself, and rewriting its
 * input would change its conversation fingerprint and discard the prompt cache.
 */
export function rewriteForeignThinking(
  messages: AgentMessage[],
  target: TargetModel,
  config: ThinkingConfig,
  override: ThinkingMode | undefined,
): AgentMessage[] {
  if (target.provider === BRIDGE_PROVIDER) return messages;
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (isSameModel(message, target)) return message;
    if (!message.content.some((block) => block.type === "thinking")) return message;
    return rewriteMessage(message, target, override ?? resolveMode(config, message, target));
  });
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return Object.values(ThinkingMode).some((mode) => mode === value);
}

const MODE_LIST = Object.values(ThinkingMode).join(", ");

export function describeState(config: ThinkingConfig, override: ThinkingMode | undefined): string {
  const rules = config.rules.length === 0
    ? ["Rules: none"]
    : ["Rules:", ...config.rules.map((rule, index) => `  ${index + 1}. ${rule.from ?? "*"} → ${rule.to ?? "*"}: ${rule.mode}`)];
  return [
    `Session override: ${override === undefined ? "none" : `${override} (rules ignored)`}`,
    `Default: ${config.fallback}`,
    ...rules,
  ].join("\n");
}

function parseFallback(value: unknown, problems: string[]): ThinkingMode {
  if (value === undefined) return ThinkingMode.Text;
  if (isThinkingMode(value)) return value;
  problems.push(`foreignThinking.default must be one of ${MODE_LIST}; using ${ThinkingMode.Text}`);
  return ThinkingMode.Text;
}

function parseRules(value: unknown, problems: string[]): ThinkingRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push("foreignThinking.rules must be an array; ignoring it");
    return [];
  }
  const rules: ThinkingRule[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseRule(entry);
    if (!parsed.ok) {
      problems.push(`foreignThinking.rules[${index}] ignored: ${parsed.error}`);
      continue;
    }
    rules.push(parsed.rule);
  }
  return rules;
}

function parseRule(entry: unknown): { ok: true; rule: ThinkingRule } | { ok: false; error: string } {
  if (!isRecord(entry)) return { ok: false, error: "not an object" };
  const { from, to, mode } = entry;
  if (!isThinkingMode(mode)) return { ok: false, error: `mode must be one of ${MODE_LIST}` };
  if ((from !== undefined && typeof from !== "string") || (to !== undefined && typeof to !== "string")) {
    return { ok: false, error: "from and to must be strings" };
  }
  return { ok: true, rule: { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), mode } };
}

function isSameModel(message: AssistantMessage, target: TargetModel): boolean {
  return message.provider === target.provider && message.api === target.api && message.model === target.id;
}

function resolveMode(config: ThinkingConfig, message: AssistantMessage, target: TargetModel): ThinkingMode {
  const source = `${message.provider}/${message.model}`;
  const destination = `${target.provider}/${target.id}`;
  const rule = config.rules.find((rule) => matches(rule.from, source) && matches(rule.to, destination));
  return rule?.mode ?? config.fallback;
}

function rewriteMessage(message: AssistantMessage, target: TargetModel, mode: ThinkingMode): AssistantMessage {
  switch (mode) {
    case ThinkingMode.Drop:
      return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
    case ThinkingMode.Text:
      return {
        ...message,
        content: message.content.flatMap((block) => (block.type === "thinking" ? thinkingAsText(block, message) : [block])),
      };
    case ThinkingMode.Keep:
      return keepThinking(message, target);
  }
}

/** Signatures and replay formats are API-specific, so keeping only works within one API family. */
function keepThinking(message: AssistantMessage, target: TargetModel): AssistantMessage {
  if (apiFamily(message.api) !== apiFamily(target.api)) return rewriteMessage(message, target, ThinkingMode.Text);
  return {
    ...message,
    provider: target.provider,
    api: target.api,
    model: target.id,
    content: message.content.filter((block) => block.type !== "thinking" || isReadable(block)),
  };
}

function thinkingAsText(block: ThinkingContent, message: AssistantMessage): TextContent[] {
  if (!isReadable(block)) return [];
  return [{
    type: "text",
    text: `<prior_model_reasoning model="${message.provider}/${message.model}">\n${block.thinking.trim()}\n</prior_model_reasoning>`,
  }];
}

function isReadable(block: ThinkingContent): boolean {
  return block.redacted !== true && block.thinking.trim() !== "";
}

/** The bridge talks the Anthropic Messages API underneath. */
function apiFamily(api: string): string {
  return api === BRIDGE_API ? ANTHROPIC_MESSAGES_API : api;
}

function matches(pattern: string | undefined, value: string): boolean {
  return pattern === undefined || matchesWildcard(pattern, value);
}
