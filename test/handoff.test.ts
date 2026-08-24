import assert from "node:assert/strict";
import { test } from "node:test";
import { decideHandoff, pendingFor } from "../handoff.ts";

const phases = [
	{ name: "IMPLEMENTING", owner: "worker" },
	{ name: "QA", owner: "qa" },
	{ name: "PLAN_REVIEW", owner: "leader" },
];

function mkBoard(over: any = {}): any {
	return {
		id: "t-1",
		workflow: "feat",
		prefix: "mb",
		cwd: "/tmp",
		status: "active",
		phase: "IMPLEMENTING",
		owner: "worker",
		revision: 0,
		task: { title: "t", descriptionPath: "task.md" },
		specs: {},
		consultations: [],
		leader: { sessionName: "leader-session" },
		resolved: {
			workflow: "feat",
			prefix: "mb",
			roster: ["planner", "advisor", "worker", "qa", "verifier"],
			agents: {},
			phases,
			specs: false,
			advisorAfter: null,
			maxRework: 3,
			maxWorkers: 1,
			configRevision: "sha",
		},
		sessions: {
			worker: { sessionName: "w", contextEpoch: 0, latestCheckpoint: "checkpoints/task-worker-e0.md" },
			qa: { sessionName: "q", contextEpoch: 0, latestCheckpoint: "checkpoints/task-qa-e0.md" },
			planner: { sessionName: "p", contextEpoch: 0, latestCheckpoint: "checkpoints/task-planner-e0.md" },
			verifier: { sessionName: "v", contextEpoch: 0, latestCheckpoint: "checkpoints/task-verifier-e0.md" },
		},
		reworkRound: 0,
		lastAdvisorConsultedRound: null,
		history: [],
		...over,
	};
}

const live = ["w", "q", "p", "v", "leader-session"];
// `board` is pulled out of the overrides so it patches the fixture rather than
// replacing the constructed board with the patch itself.
const call = ({ board: patch = {}, ...rest }: any) =>
	decideHandoff({
		board: mkBoard(patch),
		from: "qa",
		to: "worker",
		phase: "IMPLEMENTING",
		liveSessions: live,
		now: 123,
		handoffId: "h-1",
		...rest,
	} as any);

// --- happy path ---

test("qa PASS to worker moves phase, owner and appends history", () => {
	const r = call({ from: "qa", to: "worker", phase: "QA", verdict: "PASS" });
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.board.phase, "QA");
	assert.equal(r.board.owner, "qa", "owner comes from the phase, not the destination");
	assert.equal(r.target, "w");
	assert.equal(r.board.history.length, 1);
	assert.deepEqual(
		{ ...r.board.history[0] },
		{
			handoffId: "h-1",
			from: "qa",
			to: "worker",
			spec: undefined,
			phase: "QA",
			verdict: "PASS",
			sentAt: 123,
		},
	);
	assert.equal(r.board.history[0].ackedAt, undefined, "ackedAt is stamped by the receiver");
});

test("planner to leader targets the leader session", () => {
	const r = call({ from: "planner", to: "leader", phase: "PLAN_REVIEW", verdict: null });
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.target, "leader-session");
	assert.equal(r.board.owner, "leader");
});

test("unknown phase falls back to the destination as owner", () => {
	const r = call({ from: "planner", to: "worker", phase: "NO_SUCH_PHASE", verdict: null });
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.board.owner, "worker");
});

// --- failure cases ---

test("destination outside the roster errors and lists the roster", () => {
	const r = call({ from: "qa", to: "researcher", verdict: "PASS" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /not in roster.*planner.*worker/s);
});

test("roster role whose session is not live errors naming it", () => {
	const r = call({ from: "qa", to: "worker", verdict: "PASS", liveSessions: ["q"] });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /'w' is not live/);
});

test("qa sending a verifier verdict errors naming PASS|FAIL", () => {
	const r = call({ from: "qa", verdict: "APPROVED" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /PASS\|FAIL/);
});

test("worker sending any verdict errors", () => {
	const r = call({ from: "worker", to: "qa", verdict: "PASS" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /allowed: none/);
});

test("exceeding maxRework refuses and names the leader", () => {
	const r = call({ from: "qa", verdict: "FAIL", board: { reworkRound: 3 } });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /leader/);
});

test("a rejected decision returns the board deep-equal to the input", () => {
	const before = mkBoard();
	const snapshot = structuredClone(before);
	decideHandoff({
		board: before,
		from: "qa",
		to: "researcher",
		phase: "QA",
		verdict: "PASS",
		liveSessions: live,
		now: 1,
		handoffId: "h",
	} as any);
	assert.deepEqual(before, snapshot, "no partial mutation on a rejected handoff");
});

// --- rework and advisor ---

test("FAIL to worker increments board rework when specs are off", () => {
	const r = call({ from: "qa", verdict: "FAIL" });
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.board.reworkRound, 1);
});

test("an empty-string spec id still counts board rework", () => {
	const r = call({ from: "qa", verdict: "FAIL", spec: "" });
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.board.reworkRound, 1);
});

test("rework is per spec when specs are on: s02 failing twice leaves s03 at 0", () => {
	const withSpecs = {
		resolved: { ...mkBoard().resolved, specs: true },
		specs: {
			s02: {
				status: "implementing",
				path: "p",
				dependsOn: [],
				reworkRound: 1,
				lastAdvisorConsultedRound: null,
			},
			s03: { status: "pending", path: "p", dependsOn: [], reworkRound: 0, lastAdvisorConsultedRound: null },
		},
	};
	const r = call({ from: "qa", verdict: "FAIL", spec: "s02", board: withSpecs });
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.board.specs.s02.reworkRound, 2);
	assert.equal(r.board.specs.s03.reworkRound, 0, "a sibling spec must not inherit rework");
	assert.equal(r.board.reworkRound, 0, "board counter untouched when specs are on");
});

test("advisorAfter null never nudges", () => {
	const r = call({
		from: "qa",
		verdict: "FAIL",
		board: { reworkRound: 5, resolved: { ...mkBoard().resolved, advisorAfter: null, maxRework: 99 } },
	});
	assert.equal(r.ok, true);
	if (r.ok)
		assert.equal(
			r.notes.some((n) => /[Aa]dvisor/.test(n)),
			false,
		);
});

test("advisorAfter 2 nudges at rework 2 and again at 3 until a consultation lands", () => {
	const res = { ...mkBoard().resolved, advisorAfter: 2, maxRework: 9 };
	const at2 = call({ from: "qa", verdict: "FAIL", board: { reworkRound: 1, resolved: res } });
	assert.equal(at2.ok, true);
	if (at2.ok)
		assert.equal(
			at2.notes.some((n) => /[Aa]dvisor/.test(n)),
			true,
			"fires at 2",
		);

	const at3 = call({ from: "qa", verdict: "FAIL", board: { reworkRound: 2, resolved: res } });
	assert.equal(at3.ok, true);
	if (at3.ok)
		assert.equal(
			at3.notes.some((n) => /[Aa]dvisor/.test(n)),
			true,
			"fires again at 3, not once",
		);

	const consulted = call({
		from: "qa",
		verdict: "FAIL",
		board: { reworkRound: 2, lastAdvisorConsultedRound: 3, resolved: res },
	});
	assert.equal(consulted.ok, true);
	if (consulted.ok)
		assert.equal(
			consulted.notes.some((n) => /[Aa]dvisor/.test(n)),
			false,
			"silent once consulted for that round",
		);
});

test("a missing checkpoint warns but does not block", () => {
	const r = call({
		from: "qa",
		verdict: "PASS",
		phase: "QA",
		board: { sessions: { ...mkBoard().sessions, qa: { sessionName: "q", contextEpoch: 4 } } },
	});
	assert.equal(r.ok, true);
	if (r.ok)
		assert.equal(
			r.notes.some((n) => /no checkpoint/i.test(n)),
			true,
		);
});

test("pendingFor returns the latest unacked handoff for a role, and nothing once acked", () => {
	const b = mkBoard({
		history: [
			{
				handoffId: "h1",
				from: "leader",
				to: "worker",
				phase: "IMPLEMENTING",
				verdict: null,
				sentAt: 1,
				ackedAt: 2,
			},
			{
				handoffId: "h2",
				from: "qa",
				to: "worker",
				phase: "IMPLEMENTING",
				verdict: "FAIL",
				message: "3 tests fail",
				sentAt: 3,
			},
			{ handoffId: "h3", from: "worker", to: "qa", phase: "QA", verdict: null, sentAt: 4 },
		],
	});
	const owed = pendingFor(b, "worker" as any);
	assert.equal(owed?.handoffId, "h2", "skips the acked one");
	assert.equal(owed?.message, "3 tests fail", "message is replayable from the board");
	assert.equal(pendingFor(b, "verifier" as any), undefined, "no work owed");
	b.history[1].ackedAt = 5;
	assert.equal(pendingFor(b, "worker" as any), undefined, "silent once acked");
});
