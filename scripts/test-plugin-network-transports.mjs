import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import * as transport from '../src/safe-fetch.js';
import {httpRequestFor,createHttpExtensionHost} from '../src/extension/http-host.js';
import {createIntegrationService} from '../src/integrations/service.js';
import {createMcpRuntime} from '../src/integrations/mcp-runtime.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {createExtensionRuntime,createExtensionStore} from '../src/extension/index.js';
import {OWNER_ACTOR} from '../src/capability/types.js';

const schema={type:'object',additionalProperties:false,properties:{value:{type:'string',maxLength:40}},required:['value']};
const manifest={type:'external-api',entry:'api.json',permissions:['network'],network:{hosts:['fixture.example']},capabilities:[{id:'write',requires:['network'],inputSchema:schema}]};
const definition={schemaVersion:1,protocol:'http-json-v1',endpoints:[{capability:'write',url:'https://fixture.example/write',method:'POST',queryKeys:[],bodyKeys:['value'],credentialRef:'plugin-fixture',response:'json'}]};
// Removing declared writes must fail before any request can be issued.
assert.doesNotThrow(()=>httpRequestFor(manifest,JSON.stringify(definition),'write',{value:'accepted'}),'reviewed HTTP JSON writes must be supported');
assert.equal(typeof transport.safeHttpResponse,'function','production authenticated streaming transport must exist');
const cert=await selfsigned.generate([{name:'commonName',value:'fixture.example'}],{keySize:2048,algorithm:'sha256',extensions:[{name:'basicConstraints',cA:true},{name:'subjectAltName',altNames:[{type:2,value:'fixture.example'}]}]});
const calls=[], cancellations=[];let writes=0, deleted=0, revision=1, slowStarted, cyclePages=0;
const server=https.createServer({key:cert.private,cert:cert.cert},async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 calls.push({method:req.method,path:req.url,authorization:req.headers.authorization,body});
 if(req.url==='/redirect'){res.writeHead(307,{location:'/write'});res.end();return;}
 if(req.url.startsWith('/mcp')){
  if(req.method==='GET'){res.writeHead(405);res.end();return;}
  if(req.method==='DELETE'){deleted++;res.writeHead(204);res.end();return;}
  const message=JSON.parse(body);
  if(message.method==='notifications/cancelled')cancellations.push(message.params.requestId);
  if(!('id' in message)){res.writeHead(202);res.end();return;}
  let result;
  if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'controlled-remote',version:'1'}};
  if(message.method==='tools/list'&&req.url==='/mcp-error') {
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'controlled-fake-token'}}));return;
  }
  if(message.method==='tools/list'&&req.url==='/mcp-cycle') {
   cyclePages++;
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,...(cyclePages>12?{error:{code:-32000,message:'controlled-fake-token'}}:{result:{tools:[],nextCursor:'same-cursor'}})}));return;
  }
  if(message.method==='tools/list')result={tools:[{name:'write',inputSchema:schema,description:'Controlled write '+revision}]};
  if(message.method==='tools/call'){
   writes++;
   if(message.params.arguments.value==='slow'){slowStarted?.();return;}
   if(message.params.arguments.value==='disconnect'){req.socket.destroy();return;}
   result={content:[{type:'text',text:'stored:'+message.params.arguments.value}]};
  }
  res.writeHead(200,{'content-type':'application/json','mcp-session-id':'controlled-session'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));return;
 }
 if(req.url==='/write'){
  writes++;
  if(JSON.parse(body).value==='disconnect'){req.socket.destroy();return;}
  if(JSON.parse(body).value==='slow'){slowStarted?.();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({stored:JSON.parse(body).value, ...(JSON.parse(body).value==='echo'?{echo:req.headers.authorization}:{} )}));return;
 }
 res.writeHead(404);res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`https://fixture.example:${server.address().port}`, networkOptions={resolveHost:async()=> '127.0.0.1',ca:cert.cert};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-plugin-network-'));let runtime,service;
try{
 const resolved=transport.safeHttpFetch;
 await assert.rejects(resolved('https://127.0.0.1/write',50000,{method:'POST',body:'{}'}));
 await assert.rejects(resolved(base+'/write',50000,{...networkOptions,method:'TRACE'}));
 const beforeRedirect=writes;await assert.rejects(resolved(base+'/redirect',50000,{...networkOptions,method:'POST',body:'{}'}),e=>e.effectStatus==='unknown');assert.equal(writes,beforeRedirect);
 manifest.network.hosts=[new URL(base).host];definition.endpoints[0].url=base+'/write';
 const source=JSON.stringify(definition), request=httpRequestFor(manifest,source,'write',{value:'accepted'});
 assert.equal(request.init.body,'{"value":"accepted"}');assert.equal(request.credentialRef,'plugin-fixture');
 assert.throws(()=>httpRequestFor(manifest,source,'write',{value:'x',credentialRef:'other'}),{code:'TOOL_ARGUMENTS_INVALID'});
 const secrets=createProviderSecrets({root});secrets.set({provider:'plugin-fixture',apiKey:'controlled-fake-token',baseUrl:base});
 const {createNetworkCredentialResolver}=await import('../src/integrations/network-credentials.js');
 const resolveCredential=createNetworkCredentialResolver(secrets);
 assert.equal(await resolveCredential('plugin-fixture',base+'/write'),'controlled-fake-token');
 await assert.rejects(async()=>resolveCredential('plugin-fixture','https://other.example/write'));
 service=createCapabilityService({stateDir:path.join(root,'state'),networkCredentialResolver:resolveCredential,networkTransportOptions:networkOptions});
 const host=createHttpExtensionHost({manifest,source,capabilityExecutor:(_id,input,options)=>service.broker.execute({actor:OWNER_ACTOR,capability:'network',approved:true,input},{signal:options.signal}).then(row=>row.result)});
 assert.deepEqual((await host.invoke('write',{value:'accepted'})).result.data,{stored:'accepted'});
 assert.equal(calls.at(-1).authorization,'Bearer controlled-fake-token');
 const before=writes;
 await assert.rejects(host.invoke('write',{value:'disconnect'}),e=>e.effectStatus==='unknown');assert.equal(writes,before+1,'ambiguous HTTP write is never retried');
 const controller=new AbortController();let started=new Promise(resolve=>{slowStarted=resolve;});const pending=host.invoke('write',{value:'slow'},{signal:controller.signal});await started;controller.abort();await assert.rejects(pending,e=>e.effectStatus==='unknown');host.shutdown();assert.equal(host.health().inflight,0);await assert.rejects(host.invoke('write',{value:'x'}),{code:'EXTENSION_DISABLED'});
 const echoed=await service.broker.execute({actor:OWNER_ACTOR,capability:'network',approved:true,input:httpRequestFor(manifest,source,'write',{value:'echo'})});assert.ok(!JSON.stringify(echoed).includes('controlled-fake-token'),'credential echo is redacted before Broker returns it');
 const packageRoot=path.join(root,'package');fs.mkdirSync(packageRoot);
 const installedManifest={...manifest,manifestVersion:1,id:'test.http-live',name:'Controlled HTTP write',version:'1.0.0',scope:{paths:[]}};
 fs.writeFileSync(path.join(packageRoot,'extension.json'),JSON.stringify(installedManifest));fs.writeFileSync(path.join(packageRoot,'api.json'),source);
 const extensions=createExtensionRuntime({store:createExtensionStore({stateDir:path.join(root,'extensions')}),capabilityBroker:service.broker,monitorIntervalMs:0});
 try {
  const review=extensions.review({sourceDir:packageRoot});extensions.install({sourceDir:packageRoot,approval:{approved:true,token:review.review.token}});extensions.enable({id:installedManifest.id});
  const wrapper=await service.broker.execute({actor:OWNER_ACTOR,capability:'extension.test.http-live.write',input:{value:'installed'}});assert.equal(wrapper.status,'pending');
  const child=await service.broker.decide({id:wrapper.approvalId,approve:true,actor:OWNER_ACTOR});assert.equal(child.status,'pending');
  const result=await service.broker.decide({id:child.approvalId,approve:true,actor:OWNER_ACTOR});assert.equal(result.result.result.data.stored,'installed');
  const next=await service.broker.execute({actor:OWNER_ACTOR,capability:'extension.test.http-live.write',input:{value:'disabled'}});
  const deferred=await service.broker.decide({id:next.approvalId,approve:true,actor:OWNER_ACTOR});await extensions.disable({id:installedManifest.id});
  const beforeDisabled=writes;await assert.rejects(service.broker.decide({id:deferred.approvalId,approve:true,actor:OWNER_ACTOR}));assert.equal(writes,beforeDisabled);
  extensions.enable({id:installedManifest.id});
  const activeWrapper=await service.broker.execute({actor:OWNER_ACTOR,capability:'extension.test.http-live.write',input:{value:'slow'}});
  const activeChild=await service.broker.decide({id:activeWrapper.approvalId,approve:true,actor:OWNER_ACTOR});
  started=new Promise(resolve=>{slowStarted=resolve;});
  const activeResult=service.broker.decide({id:activeChild.approvalId,approve:true,actor:OWNER_ACTOR}).then(()=>null,error=>error);
  await started;const disabledAt=Date.now();await extensions.disable({id:installedManifest.id});
  const stoppedError=await activeResult;assert.equal(stoppedError?.effectStatus,'unknown');assert.ok(Date.now()-disabledAt<2000,'disable aborts an already approved HTTP socket promptly');
 } finally {await extensions.close();}
 console.log('PASS installed HTTP package review, outer/inner approvals, real authenticated TLS write, disabled pending request and credential echo redaction');
 console.log('PASS actual TLS HTTP write, authenticated Core Broker, schema, SSRF, redirect denial, cancellation and no retry');
 const integration=createIntegrationService({stateDir:path.join(root,'integration'),resolveCredential,networkOptions});
 try {
  await integration.execute({method:'mcp.config.update',params:{serverId:'remote',approved:true,config:{url:base+'/mcp',credentialRef:'plugin-fixture',allowedTools:['write'],timeoutMs:2000}}});
  await integration.execute({method:'mcp.enable',params:{serverId:'remote',approved:true}});
  await integration.execute({method:'mcp.start',params:{serverId:'remote',approved:true}});
  const discovered=await integration.execute({method:'mcp.tools',params:{serverId:'remote'}});assert.equal(discovered.tools.length,1);
  const approval=await integration.execute({method:'mcp.invoke',params:{serverId:'remote',tool:'write',input:{value:'registry'}}});assert.equal(approval.status,'pending');
  const approved=await integration.broker.decide({id:approval.approvalId,approve:true,actor:OWNER_ACTOR});assert.equal(approved.result.content[0].text,'stored:registry');
  const old=await integration.execute({method:'mcp.invoke',params:{serverId:'remote',tool:'write',input:{value:'old-binding'}}});
  await integration.execute({method:'mcp.config.update',params:{serverId:'remote',approved:true,config:{url:base+'/mcp-v2'}}});
  await assert.rejects(integration.broker.decide({id:old.approvalId,approve:true,actor:OWNER_ACTOR}));
  assert.equal(integration.runtime.status('remote').status,'stopped');
 }finally{await integration.close();}
 console.log('PASS registered remote MCP through production Integration Broker, explicit tool approval and configuration invalidation');
 const descriptor={id:'fixture',transport:'streamable-http',namespace:'mcp__fixture__',tools:[],url:base+'/mcp'};
 runtime=createMcpRuntime({servers:[descriptor],resolveCredential,networkOptions});
 const config={url:base+'/mcp',credentialRef:'plugin-fixture',allowedTools:['write'],timeoutMs:2000};
 assert.equal((await runtime.start('fixture',config)).status,'running');assert.deepEqual(runtime.discover('fixture')[0].inputSchema,schema);
 const result=await runtime.call('fixture','write',{value:'mcp'});assert.equal(result.content[0].text,'stored:mcp');
 await assert.rejects(runtime.call('fixture','write',{value:5}),{code:'TOOL_ARGUMENTS_INVALID'});
 await assert.rejects(runtime.call('fixture','not-approved',{}),{code:'UNKNOWN_MCP_TOOL'});
 const beforeMcp=writes;await assert.rejects(runtime.call('fixture','write',{value:'disconnect'}),e=>e.effectStatus==='unknown');assert.equal(writes,beforeMcp+1);
 await runtime.restart('fixture',config);const abort=new AbortController();started=new Promise(resolve=>{slowStarted=resolve;});const pendingMcp=runtime.call('fixture','write',{value:'slow'},{signal:abort.signal});await started;abort.abort();await assert.rejects(pendingMcp,e=>e.effectStatus==='unknown');
 await runtime.stop('fixture');assert.equal(runtime.status('fixture').status,'stopped');assert.ok(deleted>0,'remote sessions terminated');
 revision++;await runtime.start('fixture',config);assert.match(runtime.discover('fixture')[0].description,/2/);await runtime.closeAll();
 assert.ok(calls.filter(row=>row.path==='/mcp').every(row=>row.authorization==='Bearer controlled-fake-token'));
 const discoveryLogs=[];
 const broken=createMcpRuntime({servers:[descriptor],resolveCredential,networkOptions,log:line=>discoveryLogs.push(line)});
 await assert.rejects(broken.start('fixture',{...config,url:base+'/mcp-cycle'}),{code:'MCP_START_FAILED'});await broken.closeAll();
 await assert.rejects(broken.start('fixture',{...config,url:base+'/mcp-error'}),{code:'MCP_START_FAILED'});await broken.closeAll();
 assert.ok(!discoveryLogs.join('').includes('controlled-fake-token'),'discovery failure text cannot leak the credential into runtime diagnostics');
 assert.ok(cyclePages<=10,'repeated cursors and empty pages cannot create an unbounded discovery loop');
 console.log('PASS actual TLS remote MCP initialize/discovery/schema/auth/call/cancel/reconnect/cleanup; third-party services BLOCKED_ENV');
}finally{
 await runtime?.closeAll();await service?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});
}
