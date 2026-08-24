import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	currentRole,
	currentTaskId,
	requireTaskId,
	listTasks,
	readBoard,
	taskDir,
	updateBoard,
	writeCheckpoint,
	writeConsultation,
} from "./board.ts";
import { spawnRole } from "./spawn.ts";
import type { Board, CheckpointInput, Role } from "./types.ts";

type Deps = { channel: () => any; liveSessions: () => Promise<string[]> };
const closePane = (id: string) =>
	new Promise<void>((resolve) =>
		execFile(process.env.HERDR_BIN ?? "herdr", ["pane", "close", id], () => resolve()),
	);
export function registerLifecycle(
	pi: any,
	deps: Deps,
): { handleAction: (action: string, idArg?: string, ctx?: any) => Promise<any> } {
	const handleAction = async (action: string, idArg?: string) => {
		if (action === "resume") {
			const id = idArg ?? listTasks(process.cwd())[0]?.id;
			if (!id)
				throw Error(
					`No task found. Existing tasks: ${listTasks()
						.map((x) => x.id)
						.join(", ")}`,
				);
			let b: Board;
			try {
				b = readBoard(id);
			} catch {
				throw Error(
					`Unknown task '${id}'. Existing tasks: ${listTasks()
						.map((x) => x.id)
						.join(", ")}`,
				);
			}
			const live = await deps.liveSessions();
			const missing = b.resolved.roster.filter(
				(r) => !b.sessions[r] || !live.includes(b.sessions[r]?.sessionName),
			);
			for (const role of missing) {
				const spawned = await spawnRole({
					role,
					board: b,
					profile: b.resolved.agents[role],
					cwd: b.cwd,
					liveSessions: deps.liveSessions,
				});
				updateBoard(id, (x) => {
					x.sessions[role] = { ...(x.sessions[role] ?? { contextEpoch: 0 }), ...spawned };
					x.status = "active";
				});
				b = readBoard(id);
			}
			if (!missing.length)
				updateBoard(id, (x) => {
					x.status = "active";
				});
			b = readBoard(id);
			const last = b.history.at(-1);
			if (last && !last.ackedAt)
				deps.channel()?.publish({ type: "handoff", handoffId: last.handoffId, taskId: b.id, to: last.to });
			return b;
		}
		if (action === "stop") {
			const b = readBoard(idArg ?? requireTaskId());
			if (b.status !== "stopped")
				return updateBoard(b.id, (x) => {
					x.status = "stopped";
				});
			return b;
		}
		if (action === "clean") {
			const id = idArg ?? requireTaskId();
			if (!id) throw Error("Task id is required");
			const b = readBoard(id);
			for (const s of Object.values(b.sessions)) if (s?.paneId) await closePane(s.paneId);
			rmSync(taskDir(id), { recursive: true, force: true });
			return { ok: true };
		}
		throw Error(`Unknown crew action '${action}'`);
	};
	pi.registerTool?.({
		name: "checkpoint",
		description: "Persist a crew checkpoint.",
		parameters: Type.Object({
			completed: Type.Optional(
				Type.Array(Type.String(), { description: "Work completed since the last checkpoint." }),
			),
			decisions: Type.Optional(
				Type.Array(Type.String(), { description: "Decisions made and their rationale." }),
			),
			failedApproaches: Type.Optional(
				Type.Array(
					Type.Object({
						approach: Type.String({ description: "An approach already tried." }),
						result: Type.String({ description: "What happened when it was tried." }),
						whyItFailed: Type.String({
							description: "Why the approach failed; prevents rediscovering dead ends.",
						}),
					}),
					{
						description:
							"An approach already tried, what happened, and why it failed; the highest-value field for future contexts.",
					},
				),
			),
			currentFailures: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"What is failing right now, verbatim; distinguishes unattempted from attempted and broken.",
				}),
			),
			validation: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"What has actually been proven, such as a targeted spec passing while the full suite was not run.",
				}),
			),
			filesChanged: Type.Optional(
				Type.Array(Type.String(), { description: "Files changed during this work." }),
			),
			remaining: Type.Optional(Type.Array(Type.String(), { description: "Work that remains to be done." })),
			nextAction: Type.Optional(
				Type.String({ description: "The next concrete action for the continuing agent." }),
			),
		}),
		execute: async (_id: string, input: CheckpointInput) => {
			const role = currentRole(),
				b = readBoard(requireTaskId());
			let path = "";
			updateBoard(b.id, (x) => {
				path = writeCheckpoint(x, role, x.currentSpec, x.sessions[role]?.contextEpoch ?? 0, input);
				const s = x.sessions[role];
				if (s) s.latestCheckpoint = `checkpoints/${path.split("/").pop()}`;
			});
			return { content: [{ type: "text", text: path }] };
		},
	});
	pi.registerTool?.({
		name: "consult",
		description: "Record a consultation conclusion.",
		parameters: Type.Object({
			role: StringEnum(["researcher", "advisor"] as const, {
				description: "The role providing the consultation conclusion.",
			}),
			requestedBy: StringEnum(
				["leader", "planner", "researcher", "advisor", "worker", "qa", "verifier"] as const,
				{ description: "The role that requested this conclusion." },
			),
			answer: Type.String({ description: "The distilled conclusion; empty is rejected." }),
			spec: Type.Optional(Type.String({ description: "The spec this conclusion addresses, if any." })),
		}),
		execute: async (_id: string, input: any) => {
			if (!input.answer?.trim()) throw Error("Consultation answer must not be empty");
			const b = readBoard(requireTaskId());
			if (input.role !== "researcher" && input.role !== "advisor")
				throw Error("Consult role must be researcher or advisor");
			const id = crypto.randomUUID();
			const rec: any = {
				id,
				role: input.role,
				requestedBy: input.requestedBy,
				spec: input.spec ?? b.currentSpec,
				reworkRound: b.currentSpec ? (b.specs[b.currentSpec]?.reworkRound ?? 0) : b.reworkRound,
				summaryPath: `consultations/c-${id}.md`,
			};
			deps.channel()?.publish({ type: "consult", taskId: b.id, role: rec.role, question: input.answer });
			updateBoard(b.id, (x) => {
				writeConsultation(x, rec, input.answer);
				x.consultations.push(rec);
				if (rec.spec && x.specs[rec.spec]) x.specs[rec.spec].lastAdvisorConsultedRound = rec.reworkRound;
				else x.lastAdvisorConsultedRound = rec.reworkRound;
			});
			return { content: [{ type: "text", text: rec.summaryPath }] };
		},
	});
	return { handleAction };
}
