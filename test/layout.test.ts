import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../config.ts";
import type { Role } from "../types.ts";

type Command = string[];

type LayoutContract = {
	partitionRoles(roles: Role[]): { review: Role[]; execution: Role[] };
	desiredColumns(input: { review: number; execution: number }): {
		leader: number;
		review?: number;
		execution?: number;
	};
	rowSplitRatios(count: number): number[];
	parsePaneLayout(raw: unknown): unknown;
	measureColumns(
		layout: unknown,
		input: { leaderPaneId: string; reviewPaneIds: string[]; executionPaneIds: string[] },
	): { leader: number; review?: number; execution?: number };
	assertEqualRows(layout: unknown, paneIds: string[]): void;
	assertFullHeightColumn(layout: unknown, paneIds: string[]): void;
	planKickoff(input: { leaderPaneId: string; reviewRoles: Role[]; executionRoles: Role[] }): unknown;
	planLateRole(input: {
		role: Role;
		leaderPaneId: string;
		reviewPaneId?: string;
		executionPaneId?: string;
	}): unknown;
	planResume(input: {
		leaderPaneId: string;
		persistedPaneIds: Partial<Record<Role, string>>;
		observedPaneIds: string[];
	}): { respawnRoles: Role[]; commands: Command[]; focusPaneId: string };
	planClean(input: { leaderPaneId: string; rolePaneIds: string[]; unrelatedPaneIds: string[] }): {
		commands: Command[];
		focusPaneId: string;
	};
};

const layoutPath = "../layout.ts";
const loadedLayout = await import(layoutPath).catch(() => undefined);
const missingLayout = (operation: string): never => {
	throw new Error(`focused layout module missing behavior: ${operation}`);
};
const layout: LayoutContract =
	(loadedLayout as LayoutContract | undefined) ??
	({
		partitionRoles: () => missingLayout("partitionRoles"),
		desiredColumns: () => missingLayout("desiredColumns"),
		rowSplitRatios: () => missingLayout("rowSplitRatios"),
		parsePaneLayout: () => missingLayout("parsePaneLayout"),
		measureColumns: () => missingLayout("measureColumns"),
		assertEqualRows: () => missingLayout("assertEqualRows"),
		assertFullHeightColumn: () => missingLayout("assertFullHeightColumn"),
		planKickoff: () => missingLayout("planKickoff"),
		planLateRole: () => missingLayout("planLateRole"),
		planResume: () => missingLayout("planResume"),
		planClean: () => missingLayout("planClean"),
	} as LayoutContract);

const canonicalReview: Role[] = ["planner", "advisor", "verifier"];
const canonicalExecution: Role[] = ["researcher", "worker", "qa"];

function commands(plan: unknown): Command[] {
	assert.ok(plan && typeof plan === "object", "layout plan must be an object");
	const value = (plan as { commands?: unknown }).commands;
	assert.ok(Array.isArray(value), "layout plan must expose argv commands");
	return value as Command[];
}

function paneCommands(plan: unknown): Command[] {
	return commands(plan).filter((argv) => argv[0] === "pane");
}

test("groups every default workflow into canonical review and execution order", () => {
	for (const [workflow, config] of Object.entries(DEFAULT_CONFIG.workflows)) {
		const grouped = layout.partitionRoles(config.roles.filter((role) => role !== "leader"));
		assert.deepEqual(
			grouped.review,
			canonicalReview.filter((role) => config.roles.includes(role)),
			`${workflow} review group`,
		);
		assert.deepEqual(
			grouped.execution,
			canonicalExecution.filter((role) => config.roles.includes(role)),
			`${workflow} execution group`,
		);
	}
});

test("selects stable leader/review/execution widths for both-stack and one-stack states", () => {
	assert.deepEqual(layout.desiredColumns({ review: 3, execution: 3 }), {
		leader: 50,
		review: 20,
		execution: 30,
	});
	assert.deepEqual(layout.desiredColumns({ review: 0, execution: 3 }), {
		leader: 70,
		execution: 30,
	});
	assert.deepEqual(layout.desiredColumns({ review: 3, execution: 0 }), {
		leader: 80,
		review: 20,
	});
});

test("uses non-flat 1/k ratios to build equal three-row stacks", () => {
	assert.deepEqual(layout.rowSplitRatios(1), []);
	assert.deepEqual(layout.rowSplitRatios(2), [0.5]);
	assert.deepEqual(layout.rowSplitRatios(3), [1 / 3, 1 / 2]);
	assert.notDeepEqual(layout.rowSplitRatios(3), [0.5, 0.5]);
});

test("measures parsed Herdr rectangles in leader | review | execution order", () => {
	const parsed = layout.parsePaneLayout({
		result: {
			layout: {
				area: { x: 0, y: 0, width: 1000, height: 600 },
				panes: [
					{ pane_id: "leader", rect: { x: 0, y: 0, width: 500, height: 600 } },
					{ pane_id: "review", rect: { x: 500, y: 0, width: 200, height: 600 } },
					{ pane_id: "execution", rect: { x: 700, y: 0, width: 300, height: 600 } },
				],
			},
		},
	});
	assert.deepEqual(
		layout.measureColumns(parsed, {
			leaderPaneId: "leader",
			reviewPaneIds: ["review"],
			executionPaneIds: ["execution"],
		}),
		{ leader: 50, review: 20, execution: 30 },
	);
});

test("accepts equal stack rows with one-cell rounding", () => {
	const parsed = layout.parsePaneLayout({
		layout: {
			area: { x: 0, y: 0, width: 1000, height: 601 },
			panes: [
				{ pane_id: "researcher", rect: { x: 700, y: 0, width: 300, height: 200 } },
				{ pane_id: "worker", rect: { x: 700, y: 200, width: 300, height: 200 } },
				{ pane_id: "qa", rect: { x: 700, y: 400, width: 300, height: 201 } },
			],
		},
	});
	assert.doesNotThrow(() => layout.assertEqualRows(parsed, ["researcher", "worker", "qa"]));
});

test("creates the late review column from the leader leaf, but adds a row when review exists", () => {
	const rowPlan = layout.planLateRole({ role: "advisor", leaderPaneId: "leader", reviewPaneId: "review" });
	const rowCommands = paneCommands(rowPlan);
	assert.equal(
		rowCommands.some((argv) => argv[1] === "split" && argv.includes("leader")),
		false,
	);
	assert.ok(rowCommands.some((argv) => argv[1] === "split" && argv.includes("review")));

	const columnPlan = layout.planLateRole({
		role: "advisor",
		leaderPaneId: "leader",
		executionPaneId: "execution",
	});
	const columnCommands = paneCommands(columnPlan);
	assert.equal(
		columnCommands.filter((argv) => argv[1] === "split" && argv.includes("leader") && argv.includes("right"))
			.length,
		1,
	);
	assert.equal((columnPlan as { columnCreation?: boolean }).columnCreation, true);
});

test("respawns missing persisted pane IDs instead of guessing by order or proximity", () => {
	const plan = layout.planResume({
		leaderPaneId: "leader",
		persistedPaneIds: { researcher: "researcher-old", worker: "worker-old", qa: "qa-old" },
		observedPaneIds: ["leader", "worker-old", "qa-old", "unrelated-nearby"],
	});
	assert.deepEqual(plan.respawnRoles, ["researcher"]);
	assert.equal(
		plan.commands.some((argv) => argv.includes("unrelated-nearby")),
		false,
	);
	assert.equal(plan.focusPaneId, "leader");
});

test("clean closes only recorded role panes and never leader or unrelated panes", () => {
	const plan = layout.planClean({
		leaderPaneId: "leader",
		rolePaneIds: ["planner", "worker", "qa"],
		unrelatedPaneIds: ["sentinel"],
	});
	const closeIds = paneCommands(plan)
		.filter((argv) => argv[1] === "close")
		.map((argv) => argv[argv.length - 1]);
	assert.deepEqual(closeIds, ["planner", "worker", "qa"]);
	assert.equal(closeIds.includes("leader"), false);
	assert.equal(closeIds.includes("sentinel"), false);
	assert.equal(plan.focusPaneId, "leader");
});

test("rejects an execution-leaf split that makes a partial-height review column", () => {
	const bad = layout.parsePaneLayout({
		layout: {
			area: { x: 0, y: 0, width: 1000, height: 600 },
			panes: [
				{ pane_id: "leader", rect: { x: 0, y: 0, width: 700, height: 600 } },
				{ pane_id: "researcher", rect: { x: 700, y: 0, width: 300, height: 300 } },
				{ pane_id: "advisor", rect: { x: 700, y: 300, width: 150, height: 300 } },
				{ pane_id: "worker", rect: { x: 850, y: 300, width: 150, height: 300 } },
			],
		},
	});
	assert.throws(() => layout.assertFullHeightColumn(bad, ["advisor"]), /full.height|column/i);
});

test("keeps leader focus after kickoff, late spawn, resume, and clean plans", () => {
	const plans = [
		layout.planKickoff({ leaderPaneId: "leader", reviewRoles: ["planner"], executionRoles: ["worker"] }),
		layout.planLateRole({ role: "advisor", leaderPaneId: "leader", executionPaneId: "execution" }),
		layout.planResume({ leaderPaneId: "leader", persistedPaneIds: {}, observedPaneIds: ["leader"] }),
		layout.planClean({ leaderPaneId: "leader", rolePaneIds: ["worker"], unrelatedPaneIds: ["sentinel"] }),
	];
	for (const plan of plans) assert.equal((plan as { focusPaneId: string }).focusPaneId, "leader");
});
