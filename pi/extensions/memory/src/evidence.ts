import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface Evidence {
  id: string;
  role: string;
  text: string;
}

export function collectEvidence(branch: SessionEntry[], eligible: Set<string>, maxBytes = 64 * 1024): Evidence[] {
  const omitted = new Set(branch.filter(entry => entry.type === "context_edit").map(entry => entry.targetId));
  const selected: Evidence[] = [];
  for (const entry of branch) {
    if (!eligible.has(entry.id) || entry.type !== "message" || omitted.has(entry.id)) continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
    if (message.role === "toolResult" && message.toolName.startsWith("memory_")) continue;
    const text = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (!text.trim() || /<\/?(?:system|developer|skill|memory)[^>]*>/i.test(text)) continue;
    selected.push({ id: entry.id, role: message.role === "toolResult" && message.isError ? "failed-tool" : message.role, text: redact(text).slice(0, message.role === "toolResult" ? 4096 : 16384) });
  }
  const priority = (item: Evidence) => item.role === "user" ? 0 : item.role === "assistant" ? 1 : 2;
  const chosen = [...selected].reverse().sort((left, right) => priority(left) - priority(right));
  let size = 0;
  const retained = new Set(chosen.filter(item => {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (size + bytes > Math.min(maxBytes, 64 * 1024)) return false;
    size += bytes;
    return true;
  }).map(item => item.id));
  return selected.filter(item => retained.has(item.id));
}

export function redact(text: string): string {
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g, "[redacted]")
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[redacted]");
}
