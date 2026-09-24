import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
