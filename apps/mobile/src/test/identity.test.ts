import { IdentityRuntime } from '../runtime/identity/IdentityRuntime';
const identity = {deviceId: 'device-1', deviceName: 'Mobile', platform: 'android', publicKey: 'B' + 'A'.repeat(86) + '=', createdAt: '2026-09-30T00:00:00.000Z'};
it('returns only validated public metadata and coalesces initialization', async () => {
  let calls = 0;
  const runtime = new IdentityRuntime({getIdentity: async () => {calls++; return JSON.stringify({...identity, privateKey: 'never expose'});}});
  const [a,b] = await Promise.all([runtime.get(), runtime.get()]);
  expect(a).toEqual(identity); expect(b).toEqual(a); expect(calls).toBe(1);
  a.deviceName = 'changed'; expect((await runtime.get()).deviceName).toBe('Mobile');
});
it('fails closed on invalid identity and normalizes native failures without leaking secrets', async () => {
  const runtime = new IdentityRuntime({getIdentity: async () => JSON.stringify({...identity, publicKey: 'bad'})});
  await expect(runtime.get()).rejects.toMatchObject({code:'storage_error'});
  const failed = new IdentityRuntime({getIdentity: async () => {throw {code: 'unsupported', message: 'secret'};}});
  await expect(failed.get()).rejects.toMatchObject({code:'unsupported', message:'Device identity is unavailable'});
});
it('allows retry after transient initialization failure', async () => {
  let calls=0;
  const runtime = new IdentityRuntime({getIdentity:async()=>{if(calls++===0) {throw new Error('private detail');} return JSON.stringify(identity);}});
  await expect(runtime.get()).rejects.toMatchObject({code:'storage_error'});
  expect(await runtime.get()).toEqual(identity);
});
it('rejects ambiguous or normalized invalid creation timestamps', async () => {
  for (const createdAt of ['2026', '2026-02-30T00:00:00.000Z']) {
    const runtime = new IdentityRuntime({getIdentity: async () => JSON.stringify({...identity,createdAt})});
    await expect(runtime.get()).rejects.toMatchObject({code:'storage_error'});
  }
});
