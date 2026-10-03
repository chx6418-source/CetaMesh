import {CetaError} from '../shared/errors/CetaError';
import {TrustedTransportRuntime} from '../runtime/sync/TrustedTransportRuntime';
import {TrustedHttpClient} from '../providers/network/TrustedHttpClient';
import {WebSocketClient, validateMeshFrame} from '../providers/network/WebSocketClient';
import {MeshHandshakeProvider} from '../providers/desktop/MeshHandshakeProvider';
import type {DeviceTrust} from '../domain/device/DeviceTrust';

const trust: DeviceTrust = {
  deviceId: 'peer-1',
  deviceName: 'Desktop',
  publicKey: 'B' + 'A'.repeat(86) + '=',
  endpoint: 'https://desktop.example',
  localDeviceId: 'mobile-1',
  localPublicKey: 'B' + 'A'.repeat(86) + '=',
  createdAt: '2026-09-30T00:00:00.000Z',
  trustState: 'trusted',
  transportType: 'lan',
  peerRole: 'desktop-node',
  protocolVersion: 1,
  capabilityManifestVersion: 1,
};

const handshake = {
  protocolVersion: 1 as const,
  deviceId: 'peer-1',
  nodeRole: 'desktop-node' as const,
  capabilityManifestVersion: 1,
  supportedEventVersions: [1],
  syncCursor: 'cursor-1',
};

test('trusted bootstrap checks trust, protocol, role, and manifest before connection', () => {
  const runtime = new TrustedTransportRuntime();
  expect(runtime.assertTrustedHandshake(trust, handshake)).toBe(true);
  expect(() => runtime.assertTrustedHandshake({...trust, trustState: 'stale'}, handshake)).toThrow(CetaError);
  expect(() => runtime.assertTrustedHandshake(trust, {...handshake, nodeRole: 'server-node'})).toThrow(CetaError);
  expect(() => runtime.assertTrustedHandshake(trust, {...handshake, capabilityManifestVersion: 2})).toThrow(CetaError);
  expect(() => runtime.assertTrustedHandshake(trust, {...handshake, deviceId: 'other-device'})).toThrow(CetaError);
});

test('handshake provider creates bounded metadata and rejects oversized cursors', () => {
  const provider = new MeshHandshakeProvider();
  expect(provider.create({deviceId: 'mobile-1', role: 'mobile-node'}, 1, [1], 'cursor-1')).toMatchObject({
    protocolVersion: 1,
    nodeRole: 'mobile-node',
    capabilityManifestVersion: 1,
  });
  expect(() => provider.create({deviceId: 'mobile-1', role: 'mobile-node'}, 1, [1], 'x'.repeat(257))).toThrow(CetaError);
});

test('trusted HTTP client uses only the trusted origin and a bounded relative path', async () => {
  const requests: unknown[] = [];
  const client = new TrustedHttpClient({
    json: async request => {
      requests.push(request);
      return {ok: true};
    },
    stream: async function* () {yield '';},
  });
  await expect(client.json({trust, path: '/mesh/handshake', body: {hello: true}, authToken: 'secret-token'})).resolves.toEqual({ok: true});
  expect(requests[0]).toMatchObject({url: 'https://desktop.example/mesh/handshake', headers: {authorization: 'Bearer secret-token'}});
  await expect(client.json({trust, path: 'https://evil.example/steal'})).rejects.toMatchObject({code: 'invalid_protocol'});
  await expect(client.json({trust, path: '/mesh/handshake', body: (() => undefined) as unknown as () => undefined})).rejects.toMatchObject({code: 'invalid_protocol'});
  await expect(client.json({trust: {...trust, trustState: 'revoked'}, path: '/mesh/handshake'})).rejects.toMatchObject({code: 'unauthorized'});
});

test('WebSocket frames and reconnection delays are bounded and cursor-aware', () => {
  expect(validateMeshFrame({kind: 'event', sequence: 1, cursor: 'cursor-1', payload: {eventId: 'e-1'}})).toMatchObject({sequence: 1, cursor: 'cursor-1'});
  expect(() => validateMeshFrame({kind: 'event', sequence: 1, payload: 'x'.repeat(70_000)})).toThrow(CetaError);
  expect(() => validateMeshFrame({kind: 'event', sequence: 1, payload: (() => undefined) as unknown as () => undefined})).toThrow(CetaError);
  expect(() => validateMeshFrame({kind: 'unknown', sequence: 1})).toThrow(CetaError);
  const client = new WebSocketClient(() => ({send: () => undefined, close: () => undefined}));
  expect(client.reconnectDelay(0)).toBe(500);
  expect(client.reconnectDelay(8)).toBeLessThanOrEqual(30_000);
});
