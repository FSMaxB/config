import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export async function toolApiSession({ extensions = [], factories = [], tools, settings = {}, entries = [] } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-tool-api-session-"));
	const requests = [];
	const responses = [];
	let extensionApi;
	const definitions = new Map();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false }, retry: { enabled: false }, ...settings,
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"), modelsPath: null,
		modelsStorePath: join(directory, "models-store.json"), refreshOnCreate: false,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true,
		noThemes: true, noContextFiles: true,
		additionalExtensionPaths: extensions,
		extensionFactories: [
			(pi) => {
				extensionApi = pi;
				pi.registerProvider("tool-api-test", {
					api: "tool-api-test", baseUrl: "http://invalid.test", apiKey: "offline",
					models: [{ id: "fake", name: "Offline fixture", reasoning: false, input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200000, maxTokens: 4096 }],
					streamSimple: (model, context) => scriptedStream(model, context, requests, responses),
				});
			},
			...factories.map(factory => (pi) => factory({
				...pi,
				registerTool(definition) {
					definitions.set(definition.name, definition);
					pi.registerTool(definition);
				},
			})),
		],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const sessionManager = SessionManager.inMemory(directory);
	for (const entry of entries) sessionManager.appendCustomEntry(entry.type, entry.data);
	const { session } = await createAgentSession({
		cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR,
		settingsManager, sessionManager, modelRuntime, resourceLoader, tools,
		model: { id: "fake", name: "Offline fixture", api: "tool-api-test", provider: "tool-api-test",
			baseUrl: "http://invalid.test", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 },
		thinkingLevel: "off",
	});
	await session.bindExtensions({});
	return {
		session, directory, requests, definitions,
		get api() { return extensionApi; },
		async call(name, arguments_ = {}) {
			const id = `fixture-${responses.length}-${requests.length}`;
			responses.push([{ type: "toolCall", id, name, arguments: arguments_ }]);
			await session.prompt("Run the fixture tool.");
			return session.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
		},
		async dispose() {
			await session.abort();
			session.dispose();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

function scriptedStream(model, context, requests, responses) {
	requests.push(structuredClone(context));
	const content = responses.shift() ?? [{ type: "text", text: "Fixture complete." }];
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [], timestamp: Date.now(), stopReason: "pending",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		stream.push({ type: "start", partial: message });
		for (const block of content) {
			const contentIndex = message.content.length;
			message.content.push(block);
			if (block.type === "toolCall") {
				stream.push({ type: "toolcall_start", contentIndex, partial: message });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
			} else {
				stream.push({ type: "text_start", contentIndex, partial: message });
				stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
				stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
			}
		}
		message.stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
		stream.push({ type: "done", reason: message.stopReason, message });
		stream.end();
	});
	return stream;
}
