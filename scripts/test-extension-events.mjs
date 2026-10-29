import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket,{WebSocketServer} from 'ws';
import {createExtensionRuntime,createExtensionStore} from '../src/extension/index.js';
import {createCapabilityBroker} from '../src/capability/broker.js';
import {createCapabilityPolicy} from '../src/capability/policy.js';
assert.ok(fs.existsSync(new URL('../src/extension/event-transport.js',import.meta.url)), 'Existing channel-adapter needs a controlled event transport implementation');
const {executeEventTransport}=await import('../src/extension/event-transport.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-event-plugin-'));
const secret='controlled-fixture-secret-32-bytes';
const responseSchema={type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false};
const envelope=(id,value)=>({protocolVersion:1,id,timestamp:Date.now(),data:{value}});
const servers=[],runtimes=[];
async function port(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const p=server.address().port;await new Promise(resolve=>server.close(resolve));return p;}
async function request(url,event,{valid=true}={}){const body=JSON.stringify(event);return fetch(url,{method:'POST',body,headers:{'content-type':'application/json','x-cetamesh-signature':valid?crypto.createHmac('sha256',secret).update(body).digest('hex'):'0'.repeat(64)}});}
async function ready(url){for(let i=0;i<100;i++){try{await fetch(url);return;}catch{await delay(10);}}throw Error('webhook listener did not become ready');}
try{
 const wsServer=new WebSocketServer({host:'127.0.0.1',port:0});servers.push(wsServer);await new Promise(resolve=>wsServer.once('listening',resolve));let connections=0;
 wsServer.on('connection',(socket,req)=>{assert.equal(req.headers.authorization,'Bearer '+secret);connections++;socket.on('message',raw=>{const subscription=JSON.parse(String(raw));assert.equal(subscription.type,'subscribe');assert.equal(subscription.topic,'fixture');socket.send(JSON.stringify(envelope('one','one')));if(connections===1)socket.close();else socket.send(JSON.stringify(envelope('two','two')));});});
 class LocalSocket extends WebSocket{constructor(url,options){assert.equal(url,'wss://8.8.8.8/events');assert.equal(options.rejectUnauthorized,true);assert.equal(options.followRedirects,false);super('ws://127.0.0.1:'+wsServer.address().port,{headers:options.headers,maxPayload:options.maxPayload});}}
 const ws=await executeEventTransport({transport:'websocket',url:'https://8.8.8.8/events',credentialRef:'plugin-fixture',subscription:{topic:'fixture'},limit:2,timeoutMs:3000,responseSchema},{secret,WebSocketImpl:LocalSocket});
 assert.deepEqual(ws.events.map(row=>row.id),['one','two']);assert.equal(connections,2);console.log('PASS real local WebSocket subscription, reconnect, replay suppression and bounded completion (TLS policy asserted; fixture uses loopback wire)');
 await assert.rejects(executeEventTransport({transport:'websocket',url:'https://127.0.0.1/events',credentialRef:'plugin-fixture',subscription:{topic:'fixture'},limit:1,timeoutMs:300,responseSchema},{secret}));
 const url='http://127.0.0.1:'+await port()+'/callback';
 const input={transport:'webhook',url,credentialRef:'plugin-fixture',limit:2,timeoutMs:3000,responseSchema};
 const listening=executeEventTransport(input,{secret});await ready(url);
 assert.equal((await request(url,envelope('bad','bad'),{valid:false})).status,403);
 assert.equal((await request(url,{...envelope('old','old'),timestamp:1})).status,403);
 assert.equal((await request(url,envelope('first','one'))).status,202);
 assert.equal((await request(url,envelope('first','duplicate'))).status,409);
 assert.equal((await request(url,envelope('second','two'))).status,202);
 assert.deepEqual((await listening).events.map(row=>row.id),['first','second']);
 await assert.rejects(fetch(url));console.log('PASS real local Webhook HMAC, freshness, replay rejection, result and socket reclamation');
 const abort=new AbortController(),cancelUrl='http://127.0.0.1:'+await port()+'/cancel';
 const cancelled=executeEventTransport({...input,url:cancelUrl},{secret,signal:abort.signal});const observed=cancelled.catch(error=>error);await ready(cancelUrl);abort.abort();assert.equal((await observed).effectStatus,'unknown');await assert.rejects(fetch(cancelUrl));console.log('PASS Webhook cancellation closes actual listener and reports uncertain effect');
 // Full installed data adapter, signed parent/child approvals and durable event receipts.
 const hookUrl='http://127.0.0.1:'+await port()+'/installed',id='fixture.events';const source=path.join(root,'source');fs.mkdirSync(source);
 const manifest={manifestVersion:1,id,name:'Events fixture',version:'1.0.0',type:'channel-adapter',entry:'events.json',permissions:['network','storage'],network:{hosts:[new URL(hookUrl).host]},capabilities:[{id:'receive',requires:['network','storage'],inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
 const definition={schemaVersion:1,protocol:'cetamesh-events-v1',endpoints:[{capability:'receive',transport:'webhook',url:hookUrl,credentialRef:'plugin-fixture',limit:1,timeoutMs:3000,responseSchema}]};
 fs.writeFileSync(path.join(source,'extension.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(source,'events.json'),JSON.stringify(definition));
 const broker=createCapabilityBroker({stateDir:path.join(root,'broker'),policy:createCapabilityPolicy({resolveTask:id=>({id,workspaceId:'ws',status:'running'})})});let transportCalls=0;
 broker.register({id:'network',permission:'network',risk:'high',execute:r=>{transportCalls++;assert.equal(r.actor.id,'desktop');assert.equal(r.taskId,'task');assert.equal(r.attemptId,'attempt-1');return executeEventTransport(r.input,{signal:AbortSignal.any([...(r.signal?[r.signal]:[]),broker.registry.require(r.pluginParent.capability).lifecycleSignal()]),secret});}});
 let runtime=createExtensionRuntime({store:createExtensionStore({stateDir:root}),capabilityBroker:broker,monitorIntervalMs:0});runtimes.push(runtime);const review=runtime.review({sourceDir:source});assert.equal(review.review.executionBoundary.codeExecution,false);runtime.install({sourceDir:source,approval:{approved:true,token:review.review.token}});runtime.enable({id});
 async function begin(operationId){const pending=await broker.execute({actor:{kind:'owner',id:'desktop'},taskId:'task',workspaceId:'ws',attemptId:'attempt-1',operationId,capability:'extension.'+id+'.receive',input:{}});const child=await broker.decide({id:pending.approvalId,approve:true,actor:{kind:'owner',id:'desktop'}});assert.equal(child.status,'pending');return broker.decide({id:child.approvalId,approve:true,actor:{kind:'owner',id:'desktop'}});}
 const first=begin('events-one');await ready(hookUrl);await request(hookUrl,envelope('durable','one'));const firstResult=await first;assert.equal(firstResult.result.result.events[0].id,'durable');
 await runtime.close();runtime=createExtensionRuntime({store:createExtensionStore({stateDir:root}),capabilityBroker:broker,monitorIntervalMs:0});runtimes.push(runtime);
 const replay=begin('events-replay');const replayObserved=replay.catch(error=>error);await ready(hookUrl);await request(hookUrl,envelope('durable','one'));assert.equal((await replayObserved).code,'EVENT_REPLAY');
 const disabled=begin('events-disabled');const disabledObserved=disabled.catch(error=>error);await ready(hookUrl);await runtime.disable({id});assert.equal((await disabledObserved).effectStatus,'unknown');await assert.rejects(fetch(hookUrl));assert.equal(transportCalls,3);await runtime.uninstall({id});console.log('PASS installed event plugin approval chain, Task/Attempt binding, persistent replay fence after restart, disable and uninstall');
}finally{await Promise.all(runtimes.map(r=>r.close()));for(const s of servers){for(const c of s.clients)c.terminate();await new Promise(resolve=>s.close(resolve));}fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
