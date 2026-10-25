import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForDataIpc } from './helpers/wait-for-data-ipc.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-ipc-readiness-'));
const tokenFile = path.join(root, 'state', 'agent-token');
fs.mkdirSync(path.dirname(tokenFile));
try {
  let clock = 0;
  let calls = 0;
  fs.writeFileSync(tokenFile, '');
  const success = { status: 200, ok: true };
  const result = await waitForDataIpc(root, {
    timeoutMs: 1000, now: () => clock,
    sleep: async ms => { clock += ms; fs.writeFileSync(tokenFile, 'ready-token'); },
    call: async ({ token }) => {
      assert.equal(token, 'ready-token', 'an empty, partially published token must not be sent');
      return ++calls === 1 ? { status: 401, ok: false } : success;
    }
  });
  assert.equal(result, success, '401 during startup is not readiness');
  assert.equal(calls, 2);
  clock = 0;
  await assert.rejects(waitForDataIpc(root, {
    timeoutMs: 300, now: () => clock, sleep: async ms => { clock += ms; },
    call: async () => ({ status: 401, ok: false })
  }), /401/, 'persistent authentication failure must remain a failure');
  await assert.rejects(waitForDataIpc(root, {
    call: async () => ({ status: 403, ok: false }),
    sleep: async () => assert.fail('unexpected status must fail immediately')
  }), /403/);
  clock = 0;
  fs.writeFileSync(tokenFile, '');
  await assert.rejects(waitForDataIpc(root, {
    timeoutMs: 300, now: () => clock, sleep: async ms => { clock += ms; },
    call: async () => assert.fail('empty token must not call IPC')
  }), /token/i);
  console.log('PASS data IPC readiness rejects empty tokens and errors, retries startup, and remains bounded');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
