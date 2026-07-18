import assert from "node:assert/strict";
import test from "node:test";
import { initialStack, transition, type Screen } from "../src/router.js";

test("initialStack is [home]", () => {
  assert.deepEqual(initialStack(), [{ id: "home" }]);
});

test("transition never mutates its input", () => {
  const stack: Screen[] = [{ id: "home" }];
  const frozen = JSON.stringify(stack);
  const next = transition(stack, { t: "push", screen: { id: "digest" } });
  assert.equal(JSON.stringify(stack), frozen, "input array untouched");
  assert.notEqual(next, stack, "returns a new array");
});

test("push appends a frame", () => {
  const next = transition([{ id: "home" }], { t: "push", screen: { id: "intake", draftId: "d1" } });
  assert.deepEqual(next, [{ id: "home" }, { id: "intake", draftId: "d1" }]);
});

test("replaceTop swaps the top frame", () => {
  const stack: Screen[] = [{ id: "home" }, { id: "digest" }];
  const next = transition(stack, { t: "replaceTop", screen: { id: "search", query: "x" } });
  assert.deepEqual(next, [{ id: "home" }, { id: "search", query: "x" }]);
});

test("pop repeatedly bottoms out at [home] and never empties", () => {
  let stack: Screen[] = [
    { id: "home" },
    { id: "digest" },
    { id: "drillin", workflowId: "w1" },
    { id: "session", worktreeId: "wt1" },
  ];
  for (let i = 0; i < 10; i++) {
    stack = transition(stack, { t: "pop" });
    assert.ok(stack.length >= 1, "stack never empties");
    assert.deepEqual(stack[0], { id: "home" }, "bottom is always home");
  }
  assert.deepEqual(stack, [{ id: "home" }]);
});

test("triageWalk from any depth yields exactly [home, escalation]", () => {
  const depths: Screen[][] = [
    [{ id: "home" }],
    [{ id: "home" }, { id: "digest" }],
    [{ id: "home" }, { id: "drillin", workflowId: "w1" }, { id: "session", worktreeId: "wt1" }],
  ];
  for (const stack of depths) {
    const next = transition(stack, { t: "triageWalk", escalationId: "e9" });
    assert.deepEqual(next, [{ id: "home" }, { id: "escalation", escalationId: "e9" }]);
  }
});

test("openSearch pushes a search frame", () => {
  const next = transition([{ id: "home" }], { t: "openSearch", query: "conflict" });
  assert.deepEqual(next, [{ id: "home" }, { id: "search", query: "conflict" }]);
});

test("bottom of the stack is always home after any single action", () => {
  const actions = [
    { t: "push", screen: { id: "digest" } },
    { t: "pop" },
    { t: "triageWalk", escalationId: "e1" },
    { t: "openSearch", query: "q" },
    { t: "replaceTop", screen: { id: "digest" } },
  ] as const;
  for (const action of actions) {
    const next = transition([{ id: "home" }], action);
    assert.deepEqual(next[0], { id: "home" });
  }
});
