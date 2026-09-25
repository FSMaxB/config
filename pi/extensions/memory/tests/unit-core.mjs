import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveProject } from '../src/project.ts';
import { loadConfiguration, writeProjectActivation } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { collectEvidence, redact } from '../src/evidence.ts';
import { parseExtraction } from '../src/extraction.ts';

async function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'pi-memory-test-'));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('default off, project activation, invalid config fails closed', async () => {
  // arrange
  await withRoot(async agentDir => {
    mkdirSync(join(agentDir, 'repository', '.git'), { recursive: true });
    mkdirSync(join(agentDir, 'repository', 'child'));
    const project = resolveProject(join(agentDir, 'repository', 'child'));
    // act
    const before = loadConfiguration(agentDir, project);
    writeProjectActivation(agentDir, project, true);
    const after = loadConfiguration(agentDir, project);
    writeFileSync(join(agentDir, 'memory.json'), '{"extractionModel":"invalid"}');
    // assert
    assert.equal(before.config.enabled, false);
    assert.equal(after.config.enabled, true);
    assert.equal(after.origin, 'project');
    assert.equal(existsSync(join(agentDir, 'memory')), false);
    assert.throws(() => loadConfiguration(agentDir, project), /Invalid memory configuration/);
  });
});

test('symlinked configuration is rejected instead of following external paths', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeFileSync(join(root,'external.json'),'{}');
    symlinkSync(join(root,'external.json'),join(root,'memory.json'));
    // act
    // assert
    assert.throws(() => loadConfiguration(root,project),/Unsafe memory file path/);
    assert.equal(existsSync(join(root,'memory')),false);
  });
});

test('store claim fencing, manual correction, tombstones, reset', async () => {
  // arrange
  await withRoot(async agentDir => {
    const project = resolveProject(agentDir);
    writeProjectActivation(agentDir, project, true);
    const store = await Store.open(agentDir, project);
    const file = join(agentDir, 'session.jsonl');
    writeFileSync(file, '');
    store.enqueue('session', file, 'leaf', JSON.stringify({ entries: [{ id: 'user', role: 'user', text: 'fact' }] }));
    // act
    const oldId = store.remember('old');
    const replacement = store.correct(oldId, 'new');
    const limits = { maxJobsPerDay: 20, maxInputEstimatedTokensPerDay: 200000, maxOutputTokensPerDay: 40000 };
    const job = store.claim('worker', limits);
    const database = new DatabaseSync(join(agentDir, 'memory', project.hash, 'memory.sqlite'));
    database.exec("UPDATE jobs SET retry_at=0");
    const claimed = store.claim('worker', limits);
    const other = await Store.open(agentDir, project);
    const competing = other.claim('other-worker', limits);
    const finalized = store.complete(claimed, [{ text: 'durable fact', evidenceEntryIds: ['user'] }]);
    const stale = other.complete({ ...claimed, owner: 'other-worker' }, [{ text: 'forged', evidenceEntryIds: ['user'] }]);
    // assert
    assert.ok(replacement);
    assert.equal(store.claims().some(claim => claim.id === oldId), false);
    assert.equal(store.claims().find(claim => claim.id === replacement).text, 'new');
    assert.equal(job, undefined); // 60-second debounce
    assert.ok(claimed);
    assert.equal(competing, undefined);
    assert.equal(finalized, true);
    assert.equal(stale, false);
    assert.equal(store.claims().find(claim => claim.text === 'durable fact').sourceId, claimed.sourceId);
    assert.equal(store.forget(store.claims().find(claim => claim.text === 'durable fact').id), true);
    assert.equal(store.claims().some(claim => claim.text === 'durable fact'), false);
    store.enqueue('session', file, 'another-leaf', JSON.stringify({ entries: [{ id: 'user', role: 'user', text: 'fact' }] }));
    assert.equal(store.counts().pending, 0); // Suppressed entry cannot repopulate on a fork.
    store.reset();
    assert.deepEqual(store.claims(), []);
    database.close();
    other.close();
    store.close();
  });
});

test('an off/on transition fences an enqueue prepared under the old epoch', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    const first=await Store.open(root,project);
    const second=await Store.open(root,project);
    const oldEpoch=first.epoch();
    // act
    second.transition(false);
    second.transition(true);
    first.observeEntries('session',new Set(['entry']),oldEpoch);
    first.enqueue('session',join(root,'file.jsonl'),'leaf',JSON.stringify({entries:[{id:'entry',role:'user',text:'off interval'}]}),new Set(),'model/extract','normal',oldEpoch);
    // assert
    assert.equal(first.counts().pending,0);
    assert.equal(first.eligibleEntryIds('session').size,0);
    first.close();second.close();
  });
});

test('project off fences a claimed worker on a second connection', async () => {
  // arrange
  await withRoot(async agentDir => {
    const project = resolveProject(agentDir);
    writeProjectActivation(agentDir, project, true);
    const first = await Store.open(agentDir, project);
    const second = await Store.open(agentDir, project);
    first.enqueue('session', join(agentDir, 'session.jsonl'), 'leaf', JSON.stringify({ entries: [{ id: 'entry', role: 'user', text: 'value' }] }));
    const database = new DatabaseSync(join(agentDir, 'memory', project.hash, 'memory.sqlite'));
    database.exec("UPDATE jobs SET retry_at=0");
    const job = first.claim('owner', { maxJobsPerDay: 20, maxInputEstimatedTokensPerDay: 200000, maxOutputTokensPerDay: 40000 });
    // act
    second.transition(false);
    const published = first.complete(job, [{ text: 'must not appear', evidenceEntryIds: ['entry'] }]);
    // assert
    assert.equal(published, false);
    assert.equal(loadConfiguration(agentDir, project).config.enabled, false);
    assert.equal(first.claims().length, 0);
    database.close(); first.close(); second.close();
  });
});

test('forget-source removes cross-revision shared evidence but preserves unrelated claims', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    const store=await Store.open(root,project);
    const database=new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    const limits={maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000};
    const firstPayload=JSON.stringify({entries:[{id:'shared',role:'user',text:'same evidence'},{id:'other',role:'user',text:'unrelated evidence'}]});
    store.enqueue('session',join(root,'file.jsonl'),'leaf-one',firstPayload);
    database.exec('UPDATE jobs SET retry_at=0');
    const first=store.claim('first',limits);
    store.complete(first,[{text:'fact from shared',evidenceEntryIds:['shared']},{text:'fact from other',evidenceEntryIds:['other']}]);
    const secondPayload=JSON.stringify({entries:[{id:'shared',role:'user',text:'same evidence'},{id:'new',role:'user',text:'new evidence'}]});
    store.enqueue('session',join(root,'file.jsonl'),'leaf-two',secondPayload);
    database.exec('UPDATE jobs SET retry_at=0');
    const second=store.claim('second',limits);
    store.complete(second,[{text:'duplicate shared fact',evidenceEntryIds:['shared']},{text:'fact from new',evidenceEntryIds:['new']}]);
    // act
    store.forgetSource(first.sourceId);
    // assert
    assert.deepEqual(store.claims().map(claim=>claim.text),['fact from new']);
    database.close();store.close();
  });
});

test('forgetting one claim does not erase another supported by a different entry in the same source', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    const store=await Store.open(root,project);
    store.enqueue('session',join(root,'file.jsonl'),'leaf',JSON.stringify({entries:[{id:'a',role:'user',text:'A'},{id:'b',role:'user',text:'B'}]}));
    const database=new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE jobs SET retry_at=0');
    const job=store.claim('owner',{maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000});
    store.complete(job,[{text:'fact A',evidenceEntryIds:['a']},{text:'fact B',evidenceEntryIds:['b']}]);
    // act
    store.forget(store.claims().find(claim=>claim.text==='fact A').id);
    // assert
    assert.deepEqual(store.claims().map(claim=>claim.text),['fact B']);
    database.close();store.close();
  });
});

test('failed jobs erase payload, keep the last failure reason and preserve the daily reservation when usage is unknown', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    const store=await Store.open(root,project);
    store.enqueue('session',join(root,'file.jsonl'),'leaf',JSON.stringify({entries:[{id:'e',role:'user',text:'value'}]}));
    const database=new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    const limits={maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000};
    // act
    for (let attempt=0;attempt<3;attempt++) {
      database.exec('UPDATE jobs SET retry_at=0');
      const job=store.claim(`worker-${attempt}`,limits);
      store.fail(job,`Unexpected token 'I' on attempt ${attempt}`);
    }
    // assert
    const job=database.prepare('SELECT status,payload,attempts,failure_reason FROM jobs').get();
    assert.equal(job.status,'failed');
    assert.equal(job.payload,'');
    assert.equal(Number(job.attempts),3);
    assert.equal(job.failure_reason,"Unexpected token 'I' on attempt 2");
    assert.equal(store.lastFailure(),"Unexpected token 'I' on attempt 2");
    assert.equal(Number(database.prepare('SELECT jobs FROM budget_days').get().jobs),3);
    database.close();store.close();
  });
});

test('three crashed leases exhaust extraction retries and erase the payload', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    const store=await Store.open(root,project);
    store.enqueue('session',join(root,'file.jsonl'),'leaf',JSON.stringify({entries:[{id:'e',role:'user',text:'fact'}]}));
    const database=new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE jobs SET retry_at=0');
    const limits={maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000};
    // act
    for (let attempt=0;attempt<3;attempt++) {
      assert.ok(store.claim(`owner-${attempt}`,limits));
      database.exec('UPDATE jobs SET lease_until=0; UPDATE state SET worker_until=0');
    }
    const fourth=store.claim('owner-four',limits);
    // assert
    assert.equal(fourth,undefined);
    const job=database.prepare('SELECT status,payload,attempts FROM jobs').get();
    assert.equal(job.status,'failed');
    assert.equal(job.payload,'');
    assert.equal(Number(job.attempts),3);
    database.close();store.close();
  });
});

test('reported usage above the reservation blocks later daily admission', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    const store=await Store.open(root,project);
    store.enqueue('session',join(root,'file.jsonl'),'leaf',JSON.stringify({entries:[{id:'e',role:'user',text:'fact'}]}));
    const database=new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE jobs SET retry_at=0');
    const limits={maxJobsPerDay:20,maxInputEstimatedTokensPerDay:5000,maxOutputTokensPerDay:5000};
    const job=store.claim('owner',limits);
    // act
    store.recordUsage('owner','extraction','fake/model',{input:6000,output:4500});
    store.complete(job,[]);
    store.enqueue('session',join(root,'file.jsonl'),'next-leaf',JSON.stringify({entries:[{id:'next',role:'user',text:'next'}]}));
    database.exec('UPDATE jobs SET retry_at=0');
    const next=store.claim('next-owner',limits);
    // assert
    assert.equal(next,undefined);
    const budget=database.prepare('SELECT inputs,outputs FROM budget_days').get();
    assert.equal(Number(budget.inputs),6000);
    assert.equal(Number(budget.outputs),4500);
    database.close();store.close();
  });
});

test('stolen worker lease cannot finalize an old extraction', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    const first=await Store.open(root,project);
    const second=await Store.open(root,project);
    first.enqueue('session',join(root,'session.jsonl'),'leaf',JSON.stringify({entries:[{id:'e',role:'user',text:'fact'}]}));
    const database=new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE jobs SET retry_at=0');
    const limits={maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000};
    const original=first.claim('original',limits);
    database.exec('UPDATE state SET worker_until=0; UPDATE jobs SET lease_until=0');
    // act
    const replacement=second.claim('replacement',limits);
    const oldResult=first.complete(original,[{text:'old',evidenceEntryIds:['e']}]);
    const newResult=second.complete(replacement,[{text:'new',evidenceEntryIds:['e']}]);
    // assert
    assert.equal(oldResult,false);
    assert.equal(newResult,true);
    assert.deepEqual(first.claims().map(claim=>claim.text),['new']);
    database.close();first.close();second.close();
  });
});

test('a new session can claim a durable snapshot from another session in the same project', async () => {
  // arrange
  await withRoot(async root => {
    const project=resolveProject(root);
    writeProjectActivation(root,project,true);
    let store=await Store.open(root,project);
    const file=join(root,'old-session.jsonl');
    store.enqueue('old-session',file,'old-leaf',JSON.stringify({entries:[{id:'entry',role:'user',text:'fact'}]}));
    store.close();
    const database=new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE jobs SET retry_at=0');
    // act
    store=await Store.open(root,project);
    const job=store.claim('new-session-worker',{maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000});
    // assert
    assert.equal(job.sessionId,'old-session');
    assert.equal(job.sessionFile,file);
    database.close();store.close();
  });
});

test('explicit model reload rehydrates only previously opted-in evidence', async () => {
  // arrange
  await withRoot(async root => {
    const project = resolveProject(root);
    writeProjectActivation(root,project,true);
    const store = await Store.open(root,project);
    const payload = JSON.stringify({entries:[{id:'eligible',role:'user',text:'known fact'}]});
    store.enqueue('session',join(root,'session.jsonl'),'leaf',payload,new Set(),'provider/old');
    const database = new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec("UPDATE jobs SET status='failed',payload='',attempts=3");
    // act
    const changed = store.refreshModels('provider/new','provider/consolidate',true);
    const eligible = store.eligibleEntryIds('session');
    store.enqueue('session',join(root,'session.jsonl'),'leaf',payload,new Set(),'provider/new','retry');
    const revived = database.prepare('SELECT status,model_id,payload,attempts FROM jobs').get();
    // assert
    assert.equal(changed,'changed');
    assert.deepEqual([...eligible],['eligible']);
    assert.equal(revived.status,'pending');
    assert.equal(revived.model_id,'provider/new');
    assert.equal(revived.payload,payload);
    assert.equal(Number(revived.attempts),0);
    database.close();store.close();
  });
});

test('new continuing source supersedes older pending snapshot without mixing branches', async () => {
  // arrange
  await withRoot(async root => {
    const project = resolveProject(root);
    writeProjectActivation(root,project,true);
    const store = await Store.open(root,project);
    const file = join(root,'session.jsonl');
    const first = JSON.stringify({ entries:[{id:'u1',role:'user',text:'old'}] });
    const second = JSON.stringify({ entries:[{id:'u1',role:'user',text:'old'},{id:'u2',role:'user',text:'new'}] });
    store.enqueue('session',file,'leaf-one',first);
    // act
    store.enqueue('session',file,'leaf-two',second,new Set(['leaf-one','leaf-two']));
    const database = new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    const jobs = database.prepare('SELECT source_id FROM jobs').all();
    const oldSource = database.prepare("SELECT id FROM sources WHERE leaf_id='leaf-one'").get().id;
    const newSource = database.prepare("SELECT supersedes FROM sources WHERE leaf_id='leaf-two'").get();
    // assert
    assert.equal(jobs.length,1);
    assert.equal(newSource.supersedes,oldSource);
    database.close(); store.close();
  });
});

test('retention removes stale inferred sources but keeps manual claims and retrieved sources', async () => {
  // arrange
  await withRoot(async root => {
    const project = resolveProject(root);
    writeProjectActivation(root,project,true);
    const store = await Store.open(root,project);
    const manual = store.remember('keep manually');
    store.enqueue('session',join(root,'session.jsonl'),'leaf',JSON.stringify({entries:[{id:'u',role:'user',text:'old evidence'}]}));
    const database = new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec("UPDATE sources SET created_at=1; UPDATE jobs SET retry_at=0");
    const job = store.claim('owner',{maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000});
    store.complete(job,[{text:'old evidence',evidenceEntryIds:['u']}]);
    // act
    const expired = store.expireSources();
    // assert
    assert.equal(expired,1);
    assert.deepEqual(store.claims().map(claim=>claim.id),[manual]);
    database.close(); store.close();
  });
});

test('only eligible original text; strict extraction and redaction', () => {
  // arrange
  const branch = [
    { type: 'message', id: 'one', message: { role: 'user', content: 'token sk-ABCDEFGHIJKLMNOPQRST' } },
    { type: 'message', id: 'two', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'confirmed' }] } },
    { type: 'context_edit', id: 'three', targetId: 'two', replacement: null },
  ];
  // act
  const evidence = collectEvidence(branch, new Set(['one', 'two']));
  const output = parseExtraction(JSON.stringify({ summary: '', claims: [{ text: 'fact', kind: 'project_fact', evidenceEntryIds: ['one'] }] }), new Set(['one']));
  // assert
  assert.deepEqual(evidence.map(entry => entry.id), ['one']);
  assert.match(evidence[0].text, /\[redacted\]/);
  assert.equal(output.claims.length, 1);
  assert.throws(() => parseExtraction('{"summary":"","claims":[{"text":"fact","kind":"preference","evidenceEntryIds":["wrong"]}]}', new Set(['one'])));
  assert.equal(redact('Authorization: Bearer abc'), 'Authorization: Bearer [redacted]');
});
