import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findRepoRoot } from "./repo.ts";

// Ordered by precedence: project-level skills shadow the global ones.
export function* skillRoots(): Generator<string> {
  const repoRoot = findRepoRoot();
  yield join(repoRoot, ".agents", "skills");
  yield join(repoRoot, ".pi", "skills");
  yield join(getAgentDir(), "skills");
  yield join(homedir(), ".agents", "skills");
  yield join(homedir(), ".claude", "skills");
}
