// Shared through globalThis like the path-permission state, so every extension sees one value
// no matter how many times the module is loaded.
const globalState = globalThis as { piSandboxActive?: boolean };

export function markSandboxActive(): void {
  globalState.piSandboxActive = true;
}

export function isSandboxActive(): boolean {
  return globalState.piSandboxActive === true;
}

export const SandboxStatus = { Active: "active", Inactive: "inactive" } as const;
export type SandboxStatus = (typeof SandboxStatus)[keyof typeof SandboxStatus];

export function sandboxStatus(): SandboxStatus {
  return isSandboxActive() ? SandboxStatus.Active : SandboxStatus.Inactive;
}
