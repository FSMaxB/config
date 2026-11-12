import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSkillIndex,
  type CommandInfo,
  LOADED_SKILL_ENTRY,
  loadedSkillsOnBranch,
  type RealPath,
  skillForReadPath,
  skillFromUserContent,
} from "./skills.ts";

const links: Record<string, string> = {
  "/home/u/.pi/agent/skills/vcs/SKILL.md": "/home/u/config/pi/skills/vcs/SKILL.md",
};
const realPath: RealPath = (path) => links[path] ?? path;

const commands: CommandInfo[] = [
  { name: "skill:vcs", source: "skill", sourceInfo: { path: "/home/u/.pi/agent/skills/vcs/SKILL.md" } },
  { name: "skill:planning", source: "skill", sourceInfo: { path: "/home/u/config/pi/skills/planning/SKILL.md" } },
  { name: "sidebar", source: "extension", sourceInfo: { path: "/home/u/config/pi/extensions/sidebar/index.ts" } },
];

test("buildSkillIndex keeps only skills and strips the skill: prefix", () => {
  // arrange
  // (commands above)

  // act
  const index = buildSkillIndex(commands, realPath);

  // assert
  assert.deepEqual(
    [...index],
    [
      ["/home/u/config/pi/skills/vcs/SKILL.md", "vcs"],
      ["/home/u/config/pi/skills/planning/SKILL.md", "planning"],
    ],
  );
});

test("skillForReadPath matches absolute, relative, @-prefixed and symlinked paths", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);
  const cwd = "/home/u/config";

  // act
  const matches = [
    skillForReadPath(index, "/home/u/config/pi/skills/planning/SKILL.md", cwd, realPath),
    skillForReadPath(index, "pi/skills/planning/SKILL.md", cwd, realPath),
    skillForReadPath(index, "@pi/skills/planning/SKILL.md", cwd, realPath),
    skillForReadPath(index, "/home/u/.pi/agent/skills/vcs/SKILL.md", cwd, realPath),
  ];

  // assert
  assert.deepEqual(matches, ["planning", "planning", "planning", "vcs"]);
});

test("skillForReadPath ignores other files and non-string paths", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);

  // act
  const matches = [
    skillForReadPath(index, "/home/u/config/README.md", "/home/u", realPath),
    skillForReadPath(index, undefined, "/home/u", realPath),
    skillForReadPath(index, "", "/home/u", realPath),
  ];

  // assert
  assert.deepEqual(matches, [undefined, undefined, undefined]);
});

test("skillFromUserContent reads the name from string and text-block content", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);
  const block = '<skill name="vcs" location="/x/SKILL.md">\nbody\n</skill>';

  // act
  const matches = [skillFromUserContent(index, block), skillFromUserContent(index, [{ type: "text", text: block }])];

  // assert
  assert.deepEqual(matches, ["vcs", "vcs"]);
});

test("skillFromUserContent ignores plain text and unknown skills", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);

  // act
  const matches = [
    skillFromUserContent(index, "hello"),
    skillFromUserContent(index, '<skill name="nope" location="/x/SKILL.md">'),
    skillFromUserContent(index, undefined),
  ];

  // assert
  assert.deepEqual(matches, [undefined, undefined, undefined]);
});

test("loadedSkillsOnBranch keeps order, drops duplicates and ignores other entries", () => {
  // arrange
  const entries = [
    { type: "custom", customType: LOADED_SKILL_ENTRY, data: { name: "vcs" } },
    { type: "custom", customType: "other", data: { name: "ignored" } },
    { type: "message" },
    { type: "custom", customType: LOADED_SKILL_ENTRY, data: { name: "planning" } },
    { type: "custom", customType: LOADED_SKILL_ENTRY, data: { name: "vcs" } },
    { type: "custom", customType: LOADED_SKILL_ENTRY, data: {} },
  ];

  // act
  const names = loadedSkillsOnBranch(entries);

  // assert
  assert.deepEqual(names, ["vcs", "planning"]);
});
