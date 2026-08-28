import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { guidanceTable, type SubagentModelConfig } from "./model-policy.ts";

test("guidanceTable only lists models allowed for an OpenAI session", () => {
  // arrange
  const config: SubagentModelConfig = {
    localProviders: ["lmstudio"],
    models: [
      { match: "gpt-*", guidance: "OpenAI default" },
      { match: "claude-haiku-*", guidance: "cheap Claude model" },
      { match: "*qwen3-coder-next*", guidance: "strongest local option" },
    ],
  };
  const mainModel = createModel("openai", "gpt-5");
  const availableModels = [
    mainModel,
    createModel("anthropic", "claude-haiku-4-5"),
    createModel("lmstudio", "qwen3-coder-next"),
  ];

  // act
  const guidance = guidanceTable({ mainModel, availableModels, config });

  // assert
  assert.match(guidance, /openai\/gpt-5: OpenAI default/);
  assert.match(guidance, /lmstudio\/qwen3-coder-next: strongest local option/);
  assert.doesNotMatch(guidance, /claude-haiku/);
});

test("guidanceTable keeps models in the configured provider family", () => {
  // arrange
  const config: SubagentModelConfig = {
    providerGroups: [["claude-bridge", "anthropic"]],
    models: [
      { match: "claude-haiku-*", guidance: "cheap Claude model" },
      { match: "claude-sonnet-*", guidance: "mid-tier Claude model" },
      { match: "gpt-*", guidance: "OpenAI default" },
    ],
  };
  const mainModel = createModel("claude-bridge", "claude-sonnet-4");
  const availableModels = [
    mainModel,
    createModel("anthropic", "claude-haiku-4-5"),
    createModel("openai", "gpt-5"),
  ];

  // act
  const guidance = guidanceTable({ mainModel, availableModels, config });

  // assert
  assert.match(guidance, /claude-bridge\/claude-sonnet-4: mid-tier Claude model/);
  assert.match(guidance, /anthropic\/claude-haiku-4-5: cheap Claude model/);
  assert.doesNotMatch(guidance, /openai\/gpt-5/);
});

test("guidanceTable is empty when no allowed model has guidance", () => {
  // arrange
  const config: SubagentModelConfig = {
    models: [{ match: "claude-*", guidance: "Claude only" }],
  };
  const mainModel = createModel("openai", "gpt-5");
  const availableModels = [mainModel];

  // act
  const guidance = guidanceTable({ mainModel, availableModels, config });

  // assert
  assert.equal(guidance, "");
});

function createModel(provider: string, id: string, baseUrl = `https://${provider}.example.com`): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  } as Model<Api>;
}
