import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveProject } from '../src/project.ts';
import { writeProjectActivation } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { parseConsolidation } from '../src/consolidation.ts';
import { stageGeneration } from '../src/publication.ts';
import { injection, search, read } from '../src/retrieval.ts';

async function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'memory-generation-'));
  const project = resolveProject(root);
  writeProjectActivation(root,project,true);
  const store = await Store.open(root,project);
  try { await callback({ root,project,store }); }
  finally { store.close(); rmSync(root,{recursive:true,force:true}); }
}

test('consolidation publishes only a validated generation; forget switches to safe fallback', async () => {
  // arrange
  await fixture(async ({ root,project,store }) => {
    const claimId = store.remember('Use a small local fixture');
    const database = new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE state SET changed_at=0');
    const limits = { maxJobsPerDay: 20,maxInputEstimatedTokensPerDay: 200000,maxOutputTokensPerDay: 40000 };
    const task = store.reserveConsolidation('worker',limits);
    assert.ok(task);
    const competing = (await Store.open(root,project));
    assert.equal(competing.reserveConsolidation('other',limits),undefined);
    const sections = parseConsolidation(JSON.stringify({ sections: [{ heading: 'Process', items: [{ text: 'Use a small local fixture', claimIds: [claimId] }] }] }),task.claims);
    const manifest = stageGeneration(root,project,task.epoch,task.revision,task.claims,sections);
    // act
    const published = store.publish(task,manifest);
    const result = read(store,'session','handbook',1,2);
    store.forget(claimId);
    // assert
    assert.equal(published,true);
    assert.match(result,/generation [a-f0-9-]+/);
    assert.match(search(store,'session','fixture'),/No matches/);
    assert.equal(injection(store),undefined);
    assert.equal(store.published(),undefined);
    competing.close(); database.close();
  });
});

test('corrupt files fail closed, stale epoch never publishes', async () => {
  // arrange
  await fixture(async ({ root,project,store }) => {
    store.remember('A project fact');
    const database = new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE state SET changed_at=0');
    const task = store.reserveConsolidation('worker',{ maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000 });
    const sections = [{ heading:'Facts',items:[{text:'A project fact',claimIds:[task.claims[0].id]}] }];
    const manifest = stageGeneration(root,project,task.epoch,task.revision,task.claims,sections);
    const path = join(root,'memory',project.hash,'generations',manifest.id,'MEMORY.md');
    writeFileSync(path,readFileSync(path,'utf8')+'corruption');
    // act
    assert.throws(() => store.publish(task,manifest),/Invalid memory artifact/);
    store.transition(false);
    // assert
    assert.equal(store.publish(task,manifest),false);
    assert.equal(store.published(),undefined);
    database.close();
  });
});

test('invalidated generations are removed only after readers release their lease', async () => {
  // arrange
  await fixture(async ({root,project,store}) => {
    const claimId = store.remember('Transient fact');
    const database = new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE state SET changed_at=0');
    const task = store.reserveConsolidation('owner',{maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000});
    const manifest = stageGeneration(root,project,task.epoch,task.revision,task.claims,[{heading:'Facts',items:[{text:'Transient fact',claimIds:[claimId]}]}]);
    store.publish(task,manifest);
    database.prepare('INSERT INTO reader_leases(id,generation_id,until) VALUES(?,?,?)').run('reader',manifest.id,Date.now()+60000);
    store.forget(claimId);
    // act
    store.cleanupGenerations();
    const pinned = readFileSync(join(root,'memory',project.hash,'generations',manifest.id,'manifest.json'),'utf8');
    database.exec("DELETE FROM reader_leases WHERE id='reader'");
    store.cleanupGenerations();
    // assert
    assert.match(pinned,/"version":1/);
    assert.throws(() => readFileSync(join(root,'memory',project.hash,'generations',manifest.id,'manifest.json'),'utf8'),/ENOENT/);
    database.close();
  });
});

test('symlinked generation components fail closed', async () => {
  // arrange
  await fixture(async ({root,project,store}) => {
    store.remember('Safe claim');
    const database = new DatabaseSync(join(root,'memory',project.hash,'memory.sqlite'));
    database.exec('UPDATE state SET changed_at=0');
    const task = store.reserveConsolidation('owner',{maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000});
    const manifest = stageGeneration(root,project,task.epoch,task.revision,task.claims,[{heading:'Facts',items:[{text:'Safe claim',claimIds:[task.claims[0].id]}]}]);
    store.publish(task,manifest);
    const dir = join(root,'memory',project.hash,'generations',manifest.id);
    renameSync(dir,dir+'-saved');
    symlinkSync(dir+'-saved',dir);
    // act
    // assert
    assert.throws(() => store.published(),/Unsafe memory generation directory/);
    database.close();
  });
});

test('strict structure and provenance validation rejects invented claims', () => {
  // arrange
  const claims = [{ id:'m-claim',text:'Supported',origin:'manual',sourceId:null }];
  // act
  const invalid = JSON.stringify({ sections:[{heading:'Unknown',items:[{text:'Invented',claimIds:['m-invented']}]}] });
  // assert
  assert.throws(() => parseConsolidation(invalid,claims),/reference/);
});
