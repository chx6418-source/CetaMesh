// Native dialogs wait for human input; ordinary host RPC retains its deadline.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const uiRequire=createRequire(path.join(root,'desktop-ui/package.json'));
const {createServer}=await import(pathToFileURL(uiRequire.resolve('vite')).href);
let now=0,next=0;const timers=new Map(),requests=[];
globalThis.window={ipc:{postMessage:raw=>requests.push(JSON.parse(raw))},
 setTimeout:(fn,ms)=>{const id=++next;timers.set(id,{at:now+ms,fn});return id;},
 clearTimeout:id=>timers.delete(id)};
function advance(ms){now+=ms;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn();}}
const vite=await createServer({configFile:false,root:path.join(root,'desktop-ui'),optimizeDeps:{noDiscovery:true},server:{middlewareMode:true},appType:'custom',logLevel:'error'});
try{
 const {hostClient}=await vite.ssrLoadModule('/src/bridge/typed-client.ts');
 for(const [name,run,result]of [
  ['folder',()=>hostClient.pickFolder(),{path:'D:/synthetic workspace'}],
  ['files',()=>hostClient.pickFiles(),{files:[]}],
  ['extension package',()=>hostClient.pickExtensionPackage(),{path:null}]
 ]){
  let state='pending';const p=run().then(v=>{state='resolved';return v;},e=>{state='rejected';throw e;});p.catch(()=>{/* Observe rejection below without an unhandled-rejection race. */});
  const request=requests.at(-1);advance(33000);await Promise.resolve();
  assert.equal(state,'pending',`${name} dialog must await human selection beyond the ordinary 32s RPC deadline`);
  window.__cetameshReceive({id:request.id,ok:true,result});assert.deepEqual(await p,result);assert.equal(timers.size,0,'selection or cancellation clears pending timer');
 }
 const ping=window.cetamesh.invoke('app.ping',{});const rejected=assert.rejects(ping,/桌面主机响应超时/);advance(32001);await rejected;
 const bounded=hostClient.pickFolder();const expired=assert.rejects(bounded,/桌面主机响应超时/);advance(300001);await expired;
 assert.equal(timers.size,0,'dialog timeout remains bounded');
 console.log('PASS native folder/files/package selection after 33s; cancellation; ordinary RPC deadline; bounded dialog deadline');
}finally{await vite.close();delete globalThis.window;}
