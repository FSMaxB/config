import type { ProfileSessionState } from "./profile-activation.ts";
import { NetworkAccess, isValidProfileName } from "./profiles.ts";
import type { ActivationDecisions, Profile } from "./profiles.ts";

export type ProfileCommand =
  | { kind: "list" }
  | { kind: "record"; name: string }
  | { kind: "stop" }
  | { kind: "edit"; name: string }
  | { kind: "forget"; name: string }
  | { kind: "delete"; name: string };

export interface ProfileCommandError {
  kind: "error";
  message: string;
}

const NAMED_SUBCOMMANDS = ["record", "edit", "forget", "delete"] as const;
export const SUBCOMMANDS = ["record", "stop", "edit", "forget", "delete"] as const;
const USAGE = `Use /sandbox-profile [${SUBCOMMANDS.map((subcommand) => (subcommand === "stop" ? subcommand : `${subcommand} <name>`)).join(" | ")}].`;

export function parseProfileCommand(commandArguments: string): ProfileCommand | ProfileCommandError {
  const [subcommand, name, ...rest] = commandArguments.trim().split(/\s+/).filter((word) => word !== "");
  if (subcommand === undefined) return { kind: "list" };
  if (subcommand === "stop") return name === undefined ? { kind: "stop" } : error(`stop takes no argument. ${USAGE}`);
  const named = NAMED_SUBCOMMANDS.find((candidate) => candidate === subcommand);
  if (named === undefined) return error(`Unknown subcommand "${subcommand}". ${USAGE}`);
  if (name === undefined || rest.length > 0) return error(`${named} takes exactly one profile name. ${USAGE}`);
  if (named === "record" && !isValidProfileName(name)) return error(`"${name}" is not a valid profile name: use lowercase letters, digits and dashes, starting with a letter or digit.`);
  return { kind: named, name };
}

export function profileCompletions(prefix: string, profileNames: readonly string[]): { value: string; label: string }[] | null {
  const [first = "", second] = prefix.split(" ");
  const candidates = second === undefined
    ? SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(first)).map((subcommand) => ({ value: subcommand, label: subcommand }))
    : profileNames.filter((name) => name.startsWith(second)).map((name) => ({ value: `${first} ${name}`, label: name }));
  return candidates.length > 0 ? candidates : null;
}

export function profileListText(profiles: readonly Profile[], state: ProfileSessionState, always: ActivationDecisions): string {
  if (profiles.length === 0) return "No sandbox profiles. Create one with /sandbox-profile record <name>.";
  return profiles.map((profile) => profileLine(profile, state, always)).join("\n");
}

function profileLine({ name, triggers, network }: Profile, state: ProfileSessionState, always: ActivationDecisions): string {
  const triggerText = [...triggers.commands, ...triggers.patterns.map((pattern) => `/${pattern}/`)].join(", ") || "none";
  const stored = always.denied.has(name)
    ? `always denied${reasonText(always.denied.get(name))}`
    : always.allowed.has(name) ? "always allowed" : "ask";
  const session = state.denied.has(name)
    ? `denied this session${reasonText(state.denied.get(name))}`
    : state.allowed.has(name) ? "allowed this session" : "no session decision";
  const accessText = network.access === NetworkAccess.Listed ? "" : `network: ${network.access}; `;
  return `${name}: ${stored}; ${session}; ${accessText}triggers: ${triggerText}`;
}

function reasonText(note: string | undefined): string {
  return note ? ` (${note})` : "";
}

function error(message: string): ProfileCommandError {
  return { kind: "error", message };
}
