import type {ExtensionManifest} from '../domain/extension/ExtensionManifest';
import type {ExtensionPackagePicker} from '../domain/extension/ExtensionPackagePicker';
import type {ExtensionRepository, InstalledExtension} from '../domain/extension/ExtensionRepository';
import {ExtensionInstallRuntime} from '../runtime/extension/ExtensionInstallRuntime';
import {ExtensionLifecycleRuntime} from '../runtime/extension/ExtensionLifecycleRuntime';
import {ExtensionImportRuntime} from '../runtime/extension/ExtensionImportRuntime';

const manifest: ExtensionManifest = {
  id: 'tool.weather',
  name: 'Weather Tool',
  version: '1.0.0',
  type: 'declarative-tool',
  publisher: 'publisher-1',
  platforms: ['android', 'ios'],
  runtime: 'declarative',
  permissions: [{capability: 'camera.capture', scope: {kind: 'local'}}],
  capabilities: ['camera.capture'],
  networkAccess: {mode: 'none'},
  inputSchema: {type: 'object'},
  outputSchema: {type: 'object'},
  minimumProtocolVersion: 1,
};

class FakeExtensionRepository implements ExtensionRepository {
  readonly records = new Map<string, InstalledExtension>();
  async get(id: string, source: InstalledExtension['source']) {return this.records.get(`${id}:${source}`);}
  async save(extension: InstalledExtension) {this.records.set(`${extension.id}:${extension.source}`, extension); return extension;}
  async remove(id: string, source: InstalledExtension['source']) {this.records.delete(`${id}:${source}`);}
  async list() {return [...this.records.values()];}
}

test('import review lists requested permissions and only installs after explicit consent', async () => {
  const repository = new FakeExtensionRepository();
  const lifecycle = new ExtensionLifecycleRuntime(repository, new ExtensionInstallRuntime(repository));
  const picker: ExtensionPackagePicker = {pick: async () => ({name: 'weather.json', text: JSON.stringify(manifest)})};
  const importer = new ExtensionImportRuntime(lifecycle, picker);

  const candidate = await importer.prepareImport();
  expect(candidate).toMatchObject({
    fileName: 'weather.json',
    manifest: {id: manifest.id, name: manifest.name},
    addedPermissions: [{capability: 'camera.capture'}],
    requiresPermissionConfirmation: true,
  });
  await expect(importer.install(candidate, false)).rejects.toMatchObject({code: 'permission_denied'});
  const installed = await importer.install(candidate, true);
  expect(installed).toMatchObject({
    source: 'import',
    status: 'disabled',
    securityReport: {signatureState: 'unsigned', requiresPermissionConfirmation: true},
  });
  await expect(lifecycle.list()).resolves.toEqual([installed]);
});

test('an imported update reports permission additions and cannot bypass reapproval', async () => {
  const repository = new FakeExtensionRepository();
  const lifecycle = new ExtensionLifecycleRuntime(repository, new ExtensionInstallRuntime(repository));
  await lifecycle.install({manifest: {...manifest, permissions: [], capabilities: []}, source: 'import'});
  let selected = {...manifest, version: '2.0.0'};
  const picker: ExtensionPackagePicker = {pick: async () => ({name: 'weather-v2.json', text: JSON.stringify(selected)})};
  const importer = new ExtensionImportRuntime(lifecycle, picker);

  const candidate = await importer.prepareImport();
  expect(candidate).toMatchObject({existingVersion: '1.0.0', requiresPermissionConfirmation: true});
  await expect(importer.install(candidate, false)).rejects.toMatchObject({code: 'permission_denied'});
  await importer.install(candidate, true);
  expect(await lifecycle.get(manifest.id, 'import')).toMatchObject({
    manifest: {version: '2.0.0'},
    previousManifest: {version: '1.0.0'},
    securityReport: {addedPermissions: [{capability: 'camera.capture'}], requiresPermissionConfirmation: true},
  });

  selected = {...manifest, version: '3.0.0', inputSchema: {script: 'no'}};
  await expect(importer.prepareImport()).rejects.toMatchObject({code: 'unsupported'});
});
