import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createJsonRpcTransport } from '../src/agent/protocol/json-rpc-transport.js';

function fixture(options = {}) {
  const readable = new PassThrough();
  const frames = [];
  const writable = new Writable({ write(chunk, encoding, done) { frames.push(JSON.parse(chunk)); done(); } });
  const transport = createJsonRpcTransport({ readable, writable, framing: 'acp-v1-jsonl', ...options });
  const send = value => readable.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  return { readable, writable, frames, transport, send };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const malformed of [false, true]) {
  let calls = 0;
  const f = fixture({ onRequest: () => { calls++; return 'must not execute'; } });
  f.readable.write('{"jsonrpc":"2.0","id":"late","method":"approve"}\n' + (malformed ? '{broken}\n' : ''));
  if (!malformed) await f.transport.close();
  await tick();
  assert.equal(calls, 0, 'closing before queued dispatch prevents reverse handler side effects');
  assert.equal(f.frames.length, 0);
  await f.transport.close();
}
{
  const notices = [];
  const f = fixture({ onNotification: (method, params) => notices.push([method, params]) });
  for (const byte of Buffer.from('\uFEFF{"jsonrpc":"2.0","method":"中文","params":{"text":"你好"}}\n')) f.readable.write(Buffer.from([byte]));
  f.readable.write('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n');
  await tick();
  assert.deepEqual(notices.map(n => n[0]), ['中文', 'a', 'b']);
  const a = f.transport.request('one'); const b = f.transport.request('two');
  f.send({ id: 999, result: 'unknown' });
  f.send({ id: f.frames[1].id, result: 'second' }); f.send({ id: f.frames[0].id, result: 'first' });
  assert.deepEqual(await Promise.all([a, b]), ['first', 'second']);
  await f.transport.close();
  for (const event of ['data', 'end', 'close', 'error']) assert.equal(f.readable.listenerCount(event), 0);
  assert.equal(f.writable.listenerCount('error'), 0);
}
{
  const f = fixture();
  const pending = Array.from({ length: 256 }, () => f.transport.request('wait').catch(e => e));
  await assert.rejects(f.transport.request('overflow'), { code: 'RPC_PENDING_LIMIT' });
  f.readable.write(Buffer.alloc(1048577, 97));
  assert.ok((await Promise.all(pending)).every(e => e.code === 'RPC_FRAME_TOO_LARGE'));
  await f.transport.close();
}
{
  const f = fixture(); const controller = new AbortController();
  const aborted = assert.rejects(f.transport.request('abort', {}, { signal: controller.signal }), { code: 'RPC_ABORTED' });
  controller.abort(); await aborted;
  await assert.rejects(f.transport.request('timeout', {}, { timeoutMs: 5 }), { code: 'RPC_TIMEOUT' });
  const pending = assert.rejects(f.transport.request('close'), { code: 'RPC_CLOSED' });
  await f.transport.close(); await pending;
}
{
  const f = fixture({ framing: 'codex-app-server-jsonl', onRequest: async (method, params) => ({ method, params }) });
  f.transport.notify('hello', { text: '中文' }); assert.equal('jsonrpc' in f.frames[0], false);
  f.readable.write('{"id":"reverse","method":"approve","params":{"ok":true}}\n'); await tick();
  assert.deepEqual(f.frames[1], { id: 'reverse', result: { method: 'approve', params: { ok: true } } });
  await f.transport.close();
}
for (const bad of ['{broken}\n', '{"jsonrpc":"1.0","method":"x"}\n', '{"jsonrpc":"2.0","id":1,"result":1,"error":{}}\n']) {
  const f = fixture(); const pending = assert.rejects(f.transport.request('pending'), { code: 'RPC_PROTOCOL_ERROR' });
  f.readable.write(bad); await pending; await f.transport.close();
}
{
  const f = fixture({ onRequest: async () => { throw new Error('secret detail'); } });
  f.send({ id: 10, method: 'fail' }); await tick();
  assert.equal(f.frames[0].error.message, 'Request handler failed');
  await f.transport.close();
}
{
  // A real Node stdio child emits BOM and Chinese UTF-8 one byte at a time.
  const child = spawn(process.execPath, ['-e', 'const b=Buffer.from("\\uFEFF"+JSON.stringify({jsonrpc:"2.0",id:1,result:"中文跨字节"})+"\\n");for(const x of b)process.stdout.write(Buffer.from([x]));'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const exited = once(child, 'exit');
  const transport = createJsonRpcTransport({ readable: child.stdout, writable: child.stdin, framing: 'acp-v1-jsonl' });
  try { assert.equal(await transport.request('fixture'), '中文跨字节'); }
  finally { await transport.close(); child.stdin.end(); }
  assert.equal((await exited)[0], 0);
}
console.log('agent RPC transport fixtures PASS');
for (const mode of ['malformed','stream-end','explicit']) {
  let closes=0, reason;
  const f=fixture({onClose:error=>{closes++;reason=error;throw new Error('callback failure');}});
  if(mode==='malformed') f.readable.write('{bad}\n');
  else if(mode==='stream-end') f.readable.end();
  else await f.transport.close();
  await tick();await f.transport.close();
  assert.equal(closes,1);assert.ok(reason instanceof Error);
  await assert.rejects(f.transport.request('after-close'));
}
