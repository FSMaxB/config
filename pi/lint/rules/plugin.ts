import type { ESLint } from "eslint";
import { noSeparatorComments } from "./no-separator-comments.ts";
import { stepDown } from "./step-down.ts";

const rules = {
  "no-separator-comments": noSeparatorComments,
  "step-down": stepDown,
} satisfies Record<LocalRule, unknown>;

/** Rules for code-style conventions that no published plugin covers. */
export const localPlugin: ESLint.Plugin = {
  meta: { name: "local" },
  // typescript-eslint's RuleModule type still lists RuleContext members that ESLint 10 removed
  // (getAncestors, parserOptions, ...). The rules use none of them, so they run fine.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- type gap described above
  rules: rules as unknown as NonNullable<ESLint.Plugin["rules"]>,
};

export type LocalRule = "no-separator-comments" | "step-down";
