import assert from "node:assert/strict";
import { test } from "node:test";
import { addToProfileLabel, ALLOW_NARROWER, ALLOW_ONCE, ALLOW_SESSION, DENY_ALWAYS, DENY_ONCE, DENY_SESSION, DENY_WITH_REASON, profileDestinations } from "./permission-choices.ts";
import { ALL_DURATIONS, askPermission, Duration, userReason } from "./permission-prompt.ts";
import type { PermissionRequest, PermissionUI } from "./permission-prompt.ts";

interface SelectCall { title: string; options: readonly string[]; preselected: string | undefined }

// Answers are consumed in order; undefined stands for Esc.
function scriptedUI(answers: readonly (string | undefined)[]): PermissionUI & { selects: SelectCall[]; inputs: string[] } {
  const queue = [...answers];
  const selects: SelectCall[] = [];
  const inputs: string[] = [];
  return {
    selects,
    inputs,
    async select(title, options, preselected) { selects.push({ title, options, preselected }); return queue.shift(); },
    async input(title) { inputs.push(title); return queue.shift(); },
  };
}

function request<Destination = never>(overrides: Partial<PermissionRequest<string, Destination>> = {}): PermissionRequest<string, Destination> {
  return { title: "Allow it?", subject: "network access to example.com", scope: "broad", narrower: [], durations: ALL_DURATIONS, ...overrides };
}

test("a plain option answers after one select and no input", async () => {
  // arrange
  const ui = scriptedUI([ALLOW_SESSION]);

  // act
  const answer = await askPermission(ui, request());

  // assert
  assert.deepEqual(answer, { decision: "allow", duration: Duration.Session, scope: "broad" });
  assert.equal(ui.selects.length, 1);
  assert.deepEqual(ui.inputs, []);
});

test("dismissing the main prompt denies once without a reason", async () => {
  // arrange
  const ui = scriptedUI([undefined]);

  // act
  const answer = await askPermission(ui, request());

  // assert
  assert.deepEqual(answer, { decision: "deny", duration: Duration.Once, note: undefined });
});

test("deny with reason asks for the reason and then the duration", async () => {
  // arrange
  const ui = scriptedUI([DENY_WITH_REASON, "  use https  ", "This session"]);

  // act
  const answer = await askPermission(ui, request());

  // assert
  assert.deepEqual(answer, { decision: "deny", duration: Duration.Session, note: "use https" });
});

test("an empty reason returns to the main prompt", async () => {
  // arrange
  const ui = scriptedUI([DENY_WITH_REASON, "   ", DENY_ONCE]);

  // act
  const answer = await askPermission(ui, request());

  // assert
  assert.deepEqual(answer, { decision: "deny", duration: Duration.Once, note: undefined });
  assert.equal(ui.selects.length, 2);
});

test("a single narrower scope skips the scope list and asks only the duration", async () => {
  // arrange
  const narrower = [{ label: "network access to example.com:443", scope: "example.com:443" }];
  const ui = scriptedUI([ALLOW_NARROWER, "Once"]);

  // act
  const answer = await askPermission(ui, request({ narrower }));

  // assert
  assert.deepEqual(answer, { decision: "allow", duration: Duration.Once, scope: "example.com:443" });
  assert.equal(ui.selects.length, 2);
});

test("several narrower scopes ask for the scope and then the duration", async () => {
  // arrange
  const narrower = [{ label: "the file", scope: "file" }, { label: "its directory", scope: "directory" }];
  const ui = scriptedUI([ALLOW_NARROWER, "its directory", "Always"]);

  // act
  const answer = await askPermission(ui, request({ narrower }));

  // assert
  assert.deepEqual(answer, { decision: "allow", duration: Duration.Always, scope: "directory" });
  assert.deepEqual(ui.selects[1].options, ["the file", "its directory"]);
});

test("dismissing the duration list returns to the main prompt", async () => {
  // arrange
  const narrower = [{ label: "the file", scope: "file" }];
  const ui = scriptedUI([ALLOW_NARROWER, undefined, ALLOW_ONCE]);

  // act
  const answer = await askPermission(ui, request({ narrower }));

  // assert
  assert.deepEqual(answer, { decision: "allow", duration: Duration.Once, scope: "broad" });
  assert.equal(ui.selects.length, 3);
});

test("the menu hides narrower without candidates and offers only the given durations", async () => {
  // arrange
  const ui = scriptedUI([undefined]);

  // act
  await askPermission(ui, request({ durations: [Duration.Once, Duration.Session] }));

  // assert
  assert.deepEqual(ui.selects[0].options, [ALLOW_ONCE, ALLOW_SESSION, DENY_ONCE, DENY_SESSION, DENY_WITH_REASON]);
  assert.ok(!ui.selects[0].options.includes(DENY_ALWAYS));
});

test("the menu lists narrower between the allow and deny options", async () => {
  // arrange
  const ui = scriptedUI([undefined]);

  // act
  await askPermission(ui, request({ narrower: [{ label: "the file", scope: "file" }] }));

  // assert
  assert.ok(ui.selects[0].options.indexOf(ALLOW_NARROWER) > ui.selects[0].options.indexOf(ALLOW_ONCE));
  assert.ok(ui.selects[0].options.indexOf(ALLOW_NARROWER) < ui.selects[0].options.indexOf(DENY_ONCE));
});

test("preselected reaches only the main prompt", async () => {
  // arrange
  const narrower = [{ label: "the file", scope: "file" }];
  const ui = scriptedUI([ALLOW_NARROWER, undefined, DENY_ONCE]);

  // act
  await askPermission(ui, request({ narrower, preselected: DENY_ONCE }));

  // assert
  assert.deepEqual(ui.selects.map(({ preselected }) => preselected), [DENY_ONCE, undefined, DENY_ONCE]);
});

test("userReason is empty without a note", () => {
  // arrange
  const note = undefined;

  // act
  const text = userReason(note);

  // assert
  assert.equal(text, "");
  assert.equal(userReason("use https"), " The user's reason: use https");
});

test("a destination in the main menu answers allow-to with the default scope", async () => {
  // arrange
  const destinations = profileDestinations(["bazel", "other"]);
  const ui = scriptedUI([addToProfileLabel("bazel")]);

  // act
  const answer = await askPermission(ui, request({ destinations, narrower: [{ label: "the file", scope: "file" }] }));

  // assert
  assert.deepEqual(answer, { decision: "allow-to", destination: "bazel", scope: "broad" });
  const { options } = ui.selects[0];
  assert.deepEqual(options.slice(options.indexOf(ALLOW_ONCE), options.indexOf(DENY_ONCE)), [ALLOW_ONCE, ALLOW_SESSION, "Allow always", addToProfileLabel("bazel"), addToProfileLabel("other"), ALLOW_NARROWER]);
});

test("a destination after allow narrower answers allow-to with the narrower scope", async () => {
  // arrange
  const destinations = profileDestinations(["bazel"]);
  const narrower = [{ label: "the file", scope: "file" }];
  const ui = scriptedUI([ALLOW_NARROWER, addToProfileLabel("bazel")]);

  // act
  const answer = await askPermission(ui, request({ destinations, narrower }));

  // assert
  assert.deepEqual(answer, { decision: "allow-to", destination: "bazel", scope: "file" });
  assert.deepEqual(ui.selects[1].options, ["Once", "This session", "Always", addToProfileLabel("bazel")]);
});

test("a duration after allow narrower still works when destinations exist", async () => {
  // arrange
  const destinations = profileDestinations(["bazel"]);
  const narrower = [{ label: "the file", scope: "file" }];
  const ui = scriptedUI([ALLOW_NARROWER, "This session"]);

  // act
  const answer = await askPermission(ui, request({ destinations, narrower }));

  // assert
  assert.deepEqual(answer, { decision: "allow", duration: Duration.Session, scope: "file" });
});

test("no destination options appear when none are passed", async () => {
  // arrange
  const ui = scriptedUI([undefined]);

  // act
  await askPermission(ui, request());

  // assert
  assert.ok(!ui.selects[0].options.some((option) => option.startsWith("Add to profile")));
});
