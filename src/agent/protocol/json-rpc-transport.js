const fault = (code, message) => Object.assign(new Error(message), { code });
const own = (object, key) => Object.hasOwn(object, key);
const validId = id => typeof id === 'string' || (Number.isSafeInteger(id));

/** Bounded JSONL connection. Cancellation affects this RPC only, never an Agent turn. */
export function createJsonRpcTransport({ readable, writable, framing, maxFrameBytes = 1048576,
  maxPending = 256, controlTimeoutMs = 30000, onNotification, onRequest, onClose }) {
  if (!['acp-v1-jsonl', 'codex-app-server-jsonl'].includes(framing)) throw new TypeError('Explicit supported framing required');
  for (const value of [maxFrameBytes, maxPending, controlTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Limits must be positive integers');
  }
  const acp = framing === 'acp-v1-jsonl';
  const pending = new Map();
  const incoming = new Set();
  let nextId = 1, closed = null, parts = [], bytes = 0, first = true, notifications = 0;
  const envelope = value => acp ? { jsonrpc: '2.0', ...value } : value;
  function finish(id, error, result) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    if (error) entry.reject(error); else entry.resolve(result);
  }
  function shutdown(reason) {
    if (closed) return;
    closed = reason instanceof Error ? reason : fault('RPC_CLOSED', 'RPC connection closed');
    readable.off('data', data); readable.off('end', ended); readable.off('close', ended); readable.off('error', failed);
    writable.off('error', failed); writable.off('close', ended);
    parts = []; bytes = 0; incoming.clear();
    for (const id of pending.keys()) finish(id, closed);
    try { onClose?.(closed); } catch { /* Observer errors cannot interrupt cleanup after the transport is already closed. */ return; }
  }
  function failed() { shutdown(fault('RPC_STREAM_ERROR', 'RPC stream failed')); }
  function ended() { shutdown(fault(bytes ? 'RPC_PROTOCOL_ERROR' : 'RPC_CLOSED', bytes ? 'Truncated RPC frame' : 'RPC stream closed')); }
  function write(value) {
    if (closed) throw closed;
    const line = JSON.stringify(envelope(value));
    if (Buffer.byteLength(line) > maxFrameBytes) throw fault('RPC_FRAME_TOO_LARGE', 'RPC frame exceeds byte limit');
    // Backpressure is rejected rather than growing an unbounded writable queue.
    if (writable.writableNeedDrain) throw fault('RPC_BACKPRESSURE', 'RPC writable is congested');
    try { writable.write(`${line}\n`, error => { if (error) failed(); }); }
    catch { failed(); throw closed; }
  }
  function frame(buffer) {
    let message;
    try {
      let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
      if (first && text.startsWith('\uFEFF')) text = text.slice(1);
      first = false;
      message = JSON.parse(text);
    } catch { throw fault('RPC_PROTOCOL_ERROR', 'Malformed UTF-8 JSON frame'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || (acp ? message.jsonrpc !== '2.0' : own(message, 'jsonrpc')))
      throw fault('RPC_PROTOCOL_ERROR', 'Invalid RPC envelope');
    if (own(message, 'method')) {
      if (typeof message.method !== 'string' || !message.method || own(message, 'result') || own(message, 'error')
        || (own(message, 'id') && !validId(message.id))) throw fault('RPC_PROTOCOL_ERROR', 'Invalid RPC method frame');
      if (!own(message, 'id')) {
        if (notifications >= maxPending) throw fault('RPC_PROTOCOL_ERROR', 'Notification handler limit reached');
        notifications++;
        Promise.resolve().then(() => !closed && onNotification?.(message.method, message.params)).catch(() => {
          shutdown(fault('RPC_HANDLER_ERROR', 'Notification handler failed'));
        }).finally(() => { notifications--; });
        return;
      }
      if (incoming.has(message.id) || incoming.size >= maxPending) throw fault('RPC_PROTOCOL_ERROR', 'Reverse request limit or duplicate ID');
      incoming.add(message.id);
      const token = message.id;
      Promise.resolve().then(() => {
        if (closed) return undefined;
        return onRequest ? onRequest(message.method, message.params) : Promise.reject(null);
      })
        .then(result => ({ id: token, result: result ?? null }), () => ({ id: token,
          error: { code: onRequest ? -32603 : -32601, message: onRequest ? 'Request handler failed' : 'Method not supported' } }))
        .then(response => { if (!closed) write(response); })
        .catch(() => shutdown(fault('RPC_STREAM_ERROR', 'Reverse response failed')))
        .finally(() => incoming.delete(token));
      return;
    }
    if (!validId(message.id) || own(message, 'result') === own(message, 'error')
      || (own(message, 'error') && (!message.error || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string')))
      throw fault('RPC_PROTOCOL_ERROR', 'Invalid RPC response');
    finish(message.id, own(message, 'error') ? Object.assign(fault('RPC_REMOTE_ERROR', 'Remote RPC failed'), { rpcCode: message.error.code }) : null, message.result);
  }
  function data(chunk) {
    if (closed) return;
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      for (let index = 0; index <= buffer.length; index++) {
        if (index !== buffer.length && buffer[index] !== 10) continue;
        const segment = buffer.subarray(start, index);
        bytes += segment.length;
        if (bytes > maxFrameBytes) throw fault('RPC_FRAME_TOO_LARGE', 'RPC frame exceeds byte limit');
        if (segment.length) parts.push(Buffer.from(segment));
        if (index < buffer.length) {
          const complete = Buffer.concat(parts, bytes); parts = []; bytes = 0;
          frame(complete);
          if (closed) return;
        }
        start = index + 1;
      }
    } catch (error) { shutdown(error); }
  }
  readable.on('data', data); readable.on('end', ended); readable.on('close', ended); readable.on('error', failed);
  writable.on('error', failed); writable.on('close', ended);
  return {
    request(method, params, { signal, timeoutMs = controlTimeoutMs } = {}) {
      if (closed) return Promise.reject(closed);
      if (signal?.aborted) return Promise.reject(fault('RPC_ABORTED', 'RPC aborted'));
      if (pending.size >= maxPending) return Promise.reject(fault('RPC_PENDING_LIMIT', 'RPC pending limit reached'));
      if (typeof method !== 'string' || !method || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
        return Promise.reject(new TypeError('Valid method and nonnegative timeout required'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const abort = () => finish(id, fault('RPC_ABORTED', 'RPC aborted'));
        const timer = timeoutMs ? setTimeout(() => finish(id, fault('RPC_TIMEOUT', 'RPC timed out')), timeoutMs) : null;
        pending.set(id, { resolve, reject, signal, abort, timer });
        signal?.addEventListener('abort', abort, { once: true });
        try { write({ id, method, ...(params === undefined ? {} : { params }) }); } catch (error) { finish(id, error); }
      });
    },
    notify(method, params) {
      if (typeof method !== 'string' || !method) throw new TypeError('Valid method required');
      write({ method, ...(params === undefined ? {} : { params }) });
    },
    async close(reason) { shutdown(reason); }
  };
}
