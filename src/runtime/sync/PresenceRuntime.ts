import type {DeviceTrust} from '../../domain/device/DeviceTrust';

export type DevicePresenceStatus = 'online' | 'offline' | 'degraded' | 'stale' | 'revoked';
export type DevicePresence = {readonly deviceId: string; readonly status: DevicePresenceStatus; readonly lastSeen?: string};

export class PresenceRuntime {
  constructor(private readonly clock: () => number = Date.now) {}

  derive(trust: DeviceTrust): DevicePresence {
    if ((trust.trustState ?? 'trusted') === 'revoked' || (trust.trustState ?? 'trusted') === 'needs_repair') {
      return {deviceId: trust.deviceId, status: 'revoked', ...(trust.lastSeenAt ? {lastSeen: trust.lastSeenAt} : {})};
    }
    if ((trust.trustState ?? 'trusted') !== 'trusted' || !trust.lastSeenAt) {
      return {deviceId: trust.deviceId, status: 'offline'};
    }
    const age = this.clock() - Date.parse(trust.lastSeenAt);
    const status: DevicePresenceStatus = age <= 30_000 ? 'online' : age < 60_000 ? 'degraded' : 'stale';
    return {deviceId: trust.deviceId, status, lastSeen: trust.lastSeenAt};
  }
}
