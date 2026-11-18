import assert from "node:assert/strict";
import { test } from "node:test";
import { ItemTone } from "./panel.ts";
import { LOADED_PLAN_ENTRY, planItems, planPathForToolPath, plansOnBranch, withPlan } from "./plans.ts";
import type { RealPath } from "./tool-path.ts";

const root = "/home/u/.pi/agent/plans";
const plan = `${root}/Users-u-config/20261116-1401-sidebar.md`;

const links: Record<string, string> = {
  "/home/u/link.md": plan,
};
const realPath: RealPath = (path) => links[path] ?? path;

test("planPathForToolPath returns the path of a Markdown file in a cwd-slug directory", () => {
  // arrange
  const rawPath = plan;

  // act
  const result = planPathForToolPath(root, rawPath, "/home/u/config", realPath);

  // assert
  assert.equal(result, plan);
});

test("planPathForToolPath resolves relative and @-prefixed paths against cwd", () => {
  // arrange
  const cwd = `${root}/Users-u-config`;

  // act
  const relative = planPathForToolPath(root, "20261116-1401-sidebar.md", cwd, realPath);
  const prefixed = planPathForToolPath(root, "@20261116-1401-sidebar.md", cwd, realPath);

  // assert
  assert.equal(relative, plan);
  assert.equal(prefixed, plan);
});

test("planPathForToolPath follows a symlink to its target", () => {
  // arrange
  const rawPath = "/home/u/link.md";

  // act
  const result = planPathForToolPath(root, rawPath, "/home/u", realPath);

  // assert
  assert.equal(result, plan);
});

test("planPathForToolPath ignores everything but Markdown files under the plans root", () => {
  // arrange
  const cwd = "/home/u/config";

  // act
  const nonMarkdown = planPathForToolPath(root, `${root}/Users-u-config/.jj/repo/store/x`, cwd, realPath);
  const outside = planPathForToolPath(root, "/home/u/config/AGENTS.md", cwd, realPath);
  const sibling = planPathForToolPath(root, "/home/u/.pi/agent/plans-old/x.md", cwd, realPath);
  const notAString = planPathForToolPath(root, 42, cwd, realPath);
  const empty = planPathForToolPath(root, "", cwd, realPath);

  // assert
  assert.equal(nonMarkdown, undefined);
  assert.equal(outside, undefined);
  assert.equal(sibling, undefined);
  assert.equal(notAString, undefined);
  assert.equal(empty, undefined);
});

test("withPlan appends a new plan and returns undefined for a known one", () => {
  // arrange
  const plans = ["/a.md"];

  // act
  const added = withPlan(plans, "/b.md");
  const known = withPlan(plans, "/a.md");

  // assert
  assert.deepEqual(added, ["/a.md", "/b.md"]);
  assert.equal(known, undefined);
});

test("plansOnBranch keeps first-load order, deduplicates and ignores unrelated entries", () => {
  // arrange
  const entries = [
    { type: "custom", customType: LOADED_PLAN_ENTRY, data: { path: "/b.md" } },
    { type: "message" },
    { type: "custom", customType: "loaded-skill", data: { path: "/skill.md" } },
    { type: "custom", customType: LOADED_PLAN_ENTRY, data: { path: "/a.md" } },
    { type: "custom", customType: LOADED_PLAN_ENTRY, data: { path: "/b.md" } },
    { type: "custom", customType: LOADED_PLAN_ENTRY, data: { path: 7 } },
    { type: "custom", customType: LOADED_PLAN_ENTRY },
  ];

  // act
  const result = plansOnBranch(entries);

  // assert
  assert.deepEqual(result, ["/b.md", "/a.md"]);
});

test("planItems shows the filename without the extension", () => {
  // arrange
  const plans = [plan];

  // act
  const items = planItems(plans);

  // assert
  assert.deepEqual(items, [{ text: "20261116-1401-sidebar", depth: 0, tone: ItemTone.Normal }]);
});
