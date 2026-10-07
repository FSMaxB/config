import type { PayloadFingerprint } from "./fingerprint.ts";
import { SectionKind } from "./fingerprint.ts";
import { MarkerEvent, type LogRecord, type RequestRecord, type Usage } from "./records.ts";

export const Verdict = {
  First: "first", // nothing to compare with: first request, or after session start/compaction
  ModelChanged: "model-changed",
  NoUsage: "no-usage", // payload logged without usage: cache warm, retry, compaction request
  Ok: "ok",
  NoPayload: "no-payload", // missed, but no payload to compare (pi-claude)
  PrefixChanged: "prefix-changed", // pi sent different content before the end of the previous request
  ProviderMiss: "provider-miss", // the previous payload is an exact prefix, yet the cache read fell short
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export interface Change {
  key: string;
  index?: number;
  label?: string;
  charOffset: number;
}

export interface Finding {
  record: RequestRecord;
  verdict: Verdict;
  promptTokens?: number;
  missedTokens?: number;
  idleMs?: number;
  firstChange?: Change;
  estimatedChangeTokens?: number;
  changedParameters: string[];
}

interface Comparison {
  firstChange?: Change;
  changedParameters: string[];
}

interface WalkState {
  previous?: RequestRecord;
  previousWithUsage?: RequestRecord;
  reportedCache: boolean;
}

// Same floor as pi's own cache-miss notice (cache-stats.js): smaller misses are breakpoint granularity.
const NOISE_FLOOR_TOKENS = 1024;
const PROBLEM_VERDICTS: readonly Verdict[] = [Verdict.PrefixChanged, Verdict.ProviderMiss, Verdict.NoPayload];
const TTL_HINT_MS = 5 * 60 * 1000;

export function analyze(records: readonly LogRecord[]): Finding[] {
  const findings: Finding[] = [];
  let state: WalkState = { reportedCache: false };
  for (const record of records) {
    if (record.kind === "marker") {
      state = resetsComparison(record.event) ? { reportedCache: state.reportedCache } : state;
      continue;
    }
    findings.push(classify(record, state));
    state = {
      previous: record,
      previousWithUsage: record.usage ? record : state.previousWithUsage,
      reportedCache: state.reportedCache || (record.usage !== undefined && cachedTokens(record.usage) > 0),
    };
  }
  return findings;
}

function resetsComparison(event: MarkerEvent): boolean {
  return event !== MarkerEvent.ModelSelect;
}

function classify(record: RequestRecord, { previous, previousWithUsage, reportedCache }: WalkState): Finding {
  const comparison = record.payload && previous?.payload ? comparePayloads(previous.payload, record.payload) : undefined;
  const idleMs = previous ? Date.parse(record.startedAt) - Date.parse(previous.completedAt ?? previous.startedAt) : undefined;
  const base = { record, changedParameters: comparison?.changedParameters ?? [], ...(idleMs === undefined ? {} : { idleMs }) };

  if (!previous) return { ...base, verdict: Verdict.First };
  if (previous.provider !== record.provider || previous.model !== record.model) return { ...base, verdict: Verdict.ModelChanged };
  const { usage } = record;
  if (!usage) return { ...base, verdict: Verdict.NoUsage };

  const promptTokens = promptTokensOf(usage);
  const missedTokens = previousWithUsage ? Math.min(promptTokensOf(previousWithUsage.usage as Usage), promptTokens) - usage.cacheRead : undefined;
  const withTokens = { ...base, promptTokens, ...(missedTokens === undefined ? {} : { missedTokens }) };

  const noMiss = missedTokens === undefined || missedTokens <= NOISE_FLOOR_TOKENS || (!reportedCache && cachedTokens(usage) === 0);
  if (noMiss) return { ...withTokens, verdict: Verdict.Ok };
  if (!comparison || !record.payload) return { ...withTokens, verdict: Verdict.NoPayload };

  const { firstChange } = comparison;
  if (!firstChange) return { ...withTokens, verdict: Verdict.ProviderMiss };
  return {
    ...withTokens,
    verdict: Verdict.PrefixChanged,
    firstChange,
    estimatedChangeTokens: Math.round((firstChange.charOffset * promptTokens) / Math.max(record.payload.totalChars, 1)),
  };
}

function promptTokensOf({ input, cacheRead, cacheWrite }: Usage): number {
  return input + cacheRead + cacheWrite;
}

function cachedTokens({ cacheRead, cacheWrite }: Usage): number {
  return cacheRead + cacheWrite;
}

// The character offset ignores the JSON punctuation between sections, so it is approximate; the
// caller scales it by the request's own tokens-per-character ratio.
function comparePayloads(previous: PayloadFingerprint, current: PayloadFingerprint): Comparison {
  const changedParameters: string[] = [];
  let offset = 0;
  for (const section of previous.sections) {
    const counterpart = current.sections.find(({ key }) => key === section.key);
    if (!counterpart) return { firstChange: { key: section.key, charOffset: offset }, changedParameters };
    if (section.kind === SectionKind.Parameter) {
      if (counterpart.hash !== section.hash) changedParameters.push(section.key);
      offset += section.chars;
      continue;
    }
    if (section.items) {
      const index = section.items.findIndex((item, position) => counterpart.items?.[position]?.hash !== item.hash);
      if (index !== -1) {
        const leading = section.items.slice(0, index).reduce((sum, { chars }) => sum + chars, 0);
        const { label } = section.items[index] ?? {};
        return { firstChange: { key: section.key, index, ...(label === undefined ? {} : { label }), charOffset: offset + 1 + leading }, changedParameters };
      }
    } else if (counterpart.hash !== section.hash) {
      return { firstChange: { key: section.key, charOffset: offset }, changedParameters };
    }
    offset += section.chars;
  }
  const added = current.sections.find(({ key, kind }) => kind === SectionKind.Content && !previous.sections.some((section) => section.key === key));
  if (added) return { firstChange: { key: added.key, charOffset: previous.totalChars }, changedParameters };
  return { changedParameters };
}

export const ReportVerbosity = { Problems: "problems", All: "all" } as const;
export type ReportVerbosity = (typeof ReportVerbosity)[keyof typeof ReportVerbosity];

export function parseReportArguments(words: readonly string[]): { verbosity: ReportVerbosity; target?: string } {
  const target = words.find((word) => word !== "--all");
  return { verbosity: words.includes("--all") ? ReportVerbosity.All : ReportVerbosity.Problems, ...(target ? { target } : {}) };
}

export function renderReport(findings: readonly Finding[], verbosity: ReportVerbosity): string {
  if (findings.length === 0) return "No requests logged.";
  const shown = verbosity === ReportVerbosity.All ? findings : findings.filter(isProblem);
  return [renderHeader(findings), ...shown.map(renderFinding)].join("\n");
}

function isProblem({ verdict }: Finding): boolean {
  return PROBLEM_VERDICTS.includes(verdict);
}

function renderHeader(findings: readonly Finding[]): string {
  const misses = findings.filter(isProblem);
  const missedTokens = misses.reduce((sum, { missedTokens: missed }) => sum + (missed ?? 0), 0);
  const counts = PROBLEM_VERDICTS.map((verdict) => ({ verdict, count: misses.filter((finding) => finding.verdict === verdict).length }))
    .filter(({ count }) => count > 0)
    .sort((left, right) => right.count - left.count)
    .map(({ verdict, count }) => `${count} ${verdict}`);
  const noUsage = findings.filter(({ verdict }) => verdict === Verdict.NoUsage).length;
  const summary = `${findings.length} requests · ${misses.length} misses (${formatNumber(missedTokens)} tokens)`;
  return [counts.length > 0 ? `${summary}: ${counts.join(", ")}` : summary, ...(noUsage > 0 ? [`${noUsage} no-usage`] : [])].join(" · ");
}

function renderFinding({ record, verdict, promptTokens, missedTokens, idleMs, firstChange, estimatedChangeTokens, changedParameters }: Finding): string {
  const columns = [
    formatTime(record.startedAt),
    `${record.provider}/${record.model}`,
    `prompt ${formatOptional(promptTokens)}`,
    `read ${formatOptional(record.usage?.cacheRead)}`,
    `missed ${formatOptional(missedTokens)}`,
    verdict,
  ];
  const details = [
    ...(firstChange ? [`at ${renderChange(firstChange)} ≈${formatNumber(estimatedChangeTokens ?? 0)} tokens`] : []),
    ...(verdict === Verdict.ProviderMiss && idleMs !== undefined ? [renderIdle(idleMs)] : []),
    ...(changedParameters.length > 0 ? [`params: ${changedParameters.join(", ")}`] : []),
  ];
  return [...columns, ...details].join("  ");
}

function renderChange({ key, index, label }: Change): string {
  return `${key}${index === undefined ? "" : `[${index}]`}${label === undefined ? "" : ` (${label})`}`;
}

function renderIdle(idleMs: number): string {
  return `idle ${Math.round(idleMs / 1000)}s${idleMs > TTL_HINT_MS ? " (> 5 min, TTL?)" : ""}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "-" : formatNumber(value);
}
