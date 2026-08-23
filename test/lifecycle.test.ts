import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join("/tmp", "blanche-lifecycle-home-"));

const { createTask, readBoard, writeBoard, taskDir } = await import("../board.ts");
const { registerLifecycle } = await import("../lifecycle.ts");
const { default: blancheExtension } = await import("../index.ts");

const resolved = () => ({
  workflow: "feat",
  prefix: "mb",
  roster: ["worker", "qa"],
  agents: {
    worker: { model: "worker-model", thinking: "low" },
    qa: { model: "qa-model", thinking: "low" },
  },
  phases: [
    { name: "IMPLEMENTING", owner: "worker" },
    { name: "QA", owner: "qa" },
  ],
  specs: true,
  advisorAfter: 2,
  maxRework: 3,
  maxWorkers: 1,
  configRevision: "persisted-revision",
});

type SeedOptions = {
  status?: "active" | "stopped" | "blocked" | "done";
  phase?: string;
  owner?: "leader" | "worker" | "qa";
  currentSpec?: string;
  specs?: Record<string, any>;
  sessions?: Record<string, any>;
  history?: any[];
};

function seed(id: string, options: SeedOptions = {}) {
  const board = createTask({
    id,
    workflow: "feat",
    prefix: "mb",
    cwd: process.cwd(),
    title: id,
    description: "durability requirement",
    resolved: resolved(),
    phase: options.phase ?? "QA",
    owner: options.owner ?? "qa",
    specs: options.specs ?? {
      s02: { status: "implementing", path: "spec.md", dependsOn: [], reworkRound: 2, lastAdvisorConsultedRound: null },
    },
  });
  board.status = options.status ?? "active";
  board.currentSpec = options.currentSpec ?? "s02";
  board.sessions = options.sessions ?? {
    worker: { sessionName: `${id}-worker`, contextEpoch: 2 },
    qa: { sessionName: `${id}-qa`, contextEpoch: 1 },
  };
  board.history = options.history ?? [];
  writeBoard(board);
  return readBoard(id);
}

function harness(live: string[] = []) {
  const tools: Record<string, any> = {};
  const published: any[] = [];
  const pi = {
    registerTool: (tool: any) => { tools[tool.name] = tool; },
  };
  const lifecycle = registerLifecycle(pi, {
    channel: () => ({ publish: (payload: unknown) => published.push(payload) }),
    liveSessions: async () => live,
  });
  assert.equal(typeof lifecycle.handleAction, "function");
  const command = (args: string) => {
    const [action, idArg] = args.trim().split(/\s+/);
    return lifecycle.handleAction(action, idArg);
  };
  return { command, tools, published };
}

function setSession(id: string, role = "worker") {
  process.env.BLANCHE_TASK = id;
  process.env.BLANCHE_ROLE = role;
}

function handoff(overrides: Record<string, unknown> = {}) {
  return {
    handoffId: "h-1",
    from: "qa",
    to: "worker",
    spec: "s02",
    phase: "IMPLEMENTING",
    verdict: "PASS",
    sentAt: 1,
    ...overrides,
  };
}

test("resume with all sessions live spawns nothing and reactivates the task", async () => {
  const id = "resume-live";
  const before = seed(id, { status: "stopped" });
  const h = harness([`${id}-worker`, `${id}-qa`]);
  const oldHerdr = process.env.HERDR_BIN;
  process.env.HERDR_BIN = "/path/that-must-not-be-called";
  try {
    const resumed: any = await h.command(`resume ${id}`);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.phase, before.phase);
    assert.equal(resumed.owner, before.owner);
    assert.equal(readBoard(id).revision, before.revision + 1);
    assert.deepEqual(h.published, []);
  } finally {
    if (oldHerdr === undefined) delete process.env.HERDR_BIN;
    else process.env.HERDR_BIN = oldHerdr;
  }
});

test("resume republishes an unacked final handoff but not an acked one", async () => {
  const unacked = seed("resume-unacked", { history: [handoff()] });
  const hu = harness(["resume-unacked-worker", "resume-unacked-qa"]);
  await hu.command("resume resume-unacked");
  assert.equal(hu.published.length, 1);
  assert.equal(hu.published[0].handoffId, "h-1");
  assert.equal(hu.published[0].taskId, "resume-unacked");

  seed("resume-acked", { history: [handoff({ handoffId: "h-acked", ackedAt: 99 })] });
  const ha = harness(["resume-acked-worker", "resume-acked-qa"]);
  await ha.command("resume resume-acked");
  assert.deepEqual(ha.published, []);
  assert.equal(readBoard("resume-unacked").revision, unacked.revision + 1);
});

test("resume replays the persisted resolved snapshot after config changes", async () => {
  const id = "resume-snapshot";
  const before = seed(id);
  const configPath = join(homedir(), ".pi", "agent", "pi-blanche.json");
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ workflows: { feat: { prefix: "changed" } } }));

  const h = harness([`${id}-worker`, `${id}-qa`]);
  const resumed: any = await h.command(`resume ${id}`);
  assert.deepEqual(resumed.resolved, before.resolved);
  assert.equal(resumed.resolved.prefix, "mb");
});

test("resume with an unknown id names the task and existing ids", async () => {
  seed("known-task");
  const h = harness();
  await assert.rejects(() => h.command("resume missing-task"), /missing-task.*known-task/s);
});

test("checkpoint writes the file, records its path, and bumps revision once", async () => {
  const id = "checkpoint";
  const before = seed(id);
  setSession(id, "worker");
  const h = harness();
  const result: any = await h.tools.checkpoint.execute("call", { completed: ["persisted fact"] });
  const after = readBoard(id);
  const path = result.content[0].text as string;
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.sessions.worker?.latestCheckpoint, `checkpoints/${path.split("/").pop()}`);
  assert.equal(existsSync(path), true);
  assert.match(readFileSync(path, "utf8"), /persisted fact/);
});

test("consult persists a record and leaves phase, owner, and currentSpec unchanged", async () => {
  const id = "consult";
  const before = seed(id);
  setSession(id, "worker");
  const h = harness();
  const result: any = await h.tools.consult.execute("call", {
    role: "advisor",
    requestedBy: "worker",
    question: "why did this fail?",
    context: "qa evidence",
    answer: "use the persisted fixture",
  });
  const after = readBoard(id);
  assert.deepEqual(
    { phase: after.phase, owner: after.owner, currentSpec: after.currentSpec },
    { phase: before.phase, owner: before.owner, currentSpec: before.currentSpec },
  );
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.consultations.length, 1);
  const record = after.consultations[0];
  assert.equal(record.role, "advisor");
  assert.equal(record.requestedBy, "worker");
  assert.equal(record.spec, "s02");
  assert.equal(record.reworkRound, 2);
  assert.equal(after.specs.s02.lastAdvisorConsultedRound, 2);
  assert.equal(record.summaryPath, result.content[0].text);
  assert.match(record.summaryPath, /^consultations\/c-/);
  assert.equal(readFileSync(join(taskDir(id), record.summaryPath), "utf8"), "use the persisted fixture");
});

test("consult rejects an empty answer without changing the advisor round", async () => {
  const id = "consult-empty";
  const before = seed(id);
  setSession(id, "worker");
  const h = harness();
  await assert.rejects(() => h.tools.consult.execute("call", {
    role: "advisor", requestedBy: "worker", answer: "   ", question: "still waiting",
  }), /answer must not be empty/);
  const after = readBoard(id);
  assert.equal(after.revision, before.revision);
  assert.equal(after.consultations.length, 0);
  assert.equal(after.specs.s02.lastAdvisorConsultedRound, null);
});

test("stop preserves phase, owner, and spec; stopping again is a no-op", async () => {
  const id = "stop";
  const before = seed(id, { phase: "QA", owner: "qa", currentSpec: "s02" });
  setSession(id);
  const h = harness();
  const stopped: any = await h.command("stop");
  assert.equal(stopped.status, "stopped");
  const after = readBoard(id);
  assert.equal(after.phase, before.phase);
  assert.equal(after.owner, before.owner);
  assert.equal(after.currentSpec, before.currentSpec);
  const revision = after.revision;
  await h.command("stop");
  assert.equal(readBoard(id).revision, revision);
});

test("clean on an unknown id errors without deleting an existing task", async () => {
  const id = "clean-known";
  seed(id);
  const h = harness();
  await assert.rejects(() => h.command("clean missing-clean"), /missing-clean/);
  assert.equal(existsSync(taskDir(id)), true);
});

test("resume, stop, and clean are reachable through the one /crew command", async () => {
  const resumeId = "route-resume";
  seed(resumeId, { status: "stopped" });
  const stopId = "route-stop";
  seed(stopId, { status: "active" });
  const cleanId = "route-clean";
  seed(cleanId, { sessions: { worker: { sessionName: "w", paneId: "pane-w", contextEpoch: 0 } } });

  const commandNames: string[] = [];
  let command: ((raw: string, ctx?: any) => Promise<unknown>) | undefined;
  const channel = {
    listSessions: async () => [
      { name: `${resumeId}-worker` },
      { name: `${resumeId}-qa` },
    ],
    publish: () => undefined,
  };
  const oldHerdr = process.env.HERDR_BIN;
  process.env.HERDR_BIN = "true";
  try {
    const pi: any = {
      on: () => undefined,
      registerCommand: (name: string, spec: any) => { commandNames.push(name); command = spec.handler; },
      registerTool: () => undefined,
      events: { emit: (_name: string, registration: any) => registration.onReady(channel) },
    };
    blancheExtension(pi);
    assert.deepEqual(commandNames, ["crew"]);
    assert.ok(command);
    await command!("resume route-resume");
    assert.equal(readBoard(resumeId).status, "active");
    setSession(stopId);
    await command!("stop");
    assert.equal(readBoard(stopId).status, "stopped");
    await command!("clean route-clean");
    assert.equal(existsSync(taskDir(cleanId)), false);
  } finally {
    if (oldHerdr === undefined) delete process.env.HERDR_BIN;
    else process.env.HERDR_BIN = oldHerdr;
  }
});

test("concurrent checkpoint-style and handoff mutations both survive updateBoard", async () => {
  const id = "concurrent-mutations";
  seed(id);
  const childPath = join(process.env.HOME!, "update-board-child.ts");
  writeFileSync(childPath, `
    import { updateBoard } from ${JSON.stringify(join(process.cwd(), "board.ts"))};
    const [taskId, mode] = process.argv.slice(-2);
    updateBoard(taskId, (board) => {
      if (mode === "handoff") {
        board.history.push({ handoffId: "concurrent-handoff", from: "qa", to: "worker", phase: "IMPLEMENTING", verdict: "PASS", sentAt: 1 });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      } else {
        board.sessions.worker.latestCheckpoint = "checkpoints/concurrent-worker-e1.md";
      }
    });
  `);
  const cli = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const run = (mode: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, childPath, id, mode], { env: { ...process.env, HOME: process.env.HOME } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
  try {
    const first = run("handoff");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = run("checkpoint");
    await Promise.all([first, second]);
  } finally {
    rmSync(childPath, { force: true });
  }
  const after = readBoard(id);
  assert.equal(after.history.some((entry) => entry.handoffId === "concurrent-handoff"), true);
  assert.equal(after.sessions.worker?.latestCheckpoint, "checkpoints/concurrent-worker-e1.md");
});

test("clean deletes only the task directory, including recorded panes", async () => {
  const id = "clean-target";
  seed(id, { sessions: { worker: { sessionName: "w", paneId: "pane-w", contextEpoch: 0 } } });
  const outside = "clean-outside";
  seed(outside);
  const oldHerdr = process.env.HERDR_BIN;
  process.env.HERDR_BIN = "true";
  try {
    const h = harness();
    const result = await h.command(`clean ${id}`);
    assert.deepEqual(result, { ok: true });
    assert.equal(existsSync(taskDir(id)), false);
    assert.equal(existsSync(taskDir(outside)), true);
  } finally {
    if (oldHerdr === undefined) delete process.env.HERDR_BIN;
    else process.env.HERDR_BIN = oldHerdr;
  }
});
