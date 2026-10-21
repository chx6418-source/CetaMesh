import type {DeviceTrust,TrustRepository} from '../../domain/device/DeviceTrust';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier,peerIdentity,endpointOrigin,publicKey,iso} from '../../protocol/PairingProtocol';
import {validateNodeRole, validateTrustMetadata} from '../../protocol/DeviceMeshProtocol';
import type {SqliteConnection,SqliteValue} from '../database/SqliteConnection';
type Row=Record<string,SqliteValue>;
function decode(r:Row):DeviceTrust{
 const base={...peerIdentity({deviceId:r.device_id,deviceName:r.device_name,publicKey:r.public_key}),endpoint:endpointOrigin(r.endpoint),localDeviceId:identifier(r.local_device_id),localPublicKey:publicKey(r.local_public_key),createdAt:iso(r.created_at)};
 const trustState=String(r.trust_state??'trusted') as DeviceTrust['trustState'];
 const transportType=String(r.transport_type??'unknown') as DeviceTrust['transportType'];
 const pairedAt=typeof r.paired_at==='string'&&r.paired_at?iso(r.paired_at):base.createdAt;
 const peerRole=validateNodeRole(r.peer_role??'desktop-node');
 const protocolVersion=Number(r.protocol_version??1);
 const capabilityManifestVersion=Number(r.capability_manifest_version??1);
 const capabilityCount=Number(r.capability_count??0);
 const lastSeenAt=typeof r.last_seen_at==='string'&&r.last_seen_at?iso(r.last_seen_at):undefined;
 const lastErrorCode=typeof r.last_error_code==='string'&&r.last_error_code?String(r.last_error_code):undefined;
 if(trustState==='trusted'&&transportType==='unknown'&&pairedAt===base.createdAt&&peerRole==='desktop-node'&&protocolVersion===1&&capabilityManifestVersion===1&&capabilityCount===0&&!lastSeenAt&&!lastErrorCode){return base;}
 return {...base,...validateTrustMetadata({trustState,transportType,pairedAt,lastSeenAt,peerRole}),protocolVersion,capabilityManifestVersion,capabilityCount,...(lastErrorCode?{lastErrorCode}:{})};
}
export class SqliteTrustRepository implements TrustRepository {
 constructor(private readonly db:SqliteConnection){}
 async consume(peerId:string,invitationId:string,expiresAt:string,tokenHash:string):Promise<void>{
  identifier(peerId);identifier(invitationId);iso(expiresAt);
  if(!/^[0-9a-f]{64}$/.test(tokenHash)){throw new CetaError('invalid_protocol','Invalid token fingerprint');}
  await this.db.transaction(async tx=>{
   const used=await tx.executeAsync('SELECT invitation_id FROM pairing_used WHERE (peer_id=? AND invitation_id=?) OR token_hash=?',[peerId,invitationId,tokenHash]);
   if(used.results.length){throw new CetaError('unauthorized','Pairing invitation was already used');}
   await tx.executeAsync('INSERT INTO pairing_used(peer_id,invitation_id,expires_at,token_hash) VALUES(?,?,?,?)',[peerId,invitationId,expiresAt,tokenHash]);
  });
 }
 async save(trust:DeviceTrust,guard:()=>void=()=>{}):Promise<void>{
  const t={...peerIdentity(trust),endpoint:endpointOrigin(trust.endpoint),localDeviceId:identifier(trust.localDeviceId),localPublicKey:publicKey(trust.localPublicKey),createdAt:iso(trust.createdAt)};
  const trustState=trust.trustState??'trusted';
  const transportType=trust.transportType??'unknown';
  const pairedAt=trust.pairedAt??trust.createdAt;
  const peerRole=trust.peerRole??'desktop-node';
  const protocolVersion=trust.protocolVersion??1;
  const capabilityManifestVersion=trust.capabilityManifestVersion??1;
  const capabilityCount=trust.capabilityCount??0;
  validateTrustMetadata({trustState,transportType,pairedAt,lastSeenAt:trust.lastSeenAt,peerRole});
  if(!Number.isInteger(protocolVersion)||protocolVersion<1||!Number.isInteger(capabilityManifestVersion)||capabilityManifestVersion<1||!Number.isInteger(capabilityCount)||capabilityCount<0||capabilityCount>64){throw new CetaError('invalid_protocol','Invalid device mesh metadata');}
  await this.db.transaction(async tx=>{
   guard();
   const old=await tx.executeAsync('SELECT device_id FROM device_trust WHERE device_id=?',[t.deviceId]);
   if(old.results.length){throw new CetaError('sync_conflict','Device is already trusted; remove trust before pairing again');}
   const count=await tx.executeAsync('SELECT COUNT(*) AS count FROM device_trust');if(Number(count.results[0].count)>=100){throw new CetaError('storage_error','Trusted device limit reached');}
   await tx.executeAsync('INSERT INTO device_trust(device_id,device_name,public_key,endpoint,local_device_id,local_public_key,created_at,trust_state,transport_type,paired_at,last_seen_at,peer_role,protocol_version,capability_manifest_version,capability_count,last_error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[t.deviceId,t.deviceName,t.publicKey,t.endpoint,t.localDeviceId,t.localPublicKey,t.createdAt,trustState,transportType,pairedAt,trust.lastSeenAt??null,peerRole,protocolVersion,capabilityManifestVersion,capabilityCount,trust.lastErrorCode??null]);
   guard();
  });
 }
 async get(id:string):Promise<DeviceTrust|undefined>{identifier(id);const r=await this.db.executeAsync('SELECT * FROM device_trust WHERE device_id=?',[id]);return r.results[0]?decode(r.results[0]):undefined;}
 async list():Promise<DeviceTrust[]>{return (await this.db.executeAsync('SELECT * FROM device_trust ORDER BY created_at DESC,device_id LIMIT 100')).results.map(decode);}
 async remove(id:string):Promise<void>{identifier(id);await this.db.executeAsync('DELETE FROM device_trust WHERE device_id=?',[id]);}
}
