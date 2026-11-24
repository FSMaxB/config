import { fileURLToPath } from "node:url";

// The shim turns off jj's watchman fsmonitor, whose socket the sandbox denies.
export function withJjShim(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, PATH: [jjShimDirectory(), ...(environment.PATH ? [environment.PATH] : [])].join(":") };
}

export function jjShimDirectory(): string {
  return fileURLToPath(new URL("../shims/jj", import.meta.url));
}
