import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,appendFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasPersistedEntries } from '../src/session-file.ts';

test('read-only JSONL validation ignores partial final lines and mismatched sessions', async () => {
  // arrange
  const root = mkdtempSync(join(tmpdir(),'memory-session-file-'));
  try {
    const path = join(root,'session.jsonl');
    const header = JSON.stringify({type:'session',id:'session'});
    const entry = JSON.stringify({type:'message',id:'new',message:{role:'user',content:'fact'}});
    writeFileSync(path,`${header}\n${entry.slice(0,-1)}`);
    // act
    const partial = await hasPersistedEntries(path,'session',new Set(['new']),new AbortController().signal);
    appendFileSync(path,'}\n');
    const complete = await hasPersistedEntries(path,'session',new Set(['new']),new AbortController().signal);
    const other = await hasPersistedEntries(path,'other',new Set(['new']),new AbortController().signal);
    // assert
    assert.equal(partial,false);
    assert.equal(complete,true);
    assert.equal(other,false);
    assert.equal(await hasPersistedEntries(join(root,'missing'),'session',new Set(['new']),new AbortController().signal),false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
