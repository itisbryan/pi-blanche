import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, Role } from "../types.ts";

type LiveSession = { name?: string; contextPct?: number };
type Viewer = { role?: Role; sessionName?: string };
type WidgetSnapshot = { board: Board; viewer: Viewer; liveRoster: LiveSession[] };
type Theme = Record<string, (text: string) => string>;
type WidgetTimer = {
	kind: "interval" | "timeout";
	callback: () => void;
	ms: number;
	cleared: boolean;
	unrefCalled: boolean;
	unref(): void;
};
type WidgetClock = {
	setInterval(callback: () => void, ms: number): WidgetTimer;
	clearInterval(timer: WidgetTimer): void;
	setTimeout(callback: () => void, ms: number): WidgetTimer;
	clearTimeout(timer: WidgetTimer): void;
};
type WidgetTui = { requestRender(): void };
type WidgetOptions = {
	tui: WidgetTui;
	theme: () => Theme;
	clock?: WidgetClock;
	glyphs?: "unicode" | "ascii";
};
type Widget = {
	render(width: number): string[];
	update(snapshot: WidgetSnapshot): void;
	dispose(): void;
};
type WidgetFactory = (snapshot: WidgetSnapshot, options: WidgetOptions) => Widget;

const widgetLoad = await import(new URL("../widget.ts", import.meta.url).href)
	.then((module) => ({ module: module as Record<string, unknown> }))
	.catch((error: unknown) => ({ error }));

function createWidget(snapshot: WidgetSnapshot, options: WidgetOptions): Widget {
	const loadError = "error" in widgetLoad ? widgetLoad.error : "unknown import failure";
	assert.ok("module" in widgetLoad, `widget module is absent: ${String(loadError)}`);
	const factory = widgetLoad.module.createCrewWidget;
	assert.equal(typeof factory, "function", "widget.ts must export createCrewWidget");
	return (factory as WidgetFactory)(snapshot, options);
}

const roles: Role[] = ["planner", "researcher", "advisor", "worker", "qa", "verifier"];
const phases = [
	{ name: "DISCOVERY", owner: "planner" as Role },
	{ name: "PLANNING", owner: "planner" as Role },
	{ name: "PLAN_REVIEW", owner: "leader" as Role },
	{ name: "IMPLEMENTING", owner: "worker" as Role },
	{ name: "QA", owner: "qa" as Role },
	{ name: "VERIFY", owner: "verifier" as Role },
	{ name: "DONE", owner: "leader" as Role },
];

function makeBoard(over: Record<string, unknown> = {}): Board {
	const base = {
		id: "feat-widget",
		workflow: "feat",
		prefix: "ft",
		cwd: "/tmp/feat-widget",
		status: "active" as const,
		phase: "DISCOVERY",
		owner: "planner" as Role,
		revision: 1,
		task: { title: "widget task", descriptionPath: "task.md" },
		currentSpec: undefined,
		specs: {},
		consultations: [],
		leader: { sessionName: "ft-feat-widget-leader" },
		resolved: {
			workflow: "feat",
			prefix: "ft",
			roster: roles,
			agents: {},
			phases,
			specs: false,
			advisorAfter: 2,
			maxRework: 4,
			maxWorkers: 1,
			configRevision: "widget-test",
		},
		sessions: {
			planner: { sessionName: "ft-feat-widget-planner", contextEpoch: 0 },
			researcher: { sessionName: "ft-feat-widget-researcher", contextEpoch: 0 },
			qa: { sessionName: "ft-feat-widget-qa", contextEpoch: 0 },
		},
		reworkRound: 0,
		lastAdvisorConsultedRound: null,
		history: [
			{
				handoffId: "handoff-0",
				from: "leader" as Role,
				to: "planner" as Role,
				phase: "DISCOVERY",
				verdict: null,
				sentAt: 1,
			},
		],
	};
	return {
		...base,
		...over,
		resolved: { ...base.resolved, ...(over.resolved as Partial<Board["resolved"]> | undefined) },
		sessions: { ...base.sessions, ...(over.sessions as Board["sessions"] | undefined) },
	} as Board;
}

function snapshot(
	over: Record<string, unknown> = {},
	viewer: Viewer = { sessionName: "ft-feat-widget-leader" },
): WidgetSnapshot {
	return {
		board: makeBoard(over),
		viewer,
		liveRoster: [
			{ name: "ft-feat-widget-leader", contextPct: 31 },
			{ name: "ft-feat-widget-planner", contextPct: 22 },
			{ name: "ft-feat-widget-qa", contextPct: 48 },
		],
	};
}

function makeTheme(palette: "light" | "dark" = "light"): Theme {
	const codes =
		palette === "light"
			? ["31", "33", "34", "35", "36", "37", "91", "90"]
			: ["91", "93", "94", "95", "96", "97", "95", "37"];
	const names = ["accent", "borderMuted", "borderAccent", "muted", "success", "warning", "error", "dim"];
	return Object.fromEntries(
		names.map((name, index) => [name, (text: string) => `\u001b[${codes[index]}m${text}\u001b[0m`]),
	) as Theme;
}

function makeClock() {
	let now = 0;
	const timers: WidgetTimer[] = [];
	const clock: WidgetClock = {
		setInterval(callback, ms) {
			const timer = {
				kind: "interval" as const,
				callback,
				ms,
				cleared: false,
				unrefCalled: false,
				unref() {
					this.unrefCalled = true;
				},
			};
			timers.push(timer);
			return timer;
		},
		clearInterval(timer) {
			timer.cleared = true;
		},
		setTimeout(callback, ms) {
			const timer = {
				kind: "timeout" as const,
				callback,
				ms,
				cleared: false,
				unrefCalled: false,
				unref() {
					this.unrefCalled = true;
				},
			};
			timers.push(timer);
			return timer;
		},
		clearTimeout(timer) {
			timer.cleared = true;
		},
	};
	return {
		clock,
		timers,
		run(ms: number) {
			now += ms;
			for (const timer of timers) {
				if (!timer.cleared && now >= timer.ms) timer.callback();
			}
		},
	};
}

const ansi = new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "g");
const stripAnsi = (value: string) => value.replace(ansi, "");
const visibleWidth = (value: string) => Array.from(stripAnsi(value)).length;
const ansiCode = (code: string) => new RegExp(`\\x1b\\[${code}m`);
const anyAnsi = new RegExp("\\x1b");

function mount(initial: WidgetSnapshot, overrides: Partial<WidgetOptions> = {}) {
	const clock = makeClock();
	let theme = makeTheme();
	let renders = 0;
	const options: WidgetOptions = {
		tui: {
			requestRender: () => {
				renders++;
			},
		},
		theme: () => theme,
		clock: clock.clock,
		...overrides,
	};
	return {
		component: createWidget(initial, options),
		clock,
		setTheme(next: "light" | "dark") {
			theme = makeTheme(next);
		},
		get renders() {
			return renders;
		},
	};
}

test("renders the six-role crew in one connected ten-line frame at width 100", () => {
	const mounted = mount(snapshot());
	const lines = mounted.component.render(100);
	assert.equal(lines.length, 10);
	assert.match(stripAnsi(lines[0]), /^╭─/);
	assert.match(stripAnsi(lines[1]), /^├─ CREW/);
	assert.match(stripAnsi(lines.at(-1) ?? ""), /^╰/);
	for (const line of lines) assert.equal(visibleWidth(line), 100);
	for (const role of roles) assert.match(stripAnsi(lines.join("\n")), new RegExp(role, "i"));
});

test("keeps a two-role roster and the six-role roster visible at 60 and 40", () => {
	const compact = snapshot({
		phase: "IMPLEMENTING",
		owner: "worker",
		resolved: {
			roster: ["worker", "qa"],
			phases: [
				{ name: "REQUESTED", owner: "leader" },
				{ name: "IMPLEMENTING", owner: "worker" },
				{ name: "QA", owner: "qa" },
				{ name: "DONE", owner: "leader" },
			],
		},
	});
	for (const width of [60, 40]) {
		const lines = mount(compact).component.render(width);
		assert.ok(lines.length <= 10);
		for (const line of lines) assert.equal(visibleWidth(line), width);
		assert.match(stripAnsi(lines.join("\n")), /WORKER/);
		assert.match(stripAnsi(lines.join("\n")), /QA/);
	}
	for (const width of [60, 40]) {
		const lines = mount(snapshot()).component.render(width);
		assert.ok(lines.length <= 10);
		for (const line of lines) assert.equal(visibleWidth(line), width);
		const text = stripAnsi(lines.join("\n"));
		for (const role of roles) assert.match(text, new RegExp(role, "i"));
	}
	for (const width of [23, 20, 12, 8]) {
		const lines = mount(snapshot()).component.render(width);
		assert.ok(lines.length > 0);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
});

test("marks exactly one YOU row for operator and worker viewers", () => {
	const operator = stripAnsi(
		mount(snapshot({}, { sessionName: "ft-feat-widget-leader" }))
			.component.render(60)
			.join("\n"),
	);
	assert.equal(operator.match(/\bYOU\b/g)?.length ?? 0, 1);
	assert.match(operator, /YOU · LEADER/);

	const workerSnapshot = snapshot(
		{ sessions: { worker: { sessionName: "ft-feat-widget-worker", contextEpoch: 0 } } },
		{ role: "worker", sessionName: "ft-feat-widget-worker" },
	);
	workerSnapshot.liveRoster.push({ name: "ft-feat-widget-worker", contextPct: 19 });
	const worker = stripAnsi(mount(workerSnapshot).component.render(60).join("\n"));
	assert.equal(worker.match(/\bYOU\b/g)?.length ?? 0, 1);
	assert.match(worker, /YOU · WORKER/);
	assert.match(worker, /OPERATOR · LEADER/);
});

test("keeps owner, provisioning, and liveness independent", () => {
	const base = stripAnsi(mount(snapshot()).component.render(60).join("\n"));
	assert.match(base, /PLANNER.*owner.*live/s);
	assert.match(base, /RESEARCHER.*offline/s);
	assert.match(base, /ADVISOR.*on demand/s);
	assert.match(base, /WORKER.*not started/s);

	const ownerOffline = snapshot({ owner: "planner" });
	ownerOffline.liveRoster = ownerOffline.liveRoster.filter(
		(session) => session.name !== "ft-feat-widget-planner",
	);
	const ownerText = stripAnsi(mount(ownerOffline).component.render(60).join("\n"));
	assert.match(ownerText, /PLANNER.*owner.*offline/s);
});

test("shows current and next phases, including same-role researcher progress", () => {
	const progress = snapshot({
		phase: "INVESTIGATING",
		owner: "researcher",
		resolved: {
			phases: [
				{ name: "INVESTIGATING", owner: "researcher" },
				{ name: "REPORT", owner: "researcher" },
			],
		},
	});
	const text = stripAnsi(mount(progress).component.render(60).join("\n"));
	assert.match(text, /INVESTIGATING/);
	assert.match(text, /REPORT/);
	assert.match(text, /researcher/i);
});

test("does not fabricate a next phase when the current phase is unknown", () => {
	const text = stripAnsi(
		mount(snapshot({ phase: "MYSTERY" }))
			.component.render(40)
			.join("\n"),
	);
	assert.match(text, /MYSTERY/);
	assert.doesNotMatch(text, /DISCOVERY|PLANNING/);
	assert.doesNotMatch(text, /complete/);
});

test("uses an unframed fallback below the framing threshold", () => {
	for (const width of [23, 12, 8]) {
		const text = stripAnsi(mount(snapshot()).component.render(width).join("\n"));
		assert.doesNotMatch(text, /╭|╮|╰|╯|├|┤|│/);
	}
});

test("hides zero rework and exposes positive and maximum rework", () => {
	const zero = stripAnsi(
		mount(snapshot({ reworkRound: 0 }))
			.component.render(60)
			.join("\n"),
	);
	assert.doesNotMatch(zero, /rework/i);
	const positiveMount = mount(snapshot({ reworkRound: 2 }));
	const positiveRaw = positiveMount.component.render(60).join("\n");
	const positive = stripAnsi(positiveRaw);
	assert.match(positive, /rework\s+2\/4/i);
	assert.match(positiveRaw, ansiCode("37"));
	const maximum = mount(snapshot({ reworkRound: 4 }));
	const maximumText = stripAnsi(maximum.component.render(60).join("\n"));
	assert.match(maximumText, /rework\s+4\/4/i);
	assert.match(maximum.component.render(60).join("\n"), ansiCode("91"));
});

test("keeps Unicode and ASCII tracer frames fixed-width and color-independent", () => {
	for (const glyphs of ["unicode", "ascii"] as const) {
		const mounted = mount(snapshot(), { glyphs });
		const frames: string[] = [];
		for (let index = 0; index < 6; index++) {
			const lines = mounted.component.render(60);
			for (const line of lines) assert.equal(visibleWidth(line), 60);
			frames.push(lines.join("\n"));
			mounted.clock.run(180);
		}
		assert.ok(new Set(frames).size > 1, `${glyphs} tracer must advance`);
		assert.match(stripAnsi(frames[0]), /PLANNER|live/);
		assert.match(frames[0], anyAnsi);
		if (glyphs === "ascii") assert.doesNotMatch(frames[0], /╭|╰|├|┤|─|│/);
	}
});

test("animates a fixed-width tracer toward the next phase edge", () => {
	for (const glyphs of ["unicode", "ascii"] as const) {
		const mounted = mount(snapshot(), { glyphs });
		const text = stripAnsi(mounted.component.render(60).join("\n"));
		assert.match(text, glyphs === "unicode" ? /●[─-]+[▶>]/ : /o[-]+>/);
	}
});

test("keeps a handoff transition in flight before settling once", () => {
	const mounted = mount(snapshot());
	mounted.component.render(60);
	const handoff: WidgetSnapshot = {
		...snapshot({
			phase: "IMPLEMENTING",
			owner: "worker",
			sessions: { worker: { sessionName: "ft-feat-widget-worker", contextEpoch: 0 } },
			history: [
				{
					handoffId: "handoff-duration",
					from: "planner",
					to: "worker",
					phase: "IMPLEMENTING",
					verdict: null,
					sentAt: 2,
				},
			],
		}),
		liveRoster: [{ name: "ft-feat-widget-leader" }, { name: "ft-feat-widget-worker" }],
	};
	mounted.component.update(handoff);
	const initial = mounted.component.render(60).join("\n");
	assert.match(stripAnsi(initial), /HANDOFF/);
	assert.match(stripAnsi(initial), /WORKER/);
	assert.match(initial, ansiCode("34"));
	mounted.clock.run(160);
	assert.match(stripAnsi(mounted.component.render(60).join("\n")), /HANDOFF/);
	for (let index = 0; index < 9; index++) mounted.clock.run(160);
	assert.doesNotMatch(stripAnsi(mounted.component.render(60).join("\n")), /HANDOFF/);
});

test("uses theme tokens for rework emphasis instead of baked ANSI colors", () => {
	const customTheme: Theme = {
		accent: (text) => `\u001b[32m${text}\u001b[0m`,
		warning: (text) => `\u001b[32m${text}\u001b[0m`,
		error: (text) => `\u001b[35m${text}\u001b[0m`,
	};
	const positive = mount(snapshot({ reworkRound: 2 }), { theme: () => customTheme });
	assert.match(positive.component.render(60).join("\n"), ansiCode("32"));
	assert.doesNotMatch(positive.component.render(60).join("\n"), ansiCode("37"));
	const maximum = mount(snapshot({ reworkRound: 4 }), { theme: () => customTheme });
	assert.match(maximum.component.render(60).join("\n"), ansiCode("35"));
	assert.doesNotMatch(maximum.component.render(60).join("\n"), ansiCode("91"));
});

test("schedules one unref'd timer only for active live work", () => {
	const active = mount(snapshot());
	active.component.render(60);
	const activeTimers = active.clock.timers.filter((timer) => !timer.cleared);
	assert.equal(activeTimers.length, 1);
	assert.equal(activeTimers[0]?.unrefCalled, true);

	const stopped = [
		snapshot({ status: "stopped" }),
		snapshot({ status: "blocked" }),
		snapshot({ status: "done" }),
		snapshot({ phase: "DONE", owner: "leader" }),
	];
	for (const state of stopped) {
		const mounted = mount(state);
		mounted.component.render(60);
		assert.equal(mounted.clock.timers.filter((timer) => !timer.cleared).length, 0);
		const before = mounted.renders;
		mounted.clock.run(2000);
		assert.equal(mounted.renders, before);
	}
	const finalText = stripAnsi(
		mount(snapshot({ phase: "DONE", owner: "leader" }))
			.component.render(60)
			.join("\n"),
	);
	assert.match(finalText, /complete/i);

	const offline = snapshot();
	offline.liveRoster = offline.liveRoster.filter((session) => session.name !== "ft-feat-widget-planner");
	const offlineMounted = mount(offline);
	offlineMounted.component.render(60);
	assert.equal(offlineMounted.clock.timers.filter((timer) => !timer.cleared).length, 0);
});

test("dispose clears animation and prevents later renders", () => {
	const mounted = mount(snapshot());
	mounted.component.render(60);
	const before = mounted.renders;
	const timer = mounted.clock.timers.find((candidate) => !candidate.cleared);
	assert.ok(timer);
	mounted.component.dispose();
	assert.equal(timer.cleared, true);
	mounted.clock.run(2000);
	assert.equal(mounted.renders, before);
});

test("update preserves an in-flight handoff and does not replay unchanged snapshots", () => {
	const initial = snapshot();
	const mounted = mount(initial);
	mounted.component.render(60);
	const initialTimer = mounted.clock.timers.find((timer) => !timer.cleared);
	const timerCount = mounted.clock.timers.length;
	mounted.component.update(snapshot());
	assert.equal(mounted.clock.timers.length, timerCount);
	assert.equal(
		mounted.clock.timers.find((timer) => !timer.cleared),
		initialTimer,
	);

	const handoff: WidgetSnapshot = {
		...snapshot(
			{
				phase: "IMPLEMENTING",
				owner: "worker",
				sessions: { worker: { sessionName: "ft-feat-widget-worker", contextEpoch: 0 } },
				history: [
					{
						handoffId: "handoff-1",
						from: "planner",
						to: "worker",
						phase: "IMPLEMENTING",
						verdict: null,
						sentAt: 2,
					},
				],
			},
			{ sessionName: "ft-feat-widget-leader" },
		),
		liveRoster: [
			{ name: "ft-feat-widget-leader", contextPct: 31 },
			{ name: "ft-feat-widget-planner", contextPct: 22 },
			{ name: "ft-feat-widget-worker", contextPct: 19 },
		],
	};
	mounted.component.update(handoff);
	const transition = mounted.component.render(60).join("\n");
	assert.match(stripAnsi(transition), /HANDOFF/);
	assert.match(stripAnsi(transition), /WORKER/);
	assert.match(transition, ansiCode("34"));
	const transitionTimers = mounted.clock.timers.length;
	mounted.component.update(handoff);
	assert.equal(mounted.clock.timers.length, transitionTimers);
	assert.match(stripAnsi(mounted.component.render(60).join("\n")), /HANDOFF/);

	mounted.clock.run(1600);
	const settled = mounted.component.render(60).join("\n");
	assert.doesNotMatch(stripAnsi(settled), /HANDOFF/);
	assert.doesNotMatch(settled, ansiCode("34"));
	mounted.component.update(handoff);
	assert.equal(mounted.clock.timers.length, transitionTimers);
});

test("reads the live theme provider again during an existing mount", () => {
	const mounted = mount(snapshot());
	const light = mounted.component.render(60).join("\n");
	assert.match(light, ansiCode("31"));
	mounted.setTheme("dark");
	const dark = mounted.component.render(60).join("\n");
	assert.match(dark, ansiCode("91"));
	assert.doesNotMatch(dark, ansiCode("31"));
});
