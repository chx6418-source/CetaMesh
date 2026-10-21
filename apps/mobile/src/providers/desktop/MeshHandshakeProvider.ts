import {validateMeshHandshake, type MeshHandshake} from '../../protocol/DeviceMeshProtocol';
import {identifier} from '../../protocol/PairingProtocol';
import {CetaError} from '../../shared/errors/CetaError';
import type {NodeRole} from '../../domain/device/NodeRole';

export class MeshHandshakeProvider {
  create(
    identity: {readonly deviceId: string; readonly role: NodeRole},
    manifestVersion: number,
    supportedEventVersions: readonly number[],
    syncCursor?: string,
  ): MeshHandshake {
    identifier(identity.deviceId);
    if (!Number.isInteger(manifestVersion) || manifestVersion < 1 || supportedEventVersions.length < 1 || supportedEventVersions.length > 32) {
      throw new CetaError('invalid_protocol', 'Invalid mesh handshake metadata');
    }
    return validateMeshHandshake({
      protocolVersion: 1,
      deviceId: identity.deviceId,
      nodeRole: identity.role,
      capabilityManifestVersion: manifestVersion,
      supportedEventVersions: [...supportedEventVersions],
      ...(syncCursor === undefined ? {} : {syncCursor}),
    });
  }
}
