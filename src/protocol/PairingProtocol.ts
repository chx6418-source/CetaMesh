import {CetaError} from '../shared/errors/CetaError';
import type {ProtocolEnvelope} from './ProtocolEnvelope';
export type PeerIdentity={deviceId:string;deviceName:string;publicKey:string};
export type PairingInvitation={invitationId:string;endpoint:string;token:string;expiresAt:string;peer:PeerIdentity};
export type PairingProof={invitationId:string;nonce:string;peer:PeerIdentity;expiresAt:string;signature:string};
export type PairingPhase='exchange'|'challenge'|'confirm'|'accepted';
const invalid=()=>new CetaError('invalid_protocol','Invalid CetaMesh protocol');
export function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)){throw invalid();}return v as Record<string,unknown>;}
export function identifier(v:unknown):string{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(v)){throw invalid();}return v;}
export function iso(v:unknown):string{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v){throw invalid();}return v;}
export function publicKey(v:unknown):string{if(typeof v!=='string'||!/^B[A-Za-z0-9+/]{85}[AEIMQUYcgkosw048]=$/.test(v)){throw invalid();}return v;}
export function nonce(v:unknown):string{if(typeof v!=='string'||!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(v)){throw invalid();}return v;}
export function peerIdentity(v:unknown):PeerIdentity{
 const p=record(v);if(typeof p.deviceName!=='string'||!p.deviceName.trim()||p.deviceName.length>100||Array.from(p.deviceName).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)){throw invalid();}
 return {deviceId:identifier(p.deviceId),deviceName:p.deviceName,publicKey:publicKey(p.publicKey)};
}
export function endpointOrigin(v:unknown):string{
 // RN's URL is not WHATWG-compatible. Parse a deliberately narrow canonical
 // DNS/IPv4 origin grammar identically on both platforms; IPv6 is unsupported.
 if(typeof v!=='string'||v.length>512){throw invalid();}
 const match=/^https:\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(v);
 if(!match){throw invalid();}const host=match[1],port=match[2];
 if(host.length>253||host==='localhost'||host.endsWith('.localhost')||
    host.split('.').some(label=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||
    port&&(Number(port)>65535||Number(port)===443)){throw invalid();}
 // Disallow integer, abbreviated and octal IP spellings before OS resolution.
 if(/^[0-9.]+$/.test(host)||/^(?:[0-9]+|0x[0-9a-f]+)$/.test(host.split('.').at(-1)!)){
  const parts=host.split('.');
  if(parts.length!==4||parts.some(p=>! /^(0|[1-9][0-9]{0,2})$/.test(p)||Number(p)>255)||parts[0]==='127'||parts[0]==='0'){throw invalid();}
 }
 return v;
}
export function assertUnexpired(expiresAt:string,now:number):void{
 const expiry=Date.parse(iso(expiresAt));if(expiry<=now||expiry>now+300000){throw invalid();}
}
function signature(v:unknown):string{if(typeof v!=='string'||v.length<12||v.length>96||!/^[A-Za-z0-9+/]+={0,2}$/.test(v)){throw invalid();}return v;}
function invitation(v:unknown,now:number,timestamp:string):PairingInvitation{
 const p=record(v),expiresAt=iso(p.expiresAt);assertUnexpired(expiresAt,now);
 if(Date.parse(expiresAt)>Date.parse(timestamp)+300000||Date.parse(expiresAt)<=Date.parse(timestamp)){throw invalid();}
 return {invitationId:identifier(p.invitationId),endpoint:endpointOrigin(p.endpoint),token:nonce(p.token),expiresAt,peer:peerIdentity(p.peer)};
}
export function validateEnvelope(v:unknown,now=Date.now()):ProtocolEnvelope{
 const e=record(v);if(e.protocol!=='cetamesh'||e.version!==1){throw invalid();}
 const id=identifier(e.id),timestamp=iso(e.timestamp);if(Date.parse(timestamp)>now+30000){throw invalid();}
 let payload:unknown;
 switch(e.type){
 case 'pairing.invitation':payload=invitation(e.payload,now,timestamp);break;
 case 'pairing.challenge':case 'pairing.accepted':{
  const p=record(e.payload),expiresAt=iso(p.expiresAt);assertUnexpired(expiresAt,now);
  payload={invitationId:identifier(p.invitationId),nonce:nonce(p.nonce),peer:peerIdentity(p.peer),expiresAt,signature:signature(p.signature)};break;
 }
 case 'pairing.exchange':{
  const p=record(e.payload),d=record(p.device);if(d.platform!=='android'&&d.platform!=='ios'){throw invalid();}
  payload={invitationId:identifier(p.invitationId),token:nonce(p.token),nonce:nonce(p.nonce),device:{...peerIdentity(d),platform:d.platform,createdAt:iso(d.createdAt)},signature:signature(p.signature)};break;
 }
 case 'pairing.confirm':{
  const p=record(e.payload);payload={invitationId:identifier(p.invitationId),nonce:nonce(p.nonce),deviceId:identifier(p.deviceId),signature:signature(p.signature)};break;
 }
 default:throw invalid();
 }
 return {protocol:'cetamesh',version:1,id,type:e.type as string,timestamp,payload};
}
export function parseEnvelope(raw:string,now=Date.now(),max=32768):ProtocolEnvelope{
 try{if(typeof raw!=='string'||raw.length>max){throw invalid();}return validateEnvelope(JSON.parse(raw),now);}catch{throw invalid();}
}
export function parseInvitation(raw:string,now=Date.now()):PairingInvitation{
 const e=parseEnvelope(raw,now,8192);if(e.type!=='pairing.invitation'){throw invalid();}return e.payload as PairingInvitation;
}
export function transcript(i:PairingInvitation,d:{deviceId:string;publicKey:string},n:string,phase:PairingPhase):string{
 return JSON.stringify(['cetamesh-pairing-v1',phase,i.invitationId,i.endpoint,i.peer.deviceId,i.peer.publicKey,d.deviceId,d.publicKey,n,i.expiresAt]);
}
