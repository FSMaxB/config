import { join } from "node:path";
import { processGlobal } from "./process-global.ts";

export function markSandboxActive(): void {
  sandboxState().active = true;
}

export function sandboxStatus(): SandboxStatus {
  return isSandboxActive() ? SandboxStatus.Active : SandboxStatus.Inactive;
}

export function isSandboxActive(): boolean {
  return sandboxState().active;
}

// One JSON file per sandbox profile. Defined in lib so the path engine can protect it.
export function sandboxProfilesDirectory(agentDirectory: string): string {
  return join(agentDirectory, "sandbox-profiles");
}

export const SandboxStatus = { Active: "active", Inactive: "inactive" } as const;
export type SandboxStatus = (typeof SandboxStatus)[keyof typeof SandboxStatus];

// Shared through globalThis like the path-permission state, so every extension sees one value
// no matter how many times the module is loaded.
function sandboxState(): SandboxState {
  return processGlobal("piSandboxActive", (): SandboxState => ({ active: false }));
}

interface SandboxState {
  active: boolean;
}
