import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProject } from '../src/project.ts';
import { writeProjectActivation } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { injection,search,read } from '../src/retrieval.ts';

test('retrieval caps UTF-8 bytes, windows and 1-based line ranges', async () => {
  // arrange
  const root=mkdtempSync(join(tmpdir(),'memory-retrieval-'));
  try {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    const store=await Store.open(root,project);
    const ids=[];
    for (let index=0;index<30;index++) ids.push(store.remember(`value ${'é'.repeat(1000)} ${index}`));
    // act
    const results=search(store,'session','value');
    const overlay=injection(store);
    const artifact=read(store,'session',`claim:${ids[0]}`,1,100);
    // assert
    assert.ok(Buffer.byteLength(results)<=16384);
    assert.ok(Buffer.byteLength(overlay)<=8192);
    assert.ok(Buffer.byteLength(artifact)<=16384);
    assert.match(results,/\[truncated\]/);
    assert.equal(read(store,'session',`claim:${ids[0]}`,0,2),'Line range must start at 1 and contain at most 100 lines');
    store.close();
  } finally { rmSync(root,{recursive:true,force:true}); }
});
