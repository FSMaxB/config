import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import memory from '../src/index.ts';
import { resolveProject } from '../src/project.ts';
import { writeProjectActivation } from '../src/config.ts';
import { Store } from '../src/store.ts';

test('observed opt-in IDs survive restart while models are unconfigured', async () => {
  // arrange
  const root=mkdtempSync(join(tmpdir(),'memory-optin-'));
  process.env.PI_CODING_AGENT_DIR=root;
  const project=resolveProject(root);
  writeProjectActivation(root,project,true);
  const hooks=new Map();
  memory({on:(name,handler)=>hooks.set(name,handler),registerTool:()=>{},registerCommand:()=>{},getActiveTools:()=>['read'],setActiveTools:()=>{}});
  const branch=[];
  const context={cwd:root,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=> 'session',getSessionFile:()=>join(root,'session.jsonl'),getBranch:()=>branch,getLeafId:()=> 'entry'},modelRegistry:{},ui:{notify:()=>{}}};
  try {
    await hooks.get('session_start')({},context);
    branch.push({type:'message',id:'entry',message:{role:'user',content:'opted-in fact'}});
    // act
    hooks.get('agent_settled')({},context);
    hooks.get('session_shutdown')({},context);
    const reopened=await Store.open(root,project);
    // assert
    assert.deepEqual([...reopened.eligibleEntryIds('session')],['entry']);
    assert.equal(reopened.counts().pending,0);
    reopened.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('shutdown during asynchronous store open cannot resurrect an old runtime', async () => {
  // arrange
  const root=mkdtempSync(join(tmpdir(),'memory-start-race-'));
  process.env.PI_CODING_AGENT_DIR=root;
  const project=resolveProject(root);
  writeProjectActivation(root,project,true);
  const store=await Store.open(root,project);
  const originalOpen=Store.open;
  let finishOpen;
  Store.open=()=>new Promise(resolve=>{finishOpen=resolve;});
  const hooks=new Map();
  let activeTools=['read'];
  memory({on:(name,handler)=>hooks.set(name,handler),registerTool:()=>{},registerCommand:()=>{},getActiveTools:()=>activeTools,setActiveTools:names=>{activeTools=names;}});
  const context={cwd:root,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=> 'session',getSessionFile:()=>join(root,'session.jsonl'),getBranch:()=>[]},ui:{notify:()=>{}}};
  try {
    const startup=hooks.get('session_start')({},context);
    // act
    hooks.get('session_shutdown')({},context);
    finishOpen(store);
    await startup;
    // assert
    assert.deepEqual(activeTools,['read']);
    assert.equal(hooks.get('context')({messages:[]},context),undefined);
  } finally {Store.open=originalOpen;rmSync(root,{recursive:true,force:true});}
});

test('reset keeps the project enabled and baselines old entries in the same session', async () => {
  // arrange
  const root=mkdtempSync(join(tmpdir(),'memory-reset-'));
  process.env.PI_CODING_AGENT_DIR=root;
  const project=resolveProject(root);
  writeProjectActivation(root,project,true);
  const hooks=new Map(),commands=new Map();
  const notices=[];
  memory({on:(name,handler)=>hooks.set(name,handler),registerTool:()=>{},registerCommand:(name,options)=>commands.set(name,options),getActiveTools:()=>['read'],setActiveTools:()=>{}});
  const entries=[{type:'message',id:'old',message:{role:'user',content:'old'}}];
  const context={cwd:root,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=> 'session',getSessionFile:()=>join(root,'session.jsonl'),getBranch:()=>entries,getLeafId:()=> 'old'},modelRegistry:{},ui:{notify:text=>notices.push(text),confirm:async()=>true},hasUI:true};
  try {
    await hooks.get('session_start')({},context);
    await commands.get('memory').handler('remember Before reset',context);
    // act
    await commands.get('memory').handler('reset',context);
    await commands.get('memory').handler('remember After reset',context);
    const injected=hooks.get('context')({messages:[]},context);
    // assert
    assert.match(notices.at(-1),/Remembered m-/);
    assert.match(injected.messages.at(-1).content,/After reset/);
    assert.doesNotMatch(injected.messages.at(-1).content,/Before reset/);
    hooks.get('session_shutdown')({},context);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('fast off/on in another process cannot reuse pre-off eligibility or context', async () => {
  // arrange
  const root = mkdtempSync(join(tmpdir(),'memory-epoch-'));
  process.env.PI_CODING_AGENT_DIR = root;
  const project=resolveProject(root);
  writeProjectActivation(root,project,true);
  const hooks = new Map();
  const pi={on:(name,handler)=>hooks.set(name,handler),registerTool:()=>{},registerCommand:()=>{},getActiveTools:()=>['read'],setActiveTools:()=>{}};
  const branch=[];
  const context={cwd:root,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=> 'session',getSessionFile:()=>join(root,'session.jsonl'),getBranch:()=>branch,getLeafId:()=>null},modelRegistry:{},ui:{notify:()=>{}},hasUI:false};
  try {
    memory(pi);
    await hooks.get('session_start')({},context);
    const store=await Store.open(root,project);
    store.remember('old project data');
    const before=hooks.get('context')({messages:[]},context);
    // act
    store.transition(false);
    store.transition(true);
    const after=hooks.get('context')({messages:[]},context);
    // assert
    assert.match(before.messages.at(-1).content,/old project data/);
    assert.equal(after,undefined);
    hooks.get('session_shutdown')({},context);
    store.close();
  } finally { rmSync(root,{recursive:true,force:true}); }
});
