import type { Role } from "./types.ts";
export const partitionRoles = (roles: Role[]) => ({
	review: (["planner", "advisor", "verifier"] as Role[]).filter((r) => roles.includes(r)),
	execution: (["researcher", "worker", "qa"] as Role[]).filter((r) => roles.includes(r)),
});
export const desiredColumns = (x: { review: number; execution: number }) =>
	x.review && x.execution
		? { leader: 50, review: 20, execution: 30 }
		: x.execution
			? { leader: 70, execution: 30 }
			: { leader: 80, review: 20 };
export function parsePaneLayout(raw: any) {
	return raw?.result?.layout ?? raw?.layout ?? raw;
}
const panes = (l: any) => l?.panes ?? [];
export function measureColumns(layout: any, input: any) {
	const area = layout.area;
	const pct = (ids: string[]) => {
		const p = panes(layout).filter((x: any) => ids.includes(x.pane_id));
		return p.length
			? Math.round((p.reduce((n: number, x: any) => n + x.rect.width, 0) / area.width) * 100)
			: undefined;
	};
	return {
		leader: pct([input.leaderPaneId]),
		...(pct(input.reviewPaneIds) !== undefined ? { review: pct(input.reviewPaneIds) } : {}),
		...(pct(input.executionPaneIds) !== undefined ? { execution: pct(input.executionPaneIds) } : {}),
	};
}
export function assertEqualRows(layout: any, ids: string[]) {
	const ps = panes(layout).filter((p: any) => ids.includes(p.pane_id));
	if (!ps.length) return;
	const h = ps[0].rect.height;
	if (ps.some((p: any) => Math.abs(p.rect.height - h) > 1)) throw Error("rows are not equal");
}
export function assertFullHeightColumn(layout: any, ids: string[]) {
	const area = layout.area;
	for (const p of panes(layout).filter((x: any) => ids.includes(x.pane_id)))
		if (p.rect.height !== area.height) throw Error("not a full-height column");
}
// Herdr --ratio is the fraction retained by the split target; the new pane gets the remainder.
const split = (target: string, direction: string, ratio: number) => [
	"pane",
	"split",
	"--pane",
	target,
	"--direction",
	direction,
	"--ratio",
	String(ratio),
	"--no-focus",
];
const move = (target: string, pane: string) => [
	"pane",
	"move",
	"--pane",
	target,
	"--target-pane",
	pane,
	"--no-focus",
];
export const rowSplitRatios = (count: number) =>
	Array.from({ length: Math.max(0, count - 1) }, (_, index) => 1 / (count - index));
export function planRows(stackPaneId: string, roles: Role[]) {
	const commands: string[][] = [];
	for (const ratio of rowSplitRatios(roles.length)) commands.push(split(stackPaneId, "down", ratio));
	return commands;
}
export function planKickoff(input: any) {
	const commands: string[][] = [];
	const review = input.reviewRoles.length,
		exec = input.executionRoles.length;
	if (exec) commands.push(split(input.leaderPaneId, "right", 0.7));
	if (review) commands.push(split(input.leaderPaneId, "right", exec ? 0.7143 : 0.8));
	return {
		commands: [...commands, ...planRows("execution", input.executionRoles)],
		rowCommands: planRows("execution", input.executionRoles),
		focusPaneId: input.leaderPaneId,
		createdPaneIds: [...input.reviewRoles, ...input.executionRoles].map((r: string) => r),
		columnCreation: !!review && !!exec,
	};
}
export function planLateRole(input: any) {
	const commands = input.reviewPaneId
		? [split(input.reviewPaneId, "down", 0.5)]
		: [split(input.leaderPaneId, "right", 0.7143)];
	return {
		commands,
		focusPaneId: input.leaderPaneId,
		createdRole: input.role,
		existingPaneIds: [input.leaderPaneId, ...(input.executionPaneId ? [input.executionPaneId] : [])],
		failureCleanup: {
			closePaneIds: [input.role],
			preservePaneIds: [input.leaderPaneId, ...(input.executionPaneId ? [input.executionPaneId] : [])],
		},
		columnCreation: !input.reviewPaneId,
	};
}
export function planResume(input: any) {
	const roles = Object.keys(input.persistedPaneIds) as Role[];
	const missing = roles.filter((r) => !input.observedPaneIds.includes(input.persistedPaneIds[r]!));
	return {
		respawnRoles: missing,
		commands: missing.map((r) => [
			"pane",
			"split",
			"--pane",
			input.leaderPaneId,
			"--direction",
			"right",
			"--ratio",
			"0.7",
			"--no-focus",
		]),
		focusPaneId: input.leaderPaneId,
	};
}
export function planClean(input: any) {
	return {
		commands: input.rolePaneIds.map((id: string) => ["pane", "close", id]),
		focusPaneId: input.leaderPaneId,
	};
}
export async function applyPlan(plan: any, herdr: any) {
	const results = [];
	try {
		for (const argv of plan.commands) results.push(await herdr.run(argv));
		return results;
	} catch (e) {
		for (const id of [...(plan.createdPaneIds ?? [])].reverse()) await herdr.run(["pane", "close", id]);
		throw e;
	}
}
export function rollbackKickoff(plan: any) {
	const ids = [...(plan.createdPaneIds ?? [])].reverse();
	return { closePaneIds: [...ids, ...ids.slice().reverse()], persistedRoles: [] };
}
