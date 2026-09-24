import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import memory from '../src/index.ts';
import { resolveProject } from '../src/project.ts';
import { writeProjectActivation } from '../src/config.ts';

const root = mkdtempSync(join(tmpdir(),'pi-memory-lifecycle-'));
process.env.PI_CODING_AGENT_DIR = root;

async function until(predicate) {
  for (let attempt=0; attempt<100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve,10));
  }
  throw new Error('worker did not complete');
}

test('opt-in lifecycle extracts and consolidates with distinct isolated provider requests; off removes injection', async () => {
  // arrange
  const project = resolveProject(root);
  writeProjectActivation(root,project,true);
  writeFileSync(join(root,'memory.json'), JSON.stringify({ extractionModel:'fake/extract',consolidationModel:'fake/consolidate' }));
  const handlers = new Map(), commands = new Map(), tools = new Map();
  let activeTools = ['read'];
  const pi = { on:(name,handler)=>handlers.set(name,handler),registerCommand:(name,options)=>commands.set(name,options),registerTool:tool=>tools.set(tool.name,tool),getActiveTools:()=>activeTools,setActiveTools:names=>{activeTools=names;} };
  const calls = [];
  const registry = {
    find: (provider,id) => provider === 'fake' ? { id,provider,contextWindow:100000 } : undefined,
    streamSimple: (model,input,options) => {
      calls.push({ model,input,options });
      return { result: async () => ({ stopReason:'stop',usage:{input:100,output:50},content:[{type:'text',text:model.id === 'extract' ? JSON.stringify({ summary:'', claims:[{text:'Use test fixtures',kind:'procedure',evidenceEntryIds:['new-user']}] }) : JSON.stringify({ sections:[{heading:'Procedures',items:[{text:'Use test fixtures',claimIds:[JSON.parse(input.messages[0].content)[0].id]}]}] }) }] }) };
    },
  };
  const header = {type:'session',id:'test-session',timestamp:new Date().toISOString(),cwd:root};
  const old = { type:'message',id:'old-user',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:'old fact',timestamp:Date.now()} };
  const entry = { type:'message',id:'new-user',parentId:'old-user',timestamp:new Date().toISOString(),message:{role:'user',content:'Use test fixtures',timestamp:Date.now()} };
  const branch = [old];
  const file = join(root,'session.jsonl');
  writeFileSync(file,[header,old,entry].map(value=>JSON.stringify(value)).join('\n')+'\n');
  const notices=[];
  const context = { cwd:root,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=>header.id,getSessionFile:()=>file,getLeafId:()=>entry.id,getBranch:()=>branch}, modelRegistry:registry,ui:{ notify:(message)=>notices.push(message) },hasUI:false };
  const intervals=[];
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = (callback) => { const timer={unref(){}}; intervals.push(callback); return timer; };
  try {
    memory(pi);
    await handlers.get('session_start')({},context);
    branch.push(entry);
    handlers.get('agent_settled')({},context);
    const database = new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE jobs SET retry_at=0');
    // act
    intervals[0]();
    await until(() => Number(database.prepare("SELECT count(*) AS count FROM jobs WHERE status='done'").get().count) === 1);
    database.exec('UPDATE state SET changed_at=0');
    intervals[0]();
    await until(() => database.prepare('SELECT active_generation_id AS id FROM state').get().id !== null);
    const injected = handlers.get('context')({messages:[]},context);
    const searched = await tools.get('memory_search').execute('call',{query:'fixtures'},undefined,undefined,context);
    await commands.get('memory').handler('off',context);
    const removed = handlers.get('context')({messages:[]},context);
    // assert
    assert.equal(Number(database.prepare('SELECT count(*) AS count FROM inference_usage').get().count),2);
    assert.equal(calls.length,2);
    assert.deepEqual(calls.map(call=>call.model.id),['extract','consolidate']);
    assert.equal(calls[0].input.messages[0].content.includes('old fact'),false);
    assert.ok(calls.every(call=>call.input.tools.length === 0 && call.options.sessionId.startsWith('memory-')));
    assert.notEqual(calls[0].options.sessionId,calls[1].options.sessionId);
    assert.match(injected.messages.at(-1).content,/Use test fixtures/);
    assert.match(searched.content[0].text,/fixtures/);
    assert.equal(removed,undefined);
    assert.deepEqual(activeTools,['read']);
    database.close();
  } finally {
    handlers.get('session_shutdown')?.({},context);
    globalThis.setInterval = originalInterval;
  }
});

test.after(()=>rmSync(root,{recursive:true,force:true}));
