export function supportedPlatform(platform: NodeJS.Platform = process.platform): Platform | undefined {
  return platform === "darwin" || platform === "linux" ? platform : undefined;
}

// The platforms sandbox-runtime supports: Seatbelt on macOS, bubblewrap on Linux.
export type Platform = "darwin" | "linux";
