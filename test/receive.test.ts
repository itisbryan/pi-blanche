import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

process.env.HOME = mkdtempSync(join("/tmp", "blanche-receive-home-"));

const { default: blancheExtension, shouldDeliver } = await import("../index.ts");
const { createTask, readBoard, taskDir, writeBoard } = await import("../board.ts");

test("delivers matching unseen handoff", () => {
	assert.equal(
		shouldDeliver({
			payload: { taskId: "t1", handoffId: "h1", to: "worker" },
			myTaskId: "t1",
			myRole: "worker",
			seenHandoffIds: [],
		}),
		true,
	);
});

test("rejects wrong task, role, duplicate, and malformed payload", () => {
	const base = { myTaskId: "t1", myRole: "worker" as const, seenHandoffIds: [] };
	assert.equal(shouldDeliver({ ...base, payload: { taskId: "t2", handoffId: "h1", to: "worker" } }), false);
	assert.equal(shouldDeliver({ ...base, payload: { taskId: "t1", handoffId: "h1", to: "qa" } }), false);
	assert.equal(
		shouldDeliver({
			...base,
			payload: { taskId: "t1", handoffId: "h1", to: "worker" },
			seenHandoffIds: ["h1"],
		}),
		false,
	);
	assert.equal(shouldDeliver({ ...base, payload: {} as any }), false);
	assert.doesNotThrow(() => shouldDeliver({ ...base, payload: null as any }));
	assert.doesNotThrow(() => shouldDeliver(null as any));
	assert.equal(shouldDeliver(null as any), false);
});

test("rejected handoff leaves board.json byte-identical", async () => {
	const id = "receive-rejected";
	const resolved = {
		workflow: "quick",
		prefix: "qk",
		roster: ["worker", "qa"],
		agents: {
			worker: { model: "worker-model", thinking: "low" },
			qa: { model: "qa-model", thinking: "low" },
		},
		phases: [{ name: "IMPLEMENTING", owner: "worker" }],
		specs: false,
		advisorAfter: null,
		maxRework: 2,
		maxWorkers: 1,
		configRevision: "x",
	};
	const board = createTask({
		id,
		workflow: "quick",
		prefix: "qk",
		title: "rejected",
		description: "d",
		resolved,
	});
	board.sessions = {
		worker: { sessionName: "receive-worker", contextEpoch: 0 },
		qa: { sessionName: "receive-qa", contextEpoch: 0 },
	};
	writeBoard(board);
	const boardPath = join(taskDir(id), "board.json");
	const before = readFileSync(boardPath, "utf8");
	process.env.BLANCHE_TASK = id;
	process.env.BLANCHE_ROLE = "qa";

	const tools: Record<string, any> = {};
	const channel = { listSessions: async () => [{ name: "receive-worker" }], publish: () => undefined };
	const pi = {
		on: () => undefined,
		registerCommand: () => undefined,
		registerTool: (tool: any) => {
			tools[tool.name] = tool;
		},
		events: { emit: (_name: string, registration: any) => registration.onReady(channel) },
		sendMessage: () => undefined,
	};
	blancheExtension(pi);

	await assert.rejects(
		() =>
			tools.handoff.execute("call", {
				to: "worker",
				phase: "IMPLEMENTING",
				spec: undefined,
				message: "should not deliver",
				verdict: "APPROVED",
			}),
		/PASS\|FAIL/,
	);
	assert.equal(readFileSync(boardPath, "utf8"), before);
	assert.deepEqual(readBoard(id).history, []);
});

test("successful handoff persists the reducer result before publishing", async () => {
	const id = "receive-success";
	const resolved = {
		workflow: "quick",
		prefix: "qk",
		roster: ["worker", "qa"],
		agents: {
			worker: { model: "worker-model", thinking: "low" },
			qa: { model: "qa-model", thinking: "low" },
		},
		phases: [{ name: "IMPLEMENTING", owner: "worker" }],
		specs: false,
		advisorAfter: null,
		maxRework: 2,
		maxWorkers: 1,
		configRevision: "x",
	};
	const board = createTask({
		id,
		workflow: "quick",
		prefix: "qk",
		title: "success",
		description: "d",
		resolved,
	});
	board.phase = "QA";
	board.owner = "qa";
	board.sessions = {
		worker: { sessionName: "success-worker", contextEpoch: 0 },
		qa: { sessionName: "success-qa", contextEpoch: 0 },
	};
	writeBoard(board);
	const before = readBoard(id);
	process.env.BLANCHE_TASK = id;
	process.env.BLANCHE_ROLE = "qa";

	const tools: Record<string, any> = {};
	const published: any[] = [];
	const channel = {
		listSessions: async () => [{ name: "success-worker" }],
		publish: (payload: any) => published.push(payload),
	};
	const pi = {
		on: () => undefined,
		registerCommand: () => undefined,
		registerTool: (tool: any) => {
			tools[tool.name] = tool;
		},
		events: { emit: (_name: string, registration: any) => registration.onReady(channel) },
		sendMessage: () => undefined,
	};
	blancheExtension(pi);

	const result: any = await tools.handoff.execute("call", {
		to: "worker",
		phase: "IMPLEMENTING",
		message: "implement now",
		verdict: "PASS",
	});
	const after = readBoard(id);
	assert.equal(after.revision, before.revision + 1);
	assert.equal(after.phase, "IMPLEMENTING");
	assert.equal(after.owner, "worker");
	assert.equal(after.history.length, 1);
	assert.equal(after.history[0].from, "qa");
	assert.equal(after.history[0].to, "worker");
	assert.equal(after.history[0].verdict, "PASS");
	assert.equal(after.history[0].ackedAt, undefined);
	assert.equal(published.length, 1);
	assert.equal(published[0].taskId, id);
	assert.equal(published[0].handoffId, after.history[0].handoffId);
	assert.equal(published[0].message, "implement now");
	assert.match(result.content[0].text, /implement now/);
});
