import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { crossProviderTargets, guidanceTable, resolveSubagentModel } from "./model-policy.ts";
import type { ProviderVerdict, SubagentModelConfig } from "./model-policy.ts";

test("guidanceTable lists other providers under their own heading", () => {
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
  const heading = guidance.indexOf("Other providers (");
  assert.match(guidance, /openai\/gpt-5: OpenAI default/);
  assert.match(guidance, /lmstudio\/qwen3-coder-next: strongest local option/);
  assert.ok(heading > guidance.indexOf("openai/gpt-5"));
  assert.ok(heading > guidance.indexOf("lmstudio/qwen3-coder-next"));
  assert.ok(guidance.indexOf("anthropic/claude-haiku-4-5") > heading);
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
  assert.ok(guidance.indexOf("openai/gpt-5") > guidance.indexOf("Other providers ("));
  assert.ok(guidance.indexOf("anthropic/claude-haiku-4-5") < guidance.indexOf("Other providers ("));
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

test("a cross-provider model without a verdict is rejected and the error names the flag", () => {
  // arrange
  const mainModel = createModel("anthropic", "claude-sonnet-4");
  const target = createModel("openai", "gpt-5");

  // act
  const resolution = resolveSubagentModel({
    requested: "openai/gpt-5",
    mainModel,
    availableModels: [mainModel, target],
    config: {},
    providerVerdicts: new Map(),
  });

  // assert
  assert.equal(resolution.ok, false);
  assert.match(resolution.error, /crossProvider: true/);
});

test("an allow verdict for the provider resolves the model", () => {
  // arrange
  const mainModel = createModel("anthropic", "claude-sonnet-4");
  const target = createModel("openai", "gpt-5");
  const providerVerdicts = new Map<string, ProviderVerdict>([["openai", { kind: "allow" }]]);

  // act
  const resolution = resolveSubagentModel({
    requested: "openai/gpt-5",
    mainModel,
    availableModels: [mainModel, target],
    config: {},
    providerVerdicts,
  });

  // assert
  assert.deepEqual(resolution, { ok: true, model: target });
});

test("a deny verdict gives its reason and says not to retry", () => {
  // arrange
  const mainModel = createModel("anthropic", "claude-sonnet-4");
  const target = createModel("openai", "gpt-5");
  const reason = "The user denied subagents on provider openai. The user's reason: too expensive";
  const providerVerdicts = new Map<string, ProviderVerdict>([["openai", { kind: "deny", reason }]]);

  // act
  const resolution = resolveSubagentModel({
    requested: "gpt-5",
    mainModel,
    availableModels: [mainModel, target],
    config: {},
    providerVerdicts,
  });

  // assert
  assert.equal(resolution.ok, false);
  assert.ok(resolution.error.includes(`${reason} Do not retry it with crossProvider`));
});

test("a local session treats cloud models as another provider", () => {
  // arrange
  const config: SubagentModelConfig = { localProviders: ["lmstudio"] };
  const mainModel = createModel("lmstudio", "qwen3-coder-next", "http://localhost:1234");
  const target = createModel("anthropic", "claude-haiku-4-5");
  const availableModels = [mainModel, target];
  const allowed = new Map<string, ProviderVerdict>([["anthropic", { kind: "allow" }]]);

  // act
  const withVerdict = resolveSubagentModel({ requested: "anthropic/claude-haiku-4-5", mainModel, availableModels, config, providerVerdicts: allowed });
  const without = resolveSubagentModel({ requested: "anthropic/claude-haiku-4-5", mainModel, availableModels, config, providerVerdicts: new Map() });

  // assert
  assert.deepEqual(withVerdict, { ok: true, model: target });
  assert.equal(without.ok, false);
  assert.match(without.error, /session runs on a local model/);
});

test("crossProviderTargets lists each other-provider model once and skips the rest", () => {
  // arrange
  const config: SubagentModelConfig = { localProviders: ["lmstudio"], providerGroups: [["claude-bridge", "anthropic"]] };
  const mainModel = createModel("claude-bridge", "claude-sonnet-4");
  const gpt = createModel("openai", "gpt-5");
  const availableModels = [
    mainModel,
    createModel("anthropic", "claude-haiku-4-5"),
    gpt,
    createModel("lmstudio", "qwen3-coder-next"),
    createModel("greenpt", "twin"),
    createModel("openai", "twin"),
  ];
  const requested = ["openai/gpt-5", "gpt-5", "anthropic/claude-haiku-4-5", "lmstudio/qwen3-coder-next", "unknown", "twin", undefined];

  // act
  const targets = crossProviderTargets({ requested, mainModel, availableModels, config });

  // assert
  assert.deepEqual(targets, [gpt]);
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
  };
}
