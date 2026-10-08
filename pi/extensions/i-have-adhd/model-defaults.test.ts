import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SubagentModelConfig } from "../subagent/model-policy.ts";
import { isOffByDefaultModel } from "./model-defaults.ts";

const config: SubagentModelConfig = { localProviders: ["lmstudio"] };

test("a model from a local provider is off by default", () => {
  // arrange
  const model = createModel("lmstudio", "qwen3-coder-next");

  // act
  const result = isOffByDefaultModel(model, config);

  // assert
  assert.equal(result, true);
});

test("a model served from localhost is off by default", () => {
  // arrange
  const model = createModel("custom", "some-model", "http://localhost:1234/v1");

  // act
  const result = isOffByDefaultModel(model, config);

  // assert
  assert.equal(result, true);
});

test("Haiku models before 5.5 are off by default on every provider", () => {
  // arrange
  const models = [
    createModel("anthropic", "claude-haiku-4-5"),
    createModel("claude-bridge", "claude-haiku-4-5"),
    createModel("anthropic", "claude-haiku-4-5-20251001"),
    createModel("openrouter", "anthropic/claude-haiku-4.5"),
    createModel("anthropic", "claude-3-5-haiku-20241022"),
  ];

  // act
  const results = models.map((model) => isOffByDefaultModel(model, config));

  // assert
  assert.deepEqual(results, [true, true, true, true, true]);
});

test("Haiku 5.5 and later keep the configured default", () => {
  // arrange
  const models = [
    createModel("anthropic", "claude-haiku-5-5"),
    createModel("claude-bridge", "claude-haiku-5-5"),
    createModel("openrouter", "anthropic/claude-haiku-5.5"),
    createModel("anthropic", "claude-haiku-6-20270101"),
    createModel("anthropic", "claude-haiku-5-10"),
  ];

  // act
  const results = models.map((model) => isOffByDefaultModel(model, config));

  // assert
  assert.deepEqual(results, [false, false, false, false, false]);
});

test("Luna models are off by default", () => {
  // arrange
  const models = [
    createModel("openai", "gpt-6-luna"),
    createModel("openai", "gpt-5.6-luna"),
  ];

  // act
  const results = models.map((model) => isOffByDefaultModel(model, config));

  // assert
  assert.deepEqual(results, [true, true]);
});

test("Mistral models are off by default, other models on the Mistral provider are not", () => {
  // arrange
  const models = [
    createModel("mistral", "mistral-large-latest"),
    createModel("mistral", "devstral-2"),
    createModel("mistral", "magistral-medium-latest"),
    createModel("mistral", "glm-5.2"),
  ];

  // act
  const results = models.map((model) => isOffByDefaultModel(model, config));

  // assert
  assert.deepEqual(results, [true, true, true, false]);
});

test("larger cloud models keep the configured default", () => {
  // arrange
  const models = [
    createModel("openai", "gpt-6-sol"),
    createModel("anthropic", "claude-opus-5-5"),
    createModel("anthropic", "claude-sonnet-5-5"),
  ];

  // act
  const results = models.map((model) => isOffByDefaultModel(model, config));

  // assert
  assert.deepEqual(results, [false, false, false]);
});

test("a missing model keeps the configured default", () => {
  // arrange
  const model = undefined;

  // act
  const result = isOffByDefaultModel(model, config);

  // assert
  assert.equal(result, false);
});

function createModel(provider: string, id: string, baseUrl = "https://api.example.com/v1"): Model<Api> {
  return { provider, id, baseUrl } as Model<Api>;
}
