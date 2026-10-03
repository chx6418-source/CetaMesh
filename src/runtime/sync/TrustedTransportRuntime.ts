import type {DeviceTrust} from '../../domain/device/DeviceTrust';
import type {MeshHandshake} from '../../protocol/DeviceMeshProtocol';
import {CetaError} from '../../shared/errors/CetaError';

export class TrustedTransportRuntime {
  assertTrustedHandshake(trust: DeviceTrust, handshake: MeshHandshake): true {
    if ((trust.trustState ?? 'trusted') !== 'trusted') {
      throw new CetaError('unauthorized', 'Device trust is not active');
    }
    if (handshake.deviceId !== trust.deviceId) {
      throw new CetaError('unauthorized', 'Handshake identity does not match trusted device');
    }
    if (handshake.protocolVersion !== (trust.protocolVersion ?? 1)) {
      throw new CetaError('unsupported', 'Peer protocol version is unsupported');
    }
    if (handshake.nodeRole !== (trust.peerRole ?? 'desktop-node')) {
      throw new CetaError('unauthorized', 'Peer node role does not match trust metadata');
    }
    if (handshake.capabilityManifestVersion !== (trust.capabilityManifestVersion ?? 1)) {
      throw new CetaError('sync_conflict', 'Peer capability manifest is stale');
    }
    return true;
  }
}
