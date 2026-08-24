import type { Board, HandoffDecision, HandoffInput, HandoffRecord, Role } from "./types.js";
export function decideHandoff(input: HandoffInput): HandoffDecision {
	const { board, from, to } = input;
	const target = to === "leader" ? board.leader.sessionName : board.sessions[to]?.sessionName;
	if (to !== "leader" && !board.resolved.roster.includes(to as Role))
		return { ok: false, error: `Role '${to}' is not in roster: ${board.resolved.roster.join(", ")}` };
	if (!target || !input.liveSessions.includes(target))
		return { ok: false, error: `Target session '${target ?? to}' is not live` };
	const allowed = from === "qa" ? ["PASS", "FAIL"] : from === "verifier" ? ["APPROVED", "CHANGES"] : [];
	if (allowed.length ? !input.verdict || !allowed.includes(input.verdict) : input.verdict != null)
		return { ok: false, error: `Invalid verdict; allowed: ${allowed.length ? allowed.join("|") : "none"}` };
	const next = structuredClone(board) as Board;
	const specId = input.spec ?? board.currentSpec;
	const spec = specId ? next.specs[specId] : undefined;
	const state = next.resolved.specs && spec ? spec : next;
	const bad = input.verdict === "FAIL" || input.verdict === "CHANGES";
	if (bad && to === "worker") state.reworkRound++;
	if (state.reworkRound > board.resolved.maxRework)
		return { ok: false, error: `Maximum rework exceeded; hand to the leader` };
	const notes: string[] = [];
	if (
		board.resolved.advisorAfter !== null &&
		next.resolved.roster.includes("advisor") &&
		state.reworkRound >= board.resolved.advisorAfter &&
		(state.lastAdvisorConsultedRound === null || state.lastAdvisorConsultedRound < state.reworkRound)
	)
		notes.push("Advisor consultation required for this rework round.");
	const epoch = board.sessions[from]?.contextEpoch;
	if (epoch !== undefined && !board.sessions[from]?.latestCheckpoint?.includes(`e${epoch}`))
		notes.push(`Warning: no checkpoint recorded for ${from} at epoch ${epoch}.`);
	next.phase = input.phase;
	next.owner = next.resolved.phases.find((p) => p.name === input.phase)?.owner ?? input.to;
	next.currentSpec = input.spec ?? board.currentSpec;
	next.history.push({
		handoffId: input.handoffId,
		from,
		to,
		spec: input.spec,
		phase: input.phase,
		verdict: input.verdict ?? null,
		...((input as { message?: string }).message ? { message: (input as { message?: string }).message } : {}),
		sentAt: input.now,
	});
	return { ok: true, board: next, notes, target };
}

/** The handoff a role still owes a turn on: latest addressed to it, never acked.
 *  Push delivery is best-effort — a publish that lands before the receiver's
 *  channel is subscribed is dropped — so the receiver pulls this on connect. */
export function pendingFor(board: Board, role: Role): HandoffRecord | undefined {
	return [...board.history].reverse().find((h) => h.to === role && !h.ackedAt);
}
