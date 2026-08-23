import type { Board, Role } from "./types.ts";

function section(title: string, body: string): string {
	return `\n## ${title}\n${body.trim()}`;
}

export function buildCrewBlock(input: {
	role: Role;
	board: Board;
	specBody?: string;
	checkpoint?: string;
	consultation?: string;
	contextPct?: number;
	softLimit: number;
	peers: string[];
	rolePrompt: string;
}): string {
	const { board } = input;
	const phases = board.resolved.phases
		.map((phase) => `${phase.name === board.phase ? "→ " : "  "}${phase.name} (${phase.owner})`)
		.join("\n");
	const task = `${board.task.title}\nphase: ${board.phase}\nowner: ${board.owner}`;
	const spec = board.currentSpec
		? `${board.currentSpec}${input.specBody?.trim() ? `\n${input.specBody.trim()}` : ""}`
		: "none";
	const summaries = Object.entries(board.specs)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, state]) => `${id}: ${state.status}, spec ${state.path}, rework ${state.reworkRound}`)
		.join("\n");
	const parts = [
		input.rolePrompt.trim(),
		section("Phases", phases),
		section("Board", task),
		section("Specs", summaries || spec),
		section("Current spec", spec),
	];
	if (board.history.length) {
		const latest = board.history[board.history.length - 1];
		parts.push(
			section(
				"Latest handoff",
				`${latest.from} → ${latest.to} (${latest.phase})${latest.verdict ? ` — ${latest.verdict}` : ""}`,
			),
		);
	}
	if (input.checkpoint?.trim()) parts.push(section("Latest checkpoint", input.checkpoint));
	if (input.consultation?.trim()) parts.push(section("Advisor consultation", input.consultation));
	parts.push(section("Peers", input.peers.length ? input.peers.slice().sort().join("\n") : "none"));
	if (input.contextPct !== undefined && input.contextPct >= input.softLimit) {
		parts.push("\nCONTEXT_PRESSURE — finish this step, then call checkpoint().");
	}
	return `${parts.join("\n").trim()}\n`;
}
