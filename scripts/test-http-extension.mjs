import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createExtensionRuntime,createExtensionStore} from '../src/extension/index.js';
import https from 'node:https';import http from 'node:http';import {EventEmitter} from 'node:events';import {Readable} from 'node:stream';
import {createCapabilityService} from '../src/capability/service.js';
import {createCapabilityBroker} from '../src/capability/broker.js';import {OWNER_ACTOR} from '../src/capability/types.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-http-extension-'));let runtime;
try {
 const source=path.join(root,'source');fs.mkdirSync(source);
 const manifest={manifestVersion:1,id:'test.http-json',name:'HTTP JSON fixture',version:'1.0.0',type:'external-api',entry:'api.json',permissions:['network'],network:{hosts:['example.com']},scope:{paths:[]},capabilities:[{id:'lookup',requires:['network'],inputSchema:{type:'object',additionalProperties:false,properties:{term:{type:'string',maxLength:50}},required:['term']}}]};
 fs.writeFileSync(path.join(source,'extension.json'),JSON.stringify(manifest));
 fs.writeFileSync(path.join(source,'api.json'),JSON.stringify({schemaVersion:1,protocol:'http-json-v1',endpoints:[{capability:'lookup',url:'https://example.com/search',method:'GET',queryKeys:['term'],response:'json'}]}));
 const broker=createCapabilityBroker({stateDir:path.join(root,'state')});let calls=0;
 broker.register({id:'network',permission:'network',provider:'fixture-transport',risk:'high',execute:async request=>{calls++;assert.equal(request.input.url,'https://example.com/search?term=a%26b');assert.equal(request.actor.id,manifest.id);return {statusCode:200,body:'{"value":4217}',truncated:false};}});
 runtime=createExtensionRuntime({store:createExtensionStore({stateDir:path.join(root,'state')}),capabilityBroker:broker,monitorIntervalMs:0});
 const review=runtime.review({sourceDir:source});assert.equal(review.scan.ok,true);assert.equal(review.review.executionBoundary.codeExecution,false);
 runtime.install({sourceDir:source,approval:{approved:true,token:review.review.token}});runtime.enable({id:manifest.id});
 const pending=await runtime.invoke({id:manifest.id,capability:'lookup',input:{term:'a&b'}});
 assert.equal(pending.status,'pending','HTTP method alone cannot prove absence of side effects');assert.equal(calls,0);
 const result=await broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR});
 assert.deepEqual(result.result.result,{statusCode:200,data:{value:4217}});assert.equal(calls,1);
 await assert.rejects(broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR}));assert.equal(calls,1,'repeat approval cannot dispatch twice');
 await assert.rejects(runtime.invoke({id:manifest.id,capability:'lookup',input:{term:'ok',url:'https://unapproved.invalid'}}),{code:'TOOL_ARGUMENTS_INVALID'});
 await runtime.disable({id:manifest.id});await assert.rejects(runtime.invoke({id:manifest.id,capability:'lookup',input:{term:'blocked'}}),{code:'EXTENSION_DISABLED'});
 const service=createCapabilityService({stateDir:path.join(root,'redirect-state')});const originalRequest=https.request,originalHttpRequest=http.request;let hops=0;
 https.request=(options,callback)=>{hops++;const request=new EventEmitter();request.end=()=>{const response=Readable.from([]);response.statusCode=302;response.headers={location:'http://8.8.8.8/downgraded'};queueMicrotask(()=>callback(response));};request.destroy=error=>{if(error)request.emit('error',error);};return request;};
 http.request=https.request;
 try{await assert.rejects(service.broker.execute({actor:OWNER_ACTOR,capability:'network',approved:true,input:{url:'https://8.8.8.8/start',requireHttps:true}}),{code:'NETWORK_SCOPE_DENIED'});assert.equal(hops,1,'HTTPS requirement is checked before a redirected transport request');}
 finally{https.request=originalRequest;http.request=originalHttpRequest;await service.close();}
 console.log('PASS declarative HTTP plugin install, schema, exact host/query, explicit invocation approval, response parsing, duplicate prevention and disable lifecycle (fixture transport)');
} finally {await runtime?.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
