import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { effectiveChildTools, restrictedModeAllowedTools } from "./mode-restrictions.ts";
import type { ToolPolicyInfo } from "../lib/tool-permission-policy.ts";

test("child permissions share owned read-only trust and deny precedence", () => {
  // arrange
  const tools = [tool("read", "files.ts"), tool("vcs_status", "vcs.ts"), tool("crit_comments", "crit.ts"),
    tool("foreign", "foreign.ts"), tool("granted", "foreign.ts"), tool("hidden", "foreign.ts", "hidden"),
    tool("question", "question.ts", "model-only")];
  const snapshot = { sessionGrants: ["granted", "hidden", "question", "absent"], sessionDenials: ["vcs_status"] };
  // act
  const allowed = restrictedModeAllowedTools(snapshot, { alwaysAllowed: ["vcs_status"], alwaysDenied: [] }, tools);
  // assert
  assert.deepEqual([...allowed], ["read", "crit_comments", "granted"]);
});

test("restricted-mode child selection intersects lists and preserves requested order", () => {
  // arrange
  const allowed = new Set(["read", "vcs_info"]);
  // act
  const results = [
    effectiveChildTools(["write", "vcs_info", "read", "read"], allowed),
    effectiveChildTools(undefined, allowed), effectiveChildTools([], allowed),
    effectiveChildTools(["write"], allowed), effectiveChildTools(undefined, new Set()),
  ];
  // assert
  assert.deepEqual(results, [["vcs_info", "read"], ["read", "vcs_info"], [], [], []]);
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
