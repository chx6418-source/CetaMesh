import {CapabilityRouterRuntime} from '../runtime/capability/CapabilityRouterRuntime';
import type {
  CapabilityDescriptor,
} from '../domain/capability/Capability';
import type {
  CapabilityGrant,
  CapabilityPolicy,
} from '../security/CapabilityPolicy';
import {InMemoryCapabilityPolicy} from '../security/CapabilityPolicy';
import {CetaError} from '../shared/errors/CetaError';

const camera: CapabilityDescriptor = {
  name: 'camera.capture',
  version: 1,
  platforms: ['android', 'ios'],
  requiresPermission: true,
};

function allowPolicy(calls: string[]): CapabilityPolicy {
  const grant: CapabilityGrant = {name: camera.name, expiresAt: 1000};
  return {
    authorize: async (request, descriptor) => {
      calls.push(`authorize:${request.name}:${descriptor.name}`);
      return grant;
    },
    consume: received => {
      calls.push(`consume:${received.name}`);
    },
  };
}

test('routes an advertised capability only after policy authorization', async () => {
  const calls: string[] = [];
  const runtime = new CapabilityRouterRuntime(
    [
      {
        listCapabilities: () => [camera],
        invoke: async request => {
          calls.push(`provider:${request.name}`);
          return {name: request.name, output: {uri: 'content://photo/1'}};
        },
      },
    ],
    allowPolicy(calls),
    'android',
  );

  expect(runtime.listCapabilities()).toEqual([camera]);
  await expect(
    runtime.invoke({name: 'camera.capture', input: {quality: 'preview'}}),
  ).resolves.toEqual({name: 'camera.capture', output: {uri: 'content://photo/1'}});
  expect(calls).toEqual([
    'authorize:camera.capture:camera.capture',
    'consume:camera.capture',
    'provider:camera.capture',
  ]);
});

test('the concrete policy prompt remains in front of the provider', async () => {
  const calls: string[] = [];
  const runtime = new CapabilityRouterRuntime(
    [
      {
        listCapabilities: () => [camera],
        invoke: async request => {
          calls.push('provider');
          return {name: request.name, output: 'captured'};
        },
      },
    ],
    new InMemoryCapabilityPolicy(
      async () => {
        calls.push('prompt');
        return 'allow-once';
      },
      {modes: {[camera.name]: 'ask'}},
    ),
    'android',
  );

  await expect(runtime.invoke({name: camera.name})).resolves.toMatchObject({
    output: 'captured',
  });
  expect(calls).toEqual(['prompt', 'provider']);
});

test('unknown capability is denied before policy or provider access', async () => {
  let policyCalls = 0;
  let providerCalls = 0;
  const runtime = new CapabilityRouterRuntime(
    [
      {
        listCapabilities: () => [camera],
        invoke: async request => {
          providerCalls += 1;
          return {name: request.name, output: null};
        },
      },
    ],
    {
      authorize: async () => {
        policyCalls += 1;
        return {name: camera.name, expiresAt: 1000};
      },
      consume: () => undefined,
    },
    'android',
  );

  await expect(runtime.invoke({name: 'shell.exec'})).rejects.toMatchObject({
    code: 'permission_denied',
  });
  expect(policyCalls).toBe(0);
  expect(providerCalls).toBe(0);
});

test('known capability without a provider is unsupported on the current platform', async () => {
  let providerCalls = 0;
  const runtime = new CapabilityRouterRuntime(
    [
      {
        listCapabilities: () => [camera],
        invoke: async request => {
          providerCalls += 1;
          return {name: request.name, output: null};
        },
      },
    ],
    {
      authorize: async () => ({name: camera.name, expiresAt: 1000}),
      consume: () => undefined,
    },
    'ios',
  );

  await expect(runtime.invoke({name: 'microphone.record'})).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(providerCalls).toBe(0);
});

test('policy denial prevents provider invocation and provider errors stay bounded', async () => {
  let providerCalls = 0;
  const denied = new CapabilityRouterRuntime(
    [
      {
        listCapabilities: () => [camera],
        invoke: async request => {
          providerCalls += 1;
          return {name: request.name, output: null};
        },
      },
    ],
    {
      authorize: async () => {
        throw new CetaError('permission_denied', 'Denied');
      },
      consume: () => undefined,
    },
    'android',
  );
  await expect(denied.invoke({name: camera.name})).rejects.toMatchObject({
    code: 'permission_denied',
  });
  expect(providerCalls).toBe(0);

  const malformed = new CapabilityRouterRuntime(
    [
      {
        listCapabilities: () => [camera],
        invoke: async () => ({name: 'camera.capture'} as unknown as {name: string; output: unknown}),
      },
    ],
    allowPolicy([]),
    'android',
  );
  await expect(malformed.invoke({name: camera.name})).rejects.toMatchObject({
    code: 'invalid_protocol',
  });
});

test('duplicate active providers fail closed at registration', () => {
  expect(
    () =>
      new CapabilityRouterRuntime(
        [
          {listCapabilities: () => [camera], invoke: async request => ({name: request.name, output: 1})},
          {listCapabilities: () => [camera], invoke: async request => ({name: request.name, output: 2})},
        ],
        allowPolicy([]),
        'android',
      ),
  ).toThrow('Multiple providers advertise the same capability');
});

test('native permission denial is preserved as permission_denied', async () => {
  const runtime = new CapabilityRouterRuntime(
    [
      {
        listCapabilities: () => [camera],
        invoke: async () => {
          throw new CetaError('permission_denied', 'OS denied camera');
        },
      },
    ],
    allowPolicy([]),
    'android',
  );

  await expect(runtime.invoke({name: camera.name})).rejects.toMatchObject({
    code: 'permission_denied',
  });
});

test('a grant bound to different request metadata cannot reach the provider', async () => {
  let providerCalls = 0;
  const runtime = new CapabilityRouterRuntime(
    [{
      listCapabilities: () => [camera],
      invoke: async request => {
        providerCalls += 1;
        return {name: request.name, output: 'captured'};
      },
    }],
    {
      authorize: async () => ({name: camera.name, expiresAt: 1000, caller: 'other-task', taskId: 'task-2', scope: {kind: 'task', id: 'task-2'}}),
      consume: () => undefined,
    },
    'android',
  );

  await expect(runtime.invoke({name: camera.name, caller: 'task-runtime', taskId: 'task-1', scope: {kind: 'task', id: 'task-1'}})).rejects.toMatchObject({code: 'permission_denied'});
  expect(providerCalls).toBe(0);
});
