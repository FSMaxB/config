import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { localPlugin } from "./plugin.ts";
import type { LocalRule } from "./plugin.ts";

/** Lints `source` as TypeScript with one local rule enabled and returns the reported messages. */
export function lintSource(rule: LocalRule, source: string): readonly string[] {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    source,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tseslint.parser },
        plugins: { local: localPlugin },
        rules: { [`local/${rule}`]: "error" },
      },
    ],
    "source.ts",
  );
  return messages.map((message) => message.message);
}
