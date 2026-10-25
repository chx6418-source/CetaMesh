import {ShareIngressRuntime} from '../runtime/inbox/ShareIngressRuntime';
import {OfflineInboxRuntime} from '../runtime/inbox/OfflineInboxRuntime';
import type {InboxItem} from '../domain/inbox/InboxItem';
import type {InboxInput} from '../domain/inbox/InboxItem';

test('share ingress accepts bounded URL/text/image/file references without changing content', async () => {
  const accepted: InboxItem[] = [];
  const ingress = new ShareIngressRuntime({
    accept: async (input: InboxInput) => {
      const item: InboxItem = {inboxId: `inbox-${accepted.length}`, kind: 'share', payload: input.payload, status: 'pending', localOnly: true, attempts: 0, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z'};
      accepted.push(item);
      return item;
    },
  } as unknown as OfflineInboxRuntime);

  await ingress.receive({type: 'url', value: 'https://example.com/article'});
  await ingress.receive({type: 'text', value: 'Important text'});
  await ingress.receive({type: 'image', name: 'photo.jpg', uri: 'content://provider/photo'});
  await ingress.receive({type: 'file', name: 'note.txt', uri: 'content://provider/note'});
  expect(accepted.map(item => item.payload)).toEqual([
    {type: 'url', value: 'https://example.com/article'},
    {type: 'text', value: 'Important text'},
    {type: 'image', name: 'photo.jpg', uri: 'content://provider/photo'},
    {type: 'file', name: 'note.txt', uri: 'content://provider/note'},
  ]);
});

test('share ingress rejects script URLs and oversized input', async () => {
  const ingress = new ShareIngressRuntime({accept: async () => {throw new Error('should not accept');}} as unknown as OfflineInboxRuntime);
  await expect(ingress.receive({type: 'url', value: ['java', 'script:alert(1)'].join('')})).rejects.toMatchObject({code: 'permission_denied'});
  await expect(ingress.receive({type: 'text', value: 'x'.repeat(16_001)})).rejects.toMatchObject({code: 'unsupported'});
});
