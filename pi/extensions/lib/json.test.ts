import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readJsonObjectFile, writeJsonFileAtomically } from "./json.ts";

let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-json-test-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("a missing file reads as undefined", async () => {
  // arrange
  const path = join(directory, "missing.json");

  // act
  const parsed = await readJsonObjectFile(path);

  // assert
  assert.equal(parsed, undefined);
});

test("a JSON object reads back", async () => {
  // arrange
  const path = join(directory, "object.json");
  await writeFile(path, '{"a":1}');

  // act
  const parsed = await readJsonObjectFile(path);

  // assert
  assert.deepEqual(parsed, { a: 1 });
});

test("invalid JSON throws instead of reading as empty", async () => {
  // arrange
  const path = join(directory, "invalid.json");
  await writeFile(path, "not json");

  // act & assert
  await assert.rejects(readJsonObjectFile(path), /not valid JSON/);
});

test("JSON that is not an object throws instead of reading as empty", async () => {
  // arrange
  const path = join(directory, "non-object.json");

  for (const value of ["null", "[]", "3"]) {
    await writeFile(path, value);

    // act & assert
    await assert.rejects(readJsonObjectFile(path), /not a JSON object/);
  }
});

test("an atomic write replaces the file and leaves no temporary file", async () => {
  // arrange
  const path = join(directory, "atomic.json");
  const value = { b: 2, a: [1, 2] };

  // act
  await writeJsonFileAtomically(path, value);

  // assert
  assert.equal(await readFile(path, "utf8"), `${JSON.stringify(value, null, 2)}\n`);
  const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});
