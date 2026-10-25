import type {ExtensionManifest} from '../domain/extension/ExtensionManifest';
import type {
  ExtensionRepository,
  InstalledExtension,
} from '../domain/extension/ExtensionRepository';
import {ExtensionInstallRuntime} from '../runtime/extension/ExtensionInstallRuntime';
import {
  ExtensionLifecycleRuntime,
  permissionDiff,
} from '../runtime/extension/ExtensionLifecycleRuntime';

const manifest: ExtensionManifest = {
  id: 'tool.weather',
  name: 'Weather Tool',
  version: '1.0.0',
  type: 'declarative-tool',
  publisher: 'publisher-1',
  platforms: ['android', 'ios'],
  runtime: 'declarative',
  permissions: [],
  capabilities: [],
  networkAccess: {mode: 'none'},
  inputSchema: {type: 'object'},
  outputSchema: {type: 'object'},
  minimumProtocolVersion: 1,
};

class FakeExtensionRepository implements ExtensionRepository {
  readonly records = new Map<string, InstalledExtension>();

  private key(extensionId: string, source: InstalledExtension['source']): string {
    return `${extensionId}:${source}`;
  }

  async get(extensionId: string, source: InstalledExtension['source']): Promise<InstalledExtension | undefined> {
    return this.records.get(this.key(extensionId, source));
  }

  async save(extension: InstalledExtension): Promise<InstalledExtension> {
    this.records.set(this.key(extension.id, extension.source), extension);
    return extension;
  }

  async remove(extensionId: string, source: InstalledExtension['source']): Promise<void> {
    this.records.delete(this.key(extensionId, source));
  }

  async list(): Promise<InstalledExtension[]> {
    return [...this.records.values()];
  }
}

const clock = () => Date.parse('2026-09-30T00:00:00.000Z');

function cameraManifest(version = '1.1.0'): ExtensionManifest {
  return {
    ...manifest,
    version,
    permissions: [{capability: 'camera.capture', scope: {kind: 'local'}}],
    capabilities: ['camera.capture'],
  };
}

test('lifecycle transitions state and rolls an update back to the prior manifest', async () => {
  const repository = new FakeExtensionRepository();
  const install = new ExtensionInstallRuntime(repository, undefined, clock);
  const lifecycle = new ExtensionLifecycleRuntime(repository, install, clock);

  await lifecycle.install({manifest, source: 'base'});
  await expect(lifecycle.enable(manifest.id, 'base')).resolves.toMatchObject({status: 'enabled', revision: 2});
  await expect(lifecycle.disable(manifest.id, 'base')).resolves.toMatchObject({status: 'disabled', revision: 3});

  await lifecycle.update({manifest: {...manifest, version: '1.1.0'}, source: 'base'});
  await expect(lifecycle.get(manifest.id, 'base')).resolves.toMatchObject({manifest: {...manifest, version: '1.1.0'}});
  await expect(lifecycle.rollback(manifest.id, 'base')).resolves.toMatchObject({manifest, status: 'disabled'});
});

test('new high-risk permissions require explicit confirmation', async () => {
  const diff = permissionDiff(manifest, cameraManifest());
  expect(diff.added).toEqual([{capability: 'camera.capture', scope: {kind: 'local'}}]);
  expect(diff.requiresConfirmation).toBe(true);

  const repository = new FakeExtensionRepository();
  const install = new ExtensionInstallRuntime(repository, undefined, clock);
  const lifecycle = new ExtensionLifecycleRuntime(repository, install, clock);
  await lifecycle.install({manifest, source: 'user-overlay'});

  await expect(lifecycle.update({manifest: cameraManifest(), source: 'user-overlay'})).rejects.toMatchObject({code: 'permission_denied'});
  await expect(lifecycle.update({manifest: cameraManifest(), source: 'user-overlay', acceptPermissionEscalation: true})).resolves.toMatchObject({
    securityReport: {requiresPermissionConfirmation: true, addedPermissions: [{capability: 'camera.capture'}]},
  });
});

test('base package and user overlay remain isolated records', async () => {
  const repository = new FakeExtensionRepository();
  const install = new ExtensionInstallRuntime(repository, undefined, clock);
  const lifecycle = new ExtensionLifecycleRuntime(repository, install, clock);

  await lifecycle.install({manifest, source: 'base'});
  await lifecycle.install({manifest: {...manifest, name: 'User Weather'}, source: 'user-overlay'});
  await lifecycle.remove(manifest.id, 'user-overlay');

  await expect(lifecycle.get(manifest.id, 'base')).resolves.toMatchObject({source: 'base', manifest});
  await expect(lifecycle.get(manifest.id, 'user-overlay')).resolves.toBeUndefined();
});
