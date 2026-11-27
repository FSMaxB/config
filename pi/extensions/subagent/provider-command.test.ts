import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderCommand, providerCompletions } from "./provider-command.ts";

test("every invocation parses to a command or an error", () => {
  // arrange
  const inputs = ["", "  ", "forget openai", "forget", "forget a b", "other"];

  // act
  const results = inputs.map(parseProviderCommand);

  // assert
  assert.deepEqual(results.slice(0, 3), [{ kind: "list" }, { kind: "list" }, { kind: "forget", provider: "openai" }]);
  assert.deepEqual(results.slice(3).map(({ kind }) => kind), ["error", "error", "error"]);
  assert.match((results[3] as { message: string }).message, /forget takes exactly one provider/);
  assert.match((results[5] as { message: string }).message, /Unknown subcommand "other"/);
});

test("completions offer the subcommand first and providers after it", () => {
  // arrange
  const providers = ["greenpt", "openai"];

  // act
  const subcommand = providerCompletions("fo", providers);
  const provider = providerCompletions("forget o", providers);
  const none = providerCompletions("zzz", providers);

  // assert
  assert.deepEqual(subcommand, [{ value: "forget", label: "forget" }]);
  assert.deepEqual(provider, [{ value: "forget openai", label: "openai" }]);
  assert.equal(none, null);
});
