import {CetaError} from '../shared/errors/CetaError';
import {identifier, iso} from './PairingProtocol';
import type {
  CapabilityAvailability,
  CapabilityManifest,
  DeviceCapabilityAdvertisement,
} from '../domain/device/DeviceCapabilityAdvertisement';
import type {TrustMetadata, TransportType, TrustState} from '../domain/device/DeviceTrust';
import {isNodeRole, type NodeRole} from '../domain/device/NodeRole';

export const MAX_MANIFEST_CAPABILITIES = 64;
export const MAX_HANDSHAKE_EVENTS = 32;
export const MAX_SYNC_CURSOR_LENGTH = 256;

const invalid = (message: string): CetaError =>
  new CetaError('invalid_protocol', message);

export function validateNodeRole(value: unknown): NodeRole {
  if (!isNodeRole(value)) {
    throw new CetaError('unsupported', 'Unknown CetaMesh node role');
  }
  return value;
}

function capabilityId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 96 ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value)
  ) {
    throw invalid('Invalid capability advertisement id');
  }
  return value;
}

function capabilityAvailability(value: unknown): CapabilityAvailability {
  if (value !== 'available' && value !== 'unavailable' && value !== 'degraded') {
    throw invalid('Invalid capability availability');
  }
  return value;
}

function advertisement(value: unknown): DeviceCapabilityAdvertisement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Invalid capability advertisement');
  }
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.version) || Number(record.version) < 1 || Number(record.version) > 1000) {
    throw invalid('Invalid capability advertisement version');
  }
  return {
    capabilityId: capabilityId(record.capabilityId),
    version: Number(record.version),
    availability: capabilityAvailability(record.availability),
  };
}

export function validateCapabilityManifest(value: unknown): CapabilityManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Invalid capability manifest');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.capabilities) || record.capabilities.length > MAX_MANIFEST_CAPABILITIES) {
    throw invalid('Capability manifest is too large');
  }
  if (!Number.isInteger(record.manifestVersion) || Number(record.manifestVersion) < 1) {
    throw invalid('Invalid capability manifest version');
  }
  return {
    deviceId: identifier(record.deviceId),
    role: validateNodeRole(record.role),
    manifestVersion: Number(record.manifestVersion),
    capabilities: record.capabilities.map(advertisement),
  };
}

const TRUST_STATES: readonly TrustState[] = ['trusted', 'revoked', 'stale', 'needs_repair'];
const TRANSPORT_TYPES: readonly TransportType[] = ['lan', 'private-relay', 'cloud-relay', 'unknown'];

export function validateTrustMetadata(value: unknown): TrustMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Invalid trust metadata');
  }
  const record = value as Record<string, unknown>;
  if (!TRUST_STATES.includes(record.trustState as TrustState)) {
    throw invalid('Invalid trust state');
  }
  if (!TRANSPORT_TYPES.includes(record.transportType as TransportType)) {
    throw invalid('Invalid transport type');
  }
  const pairedAt = iso(record.pairedAt);
  const lastSeenAt = record.lastSeenAt === undefined || record.lastSeenAt === null
    ? undefined
    : iso(record.lastSeenAt);
  return {
    trustState: record.trustState as TrustState,
    transportType: record.transportType as TransportType,
    pairedAt,
    ...(lastSeenAt ? {lastSeenAt} : {}),
    peerRole: validateNodeRole(record.peerRole),
  };
}

export type MeshHandshake = {
  readonly protocolVersion: 1;
  readonly deviceId: string;
  readonly nodeRole: NodeRole;
  readonly capabilityManifestVersion: number;
  readonly supportedEventVersions: readonly number[];
  readonly syncCursor?: string;
};

export function validateMeshHandshake(value: unknown): MeshHandshake {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Invalid mesh handshake');
  }
  const record = value as Record<string, unknown>;
  if (record.protocolVersion !== 1) {
    throw new CetaError('unsupported', 'Unsupported mesh protocol version');
  }
  if (!Array.isArray(record.supportedEventVersions) || record.supportedEventVersions.length < 1 || record.supportedEventVersions.length > MAX_HANDSHAKE_EVENTS || record.supportedEventVersions.some(version => !Number.isInteger(version) || Number(version) < 1)) {
    throw invalid('Invalid event version list');
  }
  const cursor = record.syncCursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > MAX_SYNC_CURSOR_LENGTH || !/^[A-Za-z0-9._:-]*$/.test(cursor))) {
    throw invalid('Invalid sync cursor');
  }
  if (!Number.isInteger(record.capabilityManifestVersion) || Number(record.capabilityManifestVersion) < 1) {
    throw invalid('Invalid capability manifest version');
  }
  return {
    protocolVersion: 1,
    deviceId: identifier(record.deviceId),
    nodeRole: validateNodeRole(record.nodeRole),
    capabilityManifestVersion: Number(record.capabilityManifestVersion),
    supportedEventVersions: record.supportedEventVersions.map(Number),
    ...(cursor === undefined ? {} : {syncCursor: cursor}),
  };
}
