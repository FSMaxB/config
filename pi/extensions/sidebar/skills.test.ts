import assert from "node:assert/strict";
import { test } from "node:test";
import { ItemTone } from "./panel.ts";
import {
  applySkillLoad,
  buildSkillIndex,
  LOADED_SKILL_ENTRY,
  LOADED_SKILL_REFERENCE_ENTRY,
  SkillState,
  skillItems,
  skillLoadForReadPath,
  skillLoadFromUserContent,
  skillsOnBranch,
} from "./skills.ts";
import type {
  CommandInfo,
  Skill,
  SkillOnBranch,
} from "./skills.ts";
import type { RealPath } from "./tool-path.ts";

const links: Record<string, string> = {
  "/home/u/.pi/agent/skills/vcs/SKILL.md": "/home/u/config/pi/skills/vcs/SKILL.md",
  "/home/u/.pi/agent/skills/vcs/references/a.md": "/home/u/config/pi/skills/vcs/references/a.md",
};
const realPath: RealPath = (path) => links[path] ?? path;

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

test("skillLoadFromUserContent reads the name from string and text-block content", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);
  const block = '<skill name="vcs" location="/x/SKILL.md">\nbody\n</skill>';

  // act
  const loads = [
    skillLoadFromUserContent(index, block),
    skillLoadFromUserContent(index, [{ type: "text", text: block }]),
  ];

  // assert
  assert.deepEqual(loads, [
    { kind: "skill", skill: vcs },
    { kind: "skill", skill: vcs },
  ]);
});

test("skillLoadFromUserContent ignores plain text and unknown skills", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);

  // act
  const loads = [
    skillLoadFromUserContent(index, "hello"),
    skillLoadFromUserContent(index, '<skill name="nope" location="/x/SKILL.md">'),
    skillLoadFromUserContent(index, undefined),
  ];

  // assert
  assert.deepEqual(loads, [undefined, undefined, undefined]);
});

test("applySkillLoad lists a skill read only through a reference, then loads it in place", () => {
  // arrange
  const other: SkillOnBranch = { skill: planning, state: SkillState.Loaded, references: [] };
  const start = [other];

  // act
  const withReference = applySkillLoad(start, { kind: "reference", skill: vcs, path: "references/a.md" });
  const loaded = withReference && applySkillLoad(withReference, { kind: "skill", skill: vcs });
  const referenced = loaded && applySkillLoad(loaded, { kind: "reference", skill: planning, path: "b.md" });

  // assert
  assert.deepEqual(withReference, [
    other,
    { skill: vcs, state: SkillState.ReferencesOnly, references: ["references/a.md"] },
  ]);
  assert.deepEqual(loaded, [other, { skill: vcs, state: SkillState.Loaded, references: ["references/a.md"] }]);
  assert.deepEqual(referenced?.map((entry) => entry.skill.name), ["planning", "vcs"]);
});

test("applySkillLoad returns undefined when nothing changes", () => {
  // arrange
  const skills: SkillOnBranch[] = [{ skill: vcs, state: SkillState.Loaded, references: ["references/a.md"] }];

  // act
  const changes = [
    applySkillLoad(skills, { kind: "skill", skill: vcs }),
    applySkillLoad(skills, { kind: "reference", skill: vcs, path: "references/a.md" }),
  ];

  // assert
  assert.deepEqual(changes, [undefined, undefined]);
});

test("skillsOnBranch keeps order, drops duplicates and ignores other and malformed entries", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);
  const entries = [
    { type: "custom", customType: LOADED_SKILL_ENTRY, data: { name: "vcs" } },
    { type: "custom", customType: "other", data: { name: "ignored" } },
    { type: "message" },
    { type: "custom", customType: LOADED_SKILL_REFERENCE_ENTRY, data: { skill: "planning", path: "a.md" } },
    { type: "custom", customType: LOADED_SKILL_ENTRY, data: { name: "vcs" } },
    { type: "custom", customType: LOADED_SKILL_REFERENCE_ENTRY, data: { skill: "planning", path: "a.md" } },
    { type: "custom", customType: LOADED_SKILL_REFERENCE_ENTRY, data: { skill: "planning" } },
    { type: "custom", customType: LOADED_SKILL_ENTRY, data: {} },
  ];

  // act
  const skills = skillsOnBranch(entries, index);

  // assert
  assert.deepEqual(skills, [
    { skill: vcs, state: SkillState.Loaded, references: [] },
    { skill: planning, state: SkillState.ReferencesOnly, references: ["a.md"] },
  ]);
});

test("skillsOnBranch treats recorded skills missing from the index as user skills", () => {
  // arrange
  const index = buildSkillIndex(commands, realPath);
  const entries = [
    { type: "custom", customType: LOADED_SKILL_ENTRY, data: { name: "removed" } },
    { type: "custom", customType: LOADED_SKILL_REFERENCE_ENTRY, data: { skill: "gone", path: "a.md" } },
  ];

  // act
  const skills = skillsOnBranch(entries, index);

  // assert
  assert.deepEqual(skills, [
    { skill: { name: "removed", level: "user" }, state: SkillState.Loaded, references: [] },
    { skill: { name: "gone", level: "user" }, state: SkillState.ReferencesOnly, references: ["a.md"] },
  ]);
});

test("skillItems emits each skill with its references one level deeper and dims reference-only skills", () => {
  // arrange
  const skills: SkillOnBranch[] = [
    { skill: vcs, state: SkillState.Loaded, references: ["references/a.md", "references/b.md"] },
    { skill: planning, state: SkillState.ReferencesOnly, references: ["notes.md"] },
    { skill: { name: "lonely", level: "user" }, state: SkillState.ReferencesOnly, references: [] },
  ];

  // act
  const user = skillItems(skills, "user");
  const repo = skillItems(skills, "repo");

  // assert
  assert.deepEqual(user, [
    { text: "vcs", depth: 0, tone: ItemTone.Normal },
    { text: "a", depth: 1, tone: ItemTone.Normal },
    { text: "b", depth: 1, tone: ItemTone.Normal },
    { text: "lonely", depth: 0, tone: ItemTone.Dim },
  ]);
  assert.deepEqual(repo, [
    { text: "planning", depth: 0, tone: ItemTone.Dim },
    { text: "notes", depth: 1, tone: ItemTone.Normal },
  ]);
});
