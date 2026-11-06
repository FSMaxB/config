import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectVcs } from "./lib/repo.ts";

export default function (pi: ExtensionAPI) {
  // Re-detected on every agent start rather than once at load, so a repository
  // initialized mid-session is still announced correctly.
  pi.on("before_agent_start", async (event) => {
    const vcs = detectVcs();
    const line =
      vcs.kind === "none"
        ? `There is no jj or git repository at or above ${vcs.root}.`
        : `The current directory is inside a ${vcs.kind}${vcs.colocated ? " (colocated jj/git)" : ""} repository rooted at ${vcs.root}.`;
    return {
      systemPrompt: `${event.systemPrompt}\n\n# Version control\n\n${line}`,
    };
  });
}
