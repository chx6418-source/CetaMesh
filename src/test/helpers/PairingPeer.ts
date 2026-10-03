import {generateKeyPairSync,sign,verify,createPublicKey,randomBytes,createHash} from 'node:crypto';
import type {DeviceCrypto,DeviceIdentity} from '../../domain/identity/DeviceIdentity';
import {transcript} from '../../protocol/PairingProtocol';
import type {PairingInvitation} from '../../protocol/PairingProtocol';
import type {PairingTransport} from '../../domain/device/DeviceTrust';
export class NodeDeviceCrypto implements DeviceCrypto {
 private pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 readonly identity:DeviceIdentity;
 constructor(id='mobile-1'){
  const jwk=this.pair.publicKey.export({format:'jwk'});
  const point=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]);
  this.identity={deviceId:id,deviceName:id,platform:'android',publicKey:point.toString('base64'),createdAt:'2026-09-30T00:00:00.000Z'};
 }
 async getIdentity(){return JSON.stringify(this.identity);}
 async sign(data:string){return sign('sha256',Buffer.from(data),this.pair.privateKey).toString('base64');}
 async verify(key:string,data:string,signature:string){
  const p=Buffer.from(key,'base64');const publicKey=createPublicKey({key:{kty:'EC',crv:'P-256',x:p.subarray(1,33).toString('base64url'),y:p.subarray(33).toString('base64url')},format:'jwk'});
  return verify('sha256',Buffer.from(data),publicKey,Buffer.from(signature,'base64'));
 }
 async fingerprint(token:string){return createHash('sha256').update(token).digest('hex');}
 async randomNonce(){return randomBytes(32).toString('base64');}
}
export function pairingFixture(now=Date.parse('2026-09-30T00:00:00.000Z')){
 const mobile=new NodeDeviceCrypto(),desktop=new NodeDeviceCrypto('desktop-1');
 const invitation:PairingInvitation={invitationId:'invite-1',endpoint:'https://desktop.example',token:randomBytes(32).toString('base64'),expiresAt:new Date(now+60000).toISOString(),peer:{deviceId:desktop.identity.deviceId,deviceName:'Desktop',publicKey:desktop.identity.publicKey}};
 const raw=JSON.stringify({protocol:'cetamesh',version:1,id:'qr-1',type:'pairing.invitation',timestamp:new Date(now).toISOString(),payload:invitation});
 let nonce='',device=mobile.identity;const used=new Set<string>();let calls=0;
 const transport:PairingTransport={post:async(_endpoint,path,body)=>{
  calls++;const p=JSON.parse(body).payload;
  if(path==='exchange'){
   if(used.has(p.token)||p.token!==invitation.token){throw new Error('used');}used.add(p.token);
   device=p.device;nonce=p.nonce;
   if(!await desktop.verify(device.publicKey,transcript(invitation,device,nonce,'exchange'),p.signature)){throw new Error('bad client');}
  }else if(!await desktop.verify(device.publicKey,transcript(invitation,device,nonce,'confirm'),p.signature)){throw new Error('bad confirm');}
  const phase=path==='exchange'?'challenge':'accepted';
  return JSON.stringify({protocol:'cetamesh',version:1,id:'response-'+calls,type:'pairing.'+phase,timestamp:new Date(now).toISOString(),payload:{invitationId:invitation.invitationId,nonce,peer:invitation.peer,expiresAt:invitation.expiresAt,signature:await desktop.sign(transcript(invitation,device,nonce,phase))}});
 }};
 return {mobile,desktop,invitation,raw,transport,calls:()=>calls};
}
