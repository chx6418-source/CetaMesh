import {CapabilityRouterRuntime} from '../runtime/capability/CapabilityRouterRuntime';
import type {CapabilityAuditEvent} from '../domain/capability/CapabilityAudit';
import {InMemoryCapabilityPolicy} from '../security/CapabilityPolicy';

const descriptor = {
  name: 'camera.capture' as const,
  version: 1,
  platforms: ['android', 'ios'] as const,
  requiresPermission: true,
};

test('audit events contain correlation and scope ids but never request payloads', async () => {
  const events: CapabilityAuditEvent[] = [];
  const runtime = new CapabilityRouterRuntime(
    [{
      listCapabilities: () => [descriptor],
      invoke: async request => ({name: request.name, output: {ok: true}}),
    }],
    new InMemoryCapabilityPolicy(async () => 'allow-once', {modes: {'camera.capture': 'ask'}}),
    'android',
    {record: event => events.push(event)},
  );

  await runtime.invoke({
    name: 'camera.capture',
    input: {apiKey: 'do-not-log', image: 'private-bytes'},
    caller: 'task-runtime',
    deviceId: 'mobile-1',
    taskId: 'task-1',
    scope: {kind: 'task', id: 'task-1'},
    context: {eventId: 'event-1', traceId: 'trace-1', taskId: 'task-1'},
  });

  expect(events.map(event => event.type)).toEqual(['requested', 'approval_required', 'started', 'completed']);
  expect(events[0]).toMatchObject({
    requestId: 'event-1',
    caller: 'task-runtime',
    deviceId: 'mobile-1',
    taskId: 'task-1',
    scope: {kind: 'task', id: 'task-1'},
  });
  expect(JSON.stringify(events)).not.toContain('do-not-log');
  expect(JSON.stringify(events)).not.toContain('private-bytes');
});

test('a denied scoped request is audited without invoking the provider', async () => {
  const events: CapabilityAuditEvent[] = [];
  let providerCalls = 0;
  const runtime = new CapabilityRouterRuntime(
    [{
      listCapabilities: () => [descriptor],
      invoke: async request => {
        providerCalls += 1;
        return {name: request.name, output: null};
      },
    }],
    new InMemoryCapabilityPolicy(async () => 'deny'),
    'android',
    {record: event => events.push(event)},
  );

  await expect(
    runtime.invoke({name: 'camera.capture', caller: 'remote-node', scope: {kind: 'device', id: 'mobile-1'}}),
  ).rejects.toMatchObject({code: 'permission_denied'});
  expect(providerCalls).toBe(0);
  expect(events.map(event => event.type)).toEqual(['requested', 'denied']);
});
