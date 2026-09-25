/** Models asked for "ONLY JSON" still tend to wrap it in a markdown code fence; the fence carries no data, so drop it before parsing. */
export function stripCodeFence(raw: string): string {
  const match = /^\s*```[A-Za-z]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  return match ? match[1] : raw;
}
