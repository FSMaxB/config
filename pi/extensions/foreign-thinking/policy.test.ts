import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONFIG,
  describeState,
  parseConfig,
  rewriteForeignThinking,
  type ThinkingConfig,
} from "./policy.ts";

const kimi = { provider: "kimi-coding", api: "openai-completions", id: "k3" };
const anthropicSonnet = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet" };
const answer: TextContent = { type: "text", text: "done" };
const call: ToolCall = { type: "toolCall", id: "call1", name: "read", arguments: { path: "a" } };
const wrappedPlan: TextContent = {
  type: "text",
  text: '<prior_model_reasoning model="zai/glm-5.3">\nplan\n</prior_model_reasoning>',
};

test("parseConfig without foreignThinking returns the defaults", () => {
  // arrange
  const settings = { theme: "dark" };

  // act
  const parsed = parseConfig(settings);

  // assert
  assert.deepEqual(parsed, { config: DEFAULT_CONFIG, problems: [] });
});

test("parseConfig skips invalid entries and reports each", () => {
  // arrange
  const settings = {
    foreignThinking: {
      default: "loud",
      rules: [{ mode: "keep", to: "a/*" }, { mode: "nope" }, "x", { mode: "drop", from: 3 }],
    },
  };

  // act
  const parsed = parseConfig(settings);

  // assert
  assert.deepEqual(parsed.config, { fallback: "text", rules: [{ mode: "keep", to: "a/*" }] });
  assert.equal(parsed.problems.length, 4);
});

test("parseConfig ignores rules that are not an array", () => {
  // arrange
  const settings = { foreignThinking: { rules: "x" } };

  // act
  const parsed = parseConfig(settings);

  // assert
  assert.deepEqual(parsed.config.rules, []);
  assert.equal(parsed.problems.length, 1);
});

test("a same-model message is unchanged", () => {
  // arrange
  const messages = [assistant("kimi-coding", "openai-completions", "k3", [thinking("plan"), answer])];

  // act
  const result = rewriteForeignThinking(messages, kimi, DEFAULT_CONFIG, undefined);

  // assert
  assert.deepEqual(result, messages);
});

test("text wraps readable thinking and removes encrypted and empty thinking", () => {
  // arrange
  const messages = [glm([thinking("plan"), thinking("secret", { redacted: true }), thinking("  "), answer, call])];

  // act
  const result = rewriteForeignThinking(messages, kimi, DEFAULT_CONFIG, undefined);

  // assert
  assert.deepEqual(contentOf(result[0]), [wrappedPlan, answer, call]);
});

test("drop removes thinking and keeps text and tool calls", () => {
  // arrange
  const config: ThinkingConfig = { fallback: "text", rules: [{ to: "kimi-coding/*", mode: "drop" }] };
  const messages = [glm([thinking("plan"), answer, call])];

  // act
  const result = rewriteForeignThinking(messages, kimi, config, undefined);

  // assert
  assert.deepEqual(contentOf(result[0]), [answer, call]);
});

test("the first matching rule wins and * matches slashes", () => {
  // arrange
  const config: ThinkingConfig = { fallback: "text", rules: [{ from: "zai/*", mode: "drop" }, { from: "lmstudio/*", mode: "drop" }, { mode: "keep" }] };
  const messages = [glm([thinking("plan"), answer]), assistant("lmstudio", "openai-completions", "qwen/qwen3.8-27b", [thinking("idea"), answer])];

  // act
  const result = rewriteForeignThinking(messages, kimi, config, undefined);

  // assert
  assert.deepEqual(contentOf(result[0]), [answer]);
  assert.deepEqual(contentOf(result[1]), [answer]);
});

test("keep within one API takes the target identity and keeps readable thinking", () => {
  // arrange
  const config: ThinkingConfig = { fallback: "text", rules: [{ mode: "keep" }] };
  const messages = [
    assistant("anthropic", "anthropic-messages", "claude-opus", [
      thinking("x", { thinkingSignature: "sig" }),
      thinking("", { thinkingSignature: "enc" }),
      answer,
    ]),
  ];

  // act
  const result = rewriteForeignThinking(messages, anthropicSonnet, config, undefined);

  // assert
  const message = result[0] as AssistantMessage;
  assert.equal(message.provider, "anthropic");
  assert.equal(message.model, "claude-sonnet");
  assert.deepEqual(message.content, [thinking("x", { thinkingSignature: "sig" }), answer]);
});

test("keep across APIs falls back to text", () => {
  // arrange
  const config: ThinkingConfig = { fallback: "text", rules: [{ mode: "keep" }] };
  const messages = [glm([thinking("plan"), answer])];

  // act
  const result = rewriteForeignThinking(messages, anthropicSonnet, config, undefined);

  // assert
  const message = result[0] as AssistantMessage;
  assert.equal(message.provider, "zai");
  assert.equal(message.model, "glm-5.3");
  assert.deepEqual(message.content, [wrappedPlan, answer]);
});

test("keep treats the bridge as the Anthropic Messages API", () => {
  // arrange
  const config: ThinkingConfig = { fallback: "text", rules: [{ mode: "keep" }] };
  const messages = [assistant("pi-claude", "claude-bridge", "claude-opus", [thinking("x", { thinkingSignature: "sig" })])];

  // act
  const result = rewriteForeignThinking(messages, anthropicSonnet, config, undefined);

  // assert
  const message = result[0] as AssistantMessage;
  assert.equal(message.api, "anthropic-messages");
  assert.deepEqual(message.content, [thinking("x", { thinkingSignature: "sig" })]);
});

test("the bridge as target gets the messages unchanged", () => {
  // arrange
  const messages = [glm([thinking("plan"), answer])];

  // act
  const result = rewriteForeignThinking(messages, { provider: "pi-claude", api: "claude-bridge", id: "claude-sonnet" }, DEFAULT_CONFIG, undefined);

  // assert
  assert.equal(result, messages);
});

test("the override ignores the rules", () => {
  // arrange
  const config: ThinkingConfig = { fallback: "text", rules: [{ mode: "keep" }] };
  const messages = [glm([thinking("plan"), answer])];

  // act
  const result = rewriteForeignThinking(messages, kimi, config, "drop");

  // assert
  assert.deepEqual(contentOf(result[0]), [answer]);
});

test("a foreign message without thinking keeps its identity under keep", () => {
  // arrange
  const config: ThinkingConfig = { fallback: "text", rules: [{ mode: "keep" }] };
  const messages = [assistant("zai", "openai-completions", "glm-5.3", [answer])];

  // act
  const result = rewriteForeignThinking(messages, kimi, config, undefined);

  // assert
  assert.deepEqual(result, messages);
});

test("describeState lists the override, default and rules", () => {
  // arrange
  const config: ThinkingConfig = { fallback: "text", rules: [{ to: "kimi-coding/*", mode: "drop" }] };

  // act
  const empty = describeState(DEFAULT_CONFIG, undefined);
  const overridden = describeState(config, "keep");

  // assert
  assert.equal(empty, "Session override: none\nDefault: text\nRules: none");
  assert.equal(overridden, "Session override: keep (rules ignored)\nDefault: text\nRules:\n  1. * → kimi-coding/*: drop");
});

function glm(content: AssistantMessage["content"]): AssistantMessage {
  return assistant("zai", "openai-completions", "glm-5.3", content);
}

function assistant(provider: string, api: string, model: string, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api,
    provider,
    model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

function thinking(text: string, extra: Partial<ThinkingContent> = {}): ThinkingContent {
  return { type: "thinking", thinking: text, ...extra };
}

function contentOf(message: unknown): AssistantMessage["content"] {
  return (message as AssistantMessage).content;
}
