import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { VcsInfo } from "./repo.ts";

export function vcsResult(
  vcs: VcsInfo,
  output: string,
  { truncated = false }: { truncated?: boolean } = {},
): AgentToolResult<{ kind: VcsInfo["kind"]; truncated: boolean }> {
  return {
    content: [{ type: "text", text: output }],
    details: { kind: vcs.kind, truncated },
    structuredContent: { kind: vcs.kind, root: vcs.root, colocated: vcs.colocated, output, truncated },
  };
}

// Cap changed-file rows without removing status headers or working-copy/parent information.
export function limitChangedFiles(output: string, limit: number): { output: string; truncated: boolean } {
  const changeLine = /^[ ACDMRU?!][ ACDMRU?!]? /;
  const kept: string[] = [];
  let shown = 0;
  let hidden = 0;
  let markerAt = 0;
  for (const line of output.split("\n")) {
    if (!changeLine.test(line)) {
      kept.push(line);
    } else if (shown < limit) {
      shown++;
      kept.push(line);
    } else {
      if (hidden === 0) markerAt = kept.length;
      hidden++;
    }
  }
  if (hidden === 0) return { output, truncated: false };
  kept.splice(markerAt, 0,
    `[truncated] ... and ${hidden} more changed files not listed ` +
      `(showing ${shown} of ${shown + hidden}; pass a larger limit to vcs_status to see more)`);
  return { output: kept.join("\n"), truncated: true };
}
