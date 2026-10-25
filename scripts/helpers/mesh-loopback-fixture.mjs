// Socket protocol fixtures must not enumerate or advertise the host's real LAN.
// Only the OS enumeration boundary is replaced; TLS, pinning, signatures,
// listeners and protocol requests still execute their production paths.
import os from 'node:os';

export function installMeshLoopbackFixture() {
  const original = os.networkInterfaces;
  os.networkInterfaces = () => ({
    'controlled-fixture': [{ family: 'IPv4', address: '127.0.0.1', internal: false }]
  });
  return () => { os.networkInterfaces = original; };
}
