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

test("Haiku models are off by default on every provider", () => {
  // arrange
  const models = [
    createModel("anthropic", "claude-haiku-4-5"),
    createModel("claude-bridge", "claude-haiku-4-5"),
  ];

  // act
  const results = models.map((model) => isOffByDefaultModel(model, config));

  // assert
  assert.deepEqual(results, [true, true]);
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
