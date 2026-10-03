import type {
  CapabilityDescriptor,
  CapabilityProvider,
  CapabilityRisk,
} from '../../domain/capability/Capability';
import type {MobileCapabilityDescriptor, MobileCapabilityManifest} from '../../domain/capability/CapabilityManifest';
import {CetaError} from '../../shared/errors/CetaError';
import {isNodeRole, type NodeRole} from '../../domain/device/NodeRole';
import {identifier} from '../../protocol/PairingProtocol';

function defaultRisk(name: string): CapabilityRisk {
  if (name === 'camera.capture' || name === 'camera.scanDocument' || name === 'camera.scanQr' || name === 'microphone.record') {
    return 'high';
  }
  if (name === 'location.current' || name === 'nfc.read' || name === 'nfc.write' || name === 'bluetooth.scan' || name === 'bluetooth.connect') {
    return 'high';
  }
  return 'medium';
}

function normalize(descriptor: CapabilityDescriptor): MobileCapabilityDescriptor {
  if (!descriptor || !descriptor.name || !Number.isInteger(descriptor.version) || descriptor.version < 1) {
    throw new CetaError('invalid_protocol', 'Invalid capability descriptor');
  }
  return {
    name: descriptor.name,
    version: descriptor.version,
    risk: descriptor.risk ?? defaultRisk(descriptor.name),
    platforms: [...descriptor.platforms],
    availability: descriptor.availability ?? 'available',
    approvalPolicy: descriptor.approvalPolicy ?? (descriptor.requiresPermission ? 'ask' : 'none'),
    providerId: descriptor.providerId ?? descriptor.name,
    inputSchemaVersion: descriptor.inputSchemaVersion ?? 1,
    outputSchemaVersion: descriptor.outputSchemaVersion ?? 1,
  };
}

export class CapabilityManifestRuntime {
  constructor(
    private readonly providers: readonly CapabilityProvider[],
    private readonly identity: {readonly deviceId: string; readonly role: NodeRole},
    private readonly manifestVersion = 1,
  ) {
    identifier(identity.deviceId);
    if (!isNodeRole(identity.role)) {
      throw new CetaError('unsupported', 'Unknown node role');
    }
  }

  getManifest(): MobileCapabilityManifest {
    const seen = new Set<string>();
    const capabilities: MobileCapabilityDescriptor[] = [];
    for (const provider of this.providers) {
      for (const descriptor of provider.listCapabilities()) {
        const normalized = normalize(descriptor);
        if (seen.has(normalized.name)) {
          throw new CetaError('invalid_protocol', 'Multiple providers advertise the same capability');
        }
        seen.add(normalized.name);
        capabilities.push(normalized);
      }
    }
    capabilities.sort((left, right) => left.name.localeCompare(right.name));
    return {
      deviceId: this.identity.deviceId,
      role: this.identity.role,
      manifestVersion: this.manifestVersion,
      capabilities,
    };
  }
}
