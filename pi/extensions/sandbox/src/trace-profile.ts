import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import { hasGlobCharacters } from "./glob-characters.ts";

// Allows everything, and reports exactly what the normal sandbox would deny: reads under the denied roots and every
// write, each silenced again for the paths the policy allows (in SBPL the last matching rule wins).
export function traceProfile(filesystem: FilesystemConfig, tag: string): string {
  const report = `(with report) (with message ${sbplString(tag)})`;
  return [
    "(version 1)",
    "(allow default)",
    rule(`(allow file-read* ${report}`, filesystem.denyRead),
    rule("(allow file-read*", filesystem.allowRead ?? []),
    `(allow file-write* ${report})`,
    rule("(allow file-write*", filesystem.allowWrite),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

// Glob entries are skipped: they are filtered later in TypeScript. With nothing left the rule is omitted, because an
// empty filter would match everything and silence the whole trace.
function rule(head: string, paths: readonly string[]): string | undefined {
  const literal = paths.filter((path) => !hasGlobCharacters(path));
  if (literal.length === 0) return undefined;
  return `${head} ${literal.map((path) => `(subpath ${sbplString(path)})`).join(" ")})`;
}

function sbplString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
