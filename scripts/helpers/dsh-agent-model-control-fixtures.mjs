import assert from 'node:assert/strict';
import {createDshAgentProvider} from '../../src/agent/dsh-agent-provider.js';

// Existing DSH wire shapes. The gateway leaf is synthetic; no real model runs.
const catalog={default:{provider:'native-provider',model:'native-a'},routableProviders:['native-provider','other-provider'],groups:[
 {id:'native-provider',models:[{id:'native-a',reasoning:{efforts:[{id:'medium'},{id:'xhigh'}],defaultEffort:'medium'}},{id:'native-b',reasoning:{efforts:[{id:'medium'},{id:'xhigh'}],defaultEffort:'xhigh'}}]},
 {id:'other-provider',models:[{id:'other-provider-only'}]}]};
let seq=0,mode='ack',running=false,release,entered,promptRelease,promptEntered;
const calls=[];
const api={async callEndpoint(endpoint,args={}){
 calls.push({endpoint,args});
 if(endpoint==='session/create')return{sessionId:'dsh-fixture-'+(++seq)};
 if(endpoint==='session/list')return{items:Array.from({length:seq},(_,i)=>({sessionId:'dsh-fixture-'+(i+1),running}))};
 if(endpoint==='session/modelCatalog')return catalog;
 if(endpoint==='session/prompt'&&mode==='pending-prompt'){promptEntered?.();await new Promise(resolve=>{promptRelease=resolve;});return{accepted:true};}
 if(endpoint==='session/selectModel'){
  const r=args.request;
  if(r.provider==='llm-native')throw Error('session/model-unavailable: no adapter registered for provider llm-native');
  if(mode==='reject')throw Error('session/model-unavailable: unknown model');
  if(mode==='hold'){entered?.();await new Promise(resolve=>{release=resolve;});}
  return{selected:{provider:r.provider,model:mode==='mismatch'?'wrong-native-model':r.model,reasoningEffort:r.reasoningEffort??'medium'}};
 }
 return{};
},async *openRemoteStream(){}};
const provider=createDshAgentProvider({api,defaults:{provider:'llm-native',model:'native-a',reasoningEffort:'medium'}});
const created=await provider.createSession({});
try{
 assert.equal(created.modelControl.status,'available');assert.equal(created.modelControl.source,'dsh-session');
 assert.deepEqual(created.modelControl.selection,{model:'native-a',reasoningEffort:'medium',modelProvider:'native-provider'});
 assert.deepEqual(created.modelControl.model.options.map(option=>option.value),['native-a','native-b']);
 assert.deepEqual(created.modelControl.reasoning.options.map(option=>option.value),['medium','xhigh']);
 const changed=await provider.selectModel({...created,reasoningEffort:'xhigh'});assert.equal(changed.confirmed,true);assert.equal(changed.modelControl.selection.reasoningEffort,'xhigh');
 mode='pending-prompt';const promptStarted=new Promise(resolve=>{promptEntered=resolve;});const dispatch=provider.send({...created,content:'synthetic pending dispatch'});await promptStarted;
 await assert.rejects(provider.selectModel({...created,model:'native-b'}),{code:'TURN_BUSY'});promptRelease();await dispatch;mode='ack';
 running=true;const before=calls.filter(call=>call.endpoint==='session/selectModel').length;
 await assert.rejects(provider.selectModel({...created,model:'native-b'}),{code:'TURN_BUSY'});running=false;
 assert.equal(calls.filter(call=>call.endpoint==='session/selectModel').length,before);
 const old=(await provider.status(created)).modelControl;
 mode='reject';await assert.rejects(provider.selectModel({...created,model:'native-b'}));
 assert.deepEqual((await provider.status(created)).modelControl.selection,old.selection);assert.equal((await provider.status(created)).modelControl.status,'available');
 assert.equal(calls.some(call=>call.endpoint==='workspace/archiveSession'),false,'a rejected change cannot archive the existing DSH session');
 mode='hold';const started=new Promise(resolve=>{entered=resolve;});const pending=provider.selectModel({...created,model:'native-b'});await started;
 await assert.rejects(provider.send({...created,content:'must wait for config'}),{code:'CONFIG_BUSY'});release();await pending;
 mode='mismatch';await assert.rejects(provider.selectModel({...created,model:'native-a'}),{code:'AGENT_CONFIGURATION_UNCONFIRMED'});
 const unknown=(await provider.status(created)).modelControl;assert.equal(unknown.status,'unknown');assert.equal(unknown.selection.model,'native-b');
 await assert.rejects(provider.send({...created,content:'must reconcile'}),{code:'AGENT_CONFIGURATION_UNKNOWN'});
 console.log('PASS DSH native catalog/effort ACK, running/transaction guards, rejection retention and unknown-ACK dispatch fence');
}finally{release?.();promptRelease?.();await provider.closeSession(created);}
