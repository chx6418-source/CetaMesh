import {ExtensionPackagePickerProvider, type ExtensionPackagePickerDriver} from '../native/files/ExtensionPackagePickerProvider';

function fakeDriver(overrides: Partial<ExtensionPackagePickerDriver> = {}) {
  const calls = {removed: [] as string[], copied: [] as string[]};
  const driver: ExtensionPackagePickerDriver = {
    pick: async () => ({uri: 'content://documents/manifest.json', name: 'manifest.json', mime: 'application/json', size: 15}),
    localCopy: async uri => {calls.copied.push(uri); return 'file:///cache/extension.json';},
    stat: async () => 15,
    read: async () => '{"id":"tool.demo"}',
    remove: async uri => {calls.removed.push(uri);},
    ...overrides,
  };
  return {driver, calls};
}

test('extension package picker returns selected JSON text and cleans its cache copy', async () => {
  const {driver, calls} = fakeDriver();
  await expect(new ExtensionPackagePickerProvider(driver).pick()).resolves.toEqual({name: 'manifest.json', text: '{"id":"tool.demo"}'});
  expect(calls.copied).toEqual(['content://documents/manifest.json']);
  expect(calls.removed).toEqual(['file:///cache/extension.json']);
});

test('extension package picker rejects oversized documents and removes rejected cache copies', async () => {
  const {driver, calls} = fakeDriver({stat: async () => 1_048_577});
  await expect(new ExtensionPackagePickerProvider(driver).pick()).rejects.toMatchObject({code: 'unsupported'});
  expect(calls.removed).toEqual(['file:///cache/extension.json']);
});

test('extension package picker rejects unsafe URIs before reading', async () => {
  const {driver, calls} = fakeDriver({pick: async () => ({uri: 'file:///../private.json', name: 'private.json', mime: 'application/json', size: 15})});
  await expect(new ExtensionPackagePickerProvider(driver).pick()).rejects.toMatchObject({code: 'permission_denied'});
  expect(calls.copied).toEqual([]);
  expect(calls.removed).toEqual([]);
});
