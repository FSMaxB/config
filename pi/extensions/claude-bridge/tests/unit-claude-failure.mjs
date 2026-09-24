import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyClaudeFailure, rateLimitResetMs, rateLimitTypeFromInfo } from "../src/claude-failure.ts";

describe("Claude failure classification", () => {
	it("classifies ordinary CLI errors without matching unrelated numbers", () => {
		// arrange
		const cases = [
			["You've hit your weekly limit · resets Thursday 4am", "rate-limit"],
			["Extra usage is disabled for this account", "rate-limit"],
			["API quota exceeded for requests", "rate-limit"],
			["OAuth token has expired; please run /login", "auth"],
			["permission_error", "auth"],
			["billing error: payment required", "billing"],
			["API Error: 529 overloaded_error", "overloaded"],
			["HTTP 500", "server"],
			["ECONNRESET while streaming", "network"],
			["EACCES: permission denied, open '/etc/hosts'", undefined],
			["disk quota exceeded", undefined],
			["the request took 500ms", undefined],
			["processed 429 rows", undefined],
			["line 502 of the file", undefined],
		];
		// act
		const actual = cases.map(([value]) => classifyClaudeFailure(value));
		// assert
		assert.deepEqual(actual, cases.map(([, expected]) => expected));
	});

	it("prefers structured HTTP statuses and extracts SDK reset fields", () => {
		// arrange
		const statuses = [
			[{ status: 429, message: "request rejected" }, "rate-limit"],
			[{ statusCode: 401, message: "nope" }, "auth"],
			[{ status: 529 }, "overloaded"],
			[{ status: 500 }, "server"],
			[{ status: 402 }, "billing"],
			[{ status: 403, type: "permission_error" }, "auth"],
		];
		const resetSeconds = Math.floor((Date.now() + 60_000) / 1000);
		// act
		const actual = statuses.map(([value]) => classifyClaudeFailure(value));
		const rateLimitType = rateLimitTypeFromInfo({ rate_limit_type: "seven_day_fable" });
		const resetMs = rateLimitResetMs({ resets_at: resetSeconds });
		const isoReset = rateLimitResetMs({ resetsAt: "2030-01-01T00:00:00Z" });
		// assert
		assert.deepEqual(actual, statuses.map(([, expected]) => expected));
		assert.equal(rateLimitType, "seven_day_fable");
		assert.equal(resetMs, resetSeconds * 1000);
		assert.equal(isoReset, Date.parse("2030-01-01T00:00:00Z"));
	});
});
