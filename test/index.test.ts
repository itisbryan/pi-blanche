import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function harness(initialSessionName = "operator") {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const tools = new Map<string, Tool>();
	const sent: Call[] = [];
	let registration: Registration | undefined;
	let sessionName = initialSessionName;
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

function herdrCalls() {
	if (!existsSync(process.env.HERDR_STUB_LOG!)) return [];
	return readFileSync(process.env.HERDR_STUB_LOG!, "utf8").split("\n").filter(Boolean);
}

function paneRuns() {
	return herdrCalls().filter((line) => line.startsWith("pane run "));
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
			const beforeCalls = herdrCalls().length;
			const beforeRuns = paneRuns().length;
			const message = await command(`${workflow} "${description}"`, {});
			const emitted = herdrCalls().slice(beforeCalls);
			assert.equal(paneRuns().length - beforeRuns, expectedEager.size, `${workflow} eager pane count`);
			for (const call of emitted) {
				const ratio = /(?:^| )--ratio ([^ ]+)/.exec(call)?.[1];
				if (ratio !== undefined) {
					const value = Number(ratio);
					assert.ok(
						Number.isFinite(value) && value > 0 && value < 1,
						`${workflow} emitted invalid ratio ${ratio}`,
					);
				}
			}
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

test("kickoff failure rolls back the task and any opened panes", async () => {
	const oldCwd = process.cwd();
	const oldHerdr = process.env.HERDR_BIN;
	const oldLog = process.env.HERDR_STUB_LOG;
	const cwd = mkdtempSync(join(tmpdir(), "blanche-kickoff-rollback-"));
	const failingHerdr = join(cwd, "failing-herdr.sh");
	const log = join(cwd, "failing-herdr.log");
	writeFileSync(
		failingHerdr,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_STUB_LOG"
case "$1 $2" in
  "pane current") printf '%s\\n' '{"result":{"pane":{"pane_id":"leader-pane"}}}' ;;
  "pane split") exit 1 ;;
  "pane close") printf '%s\\n' '{"result":{"ok":true}}' ;;
  *) printf '%s\\n' '{"result":{"ok":true}}' ;;
esac
`,
	);
	chmodSync(failingHerdr, 0o755);
	process.chdir(cwd);
	process.env.HERDR_BIN = failingHerdr;
	process.env.HERDR_STUB_LOG = log;
	try {
		const h = harness();
		blancheExtension(h.pi);
		const registration = h.getRegistration();
		assert.ok(registration);
		registration.onReady({ listSessions: async () => [], publish() {} });
		const command = h.commands.get("crew");
		assert.ok(command);
		await assert.rejects(() => command('quick "deliberately fail kickoff"', {}), /Crew kickoff failed/);
		assert.equal(listTasks(cwd).length, 0, "failed kickoff must not leave an active task");
		assert.equal(existsSync(join(cwd, ".pi", "agent", "pi-blanche", "tasks")), false);
	} finally {
		process.chdir(oldCwd);
		if (oldHerdr === undefined) delete process.env.HERDR_BIN;
		else process.env.HERDR_BIN = oldHerdr;
		if (oldLog === undefined) delete process.env.HERDR_STUB_LOG;
		else process.env.HERDR_STUB_LOG = oldLog;
		rmSync(failingHerdr, { force: true });
		rmSync(log, { force: true });
	}
});

test("crew widget is hidden from bystanders and shown to participants", async () => {
	const oldCwd = process.cwd();
	const oldRole = process.env.BLANCHE_ROLE;
	const cwd = mkdtempSync(join(tmpdir(), "blanche-widget-participants-"));
	const id = "widget-participants";
	process.chdir(cwd);
	createTask({
		id,
		workflow: "e2e",
		title: id,
		description: "widget participant test",
		cwd,
		resolved: resolved("worker"),
		prefix: "e2e",
		phase: "IMPLEMENTING",
		owner: "worker",
		leader: { sessionName: "leader-session" },
	});
	updateBoard(id, (board) => {
		board.sessions.worker = { sessionName: "worker-session", contextEpoch: 0 };
	});

	const capture = async (name: string, explicitRole?: string): Promise<unknown> => {
		if (explicitRole) process.env.BLANCHE_ROLE = explicitRole;
		else delete process.env.BLANCHE_ROLE;
		const h = harness(name);
		const calls: Array<[unknown, unknown]> = [];
		blancheExtension(h.pi);
		const registration = h.getRegistration();
		assert.ok(registration);
		registration.onReady({ listSessions: async () => [], publish() {} });
		h.handlers.get("session_start")?.(
			{},
			{ ui: { setWidget: (widgetName: unknown, widget: unknown) => calls.push([widgetName, widget]) } },
		);
		await new Promise((resolve) => setImmediate(resolve));
		return calls[calls.length - 1]?.[1];
	};

	const assertFactory = async (name: string, explicitRole?: string) => {
		const factory = await capture(name, explicitRole);
		assert.equal(typeof factory, "function", "participant widget must be a component factory");
		const component = (
			factory as (
				tui: { requestRender(): void },
				theme: Record<string, (text: string) => string>,
			) => {
				render(width: number): string[];
				dispose(): void;
			}
		)({ requestRender() {} }, {});
		assert.equal(typeof component.render, "function");
		component.dispose();
	};

	try {
		assert.equal(await capture("operator"), undefined, "unrelated operator must not see the widget");
		await assertFactory("operator", "worker");
		await assertFactory("leader-session");
		await assertFactory("worker-session");
	} finally {
		process.chdir(oldCwd);
		restoreEnv("BLANCHE_ROLE", oldRole);
	}
});

test("stale UI context cannot escape the widget refresh path", async () => {
	const h = harness("stale-context");
	const setWidgetCalls: unknown[] = [];
	const stale: any = {};
	Object.defineProperty(stale, "ui", {
		get() {
			throw new Error("stale ctx");
		},
	});
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		blancheExtension(h.pi);
		const sessionStart = h.handlers.get("session_start");
		assert.ok(sessionStart, "extension must register session_start");
		await assert.doesNotReject(() => sessionStart?.({}, stale) as Promise<unknown>);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.deepEqual(unhandled, [], "stale refresh must not escape as an unhandled rejection");
	assert.equal(setWidgetCalls.length, 0);
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
		assert.deepEqual(
			{ ...h.sent[0][0], content: nonce },
			{
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
			},
		);
		const deliveredContent = h.sent[0][0].content;
		assert.equal(typeof deliveredContent, "string");
		assert.ok((deliveredContent as string).includes(nonce));
		assert.match(
			deliveredContent as string,
			/This is the final phase\. Report completion to the user and do not hand off\./,
		);
		assert.deepEqual(h.sent[0][1], { triggerTurn: true });
		assert.equal(typeof readBoard(id).history[0].ackedAt, "number");
	} finally {
		restoreEnv("BLANCHE_TASK", oldTask);
		restoreEnv("BLANCHE_ROLE", oldRole);
	}
});

test("handoff delivery gives literal next-step, advisor, and fallback instructions", async () => {
	const oldTask = process.env.BLANCHE_TASK;
	const oldRole = process.env.BLANCHE_ROLE;
	const capture = async (id: string, target: "leader" | "worker" | "advisor"): Promise<string> => {
		process.env.BLANCHE_TASK = id;
		process.env.BLANCHE_ROLE = target;
		const h = harness();
		blancheExtension(h.pi);
		const registration = h.getRegistration();
		assert.ok(registration);
		registration.onReady({ listSessions: async () => [], publish() {} });
		h.handlers.get("session_start")?.();
		await new Promise((resolve) => setImmediate(resolve));
		const content = h.sent[0]?.[0]?.content;
		assert.equal(typeof content, "string");
		return content as string;
	};
	try {
		createTask({
			id: "delivery-next-phase",
			workflow: "e2e",
			title: "delivery-next-phase",
			description: "next phase",
			cwd: process.cwd(),
			resolved: {
				...resolved("worker"),
				roster: ["worker", "qa"],
				agents: { worker: { model: "test", thinking: "low" }, qa: { model: "test", thinking: "low" } },
				phases: [
					{ name: "REQUESTED", owner: "leader" },
					{ name: "IMPLEMENTING", owner: "worker" },
					{ name: "QA", owner: "qa" },
				],
			},
			prefix: "e2e",
			phase: "IMPLEMENTING",
			owner: "worker",
			leader: { sessionName: "e2e-leader" },
		});
		updateBoard("delivery-next-phase", (board) => {
			board.sessions.worker = { sessionName: "e2e-delivery-next-phase-worker", contextEpoch: 0 };
			board.history.push({
				handoffId: "handoff-delivery-next-phase",
				from: "leader",
				to: "worker",
				phase: "IMPLEMENTING",
				verdict: null,
				message: "next phase",
				sentAt: 1,
			});
		});
		const next = await capture("delivery-next-phase", "worker");
		assert.match(next, /On success, hand off to qa with phase QA\./);
		assert.match(next, /If you cannot, hand off to leader with the reason\./);

		createTask({
			id: "delivery-leader-progress",
			workflow: "hotfix",
			title: "delivery-leader-progress",
			description: "leader progression",
			cwd: process.cwd(),
			resolved: {
				...resolved("worker"),
				phases: [
					{ name: "TRIAGE", owner: "leader" },
					{ name: "LEADER_REVIEW", owner: "leader" },
					{ name: "DONE", owner: "leader" },
				],
			},
			prefix: "hf",
			phase: "LEADER_REVIEW",
			owner: "leader",
			leader: { sessionName: "e2e-leader" },
		});
		updateBoard("delivery-leader-progress", (board) => {
			board.history.push({
				handoffId: "handoff-delivery-leader-progress",
				from: "worker",
				to: "leader",
				phase: "LEADER_REVIEW",
				verdict: null,
				message: "review",
				sentAt: 1,
			});
		});
		const leaderProgress = await capture("delivery-leader-progress", "leader");
		assert.match(leaderProgress, /On success, advance to phase DONE by handing off to leader/);
		assert.match(leaderProgress, /do not hand off while remaining in phase LEADER_REVIEW/);
		assert.doesNotMatch(leaderProgress, /Do not hand off to leader\./);

		createTask({
			id: "delivery-advisor-instruction",
			workflow: "e2e",
			title: "delivery-advisor-instruction",
			description: "advisor phase",
			cwd: process.cwd(),
			resolved: {
				...resolved("worker"),
				roster: ["advisor"],
				agents: { advisor: { model: "test", thinking: "low" } },
				phases: [
					{ name: "REQUESTED", owner: "leader" },
					{ name: "INVESTIGATING", owner: "advisor" },
					{ name: "REPORT", owner: "advisor" },
				],
			},
			prefix: "e2e",
			phase: "INVESTIGATING",
			owner: "advisor",
			leader: { sessionName: "e2e-leader" },
		});
		updateBoard("delivery-advisor-instruction", (board) => {
			board.sessions.advisor = { sessionName: "e2e-delivery-advisor-instruction-advisor", contextEpoch: 0 };
			board.history.push({
				handoffId: "handoff-delivery-advisor-instruction",
				from: "worker",
				to: "advisor",
				phase: "INVESTIGATING",
				verdict: null,
				message: "advise",
				sentAt: 1,
			});
		});
		const advisor = await capture("delivery-advisor-instruction", "advisor");
		assert.match(
			advisor,
			/ACTION REQUIRED: call consult first, then handoff your advice back to the worker\./,
		);

		seedPending("delivery-fallback-instruction", "worker", "fallback");
		updateBoard("delivery-fallback-instruction", (board) => {
			board.history[0].phase = "UNKNOWN";
		});
		const fallback = await capture("delivery-fallback-instruction", "worker");
		assert.match(fallback, /Complete this phase, then end your turn by calling handoff\(\.\.\.\)/);
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
		const deliveredContent = h.sent[0][0].content;
		assert.equal(typeof deliveredContent, "string");
		assert.ok((deliveredContent as string).includes(nonce));
		assert.equal(h.sent[0][0].customType, "blanche_handoff");
		assert.equal(h.sent[0][1].triggerTurn, true);
		assert.equal(typeof readBoard(id).history[0].ackedAt, "number");
	} finally {
		globalThis.setInterval = oldSetInterval;
		restoreEnv("BLANCHE_TASK", oldTask);
		restoreEnv("BLANCHE_ROLE", oldRole);
	}
});
