import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SUBMIT_PLAN = "submit_plan";
const UNGATED_TOOLS = new Set(["repo_read", "repo_grep", "repo_find", "repo_ls", "question", SUBMIT_PLAN]);

const DECISIONS_FILE = join(getAgentDir(), "plan-mode.json");
const PLANS_DIR = join(getAgentDir(), "plans");

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow in session";
const ALLOW_ALWAYS = "Allow always";
const DENY_SESSION = "Deny in session";
const DENY_ALWAYS = "Deny always";
const APPROVE = "Approve — leave plan mode";
const REFINE = "Refine — send feedback";
const CLEAR_ALL = "Clear all";
const DONE = "Done";

const COLLAPSED_PLAN_LINES = 15;

export default function (pi: ExtensionAPI) {
	let planMode = false;
	let agentRunning = false;
	let pendingToggle: boolean | undefined;
	const sessionGrants = new Set<string>();
	const alwaysGrants = new Set<string>();
	const sessionDenials = new Set<string>();
	const alwaysDenials = new Set<string>();
	let promptChain: Promise<void> = Promise.resolve();

	function isAllowed(toolName: string): boolean {
		return UNGATED_TOOLS.has(toolName) || sessionGrants.has(toolName) || alwaysGrants.has(toolName);
	}

	function blockedReason(toolName: string): string | undefined {
		if (alwaysDenials.has(toolName)) return deniedReason(toolName, "you denied it for all sessions");
		if (sessionDenials.has(toolName)) return deniedReason(toolName, "you denied it for this session");
		return undefined;
	}

	// The most recent decision wins outright, so a tool never sits in two sets and
	// a narrow grant can always override an earlier "always" denial.
	async function record(toolName: string, decision: Set<string>): Promise<void> {
		for (const set of [sessionGrants, alwaysGrants, sessionDenials, alwaysDenials]) {
			set.delete(toolName);
		}
		decision.add(toolName);
		persist();
		await writePersistedDecisions(alwaysGrants, alwaysDenials);
	}

	function persist(): void {
		pi.appendEntry("plan-mode", {
			enabled: planMode,
			sessionGrants: [...sessionGrants],
			sessionDenials: [...sessionDenials],
		});
	}

	function refreshIndicators(ctx: ExtensionContext): void {
		const pendingChange = pendingToggle !== undefined && pendingToggle !== planMode;
		ctx.ui.setStatus("plan-mode", planMode ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
		ctx.ui.setWidget("plan-mode", planBanner(ctx.ui.theme, planMode, pendingChange), { placement: "aboveEditor" });
	}

	// submit_plan is added and removed as a delta against the live tool list rather than
	// restored from a snapshot, so a changed extension set can never resurrect stale tools.
	function syncSubmitPlanTool(): void {
		const active = pi.getActiveTools();
		const present = active.includes(SUBMIT_PLAN);
		if (planMode && !present) {
			pi.setActiveTools([...active, SUBMIT_PLAN]);
		} else if (!planMode && present) {
			pi.setActiveTools(active.filter((name) => name !== SUBMIT_PLAN));
		}
	}

	function setPlanMode(enabled: boolean, ctx: ExtensionContext): void {
		planMode = enabled;
		syncSubmitPlanTool();
		refreshIndicators(ctx);
		persist();
	}

	function toggle(ctx: ExtensionContext): void {
		if (agentRunning) {
			pendingToggle = !(pendingToggle ?? planMode);
			refreshIndicators(ctx);
			ctx.ui.notify(`Plan mode will be ${pendingToggle ? "enabled" : "disabled"} at the next tool call.`);
			return;
		}
		setPlanMode(!planMode, ctx);
		ctx.ui.notify(planMode ? "Plan mode enabled." : "Plan mode disabled.");
	}

	function flushPendingToggle(ctx: ExtensionContext): void {
		if (pendingToggle === undefined) return;

		const enabled = pendingToggle;
		pendingToggle = undefined;
		if (enabled === planMode) {
			refreshIndicators(ctx);
			return;
		}
		setPlanMode(enabled, ctx);
		ctx.ui.notify(planMode ? "Plan mode enabled." : "Plan mode disabled.");
	}

	// ui.select() owns the terminal, and pi dispatches tool batches through
	// executeToolCallsParallel, so concurrent gate handlers would fight over it.
	function serialize<T>(task: () => Promise<T>): Promise<T> {
		const result = promptChain.then(task, task);
		promptChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function requestPermission(event: ToolCallEvent, ctx: ExtensionContext) {
		// An earlier prompt from the same batch may have decided this tool while we queued.
		const blocked = blockedReason(event.toolName);
		if (blocked) return { block: true, reason: blocked };
		if (isAllowed(event.toolName)) return undefined;

		const choice = await ctx.ui.select(`Plan mode — allow ${event.toolName}?\n\n  ${summarizeInput(event)}`, [
			ALLOW_ONCE,
			ALLOW_SESSION,
			ALLOW_ALWAYS,
			"Deny once",
			DENY_SESSION,
			DENY_ALWAYS,
		]);

		switch (choice) {
			case ALLOW_ONCE:
				return undefined;
			case ALLOW_SESSION:
				await record(event.toolName, sessionGrants);
				return undefined;
			case ALLOW_ALWAYS:
				await record(event.toolName, alwaysGrants);
				return undefined;
			case DENY_SESSION:
				await record(event.toolName, sessionDenials);
				return { block: true, reason: deniedReason(event.toolName, "you denied it for this session") };
			case DENY_ALWAYS:
				await record(event.toolName, alwaysDenials);
				return { block: true, reason: deniedReason(event.toolName, "you denied it for all sessions") };
			default:
				return { block: true, reason: deniedReason(event.toolName, "the user denied this call") };
		}
	}

	async function manageDecisions(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Managing plan mode decisions needs an interactive UI.", "error");
			return;
		}

		while (true) {
			const entries = listDecisions(sessionGrants, alwaysGrants, sessionDenials, alwaysDenials);
			if (entries.length === 0) {
				ctx.ui.notify("No plan mode grants or denials recorded.");
				return;
			}

			const labels = entries.map(({ label }) => label);
			const choice = await ctx.ui.select("Plan mode decisions — pick one to remove", [...labels, CLEAR_ALL, DONE]);

			if (choice === CLEAR_ALL) {
				for (const set of [sessionGrants, alwaysGrants, sessionDenials, alwaysDenials]) {
					set.clear();
				}
				persist();
				await writePersistedDecisions(alwaysGrants, alwaysDenials);
				ctx.ui.notify("Cleared all plan mode grants and denials.");
				return;
			}

			const entry = entries[labels.indexOf(choice ?? "")];
			if (!entry) return;

			entry.set.delete(entry.toolName);
			persist();
			await writePersistedDecisions(alwaysGrants, alwaysDenials);
		}
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (tools that change things need approval)",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: SUBMIT_PLAN,
		label: "Submit plan",
		description:
			"Submit a finished plan for the user to approve. Only available in plan mode. " +
			"Writes the plan to a file and asks the user whether to approve it, request changes, or stay in plan mode. " +
			"Approval is the only way out of plan mode. The tool result contains the path the plan was written to.",
		promptSnippet: "Submit a finished plan for the user to approve, ending plan mode",
		promptGuidelines: [
			"Call submit_plan once the plan is complete, rather than describing the plan and waiting for a reply.",
			"Only the user can leave plan mode, so never assume approval before submit_plan returns it.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			title: Type.String({ description: "Short title for the plan, used for the filename" }),
			plan: Type.String({ description: "The full plan, as markdown" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { title, plan } = params;
			if (!planMode) {
				const error = "submit_plan is only available in plan mode.";
				return { content: [{ type: "text", text: error }], isError: true, details: { path: null, outcome: "unavailable" } };
			}

			const path = await writePlanFile(title, plan);

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `Plan written to ${path}. No interactive UI, so plan mode stays on.` }],
					details: { path, outcome: "saved" },
				};
			}

			const choice = await ctx.ui.select(`Plan submitted — what next?\n\n  ${path}`, [
				APPROVE,
				REFINE,
				"Stay in plan mode",
			]);

			if (choice === APPROVE) {
				setPlanMode(false, ctx);
				return {
					content: [
						{
							type: "text",
							text: `Plan approved and written to ${path}. Plan mode is off and full tool access is restored.`,
						},
					],
					details: { path, outcome: "approved" },
				};
			}

			if (choice === REFINE) {
				const feedback = (await ctx.ui.input("Feedback on the plan:", "What should change?"))?.trim();
				const text = feedback
					? `Plan written to ${path} but not approved. Still in plan mode. The user asks for: ${feedback}`
					: `Plan written to ${path} but not approved. Still in plan mode.`;
				return { content: [{ type: "text", text }], details: { path, outcome: "refine" } };
			}

			return {
				content: [{ type: "text", text: `Plan written to ${path}. Still in plan mode.` }],
				details: { path, outcome: "saved" },
			};
		},

		renderCall(args, theme, context) {
			const title = new Text(theme.fg("toolTitle", theme.bold("submit_plan ")) + theme.fg("muted", args.title ?? ""), 0, 0);
			const plan = typeof args.plan === "string" ? args.plan.trim() : "";
			if (!context.argsComplete || !plan) return title;

			const lines = plan.split("\n");
			const visible = context.expanded ? lines : lines.slice(0, COLLAPSED_PLAN_LINES);

			const container = new Container();
			container.addChild(title);
			container.addChild(new Markdown(visible.join("\n"), 2, 0, getMarkdownTheme()));
			if (visible.length < lines.length) {
				const hint = `… ${lines.length - visible.length} more lines (expand to see all)`;
				container.addChild(new Text(theme.fg("dim", hint), 2, 0));
			}
			return container;
		},

		renderResult(result, renderOptions, theme) {
			const details = result.details as { path: string | null; outcome: string } | undefined;
			if (renderOptions.isPartial) {
				return new Text(theme.fg("muted", "Waiting for your decision..."), 0, 0);
			}
			if (!details?.path) {
				return new Text(theme.fg("error", "✗ only available in plan mode"), 0, 0);
			}
			const label = details.outcome === "approved" ? "approved" : details.outcome === "refine" ? "needs changes" : "saved";
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", label) + theme.fg("dim", ` — ${details.path}`), 0, 0);
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or review recorded tool decisions with `grants`",
		getArgumentCompletions: (prefix) => ("grants".startsWith(prefix) ? [{ value: "grants", label: "grants" }] : null),
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (!argument) {
				toggle(ctx);
				return;
			}
			if (argument === "grants") {
				await manageDecisions(ctx);
				return;
			}
			ctx.ui.notify(`Unknown argument "${argument}". Use /plan to toggle or /plan grants to review.`, "error");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		flushPendingToggle(ctx);
		if (!planMode) return;

		const blocked = blockedReason(event.toolName);
		if (blocked) return { block: true, reason: blocked };
		if (isAllowed(event.toolName)) return;

		if (!ctx.hasUI) {
			return { block: true, reason: deniedReason(event.toolName, "there is no interactive UI to ask for approval") };
		}
		return await serialize(() => requestPermission(event, ctx));
	});

	pi.on("before_agent_start", async (event) => {
		if (!planMode) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${planModeInstructions()}` };
	});

	pi.on("agent_start", async () => {
		agentRunning = true;
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		flushPendingToggle(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		const { alwaysAllowed, alwaysDenied } = await readPersistedDecisions();
		for (const toolName of alwaysAllowed) {
			alwaysGrants.add(toolName);
		}
		for (const toolName of alwaysDenied) {
			alwaysDenials.add(toolName);
		}

		const restored = lastPlanModeState(ctx);
		if (restored) {
			planMode = restored.enabled;
			for (const toolName of restored.sessionGrants) {
				sessionGrants.add(toolName);
			}
			for (const toolName of restored.sessionDenials ?? []) {
				sessionDenials.add(toolName);
			}
		}
		if (pi.getFlag("plan") === true) {
			planMode = true;
		}

		syncSubmitPlanTool();
		refreshIndicators(ctx);
	});
}

interface PlanModeState {
	enabled: boolean;
	sessionGrants: string[];
	sessionDenials?: string[];
}

interface DecisionEntry {
	label: string;
	toolName: string;
	set: Set<string>;
}

function planBanner(theme: Theme, planMode: boolean, pendingChange: boolean): string[] | undefined {
	if (!planMode) {
		return pendingChange ? [theme.fg("dim", "⏸ plan mode starts at the next tool call")] : undefined;
	}

	const label = theme.fg("warning", theme.bold("⏸ PLAN MODE"));
	const hint = pendingChange
		? " — ending at the next tool call"
		: " — read-only tools run freely, everything else asks. /plan to exit";
	return [label + theme.fg("dim", hint)];
}

function listDecisions(
	sessionGrants: Set<string>,
	alwaysGrants: Set<string>,
	sessionDenials: Set<string>,
	alwaysDenials: Set<string>,
): DecisionEntry[] {
	const groups: [Set<string>, string][] = [
		[sessionGrants, "allow (session)"],
		[alwaysGrants, "allow (always)"],
		[sessionDenials, "deny (session)"],
		[alwaysDenials, "deny (always)"],
	];
	return groups.flatMap(([set, scope]) =>
		[...set].sort().map((toolName) => ({ label: `${toolName} — ${scope}`, toolName, set })),
	);
}

function summarizeInput(event: ToolCallEvent): string {
	const input = event.input as Record<string, unknown>;
	const detail =
		typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : JSON.stringify(input);
	return detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
}

function deniedReason(toolName: string, cause: string): string {
	return (
		`Plan mode is active and ${cause}, so ${toolName} did not run. ` +
		"Do not retry it and do not route around it with a different tool. " +
		"State what you need it for so the user can grant access, or call submit_plan if the plan is ready."
	);
}

function planModeInstructions(): string {
	const ungated = [...UNGATED_TOOLS].filter((name) => name !== SUBMIT_PLAN).join(", ");
	return [
		"Plan mode is active.",
		"",
		`- These tools are available as usual: ${ungated}.`,
		"- Every other tool, including bash and the unscoped read, write and edit, needs the user's approval for each call.",
		"- The repo_* tools are confined to the repository and prompt before reaching outside it, so prefer them over bash.",
		"- If a call is denied, do not retry it and do not route around it with a different tool.",
		`- Call ${SUBMIT_PLAN} when the plan is ready. Only the user can leave plan mode.`,
	].join("\n");
}

async function writePlanFile(title: string, plan: string): Promise<string> {
	const directory = join(PLANS_DIR, cwdSlug());
	await mkdir(directory, { recursive: true });

	const path = join(directory, `${timestamp()}-${slugify(title)}.md`);
	await writeFile(path, plan.endsWith("\n") ? plan : `${plan}\n`);
	return path;
}

function cwdSlug(): string {
	return process.cwd().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function timestamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	return slug || "plan";
}

function lastPlanModeState(ctx: ExtensionContext): PlanModeState | undefined {
	const entry = ctx.sessionManager
		.getEntries()
		.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
		.pop() as { data?: PlanModeState } | undefined;
	return entry?.data;
}

async function readPersistedDecisions(): Promise<{ alwaysAllowed: string[]; alwaysDenied: string[] }> {
	try {
		const parsed = JSON.parse(await readFile(DECISIONS_FILE, "utf8")) as Record<string, unknown>;
		return { alwaysAllowed: stringList(parsed.alwaysAllowed), alwaysDenied: stringList(parsed.alwaysDenied) };
	} catch {
		return { alwaysAllowed: [], alwaysDenied: [] };
	}
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function writePersistedDecisions(allowed: Set<string>, denied: Set<string>): Promise<void> {
	await mkdir(dirname(DECISIONS_FILE), { recursive: true });
	const content = { alwaysAllowed: [...allowed].sort(), alwaysDenied: [...denied].sort() };
	await writeFile(DECISIONS_FILE, `${JSON.stringify(content, null, 2)}\n`);
}
