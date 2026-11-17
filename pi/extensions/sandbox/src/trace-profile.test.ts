import assert from "node:assert/strict";
import test from "node:test";
import { traceProfile } from "./trace-profile.ts";

test("quiet lists are omitted instead of emitting an empty filter", () => {
  // arrange
  const filesystem = { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] };

  // act
  const profile = traceProfile(filesystem, "TAG");

  // assert
  assert.equal(profile, ['(version 1)', '(allow default)', '(allow file-write* (with report) (with message "TAG"))'].join("\n"));
});

test("glob entries are skipped", () => {
  // arrange
  const filesystem = { denyRead: ["/Users", "/data/*.log"], allowRead: ["/a/**"], allowWrite: ["/b/[x]"], denyWrite: [] };

  // act
  const profile = traceProfile(filesystem, "TAG");

  // assert
  assert.match(profile, /\(subpath "\/Users"\)/);
  assert.doesNotMatch(profile, /\*\.log|\/a\/|\/b\//);
});

test("quotes and backslashes in paths and tags are escaped", () => {
  // arrange
  const filesystem = { denyRead: ['/odd"dir\\x'], allowRead: [], allowWrite: [], denyWrite: [] };

  // act
  const profile = traceProfile(filesystem, 'T"AG');

  // assert
  assert.match(profile, /\(subpath "\/odd\\"dir\\\\x"\)/);
  assert.match(profile, /\(with message "T\\"AG"\)/);
});

test("reporting rules come before the rules that silence them", () => {
  // arrange
  const filesystem = { denyRead: ["/Users"], allowRead: ["/Users/max/repo"], allowWrite: ["/Users/max/repo"], denyWrite: [] };

  // act
  const lines = traceProfile(filesystem, "TAG").split("\n");

  // assert
  assert.deepEqual(lines, [
    "(version 1)",
    "(allow default)",
    '(allow file-read* (with report) (with message "TAG") (subpath "/Users"))',
    '(allow file-read* (subpath "/Users/max/repo"))',
    '(allow file-write* (with report) (with message "TAG"))',
    '(allow file-write* (subpath "/Users/max/repo"))',
  ]);
});
