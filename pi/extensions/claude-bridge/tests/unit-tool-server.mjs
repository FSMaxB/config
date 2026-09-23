import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolServer } from "../src/tool-server.ts";

const QUESTION_SCHEMA = {
	type: "object",
	required: ["question"],
	properties: {
		question: { type: "string", description: "The question to ask" },
		options: {
			type: "array",
			description: "Answers to choose from",
			items: {
				type: "object",
				required: ["title"],
				properties: {
					title: { type: "string" },
					description: { type: "string", description: "Longer description explaining this option" },
				},
			},
		},
		limit: { type: "integer", minimum: 1, description: "Maximum number of answers" },
	},
};

describe("createToolServer", () => {
	it("lists the pi JSON Schema byte-identically on the wire", async () => {
		// arrange
		const parameters = { ...QUESTION_SCHEMA, [Symbol.for("TypeBox.Kind")]: "Object" };
		const sent = [];
		const { client } = await connect([{ name: "question", description: "Ask", parameters, handler: async () => ({ content: [] }) }], sent);

		// act
		await client.listTools();

		// assert
		const response = sent.find((message) => JSON.stringify(message).includes('"tools":['));
		assert.equal(response.result.tools[0].name, "question");
		assert.equal(JSON.stringify(response.result.tools[0].inputSchema), JSON.stringify(QUESTION_SCHEMA));
	});

	it("passes the raw arguments to the handler and returns its result", async () => {
		// arrange
		const seen = [];
		const handler = async (args) => { seen.push(args); return { content: [{ type: "text", text: "ok" }], isError: false }; };
		const { client } = await connect([{ name: "echo", description: "Echo", parameters: { type: "object", properties: {} }, handler }]);

		// act
		const result = await client.callTool({ name: "echo", arguments: { id: "1", stray: { nested: true } } });

		// assert
		assert.deepEqual(seen, [{ id: "1", stray: { nested: true } }]);
		assert.deepEqual(result, { content: [{ type: "text", text: "ok" }], isError: false });
	});

	it("rejects an unknown tool name", async () => {
		// arrange
		const { client } = await connect([]);

		// act / assert
		await assert.rejects(client.callTool({ name: "missing", arguments: {} }), /Tool missing not found/);
	});
});

async function connect(tools, sent = []) {
	const { instance } = createToolServer("custom-tools", tools);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const send = serverTransport.send.bind(serverTransport);
	serverTransport.send = (message, options) => { sent.push(JSON.parse(JSON.stringify(message))); return send(message, options); };
	await instance.connect(serverTransport);
	const client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client };
}
