// Files are taken in name order, so which duplicate wins does not depend on directory order.
export function dropDuplicateNames<Agent extends { name: string }>(entries: { file: string; agent: Agent }[]): { agents: Agent[]; skipped: string[] } {
  const sorted = [...entries].sort((left, right) => left.file.localeCompare(right.file));
  const owners = new Map<string, string>();
  const skipped = sorted.flatMap(({ file, agent }) => {
    const owner = owners.get(agent.name);
    if (owner !== undefined) return [`${file} was skipped: agent "${agent.name}" is already defined by ${owner}.`];
    owners.set(agent.name, file);
    return [];
  });
  return { agents: sorted.filter(({ file, agent }) => owners.get(agent.name) === file).map(({ agent }) => agent), skipped };
}
