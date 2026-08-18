import { readFile } from "node:fs/promises";

export async function readJsonObject(
  path: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}
