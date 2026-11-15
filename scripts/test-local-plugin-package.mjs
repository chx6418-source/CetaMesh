import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {createLocalEngineService} from '../src/plugin-center/local-engines.js';
const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-plugin-package-'))),state=path.join(base,'state');
const owner={kind:'owner',id:'fixture'};
const contract=fs.readFileSync(new URL('../src/agentos/managed-v1.json',import.meta.url));
function archive(version='2.0.0',extra={}){
 const files={'plugin/agentos.system.json':strToU8(JSON.stringify({id:'org.cetamesh.agentos',name:'AgentOS',version,managed:{protocol:'cetamesh.agentos.managed.v1',entry:'server/managed/stdio.mjs'}})),
  'plugin/package.json':strToU8('{"type":"module"}'),'plugin/contracts/agentos-managed-v1.json':new Uint8Array(contract),
  'plugin/server/managed/stdio.mjs':strToU8('throw Error("Import must never execute this fixture");'),
  'plugin/catalog/default.json':strToU8('{}'),...extra};
 const file=path.join(base,'plugin-'+version+'-'+Math.random().toString(36).slice(2)+'.zip');fs.writeFileSync(file,zipSync(files));return file;
}
let service=createLocalEngineService({stateDir:state}),closed=0;
const call=(method,params={},actor=owner)=>service.execute({actor,method:'engines.'+method,params});
try{
 const review=await call('package.review',{file:archive()});
 assert.equal(review.id,'agentos');assert.equal(review.version,'2.0.0');assert.equal(review.installable,true);
 assert.deepEqual((await call('list')).engines,[],'import does not install or run the plugin');
 await assert.rejects(call('package.review',{file:archive()}, {kind:'agent',id:'fixture'}),{code:'PERMISSION_DENIED'});
 await assert.rejects(call('package.install',{id:'agentos',token:review.token}),{code:'ENGINE_REVIEW_REQUIRED'});
 service.attach('agentos',{disconnect:async()=>{closed++;},refresh(){},close:async()=>{}});
 await call('package.install',{id:'agentos',token:review.token,reviewed:true,enable:true});
 const first=service.getConfiguration('agentos');assert.equal(first.enabled,true);assert.equal(first.package.managed,true);
 assert.equal(fs.existsSync(path.join(first.root,'agentos.system.json')),true);assert.ok(first.root.startsWith(fs.realpathSync(state)+path.sep));
 assert.equal(first.nodePath,fs.realpathSync(process.execPath),'Node is selected without an Owner path field');
 await call('disable',{id:'agentos'});
 const enabledReview=await call('review',{id:'agentos',root:first.root,nodePath:first.nodePath});await call('enable',{id:'agentos',token:enabledReview.token});
 assert.equal(service.getConfiguration('agentos').package.managed,true,'re-enabling preserves installed package ownership');
 await assert.rejects(call('package.install',{id:'agentos',token:review.token,reviewed:true}),{code:'ENGINE_REVIEW_REQUIRED'});
 const update=await call('package.review',{file:archive('2.0.1')});const release=service.acquire('agentos',service.getConfiguration('agentos').revision);
 await assert.rejects(call('package.install',{id:'agentos',token:update.token,reviewed:true}),{code:'ENGINE_BUSY'});
 await assert.rejects(call('uninstall',{id:'agentos'}),{code:'ENGINE_BUSY'});release();
 await call('package.install',{id:'agentos',token:update.token,reviewed:true,enable:true});
 assert.equal(service.getConfiguration('agentos').version,'2.0.1');assert.equal(fs.existsSync(first.root),true,'update preserves the old immutable package');
 const changed=await call('package.review',{file:archive('2.0.2')});fs.appendFileSync(path.join(changed.root,'server/managed/stdio.mjs'),'\n// changed after review');
 await assert.rejects(call('package.install',{id:'agentos',token:changed.token,reviewed:true}),{code:'ENGINE_IDENTITY_CHANGED'});
 assert.equal(service.getConfiguration('agentos').version,'2.0.1');
 const history=path.join(state,'agentos','retained-evidence.json');fs.mkdirSync(path.dirname(history),{recursive:true});fs.writeFileSync(history,'retained');
 await service.close();service=createLocalEngineService({stateDir:state});assert.equal((await call('list')).engines[0].version,'2.0.1');
 await call('uninstall',{id:'agentos'});assert.deepEqual((await call('list')).engines,[]);assert.equal(fs.readFileSync(history,'utf8'),'retained');
 assert.equal(fs.existsSync(first.root),false,'uninstall removes only the managed program versions');
 const cancelled=await call('package.review',{file:archive()});await call('package.cancel',{token:cancelled.token});
 assert.equal(fs.existsSync(cancelled.root),false,'cancelling import releases owned staging files');
 assert.ok(closed>=2,'only the owned adapter is disconnected on install/update');
 for(const extra of [{'../escape.txt':strToU8('bad')},{'plugin/CON.txt':strToU8('bad')},{'plugin/server/a:stream':strToU8('bad')},{'plugin/ONE.txt':strToU8('a'),'plugin/one.txt':strToU8('b')}]){
  await assert.rejects(call('package.review',{file:archive('2.0.3',extra)}),error=>/PACKAGE_(PATH_INVALID|INVALID)/.test(error.code));
 }
 const ordinary=path.join(base,'ordinary.zip');fs.writeFileSync(ordinary,zipSync({'extension.json':strToU8('{}')}));
 await assert.rejects(call('package.review',{file:ordinary}),{code:'ENGINE_PACKAGE_NOT_SUPPORTED'});
 for(const [label,mutate,code] of [
  ['link',(bytes,p)=>bytes.writeUInt32LE(0xa1ff0000,p+38),'PACKAGE_INVALID'],
  ['declared-bomb',(bytes,p)=>bytes.writeUInt32LE(600*1024*1024,p+24),'PACKAGE_TOO_LARGE'],
  ['crc',(bytes,p)=>bytes.writeUInt32LE((bytes.readUInt32LE(p+16)^1)>>>0,p+16),'PACKAGE_INVALID'],
 ]){const file=archive();const bytes=fs.readFileSync(file),central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));assert.ok(central>0);mutate(bytes,central);fs.writeFileSync(file,bytes);await assert.rejects(call('package.review',{file}),{code},label);}
 console.log('PASS ZIP import/install/update/reload/uninstall, automatic Node, no pre-review execution, busy/tamper/replay refusal and preserved evidence');
}finally{await service.close();fs.rmSync(base,{recursive:true,force:true});}
