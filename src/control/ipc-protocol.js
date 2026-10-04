import { TextDecoder } from 'node:util';

export const IPC_PROTOCOL_VERSION = 1;
export const IPC_PROTOCOL_MAX_FRAME_BYTES = 1024 * 1024;
export const IPC_PROTOCOL_DISPATCH_TIMEOUT_MS = 30_000;

const DEFAULT_ERROR_MESSAGE = 'Internal error';
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Start the native length-prefixed JSON protocol on the supplied streams.
 * Frames use a 4-byte unsigned little-endian payload length followed by UTF-8 JSON.
 *
 * `control.execute` expects params shaped as `{ method, params? }`; the injected
 * dispatcher receives `{ method, params }` and may optionally accept a second
 * `{ signal }` argument. The returned `done` promise settles after EOF and all
 * requests queued before EOF have been handled.
 */
export function startIpcProtocol({
  input = process.stdin,
  output = process.stdout,
  dispatch,
  maxFrameBytes = IPC_PROTOCOL_MAX_FRAME_BYTES,
  dispatchTimeoutMs = IPC_PROTOCOL_DISPATCH_TIMEOUT_MS
} = {}) {
  if (!input || typeof input.on !== 'function' || typeof input.off !== 'function') {
    throw new TypeError('input must be a readable event stream');
  }
  if (!output || typeof output.write !== 'function' || typeof output.on !== 'function' || typeof output.off !== 'function') {
    throw new TypeError('output must be a writable event stream');
  }
  if (typeof dispatch !== 'function') throw new TypeError('dispatch must be a function');
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 0xffffffff) {
    throw new TypeError('maxFrameBytes must be a positive safe integer no larger than uint32');
  }
  if (!Number.isSafeInteger(dispatchTimeoutMs) || dispatchTimeoutMs < 1) {
    throw new TypeError('dispatchTimeoutMs must be a positive safe integer');
  }

  let header = Buffer.alloc(0);
  let payload = Buffer.alloc(0);
  let expectedLength = null;
  let discardRemaining = 0;
  let closed = false;
  let disconnected = false;
  let settled = false;
  let cancelActiveDispatch = null;
  let queue = Promise.resolve();
  const watchInputClose = input === output;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const cleanup = () => {
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('error', onInputError);
    if (watchInputClose) input.off('close', onClose);
    output.off('error', onOutputError);
  };

  const settleDone = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectDone(error);
    else resolveDone();
  };

  const writeFrame = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > maxFrameBytes) throw new Error('IPC response exceeds frame limit');
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    output.write(frame);
  };

  const writeError = (id, code, message) => {
    writeFrame({
      version: IPC_PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message }
    });
  };

  const enqueue = (framePayload) => {
    queue = queue.then(() => handlePayload(framePayload)).catch(() => {
      try {
        writeError(null, 'INTERNAL_ERROR', DEFAULT_ERROR_MESSAGE);
      } catch {
        // A failed output stream is surfaced by its error event.
      }
    });
  };

  const enqueueError = (id, code, message) => {
    queue = queue.then(() => writeError(id, code, message)).catch(() => {
      try {
        writeError(null, 'INTERNAL_ERROR', DEFAULT_ERROR_MESSAGE);
      } catch {
        // A failed output stream is surfaced by its error event.
      }
    });
  };

  const handlePayload = async (framePayload) => {
    if (disconnected) return;
    let request;
    try {
      request = JSON.parse(utf8Decoder.decode(framePayload));
    } catch {
      writeError(null, 'INVALID_JSON', 'Frame payload is not valid JSON');
      return;
    }

    const id = request && typeof request === 'object' && !Array.isArray(request)
      && typeof request.id === 'string'
      ? request.id
      : null;

    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      writeError(id, 'INVALID_REQUEST', 'Request must be a JSON object');
      return;
    }
    if (request.version !== IPC_PROTOCOL_VERSION) {
      writeError(id, 'UNSUPPORTED_VERSION', `Unsupported protocol version: ${String(request.version)}`);
      return;
    }
    if (typeof request.id !== 'string' || typeof request.method !== 'string') {
      writeError(id, 'INVALID_REQUEST', 'Request id and method must be strings');
      return;
    }
    if (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))) {
      writeError(id, 'INVALID_PARAMS', 'Request params must be a JSON object');
      return;
    }

    const params = request.params ?? {};
    if (request.method === 'core.ping') {
      writeFrame({ version: IPC_PROTOCOL_VERSION, id, ok: true, result: { status: 'pong' } });
      return;
    }
    // 产品私有方法族（memory.* / task.*）：由注入 dispatch 侧做二级白名单。
    if (request.method.startsWith('memory.') || request.method.startsWith('task.')) {
      try {
        const result = await runDispatch({ method: request.method, params });
        if (!disconnected) writeFrame({ version: IPC_PROTOCOL_VERSION, id, ok: true, result: result === undefined ? null : result });
      } catch (error) {
        if (!disconnected) {
          writeError(id, typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR', typeof error?.message === 'string' ? error.message : DEFAULT_ERROR_MESSAGE);
        }
      }
      return;
    }
    if (request.method !== 'control.execute') {
      writeError(id, 'METHOD_NOT_FOUND', `Unknown IPC method: ${request.method}`);
      return;
    }
    if (typeof params.method !== 'string') {
      writeError(id, 'INVALID_PARAMS', 'control.execute params.method must be a string');
      return;
    }
    if (params.params !== undefined && (!params.params || typeof params.params !== 'object' || Array.isArray(params.params))) {
      writeError(id, 'INVALID_PARAMS', 'control.execute params.params must be a JSON object');
      return;
    }

    try {
      const result = await runDispatch({ method: params.method, params: params.params ?? {} });
      if (disconnected) return;
      writeFrame({ version: IPC_PROTOCOL_VERSION, id, ok: true, result: result === undefined ? null : result });
    } catch (error) {
      if (disconnected) return;
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
      const message = typeof error?.message === 'string' ? error.message : DEFAULT_ERROR_MESSAGE;
      writeError(id, code, message);
    }
  };

  const runDispatch = (command) => new Promise((resolve, reject) => {
    let finished = false;
    const controller = new AbortController();
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (cancelActiveDispatch === cancel) cancelActiveDispatch = null;
      callback(value);
    };
    const cancel = (error) => {
      controller.abort(error);
      finish(reject, error);
    };
    const timer = setTimeout(() => {
      const error = new Error(`Control dispatch timed out after ${dispatchTimeoutMs} ms`);
      error.code = 'DISPATCH_TIMEOUT';
      cancel(error);
    }, dispatchTimeoutMs);
    cancelActiveDispatch = cancel;
    Promise.resolve()
      .then(() => dispatch(command, { signal: controller.signal }))
      .then((result) => finish(resolve, result), (error) => finish(reject, error));
  });

  const onData = (chunk) => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    let offset = 0;

    while (offset < bytes.length) {
      if (discardRemaining > 0) {
        const count = Math.min(discardRemaining, bytes.length - offset);
        offset += count;
        discardRemaining -= count;
        continue;
      }

      if (expectedLength === null) {
        const count = Math.min(4 - header.length, bytes.length - offset);
        header = header.length === 0
          ? bytes.subarray(offset, offset + count)
          : Buffer.concat([header, bytes.subarray(offset, offset + count)]);
        offset += count;
        if (header.length < 4) continue;

        expectedLength = header.readUInt32LE(0);
        header = Buffer.alloc(0);
        payload = Buffer.alloc(0);

        if (expectedLength > maxFrameBytes) {
          enqueueError(null, 'FRAME_TOO_LARGE', `Frame exceeds ${maxFrameBytes} bytes`);
          discardRemaining = expectedLength;
          expectedLength = null;
          continue;
        }
      }

      const count = Math.min(expectedLength - payload.length, bytes.length - offset);
      if (count > 0) {
        const segment = bytes.subarray(offset, offset + count);
        payload = payload.length === 0 ? segment : Buffer.concat([payload, segment]);
        offset += count;
      }

      if (payload.length === expectedLength) {
        enqueue(payload);
        payload = Buffer.alloc(0);
        expectedLength = null;
      }
    }
  };

  const onEnd = () => {
    if (closed) return;
    closed = true;
    if (header.length > 0 || expectedLength !== null) {
      enqueueError(null, 'TRUNCATED_FRAME', 'Input ended in the middle of a frame');
    }
    queue.then(() => settleDone(), (error) => settleDone(error));
  };

  const disconnect = (error) => {
    if (disconnected) return;
    disconnected = true;
    closed = true;
    if (typeof input.pause === 'function') input.pause();
    cancelActiveDispatch?.(error ?? Object.assign(new Error('IPC connection closed'), { code: 'IPC_CLOSED' }));
    settleDone(error);
  };

  const onInputError = (error) => disconnect(error);
  const onOutputError = (error) => disconnect(error);
  const onClose = () => disconnect();

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onInputError);
  if (watchInputClose) input.on('close', onClose);
  output.on('error', onOutputError);

  try {
    writeFrame({ version: IPC_PROTOCOL_VERSION, event: 'core.ready' });
  } catch (error) {
    settleDone(error);
  }

  const close = () => {
    disconnect();
  };

  return { close, done };
}
