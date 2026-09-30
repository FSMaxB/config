export function deniedToolDeclarations(
  declared: readonly { name: string }[],
  deniedNames: ReadonlySet<string>,
): string[] {
  return declared.filter(tool => deniedNames.has(tool.name)).map(tool => tool.name);
}
