import assert from "node:assert/strict";
import test from "node:test";
import { shouldDeliver } from "../index.ts";

test("delivers matching unseen handoff", () => {
  assert.equal(shouldDeliver({ payload: { taskId: "t1", handoffId: "h1", to: "worker" }, myTaskId: "t1", myRole: "worker", seenHandoffIds: [] }), true);
});

test("rejects wrong task, role, duplicate, and malformed payload", () => {
  const base = { myTaskId: "t1", myRole: "worker" as const, seenHandoffIds: [] };
  assert.equal(shouldDeliver({ ...base, payload: { taskId: "t2", handoffId: "h1", to: "worker" } }), false);
  assert.equal(shouldDeliver({ ...base, payload: { taskId: "t1", handoffId: "h1", to: "qa" } }), false);
  assert.equal(shouldDeliver({ ...base, payload: { taskId: "t1", handoffId: "h1", to: "worker" }, seenHandoffIds: ["h1"] }), false);
  assert.equal(shouldDeliver({ ...base, payload: {} as any }), false);
  assert.doesNotThrow(() => shouldDeliver({ ...base, payload: null as any }));
  assert.doesNotThrow(() => shouldDeliver(null as any));
  assert.equal(shouldDeliver(null as any), false);
});
