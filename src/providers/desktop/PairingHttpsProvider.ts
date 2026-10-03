import type {PairingTransport} from '../../domain/device/DeviceTrust';
import {endpointOrigin} from '../../protocol/PairingProtocol';
import {CetaError} from '../../shared/errors/CetaError';
import Native from '../../native/pairing/NativeCetaPairingTransport';
type Bridge=NonNullable<typeof Native>;
let sequence=0;
export class PairingHttpsProvider implements PairingTransport {
 constructor(private readonly bridge:Bridge|null=Native??null){}
 post(endpoint:string,path:'exchange'|'confirm',body:string,signal:AbortSignal):Promise<string>{
  endpointOrigin(endpoint);
  if(path!=='exchange'&&path!=='confirm'||body.length>16384){return Promise.reject(new CetaError('invalid_protocol','Invalid pairing request'));}
  if(!this.bridge){return Promise.reject(new CetaError('unsupported','Pairing transport is unavailable'));}
  const bridge=this.bridge,requestId='pairing-request-'+(++sequence);
  return new Promise((resolve,reject)=>{
   let settled=false;
   const finish=(raw?:string,error?:CetaError)=>{if(settled){return;}settled=true;signal.removeEventListener('abort',abort);if(error){reject(error);}else if(typeof raw!=='string'||raw.length>32768){reject(new CetaError('invalid_protocol','Invalid pairing response'));}else{resolve(raw);}};
   const abort=()=>{bridge.cancel(requestId);finish(undefined,new CetaError('cancelled','Pairing cancelled'));};
   if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
   bridge.post(endpoint+'/cetamesh/v1/pairing/'+path,body,requestId).then(v=>finish(v),e=>{
    const code=e&&typeof e==='object'&&'code' in e&&['timeout','cancelled','network_unavailable','unauthorized','invalid_protocol'].includes(String(e.code))?e.code as CetaError['code']:'provider_error';
    finish(undefined,new CetaError(code,'Pairing request failed'));
   });
  });
 }
}
