import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	createTask,
	currentRole,
	currentTaskId,
	listTasks,
	readBoard,
	taskDir,
	updateBoard,
} from "./board.ts";
import { loadConfig, resolveCrew, serviceRoles } from "./config.ts";
import { decideHandoff, pendingFor } from "./handoff.ts";
import { buildCrewBlock } from "./inject.ts";
import { registerLifecycle } from "./lifecycle.ts";
import { spawnRole } from "./spawn.ts";
import type { Board, HandoffDecision, Role } from "./types.ts";
import { createCrewWidget } from "./widget.ts";

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
	let uiContext: any;
	const role = (): Role | undefined => currentRole();
	const sessionName = (): string | undefined => {
		try {
			return pi.getSessionName?.();
		} catch {
			return undefined;
		}
	};
	const taskId = (): string | undefined => currentTaskId(process.cwd(), sessionName());

	// Shared by the handoff tool and by kickoff's opening handoff.
	const sendHandoff = async (b: Board, from: Role, input: any): Promise<string[]> => {
		const handoffId = randomUUID();
		if (input.to !== "leader") await ensureRole(b, input.to);
		const live = await liveSessions();
		let decision: HandoffDecision | undefined;
		updateBoard(b.id, (fresh) => {
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
		void refreshWidget();
		if (decision.notes.some((note) => note.toLowerCase().includes("advisor"))) {
			await ensureRole(b, "advisor");
		}
		channel?.publish({
			taskId: b.id,
			handoffId,
			to: input.to,
			phase: input.phase,
			spec: input.spec,
			message: input.message,
			verdict: input.verdict,
			notes: decision.notes,
		});
		return decision.notes;
	};
	const board = (): Board | undefined => {
		const id = taskId();
		if (!id) return undefined;
		try {
			return readBoard(id);
		} catch {
			return undefined;
		}
	};
	const liveRoster = async (): Promise<Array<{ name?: string; contextPct?: number }>> => {
		if (!channel) return [];
		try {
			return (await channel.listSessions()).filter((session: any) => session.name);
		} catch {
			return [];
		}
	};
	const liveSessions = async (): Promise<string[]> =>
		(await liveRoster()).flatMap((session) => (session.name ? [session.name] : []));
	let widgetKey: string | undefined;
	let widgetSnapshot: Parameters<typeof createCrewWidget>[0] | undefined;
	let widgetComponent: ReturnType<typeof createCrewWidget> | undefined;
	let widgetTui: { requestRender(): void } | undefined;
	const refreshWidget = async (context = uiContext): Promise<void> => {
		if (!context?.ui?.setWidget) return;
		const current = board();
		const name = sessionName();
		const participant =
			!!process.env.BLANCHE_ROLE ||
			(current !== undefined &&
				(name === current.leader.sessionName ||
					Object.values(current.sessions).some((session) => session?.sessionName === name)));
		if (!current || !participant) {
			widgetComponent?.dispose();
			widgetComponent = undefined;
			widgetSnapshot = undefined;
			widgetKey = undefined;
			widgetTui = undefined;
			context.ui.setWidget("blanche", undefined);
			return;
		}
		const live = await liveRoster();
		const snapshot: Parameters<typeof createCrewWidget>[0] = {
			board: current,
			viewer: { role: process.env.BLANCHE_ROLE as Role | undefined, sessionName: name },
			liveRoster: live,
		};
		const key = `${current.id}|${snapshot.viewer.role ?? ""}|${snapshot.viewer.sessionName ?? ""}`;
		widgetSnapshot = snapshot;
		if (widgetKey === key) {
			widgetComponent?.update(snapshot);
			widgetTui?.requestRender();
			return;
		}
		widgetComponent?.dispose();
		widgetComponent = undefined;
		widgetTui = undefined;
		widgetKey = key;
		const initial = widgetSnapshot;
		if (!initial) return;
		context.ui.setWidget(
			"blanche",
			(tui: { requestRender(): void }, theme: Record<string, (s: string) => string>) => {
				widgetTui = tui;
				const component = createCrewWidget(widgetSnapshot ?? initial, {
					tui,
					theme: () => {
						const liveTheme = context.ui.theme;
						if (liveTheme?.fg) {
							return {
								accent: (text: string) => liveTheme.fg("accent", text),
								borderAccent: (text: string) => liveTheme.fg("borderAccent", text),
								dim: (text: string) => liveTheme.fg("dim", text),
								error: (text: string) => liveTheme.fg("error", text),
								muted: (text: string) => liveTheme.fg("muted", text),
								success: (text: string) => liveTheme.fg("success", text),
								warning: (text: string) => liveTheme.fg("warning", text),
							};
						}
						return theme;
					},
				});
				widgetComponent = component;
				return component;
			},
		);
	};
	// ponytail: spawn-then-record reads a stale board, so two concurrent
	// escalations could spawn duplicate advisor panes and leak the unrecorded
	// one. Foreclosed by maxWorkers:1 today. Upgrade path: claim the session
	// slot under the board lock before spawning, or dedupe on a live broker-name check.
	const ensureRole = async (b: Board, target: Role): Promise<void> => {
		if (b.sessions[target]) return;
		const launched = await spawnRole({
			role: target,
			board: b,
			profile: b.resolved.agents[target],
			cwd: b.cwd,
			liveSessions,
		});
		updateBoard(b.id, (fresh) => {
			if (!fresh.sessions[target]) {
				fresh.sessions[target] = { ...launched, contextEpoch: 0 };
			}
		});
	};

	// pi.sendMessage is a no-op until the session is actually running, and the
	// channel becomes ready during startup — so an early delivery would be
	// swallowed while still being marked acked, burning the handoff for good.
	// Nothing is consumed until we can genuinely hand it to a turn.
	let sessionReady = false;
	pi.on("session_start", (_event: any, context: any) => {
		uiContext = context ?? uiContext;
		sessionReady = true;
		pullOwed();
		void refreshWidget();
	});

	const deliver = (payload: any) => {
		if (!sessionReady) return;
		const currentTask = taskId();
		const currentRole = role();
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
		// sendMessage takes a CustomMessage, not a string. Passing a string silently
		// injects nothing, which is why handoffs acked but no turn ever ran.
		const phaseIndex = currentBoard?.resolved.phases.findIndex((phase) => phase.name === payload.phase) ?? -1;
		const nextPhase = phaseIndex >= 0 ? currentBoard?.resolved.phases[phaseIndex + 1] : undefined;
		const terminalInstruction =
			payload.to === "advisor"
				? "ACTION REQUIRED: call consult first, then handoff your advice back to the worker."
				: nextPhase
					? payload.to === "leader"
						? nextPhase.owner === "leader"
							? `On success, advance to phase ${nextPhase.name} by handing off to leader. If blocked, stop and ask the user for the missing input; do not hand off while remaining in phase ${payload.phase}.`
							: `On success, hand off to ${nextPhase.owner} with phase ${nextPhase.name}. If blocked, stop and ask the user for the missing input. Do not hand off to leader.`
						: `On success, hand off to ${nextPhase.owner} with phase ${nextPhase.name}. If you cannot, hand off to leader with the reason.`
					: currentBoard && phaseIndex >= 0
						? "This is the final phase. Report completion to the user and do not hand off."
						: `Complete this phase, then end your turn by calling handoff(...). ${payload.to === "leader" ? "If blocked, stop and ask the user for the missing input. Do not hand off to leader." : "If you cannot, hand off to leader with the reason."}`;
		const actionLines = [
			`[blanche] You are now ${payload.to} for ${payload.taskId}, phase ${payload.phase}${payload.spec ? `, spec ${payload.spec}` : ""}.`,
			"This is work, not conversation.",
			terminalInstruction,
			...(payload.verdict ? [`Incoming verdict: ${payload.verdict}`] : []),
		];
		pi.sendMessage?.(
			{
				customType: "blanche_handoff",
				content: [
					...actionLines,
					"Sender message:",
					payload.message ?? `Handoff for ${payload.phase}`,
					...(payload.notes ?? []),
				].join("\n"),
				display: true,
				details: payload,
			},
			{ triggerTurn: true },
		);
	};

	const pullOwed = () => {
		const b = board();
		const currentRole = role();
		if (!b || !currentRole) {
			void refreshWidget();
			return;
		}
		const owed = pendingFor(b, currentRole);
		if (owed) deliver({ ...owed, taskId: b.id });
	};

	// The leader's own advertised name, not pi.getSessionName() — an unnamed
	// session returns undefined there, and recording the literal "leader" matches
	// no live session, so every handoff back to the operator fails liveness.
	const selfName = async (): Promise<string | undefined> => {
		const id = process.env.PI_INTERCOM_SESSION_ID;
		if (!channel || !id) return undefined;
		return (await channel.listSessions()).find((s: any) => s.id === id)?.name;
	};

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
		void refreshWidget();
	});

	pi.events?.emit?.("intercom:extension-register", {
		namespace,
		ownerEligible: true,
		onEvent: (event: any) => {
			if (event.type !== "message" || !event.payload) return;
			deliver(event.payload);
		},
		onReady: (ready: any) => {
			// onReady is invoked SYNCHRONOUSLY by pi-intercom during extension load, so
			// this function and everything reachable from it runs PRE-BIND: registration
			// methods are safe, action methods (getSessionName, sendMessage, ...) throw
			// notInitialized. The sessionName() catch and sessionReady gate enforce this.
			// Do not call an action method from here.
			channel = ready;
			lifecycleHandle = registerLifecycle(pi, { channel: () => channel, liveSessions }) as any;
			// Push and a single pull are both single moments, and they can both miss:
			// a handoff published before this channel negotiated is dropped, and a pull
			// that runs before the sender commits sees nothing. The board is the truth,
			// so keep asking. deliver() dedupes, so repeats are free.
			// ponytail: 3s poll of one small JSON file. Swap for a session_joined
			// handshake before publishing if this ever shows up in a profile.
			pullOwed();
			const timer = setInterval(pullOwed, 3000);
			timer.unref?.();
		},
	});

	pi.registerTool?.({
		name: "handoff",
		description: "Hand off the current crew task.",
		parameters: Type.Object({
			to: StringEnum(["leader", "planner", "researcher", "advisor", "worker", "qa", "verifier"] as const, {
				description: "Crew role receiving this handoff.",
			}),
			phase: Type.String({ description: "Target phase name from this workflow." }),
			spec: Type.Optional(Type.String({ description: "Current spec id, when the workflow uses specs." })),
			message: Type.String({ description: "What the receiving role needs to act." }),
			verdict: Type.Optional(
				StringEnum(["PASS", "FAIL", "APPROVED", "CHANGES"] as const, {
					description: "QA or verifier verdict, when applicable.",
				}),
			),
		}),
		execute: async (_id: string, input: any) => {
			const currentBoard = board();
			const from = role();
			if (!currentBoard || !from) throw new Error("Not running in a Blanche crew session.");
			const notes = await sendHandoff(currentBoard, from, input);
			return {
				content: [{ type: "text", text: [input.message ?? "Handoff sent.", ...notes].join("\n") }],
			};
		},
	});

	pi.registerCommand?.("crew", {
		description: "Start or inspect a Blanche crew.",
		handler: async (raw: string, ctx: any) => {
			uiContext = ctx ?? uiContext;
			const args = raw.trim();
			if (args === "status") {
				const current = board();
				if (!current) {
					const status = "No active Blanche crew.";
					ctx?.ui?.notify?.(status, "info");
					void refreshWidget(ctx);
					return status;
				}
				const roster = Object.entries(current.sessions)
					.map(([r, s]) => `${r}: e${s?.contextEpoch ?? 0} ${s?.sessionName ?? "offline"}`)
					.join(" | ");
				const status = `${current.phase} ▸ ${current.owner} ▸ ${current.currentSpec ?? "no spec"} ▸ rework ${current.reworkRound} | ${roster}`;
				ctx?.ui?.setStatus?.("blanche", status);
				ctx?.ui?.notify?.(status, "info");
				void refreshWidget(ctx);
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
			if (!channel) {
				throw new Error(
					"pi-blanche needs pi-intercom for crew messaging. Install it: pi install npm:pi-intercom",
				);
			}
			const crew = resolveCrew(loadConfig(), workflow);
			const blocking = listTasks(process.cwd()).find((candidate) => candidate.status === "active");
			if (blocking) {
				throw new Error(
					`Crew ${blocking.id} is already active in this directory. Stop or clean it ` +
						`(/crew stop, /crew clean ${blocking.id}), or start in another directory.`,
				);
			}
			const id = `${workflow}-${Date.now().toString(36)}`;
			// Label this session to match the crew convention, so it is identifiable
			// in the roster instead of showing up as subagent-chat-<uuid>.
			let leaderName: string | undefined;
			if (pi.setSessionName) {
				leaderName = `${crew.prefix}-${id}-leader`;
				pi.setSessionName(leaderName);
			} else {
				leaderName = (await selfName()) ?? pi.getSessionName?.();
			}
			if (!leaderName) {
				if (!channel) {
					throw new Error(
						"pi-blanche needs pi-intercom for crew messaging. Install it: pi install npm:pi-intercom",
					);
				}
				throw new Error(
					"This session is not on the intercom roster, so the crew could never hand work back to you. " +
						"Check the broker is up (`intercom status`), or start pi with --name.",
				);
			}
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
				leader: { sessionName: leaderName },
			});
			const openedPanes: string[] = [];
			// ponytail: only the advisor is lazy — its trigger is the advisorAfter nudge.
			// The researcher is reached by plain intercom, which we do not intercept, so
			// lazy-spawning it would advertise a peer with no session behind it.
			const service = new Set(serviceRoles(crew));
			const eagerRoles = new Set(crew.phases.map((phase) => phase.owner));
			if (service.has("researcher")) eagerRoles.add("researcher");
			try {
				for (const member of crew.roster) {
					if (!eagerRoles.has(member)) continue;
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
				// Kickoff hands the work over itself. `handoff` is an agent tool, so an
				// operator has no way to call it — without this the crew spawns and sits
				// at REQUESTED forever. The description IS the work.
				const opening = crew.phases.find((p) => p.owner !== "leader");
				let started = "";
				if (opening) {
					await sendHandoff(readBoard(created.id), "leader", {
						to: opening.owner,
						phase: opening.name,
						message: description,
					});
					started = `\n${opening.name} \u25b8 ${opening.owner} \u2014 work handed over.`;
				}
				const message = `Crew ${id} started: ${crew.roster.join(", ")}${started}`;
				ctx?.ui?.notify?.(message, "info");
				void refreshWidget(ctx);
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
