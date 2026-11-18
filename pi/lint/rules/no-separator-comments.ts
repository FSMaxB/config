import { ESLintUtils } from "@typescript-eslint/utils";

/**
 * A run of three or more identical separator characters at the start or the end of a comment:
 * `// ----`, `// --- Setup ---` or a line of stars. Mixed runs, such as the stars and slash
 * ending a glob, do not count.
 */
const SEPARATOR = /^\s*([-=*#_~])\1{2,}|([-=#_~])\2{2,}\s*$/;

/** Bans banner comments that split a file into sections; split it into functions or modules. */
export const noSeparatorComments = ESLintUtils.RuleCreator.withoutDocs<[], "separator">({
  meta: {
    type: "suggestion",
    messages: {
      separator: "Split the code into functions or modules instead of separating it with comments.",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    return {
      Program(): void {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!SEPARATOR.test(comment.value)) continue;
          context.report({ loc: comment.loc, messageId: "separator" });
        }
      },
    };
  },
});
