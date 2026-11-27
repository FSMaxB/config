import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGrant } from "../lib/session-grants.ts";
import { grantRows } from "./grants.ts";

test("rows are grouped by kind in a fixed order", () => {
  // arrange
  const grants: SessionGrant[] = [
    { kind: "network", decision: "allow", host: "example.com" },
    { kind: "unsandboxed", decision: "allow" },
    { kind: "profile", decision: "allow", name: "bazel" },
    { kind: "tool", decision: "deny", name: "fetch_content" },
    { kind: "path", decision: "allow", access: "read", target: "/home/u/x/**" },
    { kind: "subagent-provider", decision: "allow", provider: "openai" },
  ];

  // act
  const rows = grantRows(grants, "/home/u");

  // assert
  assert.deepEqual(rows, [
    "✓ read ~/x/**",
    "✗ tool fetch_content",
    "✓ net example.com",
    "✓ profile bazel",
    "✓ unsandboxed bash",
    "✓ subagent openai",
  ]);
});

test("grants of the same kind keep their input order", () => {
  // arrange
  const grants: SessionGrant[] = [
    { kind: "network", decision: "deny", host: "b.example" },
    { kind: "tool", decision: "allow", name: "web_search" },
    { kind: "network", decision: "allow", host: "a.example" },
  ];

  // act
  const rows = grantRows(grants, "/home/u");

  // assert
  assert.deepEqual(rows, ["✓ tool web_search", "✗ net b.example", "✓ net a.example"]);
});

test("only paths inside the home directory are shortened", () => {
  // arrange
  const targets = ["/home/u", "/home/u/docs", "/home/u2/x", "/etc/x"];
  const grants = targets.map((target): SessionGrant => ({ kind: "path", decision: "allow", access: "write", target }));

  // act
  const rows = grantRows(grants, "/home/u");

  // assert
  assert.deepEqual(rows, ["✓ write ~", "✓ write ~/docs", "✓ write /home/u2/x", "✓ write /etc/x"]);
});
