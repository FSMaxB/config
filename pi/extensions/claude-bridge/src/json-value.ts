import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

// Tool arguments reach the bridge as JSON (the SDK's streamed input, the MCP server's validated
// copy), but typed as unknown; these checks give them pi's JSON types.

export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isJsonObject(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every(isJsonValue);
}

// Keys whose value is not JSON (undefined from an optional field, most commonly) are dropped, as
// JSON.stringify would drop them; anything but an object gives an empty object.
export function jsonObjectFrom(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const result: JsonObject = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isJsonValue(entry)) result[key] = entry;
	}
	return result;
}

export function parseJsonObject(text: string): JsonObject | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
