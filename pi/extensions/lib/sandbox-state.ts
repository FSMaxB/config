// Shared through globalThis like the path-permission state, so every extension sees one value
// no matter how many times the module is loaded.
const globalState = globalThis as { piSandboxActive?: boolean };

export function markSandboxActive(): void {
  globalState.piSandboxActive = true;
}

export function isSandboxActive(): boolean {
  return globalState.piSandboxActive === true;
}
