import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTask, readBoard, taskDir, updateBoard } from "./board.ts";
import { loadConfig, resolveCrew } from "./config.ts";
import { decideHandoff } from "./handoff.ts";
import { buildCrewBlock } from "./inject.ts";
import { registerLifecycle } from "./lifecycle.ts";
import { spawnRole } from "./spawn.ts";
import type { Board, HandoffDecision, Role } from "./types.ts";

const namespace = "blanche/v1";
const closePane = (paneId: string): Promise<void> =>
	new Promise((done) => {
		execFile(process.env.HERDR_BIN ?? "herdr", ["pane", "close", paneId], { shell: false }, () => done());
	});

export function shouldDeliver(input: {
	payload: { taskId: string; handoffId: string; to: Role };
	myTaskId: string;
	myRole: Role;
	seenHandoffIds: string[];
}): boolean {
	const candidate = input as unknown as Record<string, unknown> | null | undefined;
	const payload = candidate?.payload as Record<string, unknown> | null | undefined;
	const seen = candidate?.seenHandoffIds;
	return (
		!!payload &&
		typeof payload.taskId === "string" &&
		typeof payload.handoffId === "string" &&
		typeof payload.to === "string" &&
		typeof candidate?.myTaskId === "string" &&
		typeof candidate?.myRole === "string" &&
		Array.isArray(seen) &&
		payload.taskId === candidate.myTaskId &&
		payload.to === candidate.myRole &&
		!seen.includes(payload.handoffId)
	);
}

export default function blancheExtension(pi: any): void {
	let channel: any;
	let lifecycleHandle:
		| { handleAction(action: string, idArg?: string, ctx?: any): Promise<unknown> }
		| undefined;
	const sessions: Partial<Record<Role, { contextEpoch: number }>> = {};
	const seenHandoffIds = new Set<string>();
	const role = (): Role | undefined => process.env.BLANCHE_ROLE as Role | undefined;
	const taskId = (): string | undefined => process.env.BLANCHE_TASK;
	const board = (): Board | undefined => {
		const id = taskId();
		if (!id) return undefined;
		try {
			return readBoard(id);
		} catch {
			return undefined;
		}
	};
	const liveSessions = async (): Promise<string[]> =>
		channel ? (await channel.listSessions()).map((s: any) => s.name).filter(Boolean) : [];

	pi.on("before_agent_start", async () => {
		const currentRole = role();
		const currentBoard = board();
		if (!currentRole || !currentBoard) return;
		const state = currentBoard.sessions[currentRole];
		const rolePrompt = readFileSync(resolve(import.meta.dirname, "roles", `${currentRole}.md`), "utf8");
		const specBody =
			currentBoard.currentSpec && currentBoard.specs[currentBoard.currentSpec]?.path
				? readFileSync(currentBoard.specs[currentBoard.currentSpec].path, "utf8")
				: undefined;
		const checkpointPath = state?.latestCheckpoint
			? join(taskDir(currentBoard.id), state.latestCheckpoint)
			: "";
		const checkpoint =
			checkpointPath && existsSync(checkpointPath) ? readFileSync(checkpointPath, "utf8") : undefined;
		const consultation = [...currentBoard.consultations]
			.reverse()
			.find((item) => (currentBoard.currentSpec ? item.spec === currentBoard.currentSpec : !item.spec));
		const consultationPath = consultation ? join(taskDir(currentBoard.id), consultation.summaryPath) : "";
		const consultationBody =
			consultationPath && existsSync(consultationPath) ? readFileSync(consultationPath, "utf8") : undefined;
		const contextSession =
			state?.sessionName && channel
				? (await channel.listSessions()).find((session: any) => session.name === state.sessionName)
				: undefined;
		const softLimit = loadConfig().context.softLimit;
		return {
			systemPrompt: buildCrewBlock({
				role: currentRole,
				board: currentBoard,
				softLimit,
				contextPct: contextSession?.contextPct,
				specBody,
				checkpoint,
				consultation: consultationBody,
				peers: Object.values(currentBoard.sessions)
					.map((s) => s?.sessionName)
					.filter(Boolean) as string[],
				rolePrompt,
			}),
		};
	});
	pi.on("session_compact", () => {
		const currentRole = role();
		if (!currentRole) return;
		const epoch = (sessions[currentRole]?.contextEpoch ?? 0) + 1;
		sessions[currentRole] = { contextEpoch: epoch };
		const currentBoard = board();
		if (currentBoard?.sessions[currentRole]) {
			updateBoard(currentBoard.id, (fresh) => {
				const session = fresh.sessions[currentRole];
				if (session) session.contextEpoch = epoch;
			});
		}
	});

	pi.events?.emit?.("intercom:extension-register", {
		namespace,
		ownerEligible: true,
		onEvent: (event: any) => {
			if (event.type !== "message" || !event.payload) return;
			const currentTask = taskId();
			const currentRole = role();
			const payload = event.payload;
			if (
				!currentTask ||
				!currentRole ||
				!shouldDeliver({
					payload,
					myTaskId: currentTask,
					myRole: currentRole,
					seenHandoffIds: [...seenHandoffIds],
				})
			)
				return;
			seenHandoffIds.add(payload.handoffId);
			const currentBoard = board();
			if (currentBoard) {
				updateBoard(currentBoard.id, (fresh) => {
					const entry = fresh.history.find((h) => h.handoffId === payload.handoffId);
					if (entry) entry.ackedAt = Date.now();
				});
			}
			pi.sendMessage?.(payload.message ?? `Handoff for ${payload.phase}`, { triggerTurn: true });
		},
		onReady: (ready: any) => {
			channel = ready;
			lifecycleHandle = registerLifecycle(pi, { channel: () => channel, liveSessions }) as any;
		},
	});

	pi.registerTool?.({
		name: "handoff",
		description: "Hand off the current crew task.",
		parameters: {},
		execute: async (_id: string, input: any) => {
			const currentBoard = board();
			const from = role();
			if (!currentBoard || !from) throw new Error("Not running in a Blanche crew session.");
			const handoffId = randomUUID();
			const live = await liveSessions();
			let decision: HandoffDecision | undefined;
			updateBoard(currentBoard.id, (fresh) => {
				const next = decideHandoff({
					...input,
					board: fresh,
					from,
					liveSessions: live,
					now: Date.now(),
					handoffId,
				});
				if (!next.ok) throw new Error(next.error);
				Object.assign(fresh, next.board);
				decision = next;
			});
			if (!decision?.ok) throw new Error("Handoff decision was not produced.");
			channel?.publish({
				taskId: currentBoard.id,
				handoffId,
				to: input.to,
				phase: input.phase,
				spec: input.spec,
				message: input.message,
				verdict: input.verdict,
				notes: decision.notes,
			});
			return {
				content: [{ type: "text", text: [input.message ?? "Handoff sent.", ...decision.notes].join("\n") }],
			};
		},
	});

	pi.registerCommand?.("crew", {
		description: "Start or inspect a Blanche crew.",
		handler: async (raw: string, ctx: any) => {
			const args = raw.trim();
			if (args === "status") {
				const current = board();
				if (!current) {
					const status = "No active Blanche crew.";
					ctx?.ui?.notify?.(status, "info");
					return status;
				}
				const roster = Object.entries(current.sessions)
					.map(([r, s]) => `${r}: e${s?.contextEpoch ?? 0} ${s?.sessionName ?? "offline"}`)
					.join(" | ");
				const status = `${current.phase} ▸ ${current.owner} ▸ ${current.currentSpec ?? "no spec"} ▸ rework ${current.reworkRound} | ${roster}`;
				ctx?.ui?.setStatus?.("blanche", status);
				ctx?.ui?.notify?.(status, "info");
				return status;
			}
			const lifecycleAction = /^(resume|stop|clean)(?:\s+(\S+))?$/.exec(args);
			if (lifecycleAction) {
				if (!lifecycleHandle) throw new Error("Crew lifecycle is not ready yet; try again shortly.");
				return lifecycleHandle.handleAction(lifecycleAction[1], lifecycleAction[2], ctx);
			}
			const match = /^(\S+)\s+["']([\s\S]*)["']$/.exec(args);
			if (!match) throw new Error('Usage: /crew <workflow> "<description>"');
			const [workflow, description] = [match[1], match[2]];
			const crew = resolveCrew(loadConfig(), workflow);
			const id = `${workflow}-${Date.now().toString(36)}`;
			const created = createTask({
				id,
				workflow,
				title: description,
				description,
				cwd: process.cwd(),
				resolved: crew,
				prefix: crew.prefix,
				phase: crew.phases[0]?.name ?? "REQUESTED",
				owner: "leader",
				leader: { sessionName: pi.getSessionName?.() ?? "leader" },
			});
			const openedPanes: string[] = [];
			try {
				for (const member of crew.roster) {
					const launched = await spawnRole({
						role: member,
						board: created,
						profile: crew.agents[member],
						cwd: process.cwd(),
						liveSessions,
					});
					openedPanes.push(launched.paneId);
					created.sessions[member] = {
						sessionName: launched.sessionName,
						paneId: launched.paneId,
						contextEpoch: 0,
					};
				}
				updateBoard(created.id, (fresh) => {
					fresh.sessions = created.sessions;
				});
				const status = `${created.phase} ▸ ${created.owner} ▸ ${created.currentSpec ?? "no spec"} ▸ rework ${created.reworkRound}`;
				ctx?.ui?.setStatus?.("blanche", status);
				const message = `Crew ${id} started: ${crew.roster.join(", ")}`;
				ctx?.ui?.notify?.(message, "info");
				return message;
			} catch (error) {
				await Promise.all(openedPanes.map((paneId) => closePane(paneId)));
				throw new Error(
					`Crew kickoff failed; any opened panes were closed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	});
}
