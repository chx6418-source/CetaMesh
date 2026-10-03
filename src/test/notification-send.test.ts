import {NotificationSendProvider} from '../native/notification/NotificationSendProvider';

const payload = {title: 'CetaMesh', body: 'A task needs your attention'};

test('advertises notification.send on both mobile platforms', () => {
  const provider = new NotificationSendProvider({
    send: async () => undefined,
    cancel: () => undefined,
  });

  expect(provider.listCapabilities()).toEqual([
    {
      name: 'notification.send',
      version: 1,
      platforms: ['android', 'ios'],
      requiresPermission: true,
    },
  ]);
});

test('validates a bounded notification and delegates only its semantic payload', async () => {
  const sent: string[] = [];
  const provider = new NotificationSendProvider({
    send: async value => {
      sent.push(value);
    },
    cancel: () => undefined,
  });

  await expect(
    provider.invoke({name: 'notification.send', input: payload}),
  ).resolves.toEqual({name: 'notification.send', output: {sent: true}});
  expect(sent).toEqual([JSON.stringify(payload)]);
});

test('rejects missing, oversized and control-character payloads before native access', async () => {
  let calls = 0;
  const provider = new NotificationSendProvider({
    send: async () => {
      calls += 1;
    },
    cancel: () => undefined,
  });
  for (const input of [
    undefined,
    {body: 'missing title'},
    {title: '   '},
    {title: 'x'.repeat(121)},
    {title: 'ok', body: 'x'.repeat(501)},
    {title: 'unsafe\u0000title'},
  ]) {
    await expect(
      provider.invoke({name: 'notification.send', input}),
    ).rejects.toMatchObject({code: 'invalid_protocol'});
  }
  expect(calls).toBe(0);
});

test('permission denial and missing native implementation fail closed', async () => {
  const denied = new NotificationSendProvider({
    send: async () => {
      throw {code: 'permission_denied'};
    },
    cancel: () => undefined,
  });
  await expect(
    denied.invoke({name: 'notification.send', input: payload}),
  ).rejects.toMatchObject({code: 'permission_denied'});
  await expect(
    new NotificationSendProvider(null).invoke({
      name: 'notification.send',
      input: payload,
    }),
  ).rejects.toMatchObject({code: 'unsupported'});
});

test('rejects arbitrary capability names and delegates cancellation', async () => {
  let cancelled = 0;
  const provider = new NotificationSendProvider({
    send: async () => undefined,
    cancel: () => {
      cancelled += 1;
    },
  });
  await expect(provider.invoke({name: 'camera.capture', input: payload})).rejects.toMatchObject({
    code: 'unsupported',
  });
  provider.cancel();
  expect(cancelled).toBe(1);
});
