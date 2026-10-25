import type {DeviceCrypto} from '../../domain/identity/DeviceIdentity';
import {CetaError} from '../../shared/errors/CetaError';
import Native from './NativeCetaDeviceIdentity';
export class DeviceCryptoProvider implements DeviceCrypto {
 private get native(){if(!Native){throw new CetaError('unsupported','Secure device identity is unavailable');}return Native;}
 async getIdentity(){return this.native.getIdentity();}
 async sign(data:string){return this.native.sign(data);}
 async verify(key:string,data:string,signature:string){return this.native.verify(key,data,signature);}
 async fingerprint(token:string){return this.native.fingerprint(token);}
 async randomNonce(){return this.native.randomNonce();}
}
