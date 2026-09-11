export const READ_FILE_TOOLS = ["read", "ls", "find", "grep"] as const;
export const WRITE_FILE_TOOLS = ["write", "edit", "delete"] as const;
export const FILE_TOOLS: readonly string[] = [
  ...READ_FILE_TOOLS,
  ...WRITE_FILE_TOOLS,
];
