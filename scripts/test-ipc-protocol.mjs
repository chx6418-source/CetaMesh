import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { executeDataCall } from '../src/control/data-ipc.js';
import {
  startIpcProtocol,
  IPC_PROTOCOL_VERSION,
  IPC_PROTOCOL_MAX_FRAME_BYTES
} from '../src/control/ipc-protocol.js';

function encodeFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readUInt32LE(offset);
    assert.ok(size <= buffer.length - offset - 4, 'output must contain complete frames');
    const body = buffer.subarray(offset + 4, offset + 4 + size);
    messages.push(JSON.parse(body.toString('utf8')));
    offset += 4 + size;
  }
  assert.equal(offset, buffer.length, 'output must not contain a partial frame');
  return messages;
}

function makeHarness({ dispatch = async () => null, maxFrameBytes, dispatchTimeoutMs } = {}) {
  const input = new PassThrough({ autoDestroy: false });
  const output = new PassThrough();
  const outputChunks = [];
  output.on('data', (chunk) => outputChunks.push(Buffer.from(chunk)));
  const ipc = startIpcProtocol({ input, output, dispatch, maxFrameBytes, dispatchTimeoutMs });

  return {
    input,
    ipc,
    messages: () => decodeFrames(Buffer.concat(outputChunks)),
    async finish(frames = []) {
      for (const frame of frames) input.write(Buffer.isBuffer(frame) ? frame : encodeFrame(frame));
      input.end();
      await ipc.done;
      return this.messages();
    }
  };
}

function request(id, method, params) {
  return { version: IPC_PROTOCOL_VERSION, id, method, ...(params === undefined ? {} : { params }) };
}

{
  const harness = makeHarness();
  const encodedPing = encodeFrame(request('p1', 'core.ping'));
  // Fragment the frame across header and payload boundaries, as a named pipe may do.
  const messages = await harness.finish([
    encodedPing.subarray(0, 2),
    encodedPing.subarray(2, 7),
    encodedPing.subarray(7)
  ]);
  assert.deepEqual(messages, [
    { version: 1, event: 'core.ready' },
    { version: 1, id: 'p1', ok: true, result: { status: 'pong' } }
  ]);
}

{
  const calls = [];
  const harness = makeHarness({ dispatch: async (command) => {
    calls.push(command);
    return { roles: ['default'] };
  } });
  const messages = await harness.finish([
    encodeFrame(request('c1', 'control.execute', { method: 'role.list', params: { includeDisabled: true } }))
  ]);
  assert.deepEqual(calls, [{ method: 'role.list', params: { includeDisabled: true } }]);
  assert.deepEqual(messages[1], {
    version: 1,
    id: 'c1',
    ok: true,
    result: { roles: ['default'] }
  });
}

{
  const harness = makeHarness({ dispatch: async () => {
    throw Object.assign(new Error('Permission denied'), { code: 'FORBIDDEN' });
  } });
  const messages = await harness.finish([
    encodeFrame(request('e1', 'control.execute', { method: 'security.update', params: {} }))
  ]);
  assert.deepEqual(messages[1], {
    version: 1,
    id: 'e1',
    ok: false,
    error: { code: 'FORBIDDEN', message: 'Permission denied' }
  });
}

{
  const harness = makeHarness({ dispatch: async () => null });
  const messages = await harness.finish([
    encodeFrame({ version: 9, id: 'v1', method: 'core.ping' }),
    encodeFrame(Buffer.from('{bad json', 'utf8')),
    encodeFrame(Buffer.from([0xff, 0xfe])),
    encodeFrame(request('u1', 'unknown.method'))
  ]);
  assert.deepEqual(messages.slice(1), [
    { version: 1, id: 'v1', ok: false, error: { code: 'UNSUPPORTED_VERSION', message: 'Unsupported protocol version: 9' } },
    { version: 1, id: null, ok: false, error: { code: 'INVALID_JSON', message: 'Frame payload is not valid JSON' } },
    { version: 1, id: null, ok: false, error: { code: 'INVALID_JSON', message: 'Frame payload is not valid JSON' } },
    { version: 1, id: 'u1', ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'Unknown IPC method: unknown.method' } }
  ]);
}

{
  const harness = makeHarness({ maxFrameBytes: 128, dispatch: async () => null });
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(129, 0);
  const messages = await harness.finish([
    oversized,
    Buffer.alloc(129, 0x78),
    encodeFrame(request('p2', 'core.ping'))
  ]);
  assert.deepEqual(messages.slice(1), [
    { version: 1, id: null, ok: false, error: { code: 'FRAME_TOO_LARGE', message: 'Frame exceeds 128 bytes' } },
    { version: 1, id: 'p2', ok: true, result: { status: 'pong' } }
  ]);
}

{
  const harness = makeHarness({
    dispatch: (_command, { signal }) => {
      assert.equal(signal.aborted, false);
      signal.addEventListener('abort', () => assert.equal(signal.aborted, true), { once: true });
      return new Promise(() => {});
    },
    dispatchTimeoutMs: 10
  });
  const messages = await harness.finish([
    encodeFrame(request('t1', 'control.execute', { method: 'role.list' }))
  ]);
  assert.deepEqual(messages[1], {
    version: 1,
    id: 't1',
    ok: false,
    error: { code: 'DISPATCH_TIMEOUT', message: 'Control dispatch timed out after 10 ms' }
  });
}

{
  let dispatchStarted = false;
  let signalAborted = false;
  const harness = makeHarness({
    dispatch: (_command, { signal }) => {
      dispatchStarted = true;
      signal.addEventListener('abort', () => { signalAborted = true; }, { once: true });
      return new Promise(() => {});
    }
  });
  harness.input.write(encodeFrame(request('d1', 'control.execute', { method: 'role.list' })));
  await new Promise((resolve) => setImmediate(resolve));
  harness.ipc.close();
  await harness.ipc.done;
  assert.equal(dispatchStarted, true);
  assert.equal(signalAborted, true);
}


// continuity.*（阶段 09）与 chat.* / task.* 同一透传路径：方法族直接进 dispatch，错误 code 原样回传。
{
  const harness = makeHarness({ dispatch: async (command) => {
    if (command.method === 'continuity.evaluate') return { taskId: command.params.taskId, action: 'rollover' };
    throw Object.assign(new Error('任务不存在'), { code: 'TASK_NOT_FOUND' });
  } });
  const messages = await harness.finish([
    request('c1', 'continuity.evaluate', { taskId: 't1' }),
    request('c2', 'continuity.rollover', { taskId: 'missing' })
  ]);
  assert.deepEqual(messages.find((m) => m.id === 'c1'), {
    version: 1, id: 'c1', ok: true, result: { taskId: 't1', action: 'rollover' }
  });
  const errorFrame = messages.find((m) => m.id === 'c2');
  assert.equal(errorFrame.ok, false);
  assert.equal(errorFrame.error.code, 'TASK_NOT_FOUND');
  harness.ipc.close();
  await harness.ipc.done;
}
assert.equal(IPC_PROTOCOL_MAX_FRAME_BYTES, 1024 * 1024);
{
  const response = await Promise.race([executeDataCall({ method: 'POST', path: '/api/fixture', body: { value: 42 } }, {
    handleApiRequest: async (req, res) => {
      await new Promise(resolve => setImmediate(resolve));
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      await new Promise(resolve => req.on('end', resolve));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    }
  }), new Promise((_, reject) => setTimeout(() => reject(new Error('async POST body was lost')), 300))]);
  assert.equal(JSON.parse(response.body).value, 42, 'data IPC buffers POST body until an async handler reads it');
}
console.log('ipc-protocol tests: PASS');
