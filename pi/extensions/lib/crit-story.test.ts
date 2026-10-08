import assert from "node:assert/strict";
import { test } from "node:test";
import { fillPrepPath, hunkIdsFromPrep } from "./crit-story.ts";

test("hunk ids are taken from the hunk headers only", () => {
  // arrange
  const prep = [
    "=== SCOPE ===",
    "base_sha: a333530b",
    "=== HUNKS ===",
    "--- (INSTALL-AGENTS.md, 2) [modified]",
    "@@ -2,7 +2,7 @@",
    "--- a line of diff text that is not a header",
    "--- (pi/extensions/lib/new, file.ts, 0) [added]",
    "",
  ].join("\n");
  // act
  const ids = hunkIdsFromPrep(prep);
  // assert
  assert.deepEqual(ids, ["(INSTALL-AGENTS.md, 2)", "(pi/extensions/lib/new, file.ts, 0)"]);
});

test("the guide placeholder is replaced by the prep path", () => {
  // arrange
  const guide = "Read the prep file at:\n\n    <run `crit story --prep <path>` first, then pass that path here>\n";
  // act
  const filled = fillPrepPath(guide, "/tmp/pi-sessions/abc/crit-story-prep.txt");
  // assert
  assert.equal(filled, "Read the prep file at:\n\n    /tmp/pi-sessions/abc/crit-story-prep.txt\n");
  assert.equal(fillPrepPath("no placeholder", "/x"), "no placeholder");
});
