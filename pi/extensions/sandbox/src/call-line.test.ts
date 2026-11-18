import assert from "node:assert/strict";
import { test } from "node:test";
import { callPrefix, PrefixedCallText, withSandboxProfiles } from "./call-line.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("PrefixedCallText draws the prefix set after the call text", () => {
  // arrange
  let prefix = "";
  const line = new PrefixedCallText();
  line.setPrefix(() => prefix);
  line.setText("$ ls");
  const width = 40;
  const expectedBefore = "$ ls";
  const expectedAfter = "[a, b] $ ls";

  // act
  const before = line.render(width).join("\n").trim();
  prefix = "[a, b] ";
  const after = line.render(width).join("\n").trim();

  // assert
  assert.equal(before, expectedBefore);
  assert.equal(after, expectedAfter);
});

test("callPrefix lists every profile", () => {
  // arrange
  const expected = "[bazel, node] ";

  // act
  const prefix = callPrefix({ kind: "sandboxed", profiles: ["bazel", "node"] }, theme);

  // assert
  assert.equal(prefix, expected);
});

test("callPrefix is empty without profiles", () => {
  // arrange
  const expected = "";

  // act
  const prefix = callPrefix({ kind: "sandboxed", profiles: [] }, theme);

  // assert
  assert.equal(prefix, expected);
});

test("withSandboxProfiles keeps the stock details", () => {
  // arrange
  const details = { fullOutputPath: "/tmp/x" };
  const expected = { fullOutputPath: "/tmp/x", sandboxProfiles: ["bazel"] };

  // act
  const profiled = withSandboxProfiles(details, ["bazel"]);
  const unprofiled = withSandboxProfiles(details, []);

  // assert
  assert.deepEqual(profiled, expected);
  assert.equal(unprofiled, details);
});
