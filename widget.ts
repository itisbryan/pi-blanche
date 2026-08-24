import type { Board, Role } from "./types.ts";

type Snapshot = {
	board: Board;
	viewer: { role?: Role; sessionName?: string };
	liveRoster: { name?: string; contextPct?: number }[];
};
type Theme = Record<string, (s: string) => string>;
type Timer = { unref?: () => void };
type Clock = {
	setInterval: (f: () => void, n: number) => Timer;
	clearInterval: (t: Timer) => void;
	setTimeout?: (f: () => void, n: number) => Timer;
	clearTimeout?: (t: Timer) => void;
};
const roles: Role[] = ["planner", "researcher", "advisor", "worker", "qa", "verifier"];
export function createCrewWidget(
	initial: Snapshot,
	opts: { tui: { requestRender(): void }; theme: () => Theme; clock?: Clock; glyphs?: "unicode" | "ascii" },
) {
	let snap = initial,
		timer: Timer | undefined,
		transitionTimer: Timer | undefined,
		frame = 0,
		previous = "",
		disposed = false,
		handoffId: string | undefined,
		transitionActive = false;
	const glyph =
		opts.glyphs === "ascii"
			? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", dot: "o", arrow: ">" }
			: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", dot: "●", arrow: "▶" };
	const color = (name: string, s: string) => opts.theme()[name]?.(s) ?? s;
	const fit = (s: string, w: number) => {
		const raw = s.replace(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "g"), "");
		const n = Array.from(raw);
		if (n.length > w) return n.slice(0, Math.max(0, w - 1)).join("") + "…";
		return s + " ".repeat(Math.max(0, w - n.length));
	};
	const active = () =>
		snap.board.status === "active" &&
		snap.board.phase !== "DONE" &&
		snap.liveRoster.some(
			(x) =>
				x.name ===
				(snap.board.owner === "leader"
					? snap.board.leader.sessionName
					: snap.board.sessions[snap.board.owner as Role]?.sessionName),
		);
	const render = (width: number) => {
		if (width < 24) return [fit(`${snap.board.phase} ${snap.board.owner}`, width)];
		const b = snap.board,
			t = snap.board.resolved,
			lines: string[] = [];
		const idx = t.phases.findIndex((p) => p.name === b.phase);
		const next = idx >= 0 ? t.phases[idx + 1] : undefined;
		const nextOwner = next?.owner ?? "";
		const traceWidth = 5,
			pos = frame % (traceWidth + 1);
		const tracer = glyph.h.repeat(pos) + glyph.dot + glyph.h.repeat(traceWidth - pos) + glyph.arrow;
		const title = `${glyph.tl}${glyph.h} BLANCHE · ${b.workflow.toUpperCase()} · ${b.phase} ${tracer} ${next ? `${next.name}/${nextOwner}` : idx < 0 ? "" : "complete"} ${glyph.tr}`;
		lines.push(fit(color("accent", title), width));
		let status = `${glyph.tl === "╭" ? "├─" : "+-"} CREW · ${b.id}`;
		if (b.reworkRound > 0)
			status += ` ${color(b.reworkRound >= b.resolved.maxRework ? "error" : "warning", `rework ${b.reworkRound}/${b.resolved.maxRework}`)}`;
		const last = b.history.at(-1);
		if (transitionActive) status += ` ${color("borderAccent", `HANDOFF ${last?.to ?? ""}`)}`;
		lines.push(fit(status, width));
		const roster = ["leader", ...(t.roster.length ? t.roster : roles)] as Role[];
		for (const role of roster) {
			const session = role === "leader" ? b.leader.sessionName : b.sessions[role]?.sessionName;
			const live = !!session && snap.liveRoster.some((x) => x.name === session);
			const you =
				snap.viewer.role === role || (snap.viewer.role === undefined && snap.viewer.sessionName === session);
			const provision = session
				? live
					? "live"
					: "offline"
				: role === "advisor"
					? "on demand"
					: "not started";
			const owner = b.owner === role ? "> owner" : "";
			const label = you ? "YOU" : role === "leader" ? "OPERATOR" : "";
			lines.push(
				fit(
					`${glyph.v} ${label ? `${label} · ` : ""}${role.toUpperCase()} ${owner} ${provision}`.replace(
						/ +/g,
						" ",
					),
					width,
				),
			);
		}
		lines.push(fit(`${glyph.bl}${glyph.h.repeat(Math.max(1, width - 2))}${glyph.br}`, width));
		if (lines.length > 10) return [fit(`${b.phase} ${b.owner} ${b.id}`, width)];
		while (lines.length < 3) lines.push(fit(`${glyph.v}`, width));
		return lines.map((x) => fit(x, width));
	};
	const ensureTimer = () => {
		const should = active();
		if (should && !timer && opts.clock) {
			timer = opts.clock.setInterval(() => {
				frame++;
				previous = "";
				opts.tui.requestRender();
			}, 160);
			timer.unref?.();
		}
		if (!should && timer && opts.clock) {
			opts.clock.clearInterval(timer);
			timer = undefined;
		}
	};
	return {
		render(width: number) {
			if (disposed) return [];
			ensureTimer();
			const out = render(width);
			if (frame % 2) out[1] = out[1]?.replace(glyph.dot, glyph.dot === "●" ? "○" : "O") ?? out[1];
			return out;
		},
		update(next: Snapshot) {
			if (disposed) return;
			const changed = JSON.stringify(next) !== JSON.stringify(snap);
			if (changed) {
				const old = snap.board.history.at(-1)?.handoffId;
				snap = next;
				if (next.board.history.at(-1)?.handoffId !== old) {
					previous = "HANDOFF";
					transitionActive = true;
					handoffId = next.board.history.at(-1)?.handoffId;
					if (opts.clock?.setTimeout)
						transitionTimer = opts.clock.setTimeout(() => {
							previous = "";
							transitionActive = false;
							handoffId = undefined;
						}, 1500);
				}
			}
			ensureTimer();
		},
		dispose() {
			if (timer && opts.clock) opts.clock.clearInterval(timer);
			if (transitionTimer && opts.clock?.clearTimeout) opts.clock.clearTimeout(transitionTimer);
			timer = undefined;
			transitionTimer = undefined;
		},
	};
}
