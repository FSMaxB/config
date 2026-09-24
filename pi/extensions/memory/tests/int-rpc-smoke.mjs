import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync,mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';

const extension = resolve(import.meta.dirname,'../index.ts');

test('isolated Pi RPC: off -> on -> remember -> off -> restart remains off', async () => {
  // arrange
  const root = mkdtempSync(join(tmpdir(),'pi-memory-rpc-'));
  const agentDir = join(root,'agent');
  const project = join(root,'project');
  mkdirSync(agentDir);
  mkdirSync(join(project,'.git'),{recursive:true});
  let first, second;
  try {
    first = start(project,agentDir);
    const commands = await first.send({type:'get_commands'});
    assert.ok(commands.data.commands.some(command => command.name === 'memory'));
    // act
    await first.send({type:'prompt',message:'/memory status'});
    assert.equal(existsSync(join(agentDir,'memory')),false);
    await first.send({type:'prompt',message:'/memory on'});
    assert.equal(existsSync(join(agentDir,'memory')),true);
    await first.send({type:'prompt',message:'/memory remember Use temporary fixtures'});
    await first.send({type:'prompt',message:'/memory off'});
    await first.close();
    second = start(project,agentDir);
    await second.send({type:'prompt',message:'/memory status'});
    // assert
    assert.match(first.notices.join('\n'),/Remembered m-/);
    assert.match(first.notices.join('\n'),/Project memory off/);
    assert.match(second.notices.join('\n'),/Memory off/);
  } finally {
    await first?.close();
    await second?.close();
    rmSync(root,{recursive:true,force:true});
  }
});

function start(project,agentDir) {
  const child = spawn('pi',['--mode','rpc','--offline','--approve','--no-extensions','--extension',extension,'--no-skills','--no-prompt-templates','--no-context-files','--session-dir',join(agentDir,'sessions')],{
    cwd:project,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_OFFLINE:'1'},stdio:['pipe','pipe','pipe'],
  });
  let buffer='',sequence=0,closed=false;
  const pending = new Map(),notices=[],diagnostics=[];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk => {
    buffer += chunk;
    let end;
    while ((end=buffer.indexOf('\n'))!==-1) {
      const line=buffer.slice(0,end); buffer=buffer.slice(end+1);
      let event;
      try { event=JSON.parse(line); } catch { continue; }
      if (event.type==='extension_ui_request' && event.method==='notify') notices.push(event.message);
      if (event.type==='response' && pending.has(event.id)) {
        const {resolve,reject,timer}=pending.get(event.id); pending.delete(event.id);clearTimeout(timer);
        event.success ? resolve(event) : reject(new Error(event.error ?? 'RPC command failed'));
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>diagnostics.push(chunk));
  child.on('exit',(code)=>{
    closed=true;
    for (const {reject,timer} of pending.values()) {clearTimeout(timer);reject(new Error(`Pi exited ${code}: ${diagnostics.join('').slice(-1000)}`));}
    pending.clear();
  });
  return {
    notices,
    send(command) {
      if (closed) return Promise.reject(new Error('Pi already exited'));
      const id=`rpc-${++sequence}`;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Pi RPC timed out: ${diagnostics.join('').slice(-1000)}`));},10000);
        pending.set(id,{resolve,reject,timer});
        child.stdin.write(JSON.stringify({...command,id})+'\n');
      });
    },
    async close() {
      if (closed) return;
      child.stdin.end();
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.kill();reject(new Error('Pi did not exit'));},5000);
        child.once('exit',()=>{clearTimeout(timer);resolve();});
      });
    },
  };
}
