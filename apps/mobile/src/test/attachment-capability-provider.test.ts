jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));
jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  types: {plainText: 'text/plain'},
  isErrorWithCode: () => false,
  errorCodes: {OPERATION_CANCELED: 'OPERATION_CANCELED'},
}));
jest.mock('react-native-blob-util', () => ({
  fs: {stat: jest.fn(), readFile: jest.fn(), unlink: jest.fn()},
}));

import {AttachmentCapabilityProvider} from '../native/files/AttachmentCapabilityProvider';

const file = {
  id: 'attachment-1',
  name: 'note.txt',
  mime: 'text/plain',
  kind: 'text' as const,
  data: 'hello',
  size: 5,
};

test('advertises file and photo selection on both mobile platforms', () => {
  const provider = new AttachmentCapabilityProvider({
    pick: async () => file,
  });

  expect(provider.listCapabilities()).toEqual([
    {
      name: 'file.pick',
      version: 1,
      platforms: ['android', 'ios'],
      requiresPermission: true,
    },
    {
      name: 'photos.select',
      version: 1,
      platforms: ['android', 'ios'],
      requiresPermission: true,
    },
  ]);
});

test('wraps the bounded PickerProvider result in a CapabilityResult', async () => {
  const calls: string[] = [];
  const provider = new AttachmentCapabilityProvider({
    pick: async name => {
      calls.push(name);
      return file;
    },
  });

  await expect(provider.invoke({name: 'file.pick'})).resolves.toEqual({
    name: 'file.pick',
    output: file,
  });
  expect(calls).toEqual(['file.pick']);
});

test('rejects external input before opening a picker', async () => {
  let calls = 0;
  const provider = new AttachmentCapabilityProvider({
    pick: async () => {
      calls += 1;
      return file;
    },
  });

  await expect(
    provider.invoke({name: 'photos.select', input: {uri: 'file:///tmp/a.jpg'}}),
  ).rejects.toMatchObject({code: 'invalid_protocol'});
  expect(calls).toBe(0);
});

test('rejects capabilities outside the file and photo picker contract', async () => {
  const provider = new AttachmentCapabilityProvider({pick: async () => file});

  await expect(provider.invoke({name: 'camera.capture'})).rejects.toMatchObject({
    code: 'unsupported',
  });
});

test('revalidates PickerProvider output before returning it', async () => {
  const provider = new AttachmentCapabilityProvider({
    pick: async () => ({...file, data: 'bad\0value'}),
  });

  await expect(provider.invoke({name: 'file.pick'})).rejects.toMatchObject({
    code: 'unsupported',
  });
});
