import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {createAcpAgentProvider} from '../src/agent/acp-agent-provider.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'acp-config-'));
const option=(id,category,currentValue,values)=>({id,name:id,category,type:'select',currentValue,options:values.map(value=>({value,name:value}))});
const options=()=>[option('model','model','a',['a','b']),option('effort','thought_level','default',['low','medium','high','default']),option('mode','mode','ask',['ask','yolo'])];
let peer,behavior='ack';
const provider=createAcpAgentProvider({descriptor:{id:'opencode',label:'OpenCode',protocolVersion:1,verifiedRuntime:true,
 security:{mode:'native',verified:true,nativeSandboxSupported:true,nativeApprovalSupported:true}},
 resolveTaskWorkspace:({taskId,workspaceId})=>({task:{id:taskId,workspaceId},workspace:{id:workspaceId,root}}),
 launch(){const readable=new PassThrough(),writable=new PassThrough();let stopped;const done=new Promise(resolve=>{stopped=resolve;});
  peer={frames:[],config:options(),readable,send:frame=>readable.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n')};
  writable.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')){const frame=JSON.parse(line);peer.frames.push(frame);
   if(frame.method==='initialize')peer.send({id:frame.id,result:{protocolVersion:1}});
   if(frame.method==='session/new')peer.send({id:frame.id,result:{sessionId:'native',configOptions:peer.config}});
   if(frame.method==='session/set_config_option'){
    if(behavior==='reject'){peer.send({id:frame.id,error:{code:-32602,message:'unsupported'}});continue;}
    if(behavior!=='mismatch')peer.config=peer.config.map(item=>item.id===frame.params.configId?{...item,currentValue:frame.params.value}:item);
    if(behavior==='reset-model'&&frame.params.configId==='effort')peer.config=peer.config.map(item=>item.id==='model'?{...item,currentValue:'a'}:item);
    peer.send({id:frame.id,result:{configOptions:peer.config}});
   }
  }});return{readable,writable,done,async close(){stopped({exitCode:0});}};
 }});
try{
 const session=await provider.createSession({taskId:'task',workspaceId:'workspace'});
 const initial=(await provider.status(session)).modelControl;
 assert.equal(initial?.selection.model,'a','session/new configuration must reach the domain status');
 assert.equal(initial.selection.reasoningEffort,'default');
 assert.deepEqual(initial.reasoning.options.map(item=>item.value),['low','medium','high','default']);
 assert.equal(JSON.stringify(initial).includes('yolo'),false,'permission selectors never become model controls');
 const selected=await provider.selectModel({...session,reasoningEffort:'medium'});
 assert.equal(selected.modelControl.selection.reasoningEffort,'medium');assert.equal(selected.modelControl.application,'runtime-confirmed');
 const count=peer.frames.length;await assert.rejects(provider.selectModel({...session,reasoningEffort:'yolo'}),{code:'AGENT_CONFIGURATION_UNSUPPORTED'});assert.equal(peer.frames.length,count);
 peer.config=peer.config.map(item=>item.id==='model'?{...item,currentValue:'b'}:item);
 peer.send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'config_option_update',configOptions:peer.config}}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal((await provider.status(session)).modelControl.selection.model,'b','idle updates are authoritative too');
 behavior='reject';await assert.rejects(provider.selectModel({...session,model:'a'}));
 assert.equal((await provider.status(session)).modelControl.selection.model,'b','rejection preserves last confirmed display');
 assert.equal((await provider.status(session)).modelControl.status,'unknown','an error is not proof a remote mutation did not happen');
 await assert.rejects(provider.send({...session,content:'must not use uncertain settings'}),{code:'AGENT_CONFIGURATION_UNKNOWN'});
 await provider.closeSession(session);
 behavior='ack';const busy=await provider.createSession({taskId:'busy',workspaceId:'workspace',model:'b',reasoningEffort:'high'});
 assert.equal((await provider.status(busy)).modelControl.selection.model,'b','initial selection is confirmed before returning the session');
 await provider.send({...busy,content:'pending'});await assert.rejects(provider.selectModel({...busy,model:'a'}),{code:'TURN_BUSY'});
 await provider.closeSession(busy);
 behavior='mismatch';const mismatch=await provider.createSession({taskId:'mismatch',workspaceId:'workspace'});
 await assert.rejects(provider.selectModel({...mismatch,model:'b'}),{code:'AGENT_CONFIGURATION_UNCONFIRMED'});
 const uncertain=(await provider.status(mismatch)).modelControl;assert.equal(uncertain.selection.model,'a');assert.equal(uncertain.status,'unknown');
 await provider.closeSession(mismatch);
 behavior='reset-model';const dependent=await provider.createSession({taskId:'dependent',workspaceId:'workspace'});
 await assert.rejects(provider.selectModel({...dependent,model:'b',reasoningEffort:'high'}),{code:'AGENT_CONFIGURATION_UNCONFIRMED'},'the final ACK must confirm the whole requested tuple');
 const reset=(await provider.status(dependent)).modelControl;assert.equal(reset.status,'unknown');assert.equal(reset.selection.model,'a');assert.equal(reset.selection.reasoningEffort,'default');
 await assert.rejects(provider.send({...dependent,content:'do not run after a dependent option reset'}),{code:'AGENT_CONFIGURATION_UNKNOWN'});
 await provider.closeSession(dependent);
 await assert.rejects(provider.createSession({taskId:'initial-dependent',workspaceId:'workspace',model:'b',reasoningEffort:'high'}),{code:'AGENT_CONFIGURATION_UNCONFIRMED'},'initial settings must be confirmed before prompt dispatch');
 console.log('PASS ACP runtime configuration advertisement, exact native values, idle updates, busy/permission refusal and uncertain ACK fence');
}finally{await provider.shutdown();fs.rmSync(root,{recursive:true,force:true});}
