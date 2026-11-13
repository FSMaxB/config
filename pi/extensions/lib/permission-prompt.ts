import { ALLOW_ALWAYS, ALLOW_NARROWER, ALLOW_ONCE, ALLOW_SESSION, DENY_ALWAYS, DENY_ONCE, DENY_SESSION, DENY_WITH_REASON } from "./permission-choices.ts";

export const Duration = { Once: "once", Session: "session", Always: "always" } as const;
export type Duration = (typeof Duration)[keyof typeof Duration];
export type LastingDuration = Exclude<Duration, typeof Duration.Once>;
export const ALL_DURATIONS: readonly Duration[] = [Duration.Once, Duration.Session, Duration.Always];

// The two calls a permission prompt makes. lib/permission-ui.ts adapts pi's UI; tests pass a scripted fake.
export interface PermissionUI {
  select(title: string, options: string[], preselected?: string): Promise<string | undefined>;
  input(title: string, placeholder: string): Promise<string | undefined>;
}

export interface ScopeChoice<Scope> {
  label: string;
  scope: Scope;
}

// Another place an allow can be recorded besides a duration, e.g. a sandbox profile.
export interface DestinationChoice<Destination> {
  label: string;
  destination: Destination;
}

export interface PermissionRequest<Scope, Destination = never> {
  title: string;
  // What a denial blocks, named in the follow-up prompts, e.g. "network access to example.com".
  subject: string;
  // What the plain allow options grant.
  scope: Scope;
  // Strictly smaller alternatives, narrowest first; empty hides "Allow narrower…".
  narrower: readonly ScopeChoice<Scope>[];
  durations: readonly Duration[];
  preselected?: string;
  // Extra places an allow can be recorded. Listed after the allow options in the main menu and after the
  // durations when a narrower scope is picked.
  destinations?: readonly DestinationChoice<Destination>[];
}

// Without destinations the answer type is what it always was, so callers that pass none need no new branch.
export type PermissionAnswer<Scope, Destination = never> =
  | { decision: "allow"; duration: Duration; scope: Scope }
  | { decision: "deny"; duration: Duration; note: string | undefined }
  | ([Destination] extends [never] ? never : { decision: "allow-to"; destination: Destination; scope: Scope });

type AnyAnswer<Scope, Destination> =
  | { decision: "allow"; duration: Duration; scope: Scope }
  | { decision: "deny"; duration: Duration; note: string | undefined }
  | { decision: "allow-to"; destination: Destination; scope: Scope };

// Dismissing the main prompt denies once, so a queue of prompts does not ask again after Esc.
// Backing out of a follow-up (Esc, or an empty reason) returns to the main prompt instead.
export async function askPermission<Scope, Destination = never>(ui: PermissionUI, request: PermissionRequest<Scope, Destination>): Promise<PermissionAnswer<Scope, Destination>> {
  const options = menuOptions(request);
  while (true) {
    const choice = await ui.select(request.title, options.map(({ label }) => label), request.preselected);
    const option = options.find(({ label }) => label === choice);
    if (!option) return { decision: "deny", duration: Duration.Once, note: undefined };
    const answer = await resolveOption(ui, request, option);
    if (answer) return answer as PermissionAnswer<Scope, Destination>;
  }
}

export function userReason(note: string | undefined): string {
  return note ? ` The user's reason: ${note}` : "";
}

type MenuOption<Scope, Destination> =
  | { label: string; kind: "answer"; answer: AnyAnswer<Scope, Destination> }
  | { label: string; kind: "narrower" }
  | { label: string; kind: "reason" };

function menuOptions<Scope, Destination>({ scope, narrower, durations, destinations = [] }: PermissionRequest<Scope, Destination>): MenuOption<Scope, Destination>[] {
  const allow = durations.map((duration): MenuOption<Scope, Destination> => ({ label: ALLOW_LABELS[duration], kind: "answer", answer: { decision: "allow", duration, scope } }));
  const allowTo = destinations.map(({ label, destination }): MenuOption<Scope, Destination> => ({ label, kind: "answer", answer: { decision: "allow-to", destination, scope } }));
  const deny = durations.map((duration): MenuOption<Scope, Destination> => ({ label: DENY_LABELS[duration], kind: "answer", answer: { decision: "deny", duration, note: undefined } }));
  const narrow: MenuOption<Scope, Destination>[] = narrower.length > 0 ? [{ label: ALLOW_NARROWER, kind: "narrower" }] : [];
  return [...allow, ...allowTo, ...narrow, ...deny, { label: DENY_WITH_REASON, kind: "reason" }];
}

// undefined sends the user back to the main prompt.
async function resolveOption<Scope, Destination>(ui: PermissionUI, request: PermissionRequest<Scope, Destination>, option: MenuOption<Scope, Destination>): Promise<AnyAnswer<Scope, Destination> | undefined> {
  switch (option.kind) {
    case "answer": return option.answer;
    case "narrower": return await askNarrower(ui, request);
    case "reason": return await askReason(ui, request);
  }
}

async function askNarrower<Scope, Destination>(ui: PermissionUI, { subject, narrower, durations, destinations = [] }: PermissionRequest<Scope, Destination>): Promise<AnyAnswer<Scope, Destination> | undefined> {
  const choice = narrower.length === 1 ? narrower[0] : await pickScope(ui, subject, narrower);
  if (!choice) return undefined;
  const picked = await pickDurationOrDestination(ui, `Allow ${choice.label} for how long?`, durations, destinations);
  if (picked === undefined) return undefined;
  return "destination" in picked ? { decision: "allow-to", destination: picked.destination, scope: choice.scope } : { decision: "allow", duration: picked.duration, scope: choice.scope };
}

async function pickScope<Scope>(ui: PermissionUI, subject: string, narrower: readonly ScopeChoice<Scope>[]): Promise<ScopeChoice<Scope> | undefined> {
  const labels = narrower.map(({ label }) => label);
  const choice = await ui.select(`Allow less than ${subject}:`, labels);
  return narrower[labels.indexOf(choice ?? "")];
}

async function askReason<Scope, Destination>(ui: PermissionUI, { subject, durations }: PermissionRequest<Scope, Destination>): Promise<AnyAnswer<Scope, Destination> | undefined> {
  const note = (await ui.input(`Why deny ${subject}? The agent sees this.`, "Leave empty to go back"))?.trim();
  if (!note) return undefined;
  const duration = await pickDuration(ui, `Deny ${subject} for how long?`, durations);
  return duration === undefined ? undefined : { decision: "deny", duration, note };
}

async function pickDurationOrDestination<Destination>(
  ui: PermissionUI,
  title: string,
  durations: readonly Duration[],
  destinations: readonly DestinationChoice<Destination>[],
): Promise<{ duration: Duration } | { destination: Destination } | undefined> {
  const durationLabels = durations.map((duration) => DURATION_LABELS[duration]);
  const choice = await ui.select(title, [...durationLabels, ...destinations.map(({ label }) => label)]);
  const duration = durations[durationLabels.indexOf(choice ?? "")];
  if (duration !== undefined) return { duration };
  const destination = destinations.find(({ label }) => label === choice);
  return destination === undefined ? undefined : { destination: destination.destination };
}

async function pickDuration(ui: PermissionUI, title: string, durations: readonly Duration[]): Promise<Duration | undefined> {
  const labels = durations.map((duration) => DURATION_LABELS[duration]);
  const choice = await ui.select(title, labels);
  return durations[labels.indexOf(choice ?? "")];
}

const ALLOW_LABELS: Record<Duration, string> = { once: ALLOW_ONCE, session: ALLOW_SESSION, always: ALLOW_ALWAYS };
const DENY_LABELS: Record<Duration, string> = { once: DENY_ONCE, session: DENY_SESSION, always: DENY_ALWAYS };
const DURATION_LABELS: Record<Duration, string> = { once: "Once", session: "This session", always: "Always" };
