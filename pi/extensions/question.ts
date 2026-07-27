import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const FREEFORM_SENTINEL = "✏️  Type custom response...";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		// The MCP bridge flattens nested object schemas and drops descriptions from optional
		// parameters, so the option shape and the flag defaults only survive in here.
		description:
			"Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. " +
			"Ask exactly one focused question per call. Before calling, gather context with tools and pass a short summary via the context field. " +
			'Each entry in options must be an object like {"title": "Short label", "description": "Optional longer detail"}, where title is required. ' +
			"Set allowMultiple to true to let the user pick several options (default false), or allowFreeform to false to require one of the listed options (default true).",
		promptSnippet:
			"Ask the user one focused question with optional multiple-choice answers to gather information interactively",
		promptGuidelines: [
			"Before calling question, gather context with tools and pass a short summary via the context field.",
			"Use question when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
			"Ask exactly one focused question per question call.",
		],
		// Flips the whole tool batch out of parallel mode, but calls the model emitted
		// before this one still run first. Prevents concurrency, not ordering.
		executionMode: "sequential",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			context: Type.Optional(
				Type.String({ description: "Relevant context to show before the question (summary of findings)" }),
			),
			options: Type.Optional(
				Type.Array(
					// Flat object rather than a union: several providers strip union item
					// schemas, leaving the model to guess the shape.
					Type.Object({
						title: Type.String({ description: "Short title for this option" }),
						description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
					}),
					{ description: "List of options for the user to choose from" },
				),
			),
			allowFreeform: Type.Optional(Type.Boolean({ description: "Add a freeform text option. Default: true" })),
			allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { question, context, options: rawOptions = [], allowFreeform = true, allowMultiple = false } = params;
			const normalizedContext = context?.trim() || undefined;
			const options = rawOptions
				.map(coerceOption)
				.filter((option): option is QuestionOption => option !== null);

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: { question, context: normalizedContext, options, response: null, cancelled: true },
				};
			}

			if (rawOptions.length > 0 && options.length === 0) {
				const error = `All ${rawOptions.length} option(s) were malformed, so nothing could be shown to the user. Each option needs a "title" that is not empty or whitespace-only, plus an optional "description". Call question again with corrected options.`;
				return {
					content: [{ type: "text", text: error }],
					isError: true,
					details: { question, context: normalizedContext, options, response: null, cancelled: true, error },
				};
			}

			if (options.length === 0 && !allowFreeform) {
				const error =
					"allowFreeform is false but no options were given, leaving the user nothing to pick. Call question again with at least one option, or allow freeform answers.";
				return {
					content: [{ type: "text", text: error }],
					isError: true,
					details: { question, context: normalizedContext, options, response: null, cancelled: true, error },
				};
			}

			const prompt = buildPrompt(question, normalizedContext);

			if (!ctx.hasUI) {
				const optionText = options.length > 0 ? `\n\nOptions:\n${formatOptionList(options)}` : "";
				const freeformHint = allowFreeform ? "\n\nYou may also answer freely." : "";
				return {
					content: [
						{
							type: "text",
							text: `Interactive UI is unavailable. Please answer directly:\n\n${prompt}${optionText}${freeformHint}`,
						},
					],
					isError: true,
					details: { question, context: normalizedContext, options, response: null, cancelled: true },
				};
			}

			const outcome = options.length === 0
				? await askFreeform(ctx.ui, prompt)
				: allowMultiple
					? await askMultiple(ctx.ui, prompt, options, allowFreeform)
					: await askSingle(ctx.ui, prompt, options, allowFreeform);

			if (outcome.kind === "cancelled") {
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { question, context: normalizedContext, options, response: null, cancelled: true },
				};
			}

			if (outcome.kind === "unparseable") {
				const error = `Could not match "${outcome.input}" to any option. Expected comma-separated option numbers, ranges, or "all" (for example 1,3-5) within 1 to ${options.length}, or exact option titles. Call question again.`;
				return {
					content: [{ type: "text", text: error }],
					isError: true,
					details: { question, context: normalizedContext, options, response: null, cancelled: true, error },
				};
			}

			const summary = outcome.kind === "freeform" ? outcome.text : outcome.selections.join(", ");
			const unresolved = outcome.kind === "selection" ? outcome.unresolved ?? [] : [];
			const warning = unresolved.length > 0
				? ` (could not interpret: ${unresolved.join(", ")} — confirm with the user before relying on this answer)`
				: "";
			return {
				content: [{ type: "text", text: `User answered: ${summary}${warning}` }],
				details: { question, context: normalizedContext, options, response: outcome, cancelled: false },
			};
		},

		renderCall(args, theme) {
			const rawOptions = Array.isArray(args.options) ? args.options : [];
			let text = theme.fg("toolTitle", theme.bold("question "));
			text += theme.fg("muted", args.question ?? "");
			if (rawOptions.length > 0) {
				const titles = rawOptions.map((option: unknown) => coerceOption(option)?.title ?? "<invalid>");
				text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${titles.join(", ")}`);
			}
			if (args.allowMultiple) {
				text += theme.fg("dim", " [multi-select]");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, renderOptions, theme) {
			const details = result.details as QuestionDetails | undefined;

			if (renderOptions.isPartial) {
				return new Text(theme.fg("muted", "Waiting for your answer..."), 0, 0);
			}
			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			if (!details?.response) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const { response } = details;
			let text = theme.fg("success", "✓ ");
			if (response.kind === "freeform") {
				text += theme.fg("muted", "(wrote) ");
			}
			text += theme.fg("accent", response.kind === "freeform" ? response.text : response.selections.join(", "));

			if (renderOptions.expanded) {
				text += "\n" + theme.fg("dim", `Q: ${details.question}`);
				if (details.context) {
					text += "\n" + theme.fg("dim", details.context);
				}
			}
			return new Text(text, 0, 0);
		},
	});
}

interface QuestionOption {
	title: string;
	description?: string;
}

type QuestionResponse =
	| { kind: "selection"; selections: string[]; unresolved?: string[] }
	| { kind: "freeform"; text: string };

interface SelectionTokens {
	selections: string[];
	unresolved: string[];
}

type AskOutcome = QuestionResponse | { kind: "cancelled" } | { kind: "unparseable"; input: string };

interface QuestionDetails {
	question: string;
	context?: string;
	options: QuestionOption[];
	response: QuestionResponse | null;
	cancelled: boolean;
	error?: string;
}

function buildPrompt(question: string, context: string | undefined): string {
	return context ? `${question}\n\nContext:\n${context}` : question;
}

async function askSingle(
	ui: ExtensionUIContext,
	prompt: string,
	options: QuestionOption[],
	allowFreeform: boolean,
): Promise<AskOutcome> {
	// select() only takes strings, so descriptions have to ride along in the label
	// and be mapped back by position afterwards.
	const displays = options.map(({ title, description }) => (description ? `${title} — ${description}` : title));
	if (allowFreeform) displays.push(FREEFORM_SENTINEL);

	const picked = await ui.select(prompt, displays);
	if (isCancelled(picked)) return { kind: "cancelled" };
	if (picked === FREEFORM_SENTINEL) return askFreeform(ui, prompt);

	const index = displays.indexOf(picked);
	return index >= 0 && index < options.length
		? { kind: "selection", selections: [options[index].title] }
		: { kind: "cancelled" };
}

async function askMultiple(
	ui: ExtensionUIContext,
	prompt: string,
	options: QuestionOption[],
	allowFreeform: boolean,
): Promise<AskOutcome> {
	const body =
		`${prompt}\n\nOptions (numbers, ranges, or "all" — e.g. 1,3-5,8):\n${formatOptionList(options)}`;
	const reply = await ui.input(body, "e.g. 1,3-5 or all");
	if (isCancelled(reply)) return { kind: "cancelled" };

	const { selections, unresolved } = resolveSelectionTokens(reply, options);
	if (selections.length > 0) return { kind: "selection", selections, unresolved };

	const trimmed = reply.trim();
	if (!trimmed) return { kind: "cancelled" };
	return allowFreeform ? { kind: "freeform", text: trimmed } : { kind: "unparseable", input: trimmed };
}

async function askFreeform(ui: ExtensionUIContext, prompt: string): Promise<AskOutcome> {
	const answer = await ui.input(prompt, "Type your answer...");
	if (isCancelled(answer)) return { kind: "cancelled" };

	const trimmed = answer.trim();
	return trimmed ? { kind: "freeform", text: trimmed } : { kind: "cancelled" };
}

function resolveSelectionTokens(input: string, options: QuestionOption[]): SelectionTokens {
	const selections: string[] = [];
	const unresolved: string[] = [];
	for (const token of input.split(",")) {
		const trimmed = token.trim();
		if (!trimmed) continue;

		const matched = resolveToken(trimmed, options);
		if (matched.length > 0) selections.push(...matched);
		else unresolved.push(trimmed);
	}
	return { selections: [...new Set(selections)], unresolved };
}

function resolveToken(token: string, options: QuestionOption[]): string[] {
	const titles = options.map(({ title }) => title);
	if (token === "*" || token.toLowerCase() === "all") return titles;

	const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(token);
	if (range) {
		const [start, end] = [Number(range[1]), Number(range[2])];
		const [first, last] = start <= end ? [start, end] : [end, start];
		if (first >= 1 && last <= titles.length) return titles.slice(first - 1, last);
	}

	const position = Number(token);
	if (Number.isInteger(position) && position >= 1 && position <= titles.length) return [titles[position - 1]];

	const match = titles.find((title) => title.toLowerCase() === token.toLowerCase());
	return match ? [match] : [];
}

function formatOptionList(options: QuestionOption[]): string {
	return options
		.map(({ title, description }, index) => `${index + 1}. ${title}${description ? ` — ${description}` : ""}`)
		.join("\n");
}

function coerceOption(option: unknown): QuestionOption | null {
	// renderCall feeds this partially-streamed, unvalidated arguments, so bare strings and
	// missing fields arrive here even though the parameter schema forbids them.
	if (typeof option === "string") {
		const title = option.trim();
		return title ? { title } : null;
	}
	if (option && typeof option === "object") {
		const { title, description } = option as { title?: unknown; description?: unknown };
		if (typeof title === "string" && title.trim()) {
			const trimmedDescription = typeof description === "string" ? description.trim() : "";
			return trimmedDescription ? { title: title.trim(), description: trimmedDescription } : { title: title.trim() };
		}
	}
	return null;
}

function isCancelled(value: string | undefined | null): value is undefined | null {
	return value === undefined || value === null;
}
