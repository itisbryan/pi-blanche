import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// board.ts resolves the task root through os.homedir() on every call, so an
// isolated HOME is all the sandboxing these tests need.
process.env.HOME = mkdtempSync(join(tmpdir(), "blanche-home-"));

const { taskDir, createTask, readBoard, writeBoard, commitBoard, listTasks, writeCheckpoint } =
  await import("../board.ts");

const crew = {
  workflow: "feat", prefix: "mb", roster: ["worker", "qa"], agents: {},
  phases: [{ name: "QA", owner: "qa" }], specs: true,
  advisorAfter: null, maxRework: 3, maxWorkers: 1, configRevision: "sha",
} as any;

const newTask = (id: string) =>
  createTask({ id, workflow: "feat", prefix: "mb", title: `title ${id}`, description: "requirement text", resolved: crew });

test("task directory is deterministic", () => {
  assert.match(taskDir("x"), /tasks\/x$/);
});

test("create -> read -> write -> read preserves fields and bumps revision exactly once", () => {
  const created = newTask("t-round");
  assert.equal(created.revision, 0);

  const read = readBoard("t-round");
  assert.equal(read.id, "t-round");
  assert.equal(read.workflow, "feat");
  assert.equal(read.task.title, "title t-round");
  assert.equal(read.status, "active");
  assert.equal(read.phase, "REQUESTED");
  assert.equal(read.revision, 0);

  read.phase = "QA";
  writeBoard(read);
  assert.equal(read.revision, 1, "writeBoard bumps in place");

  const again = readBoard("t-round");
  assert.equal(again.revision, 1, "exactly once, not twice");
  assert.equal(again.phase, "QA");
  assert.equal(again.task.title, "title t-round", "unrelated fields survive");
});

test("createTask makes sibling spec/checkpoint/consultation dirs, not nested ones", () => {
  newTask("t-dirs");
  for (const d of ["specs", "checkpoints", "consultations"]) {
    assert.equal(existsSync(join(taskDir("t-dirs"), d)), true, `${d} must be a sibling`);
  }
});

test("writeCheckpoint lands in checkpoints/ and omits empty sections", () => {
  const b = newTask("t-cp");
  const path = writeCheckpoint(b, "worker" as any, "s02", 1, {
    completed: ["did the thing"],
    failedApproaches: [{ approach: "redis lock", result: "still races", whyItFailed: "lock after the read" }],
  });
  assert.match(path, /checkpoints\/s02-worker-e1\.md$/);
  const body = readFileSync(path, "utf8");
  assert.match(body, /did the thing/);
  assert.match(body, /lock after the read/);
  assert.doesNotMatch(body, /## Remaining/, "empty sections are omitted, not rendered blank");
});

test("commitBoard succeeds on the current revision", () => {
  const b = newTask("t-commit");
  const next = readBoard("t-commit");
  next.phase = "VERIFY";
  const res = commitBoard(next, b.revision);
  assert.equal(res.ok, true);
  assert.equal(readBoard("t-commit").phase, "VERIFY");
});

test("commitBoard rejects a stale revision, returns current, and leaves disk untouched", () => {
  newTask("t-stale");
  const a = readBoard("t-stale");
  const b = readBoard("t-stale");

  a.phase = "QA";
  assert.equal(commitBoard(a, a.revision).ok, true);

  b.phase = "CLOBBERED";
  const res = commitBoard(b, 0);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.current.phase, "QA", "loser is handed the current board");
  assert.equal(readBoard("t-stale").phase, "QA", "disk is untouched by the loser");
});

test("after writeBoard no .tmp remains and the board parses", () => {
  const b = newTask("t-atomic");
  writeBoard(b);
  const left = readdirSync(taskDir("t-atomic")).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(left, [], "no partial file survives a write");
  assert.doesNotThrow(() => readBoard("t-atomic"));
});

test("listTasks returns saved boards", () => {
  newTask("t-list");
  assert.equal(listTasks().some((b) => b.id === "t-list"), true);
});
