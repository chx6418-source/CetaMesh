import { IPC_PROTOCOL_MAX_FRAME_BYTES } from './ipc-protocol.js';

// Worst JSON escaping of a permitted 200-character request id, plus actual
// version/ok/result envelope and the four-byte length header.
export function fitsIpcResponse(result) {
  return 4 + Buffer.byteLength(JSON.stringify({ version: 1, id: '\u0000'.repeat(200), ok: true, result }), 'utf8')
    <= IPC_PROTOCOL_MAX_FRAME_BYTES;
}
export function requireIpcItem(result) {
  if (!fitsIpcResponse(result)) throw Object.assign(new Error('Single item exceeds IPC response budget; use a bounded content reference'), {code:'IPC_ITEM_TOO_LARGE'});
}
