import assert from "node:assert/strict";
import { test } from "node:test";
import { registerToolWithGuidelines } from "./register-tool.ts";

test("guideline registration preserves the tool API metadata and callbacks", () => {
  // arrange
  const registered: unknown[] = [];
  const definition = {
    name: "fixture", label: "Fixture", description: "Original description",
    parameters: { type: "object" }, promptGuidelines: ["A guideline"],
    exposure: "model-only", namespace: { name: "fixtures", description: "Test tools" },
    annotations: { readOnlyHint: true }, outputSchema: { type: "object" },
    prepareLoadout: () => ({ hiddenDeclarations: ["other"] }),
    execute: async () => ({ content: [], details: undefined }),
    renderCall: () => undefined, renderResult: () => undefined,
  };
  // act
  registerToolWithGuidelines({ registerTool: tool => registered.push(tool) } as never, definition as never);
  // assert
  assert.deepEqual(registered, [{ ...definition, description: "Original description A guideline" }]);
});
