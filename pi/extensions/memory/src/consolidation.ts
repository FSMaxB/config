import type { Claim } from "./store.ts";
import { redact } from "./evidence.ts";
import { stripCodeFence } from "./model-output.ts";

export interface Section { heading: string; items: { text: string; claimIds: string[] }[] }

export function parseConsolidation(raw: string, claims: Claim[]): Section[] {
  if (Buffer.byteLength(raw) > 24 * 1024) throw new Error("Consolidation output exceeds 24 KiB");
  const result: unknown = JSON.parse(stripCodeFence(raw));
  if (!object(result) || Object.keys(result).join() !== "sections" || !Array.isArray(result.sections) || result.sections.length > 32) throw new Error("Invalid consolidation output");
  const ids = new Set(claims.map(claim => claim.id));
  return result.sections.map((section: unknown) => {
    if (!object(section) || !keys(section, ["heading", "items"]) || typeof section.heading !== "string" || !section.heading.trim() || section.heading.length > 120 || !Array.isArray(section.items) || section.items.length > 64) throw new Error("Invalid consolidation section");
    return {
      heading: redact(section.heading),
      items: section.items.map((item: unknown) => {
        if (!object(item) || !keys(item, ["text", "claimIds"]) || typeof item.text !== "string" || !item.text.trim() || item.text.length > 2048 || !Array.isArray(item.claimIds) || !item.claimIds.length || !item.claimIds.every(id => typeof id === "string" && ids.has(id))) throw new Error("Invalid consolidation item reference");
        return { text: redact(item.text), claimIds: item.claimIds as string[] };
      }),
    };
  });
}

export function renderConsolidation(sections: Section[]): { summary: string; handbook: string } {
  const handbook = "# Historical project evidence\n\n" + sections.map(section => `## ${singleLine(section.heading)}\n\n${section.items.map(item => `- ${singleLine(item.text)} (${item.claimIds.join(", ")})`).join("\n")}`).join("\n\n") + "\n";
  const summary = "Historical project evidence, possibly stale; current user and repository instructions take precedence. Read artifacts with memory_read.\n" + sections.flatMap(section => section.items.map(item => `- ${singleLine(item.text)} [${item.claimIds.join(", ")}]`)).join("\n") + "\n";
  if (Buffer.byteLength(summary) > 8192 || Buffer.byteLength(handbook) > 32768) throw new Error("Consolidation exceeds artifact limit");
  return { summary, handbook };
}

function singleLine(text: string): string { return text.replace(/[\r\n]+/g, " "); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, names: string[]): boolean { return Object.keys(value).length === names.length && names.every(name => name in value); }
