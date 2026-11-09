import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { globToRegex } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { selectorLabel } from "../../lib/path-permission-rules.ts";
import { scanVcsLayout, vcsWriteRules, type DirectoryListing, type VcsLayout } from "./vcs-policy.ts";

const REPO = "/Users/max/repo";

interface Tree { [name: string]: Tree | "file" }

function layoutOf(tree: Tree, repoRoot = REPO): VcsLayout {
  const listings = new Map<string, DirectoryListing>();
  const register = (path: string, node: Tree): void => {
    listings.set(path, { path, entries: Object.entries(node).map(([name, child]) => ({ name, directory: child !== "file" })) });
    for (const [name, child] of Object.entries(node)) if (child !== "file") register(join(path, name), child);
  };
  for (const [name, child] of Object.entries(tree)) if (child !== "file") register(join(repoRoot, name), child);
  return { repoRoot, listings };
}

const COLOCATED: Tree = {
  ".git": {
    HEAD: "file", config: "file", description: "file", index: "file", "index.lock": "file", "packed-refs": "file",
    hooks: {}, info: { exclude: "file", refs: "file" }, objects: {}, refs: {}, logs: {}, lfs: {},
  },
  ".jj": {
    ".gitignore": "file",
    repo: { "config-id": "file", type: "file", workspace_store: {}, op_store: {}, op_heads: {}, index: {}, store: { type: "file", git_target: "file", extra: {} } },
    working_copy: { checkout: "file", tree_state: "file", type: "file", ".tmpAbc123": "file", "working_copy.lock": "file" },
  },
};

test("everything git and jj do not need is denied", () => {
  // arrange
  const layout = layoutOf(COLOCATED);

  // act
  const { deny } = vcsWriteRules(layout, "darwin");

  // assert
  for (const path of [
    ".git/config", ".git/hooks", ".git/description", ".git/info/exclude", ".jj/.gitignore", ".jj/repo/config-id", ".jj/repo/type",
    ".jj/repo/workspace_store", ".jj/repo/store/git_target", ".jj/repo/store/type", ".jj/working_copy/type",
  ]) {
    assert.ok(deny.includes(join(REPO, path)), `${path} must be denied`);
  }
});

test("what git and jj write during normal operation is not denied", () => {
  // arrange
  const layout = layoutOf(COLOCATED);

  // act
  const { deny } = vcsWriteRules(layout, "linux");

  // assert
  for (const path of [
    ".git/objects", ".git/refs", ".git/HEAD", ".git/index", ".git/index.lock", ".git/packed-refs", ".git/info/refs", ".git/lfs", ".jj/repo/op_store",
    ".jj/repo/op_heads", ".jj/repo/index", ".jj/repo/store/extra", ".jj/working_copy/checkout", ".jj/working_copy/tree_state",
    ".jj/working_copy/.tmpAbc123", ".jj/working_copy/working_copy.lock", ".jj/repo",
  ]) {
    assert.ok(!deny.includes(join(REPO, path)), `${path} must not be denied`);
  }
});

test("absent names that must stay absent are denied on darwin", () => {
  // arrange
  const layout = layoutOf(COLOCATED);

  // act
  const { deny } = vcsWriteRules(layout, "darwin");

  // assert
  for (const path of [".git/commondir", ".git/modules", ".git/worktrees", ".git/remotes", ".git/branches", ".git/config.worktree", ".jj/repo/config.toml", ".jj/workspace-config.toml"]) {
    assert.ok(deny.includes(join(REPO, path)), `${path} must be denied while absent`);
  }
});

test("linux skips the absent names whose placeholder file would break git", () => {
  // arrange
  const layout = layoutOf(COLOCATED);

  // act
  const { deny } = vcsWriteRules(layout, "linux");

  // assert
  assert.ok(!deny.includes(join(REPO, ".git/commondir")));
  assert.ok(deny.includes(join(REPO, ".git/modules")));
  assert.ok(deny.includes(join(REPO, ".git/hooks")));
});

test("files in .git/info that git reads stay denied while absent", () => {
  // arrange
  const layout = layoutOf({ ".git": { info: { refs: "file" } } });

  // act
  const { deny } = vcsWriteRules(layout, "linux");

  // assert
  for (const name of ["exclude", "attributes", "sparse-checkout", "grafts"]) {
    assert.ok(deny.includes(join(REPO, ".git/info", name)), `.git/info/${name} must be denied while absent`);
  }
  assert.ok(!deny.includes(join(REPO, ".git/info/refs")));
});

test("linux denies an absent config.toml only when its config-id exists", () => {
  // arrange
  const withId = layoutOf(COLOCATED);
  const withoutId = layoutOf({ ...COLOCATED, ".jj": { ...(COLOCATED[".jj"] as Tree), repo: { op_store: {} } } });

  // act
  const covered = vcsWriteRules(withId, "linux");
  const exposed = vcsWriteRules(withoutId, "linux");

  // assert
  assert.ok(covered.deny.includes(join(REPO, ".jj/repo/config.toml")));
  assert.ok(!covered.deny.includes(join(REPO, ".jj/workspace-config.toml")), "the workspace id is missing in this layout");
  assert.deepEqual(covered.missingConfigIds, [join(REPO, ".jj/workspace-config-id")]);
  assert.ok(!exposed.deny.includes(join(REPO, ".jj/repo/config.toml")));
  assert.deepEqual([...exposed.missingConfigIds].sort(), [join(REPO, ".jj/repo/config-id"), join(REPO, ".jj/workspace-config-id")]);
});

test("darwin never reports a missing config-id", () => {
  // arrange
  const layout = layoutOf({ ".jj": { repo: {} } });

  // act
  const rules = vcsWriteRules(layout, "darwin");

  // assert
  assert.deepEqual(rules.missingConfigIds, []);
});

test("a nested git directory of a non-colocated jj repository is protected like .git", () => {
  // arrange
  const nested = { HEAD: "file", config: "file", hooks: {}, objects: {}, refs: {} } satisfies Tree;
  const layout = layoutOf({ ".jj": { repo: { store: { git: nested, extra: {} } } } });

  // act
  const { deny, repositoryAllow } = vcsWriteRules(layout, "darwin");

  // assert
  assert.ok(deny.includes(join(REPO, ".jj/repo/store/git/config")));
  assert.ok(deny.includes(join(REPO, ".jj/repo/store/git/hooks")));
  assert.ok(!deny.includes(join(REPO, ".jj/repo/store/git/objects")));
  assert.ok(repositoryAllow.map(selectorLabel).includes(join(REPO, ".jj/repo/store/git/objects/**")));
});

test("a directory that should be a directory but is a file is denied", () => {
  // arrange
  const layout = layoutOf({ ".jj": { repo: "file", working_copy: {} } });

  // act
  const { deny } = vcsWriteRules(layout, "linux");

  // assert
  assert.ok(deny.includes(join(REPO, ".jj/repo")));
});

test("a .git file is denied as a whole", () => {
  // arrange
  const layout: VcsLayout = { ...layoutOf({}), gitFile: join(REPO, ".git") };

  // act
  const { deny, vcsDirectories } = vcsWriteRules(layout, "darwin");

  // assert
  assert.deepEqual(deny, [join(REPO, ".git")]);
  assert.deepEqual(vcsDirectories, [join(REPO, ".git")]);
});

test("the allowlist becomes write selectors on darwin and stays empty on linux", () => {
  // arrange
  const layout = layoutOf(COLOCATED);

  // act
  const darwin = vcsWriteRules(layout, "darwin").repositoryAllow.map(selectorLabel);
  const linux = vcsWriteRules(layout, "linux").repositoryAllow;

  // assert
  for (const path of [".git/objects/**", ".git/HEAD", ".git/HEAD.lock", ".git/index.lock", ".jj/repo/op_store/**", ".jj/working_copy/tree_state", ".jj/working_copy/.tmp*"]) {
    assert.ok(darwin.includes(join(REPO, path)), `${path} must be allowed`);
  }
  assert.deepEqual(linux, []);
});

test("a repository without VCS directories keeps its plain repository allow", () => {
  // arrange
  const layout = layoutOf({});

  // act
  const rules = vcsWriteRules(layout, "darwin");

  // assert
  assert.deepEqual(rules.repositoryAllow, []);
  assert.deepEqual(rules.deny, []);
  assert.deepEqual(rules.vcsDirectories, []);
});

test("the complement of the VCS directories covers everything else, in both cases", () => {
  // arrange
  const matchers = vcsWriteRules(layoutOf(COLOCATED), "darwin").repositoryAllow
    .filter((selector) => selector.kind === "glob")
    .map((selector) => new RegExp(globToRegex(`${selector.base}/${selector.pattern}`)));
  const writable = (path: string) => matchers.some((matcher) => matcher.test(join(REPO, path)));

  // act
  const blocked = [".git", ".git/config", ".GIT/config", ".Git/x", ".gIT/x", ".jj", ".jj/repo/config.toml", ".JJ/x", ".Jj", ".jJ/x"].filter(writable);
  const open = ["src/a.ts", "src/deep/er/b.ts", "README.md", ".github/workflows/x.yml", ".gitignore", ".gi", ".jjconfig", ".env", ".vim/x", ".g", ".j", "a", "Zed/b/c"]
    .filter((path) => !writable(path));

  // assert
  assert.deepEqual(blocked, []);
  assert.deepEqual(open, []);
});

test("a repository root with glob characters keeps its plain repository allow", () => {
  // arrange
  const layout = layoutOf(COLOCATED, "/Users/max/odd[1]");

  // act
  const rules = vcsWriteRules(layout, "darwin");

  // assert
  assert.deepEqual(rules.repositoryAllow, []);
  assert.ok(rules.deny.length > 0);
});

test("scanVcsLayout lists the directories the specs describe and does not follow symlinks", async () => {
  // arrange
  const root = await mkdtemp(join(tmpdir(), "vcs-layout-"));
  try {
    execFileSync("git", ["init", "--quiet", "--template=", root]);
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "exclude"), "");
    await mkdir(join(root, ".jj", "repo", "store", "git"), { recursive: true });
    await mkdir(join(root, ".jj", "working_copy"), { recursive: true });
    await writeFile(join(root, ".jj", "repo", "config-id"), "id");
    await writeFile(join(root, ".jj", "repo", "store", "git_target"), "../../../.git");
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, ".jj", "repo", "op_store"));

    // act
    const layout = await scanVcsLayout(root);

    // assert
    const names = (path: string) => layout.listings.get(join(root, path))?.entries.map((entry) => entry.name).sort();
    assert.ok(names(".git")?.includes("objects"));
    assert.ok(names(".git/info")?.includes("exclude"));
    assert.deepEqual(names(".jj/repo/store"), ["git", "git_target"]);
    assert.ok(layout.listings.has(join(root, ".jj", "repo", "store", "git")));
    assert.ok(layout.listings.has(join(root, ".jj", "working_copy")));
    const symlinked = layout.listings.get(join(root, ".jj", "repo"))?.entries.find((entry) => entry.name === "op_store");
    assert.equal(symlinked?.directory, false);
    assert.equal(layout.gitFile, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanVcsLayout treats a missing VCS directory as absent and a .git file as a gitFile", async () => {
  // arrange
  const root = await mkdtemp(join(tmpdir(), "vcs-layout-"));
  try {
    const empty = await scanVcsLayout(root);
    await writeFile(join(root, ".git"), "gitdir: /elsewhere");

    // act
    const withFile = await scanVcsLayout(root);

    // assert
    assert.equal(empty.listings.size, 0);
    assert.equal(empty.gitFile, undefined);
    assert.equal(withFile.listings.size, 0);
    assert.equal(withFile.gitFile, join(root, ".git"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
