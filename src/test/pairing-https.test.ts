import {PairingHttpsProvider} from '../providers/desktop/PairingHttpsProvider';
it('rejects cancellation before network and sanitizes native rejection',async()=>{
 let calls=0;const provider=new PairingHttpsProvider({post:async()=>{calls++;throw {code:'unauthorized',message:'token-secret'};},cancel:()=>{}});
 const cancelled=new AbortController();cancelled.abort();await expect(provider.post('https://peer.example','exchange','{}',cancelled.signal)).rejects.toMatchObject({code:'cancelled'});expect(calls).toBe(0);
 await expect(provider.post('https://peer.example','exchange','{}',new AbortController().signal)).rejects.toMatchObject({code:'unauthorized',message:'Pairing request failed'});
});
it('cancels pending native operation and rejects oversize response',async()=>{
 let finish!:(v:string)=>void,cancelled=false;const provider=new PairingHttpsProvider({post:()=>new Promise(resolve=>{finish=resolve;}),cancel:()=>{cancelled=true;}});
 const controller=new AbortController();const p=provider.post('https://peer.example','exchange','{}',controller.signal);controller.abort();await expect(p).rejects.toMatchObject({code:'cancelled'});expect(cancelled).toBe(true);finish('late');
 const large=new PairingHttpsProvider({post:async()=> 'x'.repeat(32769),cancel:()=>{}});await expect(large.post('https://peer.example','confirm','{}',new AbortController().signal)).rejects.toMatchObject({code:'invalid_protocol'});
});
