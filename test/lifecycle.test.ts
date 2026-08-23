import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLifecycle } from '../lifecycle.ts';
test('registerLifecycle installs crew command and tools',()=>{const commands:any[]=[];const tools:any[]=[];registerLifecycle({registerCommand:(n:any,c:any)=>commands.push(n),registerTool:(t:any)=>tools.push(t)},{channel:()=>undefined,liveSessions:async()=>[]});assert.deepEqual(commands,['crew']);assert.deepEqual(tools.map(x=>x.name),['checkpoint','consult']);});
