import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import type { Board, CheckpointInput, ConsultationRecord, Role } from "./types.js";
export const taskRoot = (cwd = join(homedir(), ".pi/agent/pi-blanche/tasks")) => cwd;
// The leader's session is not spawned by pi-blanche, so it has no BLANCHE_*
// env. Without these fallbacks the operator can never make the first handoff:
// the crew spawns, the task sits in REQUESTED owned by leader, and nothing
// starts. Resolve here so every call site agrees.
export const currentRole = (): Role => (process.env.BLANCHE_ROLE as Role) ?? "leader";

const SESSION_PREFIXES = Object.values(DEFAULT_CONFIG.workflows).map((workflow) => workflow.prefix);
const SESSION_ROLES = ["leader", ...Object.keys(DEFAULT_CONFIG.agents)] as Role[];
if (
	SESSION_PREFIXES.some((value) => value.includes("-")) ||
	SESSION_ROLES.some((value) => value.includes("-"))
) {
	throw new Error("Session prefixes and roles must not contain dashes");
}
export function taskIdFromSessionName(name?: string): string | undefined {
	if (!name) return undefined;
	const parts = name.split("-");
	if (
		parts.length < 3 ||
		!SESSION_PREFIXES.includes(parts[0]) ||
		!SESSION_ROLES.includes(parts.at(-1)! as Role)
	)
		return undefined;
	return parts.slice(1, -1).join("-");
}
export const currentTaskId = (cwd = process.cwd(), sessionName?: string): string | undefined => {
	if (process.env.BLANCHE_TASK) return process.env.BLANCHE_TASK;
	const named = taskIdFromSessionName(sessionName);
	if (named && existsSync(join(taskDir(named), "board.json"))) return named;
	const candidates = listTasks(cwd);
	return candidates.length === 1 ? candidates[0]?.id : undefined;
};
export const requireTaskId = (cwd = process.cwd(), sessionName?: string): string => {
	const id = currentTaskId(cwd, sessionName);
	if (id) return id;
	const candidates = listTasks(cwd);
	if (!candidates.length) throw new Error("No Blanche task found; pass one explicitly: /crew <action> <id>.");
	throw new Error(
		`Multiple tasks in this directory: ${candidates.map((task) => task.id).join(", ")}. Pass one explicitly: /crew <action> <id>.`,
	);
};

export function taskDir(id: string) {
	return join(taskRoot(), id);
}
const atomic = (path: string, data: string) => {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
};
export function createTask(input: any): Board {
	const id = input.id;
	const dir = taskDir(id);
	mkdirSync(join(dir, "specs"), { recursive: true });
	mkdirSync(join(dir, "checkpoints"), { recursive: true });
	mkdirSync(join(dir, "consultations"), { recursive: true });
	writeFileSync(join(dir, "task.md"), input.description ?? "");
	const board: Board = {
		id,
		workflow: input.workflow,
		prefix: input.prefix ?? input.resolved?.prefix ?? "",
		cwd: input.cwd ?? process.cwd(),
		status: "active",
		phase: input.phase ?? "REQUESTED",
		owner: input.owner ?? "leader",
		revision: 0,
		task: { title: input.title ?? id, descriptionPath: "task.md" },
		specs: input.specs ?? {},
		consultations: [],
		leader: input.leader ?? { sessionName: "leader" },
		resolved: input.resolved,
		sessions: {},
		reworkRound: 0,
		lastAdvisorConsultedRound: null,
		history: [],
	};
	atomic(join(dir, "board.json"), JSON.stringify(board, null, 2));
	return board;
}
export function readBoard(id: string) {
	return JSON.parse(readFileSync(join(taskDir(id), "board.json"), "utf8")) as Board;
}
export function writeBoard(board: Board) {
	board.revision++;
	atomic(join(taskDir(board.id), "board.json"), JSON.stringify(board, null, 2));
}
export function updateBoard(id: string, mutate: (b: Board) => void): Board {
	const lock = join(taskDir(id), "board.json.lock");
	const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	for (let i = 0; i < 20; i++) {
		try {
			// ponytail: stale-break races — two processes recovering from one crashed holder can both rmSync then both mkdir. Upgrade path: O_EXCL lock file holding the owner pid, verified before breaking.
			if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 5000)
				rmSync(lock, { recursive: true, force: true });
			mkdirSync(lock);
		} catch {
			sleep();
			continue;
		}
		try {
			const b = readBoard(id);
			mutate(b);
			writeBoard(b);
			return b;
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	}
	throw Error("Board is busy; retry");
}

export function listTasks(cwd?: string) {
	if (!existsSync(taskRoot())) return [];
	const norm = (p: string) => {
		const r = resolve(p);
		try {
			return realpathSync(r);
		} catch {
			return r;
		}
	};
	const wanted = cwd && norm(cwd);
	return readdirSync(taskRoot(), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => {
			try {
				const b = readBoard(e.name);
				return { b, mtime: statSync(join(taskDir(e.name), "board.json")).mtimeMs };
			} catch {
				return null;
			}
		})
		.filter((x): x is { b: Board; mtime: number } => !!x && (!wanted || norm(x.b.cwd) === wanted))
		.sort((a, b) => b.mtime - a.mtime)
		.map((x) => x.b);
}
export function writeCheckpoint(
	board: Board,
	role: Role,
	spec: string | undefined,
	epoch: number,
	input: CheckpointInput,
) {
	const name = `${spec ?? "task"}-${role}-e${epoch}.md`,
		path = join(taskDir(board.id), "checkpoints", name);
	const sections: [string, string | undefined][] = [
		["Completed", input.completed?.join("\n")],
		["Decisions", input.decisions?.join("\n")],
		[
			"Failed approaches",
			input.failedApproaches?.map((x) => `${x.approach}: ${x.result} (${x.whyItFailed})`).join("\n"),
		],
		["Current failures", input.currentFailures?.join("\n")],
		["Validation", input.validation?.join("\n")],
		["Files changed", input.filesChanged?.join("\n")],
		["Remaining", input.remaining?.join("\n")],
		["Next action", input.nextAction],
	];
	writeFileSync(
		path,
		`${sections
			.filter(([, v]) => v)
			.map(([k, v]) => `## ${k}\n${v}`)
			.join("\n\n")}\n`,
	);
	return path;
}
export function writeConsultation(board: Board, rec: ConsultationRecord, body: string) {
	const path = join(taskDir(board.id), rec.summaryPath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body);
	return rec.summaryPath;
}
