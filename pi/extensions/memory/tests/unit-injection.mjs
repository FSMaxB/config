import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import memory from '../src/index.ts';
import { resolveProject } from '../src/project.ts';
import { writeProjectActivation } from '../src/config.ts';

test('injection is a persisted custom message written once per memory snapshot', async () => {
  // arrange
  const root = mkdtempSync(join(tmpdir(), 'memory-injection-'));
  process.env.PI_CODING_AGENT_DIR = root;
  writeProjectActivation(root, resolveProject(root), true);
  const hooks = new Map(), commands = new Map();
  memory({ on: (name, handler) => hooks.set(name, handler), registerTool: () => {}, registerCommand: (name, options) => commands.set(name, options), getActiveTools: () => ['read'], setActiveTools: () => {} });
  const branch = [];
  const context = { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'session', getSessionFile: () => join(root, 'session.jsonl'), getBranch: () => branch, getLeafId: () => null }, modelRegistry: {}, ui: { notify: () => {} }, hasUI: false };
  const persist = message => branch.push({ type: 'custom_message', id: `injection-${branch.length}`, customType: message.customType, content: message.content, display: message.display, details: message.details });
  try {
    await hooks.get('session_start')({}, context);
    await commands.get('memory').handler('remember First fact', context);
    // act
    const first = hooks.get('before_agent_start')({ prompt: '' }, context);
    persist(first.message);
    branch.push({ type: 'message', id: 'tool-result', message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'file' }] } });
    const repeated = hooks.get('before_agent_start')({ prompt: '' }, context);
    const unchangedContext = hooks.get('context')({ messages: [] }, context);
    await commands.get('memory').handler('remember Second fact', context);
    const changed = hooks.get('before_agent_start')({ prompt: '' }, context);
    // assert
    assert.equal(first.message.customType, 'memory-injection');
    assert.equal(first.message.display, false);
    assert.match(first.message.content, /First fact/);
    assert.equal(typeof first.message.details.token, 'string');
    assert.equal(repeated, undefined);
    assert.equal(unchangedContext, undefined);
    assert.match(changed.message.content, /Second fact/);
    assert.notEqual(changed.message.details.token, first.message.details.token);
    hooks.get('session_shutdown')({}, context);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
