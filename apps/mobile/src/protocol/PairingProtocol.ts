import {CetaError} from '../shared/errors/CetaError';
import type {ProtocolEnvelope} from './ProtocolEnvelope';
export type PeerKeyAlgorithm='p256'|'ed25519';
export type PeerIdentity={deviceId:string;deviceName:string;publicKey:string;keyAlgorithm?:PeerKeyAlgorithm};
export type PairingInvitation={invitationId:string;endpoint:string;token:string;expiresAt:string;peer:PeerIdentity;tlsPin?:string};
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
// v1.1 optional fields: absent keyAlgorithm means the v1 P-256 default; tlsPin is
// the SHA-256(DER) fingerprint of the peer's per-installation self-signed LAN cert.
export function keyAlgorithm(v:unknown):PeerKeyAlgorithm{if(v!=='p256'&&v!=='ed25519'){throw invalid();}return v;}
export function tlsPin(v:unknown):string{if(typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v)){throw invalid();}return v;}
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
 const peer=record(p.peer);
 return {invitationId:identifier(p.invitationId),endpoint:endpointOrigin(p.endpoint),token:nonce(p.token),expiresAt,
  peer:{...peerIdentity(peer),...(peer.keyAlgorithm===undefined?{}:{keyAlgorithm:keyAlgorithm(peer.keyAlgorithm)})},
  ...(p.tlsPin===undefined?{}:{tlsPin:tlsPin(p.tlsPin)})};
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
 // Invitations carrying a tlsPin bind the certificate fingerprint into the
 // signed transcript (v1.1); without one the v1 transcript is byte-identical.
 return JSON.stringify(i.tlsPin===undefined?['cetamesh-pairing-v1',phase,i.invitationId,i.endpoint,i.peer.deviceId,i.peer.publicKey,d.deviceId,d.publicKey,n,i.expiresAt]:['cetamesh-pairing-v1.1',phase,i.invitationId,i.endpoint,i.peer.deviceId,i.peer.publicKey,d.deviceId,d.publicKey,n,i.expiresAt,i.tlsPin]);
}
export function payloadHash(payload:unknown):string{
 const text=JSON.stringify(payload);if(typeof text!=='string'){throw invalid();}
 return sha256Hex(text);
}
// eslint-disable-next-line @typescript-eslint/no-shadow -- `nonce` is the wire field name.
export function meshSigningString(type:string,id:string,from:string,to:string,timestamp:string,nonce:string,ph:string):string{
 return JSON.stringify(['cetamesh-mesh-v1',type,id,from,to,timestamp,nonce,ph]);
}
/* eslint-disable no-bitwise -- SHA-256 is defined in terms of 32-bit word operations. */
// Pure TypeScript SHA-256 over the UTF-8 bytes of a string. The protocol layer
// must not depend on node:crypto (React Native has no Node builtins) and native
// crypto is asynchronous, so the M6 payload hash needs this local implementation.
const SHA256_K=[
 0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
 0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
 0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
 0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
 0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
 0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
 0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
 0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function utf8(value:string):number[]{
 const bytes:number[]=[];
 for(let index=0;index<value.length;index+=1){
  let code=value.charCodeAt(index);
  if(code>=0xd800&&code<=0xdbff&&index+1<value.length){const low=value.charCodeAt(index+1);if(low>=0xdc00&&low<=0xdfff){code=0x10000+((code-0xd800)<<10)+low-0xdc00;index+=1;}}
  if(code<0x80){bytes.push(code);}
  else if(code<0x800){bytes.push(0xc0|(code>>>6),0x80|(code&0x3f));}
  else if(code<0x10000){bytes.push(0xe0|(code>>>12),0x80|((code>>>6)&0x3f),0x80|(code&0x3f));}
  else{bytes.push(0xf0|(code>>>18),0x80|((code>>>12)&0x3f),0x80|((code>>>6)&0x3f),0x80|(code&0x3f));}
 }
 return bytes;
}
function sha256Hex(value:string):string{
 const bytes=utf8(value),bitLength=bytes.length*8;bytes.push(0x80);
 while((bytes.length+8)%64!==0){bytes.push(0);}
 for(let shift=56;shift>=0;shift-=8){bytes.push(Math.floor(bitLength/2**shift)%256);}
 let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
 for(let offset=0;offset<bytes.length;offset+=64){
  const words=new Array<number>(64).fill(0);
  for(let index=0;index<16;index+=1){const position=offset+index*4;words[index]=((bytes[position]<<24)|(bytes[position+1]<<16)|(bytes[position+2]<<8)|bytes[position+3])>>>0;}
  for(let index=16;index<64;index+=1){
   const previous=words[index-15],previousTwo=words[index-2];
   const small0=((previous>>>7)|(previous<<25))^((previous>>>18)|(previous<<14))^(previous>>>3);
   const small1=((previousTwo>>>17)|(previousTwo<<15))^((previousTwo>>>19)|(previousTwo<<13))^(previousTwo>>>10);
   words[index]=(words[index-16]+small0+words[index-7]+small1)>>>0;
  }
  let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
  for(let index=0;index<64;index+=1){
   const big1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7)),choose=(e&f)^(~e&g);
   const temp1=(h+big1+choose+SHA256_K[index]+words[index])>>>0;
   const big0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10)),majority=(a&b)^(a&c)^(b&c);
   const temp2=(big0+majority)>>>0;
   h=g;g=f;f=e;e=(d+temp1)>>>0;d=c;c=b;b=a;a=(temp1+temp2)>>>0;
  }
  h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+h)>>>0;
 }
 return [h0,h1,h2,h3,h4,h5,h6,h7].map(word=>word.toString(16).padStart(8,'0')).join('');
}
/* eslint-enable no-bitwise */
