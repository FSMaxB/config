import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { planModeAllowedTools } from "./plan-restrictions.ts";
import type { ToolPolicyInfo } from "../lib/tool-permission-policy.ts";

test("child permissions share owned read-only trust and deny precedence", () => {
  // arrange
  const tools = [tool("read", "files.ts"), tool("vcs_status", "vcs.ts"), tool("crit_comments", "crit.ts"),
    tool("foreign", "foreign.ts"), tool("granted", "foreign.ts"), tool("hidden", "foreign.ts", "hidden"),
    tool("question", "question.ts", "model-only")];
  const snapshot = { sessionGrants: ["granted", "hidden", "question", "absent"], sessionDenials: ["vcs_status"] };
  // act
  const allowed = planModeAllowedTools(snapshot, { alwaysAllowed: ["vcs_status"], alwaysDenied: [] }, tools);
  // assert
  assert.deepEqual([...allowed], ["read", "crit_comments", "granted"]);
});

function tool(name: string, owner: string, exposure: ToolPolicyInfo["exposure"] = "direct"): ToolPolicyInfo {
  return { name, exposure, annotations: { readOnlyHint: true },
    sourceInfo: { path: fileURLToPath(new URL(`../${owner}`, import.meta.url)),
      source: "fixture", scope: "user", origin: "top-level" } };
}
