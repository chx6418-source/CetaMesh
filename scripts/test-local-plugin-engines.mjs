import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLocalEngineService} from '../src/plugin-center/local-engines.js';
const base=fs.mkdtempSync(path.join(os.tmpdir(),'cm-engine-config-'));
const owner={kind:'owner',id:'test'};
try {
 const service=createLocalEngineService({stateDir:base});
 assert.equal(service.getConfiguration('agentos')?.enabled??false,false);
 assert.deepEqual((await service.execute({actor:owner,method:'engines.list'})).engines,[], 'a fresh installation has no connected external plugins');
 await assert.rejects(service.execute({actor:owner,method:'engines.disable',params:{id:'agentos'}}),{code:'ENGINE_NOT_CONFIGURED'});
 await assert.rejects(service.execute({actor:{kind:'agent',id:'test'},method:'engines.review',params:{id:'agentos'}}),{code:'PERMISSION_DENIED'});
 await assert.rejects(service.execute({actor:owner,method:'engines.enable',params:{id:'agentos',token:'invented'}}),{code:'ENGINE_REVIEW_REQUIRED'});
 if(process.env.CETAMESH_TEST_AGENTOS_ROOT){
  const review=await service.execute({actor:owner,method:'engines.review',params:{id:'agentos',root:process.env.CETAMESH_TEST_AGENTOS_ROOT,nodePath:process.execPath}});
  assert.ok(review.summary.length);
  assert.deepEqual((await service.execute({actor:owner,method:'engines.list'})).engines,[], 'a review alone does not connect a plugin');
  await service.execute({actor:owner,method:'engines.enable',params:{id:'agentos',token:review.token}});
  const config=service.getConfiguration('agentos'); assert.equal(config.enabled,true);
  assert.deepEqual((await service.execute({actor:owner,method:'engines.list'})).engines.map(({id,enabled})=>[id,enabled]),[['agentos',true]]);
  const release=service.acquire('agentos',config.revision);
  await assert.rejects(service.execute({actor:owner,method:'engines.disable',params:{id:'agentos'}}),{code:'ENGINE_BUSY'});
  release();
  await service.execute({actor:owner,method:'engines.disable',params:{id:'agentos'}});
  assert.deepEqual((await service.execute({actor:owner,method:'engines.list'})).engines.map(({id,enabled})=>[id,enabled]),[['agentos',false]], 'a disabled external plugin can still be managed');
  assert.throws(()=>service.acquire('agentos',config.revision));
  await assert.rejects(service.execute({actor:owner,method:'engines.enable',params:{id:'agentos',token:review.token}}),{code:'ENGINE_REVIEW_REQUIRED'});
 }
 console.log('PASS local engine default-off, Owner review, single-use configuration token and operation lease');
 const shutdown=createLocalEngineService({stateDir:path.join(base,'shutdown')});let otherClosed=false;
 const unconfirmed=Object.assign(new Error('Owned Host exit not confirmed'),{code:'AGENTOS_STOP_UNCONFIRMED'});
 shutdown.attach('agentos',{close:async()=>{throw unconfirmed;}});
 shutdown.attach('reverselab',{close:async()=>{otherClosed=true;}});
 await assert.rejects(shutdown.close());
 assert.equal(otherClosed,true,'One unconfirmed Host must not skip closing another owned plugin');
 console.log('PASS failed plugin shutdown remains an error while other plugins still close');
}finally{fs.rmSync(base,{recursive:true,force:true});}
