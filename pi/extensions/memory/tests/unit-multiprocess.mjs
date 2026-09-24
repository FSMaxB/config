import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveProject } from '../src/project.ts';
import { writeProjectActivation } from '../src/config.ts';
import { Store } from '../src/store.ts';

test('separate Pi processes cannot publish after project off', async () => {
  // arrange
  const root = mkdtempSync(join(tmpdir(),'memory-process-'));
  let child;
  try {
    const project = resolveProject(root);
    writeProjectActivation(root,project,true);
    const store = await Store.open(root,project);
    store.remember('Do not publish stale work');
    const database = await import('node:sqlite');
    const connection = new database.DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    connection.exec('UPDATE state SET changed_at=0');
    connection.close();
    child = spawn(process.execPath,['--import','tsx','tests/fixtures/publish-worker.mjs',root],{cwd:import.meta.dirname+'/..',stdio:['pipe','pipe','pipe']});
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',data => { output += data; });
    await new Promise((resolve,reject) => {
      const timeout = setTimeout(()=>reject(new Error('child not ready')),5000);
      child.stdout.on('data',function onData(data) {
        if (!data.includes('ready')) return;
        clearTimeout(timeout);
        child.stdout.off('data',onData);
        resolve();
      });
    });
    // act
    store.transition(false);
    child.stdin.end('\n');
    await once(child,'close',{signal:AbortSignal.timeout(5000)});
    // assert
    assert.match(output,/ready\nfalse\n/);
    assert.equal(store.generationId(),undefined);
    store.close();
  } finally {
    child?.kill();
    rmSync(root,{recursive:true,force:true});
  }
});
