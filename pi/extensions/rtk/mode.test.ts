import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SubagentModelConfig } from "../subagent/model-policy.ts";
import {
  commandMode,
  flagMode,
  resolveMode,
  RtkMode,
  savedMode,
  STATE_ENTRY_TYPE,
} from "./mode.ts";

const policyConfig: SubagentModelConfig = { localProviders: ["lmstudio"] };

test("a saved state wins over the flags and the model default", () => {
  // arrange
  const options = {
    saved: RtkMode.Off,
    flag: RtkMode.On,
    settings: { rtk: { alwaysOn: true } },
    model: createModel("anthropic", "claude-sonnet-5-5"),
    policyConfig,
  };

  // act
  const result = resolveMode(options);

  // assert
  assert.equal(result, RtkMode.Off);
});

test("a flag wins over the model default", () => {
  // arrange
  const options = {
    saved: undefined,
    flag: RtkMode.Off,
    settings: { rtk: { alwaysOn: true } },
    model: createModel("anthropic", "claude-sonnet-5-5"),
    policyConfig,
  };

  // act
  const result = resolveMode(options);

  // assert
  assert.equal(result, RtkMode.Off);
});

test("the on flag applies without the setting and on a local model", () => {
  // arrange
  const options = {
    saved: undefined,
    flag: RtkMode.On,
    settings: {},
    model: createModel("lmstudio", "qwen3-coder-next"),
    policyConfig,
  };

  // act
  const result = resolveMode(options);

  // assert
  assert.equal(result, RtkMode.On);
});

test("the setting turns rtk on for a model that is not off by default", () => {
  // arrange
  const options = {
    saved: undefined,
    flag: undefined,
    settings: { rtk: { alwaysOn: true } },
    model: createModel("anthropic", "claude-sonnet-5-5"),
    policyConfig,
  };

  // act
  const result = resolveMode(options);

  // assert
  assert.equal(result, RtkMode.On);
});

test("the setting does not turn rtk on for local and old Haiku models", () => {
  // arrange
  const models = [
    createModel("lmstudio", "qwen3-coder-next"),
    createModel("anthropic", "claude-haiku-4-5"),
  ];

  // act
  const results = models.map((model) =>
    resolveMode({
      saved: undefined,
      flag: undefined,
      settings: { rtk: { alwaysOn: true } },
      model,
      policyConfig,
    }),
  );

  // assert
  assert.deepEqual(results, [RtkMode.Off, RtkMode.Off]);
});

test("a missing or malformed setting leaves rtk off", () => {
  // arrange
  const settings = [{}, { rtk: { alwaysOn: "yes" } }];

  // act
  const results = settings.map((entry) =>
    resolveMode({
      saved: undefined,
      flag: undefined,
      settings: entry,
      model: createModel("anthropic", "claude-sonnet-5-5"),
      policyConfig,
    }),
  );

  // assert
  assert.deepEqual(results, [RtkMode.Off, RtkMode.Off]);
});

test("no saved mode without entries or with only other custom entries", () => {
  // arrange
  const otherEntries = [{ type: "custom", customType: "i-have-adhd-state", data: { mode: "on" } }];

  // act
  const results = [savedMode([]), savedMode(otherEntries)];

  // assert
  assert.deepEqual(results, [undefined, undefined]);
});

test("the last saved mode on the branch wins", () => {
  // arrange
  const entries = [
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { mode: "on" } },
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { mode: "off" } },
  ];

  // act
  const result = savedMode(entries);

  // assert
  assert.equal(result, RtkMode.Off);
});

test("a saved entry with an unknown mode is ignored", () => {
  // arrange
  const entries = [
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { mode: "on" } },
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { mode: "maybe" } },
  ];

  // act
  const result = savedMode(entries);

  // assert
  assert.equal(result, RtkMode.On);
});

test("the no-rtk flag wins over the rtk flag", () => {
  // arrange
  const combinations: [boolean, boolean][] = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ];

  // act
  const results = combinations.map(([rtkFlag, noRtkFlag]) => flagMode(rtkFlag, noRtkFlag));

  // assert
  assert.deepEqual(results, [undefined, RtkMode.On, RtkMode.Off, RtkMode.Off]);
});

test("the command without an argument flips the current mode", () => {
  // arrange
  const currents = [RtkMode.On, RtkMode.Off];

  // act
  const results = currents.map((current) => commandMode("", current));

  // assert
  assert.deepEqual(results, [RtkMode.Off, RtkMode.On]);
});

test("the command accepts on and off in any case and rejects other arguments", () => {
  // arrange
  const argumentsToTry = ["on", " OFF ", "maybe"];

  // act
  const results = argumentsToTry.map((argument) => commandMode(argument, RtkMode.Off));

  // assert
  assert.deepEqual(results, [RtkMode.On, RtkMode.Off, undefined]);
});

function createModel(provider: string, id: string, baseUrl = "https://api.example.com/v1"): Model<Api> {
  return { provider, id, baseUrl } as Model<Api>;
}
