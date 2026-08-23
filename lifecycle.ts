import { rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { readBoard, writeBoard, commitBoard, listTasks, taskDir, writeCheckpoint, writeConsultation } from "./board.ts";
import { spawnRole } from "./spawn.ts";
import type { Board, CheckpointInput, Role } from "./types.ts";

type Deps={channel:()=>any;liveSessions:()=>Promise<string[]>};
const closePane=(id:string)=>new Promise<void>(resolve=>execFile(process.env.HERDR_BIN??"herdr",["pane","close",id],()=>resolve()));
function current(pi:any){const id=process.env.BLANCHE_TASK;if(!id)throw Error("Not in a Blanche crew session.");return readBoard(id);}
export function registerLifecycle(pi:any,deps:Deps):void {
  pi.registerCommand?.("crew",{description:"Manage a Blanche crew.",handler:async(args:string)=>{const [action,idArg]=String(args??"").trim().split(/\s+/);
    if(action==="resume"){const id=idArg??listTasks(process.cwd())[0]?.id;if(!id){throw Error(`No task found. Existing tasks: ${listTasks().map(x=>x.id).join(", ")}`);}let b:Board;try{b=readBoard(id);}catch{throw Error(`Unknown task '${id}'. Existing tasks: ${listTasks().map(x=>x.id).join(", ")}`);}const live=await deps.liveSessions();for(const role of b.resolved.roster){const s=b.sessions[role];if(!s||!live.includes(s.sessionName)){const spawned=await spawnRole({role,board:b,profile:b.resolved.agents[role],cwd:b.cwd});b.sessions[role]={...(s??{contextEpoch:0}),...spawned};}}b.status="active";writeBoard(b);const last=b.history.at(-1);if(last&&!last.ackedAt)deps.channel()?.publish({type:"handoff",handoffId:last.handoffId,taskId:b.id,to:last.to});return b;}
    if(action==="stop"){const b=current(pi);if(b.status!=="stopped"){b.status="stopped";writeBoard(b);}return b;}
    if(action==="clean"){const id=idArg??process.env.BLANCHE_TASK;if(!id)throw Error("Task id is required");let b:Board;try{b=readBoard(id);}catch{throw Error(`Unknown task '${id}'. Existing tasks: ${listTasks().map(x=>x.id).join(", ")}`);}for(const s of Object.values(b.sessions))if(s?.paneId)await closePane(s.paneId);rmSync(taskDir(id),{recursive:true,force:true});return {ok:true};}
    throw Error(`Unknown crew action '${action??""}'`);
  }});
  pi.registerTool?.({name:"checkpoint",description:"Persist a crew checkpoint.",parameters:{},execute:async(_id:string,input:CheckpointInput)=>{const b=current(pi),role=process.env.BLANCHE_ROLE as Role;if(!role)throw Error("Role is required");const s=b.sessions[role];const path=writeCheckpoint(b,role,b.currentSpec,s?.contextEpoch??0,input);if(s)s.latestCheckpoint=path;writeBoard(b);return {content:[{type:"text",text:path}]};}});
  pi.registerTool?.({name:"consult",description:"Request a consultation.",parameters:{},execute:async(_id:string,input:any)=>{const b=current(pi),from=process.env.BLANCHE_ROLE as Role,role=input.role as Role;if(role!=="researcher"&&role!=="advisor")throw Error("Consult role must be researcher or advisor");const id=crypto.randomUUID(),path=`c-${id}.md`;const rec={id,role,requestedBy:from,spec:b.currentSpec,reworkRound:b.currentSpec?b.specs[b.currentSpec]?.reworkRound??0:b.reworkRound,summaryPath:path};deps.channel()?.publish({type:"consult",taskId:b.id,consultationId:id,role,question:input.question,context:input.context});const file=writeConsultation(b,rec,input.answer??"");rec.summaryPath=file;b.consultations.push(rec); if(b.currentSpec&&b.specs[b.currentSpec])b.specs[b.currentSpec].lastAdvisorConsultedRound=rec.reworkRound;else b.lastAdvisorConsultedRound=rec.reworkRound;writeBoard(b);return {content:[{type:"text",text:file}]};}});
}
