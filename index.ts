import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCrewBlock } from "./inject.ts";
import { spawnRole } from "./spawn.ts";
import { readBoard, commitBoard, writeCheckpoint, writeConsultation } from "./board.ts";
import { decideHandoff } from "./handoff.ts";
import type { Board, Role } from "./types.ts";

const namespace = "blanche/v1";

export default function blancheExtension(pi: any): void {
  let channel: any;
  const sessions: Partial<Record<Role, { contextEpoch: number }>> = {};
  const role = (): Role | undefined => process.env.BLANCHE_ROLE as Role | undefined;
  const board = (): Board | undefined => {
    const id = process.env.BLANCHE_TASK;
    if (!id) return undefined;
    try { return readBoard(id); } catch { return undefined; }
  };

  pi.on("before_agent_start", async () => {
    const currentRole = role();
    const currentBoard = board();
    if (!currentRole || !currentBoard) return;
    const state = currentBoard.sessions[currentRole];
    const rolePrompt = readFileSync(resolve(import.meta.dirname, "roles", `${currentRole}.md`), "utf8");
    const specBody = currentBoard.currentSpec && currentBoard.specs[currentBoard.currentSpec]?.path
      ? readFileSync(currentBoard.specs[currentBoard.currentSpec].path, "utf8") : undefined;
    return { systemPrompt: buildCrewBlock({
      role: currentRole, board: currentBoard, softLimit: 0.8,
      specBody, checkpoint: state?.latestCheckpoint, peers: Object.values(currentBoard.sessions).map((s) => s?.sessionName).filter(Boolean) as string[],
      rolePrompt,
    }) };
  });
  pi.on("session_compact", () => {
    const currentRole = role();
    if (currentRole) sessions[currentRole] = { contextEpoch: (sessions[currentRole]?.contextEpoch ?? 0) + 1 };
  });
  pi.events?.emit?.("intercom:extension-register", {
    namespace, ownerEligible: true,
    onEvent: (event: any) => { if (event.type === "state" && event.state?.payload) channel = channel ?? undefined; },
    onReady: (ready: any) => { channel = ready; },
  });

  pi.registerTool?.({ name: "handoff", description: "Hand off the current crew task.", parameters: {}, execute: async (_id: string, input: any) => {
    const currentBoard = board(); const from = role();
    if (!currentBoard || !from) throw new Error("Not running in a Blanche crew session.");
    const live = channel ? (await channel.listSessions()).map((s: any) => s.name) : [];
    const decision = decideHandoff({ ...input, board: currentBoard, from, liveSessions: live, now: Date.now(), handoffId: crypto.randomUUID() });
    if (!decision.ok) throw new Error(decision.error);
    const committed = commitBoard(decision.board, currentBoard.revision);
    if (!committed.ok) throw new Error("Board changed concurrently; retry handoff.");
    channel?.publish({ type: "handoff", handoffId: decision.board.history.at(-1)?.handoffId, taskId: currentBoard.id, to: input.to });
    return { content: [{ type: "text", text: "Handoff sent." }] };
  }});
  pi.registerTool?.({ name: "checkpoint", description: "Persist a crew checkpoint.", parameters: {}, execute: async (_id: string, input: any) => {
    const currentBoard = board(); const from = role(); if (!currentBoard || !from) throw new Error("Not in a crew session.");
    const path = writeCheckpoint(currentBoard, from, currentBoard.currentSpec, sessions[from]?.contextEpoch ?? 0, input);
    return { content: [{ type: "text", text: path }] };
  }});
  pi.registerTool?.({ name: "consult", description: "Persist an advisor consultation.", parameters: {}, execute: async (_id: string, input: any) => {
    const currentBoard = board(); const from = role(); if (!currentBoard || !from) throw new Error("Not in a crew session.");
    const path = writeConsultation(currentBoard, { id: crypto.randomUUID(), role: "advisor", requestedBy: from, spec: currentBoard.currentSpec, reworkRound: currentBoard.currentSpec ? currentBoard.specs[currentBoard.currentSpec]?.reworkRound ?? 0 : currentBoard.reworkRound, summaryPath: "" }, input.body ?? "");
    return { content: [{ type: "text", text: path }] };
  }});
  pi.registerCommand?.("crew", { description: "Manage a Blanche crew.", handler: async (args: string) => {
    const [action] = args.trim().split(/\s+/);
    if (action === "status") pi.sendMessage?.("Blanche status available in board.json");
    else if (action === "stop") pi.sendMessage?.("Blanche crew stopped.");
    else if (action === "clean" || action === "resume") pi.sendMessage?.(`crew ${action} is not available in this minimal integration`);
    else pi.sendMessage?.(`crew workflow ${action ?? ""} requested`);
  }});
}
