import {
  InMemoryCapabilityPolicy,
} from '../security/CapabilityPolicy';
import type {CapabilityDescriptor} from '../domain/capability/Capability';

const descriptor: CapabilityDescriptor = {
  name: 'camera.capture',
  version: 1,
  platforms: ['android', 'ios'],
  requiresPermission: true,
};

test('unknown capabilities default to deny without invoking the prompt', async () => {
  let prompts = 0;
  const policy = new InMemoryCapabilityPolicy(async () => {
    prompts += 1;
    return 'allow-once';
  });

  await expect(
    policy.authorize({name: 'shell.exec'}, descriptor),
  ).rejects.toMatchObject({code: 'permission_denied'});
  expect(prompts).toBe(0);
});

test('deny mode blocks access before a grant is created', async () => {
  let prompts = 0;
  const policy = new InMemoryCapabilityPolicy(async () => {
    prompts += 1;
    return 'allow-once';
  });

  await expect(
    policy.authorize({name: descriptor.name}, descriptor),
  ).rejects.toMatchObject({code: 'permission_denied'});
  expect(prompts).toBe(0);
});

test('ask prompts for an explicit one-time decision and rejects a denial', async () => {
  const decisions: Array<'deny' | 'allow-once'> = ['allow-once', 'deny'];
  const policy = new InMemoryCapabilityPolicy(
    async request => {
      expect(request.name).toBe(descriptor.name);
      return decisions.shift() ?? 'deny';
    },
    {modes: {[descriptor.name]: 'ask'}},
  );

  const grant = await policy.authorize({name: descriptor.name}, descriptor);
  policy.consume(grant);
  expect(() => policy.consume(grant)).toThrow();
  await expect(
    policy.authorize({name: descriptor.name}, descriptor),
  ).rejects.toMatchObject({code: 'permission_denied'});
});

test('allow-once creates one grant and returns to ask after use', async () => {
  let now = 100;
  const policy = new InMemoryCapabilityPolicy(
    async () => 'deny',
    {
      modes: {[descriptor.name]: 'allow-once'},
      clock: () => now,
      grantTtlMs: 50,
    },
  );

  const grant = await policy.authorize({name: descriptor.name}, descriptor);
  expect(grant.expiresAt).toBe(150);
  expect(policy.getMode(descriptor.name)).toBe('ask');
  now = 151;
  expect(() => policy.consume(grant)).toThrow();
  await expect(
    policy.authorize({name: descriptor.name}, descriptor),
  ).rejects.toMatchObject({code: 'permission_denied'});
});

test('a configured unknown capability cannot be turned into an allow rule', () => {
  const policy = new InMemoryCapabilityPolicy(async () => 'allow-once');

  expect(() => policy.setMode('shell.exec', 'allow-once')).toThrow(
    'Unknown capability denied',
  );
  expect(policy.getMode('shell.exec')).toBe('deny');
});

test('request and descriptor names must match', async () => {
  const policy = new InMemoryCapabilityPolicy(async () => 'allow-once', {
    modes: {[descriptor.name]: 'allow-once'},
  });

  await expect(
    policy.authorize({name: 'camera.scanQr'}, descriptor),
  ).rejects.toMatchObject({code: 'permission_denied'});
});

test('prompt failures become standard permission errors', async () => {
  const policy = new InMemoryCapabilityPolicy(async () => {
    throw new Error('prompt implementation detail');
  }, {modes: {[descriptor.name]: 'ask'}});

  await expect(
    policy.authorize({name: descriptor.name}, descriptor),
  ).rejects.toMatchObject({
    code: 'permission_denied',
    message: 'Capability access was not confirmed',
  });
});
