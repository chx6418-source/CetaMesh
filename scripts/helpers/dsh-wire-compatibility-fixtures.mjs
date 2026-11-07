// Owned protocol peer, derived from published interface shapes rather than upstream code.
// Latest reference: dsh-v0.2.2-rc.1 / 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db:
// api/session-controller/{types,index}, api/gateway/stream-protocol,
// client/connection/rpc-schema and api/workspace-controller/types.
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {NodeApiClient} from '../../src/dsh-client.js';
import {createDshAgentProvider} from '../../src/agent/dsh-agent-provider.js';

for(const version of ['0.1.5-rc.1','0.2.2-rc.1']){
 const sessionId='wire-fixture-'+version,calls=[],sockets=new Set();
 let created=false,archived=false,rejectAuth=false,malformedList=false;
 const models={default:{provider:'fixture-provider',model:'fixture-a',reasoningEffort:'medium'},
  routableProviders:['fixture-provider'],groups:[{id:'fixture-provider',name:'Owned synthetic provider',models:
   ['fixture-a','fixture-b'].map(id=>({id,name:id,reasoning:{efforts:[{id:'medium',name:'Medium'},{id:'high',name:'High'}],defaultEffort:'medium'}}))}],failures:[]};
 const server=http.createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk;
  const message=JSON.parse(raw),endpoint=request.url.slice('/api/'.length),args=message.payload?.args;
  assert.equal(message.type,'client-request');assert.equal(message.method,endpoint);
  assert.equal(typeof message.rpcId,'string');assert.equal(request.headers.cookie,'synthetic-readonly-cookie');
  calls.push({endpoint,args});
  if(rejectAuth){response.writeHead(401);response.end();return;}
  let value={};
  if(endpoint==='session/list'){
   assert.deepEqual(args,{_request:{}});
   value=malformedList?{}:{items:created&&!archived?[{sessionId,agentAvailable:true,running:false,blank:false,updatedAt:123,
    ...(version==='0.2.2-rc.1'?{formatStatus:'current'}:{}),projections:{kind:'sequenced',asOfSeq:3,values:{title:'Synthetic protocol result',tokenUsage:{uncachedInputTokens:3},contextPressure:{pressureTokens:7}}}}]:[]};
  }else if(endpoint==='session/create'){
   assert.equal(args.request.cwd,'C:/SyntheticProtocolWorkspace');created=true;value={sessionId};
  }else if(endpoint==='session/modelCatalog')value=models;
  else if(endpoint==='session/selectModel'){
   const {sessionId:bound,...selection}=args.request;assert.equal(bound,sessionId);value={selected:selection};
  }else if(endpoint==='session/prompt'){
   assert.equal(args.request.sessionId,sessionId);assert.equal(args.request.mode,'queue');
   assert.deepEqual(args.request.content,[{type:'text',text:'Owned synthetic prompt; no model exists.'}]);
   assert.equal(typeof args.request.requestId,'string');value={accepted:true};
  }else if(endpoint==='session/cancel'){
   assert.deepEqual(args,{request:{sessionId}});value={accepted:true};
  }else if(endpoint==='workspace/archiveSession'){
   assert.deepEqual(args,{request:{sessionId}});archived=true;value={archivedSessionIds:[sessionId]};
  }else assert.equal(endpoint,'settings/describe','only the observed/public endpoints are used');
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value}}));
 });
 const websocket=new WebSocketServer({server,path:'/api/remote.mux'});
 websocket.on('connection',socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  socket.on('message',bytes=>{
   const frame=JSON.parse(String(bytes));assert.equal(frame.type,'open');assert.equal(frame.endpoint,'session/follow');
   assert.deepEqual(frame.payload,{args:{request:{address:{kind:'session',sessionId}}}});
   const records=[{type:'event',event:{seq:0,time:120,type:'permission/preset',data:{preset:'fixture'}}},
    {type:'event',event:{seq:1,time:121,type:'turn/start',data:{turn:1}}},
    {type:'event',event:{seq:2,time:122,type:'assistant/message',surfaceOp:'append',data:{turn:1,text:'Synthetic fixture output'}}},
    {type:'event',event:{seq:3,time:123,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}}];
   socket.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'snapshot',header:{version:1,id:sessionId,createdAt:120,isSeeded:false},cursor:3,records,hasMore:false,projections:{asOfSeq:3,values:{}}}}));
   socket.send(JSON.stringify({type:'end',streamId:frame.streamId}));
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const api=new NodeApiClient('http://127.0.0.1:'+server.address().port,{authCookie:'synthetic-readonly-cookie',timeoutMs:2000});
 const provider=createDshAgentProvider({api});
 try{
  const health=await provider.health();assert.equal(health.available,true);assert.equal(health.taskEligible,false);
  const session=await provider.createSession({cwd:'C:/SyntheticProtocolWorkspace',modelProvider:'fixture-provider',model:'fixture-a',reasoningEffort:'medium'});
  assert.equal(session.modelControl.selection.model,'fixture-a');
  const changed=await provider.selectModel({...session,model:'fixture-b',modelProvider:'fixture-provider',reasoningEffort:'high'});
  assert.equal(changed.confirmed,true);assert.equal(changed.modelControl.selection.model,'fixture-b');
  const sent=await provider.send({...session,content:'Owned synthetic prompt; no model exists.'});assert.equal(sent.accepted,true);
  const events=[];for await(const row of provider.follow(session))events.push(row.event);
  assert.deepEqual(events.map(row=>row.seq),[1,2,3]);assert.equal(events[1].surfaceOp,'append');
  assert.equal((await provider.status(session)).running,false);
  assert.equal((await provider.contextUsage(session)).tokenUsage.uncachedInputTokens,3);
  assert.equal((await provider.resume(session)).resumed,true);
  const cancelled=await provider.cancel(session);assert.equal(cancelled.cancelRequested,true);assert.equal(cancelled.stopped,false);
  assert.equal((await provider.closeSession(session)).closed,true);
  await assert.rejects(provider.resume(session),{code:'SESSION_NOT_FOUND'});
  rejectAuth=true;assert.equal((await provider.health()).authenticated,false);
  rejectAuth=false;malformedList=true;
  const unverified=await provider.health();
  assert.equal(unverified.available,false,'an HTTP success with an unrecognized Session-list schema is not protocol compatibility');
  assert.equal(unverified.diagnostic.code,'DSH_PROTOCOL_UNVERIFIED');
  assert.equal(calls.filter(row=>row.endpoint==='session/create').length,1,'missing/resume/auth failures never create replacement Sessions');
  console.log('PASS DSH '+version+' synthetic HTTP/remote.mux: health, exact model ack, create/prompt, events, status, context, resume, cancel and archive');
 }finally{
  await provider.shutdown();for(const socket of sockets)socket.terminate();
  await new Promise(resolve=>websocket.close(resolve));await new Promise(resolve=>server.close(resolve));
 }
}
