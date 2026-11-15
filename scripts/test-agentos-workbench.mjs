import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {zipSync,strToU8} from 'fflate';
import {createLocalEngineService} from '../src/plugin-center/local-engines.js';
const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-agentos-workbench-'))),stateDir=path.join(base,'state');
const contract=fs.readFileSync(new URL('../src/agentos/managed-v1.json',import.meta.url));
const file=path.join(base,'plugin.zip');
fs.writeFileSync(file,zipSync({
 'plugin/agentos.system.json':strToU8(JSON.stringify({id:'org.cetamesh.agentos',version:'2.0.0',managed:{protocol:'cetamesh.agentos.managed.v1',entry:'server/managed/stdio.mjs'}})),
 'plugin/package.json':strToU8('{"type":"module"}'),'plugin/server/managed/stdio.mjs':strToU8('throw Error("not executed");'),
 'plugin/catalog/images.json':strToU8('{}'),'plugin/contracts/agentos-managed-v1.json':new Uint8Array(contract),
 'plugin/ui.mjs':strToU8('// verified upstream UI entry'),'plugin/install.mjs':strToU8('// original UI dependency'),'plugin/AgentOSConsole.exe':strToU8('fixture; never executed')
}));
const requests=[],children=[];
function spawn(file,args,options){
 requests.push({file,args,options});const child=new EventEmitter();child.pid=700+children.length;child.exitCode=null;child.signalCode=null;
 child.kill=()=>{child.exitCode=0;queueMicrotask(()=>child.emit('exit',0));return true;};children.push(child);
 if(args[0]?.endsWith('ui.mjs'))fs.writeFileSync(path.join(options.env.AGENTOS_HOME,'console.json'),JSON.stringify({pid:child.pid,port:19231,token:'a'.repeat(24)}));
 queueMicrotask(()=>child.emit('spawn'));return child;
}
const service=createLocalEngineService({stateDir,workbenchSpawn:spawn,workbenchPlatform:'win32'});
const owner={kind:'owner',id:'fixture'},call=(method,params={},actor=owner)=>service.execute({actor,method:'engines.'+method,params});
try {
 const review=await call('package.review',{file});await call('package.install',{id:'agentos',token:review.token,reviewed:true,enable:true});
 await assert.rejects(call('workbench.open',{id:'agentos'},{kind:'agent',id:'model'}),{code:'PERMISSION_DENIED'});
 const opened=await call('workbench.open',{id:'agentos',file:'arbitrary.exe',args:['--allow-unmanaged-root']});
 assert.equal(opened.opened,true);assert.equal(requests.length,2);
 const config=service.getConfiguration('agentos');
 assert.equal(requests[0].file,process.execPath);assert.deepEqual(requests[0].args,[path.join(config.root,'ui.mjs')]);
 assert.equal(requests[0].options.shell,false);assert.equal(requests[0].options.windowsHide,true);
 assert.equal(requests[1].file,path.join(config.root,'AgentOSConsole.exe'));assert.deepEqual(requests[1].args,[]);
 assert.equal(requests[1].options.windowsHide,false,'Owner requested a visible native workbench');
 assert.equal(requests[0].options.env.AGENTOS_UNMANAGED_ALLOW_ROOT,undefined);
 assert.equal(requests[0].options.env.CETAMESH_AGENTOS_SESSION_KEY,undefined);
 assert.equal(requests[0].options.env.AGENTOS_HOME,path.join(stateDir,'agentos','workbench'));
 assert.equal((await call('workbench.open',{id:'agentos'})).alreadyOpen,true);assert.equal(requests.length,2);
 await assert.rejects(call('uninstall',{id:'agentos'}),{code:'ENGINE_BUSY'});
 children[1].kill();for(let i=0;i<20&&(await call('list')).engines[0].active;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await call('list')).engines[0].active,0,'exit confirms both owned processes before releasing configuration lease');
 fs.appendFileSync(path.join(config.root,'ui.mjs'),'\n// changed');
 await assert.rejects(call('workbench.open',{id:'agentos'}),{code:'ENGINE_IDENTITY_CHANGED'});assert.equal(requests.length,2);
 console.log('PASS Owner-only native workbench, fixed verified entries, isolated data/env, no root flag, singleton, update lease, confirmed exit and tamper refusal');
}finally{await service.close();fs.rmSync(base,{recursive:true,force:true});}
