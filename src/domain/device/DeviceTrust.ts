import type {PeerIdentity} from '../../protocol/PairingProtocol';
import type {NodeRole} from './NodeRole';

export type TrustState = 'trusted' | 'revoked' | 'stale' | 'needs_repair';
export type TransportType = 'lan' | 'private-relay' | 'cloud-relay' | 'unknown';

export type TrustMetadata = {
  readonly trustState?: TrustState;
  readonly transportType?: TransportType;
  readonly pairedAt?: string;
  readonly lastSeenAt?: string;
  readonly peerRole?: NodeRole;
  readonly protocolVersion?: number;
  readonly capabilityManifestVersion?: number;
  readonly capabilityCount?: number;
  readonly lastErrorCode?: string;
};

export type DeviceTrust=PeerIdentity & {
  endpoint:string;
  localDeviceId:string;
  localPublicKey:string;
  createdAt:string;
} & TrustMetadata;
export interface TrustRepository {
 consume(peerId:string,invitationId:string,expiresAt:string,tokenHash:string):Promise<void>;
 save(trust:DeviceTrust,guard?:()=>void):Promise<void>;
 get(deviceId:string):Promise<DeviceTrust|undefined>;
 list():Promise<DeviceTrust[]>;
 remove(deviceId:string):Promise<void>;
}
export interface PairingTransport {post(endpoint:string,path:'exchange'|'confirm',body:string,signal:AbortSignal):Promise<string>;}
