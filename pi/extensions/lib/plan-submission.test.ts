import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canSubmitReviewedPlan, registerPlanSubmission, submitReviewedPlan } from "./plan-submission.ts";

it("discovers across separate API wrappers and awaits the live handler", async () => {
  // arrange
  const bus = eventBus();
  const context = {} as ExtensionContext;
  const controller = new AbortController();
  const params = { path: "/plan.md", suggestedModel: "fixture/model", suggestedModelReason: "Mechanical work" };
  const expected = { content: [{ type: "text" as const, text: "approved" }], details: { path: params.path, outcome: "approved" } };
  let received: unknown[];
  registerPlanSubmission({ ...bus }, {
    available: (liveContext) => liveContext === context,
    submit: async (...arguments_) => { received = arguments_; return expected; },
  });
  // act
  const available = canSubmitReviewedPlan({ ...bus }, context);
  const result = await submitReviewedPlan({ ...bus }, params, controller.signal, context);
  // assert
  assert.equal(available, true);
  assert.equal(result, expected);
  assert.deepEqual(received!, [params, controller.signal, context]);
});

it("treats a missing handler as unavailable and rejects invocation", async () => {
  // arrange
  const bus = eventBus();
  const context = {} as ExtensionContext;
  // act
  const available = canSubmitReviewedPlan(bus, context);
  const result = submitReviewedPlan(bus, { path: "/plan.md" }, undefined, context);
  // assert
  assert.equal(available, false);
  await assert.rejects(result, /not available/);
});

it("rejects duplicate service registrations", async () => {
  // arrange
  const bus = eventBus();
  const context = {} as ExtensionContext;
  registerPlanSubmission(bus, savedService());
  registerPlanSubmission(bus, savedService());
  // act
  const invocation = submitReviewedPlan(bus, { path: "/plan.md" }, undefined, context);
  // assert
  assert.throws(() => canSubmitReviewedPlan(bus, context), /Multiple/);
  await assert.rejects(invocation, /Multiple/);
});

it("honors disposal and keeps separate session buses isolated", async () => {
  // arrange
  const first = eventBus();
  const second = eventBus();
  const context = {} as ExtensionContext;
  const dispose = registerPlanSubmission(first, savedService());
  // act
  const firstAvailable = canSubmitReviewedPlan(first, context);
  const secondAvailable = canSubmitReviewedPlan(second, context);
  dispose();
  const disposedAvailable = canSubmitReviewedPlan(first, context);
  // assert
  assert.equal(firstAvailable, true);
  assert.equal(secondAvailable, false);
  assert.equal(disposedAvailable, false);
});

it("checks availability with live state and propagates submission failures", async () => {
  // arrange
  const bus = eventBus();
  const context = {} as ExtensionContext;
  let available = false;
  registerPlanSubmission(bus, {
    available: () => available,
    submit: async () => { throw new Error("Submission failed"); },
  });
  // act
  const inactive = canSubmitReviewedPlan(bus, context);
  available = true;
  const active = canSubmitReviewedPlan(bus, context);
  const result = submitReviewedPlan(bus, { path: "/plan.md" }, undefined, context);
  // assert
  assert.equal(inactive, false);
  assert.equal(active, true);
  await assert.rejects(result, /Submission failed/);
});

it("does not invoke a handler after cancellation", async () => {
  // arrange
  const bus = eventBus();
  const controller = new AbortController();
  let submitted = false;
  registerPlanSubmission(bus, {
    available: () => true,
    submit: async () => { submitted = true; return { content: [], details: { path: null, outcome: "saved" } }; },
  });
  controller.abort();
  // act
  const result = submitReviewedPlan(bus, { path: "/plan.md" }, controller.signal, {} as ExtensionContext);
  // assert
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(submitted, false);
});

function savedService() {
  return {
    available: () => true,
    submit: async () => ({ content: [], details: { path: null, outcome: "saved" } }),
  };
}

function eventBus(): ExtensionAPI["events"] {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const listeners = handlers.get(channel) ?? new Set();
      handlers.set(channel, listeners);
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    },
  };
}
