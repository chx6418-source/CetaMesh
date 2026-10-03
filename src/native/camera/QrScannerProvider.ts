import type {QrScannerProvider as Provider} from '../../domain/capability/QrScanner';
import {CetaError} from '../../shared/errors/CetaError';
import Native from './NativeCetaQrScanner';
export class QrScannerProvider implements Provider {
 scan():Promise<string>{if(!Native){return Promise.reject(new CetaError('unsupported','QR scanner is unavailable'));}return Native.scan();}
 cancel():void{Native?.cancel();}
}
