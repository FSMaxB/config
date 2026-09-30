import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { planToolPermission, trustedReadOnlyToolNames, isTrustedReadOnlyRegistration, type ToolPolicyInfo } from "./tool-permission-policy.ts";

test("only exact local owner/name pairs with read-only hints receive trust", () => {
  // arrange
  const groups = [
    ["files.ts", ["read", "ls", "find", "grep"]],
    ["vcs.ts", ["vcs_info", "vcs_status", "vcs_branches", "vcs_log", "vcs_show", "vcs_diff", "vcs_file", "vcs_blame"]],
    ["crit.ts", ["crit_comments", "crit_status"]],
  ] as const;
  const tools = groups.flatMap(([owner, names]) => names.map(name => tool(name, fileURLToPath(new URL(`../${owner}`, import.meta.url)))));
  // act
  const trusted = trustedReadOnlyToolNames(tools);
  // assert
  assert.deepEqual([...trusted], tools.map(tool => tool.name));
  for (const path of ["builtin:mcp", "<sdk:read>", "/missing-extension.ts", fileURLToPath(import.meta.url)]) {
    assert.equal(trustedReadOnlyToolNames([tool("read", path)]).size, 0);
  }
  assert.equal(trustedReadOnlyToolNames([tool("write", tools[0].sourceInfo.path)]).size, 0);
  assert.equal(trustedReadOnlyToolNames([{ ...tools[0], annotations: {} }]).size, 0);
  assert.equal(trustedReadOnlyToolNames([{ ...tools[0], sourceInfo: undefined } as never]).size, 0);
});

test("canonical ownership accepts the installed extension symlink", () => {
  // arrange
  const directory = mkdtempSync(join(tmpdir(), "tool-owner-"));
  const link = join(directory, "files.ts");
  symlinkSync(fileURLToPath(new URL("../files.ts", import.meta.url)), link);
  try {
    // act
    const trusted = trustedReadOnlyToolNames([tool("read", link)]);
    // assert
    assert.deepEqual([...trusted], ["read"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("existing synthetic-path symlinks cannot acquire trusted ownership", () => {
  // arrange
  const directory = mkdtempSync(join(tmpdir(), "synthetic-tool-owner-"));
  const previousCwd = process.cwd();
  for (const name of ["builtin:read", "<sdk:read>"]) {
    symlinkSync(fileURLToPath(new URL("../files.ts", import.meta.url)), join(directory, name));
  }
  process.chdir(directory);
  try {
    // act
    const trusted = trustedReadOnlyToolNames([tool("read", "builtin:read"), tool("read", "<sdk:read>")]);
    // assert
    assert.equal(trusted.size, 0);
  } finally {
    process.chdir(previousCwd);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pure provenance classification rejects unapproved names and owners", () => {
  // arrange
  const owners = new Map([["/owned/files.ts", new Set(["read"])]]);
  // act
  const verdicts = [
    { name: "read", readOnlyHint: true, ownerPath: "/owned/files.ts" },
    { name: "read", readOnlyHint: true, ownerPath: "/foreign/files.ts" },
    { name: "write", readOnlyHint: true, ownerPath: "/owned/files.ts" },
    { name: "read", ownerPath: "/owned/files.ts" },
  ].map(tool => isTrustedReadOnlyRegistration(tool, owners));
  // assert
  assert.deepEqual(verdicts, [true, false, false, false]);
});

test("denials override grants, trusted hints, and special permissions", () => {
  // arrange
  const decisions = { sessionGrants: ["granted", "denied"], alwaysGrants: ["always"],
    sessionDenials: ["denied"], alwaysDenials: ["trusted-denied"] };
  const trusted = new Set(["trusted", "trusted-denied"]);
  const special = new Set(["special", "denied"]);
  // act
  const results = ["granted", "always", "trusted", "special", "denied", "trusted-denied", "foreign"]
    .map(name => planToolPermission(name, decisions, special, trusted));
  // assert
  assert.deepEqual(results, ["allow", "allow", "allow", "allow", "deny", "deny", "approval"]);
});

function tool(name: string, path: string): ToolPolicyInfo {
  return { name, exposure: "direct", annotations: { readOnlyHint: true },
    sourceInfo: { path, source: "fixture", scope: "user", origin: "top-level" } };
}
