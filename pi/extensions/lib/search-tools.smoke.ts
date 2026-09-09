// Runnable smoke test for the rg/fd-backed executes. There is no test runner for extensions,
// so this is plain node: `node pi/extensions/lib/search-tools.smoke.ts` (see the plan for the
// transient node_modules symlink that makes the bare pi import resolve).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFindExecute, createGrepExecute } from "./search-tools.ts";

const fixture = createFixture();
try {
  const grep = createGrepExecute(fixture);
  const find = createFindExecute(fixture);
  const run = async (
    execute: ReturnType<typeof createGrepExecute>,
    params: unknown,
  ) => {
    const result: any = await execute("smoke", params as any, undefined as any, undefined as any, undefined as any);
    return result.content[0].text as string;
  };

  {
    // arrange / act
    const text = await run(grep, { pattern: "transactor" });

    // assert
    const lines = text.split("\n");
    const headers = lines.filter((line) => !line.startsWith("  "));
    const rows = lines.filter((line) => line.startsWith("  "));
    assert.deepEqual(headers.sort(), ["alpha.ts", "beta.txt"], `unexpected headers: ${text}`);
    assert.equal(rows.length, 3, `expected 3 match rows, got: ${text}`);
    for (const row of rows) assert.match(row, /^  \d+: /);
    assert.ok(!text.includes("ignored.txt"), `gitignored file matched: ${text}`);
  }

  {
    // arrange / act
    const text = await run(grep, { pattern: "transactor", filesOnly: true });

    // assert
    assert.deepEqual(text.split("\n").sort(), ["alpha.ts", "beta.txt"]);
  }

  {
    // arrange / act
    const text = await run(grep, {
      pattern: "transactor",
      filesOnly: true,
      limit: 1,
    });

    // assert
    const [paths, notice] = text.split("\n\n");
    assert.equal(paths.split("\n").length, 1, `expected 1 path, got: ${text}`);
    assert.match(notice, /files limit reached/);
  }

  {
    // arrange / act
    const text = await run(grep, { pattern: "TRANSACTOR", ignoreCase: true });

    // assert
    const rows = text.split("\n").filter((line) => line.startsWith("  "));
    assert.equal(rows.length, 3, `expected 3 match rows, got: ${text}`);
  }

  {
    // arrange / act
    const text = await run(grep, { pattern: "export", path: "alpha.ts", context: 1 });

    // assert
    // The fixture file ends with a newline, so the 1-line context window after line 2 includes
    // the trailing empty "line 3" that content.split("\n") produces; that is pre-existing behavior.
    assert.equal(
      text,
      "alpha.ts\n  1- const transactor = 1;\n  2: export { transactor };\n  3- ",
    );
  }

  {
    // arrange / act
    const text = await run(grep, { pattern: "nothing-matches-this" });

    // assert
    assert.equal(text, "No matches found");
  }

  {
    // arrange / act
    const entries = (await run(find, { pattern: "**" })).split("\n");

    // assert
    assert.ok(entries.includes("alpha.ts"), `missing alpha.ts: ${entries}`);
    assert.ok(
      entries.includes("nested") || entries.includes("nested/"),
      `missing nested: ${entries}`,
    );
    assert.ok(!entries.includes("ignored.txt"), `gitignored file listed: ${entries}`);
  }

  {
    // arrange / act
    const entries = (await run(find, { pattern: "**", type: "file" })).split("\n");

    // assert
    assert.ok(entries.includes("alpha.ts"), `missing alpha.ts: ${entries}`);
    assert.ok(entries.includes("nested/gamma.ts"), `missing gamma.ts: ${entries}`);
    assert.ok(
      !entries.includes("nested") && !entries.includes("nested/"),
      `directory listed under type=file: ${entries}`,
    );
  }

  {
    // arrange / act
    const entries = (await run(find, { pattern: "**", type: "directory" })).split("\n");

    // assert
    assert.ok(
      entries.includes("nested") || entries.includes("nested/"),
      `missing nested: ${entries}`,
    );
    assert.ok(!entries.includes("alpha.ts"), `file listed under type=directory: ${entries}`);
  }

  {
    // arrange / act
    const entries = (await run(find, { pattern: "*.ts" })).split("\n");

    // assert
    assert.deepEqual(entries.sort(), ["alpha.ts", "nested/gamma.ts"]);
  }

  {
    // arrange / act
    const text = await run(find, { pattern: "**", limit: 2 });

    // assert
    assert.match(text, /results limit reached/);
  }

  console.log("smoke test passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "search-tools-"));
  writeFileSync(
    path.join(directory, "alpha.ts"),
    "const transactor = 1;\nexport { transactor };\n",
  );
  writeFileSync(path.join(directory, "beta.txt"), "transactor notes\n");
  mkdirSync(path.join(directory, "nested"));
  writeFileSync(path.join(directory, "nested", "gamma.ts"), "export const x = 1;\n");
  writeFileSync(path.join(directory, ".gitignore"), "ignored.txt\n");
  writeFileSync(path.join(directory, "ignored.txt"), "transactor hidden\n");
  // rg and fd only honor .gitignore inside a git repo, and this exercises fd's git-boundary branch.
  spawnSync("git", ["init", "-q"], { cwd: directory });
  return directory;
}
