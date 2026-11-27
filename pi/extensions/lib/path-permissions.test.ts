import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentMode } from "./agent-mode.ts";
import { inheritedRules, parseChildPathPolicy, serializeChildPathPolicy } from "./path-permission-snapshot.ts";
import { PathResolution, resolveOperationPath, resolveThroughSymlinks } from "./path-resolution.ts";
import {
  covers,
  defaultAllowed,
  emptyRules,
  emptyStoredRules,
  evaluate,
  exact,
  glob,
  matchesRule,
  parseRules,
  parseStoredRules,
  readOnlyRepositoryNotice,
  recordRule,
  selectorKey,
  selectorLabel,
  serializeRules,
  serializeStoredRules,
  sessionGrantsFromRules,
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

test("an operation path keeps a final symlink and resolves only its parent", async () => {
  // arrange
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "pi-path-permissions-")));
  const directory = join(fixture, "directory");
  const linkedDirectory = join(fixture, "linked-directory");
  const target = join(fixture, "target.txt");
  await mkdir(directory);
  await writeFile(target, "target\n");
  await symlink(directory, linkedDirectory);
  await symlink(target, join(directory, "link"));
  const expectedLinkPath = join(directory, "link");

  try {
    // act
    const preserved = await resolveOperationPath(join(linkedDirectory, "link"), PathResolution.PreserveFinalSymlink);
    const followed = await resolveOperationPath(join(linkedDirectory, "link"), PathResolution.Follow);

    // assert
    assert.equal(preserved, expectedLinkPath);
    assert.equal(followed, target);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a new opposite rule removes the identical rule from the other tier", () => {
  // arrange
  const session = emptyRules();
  const always = emptyRules();
  always.read.deny.set(selectorKey(tree("/tmp")), "no tmp");

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
  assert.deepEqual(always.read.deny, new Map());
});

test("deny rules win over allows and defaults", () => {
  // arrange
  const always = emptyRules();
  const session = emptyRules();
  always.read.allow.add(selectorKey(tree("/repo")));
  session.read.deny.set(selectorKey(tree("/repo/private")), undefined);

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

test("default write access excludes the repository but not the jj locks in restricted modes", () => {
  // arrange
  const options = {
    repoRoot: "/repo",
    memoryDirectory: "/memory",
    skillRoots: ["/skills"],
    agentDirectory: "/agent",
    temporaryDirectory: undefined,
    homeDirectory: "/home",
  };

  // act
  const planning = defaultAllowed("write", { ...options, agentMode: AgentMode.Planning });
  const exploring = defaultAllowed("write", { ...options, agentMode: AgentMode.Exploring });
  const normal = defaultAllowed("write", { ...options, agentMode: AgentMode.Execution });

  // assert
  const jjLocks = ["/repo/.jj/working_copy/working_copy.lock", "/repo/.jj/repo/git_import_export.lock"];
  assert.deepEqual(planning.map(selectorLabel), ["/memory/**", "/agent/plans/**", ...jjLocks]);
  assert.deepEqual(exploring.map(selectorLabel), ["/memory/**", "/agent/plans/**", ...jjLocks]);
  assert.deepEqual(normal.map(selectorLabel), ["/repo/**", "/memory/**", "/agent/plans/**"]);
});

test("a failed write names the restricted mode only while it is on", () => {
  // act
  const planningWrite = readOnlyRepositoryNotice("write", AgentMode.Planning);
  const exploringWrite = readOnlyRepositoryNotice("write", AgentMode.Exploring);
  const normalWrite = readOnlyRepositoryNotice("write", AgentMode.Execution);
  const reads = [AgentMode.Planning, AgentMode.Exploring, AgentMode.Execution].map((mode) => readOnlyRepositoryNotice("read", mode));

  // assert
  assert.match(planningWrite, /Plan mode is on/);
  assert.match(exploringWrite, /Explore mode is on/);
  assert.equal(normalWrite, "");
  assert.deepEqual(reads, ["", "", ""]);
});

test("default read access includes every trusted root", () => {
  // arrange
  const options = {
    agentMode: AgentMode.Planning,
    repoRoot: "/repo",
    memoryDirectory: "/memory",
    skillRoots: ["/skills/one", "/skills/two"],
    agentDirectory: "/agent",
    temporaryDirectory: undefined,
    homeDirectory: "/home",
  };
  const expected = ["/repo/**", "/memory/**", "/agent/plans/**", "/home/.crit/**", "/skills/one/**", "/skills/two/**"];

  // act
  const allowed = defaultAllowed("read", options);

  // assert
  assert.deepEqual(allowed.map(selectorLabel), expected);
});

test("the session temporary directory is readable and writable in every mode", () => {
  // arrange
  const options = {
    repoRoot: "/repo",
    memoryDirectory: "/memory",
    skillRoots: [],
    agentDirectory: "/agent",
    temporaryDirectory: "/scratch",
    homeDirectory: "/home",
  };

  // act
  const planningWrite = defaultAllowed("write", { ...options, agentMode: AgentMode.Planning });
  const normalWrite = defaultAllowed("write", { ...options, agentMode: AgentMode.Execution });
  const read = defaultAllowed("read", { ...options, agentMode: AgentMode.Planning });

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
  recordRule({ mode: "write", kind: "deny", tier: "session", selector: { kind: "tree", path: "/secrets" }, note: undefined }, { session: rules, always });

  // act
  const serialized = serializeRules(rules);
  const parsed = parseRules(JSON.parse(JSON.stringify(serialized)));

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

test("a protected tree inside a default tree prompts", () => {
  // arrange
  const layers = { defaults: [tree("/repo")], always: emptyRules(), session: emptyRules(), protected: [tree("/repo/pi/extensions")] };

  // act
  const protectedVerdict = evaluate("/repo/pi/extensions/foo.ts", "write", layers);
  const siblingVerdict = evaluate("/repo/README.md", "write", layers);

  // assert
  assert.equal(protectedVerdict, "prompt");
  assert.equal(siblingVerdict, "allow");
});

test("an explicit allow beats protection and a deny beats both", () => {
  // arrange
  const allowing = emptyRules();
  allowing.write.allow.add(selectorKey(tree("/repo/pi/extensions")));
  const denying = emptyRules();
  denying.write.deny.set(selectorKey(tree("/repo/pi/extensions")), undefined);
  const protectedSelectors = [tree("/repo/pi/extensions")];

  // act
  const allowed = evaluate("/repo/pi/extensions/foo.ts", "write", { defaults: [tree("/repo")], always: emptyRules(), session: allowing, protected: protectedSelectors });
  const denied = evaluate("/repo/pi/extensions/foo.ts", "write", { defaults: [tree("/repo")], always: denying, session: allowing, protected: protectedSelectors });

  // assert
  assert.equal(allowed, "allow");
  assert.equal(denied, "deny");
});

test("evaluation without protected selectors is unchanged", () => {
  // arrange
  const layers = { defaults: [tree("/repo")], always: emptyRules(), session: emptyRules() };

  // act
  const verdict = evaluate("/repo/pi/extensions/foo.ts", "write", layers);

  // assert
  assert.equal(verdict, "allow");
});

test("a tree grant covers protected selectors rooted inside it", () => {
  // arrange
  const grant = tree("/repo");

  // act
  const nestedTree = covers(grant, tree("/repo/pi/extensions"));
  const nestedExact = covers(grant, exact("/repo/pi/extensions/a.ts"));
  const nestedGlob = covers(grant, glob("/repo/agent", "*.json"));
  const outside = covers(grant, tree("/elsewhere"));

  // assert
  assert.equal(nestedTree, true);
  assert.equal(nestedExact, true);
  assert.equal(nestedGlob, true);
  assert.equal(outside, false);
});

test("an exact grant covers only the equal path and a glob grant covers nothing", () => {
  // arrange
  const target = tree("/repo/pi/extensions");

  // act
  const equal = covers(exact("/repo/pi/extensions"), target);
  const different = covers(exact("/repo/pi"), target);
  const globbed = covers(glob("/repo", "**"), target);

  // assert
  assert.equal(equal, true);
  assert.equal(different, false);
  assert.equal(globbed, false);
});

test("a child path policy keeps the parent's rule store and accepts a policy without one", () => {
  // arrange
  const policy = { version: 1, session: serializeRules(emptyRules()), readDefaults: [], writeDefaults: [] };
  const expected = [undefined, "explore", "plan", "invalid", "invalid"];

  // act
  const parsed = [
    parseChildPathPolicy(JSON.stringify(policy)),
    parseChildPathPolicy(JSON.stringify({ ...policy, ruleStore: "explore" })),
    parseChildPathPolicy(JSON.stringify({ ...policy, ruleStore: "plan" })),
    parseChildPathPolicy(JSON.stringify({ ...policy, ruleStore: "other" })),
    parseChildPathPolicy(JSON.stringify({ ...policy, ruleStore: "shared" })),
  ];

  // assert
  assert.deepEqual(parsed.map((result) => (result.kind === "valid" ? result.policy.ruleStore : result.kind)), expected);
});

test("stored rules keep one rule set per agent mode through a serialize and parse round trip", () => {
  // arrange
  const rules = emptyStoredRules();
  recordRule({ mode: "read", kind: "allow", tier: "always", selector: tree("/execution") }, { session: emptyRules(), always: rules.execution });
  recordRule({ mode: "write", kind: "deny", tier: "always", selector: exact("/plan/file"), note: undefined }, { session: emptyRules(), always: rules.plan });
  recordRule({ mode: "read", kind: "deny", tier: "always", selector: glob("/explore", "*.txt"), note: undefined }, { session: emptyRules(), always: rules.explore });

  // act
  const serialized = serializeStoredRules(rules);
  const parsed = parseStoredRules(JSON.parse(JSON.stringify(serialized)));

  // assert
  assert.equal(serialized.version, 3);
  assert.deepEqual(Object.keys(serialized).sort(), ["execution", "explore", "plan", "version"]);
  assert.deepEqual(parsed, rules);
});

test("stored rules reject a version 2 object", () => {
  // arrange
  const legacy = serializeRules(emptyRules());

  // act
  const parse = () => parseStoredRules(legacy);

  // assert
  assert.throws(parse, /Unsupported path permission rules version: 2/);
});

test("stored rules reject a version 3 object that misses a mode", () => {
  // arrange
  const { plan: _plan, ...withoutPlan } = serializeStoredRules(emptyStoredRules());

  // act
  const parse = () => parseStoredRules(withoutPlan);

  // assert
  assert.throws(parse, /Invalid path permission rules/);
});

test("a child path policy keeps the parent's agent mode and rejects unknown modes", () => {
  // arrange
  const policy = { version: 1, session: serializeRules(emptyRules()), readDefaults: [], writeDefaults: [] };
  const expected = [undefined, "planning", "invalid"];

  // act
  const parsed = [
    parseChildPathPolicy(JSON.stringify(policy)),
    parseChildPathPolicy(JSON.stringify({ ...policy, agentMode: "planning" })),
    parseChildPathPolicy(JSON.stringify({ ...policy, agentMode: "other" })),
  ];

  // assert
  assert.deepEqual(parsed.map((result) => (result.kind === "valid" ? result.policy.agentMode : result.kind)), expected);
});

test("a child path policy with malformed rules is rejected", () => {
  // arrange
  const policy = { version: 1, session: serializeRules(emptyRules()), readDefaults: [], writeDefaults: [] };

  // act
  const bogusSelector = parseChildPathPolicy(JSON.stringify({ ...policy,
    session: { version: 2, read: { allow: [{ kind: "bogus", path: "/x" }], deny: [] }, write: { allow: [], deny: [] } } }));
  const emptySession = parseChildPathPolicy(JSON.stringify({ ...policy, session: {} }));
  const relativeDefault = parseChildPathPolicy(JSON.stringify({ ...policy, readDefaults: [{ kind: "tree", path: "relative/dir" }] }));
  const globWithoutPattern = parseChildPathPolicy(JSON.stringify({ ...policy, writeDefaults: [{ kind: "glob", base: "/x" }] }));

  // assert
  for (const parsed of [bogusSelector, emptySession, relativeDefault, globWithoutPattern]) assert.equal(parsed.kind, "invalid");
});

test("a child keeps the deny notes of its parent's session rules", () => {
  // arrange
  const session = emptyRules();
  recordRule({ mode: "read", kind: "deny", tier: "session", selector: tree("/repo/private"), note: "keys inside" }, { session, always: emptyRules() });
  const encoded = serializeChildPathPolicy({ version: 1, session: serializeRules(session), readDefaults: [], writeDefaults: [] });

  const expected = "keys inside";

  // act
  const parsed = parseChildPathPolicy(encoded);

  // assert
  assert.equal(parsed.kind, "valid");
  assert.equal(inheritedRules(parsed.policy).read.deny.get(selectorKey(tree("/repo/private"))), expected);
});

test("a child path policy with absolute selectors parses", () => {
  // arrange
  const expected = [tree("/abs")];
  const policy = { version: 1, session: serializeRules(emptyRules()), readDefaults: expected, writeDefaults: [] };

  // act
  const parsed = parseChildPathPolicy(JSON.stringify(policy));

  // assert
  assert.deepEqual(parsed.kind === "valid" ? parsed.policy.readDefaults : parsed.kind, expected);
});

test("session grants list read before write and allow before deny with readable targets", () => {
  // arrange
  const rules = emptyRules();
  rules.write.deny.set(selectorKey(exact("/b")), undefined);
  rules.read.deny.set(selectorKey(glob("/c", "*.md")), undefined);
  rules.read.allow.add(selectorKey(tree("/a")));

  // act
  const grants = sessionGrantsFromRules(rules);

  // assert
  assert.deepEqual(grants, [
    { kind: "path", decision: "allow", access: "read", target: "/a/**" },
    { kind: "path", decision: "deny", access: "read", target: "/c/*.md" },
    { kind: "path", decision: "deny", access: "write", target: "/b" },
  ]);
});
