import {QrScannerRuntime} from '../runtime/capability/QrScannerRuntime';
import {QrScanPolicy} from '../security/QrScanPolicy';
it('denies unknown capability, arbitrary input and user denial before native access',async()=>{
 let scans=0;const r=new QrScannerRuntime(new QrScanPolicy(async()=>false),{scan:async()=>{scans++;return 'qr';},cancel:()=>{}});
 await expect(r.invoke({name:'camera.capture',input:undefined})).rejects.toMatchObject({code:'permission_denied'});
 await expect(r.invoke({name:'camera.scanQr',input:'/private'})).rejects.toMatchObject({code:'permission_denied'});
 await expect(r.scan()).rejects.toMatchObject({code:'permission_denied'});expect(scans).toBe(0);
});
it('consumes grants once, validates result size and normalizes native errors',async()=>{
 const p=new QrScanPolicy(async()=>true);const g=await p.authorize('camera.scanQr');p.consume(g);expect(()=>p.consume(g)).toThrow();
 const r=new QrScannerRuntime(p,{scan:async()=> 'x'.repeat(8193),cancel:()=>{}});await expect(r.scan()).rejects.toMatchObject({code:'invalid_protocol'});
 const denied=new QrScannerRuntime(p,{scan:async()=>{throw {code:'permission_denied',message:'secret QR'};},cancel:()=>{}});
 await expect(denied.scan()).rejects.toMatchObject({code:'permission_denied',message:'QR scanning is unavailable'});
});
it('cancellation during permission prompt never launches camera',async()=>{
 let approve!:(v:boolean)=>void;let scans=0;
 const r=new QrScannerRuntime(new QrScanPolicy(()=>new Promise(resolve=>{approve=resolve;})),{scan:async()=>{scans++;return 'qr';},cancel:()=>{}});
 const pending=r.scan();r.cancel();approve(true);await expect(pending).rejects.toMatchObject({code:'cancelled'});expect(scans).toBe(0);
});
it('rejects overlapping scans and discards native result after cancellation',async()=>{
 let finish!:(v:string)=>void;
 const r=new QrScannerRuntime(new QrScanPolicy(async()=>true),{scan:()=>new Promise(resolve=>{finish=resolve;}),cancel:()=>{}});
 const p=r.scan();await Promise.resolve();await expect(r.scan()).rejects.toMatchObject({code:'sync_conflict'});r.cancel();finish('private qr');await expect(p).rejects.toMatchObject({code:'cancelled'});
});
