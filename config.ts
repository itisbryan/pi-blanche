import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AgentProfile, BlancheConfig, ResolvedCrew, Role } from "./types.js";

export const DEFAULT_CONFIG_PATH = `${homedir()}/.pi/agent/pi-blanche.json`;
const roles: Role[] = ["leader", "planner", "researcher", "advisor", "worker", "qa", "verifier"];
const baseAgents: Record<string, AgentProfile> = {
  planner:{model:"claude-bridge/claude-opus-5",thinking:"high"}, researcher:{model:"openai-codex/gpt-5.6-luna",thinking:"medium"}, advisor:{model:"openai-codex/gpt-5.6-luna",thinking:"xhigh"}, worker:{model:"claude-bridge/claude-sonnet-5",thinking:"low"}, qa:{model:"claude-bridge/claude-sonnet-5",thinking:"low"}, verifier:{model:"claude-bridge/claude-opus-5",thinking:"high"}
};
const phases = (names: string[], owner: Role[]) => names.map((name,i)=>({name,owner:owner[i]}));
export const DEFAULT_CONFIG: BlancheConfig = { agents: baseAgents, context:{softLimit:.65}, workflows:{
 quick:{prefix:"qk",roles:["worker","qa"],phases:phases(["REQUESTED","IMPLEMENTING","QA","DONE"],["leader","worker","qa","leader"]),specs:false,advisorAfter:null,maxRework:2,maxWorkers:1},
 fix:{prefix:"fx",roles:["researcher","advisor","worker","qa","verifier"],phases:phases(["REQUESTED","REPRODUCE","DIAGNOSE","IMPLEMENTING","QA","VERIFY","DONE"],["leader","worker","worker","worker","qa","verifier","leader"]),specs:false,advisorAfter:2,maxRework:4,maxWorkers:1},
 hotfix:{prefix:"hf",roles:["advisor","worker","qa"],phases:phases(["TRIAGE","IMPLEMENTING","TARGETED_QA","LEADER_REVIEW","DONE"],["leader","worker","qa","leader","leader"]),specs:false,advisorAfter:1,maxRework:2,maxWorkers:1},
 feat:{prefix:"mb",roles:["planner","researcher","advisor","worker","qa","verifier"],phases:phases(["REQUESTED","DISCOVERY","PLANNING","PLAN_REVIEW","IMPLEMENTING","QA","VERIFY","DONE"],["leader","planner","planner","leader","worker","qa","verifier","leader"]),specs:true,advisorAfter:2,maxRework:3,maxWorkers:1},
 refactor:{prefix:"rf",roles:["planner","advisor","worker","qa","verifier"],phases:phases(["REQUESTED","BASELINE","PLANNING","IMPLEMENTING","REGRESSION_QA","VERIFY","DONE"],["leader","qa","planner","worker","qa","verifier","leader"]),specs:true,advisorAfter:2,maxRework:3,maxWorkers:1},
 investigate:{prefix:"iv",roles:["researcher","advisor"],phases:phases(["REQUESTED","INVESTIGATING","REPORT","DONE"],["leader","researcher","researcher","leader"]),specs:false,advisorAfter:null,maxRework:0,maxWorkers:0},
 review:{prefix:"rv",roles:["qa","verifier","advisor"],phases:phases(["REQUESTED","QA","VERIFY","DONE"],["leader","qa","verifier","leader"]),specs:false,advisorAfter:null,maxRework:0,maxWorkers:0}
}};
export function loadConfig(path = DEFAULT_CONFIG_PATH): BlancheConfig {
  if (!existsSync(path)) { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path, JSON.stringify(DEFAULT_CONFIG,null,2)+"\n"); return DEFAULT_CONFIG; }
  return JSON.parse(readFileSync(path,"utf8"));
}
export function resolveCrew(cfg: BlancheConfig, workflow: string): ResolvedCrew {
  const w=cfg.workflows[workflow]; if(!w) throw new Error(`Unknown workflow '${workflow}'. Known workflows: ${Object.keys(cfg.workflows).join(", ")}`);
  const agents={...cfg.agents,...(w.agents??{})};
  const roster=w.roles.filter(r=>r!=="leader");
  return {workflow,prefix:w.prefix,roster,agents,phases:w.phases,specs:w.specs,advisorAfter:w.advisorAfter,maxRework:w.maxRework,maxWorkers:w.maxWorkers,configRevision:createHash("sha256").update(JSON.stringify(cfg)).digest("hex")};
}
export function phaseOwner(crew: ResolvedCrew, phase: string): Role|undefined { return crew.phases.find(p=>p.name===phase)?.owner; }
export function serviceRoles(crew: ResolvedCrew): Role[] { return crew.roster.filter(r=>!crew.phases.some(p=>p.owner===r)); }
