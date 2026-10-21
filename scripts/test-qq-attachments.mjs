import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertQqAttachments } from '../src/channel/qq/attachments.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-qq-attachments-'));
try {
  const allowed = path.join(root, 'allowed'); fs.mkdirSync(allowed);
  const inside = path.join(allowed, 'fixture.wav'); fs.writeFileSync(inside, 'fixture');
  const outside = path.join(root, 'private.txt'); fs.writeFileSync(outside, 'private');
  const options = { dataRoot: root, config: { fileSend: { localDirs: [allowed] } } };
  for (const type of ['file', 'record', 'image', 'video']) {
    await assert.rejects(assertQqAttachments({ message: [{ type, data: { file: outside } }] }, options), { code: 'QQ_ATTACHMENT_DENIED' });
    await assertQqAttachments({ message: [{ type, data: { file: inside } }] }, options);
  }
  await assert.rejects(assertQqAttachments({ file: outside }, options), { code: 'QQ_ATTACHMENT_DENIED' });
  await assert.rejects(assertQqAttachments({ file: 'http://127.0.0.1/private' }, options));
  console.log('Final QQ attachment realpath, declared directory and private URL checks verified');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
