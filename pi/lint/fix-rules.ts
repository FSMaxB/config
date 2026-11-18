import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const PI_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

const rules: ReadonlySet<string> = new Set(process.argv.slice(2));
if (rules.size === 0) {
  console.error("Usage: npm run fix -- <rule>...");
  process.exit(1);
}
const eslint = new ESLint({
  cwd: PI_DIRECTORY,
  overrideConfigFile: "lint/eslint.config.ts",
  fix: (message) => message.ruleId !== null && rules.has(message.ruleId),
});
const results = await eslint.lintFiles(["extensions", "lint"]);
await ESLint.outputFixes(results);
