import { redact } from "./evidence.ts";

export interface ExtractedClaim { text: string; kind: "procedure" | "project_fact" | "preference" | "outcome"; evidenceEntryIds: string[] }
export interface Extraction { summary: string; claims: ExtractedClaim[] }

export function parseExtraction(raw: string, entryIds: Set<string>): Extraction {
  if (Buffer.byteLength(raw) > 16 * 1024) throw new Error("Extraction output too large");
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed) || !keys(parsed, ["summary", "claims"]) || typeof parsed.summary !== "string" || !Array.isArray(parsed.claims) || parsed.claims.length > 256) throw new Error("Invalid extraction response");
  const claims = parsed.claims.map((value: unknown) => {
    if (!record(value) || !keys(value, ["text", "kind", "evidenceEntryIds"]) || typeof value.text !== "string" || !value.text.trim() || !["procedure", "project_fact", "preference", "outcome"].includes(String(value.kind)) || !Array.isArray(value.evidenceEntryIds) || value.evidenceEntryIds.length === 0 || !value.evidenceEntryIds.every(id => typeof id === "string" && entryIds.has(id))) throw new Error("Invalid extraction claim");
    return { text: redact(value.text).slice(0, 2048), kind: value.kind, evidenceEntryIds: value.evidenceEntryIds } as ExtractedClaim;
  });
  return { summary: redact(parsed.summary).slice(0, 8192), claims };
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && allowed.every(key => key in value);
}
