import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createCodexAgentProvider } from '../src/agent/codex-agent-provider.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { createOpenAiCompatibleModelProvider } from '../src/model/providers/openai-compatible.js';

const unsupported = defineAgentProvider({ id: 'audit-discovery', label: 'Audit Discovery', methods: {} });
assert.equal(unsupported.capabilities().supported.follow, false);
const unsupportedStream = unsupported.follow({ sessionId: 'discovery-only' });
assert.equal(typeof unsupportedStream?.[Symbol.asyncIterator], 'function', 'unsupported Follow keeps the AsyncIterable contract');
await assert.rejects(async () => {
  for await (const _event of unsupportedStream) { void _event; }
}, error => error.code === 'AGENT_UNSUPPORTED');
console.log('PASS AUD-002 unsupported Follow rejects with domain code while remaining AsyncIterable');

const fakeCli = {
  executable: () => 'codex-fixture',
  probe(args) {
    if (args[0] === '--version') return { available: true, stdout: 'codex-cli 9.9.9-fixture', stderr: '' };
    if (args[0] === '--help') return { available: true, stdout: '--config --ask-for-approval --cd', stderr: '' };
    if (args[0] === 'exec' && args[1] === '--help') return { available: true, stdout: '--json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check', stderr: '' };
    if (args[0] === 'login' && args[1] === 'status') return { available: true, stdout: 'Logged in', stderr: '' };
    return { available: false, stdout: '', stderr: '' };
  },
  async shutdown() {}
};
const auditRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-audit-replay-'));
const auditWorkspace = path.join(auditRoot, 'workspace');
fs.mkdirSync(auditWorkspace);
fs.writeFileSync(path.join(auditWorkspace, 'keep.txt'), 'source workspace must survive provider shutdown');
const provider = createCodexAgentProvider({ cliProcess: fakeCli,
  stagingRoot: path.join(auditRoot, 'stages'),
  resolveTaskWorkspace: async () => ({ task: { id: 'task-1', workspaceId: 'workspace-1', goal: 'audit' },
    workspace: { id: 'workspace-1', root: auditWorkspace } })
});
const { sessionId } = await provider.createSession({ taskId: 'task-1', workspaceId: 'workspace-1' });
const session = provider._sessions.get(sessionId);
const five = ['turn/start', 'assistant/chunk', 'tool/activity', 'assistant/message', 'turn/end']
  .map((type, index) => ({ type, seq: index + 1, eventId: `${sessionId}:${index + 1}`, data: { turn: 'turn-1', index } }));
session.events.push(...five);
session.nextSequence = five.length;
const controllers = [new AbortController(), new AbortController(), new AbortController()];
const iterators = controllers.map(controller => provider.follow({ sessionId, signal: controller.signal, sinceSequence: 0 })[Symbol.asyncIterator]());
try {
  for (const iterator of iterators) {
    const actual = [];
    for (let index = 0; index < five.length; index += 1) {
      const next = await Promise.race([iterator.next(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Follow missed replay event')), 100))]);
      actual.push(next.value?.type);
    }
    assert.deepEqual(actual, five.map(event => event.type), 'Task, Chat and Continuity each receive the complete ordered turn');
  }
  console.log('PASS AUD-001/RSK-001 independent 3-consumer replay');
  const cancelled = new AbortController();
  cancelled.abort();
  const cancelledStream = provider.follow({ sessionId, signal: cancelled.signal, sinceSequence: 0 });
  assert.equal((await cancelledStream.next()).done, true, 'one subscriber cancellation does not drain the shared journal');
  const futureController = new AbortController();
  try {
    await assert.rejects(() => Promise.race([
      provider.follow({ sessionId, signal: futureController.signal, sinceSequence: 99 }).next(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('future cursor waited indefinitely')), 100))
    ]), error => error.code === 'AGENT_EVENT_GAP', 'a future cursor fails instead of waiting indefinitely');
  } finally { futureController.abort(); }
  session.events.splice(0, 3);
  await assert.rejects(async () => {
    for await (const _event of provider.follow({ sessionId, sinceSequence: 0 })) { void _event; }
  }, error => error.code === 'AGENT_EVENT_GAP', 'retention overflow produces an explicit gap');
  const late = provider.follow({ sessionId, sinceSequence: 3 });
  assert.equal((await late.next()).value.eventId, five[3].eventId, 'late subscriber replays retained event identity');
  await late.return();
} finally {
  controllers.forEach(controller => controller.abort());
  await Promise.all(iterators.map(iterator => iterator.return?.()));
  try {
    await provider.shutdown();
    assert.equal(fs.existsSync(session.stage.root), false, 'shutdown removes only its owned stage');
    assert.equal(fs.readFileSync(path.join(auditWorkspace, 'keep.txt'), 'utf8'), 'source workspace must survive provider shutdown');
  } finally { fs.rmSync(auditRoot, { recursive: true, force: true }); }
}

const noTerminal = createToolExecutionCoordinator({
  modelRuntime: { supportsToolCalling: () => true, async chat() { throw new Error('stream expected'); }, async *stream() {
    yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'partial answer' } } };
  } },
  capabilityBroker: { execute() { throw new Error('No tool should execute'); } }
});
await assert.rejects(() => noTerminal.run({ providerId: 'fixture', messages: [{ role: 'user', content: 'Hello' }],
  manifest: [], actor: { kind: 'owner', id: 'audit' }, sessionId: 'audit-session', turnId: 'audit-turn',
  scope: { taskId: null, workspaceId: null } }), error => error.code === 'MODEL_STREAM_TERMINAL_MISSING');
console.log('PASS RSK-002 streamed Tool Calling refuses EOF without explicit turn/end');

const dsmlFrames = [
  { choices: [{ delta: { content: 'Work complete <｜DS' }, finish_reason: null }] },
  { choices: [{ delta: { content: 'ML｜calls><｜DSML｜invoke name="cap_filesystem_search">' }, finish_reason: 'stop' }] }
];
const dsmlProvider = createOpenAiCompatibleModelProvider({ id: 'deepseek-official', label: 'DeepSeek fixture',
  baseUrl: 'https://fixture.example/v1', defaultModel: 'deepseek-flash', supportsTools: true,
  secrets: { raw: () => ({ apiKey: 'fixture-only', baseUrl: 'https://fixture.example/v1' }) },
  fetchImpl: async () => new Response(dsmlFrames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }) });
const streamed = [];
await assert.rejects(async () => {
  for await (const event of dsmlProvider.stream({ model: 'deepseek-flash',
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'cap_test', arguments: '{}' } }] }],
    tools: [], toolChoice: 'none' })) streamed.push(event);
}, error => error.code === 'MODEL_TOOL_PROTOCOL_MISMATCH');
assert.equal(streamed.some(event => JSON.stringify(event).includes('DSML')), false,
  'split internal DSML syntax never reaches UI stream events');
console.log('PASS DeepSeek DSML protocol mismatch is rejected before displaying internal syntax');


for (const marker of ['<｜｜DSML｜｜','<||DSML||']) {
 const frames=[{choices:[{delta:{content:marker.slice(0,5)},finish_reason:null}]},{choices:[{delta:{content:marker.slice(5)+' calls><internal>PRIVATE</internal>',tool_calls:[{index:0,id:'safe-call',type:'function',function:{name:'cap_filesystem_read',arguments:'{"path":"fixture.txt"}'}}]},finish_reason:'tool_calls'}]}];
 const p=createOpenAiCompatibleModelProvider({id:'deepseek-official',label:'fixture',baseUrl:'https://fixture.example/v1',defaultModel:'fixture',supportsTools:true,secrets:{raw:()=>({apiKey:'fixture-only'})},fetchImpl:async()=>new Response(frames.map(f=>'data: '+JSON.stringify(f)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
 const events=[];for await(const e of p.stream({model:'fixture',messages:[{role:'user',content:'read'}],tools:[{id:'filesystem.read',description:'read',inputSchema:{type:'object',properties:{path:{type:'string'}}}}]}))events.push(e);
 assert.equal(events.some(e=>JSON.stringify(e).includes('DSML')||JSON.stringify(e).includes('PRIVATE')),false,'internal syntax must never reach assistant events');
 assert.equal(events.find(e=>e.type==='assistant/tool-calls').data.toolCalls[0].capabilityId,'filesystem.read','structured tool must remain usable');
}
console.log('PASS double-pipe DSML is suppressed while structured tool calls are preserved');

const finalSummaryProvider=createOpenAiCompatibleModelProvider({id:'deepseek-official',label:'fixture',baseUrl:'https://fixture.example/v1',defaultModel:'fixture',protocolProfile:'deepseek-chat-v1',supportsTools:true,secrets:{raw:()=>({apiKey:'fixture-only'})},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'summary without required continuation'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})});
await assert.rejects(()=>finalSummaryProvider.chat({model:'fixture',reasoning:'high',tools:[],messages:[{role:'assistant',content:null,tool_calls:[{id:'prior',type:'function',function:{name:'cap_read',arguments:'{}'}}]},{role:'tool',tool_call_id:'prior',content:'verified result'}]}),error=>error.code==='MODEL_CONTINUATION_REQUIRED','final synthesis must retain native continuation requirements for the next user turn');
console.log('PASS thinking final synthesis refuses missing native continuation before persistence');
