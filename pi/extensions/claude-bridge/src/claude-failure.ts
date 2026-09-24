import { resetTimestampMs } from "./rate-limit.js";

export type ClaudeFailureKind = "auth" | "billing" | "rate-limit" | "overloaded" | "server" | "network";

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
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
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
		|| httpStatusInText(normalized) === 401 || httpStatusInText(normalized) === 403) return "auth";
	if (/extra usage|overage/.test(normalized)) return "rate-limit";
	if (/billing error|payment|required.*billing|credit balance.*(?:low|insufficient|empty)|insufficient credits/.test(normalized)) return "billing";
	const quotaInUsageContext = /\bquota\b/.test(normalized) && /\b(?:rate|usage|limits?|requests?|tokens?|messages?|api)\b/.test(normalized);
	if (/\brate limit|usage limit|session limit|weekly limit|monthly limit|limit reached|you(?:'|’)ve hit your .* limit|too many requests|resets? (?:at )?\d/.test(normalized)
		|| quotaInUsageContext || httpStatusInText(normalized) === 429) return "rate-limit";
	if (/overloaded|capacity/.test(normalized) || httpStatusInText(normalized) === 529) return "overloaded";
	const statusInText = httpStatusInText(normalized);
	if (/server error|internal server/.test(normalized) || (statusInText !== undefined && statusInText >= 500)) return "server";
	if (/network|timeout|timed out|socket|econn|connection closed|fetch failed|unexpected end|\beof\b/.test(normalized)) return "network";
	return undefined;
}

function httpStatusInText(normalized: string): number | undefined {
	const match = /\b(?:http|https|status(?: code)?|error|code)\b[^a-z0-9]{0,4}([45]\d\d)\b/.exec(normalized);
	return match ? Number(match[1]) : undefined;
}

function classifyStatusCode(status: number): ClaudeFailureKind | undefined {
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "billing";
	if (status === 429) return "rate-limit";
	if (status === 529) return "overloaded";
	if (status >= 500 && status <= 599) return "server";
	return undefined;
}
