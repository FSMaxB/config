import { Linter } from "eslint";
import type { Linter as LinterTypes } from "eslint";
import tseslint from "typescript-eslint";
import { localPlugin } from "./plugin.ts";
import type { LocalRule } from "./plugin.ts";

/** Lints `source` as TypeScript with one local rule enabled and returns the reported messages. */
export function lintSource(rule: LocalRule, source: string): readonly string[] {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(source, ruleConfig(rule), "source.ts").map((message) => message.message);
}

/** Lints `source` with one local rule enabled, applies its fixes and returns the fixed source. */
export function fixSource(rule: LocalRule, source: string): string {
  const linter = new Linter({ configType: "flat" });
  return linter.verifyAndFix(source, ruleConfig(rule), "source.ts").output;
}

function ruleConfig(rule: LocalRule): LinterTypes.Config[] {
  return [
    {
      files: ["**/*.ts"],
      languageOptions: { parser: tseslint.parser },
      plugins: { local: localPlugin },
      rules: { [`local/${rule}`]: "error" },
    },
  ];
}
