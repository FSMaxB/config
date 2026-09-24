import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import memory from '../src/index.ts';
import { resolveProject } from '../src/project.ts';
import { writeProjectActivation } from '../src/config.ts';

test('shutdown cancels an unresponsive provider and fences its completion', async () => {
  // arrange
  const root=mkdtempSync(join(tmpdir(),'memory-abort-'));
  process.env.PI_CODING_AGENT_DIR=root;
  const project=resolveProject(root);
  writeProjectActivation(root,project,true);
  writeFileSync(join(root,'memory.json'),JSON.stringify({extractionModel:'fake/extract',consolidationModel:'fake/consolidate'}));
  const header={type:'session',id:'session',timestamp:new Date().toISOString(),cwd:root};
  const entry={type:'message',id:'entry',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:'fact',timestamp:Date.now()}};
  const file=join(root,'session.jsonl');
  writeFileSync(file,`${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
  const branch=[];
  const hooks=new Map();
  memory({on:(name,handler)=>hooks.set(name,handler),registerTool:()=>{},registerCommand:()=>{},getActiveTools:()=>['read'],setActiveTools:()=>{}});
  let resolveProvider;
  const clock=globalThis.setInterval;
  let workerTick;
  globalThis.setInterval=callback=>{ workerTick ??= callback;return {unref(){}}; };
  const context={cwd:root,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=>header.id,getSessionFile:()=>file,getLeafId:()=>entry.id,getBranch:()=>branch},modelRegistry:{find:(provider,id)=>({provider,id,contextWindow:100000}),streamSimple:()=>({result:()=>new Promise(resolve=>{resolveProvider=resolve;})})},ui:{notify:()=>{}}};
  try {
    await hooks.get('session_start')({},context);
    branch.push(entry);
    hooks.get('agent_settled')({},context);
    const database=new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE jobs SET retry_at=0');
    // act
    workerTick();
    for (let attempt=0;attempt<100 && !resolveProvider;attempt++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(resolveProvider);
    hooks.get('session_shutdown')({},context);
    resolveProvider({stopReason:'stop',content:[{type:'text',text:JSON.stringify({summary:'',claims:[{text:'late fact',kind:'project_fact',evidenceEntryIds:['entry']}]})}]});
    await new Promise(resolve=>setTimeout(resolve,10));
    // assert
    assert.equal(database.prepare('SELECT worker_owner FROM state').get().worker_owner,null);
    assert.equal(Number(database.prepare('SELECT count(*) AS n FROM claims').get().n),0);
    database.close();
  } finally { globalThis.setInterval=clock;rmSync(root,{recursive:true,force:true}); }
});
