import {RemoteCapabilityRuntime} from '../runtime/capability/RemoteCapabilityRuntime';
import type {CapabilityRuntime} from '../runtime/capability/CapabilityRuntime';

test('remote capability invocation returns to the local runtime with caller and scope metadata', async () => {
  const requests: unknown[] = [];
  const local: CapabilityRuntime = {
    invoke: async request => {requests.push(request); return {ok: true};},
  };
  const runtime = new RemoteCapabilityRuntime(local, 'mobile-1');

  await expect(runtime.invoke({
    trusted: true,
    remoteDeviceId: 'desktop-1',
    taskId: 'task-1',
    capability: 'camera.capture',
    scope: {kind: 'task', id: 'task-1'},
    input: {quality: 'preview'},
  })).resolves.toEqual({ok: true});
  expect(requests[0]).toMatchObject({caller: 'remote-node', deviceId: 'mobile-1', taskId: 'task-1', name: 'camera.capture', scope: {kind: 'task', id: 'task-1'}});
});

test('trust removal blocks remote capability invocation before local provider access', async () => {
  let calls = 0;
  const runtime = new RemoteCapabilityRuntime({invoke: async () => {calls += 1; return null;}}, 'mobile-1');
  await expect(runtime.invoke({trusted: false, remoteDeviceId: 'desktop-1', capability: 'camera.capture', scope: {kind: 'device', id: 'mobile-1'}})).rejects.toMatchObject({code: 'unauthorized'});
  expect(calls).toBe(0);
});

test('unknown remote event is rejected without a provider-side escape hatch', async () => {
  const runtime = new RemoteCapabilityRuntime({invoke: async request => ({name: request.name})}, 'mobile-1');
  await expect(runtime.invoke({trusted: true, remoteDeviceId: 'desktop-1', capability: 'shell.exec', scope: {kind: 'device', id: 'mobile-1'}})).rejects.toMatchObject({code: 'permission_denied'});
});
