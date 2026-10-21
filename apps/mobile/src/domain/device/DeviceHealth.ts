import type {TransportType, TrustState} from './DeviceTrust';
import type {NodeRole} from './NodeRole';

export type DeviceHealth = {
  readonly deviceId: string;
  readonly paired: boolean;
  readonly trusted: boolean;
  readonly reachable: boolean;
  readonly trustState: TrustState;
  readonly lastSeen?: string;
  readonly transport: TransportType;
  readonly protocolVersion: number;
  readonly peerRole: NodeRole;
  readonly capabilityCount: number;
  readonly lastErrorCode?: string;
};
