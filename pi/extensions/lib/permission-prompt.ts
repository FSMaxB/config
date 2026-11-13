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

export interface PermissionRequest<Scope> {
  title: string;
  // What a denial blocks, named in the follow-up prompts, e.g. "network access to example.com".
  subject: string;
  // What the plain allow options grant.
  scope: Scope;
  // Strictly smaller alternatives, narrowest first; empty hides "Allow narrower…".
  narrower: readonly ScopeChoice<Scope>[];
  durations: readonly Duration[];
  preselected?: string;
}

export type PermissionAnswer<Scope> =
  | { decision: "allow"; duration: Duration; scope: Scope }
  | { decision: "deny"; duration: Duration; note: string | undefined };

// Dismissing the main prompt denies once, so a queue of prompts does not ask again after Esc.
// Backing out of a follow-up (Esc, or an empty reason) returns to the main prompt instead.
export async function askPermission<Scope>(ui: PermissionUI, request: PermissionRequest<Scope>): Promise<PermissionAnswer<Scope>> {
  const options = menuOptions(request);
  while (true) {
    const choice = await ui.select(request.title, options.map(({ label }) => label), request.preselected);
    const option = options.find(({ label }) => label === choice);
    if (!option) return { decision: "deny", duration: Duration.Once, note: undefined };
    const answer = await resolveOption(ui, request, option);
    if (answer) return answer;
  }
}

export function userReason(note: string | undefined): string {
  return note ? ` The user's reason: ${note}` : "";
}

type MenuOption<Scope> =
  | { label: string; kind: "answer"; answer: PermissionAnswer<Scope> }
  | { label: string; kind: "narrower" }
  | { label: string; kind: "reason" };

function menuOptions<Scope>({ scope, narrower, durations }: PermissionRequest<Scope>): MenuOption<Scope>[] {
  const allow = durations.map((duration): MenuOption<Scope> => ({ label: ALLOW_LABELS[duration], kind: "answer", answer: { decision: "allow", duration, scope } }));
  const deny = durations.map((duration): MenuOption<Scope> => ({ label: DENY_LABELS[duration], kind: "answer", answer: { decision: "deny", duration, note: undefined } }));
  const narrow: MenuOption<Scope>[] = narrower.length > 0 ? [{ label: ALLOW_NARROWER, kind: "narrower" }] : [];
  return [...allow, ...narrow, ...deny, { label: DENY_WITH_REASON, kind: "reason" }];
}

// undefined sends the user back to the main prompt.
async function resolveOption<Scope>(ui: PermissionUI, request: PermissionRequest<Scope>, option: MenuOption<Scope>): Promise<PermissionAnswer<Scope> | undefined> {
  switch (option.kind) {
    case "answer": return option.answer;
    case "narrower": return await askNarrower(ui, request);
    case "reason": return await askReason(ui, request);
  }
}

async function askNarrower<Scope>(ui: PermissionUI, { subject, narrower, durations }: PermissionRequest<Scope>): Promise<PermissionAnswer<Scope> | undefined> {
  const choice = narrower.length === 1 ? narrower[0] : await pickScope(ui, subject, narrower);
  if (!choice) return undefined;
  const duration = await pickDuration(ui, `Allow ${choice.label} for how long?`, durations);
  return duration === undefined ? undefined : { decision: "allow", duration, scope: choice.scope };
}

async function pickScope<Scope>(ui: PermissionUI, subject: string, narrower: readonly ScopeChoice<Scope>[]): Promise<ScopeChoice<Scope> | undefined> {
  const labels = narrower.map(({ label }) => label);
  const choice = await ui.select(`Allow less than ${subject}:`, labels);
  return narrower[labels.indexOf(choice ?? "")];
}

async function askReason<Scope>(ui: PermissionUI, { subject, durations }: PermissionRequest<Scope>): Promise<PermissionAnswer<Scope> | undefined> {
  const note = (await ui.input(`Why deny ${subject}? The agent sees this.`, "Leave empty to go back"))?.trim();
  if (!note) return undefined;
  const duration = await pickDuration(ui, `Deny ${subject} for how long?`, durations);
  return duration === undefined ? undefined : { decision: "deny", duration, note };
}

async function pickDuration(ui: PermissionUI, title: string, durations: readonly Duration[]): Promise<Duration | undefined> {
  const labels = durations.map((duration) => DURATION_LABELS[duration]);
  const choice = await ui.select(title, labels);
  return durations[labels.indexOf(choice ?? "")];
}

const ALLOW_LABELS: Record<Duration, string> = { once: ALLOW_ONCE, session: ALLOW_SESSION, always: ALLOW_ALWAYS };
const DENY_LABELS: Record<Duration, string> = { once: DENY_ONCE, session: DENY_SESSION, always: DENY_ALWAYS };
const DURATION_LABELS: Record<Duration, string> = { once: "Once", session: "This session", always: "Always" };
