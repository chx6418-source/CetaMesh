import type {DeviceCrypto,DeviceIdentity} from '../../domain/identity/DeviceIdentity';
import type {DeviceTrust,TrustRepository,PairingTransport} from '../../domain/device/DeviceTrust';
import type {IdentityRuntime} from './IdentityRuntime';
import {CetaError} from '../../shared/errors/CetaError';
import {parseInvitation,parseEnvelope,transcript,assertUnexpired,nonce,identifier} from '../../protocol/PairingProtocol';
import type {PairingInvitation,PairingProof} from '../../protocol/PairingProtocol';
export type PairingPreview={id:string;endpoint:string;expiresAt:string;peer:PairingInvitation['peer'];stage:'destination'|'confirm'};
type Pending={id:string;invitation:PairingInvitation;stage:'destination'|'confirm';generation:number;controller:AbortController;device?:DeviceIdentity;nonce?:string};
export class PairingRuntime {
 private pending?:Pending;
 private generation=0;
 private sequence=0;
 private busy=false;
 private closed=false;
 private mutation:Promise<unknown>=Promise.resolve();
 private operations=new Set<Promise<unknown>>();
 private blocked=new Set<string>();
 private leases=new Map<string,Set<AbortController>>();
 constructor(private readonly identity:IdentityRuntime,private readonly crypto:DeviceCrypto,private readonly repository:TrustRepository,private readonly transport:PairingTransport,private readonly clock=Date.now){}
 preview(raw:string):PairingPreview{
  if(this.closed){throw new CetaError('cancelled','Pairing is closed');}
  if(this.busy){throw new CetaError('sync_conflict','Another pairing request is pending');}
  this.cancel();const invitation=parseInvitation(raw,this.clock());
  const p:Pending={id:'pairing-'+(++this.sequence),invitation,stage:'destination',generation:this.generation,controller:new AbortController()};this.pending=p;return this.view(p);
 }
 private view(p:Pending):PairingPreview{return {id:p.id,endpoint:p.invitation.endpoint,expiresAt:p.invitation.expiresAt,peer:{...p.invitation.peer},stage:p.stage};}
 private current(id:string,stage:Pending['stage']):Pending{
  const p=this.pending;if(!p||p.id!==id||p.stage!==stage){throw new CetaError('unauthorized','Pairing confirmation is no longer valid');}
  this.check(p);return p;
 }
 private check(p:Pending):void{
  if(this.closed||p!==this.pending||p.generation!==this.generation||p.controller.signal.aborted){throw new CetaError('cancelled','Pairing cancelled');}
  assertUnexpired(p.invitation.expiresAt,this.clock());
 }
 private track<T>(operation:Promise<T>):Promise<T>{this.operations.add(operation);operation.then(()=>this.operations.delete(operation),()=>this.operations.delete(operation));return operation;}
 exchange(id:string):Promise<PairingPreview>{return this.track(this.exchangeOnce(id));}
 private async exchangeOnce(id:string):Promise<PairingPreview>{
  if(this.busy){throw new CetaError('sync_conflict','Another pairing request is pending');}
  const p=this.current(id,'destination');this.busy=true;
  try{
   if(await this.repository.get(p.invitation.peer.deviceId)){throw new CetaError('sync_conflict','Remove existing trust before pairing again');}this.check(p);
   const tokenHash=await this.crypto.fingerprint(p.invitation.token);this.check(p);
   await this.repository.consume(p.invitation.peer.deviceId,p.invitation.invitationId,p.invitation.expiresAt,tokenHash);this.check(p);
   const device=await this.identity.get();this.check(p);
   if(device.deviceId===p.invitation.peer.deviceId){throw new CetaError('invalid_protocol','Cannot pair a device with itself');}
   p.device=device;p.nonce=nonce(await this.crypto.randomNonce());this.check(p);
   const signature=await this.crypto.sign(transcript(p.invitation,device,p.nonce,'exchange'));this.check(p);
   const body=this.envelope('pairing.exchange',{invitationId:p.invitation.invitationId,token:p.invitation.token,nonce:p.nonce,device,signature});
   const response=await this.post(p,'exchange',body);this.check(p);await this.verifyProof(p,response,'challenge');this.check(p);
   p.stage='confirm';return this.view(p);
  }catch(e){if(this.pending===p){this.cancel();}throw this.safe(e);}finally{this.busy=false;}
 }
 confirm(id:string):Promise<DeviceTrust>{return this.track(this.confirmOnce(id));}
 private async confirmOnce(id:string):Promise<DeviceTrust>{
  if(this.busy){throw new CetaError('sync_conflict','Another pairing request is pending');}
  const p=this.current(id,'confirm');this.busy=true;this.blocked.add(p.invitation.peer.deviceId);let saved=false;
  try{
   const signature=await this.crypto.sign(transcript(p.invitation,p.device!,p.nonce!,'confirm'));this.check(p);
   const response=await this.post(p,'confirm',this.envelope('pairing.confirm',{invitationId:p.invitation.invitationId,nonce:p.nonce,deviceId:p.device!.deviceId,signature}));this.check(p);
   await this.verifyProof(p,response,'accepted');this.check(p);
   const trust:DeviceTrust={...p.invitation.peer,endpoint:p.invitation.endpoint,localDeviceId:p.device!.deviceId,localPublicKey:p.device!.publicKey,createdAt:new Date(this.clock()).toISOString()};
   await this.mutate(async()=>{this.check(p);await this.repository.save(trust,()=>this.check(p));saved=true;});this.check(p);
   this.blocked.delete(trust.deviceId);this.pending=undefined;return {...trust};
  }catch(e){
   if(this.pending===p){this.cancel();}
   if(saved){await this.mutate(()=>this.repository.remove(p.invitation.peer.deviceId));}
   throw this.safe(e);
  }finally{this.busy=false;}
 }
 private async verifyProof(p:Pending,raw:string,phase:'challenge'|'accepted'):Promise<void>{
  const e=parseEnvelope(raw,this.clock());if(e.type!=='pairing.'+phase){throw new CetaError('invalid_protocol','Unexpected pairing response');}
  const proof=e.payload as PairingProof,i=p.invitation;
  if(proof.invitationId!==i.invitationId||proof.nonce!==p.nonce||proof.expiresAt!==i.expiresAt||proof.peer.deviceId!==i.peer.deviceId||proof.peer.publicKey!==i.peer.publicKey||proof.peer.deviceName!==i.peer.deviceName||!await this.crypto.verify(i.peer.publicKey,transcript(i,p.device!,p.nonce!,phase),proof.signature)){
   throw new CetaError('invalid_protocol','Pairing signature or identity mismatch');
  }
 }
 private envelope(type:string,payload:unknown):string{return JSON.stringify({protocol:'cetamesh',version:1,id:'mobile-event-'+(++this.sequence),type,timestamp:new Date(this.clock()).toISOString(),payload});}
 private post(p:Pending,path:'exchange'|'confirm',body:string):Promise<string>{
  return new Promise((resolve,reject)=>{
   let settled=false;
   const finish=(value?:string,error?:CetaError)=>{if(settled){return;}settled=true;clearTimeout(timer);p.controller.signal.removeEventListener('abort',abort);if(error){reject(error);}else{resolve(value!);}};
   const abort=()=>finish(undefined,new CetaError('cancelled','Pairing cancelled'));
   const timer=setTimeout(()=>{finish(undefined,new CetaError('timeout','Pairing request timed out'));p.controller.abort();},15000);
   p.controller.signal.addEventListener('abort',abort,{once:true});
   if(p.controller.signal.aborted){abort();return;}
   this.transport.post(p.invitation.endpoint,path,body,p.controller.signal).then(v=>finish(v),e=>finish(undefined,this.safe(e)));
  });
 }
 private safe(e:unknown):CetaError{
  if(e instanceof CetaError){return e;}
  const code=e&&typeof e==='object'&&'code' in e&&['unsupported','permission_denied','timeout','cancelled','network_unavailable','unauthorized','invalid_protocol','storage_error'].includes(String(e.code))?e.code as CetaError['code']:'provider_error';
  return new CetaError(code,'Pairing is unavailable');
 }
 private mutate<T>(operation:()=>Promise<T>):Promise<T>{const result=this.mutation.then(operation,operation);this.mutation=result.catch(()=>{});return result;}
 cancel():void{this.generation++;this.pending?.controller.abort();this.pending=undefined;}
 listTrust():Promise<DeviceTrust[]>{return this.repository.list();}
 async removeTrust(id:string):Promise<void>{
  identifier(id);this.blocked.add(id);for(const lease of this.leases.get(id)??[]){lease.abort();}
  if(this.pending?.invitation.peer.deviceId===id){this.cancel();}
  await this.mutate(()=>this.repository.remove(id));
 }
 async withTrustedDevice<T>(id:string,key:string,operation:(trust:DeviceTrust,signal:AbortSignal)=>Promise<T>):Promise<T>{
  identifier(id);const controller=new AbortController();const leases=this.leases.get(id)??new Set<AbortController>();this.leases.set(id,leases);leases.add(controller);
  const check=()=>{if(this.closed||this.blocked.has(id)||controller.signal.aborted){throw new CetaError('unauthorized','Device trust is no longer valid');}};
  try{
   check();const trust=await this.repository.get(id),local=await this.identity.get();check();
   if(!trust||trust.publicKey!==key||trust.localDeviceId!==local.deviceId||trust.localPublicKey!==local.publicKey){throw new CetaError('unauthorized','Device is not trusted');}
   const result=await operation({...trust},controller.signal);check();return result;
  }finally{leases.delete(controller);if(!leases.size){this.leases.delete(id);}}
 }
 async close():Promise<void>{this.closed=true;this.cancel();for(const leases of this.leases.values()){for(const lease of leases){lease.abort();}}await Promise.allSettled([...this.operations]);await this.mutation;}
}
