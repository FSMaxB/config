// `*` matches any run of characters, slashes included; every other character matches itself.
export function matchesWildcard(pattern: string, value: string): boolean {
  const expression = pattern.split("*").map(escapeRegularExpression).join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

function escapeRegularExpression(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
