import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import type { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";
import { localPlugin } from "./rules/plugin.ts";

// The npm scripts run ESLint from pi/, so every glob below is relative to it.
const PI_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

// Files whose loader needs a default export: pi loads extensions/*.ts and extensions/*/index.ts,
// claude-bridge and sandbox re-export theirs from src/, a claude-bridge test fixture is loaded as
// an extension, and ESLint loads this file.
const DEFAULT_EXPORT_FILES = [
  "lint/eslint.config.ts",
  "extensions/*.ts",
  "extensions/*/index.ts",
  "extensions/claude-bridge/src/index.ts",
  "extensions/claude-bridge/tests/fixtures/*.ts",
  "extensions/sandbox/src/extension.ts",
];

const TEST_FILES = ["**/*.test.ts", "extensions/claude-bridge/tests/**"];

export default defineConfig([
  { ignores: ["**/node_modules/**"] },
  {
    files: ["**/*.ts", "**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        // lint/tsconfig.json comes first so that the lib/ modules sandbox imports are typed by it.
        project: ["lint/tsconfig.json", "extensions/claude-bridge/tsconfig.json", "extensions/sandbox/tsconfig.json"],
        tsconfigRootDir: PI_DIRECTORY,
      },
    },
    plugins: { local: localPlugin, unicorn },
    rules: {
      ...presetAdjustments(),
      ...codeStyleRules(),
      "no-restricted-syntax": ["error", ...restrictedSyntax(), defaultExportRestriction()],
    },
  },
  {
    files: DEFAULT_EXPORT_FILES,
    rules: { "no-restricted-syntax": ["error", ...restrictedSyntax()] },
  },
  {
    files: TEST_FILES,
    rules: { "@typescript-eslint/no-magic-numbers": "off" },
  },
]);

/** Turns off or tunes preset rules that fight pi's APIs or node:test. */
function presetAdjustments(): Linter.RulesRecord {
  return {
    // node:test's test() and describe() return promises that the runner tracks itself.
    "@typescript-eslint/no-floating-promises": [
      "error",
      {
        allowForKnownSafeCalls: [
          { from: "package", package: "node:test", name: ["test", "describe", "it", "suite", "before", "after", "beforeEach", "afterEach"] },
        ],
      },
    ],
    "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
    "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
    // pi's tool and event handler types expect async functions even when they do not await.
    "@typescript-eslint/require-await": "off",
    // No-op handlers and interface methods (invalidate() {}) are intentional.
    "@typescript-eslint/no-empty-function": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all", ignoreRestSiblings: true },
    ],
    eqeqeq: ["error", "always", { null: "ignore" }],
  };
}

/** Rules that enforce the code-style skill and its TypeScript reference. */
function codeStyleRules(): Linter.RulesRecord {
  return {
    "local/no-separator-comments": "error",
    "local/step-down": "error",
    "unicorn/prefer-early-return": "error",
    "unicorn/name-replacements": [
      "error",
      {
        // Properties, shorthand properties and imports mirror external APIs such as pi's
        // execute(toolCallId, params); only names this code chooses are checked.
        checkProperties: false,
        checkShorthandProperties: false,
        checkDefaultAndNamespaceImports: false,
        checkShorthandImports: false,
        checkFilenames: false,
      },
    ],
    "@typescript-eslint/no-magic-numbers": [
      "error",
      {
        ignore: [-1, 0, 1, 2],
        ignoreArrayIndexes: true,
        ignoreDefaultValues: true,
        ignoreEnums: true,
        ignoreNumericLiteralTypes: true,
        ignoreReadonlyClassProperties: true,
        ignoreTypeIndexes: true,
      },
    ],
    "unicorn/prefer-node-protocol": "error",
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/parameter-properties": "error",
    "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-non-null-assertion": "error",
    // `as const` stays allowed. For data this process wrote itself, disable the rule on that line
    // with a `-- reason`.
    "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    "unicorn/no-null": ["error", { checkArguments: false }],
    "@typescript-eslint/prefer-readonly": "error",
    "unicorn/no-for-each": "error",
    "unicorn/no-array-reduce": ["error", { allowSimpleOperations: true }],
    "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: false }],
    "unicorn/throw-new-error": "error",
    "unicorn/catch-error-name": ["error", { name: "error" }],
    "unicorn/prefer-optional-catch-binding": "error",
  };
}

/** Code-style bans that are plain AST patterns. */
function restrictedSyntax(): readonly RestrictedSyntax[] {
  return [
    {
      selector: [
        "Program > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression)",
        "Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression)",
      ].join(", "),
      message: "Declare module-level functions with `function`; use arrow functions only for callbacks.",
    },
    {
      selector: [
        "Program > FunctionDeclaration[returnType=undefined]",
        "Program > ExportNamedDeclaration > FunctionDeclaration[returnType=undefined]",
        "Program > ExportDefaultDeclaration > FunctionDeclaration[returnType=undefined]",
      ].join(", "),
      message: "Give every module-level function an explicit return type.",
    },
    {
      selector: ":function > Identifier.params[typeAnnotation.typeAnnotation.type='TSBooleanKeyword']",
      message: "Use a union of string literals instead of a positional boolean parameter.",
    },
    { selector: "TSEnumDeclaration", message: "Use a union of string literals or an `as const` object instead of `enum`." },
    {
      selector: ":matches(PropertyDefinition, MethodDefinition, TSAbstractMethodDefinition, TSParameterProperty)[accessibility='private']",
      message: "Make class members private with `#name`, not with the `private` keyword.",
    },
  ];
}

function defaultExportRestriction(): RestrictedSyntax {
  return { selector: "ExportDefaultDeclaration", message: "Use named exports; only extension entry points export a default." };
}

interface RestrictedSyntax {
  readonly selector: string;
  readonly message: string;
}
