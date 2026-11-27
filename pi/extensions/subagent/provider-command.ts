const USAGE = "Use /subagent-providers [forget <provider>].";

const SUBCOMMANDS = ["forget"] as const;

export function parseProviderCommand(commandArguments: string): ProviderCommandParse {
  const words = commandArguments.trim().split(/\s+/).filter((word) => word !== "");
  const subcommand = words.at(0);
  const provider = words.at(1);
  if (subcommand === undefined) return { kind: "list" };
  if (subcommand !== "forget") return { kind: "error", message: `Unknown subcommand "${subcommand}". ${USAGE}` };
  if (provider === undefined || words.length > 2) {
    return { kind: "error", message: `forget takes exactly one provider. ${USAGE}` };
  }
  return { kind: "forget", provider };
}

export type ProviderCommandParse = ProviderCommand | { kind: "error"; message: string };

export type ProviderCommand = { kind: "list" } | { kind: "forget"; provider: string };

export function providerCompletions(prefix: string, providers: readonly string[]): { value: string; label: string }[] | null {
  const words = prefix.split(" ");
  const first = words.at(0) ?? "";
  const second = words.at(1);
  const candidates = second === undefined
    ? SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(first)).map((subcommand) => ({ value: subcommand, label: subcommand }))
    : providers.filter((provider) => provider.startsWith(second)).map((provider) => ({ value: `${first} ${provider}`, label: provider }));
  // eslint-disable-next-line unicorn/no-null -- pi's argument completion treats null as "no completions"
  return candidates.length > 0 ? candidates : null;
}
