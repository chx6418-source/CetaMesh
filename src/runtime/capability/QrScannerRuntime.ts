import type {QrScannerProvider} from '../../domain/capability/QrScanner';
import type {QrScanPolicy} from '../../security/QrScanPolicy';
import {CetaError} from '../../shared/errors/CetaError';
import type {CapabilityRequest,CapabilityRuntime} from './CapabilityRuntime';
export class QrScannerRuntime implements CapabilityRuntime {
 private busy=false;
 private generation=0;
 constructor(private readonly policy:QrScanPolicy,private readonly provider:QrScannerProvider){}
 async invoke(request:CapabilityRequest):Promise<string>{
  if(request.input!==undefined&&request.input!==null){throw new CetaError('permission_denied','QR scanner accepts no external input');}
  if(this.busy){throw new CetaError('sync_conflict','A QR scan is already pending');}
  this.busy=true;const generation=this.generation;
  try{
   const grant=await this.policy.authorize(request.name);
   if(generation!==this.generation){throw new CetaError('cancelled','QR scan cancelled');}
   this.policy.consume(grant);
   const raw=await this.provider.scan();
   if(generation!==this.generation){throw new CetaError('cancelled','QR scan cancelled');}
   if(typeof raw!=='string'||!raw.length||raw.length>8192){throw new CetaError('invalid_protocol','Invalid QR payload');}
   return raw;
  }catch(e){
   if(e instanceof CetaError){throw e;}
   const code=e&&typeof e==='object'&&'code' in e&&['permission_denied','unsupported','cancelled'].includes(String(e.code))?e.code as 'permission_denied'|'unsupported'|'cancelled':'provider_error';
   throw new CetaError(code,'QR scanning is unavailable');
  }finally{this.busy=false;}
 }
 scan():Promise<string>{return this.invoke({name:'camera.scanQr',input:undefined});}
 cancel():void{this.generation++;this.provider.cancel();}
}
