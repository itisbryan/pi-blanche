import { execFile } from "node:child_process";
import type { AgentProfile, Board, Role } from "./types.ts";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export function buildRoleCommand(input: {
	role: Role;
	taskId: string;
	sessionName: string;
	profile: AgentProfile;
	extensions?: string[];
}): string {
	return [
		`BLANCHE_ROLE=${shellQuote(input.role)}`,
		`BLANCHE_TASK=${shellQuote(input.taskId)}`,
		"pi",
		"--name",
		shellQuote(input.sessionName),
		"--model",
		shellQuote(input.profile.model),
		"--thinking",
		shellQuote(input.profile.thinking),
		...(input.extensions ?? []).flatMap((extension) => ["-e", shellQuote(extension)]),
	].join(" ");
}
const crewExtensions = (): string[] =>
	[process.env.BLANCHE_INTERCOM_EXTENSION, process.env.BLANCHE_EXTENSION].filter(Boolean) as string[];
export const runHerdr = (args: string[]): Promise<unknown> =>
	new Promise((resolve, reject) => {
		execFile(process.env.HERDR_BIN ?? "herdr", args, { shell: false }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.trim() || error.message));
				return;
			}
			const lines = stdout.trim().split(/\r?\n/).reverse();
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as unknown;
					resolve(
						parsed && typeof parsed === "object" && "result" in parsed
							? (parsed as { result: unknown }).result
							: parsed,
					);
					return;
				} catch {}
			}
			resolve(stdout.trim());
		});
	});

export function extractPaneId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const pane =
		record.pane && typeof record.pane === "object" ? (record.pane as Record<string, unknown>) : record;
	return ["pane_id", "paneId", "id"].map((key) => pane[key]).find((v): v is string => typeof v === "string");
}

export async function spawnRole(input: {
	role: Role;
	board: Board;
	profile: AgentProfile;
	cwd: string;
	liveSessions: () => Promise<string[]>;
	paneId?: string;
	splitTargetPaneId?: string;
	splitDirection?: "right" | "down";
	splitRatio?: number;
}): Promise<{ sessionName: string; paneId: string }> {
	const taskId = input.board.id;
	const sessionName = `${input.board.prefix}-${taskId}-${input.role}`;
	let id = input.paneId;
	if (!id) {
		const target = input.splitTargetPaneId;
		if (target && input.splitRatio === undefined) throw new Error("Missing planned split ratio.");
		const splitArgs = target
			? [
					"pane",
					"split",
					"--pane",
					target,
					"--direction",
					input.splitDirection ?? "down",
					"--ratio",
					String(input.splitRatio),
					"--no-focus",
				]
			: ["pane", "split", "--current", "--direction", "right", "--cwd", input.cwd];
		const split = await runHerdr(splitArgs);
		id = extractPaneId(split);
	}
	if (!id) throw new Error("Herdr pane split returned no pane id.");
	const command = buildRoleCommand({
		role: input.role,
		taskId,
		sessionName,
		profile: input.profile,
		extensions: crewExtensions(),
	});
	try {
		await runHerdr(["pane", "run", id, command]);
		const deadline = Date.now() + Number(process.env.BLANCHE_REGISTRATION_TIMEOUT_MS ?? 20_000);
		while (Date.now() < deadline) {
			const sessions = await input.liveSessions();
			if (sessions.includes(sessionName)) return { sessionName, paneId: id };
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`Timed out waiting for ${sessionName} to register in pane ${id}.`);
	} catch (error) {
		await runHerdr(["pane", "close", id]).catch(() => undefined);
		throw error;
	}
}
