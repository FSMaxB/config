import assert from "node:assert/strict";
import test from "node:test";
import {
  coveredProtectedSelectors,
  denyNote,
  emptyStoredRules,
  EntryKind,
  exact,
  glob,
  narrowerSelectors,
  parseStoredRules,
  recordRule,
  selectorKey,
  serializeStoredRules,
  tree,
  emptyRules,
} from "./path-permission-rules.ts";
import type {
  PathSelector,
} from "./path-permission-rules.ts";

test("a tree grant covers a protected root nested inside it", () => {
  // arrange
  const grant = tree("/home/user");
  const protectedSelectors: PathSelector[] = [tree("/home/user/.pi/agent/extensions"), tree("/root/other")];

  // act
  const covered = coveredProtectedSelectors(grant, protectedSelectors);

  // assert
  assert.deepEqual(covered, [tree("/home/user/.pi/agent/extensions")]);
});

test("an exact grant covers the identical protected root", () => {
  // arrange
  const grant = exact("/home/user/.pi/agent/extensions");
  const protectedSelectors: PathSelector[] = [tree("/home/user/.pi/agent/extensions")];

  // act
  const covered = coveredProtectedSelectors(grant, protectedSelectors);

  // assert
  assert.deepEqual(covered, [tree("/home/user/.pi/agent/extensions")]);
});

test("a glob grant covers nothing", () => {
  // arrange
  const grant = glob("/home/user", "**");
  const protectedSelectors: PathSelector[] = [tree("/home/user/.pi/agent/extensions")];

  // act
  const covered = coveredProtectedSelectors(grant, protectedSelectors);

  // assert
  assert.deepEqual(covered, []);
});

test("an unrelated tree covers nothing", () => {
  // arrange
  const grant = tree("/opt/work");
  const protectedSelectors: PathSelector[] = [tree("/home/user/.pi/agent/extensions")];

  // act
  const covered = coveredProtectedSelectors(grant, protectedSelectors);

  // assert
  assert.deepEqual(covered, []);
});

test("a deny note survives serializing and parsing the stored rules", () => {
  // arrange
  const rules = emptyStoredRules();
  recordRule({ mode: "read", kind: "deny", tier: "always", selector: tree("/secret"), note: "private data" }, { session: emptyRules(), always: rules.execution });
  recordRule({ mode: "write", kind: "deny", tier: "always", selector: exact("/plain") }, { session: emptyRules(), always: rules.execution });

  // act
  const parsed = parseStoredRules(JSON.parse(JSON.stringify(serializeStoredRules(rules))));

  // assert
  assert.equal(parsed.execution.read.deny.get(selectorKey(tree("/secret"))), "private data");
  assert.equal(parsed.execution.write.deny.get(selectorKey(exact("/plain"))), undefined);
  assert.equal(parsed.execution.write.deny.has(selectorKey(exact("/plain"))), true);
});

test("a stored deny entry without a note still parses", () => {
  // arrange
  const stored = { version: 3, execution: { read: { allow: [], deny: [{ kind: "tree", path: "/old" }] }, write: { allow: [], deny: [] } }, plan: emptyRulesJson(), explore: emptyRulesJson() };

  // act
  const parsed = parseStoredRules(stored);

  // assert
  assert.deepEqual([...parsed.execution.read.deny], [[selectorKey(tree("/old")), undefined]]);
});

test("an allow over a noted deny removes the note with the deny", () => {
  // arrange
  const session = emptyRules();
  recordRule({ mode: "read", kind: "deny", tier: "session", selector: tree("/x"), note: "no" }, { session, always: emptyRules() });

  // act
  recordRule({ mode: "read", kind: "allow", tier: "session", selector: tree("/x") }, { session, always: emptyRules() });

  // assert
  assert.equal(session.read.deny.size, 0);
});

test("denyNote returns the note of a matching deny rule", () => {
  // arrange
  const session = emptyRules();
  recordRule({ mode: "read", kind: "deny", tier: "session", selector: tree("/repo/private"), note: "keys inside" }, { session, always: emptyRules() });
  recordRule({ mode: "read", kind: "deny", tier: "session", selector: tree("/repo/other"), note: "other reason" }, { session, always: emptyRules() });

  // act
  const note = denyNote("/repo/private/key.pem", "read", { always: emptyRules(), session });
  const unrelated = denyNote("/repo/src/main.ts", "read", { always: emptyRules(), session });
  const otherMode = denyNote("/repo/private/key.pem", "write", { always: emptyRules(), session });

  // assert
  assert.equal(note, "keys inside");
  assert.equal(unrelated, undefined);
  assert.equal(otherMode, undefined);
});

test("denyNote prefers an always rule over a session rule", () => {
  // arrange
  const always = emptyRules();
  const session = emptyRules();
  recordRule({ mode: "read", kind: "deny", tier: "always", selector: tree("/repo"), note: "always reason" }, { session: emptyRules(), always });
  recordRule({ mode: "read", kind: "deny", tier: "session", selector: tree("/repo"), note: "session reason" }, { session, always: emptyRules() });

  // act
  const note = denyNote("/repo/a", "read", { always, session });

  // assert
  assert.equal(note, "always reason");
});

test("narrower scopes of a file are the file and each enclosing directory below the grant root", () => {
  // arrange
  const broad = tree("/repo");

  // act
  const scopes = narrowerSelectors("/repo/a/b/c.txt", EntryKind.File, broad);

  // assert
  assert.deepEqual(scopes, [exact("/repo/a/b/c.txt"), tree("/repo/a/b"), tree("/repo/a")]);
});

test("a directory equal to the grant root has no narrower scope", () => {
  // arrange
  const broad = tree("/repo");

  // act
  const scopes = narrowerSelectors("/repo", EntryKind.Directory, broad);

  // assert
  assert.deepEqual(scopes, []);
});

test("a directory below the grant root narrows to itself and its parents inside the root", () => {
  // arrange
  const broad = tree("/repo");

  // act
  const scopes = narrowerSelectors("/repo/a/b", EntryKind.Directory, broad);

  // assert
  assert.deepEqual(scopes, [tree("/repo/a/b"), tree("/repo/a")]);
});

test("a file directly in the grant root narrows only to itself", () => {
  // arrange
  const broad = tree("/x");

  // act
  const scopes = narrowerSelectors("/x/f", EntryKind.File, broad);

  // assert
  assert.deepEqual(scopes, [exact("/x/f")]);
});

test("a glob grant narrows only to the path itself", () => {
  // arrange
  const broad = glob("/agent", "*.json");

  // act
  const scopes = narrowerSelectors("/agent/settings.json", EntryKind.File, broad);

  // assert
  assert.deepEqual(scopes, [exact("/agent/settings.json")]);
});

function emptyRulesJson() {
  return { read: { allow: [], deny: [] }, write: { allow: [], deny: [] } };
}
