import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSkillIndex, skillLoadForReadPath, skillReferenceLabel } from "./skill-index.ts";
import type { CommandInfo, Skill } from "./skill-index.ts";

const links: Record<string, string> = {
  "/home/u/.pi/agent/skills/vcs/SKILL.md": "/home/u/config/pi/skills/vcs/SKILL.md",
  "/home/u/.pi/agent/skills/vcs/references/a.md": "/home/u/config/pi/skills/vcs/references/a.md",
};

const commands: CommandInfo[] = [
  {
    name: "skill:vcs",
    source: "skill",
    sourceInfo: { path: "/home/u/.pi/agent/skills/vcs/SKILL.md", scope: "user" },
  },
  {
    name: "skill:planning",
    source: "skill",
    sourceInfo: { path: "/home/u/config/pi/skills/planning/SKILL.md", scope: "project" },
  },
  {
    name: "sidebar",
    source: "extension",
    sourceInfo: { path: "/home/u/config/pi/extensions/sidebar/index.ts", scope: "user" },
  },
];

const vcs: Skill = { name: "vcs", level: "user" };
const planning: Skill = { name: "planning", level: "repo" };

test("buildSkillIndex keeps only skills and strips the skill: prefix", () => {
  // arrange
  // (commands above)

  // act
  const index = buildSkillIndex(commands, realPath);

  // assert
  assert.deepEqual(
    [...index],
    [
      ["/home/u/config/pi/skills/vcs/SKILL.md", vcs],
      ["/home/u/config/pi/skills/planning/SKILL.md", planning],
    ],
  );
});

test("buildSkillIndex maps project scope to repo and user and temporary scope to user", () => {
  // arrange
  const scoped = (scope: string): CommandInfo => ({
    name: `skill:${scope}`,
    source: "skill",
    sourceInfo: { path: `/x/${scope}/SKILL.md`, scope },
  });

  // act
  const levels = [...buildSkillIndex([scoped("project"), scoped("user"), scoped("temporary")], realPath).values()];

  // assert
  assert.deepEqual(levels, [
    { name: "project", level: "repo" },
    { name: "user", level: "user" },
    { name: "temporary", level: "user" },
  ]);
});

test("skillLoadForReadPath matches SKILL.md via absolute, relative, @-prefixed and symlinked paths", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);
  const cwd = "/home/u/config";

  // act
  const loads = [
    skillLoadForReadPath(index, "/home/u/config/pi/skills/planning/SKILL.md", cwd, realPath),
    skillLoadForReadPath(index, "pi/skills/planning/SKILL.md", cwd, realPath),
    skillLoadForReadPath(index, "@pi/skills/planning/SKILL.md", cwd, realPath),
    skillLoadForReadPath(index, "/home/u/.pi/agent/skills/vcs/SKILL.md", cwd, realPath),
  ];

  // assert
  assert.deepEqual(loads, [
    { kind: "skill", skill: planning },
    { kind: "skill", skill: planning },
    { kind: "skill", skill: planning },
    { kind: "skill", skill: vcs },
  ]);
});

test("skillLoadForReadPath returns other files of a skill relative to its directory, also via symlinks", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);
  const cwd = "/home/u/config";

  // act
  const loads = [
    skillLoadForReadPath(index, "/home/u/.pi/agent/skills/vcs/references/a.md", cwd, realPath),
    skillLoadForReadPath(index, "pi/skills/planning/notes/b.md", cwd, realPath),
  ];

  // assert
  assert.deepEqual(loads, [
    { kind: "reference", skill: vcs, path: "references/a.md" },
    { kind: "reference", skill: planning, path: "notes/b.md" },
  ]);
});

test("skillLoadForReadPath prefers the deepest skill directory", () => {
  // arrange
  const nested: Skill = { name: "nested", level: "user" };
  const index = buildSkillIndex(
    [
      ...commands,
      { name: "skill:nested", source: "skill", sourceInfo: { path: "/home/u/config/pi/skills/vcs/nested/SKILL.md", scope: "user" } },
    ],
    realPath,
  );

  // act
  const load = skillLoadForReadPath(index, "/home/u/config/pi/skills/vcs/nested/a.md", "/home/u", realPath);

  // assert
  assert.deepEqual(load, { kind: "reference", skill: nested, path: "a.md" });
});

test("skillLoadForReadPath ignores unrelated files, sibling directories with a shared prefix and non-string paths", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);

  // act
  const loads = [
    skillLoadForReadPath(index, "/home/u/config/README.md", "/home/u", realPath),
    skillLoadForReadPath(index, "/home/u/config/pi/skills/vcsx/a.md", "/home/u", realPath),
    skillLoadForReadPath(index, undefined, "/home/u", realPath),
    skillLoadForReadPath(index, "", "/home/u", realPath),
  ];

  // assert
  assert.deepEqual(loads, [undefined, undefined, undefined, undefined]);
});

test("skillReferenceLabel drops a leading references/ and a trailing .md only", () => {
  // arrange
  const paths = ["references/typescript.md", "scripts/check.sh", "notes/references/a.md"];
  const expected = ["typescript", "scripts/check.sh", "notes/references/a"];

  // act
  const labels = paths.map(skillReferenceLabel);

  // assert
  assert.deepEqual(labels, expected);
});

function realPath(path: string): string {
  return links[path] ?? path;
}
