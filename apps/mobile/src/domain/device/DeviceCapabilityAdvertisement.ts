import type {NodeRole} from './NodeRole';

export type CapabilityAvailability = 'available' | 'unavailable' | 'degraded';

export type DeviceCapabilityAdvertisement = {
  readonly capabilityId: string;
  readonly version: number;
  readonly availability: CapabilityAvailability;
};

export type CapabilityManifest = {
  readonly deviceId: string;
  readonly role: NodeRole;
  readonly manifestVersion: number;
  readonly capabilities: readonly DeviceCapabilityAdvertisement[];
};
