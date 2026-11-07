// Deterministic ACP peer for the production-Core handoff integration test.
// It has one fixed read operation and never starts a model or a shell.
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';

const sessionId = 'local-readonly-worker';
const permissions = new Map();
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
let sequence = 0;
async function prompt(frame) {
  const text = frame.params.prompt.map(row => row.text).join('\n');
  if (!text.includes('You are the selected execution worker.')) {
    send({ id: frame.id, result: { stopReason: 'end_turn' } });
    return;
  }
  const toolCallId = 'fixed-read-' + ++sequence;
  const approved = await new Promise(resolve => {
    const id = 'permission-' + sequence;
    permissions.set(id, resolve);
    send({ id, method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId, kind: 'read', title: 'Read the fixed project proof file',
        rawInput: { path: 'proof.txt' }, locations: [{ path: 'proof.txt' }] },
      options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
  });
  if (!approved) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The fixed read was denied; no file tool ran.' } });
    send({ id: frame.id, result: { stopReason: 'refusal' } });
    return;
  }
  const content = fs.readFileSync('proof.txt', 'utf8');
  const result = { path: 'proof.txt', sha256: crypto.createHash('sha256').update(content).digest('hex'), content };
  update({ sessionUpdate: 'tool_call_update', toolCallId, kind: 'read', title: 'Fixed project proof read',
    status: 'completed', rawOutput: result });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(result) } });
  send({ id: frame.id, result: { stopReason: 'end_turn' } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: 1 } });
  else if (frame.method === 'session/new') send({ id: frame.id, result: { sessionId } });
  else if (frame.method === 'session/prompt') void prompt(frame);
  else if (frame.method === 'session/cancel') {
    for (const resolve of permissions.values()) resolve(false);
    permissions.clear();
  } else if (!frame.method && permissions.has(frame.id)) {
    const resolve = permissions.get(frame.id); permissions.delete(frame.id);
    resolve(frame.result?.outcome?.outcome === 'selected' && frame.result.outcome.optionId === 'allow');
  }
});
