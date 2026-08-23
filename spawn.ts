import { execFile } from "node:child_process";
import type { AgentProfile, Board, Role } from "./types.ts";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const runHerdr = (args: string[]): Promise<unknown> => new Promise((resolve, reject) => {
  execFile(process.env.HERDR_BIN ?? "herdr", args, { shell: false }, (error, stdout, stderr) => {
    if (error) { reject(new Error(stderr.trim() || error.message)); return; }
    const lines = stdout.trim().split(/\r?\n/).reverse();
    for (const line of lines) { try { resolve(JSON.parse(line)); return; } catch {} }
    resolve(stdout.trim());
  });
});

function paneId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const pane = record.pane && typeof record.pane === "object" ? record.pane as Record<string, unknown> : record;
  return ["pane_id", "paneId", "id"].map((key) => pane[key]).find((v): v is string => typeof v === "string");
}

export async function spawnRole(input: {
  role: Role; board: Board; profile: AgentProfile; cwd: string;
}): Promise<{ sessionName: string; paneId: string }> {
  const taskId = input.board.id;
  const sessionName = `${input.board.prefix}-${taskId}-${input.role}`;
  const split = await runHerdr(["pane", "split", "--current", "--direction", "right", "--cwd", input.cwd]);
  const id = paneId(split);
  if (!id) throw new Error("Herdr pane split returned no pane id.");
  const command = [
    "BLANCHE_ROLE=" + shellQuote(input.role),
    "BLANCHE_TASK=" + shellQuote(taskId),
    "pi", "--name", shellQuote(sessionName), "--model", shellQuote(input.profile.model), "--thinking", shellQuote(input.profile.thinking),
  ].join(" ");
  try {
    await runHerdr(["pane", "run", id, command]);
    const deadline = Date.now() + Number(process.env.BLANCHE_REGISTRATION_TIMEOUT_MS ?? 20_000);
    while (Date.now() < deadline) {
      const sessions = await listSessions();
      if (sessions.some((session) => session.name === sessionName)) return { sessionName, paneId: id };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${sessionName} to register in pane ${id}.`);
  } catch (error) {
    await runHerdr(["pane", "close", id]).catch(() => undefined);
    throw error;
  }
}

async function listSessions(): Promise<Array<{ name?: string }>> {
  try {
    const result = await runHerdr(["session", "list", "--json"]);
    if (Array.isArray(result)) return result as Array<{ name?: string }>;
    if (result && typeof result === "object" && Array.isArray((result as any).sessions)) return (result as any).sessions;
  } catch {}
  return [];
}
