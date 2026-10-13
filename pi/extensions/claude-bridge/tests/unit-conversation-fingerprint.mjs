import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conversationFingerprint, conversationFingerprintsMatch } from "../src/session-persistence.js";

const user = (text) => ({ role: "user", content: text });
const assistant = () => ({ role: "assistant", content: [] });
const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const assistantCall = (name, args) => ({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name, arguments: args }] });

describe("conversationFingerprint", () => {
	it("hashes the FIRST user message's text, string or block form alike", () => {
		const fromString = conversationFingerprint([user("hello")]);
		assert.match(fromString, /^u:[0-9a-f]{12}$/);
		assert.equal(conversationFingerprint([{ role: "user", content: [{ type: "text", text: "hello" }] }]), fromString);
		// An assistant message with empty content (an aborted turn) adds no
		// second component — same anchor as the bare opener.
		assert.equal(conversationFingerprint([user("hello"), assistant(), user("later turn")]), fromString);
		assert.notEqual(conversationFingerprint([user("other opener")]), fromString);
	});

	it("adds the FIRST assistant message's text as a second component once one exists", () => {
		const grown = conversationFingerprint([user("hello"), assistantText("first answer"), user("later turn")]);
		assert.match(grown, /^u:[0-9a-f]{12}\|a:[0-9a-f]{12}$/);
		// The user component is shared with the turn-1 form; the assistant text
		// is what discriminates two same-opener conversations.
		assert.equal(grown.startsWith(conversationFingerprint([user("hello")])), true);
		assert.equal(conversationFingerprint([user("hello"), assistantText("first answer")]), grown);
		assert.notEqual(conversationFingerprint([user("hello"), assistantText("other answer")]), grown);
	});

	it("anchors the second component on a tool-call-only first assistant message", () => {
		// arrange
		const opener = user("hello");

		// act
		const withCall = conversationFingerprint([opener, assistantCall("set_session_name", { name: "debug the bridge" })]);
		const otherArguments = conversationFingerprint([opener, assistantCall("set_session_name", { name: "plan a feature" })]);
		const skippedEmpty = conversationFingerprint([opener, assistant(), assistantText("first answer")]);

		// assert
		assert.match(withCall, /^u:[0-9a-f]{12}\|a:[0-9a-f]{12}$/);
		assert.notEqual(withCall, otherArguments, "the call's arguments are part of the identity");
		assert.equal(skippedEmpty, conversationFingerprint([opener, assistantText("first answer")]), "an empty assistant message is skipped");
	});

	it("returns undefined when conversation identity is unknown", () => {
		const rows = [
			["empty history", []],
			["assistant only", [assistant()]],
			["image opener", [{ role: "user", content: [{ type: "image", data: "zzz", mimeType: "image/png" }] }]],
			["blank opener", [{ role: "user", content: "   " }]],
		];
		for (const [name, messages] of rows) assert.equal(conversationFingerprint(messages), undefined, name);
	});
});

describe("conversationFingerprintsMatch", () => {
	it("lets the assistant component decide once both anchors carry one", () => {
		// arrange
		const answer = assistantText("first answer");
		// A context handler prepended a request-local message on the turn the
		// record was stamped, so the recorded opener is not the persisted one.
		const recorded = conversationFingerprint([user("request-local bootstrap"), user("hello"), answer]);
		const persisted = conversationFingerprint([user("hello"), answer]);
		const sameOpenerOtherAnswer = conversationFingerprint([user("request-local bootstrap"), assistantText("other answer")]);

		// act + assert
		assert.equal(conversationFingerprintsMatch(recorded, persisted), true, "the persisted first assistant message identifies the conversation");
		assert.equal(conversationFingerprintsMatch(recorded, sameOpenerOtherAnswer), false, "a same opener with another first answer is foreign");
	});

	it("compares the opener while either anchor lacks an assistant component", () => {
		// arrange
		const turnOne = conversationFingerprint([user("hello")]);
		const grown = conversationFingerprint([user("hello"), assistantText("first answer")]);
		const other = conversationFingerprint([user("other opener"), assistantText("first answer")]);

		// act + assert
		assert.equal(conversationFingerprintsMatch(turnOne, grown), true);
		assert.equal(conversationFingerprintsMatch(turnOne, other), false);
		assert.equal(conversationFingerprintsMatch("garbage", other), true, "an unparseable anchor fails open");
	});
});

