import { resetTimestampMs } from "./rate-limit.js";
import { isRecord } from "../../lib/untyped.ts";

export function rateLimitTypeFromInfo(info: Record<string, unknown> | undefined): unknown {
	return info?.rateLimitType ?? info?.rate_limit_type ?? info?.type;
}

export function rateLimitResetMs(info: Record<string, unknown> | undefined): number | undefined {
	return resetTimestampMs(rateLimitResetFromInfo(info));
}

export function rateLimitResetFromInfo(info: Record<string, unknown> | undefined): unknown {
	return info?.resetsAt ?? info?.resets_at ?? info?.resetAt ?? info?.reset_at;
}

export function classifyClaudeFailure(value: unknown): ClaudeFailureKind | undefined {
	const details: unknown[] = [value];
	let numericStatus: number | undefined;
	if (isRecord(value)) {
		const record = value;
		details.push(record.name, record.type, record.message, record.code, record.status, record.statusCode, record.body, record.error);
		for (const field of [record.status, record.statusCode]) {
			if (typeof field === "number" && Number.isInteger(field)) { numericStatus = field; break; }
		}
	}
	const text = details.map((detail) => {
		if (typeof detail === "string" || typeof detail === "number") return String(detail);
		try { return JSON.stringify(detail ?? ""); } catch { return String(detail); }
	}).join(" ");
	const normalized = text.toLowerCase().replace(/[_-]+/g, " ");
	const statusKind = numericStatus !== undefined ? classifyStatusCode(numericStatus) : undefined;
	if (statusKind) return statusKind;
	if (/authentication (?:failed|error)|permission error|oauth org not allowed|oauth token.*expired|token.*expired|unauthorized|invalid token|login required|please run .*login|not logged in/.test(normalized)
		|| httpStatusInText(normalized) === HttpStatus.Unauthorized || httpStatusInText(normalized) === HttpStatus.Forbidden) return "auth";
	if (/extra usage|overage/.test(normalized)) return "rate-limit";
	if (/billing error|payment|required.*billing|credit balance.*(?:low|insufficient|empty)|insufficient credits/.test(normalized)) return "billing";
	const quotaInUsageContext = /\bquota\b/.test(normalized) && /\b(?:rate|usage|limits?|requests?|tokens?|messages?|api)\b/.test(normalized);
	if (/\brate limit|usage limit|session limit|weekly limit|monthly limit|limit reached|you(?:'|’)ve hit your .* limit|too many requests|resets? (?:at )?\d/.test(normalized)
		|| quotaInUsageContext || httpStatusInText(normalized) === HttpStatus.TooManyRequests) return "rate-limit";
	if (/overloaded|capacity/.test(normalized) || httpStatusInText(normalized) === HttpStatus.Overloaded) return "overloaded";
	const statusInText = httpStatusInText(normalized);
	if (/server error|internal server/.test(normalized) || (statusInText !== undefined && statusInText >= ServerErrorStatus.First)) return "server";
	if (/network|timeout|timed out|socket|econn|connection closed|fetch failed|unexpected end|\beof\b/.test(normalized)) return "network";
	return undefined;
}

function httpStatusInText(normalized: string): number | undefined {
	const match = /\b(?:http|https|status(?: code)?|error|code)\b[^a-z0-9]{0,4}([45]\d\d)\b/.exec(normalized);
	return match ? Number(match[1]) : undefined;
}

function classifyStatusCode(status: number): ClaudeFailureKind | undefined {
	if (status === HttpStatus.Unauthorized || status === HttpStatus.Forbidden) return "auth";
	if (status === HttpStatus.PaymentRequired) return "billing";
	if (status === HttpStatus.TooManyRequests) return "rate-limit";
	if (status === HttpStatus.Overloaded) return "overloaded";
	if (status >= ServerErrorStatus.First && status <= ServerErrorStatus.Last) return "server";
	return undefined;
}

export type ClaudeFailureKind = "auth" | "billing" | "rate-limit" | "overloaded" | "server" | "network";

// 529 is Anthropic's "overloaded" status, outside the standard HTTP set.
const HttpStatus = { Unauthorized: 401, PaymentRequired: 402, Forbidden: 403, TooManyRequests: 429, Overloaded: 529 } as const;
const ServerErrorStatus = { First: 500, Last: 599 } as const;
