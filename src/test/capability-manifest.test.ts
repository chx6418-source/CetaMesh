import {CapabilityManifestRuntime} from '../runtime/capability/CapabilityManifestRuntime';

test('builds a mobile capability manifest with provider-neutral policy metadata', () => {
  const runtime = new CapabilityManifestRuntime(
    [
      {
        listCapabilities: () => [
          {
            name: 'camera.capture',
            version: 1,
            platforms: ['android', 'ios'],
            requiresPermission: true,
          },
        ],
        invoke: async request => ({name: request.name, output: null}),
      },
    ],
    {deviceId: 'mobile-1', role: 'mobile-node'},
  );

  expect(runtime.getManifest()).toEqual({
    deviceId: 'mobile-1',
    role: 'mobile-node',
    manifestVersion: 1,
    capabilities: [
      expect.objectContaining({
        name: 'camera.capture',
        version: 1,
        risk: 'high',
        availability: 'available',
        approvalPolicy: 'ask',
        providerId: 'camera.capture',
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
      }),
    ],
  });
});

test('manifest generation fails closed for duplicate capability names', () => {
  const runtime = new CapabilityManifestRuntime(
        [
          {
            listCapabilities: () => [
              {name: 'camera.capture', version: 1, platforms: ['android'], requiresPermission: true},
            ],
            invoke: async request => ({name: request.name, output: null}),
          },
          {
            listCapabilities: () => [
              {name: 'camera.capture', version: 1, platforms: ['android'], requiresPermission: true},
            ],
            invoke: async request => ({name: request.name, output: null}),
          },
        ],
        {deviceId: 'mobile-1', role: 'mobile-node'},
      );

  expect(() => runtime.getManifest()).toThrow('Multiple providers advertise the same capability');
});
