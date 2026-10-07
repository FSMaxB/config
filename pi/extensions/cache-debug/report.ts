// Usage: node pi/extensions/cache-debug/report.ts [--all] [<session-id> | <file.jsonl>]
// Without a target it reports the most recently written log.
import { analyze, parseReportArguments, renderReport } from "./analysis.ts";
import { cacheDebugDirectory, readLog, resolveLogPath } from "./log-file.ts";

const { verbosity, target } = parseReportArguments(process.argv.slice(2));
const path = await resolveLogPath(cacheDebugDirectory(), target);
if (path === undefined) {
  console.error(`No cache-debug logs in ${cacheDebugDirectory()}`);
  process.exit(1);
}
console.log(`${path}\n${renderReport(analyze(await readLog(path)), verbosity)}`);
