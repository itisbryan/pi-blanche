import assert from "node:assert/strict";
import test from "node:test";
import { buildCrewBlock } from "../inject.ts";
import { buildRoleCommand } from "../spawn.ts";
import type { Board } from "../types.ts";

const board = (): Board => ({
	id: "t-1",
	workflow: "feat",
	prefix: "mb",
	cwd: "/tmp",
	status: "active",
	phase: "IMPLEMENTING",
	owner: "worker",
	revision: 1,
	task: { title: "Add '$' support", descriptionPath: "task.md" },
	plan: { revision: 1, status: "approved", contentPath: "plan.md" },
	currentSpec: "s02",
	specs: {
		s02: {
			status: "implementing",
			path: "/definitely/missing",
			dependsOn: [],
			reworkRound: 1,
			lastAdvisorConsultedRound: null,
		},
	},
	consultations: [],
	leader: { sessionName: "mb-t-1-leader" },
	resolved: {
		workflow: "feat",
		prefix: "mb",
		roster: ["planner", "researcher", "advisor", "worker", "qa", "verifier"],
		agents: {},
		phases: [{ name: "IMPLEMENTING", owner: "worker" }],
		specs: true,
		advisorAfter: 2,
		maxRework: 3,
		maxWorkers: 1,
		configRevision: "x",
	},
	sessions: { worker: { sessionName: "mb-t-1-worker", contextEpoch: 1 } },
	reworkRound: 0,
	lastAdvisorConsultedRound: null,
	history: [],
});

const input = (contextPct?: number) => ({
	role: "worker" as const,
	board: board(),
	specBody: "Goal: preserve ephemeral crew context.\nAcceptance criteria: prompt is ephemeral",
	checkpoint: "validated files",
	softLimit: 0.8,
	contextPct,
	peers: ["mb-t-1-qa", "mb-t-1-planner"],
	rolePrompt: "ROLE PROMPT",
});

test("renders worker block with spec, checkpoint, and peers", () => {
	const block = buildCrewBlock(input(0.5));
	assert.match(block, /ROLE PROMPT/);
	assert.match(block, /validated files/);
	assert.match(block, /mb-t-1-qa/);
	assert.match(block, /s02/);
	assert.match(block, /preserve ephemeral crew context/);
	assert.match(block, /prompt is ephemeral/);
});

test("spawn command quotes spaces, apostrophes, and dollar signs exactly", () => {
	assert.equal(
		buildRoleCommand({
			role: "worker",
			taskId: "task $'quoted'",
			sessionName: "mb-$worker",
			profile: { model: "model $1", thinking: "low" },
		}),
		"BLANCHE_ROLE='worker' BLANCHE_TASK='task $'\\''quoted'\\''' pi --name 'mb-$worker' --model 'model $1' --thinking 'low'",
	);
});

test("context pressure is absent below limit and present once at limit", () => {
	assert.equal(buildCrewBlock(input(0.79)).match(/CONTEXT_PRESSURE/g), null);
	assert.equal(buildCrewBlock(input(0.8)).match(/CONTEXT_PRESSURE/g)?.length, 1);
});

test("assembly is stable and omits missing optional sections", () => {
	const a = buildCrewBlock({
		...input(0),
		specBody: undefined,
		checkpoint: undefined,
		consultation: undefined,
		peers: ["z-peer", "a-peer"],
	});
	const b = buildCrewBlock({
		...input(0),
		specBody: undefined,
		checkpoint: undefined,
		consultation: undefined,
		peers: ["a-peer", "z-peer"],
	});
	assert.equal(a, b);
	assert.doesNotMatch(a, /Latest checkpoint|Advisor consultation|Acceptance criteria/);
});
