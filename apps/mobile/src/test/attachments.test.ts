import { AttachmentPolicy } from '../security/AttachmentPolicy';
import { AttachmentRuntime } from '../runtime/capability/AttachmentRuntime';
import {
  validateAttachment,
  validatePickedUri,
} from '../domain/capability/Attachment';
const file = {
  id: 'a',
  name: 'note.txt',
  mime: 'text/plain',
  kind: 'text' as const,
  data: 'hello',
  size: 5,
};
test('unknown capability defaults DENY; grants are single use and expire', async () => {
  let now = 0;
  const policy = new AttachmentPolicy(
    async () => true,
    () => now,
  );
  await expect(policy.authorize('shell.exec')).rejects.toMatchObject({
    code: 'permission_denied',
  });
  const grant = await policy.authorize('file.pick');
  policy.consume(grant, 'file.pick');
  expect(() => policy.consume(grant, 'file.pick')).toThrow();
  const expired = await policy.authorize('photos.select');
  now = 60001;
  expect(() => policy.consume(expired, 'photos.select')).toThrow();
});
test('denied policy never invokes picker; explicit approval allows only selected content', async () => {
  let reads = 0;
  const provider = {
    pick: async () => {
      reads++;
      return file;
    },
  };
  const denied = new AttachmentRuntime(
    new AttachmentPolicy(async () => false),
    provider,
  );
  await expect(denied.pick('file.pick')).rejects.toMatchObject({
    code: 'permission_denied',
  });
  expect(reads).toBe(0);
  const allowed = new AttachmentRuntime(
    new AttachmentPolicy(async () => true),
    provider,
  );
  expect(await allowed.pick('file.pick')).toEqual(file);
  await expect(
    allowed.invoke({ name: 'file.pick', input: { path: '/etc/passwd' } }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  expect(reads).toBe(1);
});
test('oversized, executable, malformed, remote and unsafe inputs are rejected', () => {
  expect(() => validateAttachment({ ...file, size: 200000 })).toThrow();
  expect(() =>
    validateAttachment({ ...file, mime: 'application/x-executable' }),
  ).toThrow();
  expect(() => validateAttachment({ ...file, data: 'bad\0value' })).toThrow();
  expect(() =>
    validateAttachment({
      ...file,
      kind: 'image',
      mime: 'image/png',
      data: 'not-base64',
    }),
  ).toThrow();
  for (const uri of [
    'https://example.com/file',
    // eslint-disable-next-line no-script-url -- security regression input; never executed
    'javascript:alert(1)',
    'file:///tmp/../private/key',
  ]) {
    expect(() => validatePickedUri(uri)).toThrow();
  }
});

test('opaque Android document IDs allow encoded separators; filesystem traversal stays denied', () => {
  expect(() =>
    validatePickedUri(
      'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fnote.txt',
    ),
  ).not.toThrow();
  expect(() => validatePickedUri('file:///tmp/%2e%2e/private/key')).toThrow();
  expect(() => validatePickedUri('file:///tmp/note%2Etxt')).not.toThrow();
});
test('picker cancellation uses standard error and does not return a phantom attachment', async () => {
  const runtime = new AttachmentRuntime(
    new AttachmentPolicy(async () => true),
    {
      pick: async () => {
        throw { code: 'cancelled' };
      },
    },
  );
  await expect(runtime.pick('file.pick')).rejects.toMatchObject({
    code: 'provider_error',
  });
});
