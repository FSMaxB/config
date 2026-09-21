// Runnable smoke test for the rg/fd-backed executes. There is no test runner for extensions,
// so this is plain node: `node pi/extensions/lib/search-tools.smoke.ts` (see the plan for the
// transient node_modules symlink that makes the bare pi import resolve).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFindExecute,
  createGrepExecute,
  createLsExecute,
} from "./search-tools.ts";
import { createLsToolDefinition } from "@earendil-works/pi-coding-agent";

const fixture = createFixture();
try {
  const grep = createGrepExecute(fixture);
  const find = createFindExecute(fixture);
  const stockLs = createLsToolDefinition(fixture).execute;
  const ls = createLsExecute(fixture, stockLs);
  const run = async (
    execute: ReturnType<typeof createGrepExecute>,
    params: unknown,
    signal?: AbortSignal,
  ) => {
    const result: any = await execute(
      "smoke",
      params as any,
      signal as any,
      undefined as any,
      undefined as any,
    );
    return {
      text: result.content[0].text as string,
      details: result.details,
    };
  };

  {
    // arrange / act
    const { text } = await run(grep, { pattern: "transactor" });

    // assert
    const lines = text.split("\n");
    const headers = lines.filter((line) => !line.startsWith("  "));
    const rows = lines.filter((line) => line.startsWith("  "));
    assert.deepEqual(
      headers.sort(),
      ["alpha.ts", "beta.txt"],
      `unexpected headers: ${text}`,
    );
    assert.equal(rows.length, 3, `expected 3 match rows, got: ${text}`);
    for (const row of rows) assert.match(row, /^  \d+: /);
    assert.ok(
      !text.includes("ignored.txt"),
      `gitignored file matched: ${text}`,
    );
  }

  {
    // arrange / act
    const { text } = await run(grep, {
      pattern: "transactor",
      filesOnly: true,
    });

    // assert
    assert.deepEqual(text.split("\n").sort(), ["alpha.ts", "beta.txt"]);
  }

  {
    // arrange / act
    const { text } = await run(grep, {
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
    const { text } = await run(grep, {
      pattern: "TRANSACTOR",
      ignoreCase: true,
    });

    // assert
    const rows = text.split("\n").filter((line) => line.startsWith("  "));
    assert.equal(rows.length, 3, `expected 3 match rows, got: ${text}`);
  }

  {
    // arrange / act
    const { text } = await run(grep, {
      pattern: "export",
      path: "alpha.ts",
      context: 1,
    });

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
    const { text } = await run(grep, { pattern: "nothing-matches-this" });

    // assert
    assert.equal(text, "No matches found");
  }

  {
    // arrange / act
    const { text } = await run(find, { pattern: "**" });
    const entries = flattenFind(text);

    // assert
    assert.ok(entries.includes("alpha.ts"), `missing alpha.ts: ${entries}`);
    assert.ok(
      entries.includes("nested") || entries.includes("nested/"),
      `missing nested: ${entries}`,
    );
    assert.ok(
      !entries.includes("ignored.txt"),
      `gitignored file listed: ${entries}`,
    );
  }

  {
    // arrange / act
    const { text } = await run(find, { pattern: "**", type: "file" });
    const entries = flattenFind(text);

    // assert
    assert.ok(entries.includes("alpha.ts"), `missing alpha.ts: ${entries}`);
    assert.ok(
      entries.includes("nested/gamma.ts"),
      `missing gamma.ts: ${entries}`,
    );
    assert.ok(
      !entries.includes("nested") && !entries.includes("nested/"),
      `directory listed under type=file: ${entries}`,
    );
  }

  {
    // arrange / act
    const { text } = await run(find, { pattern: "**", type: "directory" });
    const entries = flattenFind(text);

    // assert
    assert.ok(
      entries.includes("nested") || entries.includes("nested/"),
      `missing nested: ${entries}`,
    );
    assert.ok(
      !entries.includes("alpha.ts"),
      `file listed under type=directory: ${entries}`,
    );
  }

  {
    // arrange / act
    const { text } = await run(find, { pattern: "*.ts" });
    const entries = flattenFind(text);

    // assert
    assert.deepEqual(entries.sort(), ["alpha.ts", "nested/gamma.ts"]);
  }

  {
    // arrange / act
    const { text } = await run(find, { pattern: "*.ts" });

    // assert
    assert.equal(text, "./\n  alpha.ts\nnested/\n  gamma.ts");
  }

  {
    // arrange / act
    const { text } = await run(find, { pattern: "**", limit: 2 });

    // assert
    assert.match(text, /results limit reached/);
  }

  {
    // arrange
    const { text: normalText } = await run(grep, { pattern: "transactor" });

    // act
    const result = await run(grep, { pattern: "transactor", output: "count" });

    // assert
    assert.equal(result.text, "3 matches");
    assert.equal(result.details, undefined);
    assert.equal(
      normalText.split("\n").filter((line) => line.startsWith("  ")).length,
      3,
    );
  }

  {
    // arrange
    const params = {
      pattern: "transactor",
      filesOnly: true,
      output: "count",
    } as const;

    // act
    const result = await run(grep, params);

    // assert
    assert.equal(result.text, "2 files with matches");
    assert.equal(result.details, undefined);
  }

  {
    // arrange
    const params = {
      pattern: "nothing-matches-this",
      output: "count",
    } as const;

    // act
    const result = await run(grep, params);

    // assert
    assert.equal(result.text, "0 matches");
    assert.equal(result.details, undefined);
  }

  {
    // arrange
    const params = {
      pattern: "transactor",
      limit: 1,
      context: 2,
      output: "count",
    } as const;

    // act
    const result = await run(grep, params);

    // assert
    assert.equal(result.text, "3 matches");
    assert.equal(result.details, undefined);
  }

  {
    // arrange
    const { text: normalText } = await run(find, { pattern: "**" });
    const expectedCount = flattenFind(normalText).length;

    // act
    const result = await run(find, { pattern: "**", output: "count" });

    // assert
    assert.equal(result.text, `${expectedCount} matching entries`);
    assert.equal(result.details, undefined);
  }

  {
    // arrange
    const expectedCounts = await Promise.all(
      (["file", "directory"] as const).map(async (type) => ({
        type,
        count: flattenFind((await run(find, { pattern: "**", type })).text)
          .length,
      })),
    );

    // act
    const results = await Promise.all(
      expectedCounts.map(({ type }) =>
        run(find, { pattern: "**", type, output: "count" }),
      ),
    );

    // assert
    for (const [index, result] of results.entries()) {
      assert.equal(
        result.text,
        `${expectedCounts[index].count} matching entries`,
      );
      assert.equal(result.details, undefined);
    }
  }

  {
    // arrange
    const params = {
      pattern: "nothing-matches-this",
      output: "count",
    } as const;

    // act
    const result = await run(find, params);

    // assert
    assert.equal(result.text, "0 matching entries");
    assert.equal(result.details, undefined);
  }

  {
    // arrange
    const expectedCount = flattenFind(
      (await run(find, { pattern: "**" })).text,
    ).length;
    const params = { pattern: "**", limit: 1, output: "count" } as const;

    // act
    const result = await run(find, params);

    // assert
    assert.equal(result.text, `${expectedCount} matching entries`);
    assert.equal(result.details, undefined);
  }

  {
    // arrange
    const params = { output: "count", limit: 1 } as const;

    // act
    const result = await run(ls, params);

    // assert
    assert.equal(result.text, "6 entries");
    assert.equal(result.details, undefined);
  }

  {
    // arrange
    const stockResult: any = await stockLs(
      "smoke",
      {},
      undefined as any,
      undefined as any,
      undefined as any,
    );

    // act
    const result = await run(ls, {});

    // assert
    assert.equal(result.text, stockResult.content[0].text);
    assert.deepEqual(result.details, stockResult.details);
  }

  {
    // arrange
    const controller = new AbortController();
    controller.abort();

    // act
    const rejected = [
      run(grep, { pattern: "transactor", output: "count" }, controller.signal),
      run(find, { pattern: "**", output: "count" }, controller.signal),
      run(ls, { output: "count" }, controller.signal),
    ];

    // assert
    for (const promise of rejected) {
      await assert.rejects(promise, /Operation aborted/);
    }
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
  writeFileSync(
    path.join(directory, "nested", "gamma.ts"),
    "export const x = 1;\n",
  );
  writeFileSync(path.join(directory, ".gitignore"), "ignored.txt\n");
  writeFileSync(path.join(directory, "ignored.txt"), "transactor hidden\n");
  // rg and fd only honor .gitignore inside a git repo, and this exercises fd's git-boundary branch.
  mkdirSync(path.join(directory, ".git"));
  return directory;
}

// Rebuilds the flat path list from find's grouped output so assertions can stay path-based.
function flattenFind(text: string): string[] {
  const paths: string[] = [];
  let directory = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("  ")) {
      paths.push(directory + line.slice(2));
    } else {
      directory = line === "./" ? "" : line;
    }
  }
  return paths;
}
