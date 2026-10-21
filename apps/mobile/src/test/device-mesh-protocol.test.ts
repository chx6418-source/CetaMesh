import {CetaError} from '../shared/errors/CetaError';
import {
  validateCapabilityManifest,
  validateNodeRole,
  validateTrustMetadata,
} from '../protocol/DeviceMeshProtocol';

describe('Device Mesh protocol v1.1', () => {
  test('rejects an unknown node role fail-closed', () => {
    expect(() => validateNodeRole('gateway-node')).toThrow(CetaError);
  });

  test('accepts bounded capability advertisements without granting permission', () => {
    const manifest = validateCapabilityManifest({
      deviceId: 'peer-1',
      role: 'desktop-node',
      manifestVersion: 1,
      capabilities: [
        {capabilityId: 'camera.capture', version: 1, availability: 'available'},
        {capabilityId: 'future.vendor-capability', version: 2, availability: 'degraded'},
      ],
    });

    expect(manifest.capabilities).toHaveLength(2);
    expect(manifest.capabilities[1].capabilityId).toBe('future.vendor-capability');
    expect(manifest.capabilities[1]).not.toHaveProperty('authorized');
  });

  test('rejects oversized or malformed capability advertisements', () => {
    expect(() =>
      validateCapabilityManifest({
        deviceId: 'peer-1',
        role: 'desktop-node',
        manifestVersion: 1,
        capabilities: Array.from({length: 65}, (_, index) => ({
          capabilityId: `vendor.capability.${index}`,
          version: 1,
          availability: 'available',
        })),
      }),
    ).toThrow(CetaError);

    expect(() =>
      validateCapabilityManifest({
        deviceId: 'peer-1',
        role: 'desktop-node',
        manifestVersion: 1,
        capabilities: [{capabilityId: 'bad capability', version: 1, availability: 'available'}],
      }),
    ).toThrow(CetaError);
  });

  test('validates trust metadata without treating presence as trust', () => {
    expect(
      validateTrustMetadata({
        trustState: 'stale',
        transportType: 'lan',
        pairedAt: '2026-09-30T00:00:00.000Z',
        lastSeenAt: '2026-09-30T00:01:00.000Z',
        peerRole: 'desktop-node',
      }),
    ).toMatchObject({trustState: 'stale', transportType: 'lan'});
  });
});
