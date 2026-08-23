import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AgentProfile, BlancheConfig, ResolvedCrew, Role } from "./types.js";
export const DEFAULT_CONFIG_PATH = `${homedir()}/.pi/agent/pi-blanche.json`;
const roles: Role[] = ["leader", "planner", "researcher", "advisor", "worker", "qa", "verifier"];
const rawTexts = new WeakMap<object, string>();
function validate(c: BlancheConfig) {
	for (const [name, w] of Object.entries(c.workflows ?? {})) {
		const p = `workflows.${name}`;
		if (!w.prefix) throw Error(`${p}.prefix`);
		if (!w.roles?.length) throw Error(`${p}.roles`);
		if (!w.phases?.length) throw Error(`${p}.phases`);
		w.phases.forEach((x, i) => {
			if (!roles.includes(x.owner)) throw Error(`${p}.phases[${i}].owner`);
		});
		if (w.advisorAfter !== null && (!Number.isInteger(w.advisorAfter) || w.advisorAfter < 0))
			throw Error(`${p}.advisorAfter`);
		for (const k of ["maxRework", "maxWorkers"] as const)
			if (!Number.isInteger(w[k]) || w[k] < 0) throw Error(`${p}.${k}`);
	}
}
const profile = (model: string, thinking: any): AgentProfile => ({ model, thinking });
const baseAgents: Record<string, AgentProfile> = {
	planner: profile("claude-bridge/claude-opus-5", "high"),
	researcher: profile("openai-codex/gpt-5.6-luna", "medium"),
	advisor: profile("openai-codex/gpt-5.6-luna", "xhigh"),
	worker: profile("claude-bridge/claude-sonnet-5", "low"),
	qa: profile("claude-bridge/claude-sonnet-5", "low"),
	verifier: profile("claude-bridge/claude-opus-5", "high"),
};
const wf = (
	prefix: string,
	roles: Role[],
	names: string[],
	owners: Role[],
	specs: boolean,
	advisorAfter: number | null,
	maxRework: number,
	maxWorkers: number,
) => ({
	prefix,
	roles,
	phases: names.map((name, i) => ({ name, owner: owners[i] })),
	specs,
	advisorAfter,
	maxRework,
	maxWorkers,
});
export const DEFAULT_CONFIG: BlancheConfig = {
	agents: baseAgents,
	context: { softLimit: 0.65 },
	workflows: {
		quick: wf(
			"qk",
			["worker", "qa"],
			["REQUESTED", "IMPLEMENTING", "QA", "DONE"],
			["leader", "worker", "qa", "leader"],
			false,
			null,
			2,
			1,
		),
		fix: wf(
			"fx",
			["researcher", "advisor", "worker", "qa", "verifier"],
			["REQUESTED", "REPRODUCE", "DIAGNOSE", "IMPLEMENTING", "QA", "VERIFY", "DONE"],
			["leader", "worker", "worker", "worker", "qa", "verifier", "leader"],
			false,
			2,
			4,
			1,
		),
		hotfix: wf(
			"hf",
			["advisor", "worker", "qa"],
			["TRIAGE", "IMPLEMENTING", "TARGETED_QA", "LEADER_REVIEW", "DONE"],
			["leader", "worker", "qa", "leader", "leader"],
			false,
			1,
			2,
			1,
		),
		feat: wf(
			"mb",
			["planner", "researcher", "advisor", "worker", "qa", "verifier"],
			["REQUESTED", "DISCOVERY", "PLANNING", "PLAN_REVIEW", "IMPLEMENTING", "QA", "VERIFY", "DONE"],
			["leader", "planner", "planner", "leader", "worker", "qa", "verifier", "leader"],
			true,
			2,
			3,
			1,
		),
		refactor: wf(
			"rf",
			["planner", "advisor", "worker", "qa", "verifier"],
			["REQUESTED", "BASELINE", "PLANNING", "IMPLEMENTING", "REGRESSION_QA", "VERIFY", "DONE"],
			["leader", "qa", "planner", "worker", "qa", "verifier", "leader"],
			true,
			2,
			3,
			1,
		),
		investigate: wf(
			"iv",
			["researcher", "advisor"],
			["REQUESTED", "INVESTIGATING", "REPORT", "DONE"],
			["leader", "researcher", "researcher", "leader"],
			false,
			null,
			0,
			0,
		),
		review: wf(
			"rv",
			["qa", "verifier", "advisor"],
			["REQUESTED", "QA", "VERIFY", "DONE"],
			["leader", "qa", "verifier", "leader"],
			false,
			null,
			0,
			0,
		),
	},
};
export function loadConfig(path = DEFAULT_CONFIG_PATH): BlancheConfig {
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		const raw = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
		writeFileSync(path, raw);
		rawTexts.set(DEFAULT_CONFIG, raw);
		return DEFAULT_CONFIG;
	}
	const raw = readFileSync(path, "utf8"),
		cfg = JSON.parse(raw) as BlancheConfig;
	validate(cfg);
	rawTexts.set(cfg, raw);
	return cfg;
}
export function resolveCrew(cfg: BlancheConfig, workflow: string): ResolvedCrew {
	const w = cfg.workflows[workflow];
	if (!w)
		throw Error(`Unknown workflow '${workflow}'. Known workflows: ${Object.keys(cfg.workflows).join(", ")}`);
	const roster = w.roles.filter((r) => r !== "leader"),
		all = { ...cfg.agents, ...(w.agents ?? {}) };
	return {
		workflow,
		prefix: w.prefix,
		roster,
		agents: Object.fromEntries(
			roster.map((r) => {
				const profile = all[r];
				if (!profile) throw Error(`agents.${r} is missing`);
				return [r, profile];
			}),
		),
		phases: w.phases,
		specs: w.specs,
		advisorAfter: w.advisorAfter,
		maxRework: w.maxRework,
		maxWorkers: w.maxWorkers,
		configRevision: createHash("sha256")
			.update(rawTexts.get(cfg) ?? JSON.stringify(cfg))
			.digest("hex"),
	};
}
export function phaseOwner(crew: ResolvedCrew, phase: string): Role | undefined {
	return crew.phases.find((p) => p.name === phase)?.owner;
}
export function serviceRoles(crew: ResolvedCrew): Role[] {
	return crew.roster.filter((r) => !crew.phases.some((p) => p.owner === r));
}
