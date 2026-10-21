import {validatePushPayload} from '../runtime/task/PushAttentionRuntime';
import {MemorySyncRuntime} from '../runtime/sync/MemorySyncRuntime';
import {RemoteCapabilityRuntime} from '../runtime/capability/RemoteCapabilityRuntime';
import {ExtensionValidationRuntime} from '../runtime/extension/ExtensionValidationRuntime';
import {MemoryPackReader} from '../runtime/extension/MemoryPackReader';

test('M5 push input is opaque and never carries task content', () => {
  expect(validatePushPayload({kind: 'task.updated', taskId: 'task-1'})).toMatchObject({kind: 'task.updated', taskId: 'task-1'});
  expect(() => validatePushPayload({kind: 'task.updated', taskId: 'task-1', goal: 'private content'})).toThrow();
});

test('M6 scope and local capability policy fail closed before provider access', async () => {
  let memoryReads = 0;
  const memory = new MemorySyncRuntime({get: async () => {memoryReads += 1; return undefined;}, upsert: async () => undefined}, async () => false);
  await expect(memory.apply({objectType: 'memory', memoryId: 'memory-1', ownerId: 'mobile-1', scopeType: 'local-only' as never, scopeId: 'mesh-1', revision: 1, source: 'manual', policy: 'my-devices', updatedAt: '2026-09-30T00:00:00.000Z'})).resolves.toMatchObject({status: 'denied'});
  expect(memoryReads).toBe(0);

  let capabilityCalls = 0;
  const remote = new RemoteCapabilityRuntime({invoke: async () => {capabilityCalls += 1; return undefined;}}, 'mobile-1');
  await expect(remote.invoke({trusted: true, remoteDeviceId: 'desktop-1', capability: 'shell.exec', scope: {kind: 'device', id: 'mobile-1'}})).rejects.toMatchObject({code: 'permission_denied'});
  expect(capabilityCalls).toBe(0);
});

test('M8 extension data remains declarative, untrusted, and read-only', () => {
  const manifest = {
    id: 'tool.safe',
    name: 'Safe Tool',
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
  expect(() => new ExtensionValidationRuntime().validateManifest({...manifest, script: 'never execute'})).toThrow();
  const pack = new MemoryPackReader().read({manifest: {id: 'pack-1', name: 'Notes', version: '1.0.0'}, memories: [], entities: [], relations: []});
  expect(pack).toMatchObject({origin: 'third_party', trust: 'untrusted', readOnly: true});
});
