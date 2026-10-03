jest.mock('react-native-blob-util', () => ({
  fs: {stat: jest.fn(), readFile: jest.fn(), unlink: jest.fn()},
}));

import {MicrophoneRecordProvider} from '../native/microphone/MicrophoneRecordProvider';

const audio = 'A'.repeat(48);

function files(overrides: Partial<{
  stat: (uri: string) => Promise<number | string>;
  read: (uri: string, encoding: 'base64') => Promise<string>;
  remove: (uri: string) => Promise<void>;
}> = {}) {
  const removed: string[] = [];
  return {
    removed,
    stat: overrides.stat ?? (async () => 48),
    read: overrides.read ?? (async () => audio),
    remove: overrides.remove ?? (async uri => { removed.push(uri); }),
  };
}

test('records bounded audio through the native provider and removes its cache file', async () => {
  const disk = files();
  const provider = new MicrophoneRecordProvider(
    {
      record: async () =>
        JSON.stringify({
          uri: 'file:///cache/ceta-recording-1.m4a',
          mime: 'audio/mp4',
          name: 'recording.m4a',
          durationMs: 1200,
        }),
      cancel: () => undefined,
    },
    disk,
  );

  await expect(provider.invoke({name: 'microphone.record'})).resolves.toMatchObject({
    name: 'microphone.record',
    output: {kind: 'audio', mime: 'audio/mp4', data: audio, size: 48, durationMs: 1200},
  });
  expect(disk.removed).toEqual(['/cache/ceta-recording-1.m4a']);
});

test('rejects arbitrary input and absent native implementation before recording', async () => {
  let records = 0;
  const disk = files();
  const provider = new MicrophoneRecordProvider(
    {record: async () => { records += 1; return ''; }, cancel: () => undefined},
    disk,
  );

  await expect(
    provider.invoke({name: 'microphone.record', input: {path: '/tmp/recording'}}),
  ).rejects.toMatchObject({code: 'invalid_protocol'});
  expect(records).toBe(0);
  await expect(
    new MicrophoneRecordProvider(null, disk).invoke({name: 'microphone.record'}),
  ).rejects.toMatchObject({code: 'unsupported'});
});

test('permission denial, invalid duration and oversized data fail closed', async () => {
  const denied = new MicrophoneRecordProvider({
    record: async () => { throw {code: 'permission_denied', message: 'private'}; },
    cancel: () => undefined,
  });
  await expect(denied.invoke({name: 'microphone.record'})).rejects.toMatchObject({
    code: 'permission_denied',
    message: 'Microphone permission was denied',
  });

  const invalidDuration = new MicrophoneRecordProvider({
    record: async () => JSON.stringify({uri: 'file:///cache/a.m4a', mime: 'audio/mp4', name: 'a.m4a', durationMs: 60001}),
    cancel: () => undefined,
  });
  await expect(invalidDuration.invoke({name: 'microphone.record'})).rejects.toMatchObject({
    code: 'permission_denied',
  });

  const disk = files({stat: async () => 9 * 1024 * 1024});
  const oversized = new MicrophoneRecordProvider({
    record: async () => JSON.stringify({uri: 'file:///cache/a.m4a', mime: 'audio/mp4', name: 'a.m4a', durationMs: 1000}),
    cancel: () => undefined,
  }, disk);
  await expect(oversized.invoke({name: 'microphone.record'})).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(disk.removed).toEqual(['/cache/a.m4a']);
});

test('invalid base64 audio is rejected and cancel delegates', async () => {
  const disk = files({read: async () => 'not audio\n'});
  let cancelled = 0;
  const provider = new MicrophoneRecordProvider({
    record: async () => JSON.stringify({uri: 'file:///cache/a.m4a', mime: 'audio/mp4', name: 'a.m4a', durationMs: 1000}),
    cancel: () => { cancelled += 1; },
  }, disk);
  await expect(provider.invoke({name: 'microphone.record'})).rejects.toMatchObject({
    code: 'invalid_protocol',
  });
  provider.cancel();
  expect(cancelled).toBe(1);
  expect(disk.removed).toEqual(['/cache/a.m4a']);
});

test('encoded path traversal is rejected before reading a cache file', async () => {
  let read = 0;
  const disk = files({read: async () => { read += 1; return audio; }});
  const provider = new MicrophoneRecordProvider({
    record: async () => JSON.stringify({
      uri: 'file:///cache/%2e%2e/private.m4a',
      mime: 'audio/mp4',
      name: 'recording.m4a',
      durationMs: 1000,
    }),
    cancel: () => undefined,
  }, disk);
  await expect(provider.invoke({name: 'microphone.record'})).rejects.toMatchObject({
    code: 'permission_denied',
  });
  expect(read).toBe(0);
  expect(disk.removed).toEqual([]);
});
