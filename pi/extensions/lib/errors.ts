// Promise rejections and catch clauses carry `unknown`; anything that is not an Error is shown as is.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The `code` of a Node.js system error such as ENOENT, or undefined for any other value.
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
