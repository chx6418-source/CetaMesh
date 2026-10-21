import { PickerProvider } from '../native/files/PickerProvider';
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));
jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  types: { plainText: 'text/plain' },
  isErrorWithCode: () => false,
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
}));
jest.mock('react-native-blob-util', () => ({
  fs: { stat: jest.fn(), readFile: jest.fn() },
}));
const selected = {
  uri: 'content://picker/selected.txt',
  name: 'note.txt',
  mime: 'text/plain',
  size: 5,
};
test('content document is copied to an owned local URI before stat/read and removed afterwards', async () => {
  const steps: string[] = [];
  const picker = new PickerProvider({
    select: async () => ({
      ...selected,
      uri: 'content://documents/document/primary%3ADownload%2Fnote.txt',
    }),
    localCopy: async uri => {
      steps.push('copy:' + uri);
      return 'file:///app/cache/picked.txt';
    },
    stat: async uri => {
      steps.push('stat:' + uri);
      return 5;
    },
    read: async uri => {
      steps.push('read:' + uri);
      return 'hello';
    },
    remove: async uri => {
      steps.push('remove:' + uri);
    },
  });
  expect((await picker.pick('file.pick')).data).toBe('hello');
  expect(steps).toEqual([
    'copy:content://documents/document/primary%3ADownload%2Fnote.txt',
    'stat:file:///app/cache/picked.txt',
    'read:file:///app/cache/picked.txt',
    'remove:file:///app/cache/picked.txt',
  ]);
});
test('picker only reads the selected bounded URI and copies bytes instead of persisting a path', async () => {
  const seen: string[] = [];
  const picker = new PickerProvider({
    select: async () => selected,
    localCopy: async () => 'file:///app/cache/selected.txt',
    remove: async () => {},
    stat: async () => 5,
    read: async uri => {
      seen.push(uri);
      return 'hello';
    },
  });
  const result = await picker.pick('file.pick');
  expect(result).toMatchObject({ kind: 'text', data: 'hello', size: 5 });
  expect(result).not.toHaveProperty('uri');
  expect(seen).toEqual(['file:///app/cache/selected.txt']);
});
test('unsafe URI, unsupported MIME and oversized stat fail before file read', async () => {
  for (const bad of [
    { ...selected, uri: 'https://example.com/x' },
    { ...selected, mime: 'application/x-executable' },
    { ...selected, size: 500000 },
  ]) {
    let read = false;
    const picker = new PickerProvider({
      select: async () => bad,
      localCopy: async () => 'file:///app/cache/selected.txt',
      remove: async () => {},
      stat: async () => 500000,
      read: async () => {
        read = true;
        return 'hello';
      },
    });
    await expect(picker.pick('file.pick')).rejects.toThrow();
    expect(read).toBe(false);
  }
});
