import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import memory from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'pi-memory-extension-'));
process.env.PI_CODING_AGENT_DIR = root;

test('disabled session never opens DB or injects context; other tools remain active', async () => {
  // arrange
  const handlers = new Map();
  const tools = new Map();
  let activeTools = ['read'];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: () => {},
    getActiveTools: () => activeTools,
    setActiveTools: names => { activeTools = names; },
  };
  memory(pi);
  const context = {
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => 'session', getSessionFile: () => join(root, 'session.jsonl'),
      getLeafId: () => null, getBranch: () => [],
    },
  };
  // act
  await handlers.get('session_start')({}, context);
  const injected = handlers.get('context')({ messages: [] }, context);
  const result = await tools.get('memory_search').execute('call', { query: 'secret' }, undefined, undefined, context);
  // assert
  assert.equal(existsSync(join(root, 'memory')), false);
  assert.equal(injected, undefined);
  assert.deepEqual(activeTools, ['read']);
  assert.equal(result.content[0].text, 'Memory disabled');
});

test('global opt-in cannot open an untrusted or ephemeral session store', async () => {
  // arrange
  writeFileSync(join(root,'memory.json'),JSON.stringify({enabled:true}));
  const handlers = new Map(), commands = new Map();
  const notifications = [];
  let tools = ['read'];
  memory({ on:(name,handler)=>handlers.set(name,handler),registerTool:()=>{},registerCommand:(name,options)=>commands.set(name,options),getActiveTools:()=>tools,setActiveTools:names=>{tools=names;} });
  const context = {cwd:root,isProjectTrusted:()=>false,sessionManager:{getSessionId:()=> 'session',getSessionFile:()=>undefined,getBranch:()=>[]},hasUI:false,ui:{notify:text=>notifications.push(text)}};
  // act
  await handlers.get('session_start')({},context);
  await commands.get('memory').handler('status',context);
  // assert
  assert.equal(existsSync(join(root,'memory')),false);
  assert.deepEqual(tools,['read']);
  assert.match(notifications.at(-1),/Memory off/);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
