import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
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

test.after(() => rmSync(root, { recursive: true, force: true }));
