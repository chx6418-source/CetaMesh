import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPipeName, dataCall } from '../../src/control/data-ipc.js';

// Test readiness is an authenticated successful response, not merely an open pipe.
export async function waitForDataIpc(dataRoot, {
  timeoutMs = 15000, call = dataCall, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const pipeName = resolveDataPipeName({ dataRoot });
  const deadline = now() + timeoutMs;
  const retryable = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'TOKEN_NOT_READY', 'IPC_NOT_READY']);
  let lastError = null;
  while (now() < deadline) {
    try {
      // The file may be visible before the writer has published its token bytes.
      const token = fs.readFileSync(path.join(dataRoot, 'state', 'agent-token'), 'utf8').trim();
      if (!token) throw Object.assign(new Error('Data IPC token is not ready'), { code: 'TOKEN_NOT_READY' });
      const res = await call({ path: '/api/status', token, timeoutMs: Math.min(2000, Math.max(1, deadline - now())), pipeName });
      if (res.ok && res.status === 200) return res;
      const error = new Error(`Data IPC readiness returned status ${res.status}`);
      // Re-read the token on every attempt; a persistent 401 still fails at the deadline.
      if (res.status === 401 || res.status === 503) error.code = 'IPC_NOT_READY';
      throw error;
    } catch (error) {
      if (!retryable.has(error.code)) throw error;
      lastError = error;
      await sleep(Math.min(150, Math.max(0, deadline - now())));
    }
  }
  throw lastError ?? new Error(`timeout waiting for data IPC ${pipeName}`);
}
