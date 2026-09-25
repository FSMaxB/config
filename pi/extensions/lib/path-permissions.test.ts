import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveThroughSymlinks } from "./path-resolution.ts";
import {
  defaultAllowed,
  emptyRules,
  evaluate,
  exact,
  glob,
  matchesRule,
  parseRules,
  recordRule,
  selectorKey,
  selectorLabel,
  serializeRules,
  tree,
} from "./path-permission-rules.ts";

test("a plain path matches exactly", () => {
  // arrange
  const pattern = exact("/repo/foo.txt");

  // act
  const same = matchesRule("/repo/foo.txt", pattern);
  const child = matchesRule("/repo/foo.txt/bar", pattern);
  const sibling = matchesRule("/repo/foo.txtx", pattern);
  const parent = matchesRule("/repo", pattern);

  // assert
  assert.equal(same, true);
  assert.equal(child, false);
  assert.equal(sibling, false);
  assert.equal(parent, false);
});

test("a tree includes the directory itself and its descendants", () => {
  // arrange
  const pattern = tree("/repo");

  // act
  const root = matchesRule("/repo", pattern);
  const child = matchesRule("/repo/a", pattern);
  const descendant = matchesRule("/repo/a/b.ts", pattern);
  const sibling = matchesRule("/repox", pattern);
  const siblingChild = matchesRule("/repox/a", pattern);

  // assert
  assert.equal(root, true);
  assert.equal(child, true);
  assert.equal(descendant, true);
  assert.equal(sibling, false);
  assert.equal(siblingChild, false);
});

test("glob rules use Node glob semantics", () => {
  // arrange
  const nestedTypeScript = glob("/repo", "**/*.ts");
  const directTypeScript = glob("/repo", "*.ts");
  const sourceFiles = glob("/repo", "**/*.{ts,md}");

  // act
  const nestedMatch = matchesRule("/repo/src/main.ts", nestedTypeScript);
  const markdownMismatch = matchesRule("/repo/src/main.md", nestedTypeScript);
  const directDoesNotCross = matchesRule("/repo/src/main.ts", directTypeScript);
  const braceTypeScript = matchesRule("/repo/src/main.ts", sourceFiles);
  const braceMarkdown = matchesRule("/repo/src/README.md", sourceFiles);

  // assert
  assert.equal(nestedMatch, true);
  assert.equal(markdownMismatch, false);
  assert.equal(directDoesNotCross, false);
  assert.equal(braceTypeScript, true);
  assert.equal(braceMarkdown, true);
});

test("path resolution follows a dangling final symlink", async () => {
  // arrange
  const fixture = await mkdtemp(join(tmpdir(), "pi-path-permissions-"));
  const repository = join(fixture, "repo");
  const target = join(fixture, "outside", "new-file.txt");
  const canonicalTarget = join(await realpath(fixture), "outside", "new-file.txt");
  const link = join(repository, "link");
  await mkdir(repository);
  await symlink(target, link);

  try {
    // act
    const resolved = await resolveThroughSymlinks(link);

    // assert
    assert.equal(resolved, canonicalTarget);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a new opposite rule removes the identical rule from the other tier", () => {
  // arrange
  const session = emptyRules();
  const always = emptyRules();
  always.read.deny.add(selectorKey(tree("/tmp")));

  // act
  const changed = recordRule(
    {
      mode: "read",
      kind: "allow",
      tier: "session",
      selector: tree("/tmp"),
    },
    { session, always },
  );

  assert.deepEqual(changed, new Set(["session", "always"]));
  assert.deepEqual(session.read.allow, new Set([selectorKey(tree("/tmp"))]));
  assert.deepEqual(always.read.deny, new Set());
});

test("deny rules win over allows and defaults", () => {
  // arrange
  const always = emptyRules();
  const session = emptyRules();
  always.read.allow.add(selectorKey(tree("/repo")));
  session.read.deny.add(selectorKey(tree("/repo/private")));

  // act
  const verdict = evaluate("/repo/private/key.txt", "read", {
    defaults: [tree("/repo")],
    always,
    session,
  });

  // assert
  assert.equal(verdict, "deny");
});

test("evaluation allows every allow layer and prompts without a match", () => {
  // arrange
  const always = emptyRules();
  const session = emptyRules();
  always.read.allow.add(selectorKey(tree("/always")));
  session.read.allow.add(selectorKey(tree("/session")));

  // act
  const defaultVerdict = evaluate("/default/file", "read", {
    defaults: [tree("/default")],
    always,
    session,
  });
  const alwaysVerdict = evaluate("/always/file", "read", {
    defaults: [],
    always,
    session,
  });
  const sessionVerdict = evaluate("/session/file", "read", {
    defaults: [],
    always,
    session,
  });
  const unmatchedVerdict = evaluate("/elsewhere/file", "read", {
    defaults: [],
    always,
    session,
  });

  // assert
  assert.equal(defaultVerdict, "allow");
  assert.equal(alwaysVerdict, "allow");
  assert.equal(sessionVerdict, "allow");
  assert.equal(unmatchedVerdict, "prompt");
});

test("default write access changes with plan mode", () => {
  // arrange
  const options = {
    repoRoot: "/repo",
    memoryDirectory: "/memory",
    skillRoots: ["/skills"],
    agentDirectory: "/agent",
  };

  // act
  const planning = defaultAllowed("write", { ...options, planMode: true });
  const normal = defaultAllowed("write", { ...options, planMode: false });

  // assert
  assert.deepEqual(planning.map(selectorLabel), ["/memory/**", "/agent/plans/**"]);
  assert.deepEqual(normal.map(selectorLabel), ["/repo/**", "/memory/**", "/agent/plans/**"]);
});

test("default read access includes every trusted root", () => {
  // arrange
  const options = {
    planMode: true,
    repoRoot: "/repo",
    memoryDirectory: "/memory",
    skillRoots: ["/skills/one", "/skills/two"],
    agentDirectory: "/agent",
  };

  // act
  const allowed = defaultAllowed("read", options);

  // assert
  assert.deepEqual(allowed.map(selectorLabel), [
    "/repo/**",
    "/memory/**",
    "/agent/plans/**",
    join(homedir(), ".crit", "**"),
    "/skills/one/**",
    "/skills/two/**",
  ]);
});

test("the session temporary directory is readable and writable in every mode", () => {
  // arrange
  const options = {
    repoRoot: "/repo",
    memoryDirectory: "/memory",
    skillRoots: [],
    agentDirectory: "/agent",
    temporaryDirectory: "/scratch",
  };

  // act
  const planningWrite = defaultAllowed("write", { ...options, planMode: true });
  const normalWrite = defaultAllowed("write", { ...options, planMode: false });
  const read = defaultAllowed("read", { ...options, planMode: true });

  // assert
  assert.ok(planningWrite.map(selectorLabel).includes("/scratch/**"));
  assert.ok(normalWrite.map(selectorLabel).includes("/scratch/**"));
  assert.ok(read.map(selectorLabel).includes("/scratch/**"));
});

test("recorded rules take part in evaluation", () => {
  // arrange
  const session = emptyRules();
  recordRule(
    { mode: "read", kind: "allow", tier: "session", selector: { kind: "tree", path: "/granted" } },
    { session, always: emptyRules() },
  );

  // act
  const inside = evaluate("/granted/file", "read", { defaults: [], always: emptyRules(), session });
  const outside = evaluate("/elsewhere/file", "read", { defaults: [], always: emptyRules(), session });

  // assert
  assert.equal(inside, "allow");
  assert.equal(outside, "prompt");
});

test("serialized rules survive a round trip through JSON and parseRules", () => {
  // arrange
  const rules = emptyRules();
  const always = emptyRules();
  for (const selector of [
    { kind: "tree", path: "/repo" } as const,
    { kind: "exact", path: "/notes/todo.md" } as const,
    { kind: "glob", base: "/src", pattern: "**/*.ts" } as const,
  ]) {
    recordRule({ mode: "read", kind: "allow", tier: "session", selector }, { session: rules, always });
  }
  recordRule({ mode: "write", kind: "deny", tier: "session", selector: { kind: "tree", path: "/secrets" } }, { session: rules, always });

  // act
  const serialized = JSON.parse(JSON.stringify(serializeRules(rules)));
  const parsed = parseRules(serialized);

  // assert
  assert.deepEqual(serialized.read.allow, [
    { kind: "exact", path: "/notes/todo.md" },
    { kind: "glob", base: "/src", pattern: "**/*.ts" },
    { kind: "tree", path: "/repo" },
  ]);
  assert.deepEqual(parsed, rules);
});

test("parseRules rejects malformed version 2 selectors", () => {
  // arrange
  const stored = { version: 2, read: { allow: [{ kind: "tree" }], deny: [] }, write: { allow: [], deny: [] } };

  // act & assert
  assert.throws(() => parseRules(stored), /Invalid path permission rules/);
});

test("a stored tree selector drops a redundant trailing subtree glob", () => {
  // arrange
  const stored = { version: 2, read: { allow: [{ kind: "tree", path: "/agent/**" }], deny: [] }, write: { allow: [], deny: [] } };

  // act
  const parsed = parseRules(stored);
  const verdict = evaluate("/agent/settings.json", "read", { defaults: [], always: parsed, session: emptyRules() });

  // assert
  assert.deepEqual(parsed.read.allow, new Set([selectorKey({ kind: "tree", path: "/agent" })]));
  assert.equal(verdict, "allow");
});
