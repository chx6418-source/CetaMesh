jest.mock('react-native-blob-util', () => ({
  fs: {stat: jest.fn(), readFile: jest.fn(), unlink: jest.fn()},
}));

import {CameraCaptureProvider} from '../native/camera/CameraCaptureProvider';
import {CetaError} from '../shared/errors/CetaError';

const jpeg = '/9j/' + 'A'.repeat(32);

function files(overrides: Partial<{
  stat: (uri: string) => Promise<number | string>;
  read: (uri: string, encoding: 'base64') => Promise<string>;
  remove: (uri: string) => Promise<void>;
}> = {}) {
  const removed: string[] = [];
  return {
    removed,
    stat: overrides.stat ?? (async () => 36),
    read: overrides.read ?? (async () => jpeg),
    remove: overrides.remove ?? (async uri => { removed.push(uri); }),
  };
}

test('captures a bounded JPEG through the native provider and removes its cache file', async () => {
  const disk = files();
  const native = {
    capture: async () =>
      JSON.stringify({
        uri: 'file:///cache/ceta-camera-1.jpg',
        mime: 'image/jpeg',
        name: 'camera.jpg',
      }),
    cancel: () => undefined,
  };
  const provider = new CameraCaptureProvider(native, disk);

  await expect(provider.invoke({name: 'camera.capture'})).resolves.toMatchObject({
    name: 'camera.capture',
    output: {kind: 'image', mime: 'image/jpeg', data: jpeg, size: 36},
  });
  expect(disk.removed).toEqual(['/cache/ceta-camera-1.jpg']);
});

test('rejects arbitrary input and absent native implementation before file access', async () => {
  let captures = 0;
  const disk = files();
  const provider = new CameraCaptureProvider(
    {capture: async () => { captures += 1; return ''; }, cancel: () => undefined},
    disk,
  );

  await expect(
    provider.invoke({name: 'camera.capture', input: {path: '/etc/passwd'}}),
  ).rejects.toMatchObject({code: 'invalid_protocol'});
  expect(captures).toBe(0);
  await expect(
    new CameraCaptureProvider(null, disk).invoke({name: 'camera.capture'}),
  ).rejects.toMatchObject({code: 'unsupported'});
});

test('native permission denial is normalized and temporary files are cleaned after validation errors', async () => {
  const denied = new CameraCaptureProvider({
    capture: async () => { throw {code: 'permission_denied', message: 'private'}; },
    cancel: () => undefined,
  });
  await expect(denied.invoke({name: 'camera.capture'})).rejects.toMatchObject({
    code: 'permission_denied',
    message: 'Camera permission was denied',
  });

  const disk = files({stat: async () => 5 * 1024 * 1024});
  const provider = new CameraCaptureProvider(
    {
      capture: async () => JSON.stringify({uri: 'file:///cache/camera.jpg', mime: 'image/jpeg', name: 'camera.jpg'}),
      cancel: () => undefined,
    },
    disk,
  );
  await expect(provider.invoke({name: 'camera.capture'})).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(disk.removed).toEqual(['/cache/camera.jpg']);
});

test('malformed and unsafe native results fail closed', async () => {
  const cases = [
    '',
    JSON.stringify({uri: 'https://example.com/camera.jpg', mime: 'image/jpeg', name: 'camera.jpg'}),
    JSON.stringify({uri: 'file:///cache/../private.jpg', mime: 'image/jpeg', name: 'camera.jpg'}),
    JSON.stringify({uri: 'file:///cache/camera.jpg', mime: 'image/png', name: 'camera.png'}),
  ];
  for (const raw of cases) {
    const provider = new CameraCaptureProvider({capture: async () => raw, cancel: () => undefined});
    await expect(provider.invoke({name: 'camera.capture'})).rejects.toBeInstanceOf(CetaError);
  }
});

test('cancel delegates to the native provider', () => {
  let cancelled = 0;
  const provider = new CameraCaptureProvider({
    capture: async () => '',
    cancel: () => { cancelled += 1; },
  });
  provider.cancel();
  expect(cancelled).toBe(1);
});
