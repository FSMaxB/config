import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ChildToolVerdict, childToolVerdict, effectiveChildTools, restrictedModeAllowedTools } from "./mode-restrictions.ts";
import type { ToolPolicyInfo } from "../lib/tool-permission-policy.ts";

test("child permissions share owned read-only trust and deny precedence", () => {
  // arrange
  const tools = [tool("read", "files.ts"), tool("grep", "files.ts"), tool("crit_comments", "crit.ts"),
    tool("foreign", "foreign.ts"), tool("granted", "foreign.ts"), tool("hidden", "foreign.ts", "hidden"),
    tool("question", "question.ts", "model-only")];
  const snapshot = { sessionGrants: ["granted", "hidden", "question", "absent"], sessionDenials: ["grep"] };
  // act
  const allowed = restrictedModeAllowedTools(snapshot, { alwaysAllowed: ["grep"], alwaysDenied: [] }, tools, false);
  // assert
  assert.deepEqual([...allowed], ["read", "crit_comments", "granted"]);
});

test("bash is admitted while the sandbox is active and a bash tool is registered", () => {
  // arrange
  const tools = [tool("read", "files.ts"), tool("bash", "foreign.ts")];
  const snapshot = { sessionGrants: [], sessionDenials: [] };
  const persisted = { alwaysAllowed: [], alwaysDenied: [] };
  // act
  const withSandbox = restrictedModeAllowedTools(snapshot, persisted, tools, true);
  const withoutSandbox = restrictedModeAllowedTools(snapshot, persisted, tools, false);
  const withoutBashTool = restrictedModeAllowedTools(snapshot, persisted, [tool("read", "files.ts")], true);
  // assert
  assert.deepEqual([...withSandbox], ["read", "bash"]);
  assert.deepEqual([...withoutSandbox], ["read"]);
  assert.deepEqual([...withoutBashTool], ["read"]);
});

test("a session or always denial keeps bash out even with an active sandbox", () => {
  // arrange
  const tools = [tool("read", "files.ts"), tool("bash", "foreign.ts")];
  // act
  const sessionDenied = restrictedModeAllowedTools({ sessionGrants: [], sessionDenials: ["bash"] }, { alwaysAllowed: [], alwaysDenied: [] }, tools, true);
  const alwaysDenied = restrictedModeAllowedTools({ sessionGrants: [], sessionDenials: [] }, { alwaysAllowed: [], alwaysDenied: ["bash"] }, tools, true);
  // assert
  assert.deepEqual([...sessionDenied], ["read"]);
  assert.deepEqual([...alwaysDenied], ["read"]);
});

test("the child checks its own sandbox before running bash", () => {
  // arrange
  const allowed = new Set(["read", "bash"]);
  // act
  const verdicts = [
    childToolVerdict("read", allowed, false),
    childToolVerdict("write", allowed, true),
    childToolVerdict("bash", allowed, true),
    childToolVerdict("bash", allowed, false),
  ];
  // assert
  assert.deepEqual(verdicts, [ChildToolVerdict.Allowed, ChildToolVerdict.Restricted, ChildToolVerdict.Allowed, ChildToolVerdict.NoSandbox]);
});

test("restricted-mode child selection intersects lists and preserves requested order", () => {
  // arrange
  const allowed = new Set(["read", "ls"]);
  // act
  const results = [
    effectiveChildTools(["write", "ls", "read", "read"], allowed),
    effectiveChildTools(undefined, allowed), effectiveChildTools([], allowed),
    effectiveChildTools(["write"], allowed), effectiveChildTools(undefined, new Set()),
  ];
  // assert
  assert.deepEqual(results, [["ls", "read"], ["read", "ls"], [], [], []]);
});

test("outside the restricted modes child selection leaves configured defaults unchanged", () => {
  // arrange
  const requested = ["read", "read", "write"];
  // act
  const selected = effectiveChildTools(requested, undefined);
  // assert
  assert.equal(selected, requested);
  assert.equal(effectiveChildTools(undefined, undefined), undefined);
  assert.deepEqual(effectiveChildTools([], undefined), []);
});

function tool(name: string, owner: string, exposure: ToolPolicyInfo["exposure"] = "direct"): ToolPolicyInfo {
  return { name, exposure, annotations: { readOnlyHint: true },
    sourceInfo: { path: fileURLToPath(new URL(`../${owner}`, import.meta.url)),
      source: "fixture", scope: "user", origin: "top-level" } };
}
