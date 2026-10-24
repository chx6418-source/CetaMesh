import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReferencePreview, findMessageReference } from '../src/desktop/reference-preview.js';
import { fitsIpcResponse } from '../src/control/response-budget.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { resolveTaskArtifactOpen } from '../src/task/artifact-open.js';

// Workspace service descriptors use canonical roots, including Windows TEMP aliases.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-preview-')));
try {
  fs.writeFileSync(path.join(root, 'main.ts'), 'const 名称 = "你好";\n'.repeat(8000));
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=must-not-read');
  fs.writeFileSync(path.join(root, 'image.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  fs.writeFileSync(path.join(root, 'fake.png'), 'not an image');
  fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(root, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x00]));
  fs.writeFileSync(path.join(root, 'document.pdf'), '%PDF-1.7');
  const text = '[入口](main.ts#L2) [网页](https://example.com/docs) [配置](.env) [图片](image.png) [假图片](fake.png) [大文件](big.txt) [乱码](bad.txt) [文档](document.pdf)\n\n[另一个][ref]\n\n[ref]: main.ts#L3';
  const actualChat = createChatService({ api: {}, controlExecute: async () => ({}), defaults: {}, stateDir: path.join(root, 'state'), resolveWorkspace: async id => ({ id, root }) });
  const session = await actualChat.execute({ method: 'chat.sessions.create', params: { config: { workspaceId: 'original' } } });
  writeJsonAtomic(path.join(actualChat._store.historyDir, `${session.id}.json`), { schemaVersion: 1, messages: [
    { id: 'saved', role: 'assistant', text, sourceWorkspaceId: 'original' },
    { id: 'legacy', role: 'assistant', text }
  ] });
  await actualChat.execute({ method: 'chat.config.set', params: { id: session.id, config: { ...session.config, workspaceId: 'another' } } });
  const actualUi = createDesktopUiService({ services: { chatService: actualChat, workspaceService: { describeWorkspace: id => id === 'original' ? { id, root } : null } } });
  const actual = await actualUi.execute({ method: 'ui.preview.open', params: { source: { kind: 'message', sessionId: session.id, messageId: 'saved', href: 'main.ts#L2' } } });
  assert.equal(actual.kind, 'code', 'real UI/Chat service retains original message scope after a session workspace switch');
  await actualUi.execute({ method: 'ui.preview.close', params: { handle: actual.handle } });
  await assert.rejects(actualUi.execute({ method: 'ui.preview.open', params: { source: { kind: 'message', sessionId: session.id, messageId: 'legacy', href: 'main.ts#L2' } } }), error => error.code === 'PREVIEW_SCOPE_UNKNOWN');
  await assert.rejects(actualUi.execute({ method: 'ui.preview.open', params: { source: { kind: 'message', sessionId: session.id, messageId: 'saved', href: 'not-in-message.txt' } } }), error => error.code === 'REFERENCE_NOT_FOUND');
  assert.throws(() => resolveTaskArtifactOpen({ artifact: { ref: 'main.ts' }, workspaceRoot: root }), error => error.code === 'ARTIFACT_TYPE_UNSUPPORTED', 'system-open allowlist stays restrictive');
  assert.equal(resolveTaskArtifactOpen({ artifact: { ref: 'main.ts' }, workspaceRoot: root, forPreview: true }).extension, '.ts');
  assert.equal(findMessageReference(text, 'main.ts#L2'), true);
  assert.equal(findMessageReference(text, 'main.ts#L3'), true);
  assert.equal(findMessageReference('`[伪造](secret.txt)`', 'secret.txt'), false);
  assert.equal(findMessageReference(text, 'other.ts'), false);
  assert.equal(findMessageReference('[文件](资料.md)', '%E8%B5%84%E6%96%99.md'), true, 'same URI normalization as Markdown renderer');
  assert.equal(findMessageReference('[文件](<my file.txt>)', 'my%20file.txt'), true);
  let clock = 1000;
  let allowed = true;
  const preview = createReferencePreview({ now: () => clock,
    resolveMessage: async source => {
      assert.equal(source.sessionId, 's1');
      assert.equal(source.messageId, 'm1');
      if (!allowed || !findMessageReference(text, source.href)) throw Object.assign(new Error('source denied'), { code: 'REFERENCE_NOT_FOUND' });
      return { workspaceId: 'original' };
    },
    describeWorkspace: id => id === 'original' ? { id, root } : null,
    resolveArtifact: async source => {
      if (source.taskId !== 't1' || source.artifactId !== 'a1') throw new Error('artifact denied');
      return { canonicalPath: path.join(root, 'main.ts'), extension: '.ts' };
    }
  });
  const source = href => ({ kind: 'message', sessionId: 's1', messageId: 'm1', href });
  const pool = createReferencePreview({ resolveMessage: async () => ({ workspaceId: 'original' }), describeWorkspace: id => ({ id, root }), resolveArtifact: async () => ({}) });
  const simultaneous = await Promise.allSettled(Array.from({ length: 16 }, () => pool.open({ source: source('main.ts#L2') })));
  assert.equal(simultaneous.filter(item => item.status === 'fulfilled').length, 8, 'pending opens reserve capacity before yielding');
  const result = await preview.open({ source: source('main.ts#L2') });
  assert.equal(result.kind, 'code'); assert.equal(result.line, 2);
  assert.equal(result.name, 'main.ts'); assert.equal(JSON.stringify(result).includes(root), false);
  const chunks = [];
  let offset = 0;
  do {
    const chunk = await preview.read({ handle: result.handle, offset });
    assert.ok(fitsIpcResponse(chunk));
    assert.ok(Buffer.from(chunk.data, 'base64').length <= 65536);
    chunks.push(Buffer.from(chunk.data, 'base64'));
    offset = chunk.nextOffset;
  } while (offset !== null);
  assert.equal(Buffer.concat(chunks).toString('utf8'), fs.readFileSync(path.join(root, 'main.ts'), 'utf8'));
  assert.equal((await preview.open({ source: source('https://example.com/docs') })).kind, 'web');
  assert.equal((await preview.open({ source: source('image.png') })).kind, 'image');
  assert.equal((await preview.open({ source: source('document.pdf') })).kind, 'unsupported');
  for (const [href, code] of [['.env', 'PREVIEW_PATH_DENIED'], ['fake.png', 'PREVIEW_IMAGE_INVALID'], ['big.txt', 'PREVIEW_TOO_LARGE'], ['bad.txt', 'PREVIEW_ENCODING_UNSUPPORTED']]) {
    await assert.rejects(preview.open({ source: source(href) }), error => error.code === code, href);
  }
  await assert.rejects(preview.open({ source: { ...source('main.ts'), path: root } }));
  await assert.rejects(preview.open({ source: source('../secret.txt') }));
  await assert.rejects(preview.read({ handle: result.handle, offset: -1 }));
  const artifact = await preview.open({ source: { kind: 'artifact', taskId: 't1', artifactId: 'a1' } });
  assert.equal(artifact.kind, 'code');
  await preview.close({ handle: artifact.handle });
  await assert.rejects(preview.read({ handle: artifact.handle, offset: 0 }), error => error.code === 'PREVIEW_EXPIRED');
  allowed = false;
  await assert.rejects(preview.read({ handle: result.handle, offset: 0 }), error => error.code === 'REFERENCE_NOT_FOUND');
  allowed = true;
  const changed = await preview.open({ source: source('main.ts#L2') });
  fs.writeFileSync(path.join(root, 'main.ts'), 'replacement');
  await assert.rejects(preview.read({ handle: changed.handle, offset: 0 }), error => error.code === 'PREVIEW_FILE_CHANGED');
  const expired = await preview.open({ source: source('main.ts#L2') });
  clock += 120001;
  await assert.rejects(preview.read({ handle: expired.handle, offset: 0 }), error => error.code === 'PREVIEW_EXPIRED');
  for (let index = 0; index < 8; index++) await preview.open({ source: source('main.ts#L2') });
  await assert.rejects(preview.open({ source: source('main.ts#L2') }), error => error.code === 'PREVIEW_LIMIT');
  console.log('PASS real reference parsing, original workspace, readonly files, chunk budgets, authority/replacement/expiry and resource bounds');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
