import assert from "node:assert/strict";
import test from "node:test";
import { emptyProfileState } from "./profile-activation.ts";
import { parseProfileCommand, profileCompletions, profileListText } from "./profile-command.ts";
import { NetworkAccess, emptyActivationDecisions, emptyProfileDefinition } from "./profiles.ts";
import type { Profile } from "./profiles.ts";

test("every subcommand parses", () => {
  // arrange
  const inputs = ["", "  ", "record bazel", "stop", "edit bazel", "forget bazel", "delete bazel"];

  // act
  const commands = inputs.map(parseProfileCommand);

  // assert
  assert.deepEqual(commands, [
    { kind: "list" },
    { kind: "list" },
    { kind: "record", name: "bazel" },
    { kind: "stop" },
    { kind: "edit", name: "bazel" },
    { kind: "forget", name: "bazel" },
    { kind: "delete", name: "bazel" },
  ]);
});

test("bad invocations give an error message", () => {
  // arrange
  const inputs = ["frobnicate", "record", "edit a b", "stop now", "record Bad_Name", "on bazel", "edit ../x"];

  // act
  const results = inputs.map(parseProfileCommand);

  // assert
  assert.ok(results.every((result) => result.kind === "error"));
  assert.match((results[0] as { message: string }).message, /Unknown subcommand "frobnicate"/);
  assert.match((results[4] as { message: string }).message, /not a valid profile name/);
  assert.match((results[5] as { message: string }).message, /Unknown subcommand "on"/);
  assert.match((results[6] as { message: string }).message, /not a valid profile name/);
});

test("completions offer subcommands first and profile names after one", () => {
  // arrange
  const names = ["bazel", "gradle"];

  // act
  const subcommands = profileCompletions("re", names);
  const profiles = profileCompletions("edit g", names);
  const none = profileCompletions("zzz", names);

  // assert
  assert.deepEqual(subcommands, [{ value: "record", label: "record" }]);
  assert.deepEqual(profiles, [{ value: "edit gradle", label: "gradle" }]);
  assert.equal(none, null);
});

test("the list shows stored and session decisions and the triggers", () => {
  // arrange
  const bazel: Profile = { name: "bazel", ...emptyProfileDefinition(), triggers: { commands: ["bazel"], patterns: ["build\\.sh"] } };
  const gradle: Profile = { name: "gradle", ...emptyProfileDefinition() };
  const tomcat: Profile = { name: "tomcat", ...emptyProfileDefinition(), network: { ...emptyProfileDefinition().network, access: NetworkAccess.Local } };
  const always = emptyActivationDecisions();
  always.allowed.add("bazel");
  always.denied.set("gradle", "too slow");
  const state = emptyProfileState();
  state.allowed.add("bazel");
  state.denied.set("gradle", undefined);

  // act
  const text = profileListText([bazel, gradle, tomcat], state, always);

  // assert
  assert.equal(text, [
    "bazel: always allowed; allowed this session; triggers: bazel, /build\\.sh/",
    "gradle: always denied (too slow); denied this session; triggers: none",
    "tomcat: ask; no session decision; network: local; triggers: none",
  ].join("\n"));
  assert.match(profileListText([], state, always), /No sandbox profiles/);
});
