import crypto from 'node:crypto';
import { channelError } from '../delivery-journal.js';

// Inherited parent/child pipes only. This is not an Owner IPC listener.
export function createChannelProcessLink({ input, output, onRequest, onClose = () => {}, maxFrameBytes = 1024 * 1024 }) {
  const pending = new Map();
  let buffer = Buffer.allocUnsafe(maxFrameBytes);
  let bufferedBytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let closed = false;
  let activeRequests = 0;
  const write = frame => {
    if (closed || output.destroyed || output.writableEnded) throw channelError('CHANNEL_PROCESS_CLOSED', 'Connector process pipe closed');
    const data = JSON.stringify({ version: 1, ...frame }) + '\n';
    if (Buffer.byteLength(data) > maxFrameBytes || (output.writableLength || 0) + Buffer.byteLength(data) > 2 * maxFrameBytes) throw channelError('CHANNEL_FRAME_LIMIT', 'Connector pipe capacity exceeded');
    output.write(data);
  };
  function close() {
    if (closed) return;
    closed = true;
    buffer = null; bufferedBytes = 0;
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(channelError('CHANNEL_PROCESS_CLOSED', 'Connector outcome unknown after process disconnect')); }
    pending.clear();
    onClose();
  }
  async function frame(row) {
    if (row?.version !== 1 || typeof row.id !== 'string') throw channelError('CHANNEL_PROTOCOL_INVALID', 'Invalid Connector frame');
    if (row.type === 'response') {
      const waiting = pending.get(row.id);
      if (!waiting) return;
      pending.delete(row.id); clearTimeout(waiting.timer);
      if (row.error) waiting.reject(channelError(row.error.code ?? 'CHANNEL_REMOTE_ERROR', String(row.error.message ?? 'Connector error')));
      else waiting.resolve(row.result);
    } else if (row.type === 'request' && typeof row.method === 'string') {
      if (activeRequests >= 256) throw channelError('CHANNEL_QUEUE_FULL', 'Connector inbound command capacity exceeded');
      activeRequests++;
      try { write({ type: 'response', id: row.id, result: await onRequest(row.method, row.params) }); }
      catch (error) { if (!closed) write({ type: 'response', id: row.id, error: { code: error?.code ?? 'CHANNEL_REMOTE_ERROR', message: String(error?.message ?? error).slice(0, 500) } }); }
      finally { activeRequests--; }
    } else throw channelError('CHANNEL_PROTOCOL_INVALID', 'Unknown Connector frame');
  }
  input.on('data', data => {
    if (closed) return;
    const chunk = Buffer.from(data);
    for (let offset = 0; offset < chunk.length;) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const piece = chunk.subarray(offset, end);
      if (bufferedBytes + piece.length > maxFrameBytes || (newline < 0 && bufferedBytes + piece.length >= maxFrameBytes)) { close(); input.destroy(); return; }
      piece.copy(buffer, bufferedBytes); bufferedBytes += piece.length;
      offset = end;
      if (newline < 0) break;
      const line = buffer.subarray(0, bufferedBytes);
      bufferedBytes = 0;
      try { void frame(JSON.parse(decoder.decode(line))).catch(() => { close(); input.destroy(); }); }
      catch (error) { void error; close(); input.destroy(); return; }
    }
  });
  input.once('end', close); input.once('close', close); input.once('error', close); output.once('error', close); output.once('close', close);
  return { close, request(method, params, timeoutMs = 30000) {
    if (closed) return Promise.reject(channelError('CHANNEL_PROCESS_CLOSED', 'Connector process pipe closed'));
    if (pending.size >= 256) return Promise.reject(channelError('CHANNEL_QUEUE_FULL', 'Connector command queue full'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(channelError('CHANNEL_COMMAND_TIMEOUT', 'Connector command outcome unknown')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { write({ type: 'request', id, method, params }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  } };
}
