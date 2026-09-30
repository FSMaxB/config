import assert from "node:assert/strict";
import { test } from "node:test";
import { limitChangedFiles, vcsResult } from "./vcs-result.ts";

test("VCS envelopes preserve the same bounded text and metadata in both channels", () => {
  // arrange
  const metadata = { kind: "jj", root: "/workspace", colocated: true } as const;
  const outputs = ["original text", "(no output)", "[truncated] capped text", "[Lines 2-3 of 9]\na\nb"];
  // act
  const results = outputs.map((output, index) => vcsResult(metadata, output, { truncated: index === 2 }));
  // assert
  results.forEach((result, index) => {
    assert.deepEqual(result.structuredContent, { ...metadata, output: outputs[index], truncated: index === 2 });
    assert.equal(result.content[0].type === "text" && result.content[0].text, outputs[index]);
    assert.deepEqual(result.details, { kind: "jj", truncated: index === 2 });
  });
});

test("missing repositories remain successful structured outcomes", () => {
  // arrange
  const metadata = { kind: "none", root: "/workspace", colocated: false } as const;
  // act
  const result = vcsResult(metadata, "No repository");
  // assert
  assert.deepEqual(result.structuredContent, { ...metadata, output: "No repository", truncated: false });
  assert.notEqual(result.isError, true);
});

test("changed-file limits preserve status headers and record truncation", () => {
  // arrange
  const jj = "Working copy changes:\nM one\nA two\nD three\nWorking copy (@): fixture\nParent (@-): parent\n";
  const git = "## main\n M one\n?? two\n";
  // act
  const cappedJj = limitChangedFiles(jj, 1);
  const cappedGit = limitChangedFiles(git, 1);
  const complete = limitChangedFiles(jj, 3);
  // assert
  assert.equal(cappedJj.truncated, true);
  assert.match(cappedJj.output, /2 more changed files/);
  assert.match(cappedJj.output, /Working copy \(@\): fixture\nParent \(@-\): parent/);
  assert.equal(cappedGit.truncated, true);
  assert.match(cappedGit.output, /^## main\n M one/);
  assert.deepEqual(complete, { output: jj, truncated: false });
});
