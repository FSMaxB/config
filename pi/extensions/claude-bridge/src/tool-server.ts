// Serves pi's tools over MCP with their JSON Schema untouched.
//
// The Agent SDK's createSdkMcpServer only accepts Zod shapes, and converting
// pi's TypeBox schemas to Zod lost `integer`, min/max bounds and several other
// keywords, so the model saw a degraded parameter shape. The SDK only ever
// calls `connect(transport)` on an `{ type: "sdk", instance }` server, so a
// low-level MCP Server answering tools/list and tools/call directly stands in
// for the Zod-based helper. It performs no argument validation either: the
// handler receives exactly what the model sent, which is what claimToolCall
// compares against the streamed tool_use input. Pi validates the arguments
// against the TypeBox schema itself before running the tool.

import { createRequire } from "node:module";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpResult } from "./extract-tool-results.js";

type McpServerModule = typeof import("@modelcontextprotocol/sdk/server/index.js");
type McpTypesModule = typeof import("@modelcontextprotocol/sdk/types.js");

// Required on first use, not imported: the MCP SDK (with zod and ajv) cost every pi startup
// ~60 ms although only a query ever builds a tool server.
const requirePackage = createRequire(import.meta.url);

export interface BridgedTool {
	name: string;
	description: string;
	parameters: unknown;
	handler: (args: Record<string, unknown> | undefined) => Promise<McpResult>;
}

export function createToolServer(name: string, tools: BridgedTool[]): McpSdkServerConfigWithInstance {
	const { Server } = requirePackage("@modelcontextprotocol/sdk/server/index.js") as McpServerModule;
	const { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } =
		requirePackage("@modelcontextprotocol/sdk/types.js") as McpTypesModule;
	const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: toJsonSchema(tool.parameters),
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = tools.find((candidate) => candidate.name === request.params.name);
		if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
		// Returned as-is, not just { content, isError }: the SDK's own McpServer does
		// the same (mcp.js executeToolHandler → `return result`), and the handler's
		// extra `toolCallId` field is relied on elsewhere.
		return await tool.handler(request.params.arguments);
	});
	return { type: "sdk", name, instance: server as unknown as McpSdkServerConfigWithInstance["instance"] };
}

// The JSON round trip drops TypeBox's symbol keys and keeps everything else verbatim.
function toJsonSchema(schema: unknown): { type: "object"; [key: string]: unknown } {
	const json = JSON.parse(JSON.stringify(schema ?? {})) as Record<string, unknown>;
	return { ...json, type: "object" };
}
