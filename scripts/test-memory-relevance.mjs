import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryRuntime } from '../src/memory/index.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-relevance-'));
const owner = { kind: 'user', id: 'desktop' };
try {
  const runtime = createMemoryRuntime({ stateDir: root });
  const relevant = runtime.create({ principal: owner, type: 'working', scope: 'chat:allowed', content: '海獭审计使用严格路径检查' });
  runtime.create({ principal: owner, type: 'working', scope: 'chat:allowed', content: '周末旅行和晚餐安排', pinned: true });
  runtime.create({ principal: owner, type: 'working', scope: 'chat:denied', content: '海獭审计的私密内容' });
  const agent = { kind: 'agent', id: 'reader', grants: { scopes: ['chat:allowed'] } };
  const page = runtime.retrieve({ principal: agent, scope: 'chat:allowed', query: '海獭审计', limit: 20 });
  assert.deepEqual(page.memories.map(row => row.id), [relevant.id], 'zero-score pinned memory must not fill an automatic retrieval query');
  assert.equal(page.meta.returned, 1);
  assert.equal(runtime.retrieve({ principal: agent, query: '不存在词XYZ' }).memories.length, 0, 'no match must return no automatic context');
  assert.equal(runtime.retrieve({ principal: agent, query: '' }).memories.length, 2, 'blank-query explicit browsing remains compatible');
  assert.throws(() => runtime.retrieve({ principal: agent, scope: 'chat:denied', query: '海獭' }), { code: 'SCOPE_NOT_AUTHORIZED' });
  console.log('PASS memory relevance gate preserves scoped retrieval and empty-query browsing');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
