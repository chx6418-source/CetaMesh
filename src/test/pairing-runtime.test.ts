import {PairingRuntime} from '../runtime/identity/PairingRuntime';
import {IdentityRuntime} from '../runtime/identity/IdentityRuntime';
import {NodeDatabase} from './helpers/NodeDatabase';
import {SqliteTrustRepository} from '../data/repositories/SqliteTrustRepository';
import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {pairingFixture} from './helpers/PairingPeer';
async function setup(){
 const fixture=pairingFixture();let now=Date.parse('2026-09-30T00:00:00.000Z');const db=new NodeDatabase();await migrateDatabase(db,appMigrations);const repo=new SqliteTrustRepository(db);
 const runtime=new PairingRuntime(new IdentityRuntime(fixture.mobile),fixture.mobile,repo,fixture.transport,()=>now);
 return {...fixture,db,repo,runtime,setNow:(v:number)=>{now=v;}};
}
it('requires two explicit confirmations and verifies real signatures before persisting public trust',async()=>{
 const f=await setup();const destination=f.runtime.preview(f.raw);expect(destination).not.toHaveProperty('token');expect(f.calls()).toBe(0);
 const review=await f.runtime.exchange(destination.id);expect(await f.repo.list()).toEqual([]);
 await f.runtime.confirm(review.id);expect((await f.repo.list())[0]).toMatchObject({deviceId:'desktop-1',localDeviceId:'mobile-1'});
 expect(f.calls()).toBe(2);expect(JSON.stringify((await f.db.executeAsync('SELECT * FROM pairing_used')).results)).not.toContain(f.invitation.token);
 await f.db.close();
});
it('rejects durable invitation replay even with a new runtime',async()=>{
 const f=await setup();await f.runtime.exchange(f.runtime.preview(f.raw).id);f.runtime.cancel();
 const r=new PairingRuntime(new IdentityRuntime(f.mobile),f.mobile,f.repo,f.transport,()=>Date.parse('2026-09-30T00:00:00.000Z'));
 await expect(r.exchange(r.preview(f.raw).id)).rejects.toMatchObject({code:'unauthorized'});expect(f.calls()).toBe(1);await f.db.close();
});
it('rejects expired confirmation and tampered peer response without saving trust',async()=>{
 const f=await setup();const review=await f.runtime.exchange(f.runtime.preview(f.raw).id);f.setNow(Date.parse(f.invitation.expiresAt));
 await expect(f.runtime.confirm(review.id)).rejects.toMatchObject({code:'invalid_protocol'});expect(await f.repo.list()).toEqual([]);await f.db.close();
 const g=await setup();const bad={post:async(...args:Parameters<typeof g.transport.post>)=>{const e=JSON.parse(await g.transport.post(...args));e.payload.peer.deviceId='attacker';return JSON.stringify(e);}};
 const r=new PairingRuntime(new IdentityRuntime(g.mobile),g.mobile,g.repo,bad,()=>Date.parse('2026-09-30T00:00:00.000Z'));
 await expect(r.exchange(r.preview(g.raw).id)).rejects.toMatchObject({code:'invalid_protocol'});expect(await g.repo.list()).toEqual([]);await g.db.close();
});
it('cancellation rejects a delayed valid exchange and leaves no trust',async()=>{
 const f=await setup();let release!:(v:string)=>void;const transport={post:async(...args:Parameters<typeof f.transport.post>)=>{const response=await f.transport.post(...args);return new Promise<string>(resolve=>{release=()=>resolve(response);});}};
 const r=new PairingRuntime(new IdentityRuntime(f.mobile),f.mobile,f.repo,transport,()=>Date.parse('2026-09-30T00:00:00.000Z'));
 const p=r.exchange(r.preview(f.raw).id);while(!release){await new Promise(resolve=>setImmediate(resolve));}r.cancel();release('');await expect(p).rejects.toMatchObject({code:'cancelled'});expect(await f.repo.list()).toEqual([]);await f.db.close();
});
it('deleting trust aborts in-flight authorization and denies stale cached connections',async()=>{
 const f=await setup();await f.runtime.confirm((await f.runtime.exchange(f.runtime.preview(f.raw).id)).id);
 let signal:AbortSignal|undefined;let finish!:()=>void;
 const running=f.runtime.withTrustedDevice('desktop-1',f.invitation.peer.publicKey,async(_trust,s)=>{signal=s;await new Promise<void>(resolve=>{finish=resolve;});return 'old result';});
 while(!finish){await new Promise(resolve=>setImmediate(resolve));}
 await f.runtime.removeTrust('desktop-1');expect(signal?.aborted).toBe(true);finish();await expect(running).rejects.toMatchObject({code:'unauthorized'});
 await expect(f.runtime.withTrustedDevice('desktop-1',f.invitation.peer.publicKey,async()=>true)).rejects.toMatchObject({code:'unauthorized'});await f.db.close();
});
it('rolls back trust insertion if cancelled while SQLite insert is in flight',async()=>{
 const f=await setup();let runtime!:PairingRuntime;
 const interrupted={executeAsync:f.db.executeAsync.bind(f.db),close:f.db.close.bind(f.db),transaction:async<T,>(op:(tx:typeof f.db)=>Promise<T>)=>f.db.transaction(async()=>{
  const tx={executeAsync:async(sql:string,params?:Parameters<typeof f.db.executeAsync>[1])=>{
   const result=await f.db.executeAsync(sql,params);if(sql.startsWith('INSERT INTO device_trust')){runtime.cancel();}return result;
  },transaction:f.db.transaction.bind(f.db),close:f.db.close.bind(f.db)};return op(tx as typeof f.db);
 })};
 runtime=new PairingRuntime(new IdentityRuntime(f.mobile),f.mobile,new SqliteTrustRepository(interrupted),f.transport,()=>Date.parse('2026-09-30T00:00:00.000Z'));
 const review=await runtime.exchange(runtime.preview(f.raw).id);await expect(runtime.confirm(review.id)).rejects.toMatchObject({code:'cancelled'});
 expect(await f.repo.list()).toEqual([]);await f.db.close();
});
it('tampered signature cannot create a confirmation preview',async()=>{
 const f=await setup();const transport={post:async(...args:Parameters<typeof f.transport.post>)=>{const e=JSON.parse(await f.transport.post(...args));const signature=Buffer.from(e.payload.signature,'base64');signature[signature.length-1]+=signature[signature.length-1]%2===0?1:-1;e.payload.signature=signature.toString('base64');return JSON.stringify(e);}};
 const runtime=new PairingRuntime(new IdentityRuntime(f.mobile),f.mobile,f.repo,transport,()=>Date.parse('2026-09-30T00:00:00.000Z'));
 await expect(runtime.exchange(runtime.preview(f.raw).id)).rejects.toMatchObject({code:'invalid_protocol'});expect(await f.repo.list()).toEqual([]);await f.db.close();
});
it('trust removal cancels pending final confirmation and prevents late persistence',async()=>{
 const f=await setup();let release!:()=>void;
 const transport={post:async(...args:Parameters<typeof f.transport.post>)=>{const response=await f.transport.post(...args);if(args[1]==='confirm'){return new Promise<string>(resolve=>{release=()=>resolve(response);});}return response;}};
 const runtime=new PairingRuntime(new IdentityRuntime(f.mobile),f.mobile,f.repo,transport,()=>Date.parse('2026-09-30T00:00:00.000Z'));
 const review=await runtime.exchange(runtime.preview(f.raw).id);const confirm=runtime.confirm(review.id);const result=confirm.then(()=>{throw new Error('Unexpected trust persistence');},error=>{expect(error).toMatchObject({code:'cancelled'});});
 while(!release){await new Promise(resolve=>setImmediate(resolve));}await runtime.removeTrust('desktop-1');release();await result;expect(await f.repo.list()).toEqual([]);await f.db.close();
});
it('rejects the same token with a changed invitation ID before a second transmission',async()=>{
 const f=await setup();await f.runtime.exchange(f.runtime.preview(f.raw).id);f.runtime.cancel();
 const altered=JSON.parse(f.raw);altered.payload.invitationId='altered-id';
 await expect(f.runtime.exchange(f.runtime.preview(JSON.stringify(altered)).id)).rejects.toMatchObject({code:'unauthorized'});
 expect(f.calls()).toBe(1);await f.db.close();
});
