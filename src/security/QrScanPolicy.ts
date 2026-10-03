import {CetaError} from '../shared/errors/CetaError';
type Grant={expiresAt:number};
export class QrScanPolicy {
 private grants=new WeakSet<Grant>();
 constructor(private readonly confirm:()=>Promise<boolean>,private readonly clock=Date.now){}
 async authorize(name:string):Promise<Grant>{
  if(name!=='camera.scanQr'||!await this.confirm()){throw new CetaError('permission_denied','QR camera access was not approved');}
  const grant={expiresAt:this.clock()+60000};this.grants.add(grant);return grant;
 }
 consume(g:Grant):void{if(!this.grants.delete(g)||g.expiresAt<=this.clock()){throw new CetaError('permission_denied','Invalid one-time camera permission');}}
}
