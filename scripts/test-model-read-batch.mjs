import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, call, observeReads, toolId } from './test-model-read-concurrency.mjs';

let passed = 0, failed = 0;
async function check(name, action) { try { await action(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } }

export const errorCountsProgram = { version: 1, steps: [
  { id: 'files', op: 'search', input: { path: 'logs', glob: '*.jsonl', limit: 8 } },
  { id: 'sources', op: 'readEach', from: 'files', pathField: 'path', maxItems: 8, maxBytes: 50000 },
  { id: 'events', op: 'lines', from: 'sources', format: 'jsonl' },
  { id: 'errors', op: 'filter', from: 'events', where: { field: 'level', op: 'eq', value: 'error' } },
  { id: 'counts', op: 'aggregate', from: 'errors', groupBy: 'code', measures: ['count'] },
  { id: 'ordered', op: 'sort', from: 'counts', field: 'code', direction: 'asc' }
], output: { from: 'ordered', fields: ['code', 'count'] } };

await check('ordinary HTTP model context.batch searches reads dependent files and returns filtered counts with source receipts', async () => {
  const f = await fixture({ files: { 'logs/a.jsonl': '{"level":"error","code":"E1","raw":"SOURCE_ONLY_A"}\n{"level":"info","code":"I0"}\n',
    'logs/b.jsonl': '{"level":"error","code":"E1"}\n{"level":"error","code":"E2","raw":"SOURCE_ONLY_B"}\n' }, calls: [call('batch', 'context.batch', errorCountsProgram)] });
  try {
    const observed = await observeReads(f.root, () => f.coordinator.run(f.options));
    assert.equal(observed.result.status, 'completed');
    const tool = f.requests[1].messages.find(row => row.role === 'tool');
    const output = JSON.parse(tool.content);
    assert.equal(output.status, 'completed');
    assert.deepEqual(output.result.output, [{ code: 'E1', count: 2 }, { code: 'E2', count: 1 }]);
    assert.equal(output.result.sources.length, 3);
    assert.equal(output.result.complete, true);
    assert(!JSON.stringify(f.requests[1]).includes('SOURCE_ONLY_'), 'only selected results and source refs enter model history');
    const sources = Object.values(f.journal()).filter(row => row.parentRequestId);
    assert.deepEqual(sources.map(row => row.capability), ['filesystem.search', 'filesystem.read', 'filesystem.read']);
    for (const row of sources) {
      assert.equal(row.status, 'completed');
      assert.equal(typeof row.evidence?.id, 'string');
      const stored = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'model', 'tool-evidence', row.evidence.id + '.json'), 'utf8'));
      assert.equal(stored.binding.sessionId, 'read-session');
      assert.equal(stored.sourceCapability, row.capability);
    }
    assert.equal(observed.peak, 2, 'dependent readEach uses the same bounded real IO dispatcher');
  } finally { await f.close(); }
});

await check('a forged or effectful plan rejects the complete program before any source reads', async () => {
  for (const extra of [{ id: 'bad', op: 'write', input: { path: 'bad.txt', content: 'x' } },
    { id: 'bad', op: 'read', input: { path: 'a.txt', actor: { kind: 'owner', id: 'desktop' } } },
    { id: 'bad', op: 'filter', from: 'future', where: { field: '__proto__.x', op: 'eq', value: 'x' } },
    { id: 'bad', op: 'search', input: { glob: '*' } }]) {
    const program = { version: 1, steps: [{ id: 'first', op: 'read', input: { path: 'a.txt' } }, extra], output: { from: 'first' } };
    const f = await fixture({ calls: [call('batch', 'context.batch', program)] });
    try {
      const observed = await observeReads(f.root, () => f.coordinator.run(f.options));
      assert.equal(observed.opened, 0);
      const tool = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
      assert(['READ_BATCH_INVALID', 'TOOL_AUTHORITY_OVERRIDE', 'TOOL_ARGUMENTS_INVALID'].includes(tool.code ?? tool.error?.code), 'invalid programs reach the explicit grammar/authority refusal');
    } finally { await f.close(); }
  }
});
await check('path references and bounded text/select/unique/sort transformations return useful targeted snippets', async () => {
  const program = { version: 1, steps: [{ id: 'files', op: 'search', input: { path: 'src', glob: '*.txt' } },
    { id: 'read', op: 'read', input: { pathRef: { from: 'files', field: 'path', index: 0 } } },
    { id: 'lines', op: 'lines', from: 'read', format: 'text' },
    { id: 'todos', op: 'filter', from: 'lines', where: { field: 'text', op: 'startsWith', value: 'TODO' } },
    { id: 'selected', op: 'select', from: 'todos', fields: ['text', '_source.path'] },
    { id: 'distinct', op: 'unique', from: 'selected', field: 'text' },
    { id: 'ordered', op: 'sort', from: 'distinct', field: 'text', direction: 'asc' }], output: { from: 'ordered' } };
  const f = await fixture({ files: { 'src/a.txt': 'ignore\nTODO zeta\nTODO alpha\nTODO alpha\n', 'src/b.txt': 'OTHER_SOURCE_ONLY\n' }, calls: [call('snippets', 'context.batch', program)] });
  try {
    await f.coordinator.run(f.options);
    const result = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content).result;
    assert.deepEqual(result.output, [{ text: 'TODO alpha', '_source.path': 'src/a.txt' }, { text: 'TODO zeta', '_source.path': 'src/a.txt' }]);
    assert.equal(result.sources.length, 2);
    assert.equal(result.complete, true);
    assert(!JSON.stringify(f.requests[1]).includes('OTHER_SOURCE_ONLY'));
  } finally { await f.close(); }
});
await check('missing source grants and direct delegate calls refuse before source IO', async () => {
  const program = { version: 1, steps: [{ id: 'read', op: 'read', input: { path: 'a.txt' } }], output: { from: 'read', fields: ['path'] } };
  const f = await fixture({ agent: true, calls: [call('batch', 'context.batch', program)] });
  try {
    f.capabilities.grantTask(f.task.id, { capabilities: ['context.batch', 'filesystem.search'] });
    f.options.actor = f.capabilities.principalForTask(f.task.id);
    const observed = await observeReads(f.root, () => f.coordinator.run(f.options));
    assert.equal(observed.opened, 0);
    const error = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
    assert.equal(error.code ?? error.error?.code, 'BATCH_SOURCE_NOT_GRANTED');
    const direct = await observeReads(f.root, () => assert.rejects(f.broker.execute({ actor: { kind: 'owner', id: 'desktop' },
      capability: 'context.batch', workspaceId: f.workspaceEntry.id, input: program }), { code: 'BATCH_CONTEXT_UNAVAILABLE' }));
    assert.equal(direct.opened, 0);
  } finally { await f.close(); }
});
await check('malformed JSONL and row truncation remain explicit facts rather than complete aggregate data', async () => {
  const program = { version: 1, steps: [{ id: 'read', op: 'read', input: { path: 'events.jsonl' } },
    { id: 'rows', op: 'lines', from: 'read', format: 'jsonl' }, { id: 'count', op: 'aggregate', from: 'rows', measures: ['count'] }], output: { from: 'count' } };
  const f = await fixture({ files: { 'events.jsonl': 'malformed\n' + '{"x":1}\n'.repeat(2001) }, calls: [call('batch', 'context.batch', program)] });
  try {
    await f.coordinator.run(f.options);
    const result = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content).result;
    assert.deepEqual(result.output, [{ count: 2000 }]);
    assert.equal(result.complete, false);
    assert.equal(result.observations.invalidJsonl, 1);
    assert.equal(result.observations.truncated, true);
    assert(result.observations.omittedRows > 0);
  } finally { await f.close(); }
});
await check('source dispatches share the remaining turn call budget and never start a fanout beyond it', async () => {
  const f = await fixture({ files: { 'logs/a.jsonl': '{"code":"A"}', 'logs/b.jsonl': '{"code":"B"}' },
    coordinatorOptions: { maxCalls: 3 }, calls: [call('batch', 'context.batch', errorCountsProgram)] });
  try {
    const result = await f.coordinator.run(f.options);
    assert.equal(result.totalCalls, 2, 'outer and search consume calls; the two-read fanout cannot fit and does not run');
    assert.equal(Object.values(f.journal()).filter(row => row.parentRequestId).length, 1);
    const tool = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
    assert.equal(tool.code ?? tool.error?.code, 'TOOL_CALL_LIMIT');
  } finally { await f.close(); }
});
await check('a bounded fifty-row projection stays available instead of falling through generic forty-item clipping', async () => {
  const program = { version: 1, steps: [{ id: 'read', op: 'read', input: { path: 'lines.txt' } },
    { id: 'lines', op: 'lines', from: 'read', format: 'text' }], output: { from: 'lines', fields: ['text'] } };
  const f = await fixture({ files: { 'lines.txt': Array.from({ length: 50 }, (_, index) => 'line ' + index).join('\n') }, calls: [call('batch', 'context.batch', program)] });
  try {
    await f.coordinator.run(f.options);
    const tool = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
    assert.equal(tool.status, 'completed');
    assert.equal(tool.result.output.length, 50);
    assert.deepEqual(tool.result.output[49], { text: 'line 49' });
    assert.equal(tool.result.complete, true);
  } finally { await f.close(); }
});
await check('recursive glob includes files directly in the requested subtree as well as nested matches', async () => {
  const program = { version: 1, steps: [{ id: 'files', op: 'search', input: { path: 'src', glob: '**/*.txt' } }], output: { from: 'files', fields: ['path'] } };
  const f = await fixture({ files: { 'src/a.txt': 'alpha', 'src/nested/b.txt': 'beta' }, calls: [call('batch', 'context.batch', program)] });
  try {
    await f.coordinator.run(f.options);
    const tool = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
    assert.deepEqual(tool.result.output, [{ path: 'src/a.txt' }, { path: 'src/nested/b.txt' }]);
  } finally { await f.close(); }
});
await check('selected dotted fields remain usable by later sort/filter transforms', async () => {
  const program = { version: 1, steps: [{ id: 'file', op: 'read', input: { path: 'rows.jsonl' } },
    { id: 'rows', op: 'lines', from: 'file', format: 'jsonl' }, { id: 'selected', op: 'select', from: 'rows', fields: ['stats.count'] },
    { id: 'sorted', op: 'sort', from: 'selected', field: 'stats.count', direction: 'asc' }], output: { from: 'sorted' } };
  const f = await fixture({ files: { 'rows.jsonl': '{"stats":{"count":2}}\n{"stats":{"count":1}}\n' }, calls: [call('batch', 'context.batch', program)] });
  try {
    await f.coordinator.run(f.options);
    const tool = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
    assert.deepEqual(tool.result.output, [{ 'stats.count': 1 }, { 'stats.count': 2 }]);
  } finally { await f.close(); }
});
await check('inner source events stay distinct with maximum-length outer turn/call IDs', async () => {
  const f = await fixture({ files: { 'logs/a.jsonl': '{"code":"A"}', 'logs/b.jsonl': '{"code":"B"}' }, calls: [call('b'.repeat(200), 'context.batch', errorCountsProgram)] });
  try {
    const sources = [];
    await f.coordinator.run({ ...f.options, turnId: 't'.repeat(160), onCapabilityResult: event => { if (event.capability.startsWith('filesystem.')) sources.push(event); } });
    assert.equal(sources.length, 3);
    assert.equal(new Set(sources.map(row => row.eventId)).size, 3);
    assert(sources.every(row => row.eventId.length <= 200));
  } finally { await f.close(); }
});
await check('the total source byte budget also bounds actual search content IO', async () => {
  const program = { version: 1, steps: [{ id: 'files', op: 'search', input: { query: '.txt' } }], output: { from: 'files', fields: ['path'] } };
  const f = await fixture({ files: { 'large.txt': 'x'.repeat(600000) }, calls: [call('batch', 'context.batch', program)] });
  try {
    await f.coordinator.run(f.options);
    const tool = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
    assert.equal(tool.code ?? tool.error?.code, 'BATCH_BYTE_LIMIT');
    assert.equal(Object.values(f.journal()).filter(row => row.parentRequestId).length, 1);
  } finally { await f.close(); }
});
await check('an accepted live outer frame cannot be entered a second time with copied IDs and arguments', async () => {
  const program = { version: 1, steps: [{ id: 'file', op: 'read', input: { path: 'a.txt' } }], output: { from: 'file', fields: ['path'] } };
  const f = await fixture({ calls: [call('batch', 'context.batch', program)] });
  let attempted = false;
  try {
    const observed = await observeReads(f.root, () => f.coordinator.run({ ...f.options, onActivity: async event => {
      if (event.capability === 'filesystem.read' && !attempted) {
        attempted = true;
        await assert.rejects(f.broker.execute({ actor: f.options.actor, capability: 'context.batch', input: program,
          requestId: toolId('read-session', 'read-turn', 0, 0), taskId: null, workspaceId: f.workspaceEntry.id,
          origin: { sessionId: 'read-session', turnId: 'read-turn', runId: null, phase: null, targetKind: 'chat' } }), { code: 'BATCH_CONTEXT_UNAVAILABLE' });
      }
    } }));
    assert.equal(observed.result.status, 'completed');
    assert.equal(observed.opened, 1);
    assert.equal(observed.result.totalCalls, 2);
  } finally { await f.close(); }
});
console.log(JSON.stringify({ passed, failed }));
if (failed) process.exitCode = 1;
