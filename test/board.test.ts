import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// board.ts resolves the task root through os.homedir() on every call, so an
// isolated HOME is all the sandboxing these tests need.
process.env.HOME = mkdtempSync(join(tmpdir(), "blanche-home-"));

const {
	taskDir,
	createTask,
	readBoard,
	writeBoard,
	updateBoard,
	listTasks,
	writeCheckpoint,
	currentRole,
	currentTaskId,
	requireTaskId,
	taskIdFromSessionName,
} = await import("../board.ts");

const crew = {
	workflow: "feat",
	prefix: "mb",
	roster: ["worker", "qa"],
	agents: {},
	phases: [{ name: "QA", owner: "qa" }],
	specs: true,
	advisorAfter: null,
	maxRework: 3,
	maxWorkers: 1,
	configRevision: "sha",
} as any;

const newTask = (id: string) =>
	createTask({
		id,
		workflow: "feat",
		prefix: "mb",
		title: `title ${id}`,
		description: "requirement text",
		resolved: crew,
	});

test("operator fallbacks resolve the leader role and the sole task", () => {
	const oldRole = process.env.BLANCHE_ROLE;
	const oldTask = process.env.BLANCHE_TASK;
	delete process.env.BLANCHE_ROLE;
	delete process.env.BLANCHE_TASK;
	try {
		assert.equal(currentRole(), "leader");
		const cwd = mkdtempSync(join(tmpdir(), "blanche-fallback-"));
		newTask("t-fallback");
		const board = readBoard("t-fallback");
		board.cwd = cwd;
		writeBoard(board);
		assert.equal(currentTaskId(cwd), "t-fallback");
	} finally {
		if (oldRole === undefined) delete process.env.BLANCHE_ROLE;
		else process.env.BLANCHE_ROLE = oldRole;
		if (oldTask === undefined) delete process.env.BLANCHE_TASK;
		else process.env.BLANCHE_TASK = oldTask;
	}
});

test("session identity resolves a known task before cwd ambiguity, and env wins", () => {
	const oldTask = process.env.BLANCHE_TASK;
	const cwd = mkdtempSync(join(tmpdir(), "blanche-session-name-"));
	newTask("t-session-name");
	const board = readBoard("t-session-name");
	board.cwd = cwd;
	writeBoard(board);
	assert.equal(taskIdFromSessionName("mb-t-session-name-worker"), "t-session-name");
	assert.equal(taskIdFromSessionName("unknown-t-session-name-worker"), undefined);
	delete process.env.BLANCHE_TASK;
	assert.equal(currentTaskId(cwd, "mb-t-session-name-worker"), "t-session-name");
	process.env.BLANCHE_TASK = "explicit-task";
	assert.equal(currentTaskId(cwd, "mb-t-session-name-worker"), "explicit-task");
	if (oldTask === undefined) delete process.env.BLANCHE_TASK;
	else process.env.BLANCHE_TASK = oldTask;
});

test("operator task fallback rejects ambiguous tasks with an explicit id hint", () => {
	const oldTask = process.env.BLANCHE_TASK;
	delete process.env.BLANCHE_TASK;
	const cwd = mkdtempSync(join(tmpdir(), "blanche-ambiguous-"));
	for (const id of ["t-ambiguous-a", "t-ambiguous-b"]) {
		newTask(id);
		const board = readBoard(id);
		board.cwd = cwd;
		writeBoard(board);
	}
	try {
		assert.equal(currentTaskId(cwd), undefined, "passive context lookup must not guess");
		assert.throws(() => requireTaskId(cwd), /Multiple tasks/);
		assert.throws(() => requireTaskId(cwd), /t-ambiguous-a/);
		assert.throws(() => requireTaskId(cwd), /t-ambiguous-b/);
		assert.throws(() => requireTaskId(cwd), /\/crew <action> <id>/);
	} finally {
		if (oldTask === undefined) delete process.env.BLANCHE_TASK;
		else process.env.BLANCHE_TASK = oldTask;
	}
});

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

test("updateBoard reads fresh state, applies a mutation, and bumps revision once", () => {
	const b = newTask("t-update");
	const updated = updateBoard("t-update", (fresh) => {
		fresh.phase = "VERIFY";
	});
	assert.equal(updated.revision, b.revision + 1);
	assert.equal(readBoard("t-update").phase, "VERIFY");
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
	assert.equal(
		listTasks().some((b) => b.id === "t-list"),
		true,
	);
});

test("listTasks orders by recency, not by task id", () => {
	// ids chosen so lexicographic order is the opposite of the correct answer
	newTask("z-old");
	newTask("a-new");
	// set mtimes explicitly so the assertion cannot flake on fast filesystems
	const stamp = (id: string, secs: number) => utimesSync(join(taskDir(id), "board.json"), secs, secs);
	stamp("z-old", 1_000_000);
	stamp("a-new", 2_000_000);

	const ids = listTasks()
		.map((b) => b.id)
		.filter((id) => id === "z-old" || id === "a-new");
	assert.deepEqual(ids, ["a-new", "z-old"], "most recently updated first");

	// and it must track updates, not creation: touching the old one reverses it
	stamp("z-old", 3_000_000);
	const after = listTasks()
		.map((b) => b.id)
		.filter((id) => id === "z-old" || id === "a-new");
	assert.deepEqual(after, ["z-old", "a-new"], "recency follows the latest write");
});

test("listTasks cwd filter normalises trailing slashes, dot segments and symlinks", () => {
	const real = mkdtempSync(join(tmpdir(), "blanche-cwd-"));
	mkdirSync(join(real, "sub"), { recursive: true });
	const target = join(real, "sub");

	createTask({
		id: "t-here",
		workflow: "feat",
		prefix: "mb",
		title: "here",
		description: "",
		resolved: crew,
		cwd: target,
	});
	createTask({
		id: "t-elsewhere",
		workflow: "feat",
		prefix: "mb",
		title: "elsewhere",
		description: "",
		resolved: crew,
		cwd: join(real, "other"),
	});

	const idsFor = (c: string) => listTasks(c).map((b) => b.id);

	assert.deepEqual(idsFor(target), ["t-here"], "exact path matches");
	assert.deepEqual(idsFor(`${target}/`), ["t-here"], "trailing slash still matches");
	assert.deepEqual(idsFor(join(real, "sub", ".")), ["t-here"], "dot segment still matches");
	// on macOS tmpdir() is a symlink (/tmp -> /private/tmp), so this is the real case
	assert.deepEqual(idsFor(join(real, "other", "..", "sub")), ["t-here"], "dotdot segment still matches");
});
