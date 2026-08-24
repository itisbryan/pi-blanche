import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.HOME = mkdtempSync(join(tmpdir(), "blanche-index-home-"));
process.env.HERDR_BIN = join(import.meta.dirname, "fake-herdr.sh");
process.env.HERDR_STUB_LOG = join(process.env.HOME, "herdr.log");
process.env.BLANCHE_REGISTRATION_TIMEOUT_MS = "1000";

const { default: blancheExtension } = await import("../index.ts");
const { createTask, listTasks, readBoard, taskDir, updateBoard } = await import("../board.ts");
const { loadConfig } = await import("../config.ts");

type Handler = (...args: unknown[]) => unknown;
type Registration = { onReady: (channel: unknown) => unknown; onEvent: (event: unknown) => unknown };
type Command = (raw: string, ctx?: unknown) => Promise<string>;
type Tool = Record<string, unknown> & { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type Call = [Record<string, unknown>, Record<string, unknown>];

function harness() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const tools = new Map<string, Tool>();
	const sent: Call[] = [];
	let registration: Registration | undefined;
	let sessionName = "operator";
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		events: {
			emit(name: string, value: unknown) {
				if (name === "intercom:extension-register") registration = value as Registration;
			},
		},
		registerCommand(name: string, config: { handler: Command }) {
			commands.set(name, config.handler);
		},
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
		sendMessage(...args: unknown[]) {
			sent.push(args as Call);
		},
		setSessionName(name: string) {
			sessionName = name;
		},
		getSessionName() {
			return sessionName;
		},
	};
	return { pi, handlers, commands, tools, sent, getRegistration: () => registration };
}

const resolved = (role: "worker" | "researcher" = "worker") => ({
	workflow: "e2e",
	prefix: "e2e",
	roster: [role],
	agents: { [role]: { model: "test", thinking: "low" } },
	phases: [
		{ name: "REQUESTED", owner: "leader" },
		{ name: "IMPLEMENTING", owner: role },
	],
	specs: false,
	advisorAfter: null,
	maxRework: 2,
	maxWorkers: 1,
	configRevision: "test",
});

function seedPending(id: string, role: "worker" | "researcher", message: string) {
	createTask({
		id,
		workflow: "e2e",
		title: id,
		description: "test task",
		cwd: process.cwd(),
		resolved: resolved(role),
		prefix: "e2e",
		phase: "IMPLEMENTING",
		owner: role,
		leader: { sessionName: "e2e-leader" },
	});
	updateBoard(id, (board) => {
		board.sessions[role] = { sessionName: `e2e-${id}-${role}`, contextEpoch: 0 };
		board.history.push({
			handoffId: `handoff-${id}`,
			from: "leader",
			to: role,
			phase: "IMPLEMENTING",
			verdict: null,
			message,
			sentAt: 1,
		});
	});
}

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function paneRuns() {
	if (!existsSync(process.env.HERDR_STUB_LOG!)) return [];
	return readFileSync(process.env.HERDR_STUB_LOG!, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("pane run "));
}

test("operator kickoff records exactly one opening handoff for every workflow", async () => {
	const oldTask = process.env.BLANCHE_TASK;
	const oldRole = process.env.BLANCHE_ROLE;
	delete process.env.BLANCHE_TASK;
	delete process.env.BLANCHE_ROLE;
	const config = loadConfig();
	const h = harness();
	let active: { workflow: string; now: number } | undefined;
	const channel = {
		listSessions: async () => {
			if (!active) return [];
			const workflow = config.workflows[active.workflow];
			const id = `${active.workflow}-${active.now.toString(36)}`;
			return workflow.roles
				.filter((role) => role !== "leader")
				.map((role) => ({ name: `${workflow.prefix}-${id}-${role}` }));
		},
		publish() {},
	};
	const originalNow = Date.now;
	const originalCwd = process.cwd();
	try {
		blancheExtension(h.pi);
		const registration = h.getRegistration();
		assert.ok(registration, "extension must register with intercom");
		registration.onReady(channel);
		const command = h.commands.get("crew");
		assert.ok(command, "extension must register /crew");
		for (const [index, workflow] of Object.keys(config.workflows).entries()) {
			process.chdir(mkdtempSync(join(tmpdir(), `blanche-kickoff-${workflow}-`)));
			const now = 1_700_000_000_000 + index;
			Date.now = () => now;
			active = { workflow, now };
			const id = `${workflow}-${now.toString(36)}`;
			const description = `opening-${workflow}`;
			const expectedEager = new Set(
				config.workflows[workflow].phases
					.filter((phase) => phase.owner !== "leader")
					.map((phase) => phase.owner),
			);
			if (config.workflows[workflow].roles.includes("researcher")) expectedEager.add("researcher");
			const beforeRuns = paneRuns().length;
			const message = await command(`${workflow} "${description}"`, {});
			assert.equal(paneRuns().length - beforeRuns, expectedEager.size, `${workflow} eager pane count`);
			assert.match(message, /work handed over/);
			const board = readBoard(id);
			const opening = config.workflows[workflow].phases.find((phase) => phase.owner !== "leader");
			assert.ok(opening);
			assert.equal(board.history.length, 1, `${workflow} must have one opening handoff`);
			assert.deepEqual(
				{
					from: board.history[0].from,
					to: board.history[0].to,
					phase: board.history[0].phase,
					message: board.history[0].message,
				},
				{ from: "leader", to: opening.owner, phase: opening.name, message: description },
			);
			assert.equal(board.phase, opening.name);
			assert.equal(board.owner, opening.owner);
			assert.deepEqual(new Set(Object.keys(board.sessions)), expectedEager, `${workflow} session roster`);
			assert.equal(board.sessions.advisor === undefined, !expectedEager.has("advisor"));
			const role = expectedEager.has("researcher") ? "researcher" : opening.owner;
			process.env.BLANCHE_TASK = id;
			process.env.BLANCHE_ROLE = role;
			const prompt = await h.handlers.get("before_agent_start")?.();
			const systemPrompt = (prompt as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
			for (const session of Object.values(board.sessions)) {
				if (session?.sessionName) assert.match(systemPrompt, new RegExp(session.sessionName));
			}
			if (!expectedEager.has("advisor")) assert.doesNotMatch(systemPrompt, new RegExp(`${id}-advisor`));
			delete process.env.BLANCHE_TASK;
			delete process.env.BLANCHE_ROLE;
		}
	} finally {
		Date.now = originalNow;
		process.chdir(originalCwd);
		restoreEnv("BLANCHE_TASK", oldTask);
		restoreEnv("BLANCHE_ROLE", oldRole);
	}
});

test("kickoff diagnoses missing pi-intercom before creating a task", async () => {
	const oldCwd = process.cwd();
	const cwd = mkdtempSync(join(tmpdir(), "blanche-no-intercom-"));
	process.chdir(cwd);
	const h = harness();
	try {
		blancheExtension(h.pi);
		const command = h.commands.get("crew");
		assert.ok(command);
		await assert.rejects(
			() => command('quick "no broker"', {}),
			/needs pi-intercom.*pi install npm:pi-intercom/,
		);
		assert.equal(listTasks(cwd).length, 0, "missing intercom must create no task");
	} finally {
		process.chdir(oldCwd);
	}
});

test("kickoff refuses an active same-cwd crew without creating anything, then allows stop and clean recovery", async () => {
	const oldTask = process.env.BLANCHE_TASK;
	const oldRole = process.env.BLANCHE_ROLE;
	const oldCwd = process.cwd();
	const oldNow = Date.now;
	delete process.env.BLANCHE_TASK;
	delete process.env.BLANCHE_ROLE;
	const config = loadConfig();
	const quick = config.workflows.quick;
	const cwd = mkdtempSync(join(tmpdir(), "blanche-blocking-"));
	process.chdir(cwd);
	const blocker = "blocking-crew";
	createTask({
		id: blocker,
		workflow: "quick",
		title: blocker,
		description: "blocking",
		cwd,
		resolved: {
			workflow: "quick",
			prefix: quick.prefix,
			roster: quick.roles.filter((role) => role !== "leader"),
			agents: config.agents,
			phases: quick.phases,
			specs: quick.specs,
			advisorAfter: quick.advisorAfter,
			maxRework: quick.maxRework,
			maxWorkers: quick.maxWorkers,
			configRevision: "test",
		},
		prefix: "qk",
		phase: "IMPLEMENTING",
		owner: "worker",
		leader: { sessionName: "qk-blocking-crew-leader" },
	});
	const h = harness();
	let activeId: string | undefined;
	let activeNow = 1_800_000_000_000;
	const channel = {
		listSessions: async () => {
			if (!activeId) return [];
			return config.workflows.quick.roles
				.filter((role) => role !== "leader")
				.map((role) => ({ name: `qk-${activeId}-${role}` }));
		},
		publish() {},
	};
	try {
		blancheExtension(h.pi);
		const registration = h.getRegistration();
		assert.ok(registration);
		registration.onReady(channel);
		const command = h.commands.get("crew");
		assert.ok(command);
		const beforeIds = listTasks(cwd).map((board) => board.id);
		const beforeRuns = paneRuns().length;
		Date.now = () => activeNow;
		await assert.rejects(() => command('quick "must-refuse"', {}), /already active.*blocking-crew/);
		assert.deepEqual(
			listTasks(cwd).map((board) => board.id),
			beforeIds,
		);
		assert.equal(paneRuns().length, beforeRuns, "refusal must open no panes");

		await command("stop blocking-crew", {});
		activeNow++;
		activeId = `quick-${activeNow.toString(36)}`;
		const afterStop = await command('quick "after-stop"', {});
		assert.match(afterStop, /started/);
		assert.equal(readBoard(activeId).status, "active");
		await command(`clean ${activeId}`, {});
		assert.equal(existsSync(taskDir(activeId)), false);

		activeNow++;
		activeId = `quick-${activeNow.toString(36)}`;
		const afterClean = await command('quick "after-clean"', {});
		assert.match(afterClean, /started/);
		assert.equal(readBoard(activeId).status, "active");
	} finally {
		Date.now = oldNow;
		process.chdir(oldCwd);
		restoreEnv("BLANCHE_TASK", oldTask);
		restoreEnv("BLANCHE_ROLE", oldRole);
	}
});

test("advisor is lazy, nudge-spawned once, and its handoff is delivered", async () => {
	const oldTask = process.env.BLANCHE_TASK;
	const oldRole = process.env.BLANCHE_ROLE;
	const id = "lazy-advisor";
	process.env.BLANCHE_TASK = id;
	process.env.BLANCHE_ROLE = "qa";
	createTask({
		id,
		workflow: "e2e",
		title: id,
		description: "lazy",
		cwd: process.cwd(),
		resolved: {
			workflow: "e2e",
			prefix: "e2e",
			roster: ["worker", "qa", "advisor"],
			agents: {
				worker: { model: "test", thinking: "low" },
				qa: { model: "test", thinking: "low" },
				advisor: { model: "test", thinking: "low" },
			},
			phases: [
				{ name: "IMPLEMENTING", owner: "worker" },
				{ name: "QA", owner: "qa" },
			],
			specs: false,
			advisorAfter: 1,
			maxRework: 3,
			maxWorkers: 1,
			configRevision: "test",
		},
		prefix: "e2e",
		phase: "QA",
		owner: "qa",
		leader: { sessionName: "e2e-leader" },
	});
	updateBoard(id, (board) => {
		board.sessions.worker = { sessionName: `e2e-${id}-worker`, contextEpoch: 0 };
		board.sessions.qa = { sessionName: `e2e-${id}-qa`, contextEpoch: 0 };
	});
	const h = harness();
	const delivered: unknown[] = [];
	const channel = {
		listSessions: async () => [
			{ name: `e2e-${id}-worker` },
			{ name: `e2e-${id}-qa` },
			{ name: `e2e-${id}-advisor` },
		],
		publish(payload: unknown) {
			delivered.push(payload);
		},
	};
	try {
		blancheExtension(h.pi);
		const registration = h.getRegistration();
		assert.ok(registration);
		registration.onReady(channel);
		const handoff = h.tools.get("handoff");
		assert.ok(handoff);
		const beforeRuns = paneRuns().length;
		await handoff.execute("call", { to: "worker", phase: "QA", verdict: "FAIL", message: "rework" });
		const afterNudge = readBoard(id);
		assert.ok(afterNudge.sessions.advisor, "advisor appears only when the nudge fires");
		assert.equal(paneRuns().length - beforeRuns, 1, "advisor nudge opens one pane");
		const advisorPane = afterNudge.sessions.advisor?.paneId;
		assert.equal(delivered.length, 1);
		assert.equal(
			(delivered[0] as { to: string }).to,
			"worker",
			"the nudge is not sent to an advisor before its pane exists",
		);

		process.env.BLANCHE_ROLE = "worker";
		await handoff.execute("call", { to: "advisor", phase: "QA", message: "lazy-advisor-nonce" });
		const afterFirst = readBoard(id);
		assert.equal(afterFirst.sessions.advisor?.paneId, advisorPane);
		assert.equal(paneRuns().length - beforeRuns, 1, "ensureRole is idempotent");
		assert.equal(delivered.length, 2);
		assert.equal((delivered[1] as { to: string; message: string }).to, "advisor");
		assert.equal((delivered[1] as { message: string }).message, "lazy-advisor-nonce");

		const promptHandler = h.handlers.get("before_agent_start");
		assert.ok(promptHandler);
		const prompt = await promptHandler();
		assert.match((prompt as { systemPrompt: string }).systemPrompt, new RegExp(`${id}-advisor`));
	} finally {
		restoreEnv("BLANCHE_TASK", oldTask);
		restoreEnv("BLANCHE_ROLE", oldRole);
	}
});

test("every registered tool exposes a described object schema", () => {
	const h = harness();
	blancheExtension(h.pi);
	const registration = h.getRegistration();
	assert.ok(registration);
	registration.onReady({ listSessions: async () => [], publish() {} });
	assert.deepEqual([...h.tools.keys()].sort(), ["checkpoint", "consult", "handoff"]);
	for (const tool of h.tools.values()) {
		const schema = tool.parameters as {
			type?: unknown;
			properties?: Record<string, { description?: unknown }>;
		};
		assert.equal(schema.type, "object", `${tool.name} parameters must be an object schema`);
		assert.ok(schema.properties && typeof schema.properties === "object", `${tool.name} needs properties`);
		for (const [field, property] of Object.entries(schema.properties)) {
			const description = property.description;
			assert.equal(typeof description, "string", `${tool.name}.${field} needs a field description`);
			if (typeof description === "string")
				assert.ok(description.trim(), `${tool.name}.${field} needs a non-empty field description`);
		}
	}
});

test("delivery waits for session_start and passes a real CustomMessage shape", async () => {
	const oldTask = process.env.BLANCHE_TASK;
	const oldRole = process.env.BLANCHE_ROLE;
	const id = "delivery-shape";
	const nonce = "HANDOFF_SHAPE_NONCE";
	process.env.BLANCHE_TASK = id;
	process.env.BLANCHE_ROLE = "worker";
	seedPending(id, "worker", nonce);
	const h = harness();
	const channel = { listSessions: async () => [], publish() {} };
	try {
		blancheExtension(h.pi);
		const registration = h.getRegistration();
		assert.ok(registration);
		registration.onReady(channel);
		registration.onEvent({
			type: "message",
			payload: {
				taskId: id,
				handoffId: `handoff-${id}`,
				to: "worker",
				phase: "IMPLEMENTING",
				message: nonce,
			},
		});
		assert.equal(h.sent.length, 0, "pre-start delivery must not consume the handoff");
		assert.equal(readBoard(id).history[0].ackedAt, undefined);

		h.handlers.get("session_start")?.();
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.sent[0][0], {
			customType: "blanche_handoff",
			content: nonce,
			display: true,
			details: {
				handoffId: `handoff-${id}`,
				from: "leader",
				to: "worker",
				phase: "IMPLEMENTING",
				verdict: null,
				message: nonce,
				sentAt: 1,
				taskId: id,
			},
		});
		assert.deepEqual(h.sent[0][1], { triggerTurn: true });
		assert.equal(typeof readBoard(id).history[0].ackedAt, "number");
	} finally {
		restoreEnv("BLANCHE_TASK", oldTask);
		restoreEnv("BLANCHE_ROLE", oldRole);
	}
});

test("delivery polling picks up a handoff committed after channel startup", async () => {
	const oldTask = process.env.BLANCHE_TASK;
	const oldRole = process.env.BLANCHE_ROLE;
	const oldSetInterval = globalThis.setInterval;
	const id = "delivery-poll";
	const nonce = "HANDOFF_POLL_NONCE";
	process.env.BLANCHE_TASK = id;
	process.env.BLANCHE_ROLE = "researcher";
	createTask({
		id,
		workflow: "e2e",
		title: id,
		description: "test task",
		cwd: process.cwd(),
		resolved: resolved("researcher"),
		prefix: "e2e",
		phase: "REQUESTED",
		owner: "leader",
		leader: { sessionName: "e2e-leader" },
	});
	let poll: (() => void) | undefined;
	let intervalMs = 0;
	globalThis.setInterval = ((callback: TimerHandler, ms?: number) => {
		if (typeof callback === "function") poll = callback as () => void;
		intervalMs = ms ?? 0;
		return { unref() {} } as unknown as ReturnType<typeof setInterval>;
	}) as unknown as typeof setInterval;
	const h = harness();
	const channel = { listSessions: async () => [], publish() {} };
	try {
		blancheExtension(h.pi);
		const registration = h.getRegistration();
		assert.ok(registration);
		registration.onReady(channel);
		h.handlers.get("session_start")?.();
		assert.equal(intervalMs, 3000);
		assert.ok(poll);
		assert.equal(h.sent.length, 0);
		updateBoard(id, (board) => {
			board.sessions.researcher = { sessionName: `e2e-${id}-researcher`, contextEpoch: 0 };
			board.history.push({
				handoffId: `handoff-${id}`,
				from: "leader",
				to: "researcher",
				phase: "IMPLEMENTING",
				verdict: null,
				message: nonce,
				sentAt: 1,
			});
		});
		poll?.();
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0][0].content, nonce);
		assert.equal(h.sent[0][0].customType, "blanche_handoff");
		assert.equal(h.sent[0][1].triggerTurn, true);
		assert.equal(typeof readBoard(id).history[0].ackedAt, "number");
	} finally {
		globalThis.setInterval = oldSetInterval;
		restoreEnv("BLANCHE_TASK", oldTask);
		restoreEnv("BLANCHE_ROLE", oldRole);
	}
});
